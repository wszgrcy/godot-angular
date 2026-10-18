import { createRequire, SourceMap } from "node:module";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import type { Plugin } from "vite";
import type { Instrumenter } from "istanbul-lib-instrument";
import { exactRegex, makeIdFiltersToMatchWithQuery, prefixRegex } from "@rolldown/pluginutils";
import { CUJ_COVERAGE_KEY, COVERAGE_PACKAGE_ENV, COVERAGE_PACKAGE_ON } from "../shared/coverage";
import { toPosix, withoutQuery } from "../shared/path";
import { NEVER_ID } from "../shared/hook-filter";

/** 发布物里存放库代码的目录（ng-packagr 的产物目录）。 */
const ARTIFACT_DIR = "fesm2022";

export interface CoverageInstrumentOptions {
  /** 绝对路径白名单：只有位于这些目录里的模块会被插桩 */
  roots: string[];
  /** 精确文件白名单（绝对路径），与 roots 取并集 */
  files?: string[];
  /**
   * 是否让插桩产出 source map。开启构建的 `sourceMap` 时打开：插桩会在模块开头插入上百行
   * 计数前导码，不交映射时整个被插桩的 chunk 在产物 map 里不会留下任何映射段，断点无法
   * 对应源文件。关闭时（默认）交空 map，产物不会变大。
   */
  sourceMap?: boolean;
  log?: (message: string) => void;
}

/**
 * 从使用方工作区定位发布物的代码目录。找不到时返回 undefined（例如 noLaunch 的机器上
 * 未安装包），由调用方决定报错还是跳过。
 */
export function resolveArtifactRoot(workspaceRoot: string, packageName = "godot-angular"): string | undefined {
  try {
    const req = createRequire(resolve(workspaceRoot, "package.json"));
    return dirname(req.resolve(`${packageName}/package.json`));
  } catch {
    return undefined;
  }
}

/** 默认插桩范围：发布物的 fesm2022/（库代码全在此处，builder 自身的 runtime 不在） */
export function defaultCoverageRoots(workspaceRoot: string): string[] {
  const pkg = resolveArtifactRoot(workspaceRoot);
  if (!pkg) return [];
  const dir = resolve(pkg, ARTIFACT_DIR);
  return existsSync(dir) ? [dir] : [];
}

/**
 * `instrumentSync` 第三个参数的本地别名：类型声明停在 istanbul v1，将 inputSourceMap 写成了
 * source-map@0.6 的 `RawSourceMap`（`version: string`），而 rollup 交的 SourceMap 是
 * `version: number`；istanbul 6 运行时识别的是后者。差异仅在这一个字段，就地转换一次，
 * 不去修改第三方声明。
 */
type InputSourceMap = Parameters<Instrumenter["instrumentSync"]>[2];

/**
 * 插桩配置的唯一来源：发布物（pre）与应用代码（post）两个插件共用同一个 instrumenter，
 * 两处必须同源：
 * - `coverageVariable` 是引擎内写入计数、宿主读取计数之间唯一的约定，名称不一致则一条也读不到；
 * - 两边产出的条目进入同一份报告，statementMap / fnMap 的编号规则不同源时，
 *   istanbul 生成报告时就会串位。
 */
export async function createCoverageInstrumenter(produceSourceMap = false): Promise<Instrumenter> {
  // 使用字面量 specifier：tools/vite-build.ts 将裸标识符一律判定为 external，istanbul 不会被
  // 内联进 builder 产物，仅在确实开启 coverage 时才被解析。
  const { createInstrumenter } = await import("istanbul-lib-instrument");
  return createInstrumenter({
    produceSourceMap,
    autoWrap: false,
    esModules: true,
    compact: false,
    coverageVariable: CUJ_COVERAGE_KEY,
    // GodotJS 中没有 `global`，也不要依赖 `new Function("return this")()`：直接指定 globalThis
    coverageGlobalScope: "globalThis",
    coverageGlobalScopeFunc: false,
  });
}

/**
 * istanbul 插桩插件（构建期），共两个实例。
 *
 * 发布物那一份只在 `CUJ_COVERAGE_PACKAGE=1` 时才挂载（默认关闭，见 `COVERAGE_PACKAGE_ENV`）：
 * 引擎内运行的就是发布物，插桩它才做到“测试的就是发布的代码”，但只有本库开发时手上才有库源码。
 * 产物里的 `*.mjs.map` 指回 `packages/**`，宿主侧的 provider 用它将覆盖率 remap 回源码，
 * 因此覆盖率本身不依赖此处的 map。`options.sourceMap` 开启时才额外生成一份，目的是使产物的
 * source map 不断链（供调试），覆盖率记录的坐标不受影响。
 *
 * 发布物那一份必须运行在 `enforce: "pre"`，依据如下：
 * Angular 的 linker 会将发布物中的 `ɵɵngDeclare*` 静态属性改写为 `ɵdir` / `ɵcmp` 运行时
 * 定义，行号全部变化（forms 入口 553 行 → 491 行），而它不交 map（`mappings: ""`）。
 * 在 linker 之后插桩，istanbul 记录的语句位置是“linker 产物”坐标，而宿主拿到的侧车 map 描述的是
 * “发布物原文”坐标，两边无法对应——remap 会将语句归到同 bundle 内另一个源文件上
 * （`forms/color.ts` 整块被计入 `choice.ts`，前者在报告中始终为 0%）。“linker 不交 map”
 * 意味着无法将两份 map 拼接，只能让插桩看到的就是发布物原文：先插桩，linker 再改写（counter
 * 作为普通语句可以活过改写，而位置已记录在 coverage 对象中）。
 *
 * `instrument` 中显式写出的文件（应用代码）则相反，必须等 analog 将 .ts 编为 JS 之后再插，
 * 那一份留在 `post`：istanbul 无法处理 TS，它需要的是 analog 产出的那份 map。
 */
export function coverageInstrumentPlugins(options: CoverageInstrumentOptions): Plugin[] {
  const roots = options.roots.map(toPosix);
  const files = new Set((options.files ?? []).map(toPosix));
  const wantMap = options.sourceMap === true;
  // 发布物插桩的开关在插件自身读取，不从调用方传入：它只影响本插件的行为，层层传参
  // 只会把“pre 那一份是内部专用”这条信息分散到别处。
  const packageInstrument = process.env[COVERAGE_PACKAGE_ENV] === COVERAGE_PACKAGE_ON;
  let instrumenter$$ = createCoverageInstrumenter(wantMap)
  const hit = new Set<string>();


  const result = (inst: Instrumenter, code: string) => {
    if (wantMap) {
      let map = inst.lastSourceMap()
      return {
        code, map: { ...map, version: +map.version }
      }
    }
    return ({
      code,
      map: { mappings: "" },
    })
  };
  let logged = false;
  const logOnce = () => {
    if (logged) return;
    logged = true;
    if (hit.size) {
      options.log?.(`覆盖率：已插桩 ${hit.size} 个模块`);
      return;
    }
    // 一个也未插桩到，四种原因各有不同的排查方式，不应合并成一句
    options.log?.(
      packageInstrument
        ? roots.length
          ? `覆盖率：${roots.join(", ")} 下没有模块进入 bundle，请检查插桩范围`
          : "覆盖率：未定位到发布物目录，产物未插桩（请确认 godot-angular 已安装）"
        : files.size
          ? "覆盖率：instrument 中的文件均未进入 bundle，请检查 glob"
          : "覆盖率：未插桩任何模块 —— 需配置 coverage.instrument（如 [\"src/**/*.ts\"]）才会插桩",
    );
  };

  const artifact: Plugin = {
    name: "godot-angular-coverage:artifact",
    enforce: "pre",
    transform: {
      // 未进入插桩目录的模块（图中绝大多数）不应进入 JS。roots 为空时需要显式恒假：
      // 空数组在 rolldown 中等价于“未写 filter”，反而全部匹配
      filter: { id: roots.length ? roots.map((root) => prefixRegex(`${root}/`)) : NEVER_ID },
      async handler(code, id) {
        const file = toPosix(withoutQuery(id));
        if (files.has(file)) return null;
        if (!/\.(?:m?js|cjs)$/.test(file)) return null;
        if (!roots.some((root) => file.startsWith(`${root}/`))) return null;
        const inst = await instrumenter$$;
        // 不携带 inputSourceMap：发布物旁的那份 `*.mjs.map` 就是 .mjs → .ts 的真实 map，
        // 宿主侧统一挂载（此处再塞一份只会使载荷变大）
        const instrumented = inst.instrumentSync(code, file);
        hit.add(file);
        return result(inst, instrumented);
      },
    },
    buildEnd: logOnce,
  };

  const source: Plugin = {
    name: "godot-angular-coverage:source",
    enforce: "post",
    transform: {
      // instrument 中显式写出的文件不限后缀：应用代码进入此处时后缀仍是 .ts
      //（代码已是 analog 编译完成的 JS，但 id 使用源文件）
      filter: {
        id: files.size
          ? [...files].map((file) => makeIdFiltersToMatchWithQuery(exactRegex(file)))
          : NEVER_ID,
      },
      async handler(code, id) {
        const file = toPosix(withoutQuery(id));
        if (!files.has(file)) return null;
        const inst = await instrumenter$$;
        const instrumented = inst.instrumentSync(
          code,
          file,
          this.getCombinedSourcemap() as unknown as InputSourceMap,
        );
        hit.add(file);
        return result(inst, instrumented);
      },
    },
    buildEnd: logOnce,
  };

  // 发布物那一份只在本库自身开发时挂载（`CUJ_COVERAGE_PACKAGE=1`）：它插桩的是 node_modules 里的那份
  // .mjs，只有库开发时手上才有对应的 .ts 源码，否则报告只能指向 .mjs。外部用户需要的是
  // source 那一份——插桩他们 `coverage.instrument` 中指定的自有代码。
  return packageInstrument ? [artifact, source] : [source];
}
