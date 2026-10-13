import type { BuilderContext } from "@angular-devkit/architect";
import angular from "@analogjs/vite-plugin-angular";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { globSync } from "tinyglobby";
import { ReplaySubject } from "rxjs";
import { bufferedValuesFrom } from "rxjs-for-await";
import { toPosix, withoutQuery } from "../shared/path";
import { idEndingWith } from "../shared/hook-filter";
import {
  build,
  loadConfigFromFile,
  mergeConfig,
  type InlineConfig,
  type Plugin,
  type UserConfig,
} from "vite";
import { assetsPlugin } from "./assets-plugin";
import { budgetsPlugin } from "./budgets-plugin";
import {
  POLYFILL_ENTRY_NAME,
  POLYFILL_ENTRY_SPECIFIER,
  polyfillExtras,
  polyfillPlugin,
} from "./polyfill";
import { icuDowngradePlugin } from "./icu-downgrade";
import { cssPlugins, GLOBAL_CSS_VIRTUAL } from "./css-plugin";
import { godotInteropPlugin } from "./godot-interop";
import { isExternalDependency, normalizeAssets, normalizeEntries, normalizeGlobalStyles } from "./options";
import {
  applicationOptionsSchema,
  type ApplicationOptions,
  type EntryPattern,
  type FileReplacement,
} from "./options-schema";

interface GodotViteEntry {
  /** 产物里的入口名，也是 Godot 侧 require 的名字 */
  name: string;
  file: string;
}

/**
 * 入口模式 → 入口表，口径与 assets 一致。名字 = output + 相对 input 的路径（去 .ts），
 * 完全由配置决定：.tscn 按名字引用脚本，匹配集不能反过来影响产物名。
 */
export function resolveEntries(
  workspaceRoot: string,
  patterns: EntryPattern[],
): GodotViteEntry[] {
  const list = normalizeEntries(patterns);
  if (list.length === 0) throw new Error("entries 未配置任何入口");

  const out: GodotViteEntry[] = [];
  const taken = new Map<string, string>();
  for (const p of list) {
    const inputRoot = resolve(workspaceRoot, p.input);
    const found = globSync([p.glob], {
      cwd: inputRoot,
      ignore: p.ignore,
      expandDirectories: false,
      onlyFiles: true,
    }).sort();
    if (found.length === 0) {
      throw new Error(
        `入口 glob 未匹配到任何文件：${p.glob}` +
          `（input: ${p.input === "" ? workspaceRoot : inputRoot}）`,
      );
    }
    for (const rel of found) {
      // name 会作为 rollup 的 input 键与 [name] 使用，只认 /
      const name = toPosix(p.output ? join(p.output, rel) : rel).replace(/\.ts$/, "");
      const file = resolve(inputRoot, rel);
      const dup = taken.get(name);
      if (dup) {
        throw new Error(
          `入口名重复：${name}\n  ${dup}\n  ${file}\n` +
            `两个模式匹配到不同文件却生成同名入口，请调整 input 或 output 使其区分。`,
        );
      }
      taken.set(name, file);
      out.push({ name, file });
    }
  }
  return out;
}

/**
 * 将产物中对兄弟 chunk 的相对 `require("./x")` 改写为 `res://` 绝对路径——GodotJS 会将
 * `require("./x")` 拼接为 `res:/x`（单斜杠）从而找不到文件。只处理以 ./ ../ 开头的字面量。
 * 必须在 generateBundle 完成：那里才知道 chunk 自身的产物路径，renderChunk 只能拿到源路径。
 */
export function godotRequirePlugin(resRoot: string): Plugin {
  return {
    name: "godot-angular-godot-require",
    enforce: "post",
    generateBundle(_info, bundle) {
      for (const [fileName, item] of Object.entries(bundle)) {
        if (item.type !== "chunk") continue;
        const base = dirname(fileName);
        item.code = item.code.replace(
          /require\((['"])(\.{1,2}\/[^'"]+)\1\)/g,
          // join 已将 ./ 和 .. 折叠，仅剩“Windows 上 join 输出反斜杠”这一步需要归一
          (_full, _q: string, spec: string) =>
            `require(${JSON.stringify(`${resRoot}/${toPosix(join(base, spec))}`)})`,
        );
      }
    },
  };
}

/**
 * `loader` 选项：将某个扩展名作为纯文本 / base64 内联。官方六种中的 `file` / `dataurl` /
 * `binary` 在 Godot 语境下没有落点，schema 直接不接受，而不是静默降级为 text。
 */
function loaderPlugin(loader: Record<string, string> | undefined): Plugin[] {
  const entries = Object.entries(loader ?? {});
  if (!entries.length) return [];
  return entries.map(([ext, kind]) => ({
    name: `godot-angular-loader-${ext.replace(/\W/g, "")}`,
    enforce: "pre",
    load: {
      filter: { id: idEndingWith(ext) },
      handler(id: string) {
        // 读取文件前移除查询串：id 可能是 `./x.txt?raw`
        const source = readText(withoutQuery(id), kind === "base64" ? "base64" : "utf8");
        return `export default ${JSON.stringify(source)}`;
      },
    },
  })) as Plugin[];
}

function readText(id: string, encoding: "utf8" | "base64"): string {
  // 给定 encoding 时返回 string（base64 是编码后的字符串，不是 Buffer）
  return readFileSync(id, encoding);
}

/** 不在 schema 中的内部通道，由 builder 入口在 parse **之后**附加。 */
export type GodotViteBuildInternals = {
  /**
   * 追加到 vite plugins 末尾。`runGodotViteWatch` 靠它注入每轮完成的 observer。
   */
  extraPlugins?: Plugin[];
  /**
   * 直接给定 input（名字 → id），跳过 `entries` 的 glob。
   * 引擎测试用它将入口替换为虚拟模块：场景脚本不应让使用方自行编写一份。
   */
  inputOverride?: Record<string, string>;
  logLevel?: InlineConfig["logLevel"];
};

/**
 * 构建核心接收的选项：已经过 `parseOptions` 的形状 + 内部字段。
 *
 * 使用 InferOutput（而不是 InferInput）是故意的：默认值已由 schema 补齐，这里每个
 * 字段都存在，因此下游不需要 `?? 默认值`。调用方必须先 parse，否则类型对不上。
 *
 * 两条链路共用这个核心，而 `styles` 只存在于 application 的 schema（vitest 那边在 schema
 * 层就拒掉了它），所以它是唯一被放宽成可选的字段：`Omit` 掉再 `Partial` 回来，其余字段
 * 仍严格取自 ApplicationOptions，schema 加字段时这里不会漏。缺省 = 没有全局样式表。
 */
export type GodotViteBuildOptions = Omit<ApplicationOptions, "styles"> &
  Partial<Pick<ApplicationOptions, "styles">> &
  GodotViteBuildInternals;

export async function runGodotViteBuild(
  options: GodotViteBuildOptions,
  context: BuilderContext,
): Promise<{ success: boolean }> {
  const prepared = await prepareConfig(options, context);
  if (!prepared) return { success: false };
  const { config, entryCount } = prepared;

  try {
    await build(config);
  } catch (err) {
    context.logger.error(formatBuildError(err));
    return { success: false };
  }
  context.logger.info(
    `已生成 ${entryCount} 个入口 → ${relative(context.workspaceRoot, resolve(context.workspaceRoot, options.outputPath))}`,
  );
  return { success: true };
}

/**
 * watch 形态：每轮构建完成 yield 一次结果，进程不退出。watch 只保证产物是新的，Godot
 * 将 .js 作为 Script 资源缓存，不重启或不 `--import` 就看不到新内容——价值在于“修改后立即
 * 得知能否编译成功”，而不是热替换。轮次靠一个观察插件的 buildEnd 推进，事件流用 ReplaySubject
 * 桥接为异步迭代，保证不丢轮次。
 */
export async function* runGodotViteWatch(
  options: GodotViteBuildOptions,
  context: BuilderContext,
): AsyncGenerator<{ success: boolean }> {
  const cycles = new ReplaySubject<boolean>();
  const observer: Plugin = {
    name: "godot-angular-watch-cycle",
    // 失败轮**也会**走到这里（err 非空），且本钩子先于 vite 自身的错误输出被调用
    buildEnd(err?: Error) {
      cycles.next(!err);
    },
  };

  const prepared = await prepareConfig(
    {
      ...options,
      watch: true,
      extraPlugins: [...(options.extraPlugins ?? []), observer],
    },
    context,
  );
  if (!prepared) {
    yield { success: false };
    return;
  }

  // watch 下 build() 不会等待全部轮次，它 resolve 出来的是 rolldown 的 watcher。健康 watch
  // 下这个 promise **不会 settle**，不能当作收尾点（收尾在下面的 finally）。此处保留 catch 仅为
  // 兜底：确实 reject 时若不挂 handler 会变成 unhandled rejection 直接终止进程。
  build(prepared.config).catch((err: unknown) => {
    context.logger.error(formatBuildError(err));
    cycles.next(false);
  });

  // 此处故意不注册 SIGINT 监听：Node 的规则是“有监听器就接管”，而 complete() 只能结束
  // 本构建器的循环，支撑事件循环的是 rolldown watcher 的句柄（无法获取、无法关闭）。注册监听后
  // Ctrl-C 反而从“立即终止”变成“无法退出”。

  try {
    // bufferedValuesFrom：一轮不丢——消费端尚未 yield 完就编译完成的几轮，会以数组形式一次性传递
    for await (const batch of bufferedValuesFrom(cycles)) {
      for (const ok of batch) {
        if (ok) {
          context.logger.info(
            `已生成 ${prepared.entryCount} 个入口 → ${relative(
              context.workspaceRoot,
              resolve(context.workspaceRoot, options.outputPath),
            )}${options.watch ? "（watch）" : ""}`,
          );
        } else {
          context.logger.warn(`本轮构建失败（watch 继续监听，文件修改后将自动重新构建）`);
        }
        // 失败不结束生成器：watch 的语义就是“出错后继续监听”，修改后下一轮自动到来
        yield { success: ok };
      }
    }
  } finally {
    // 结束 Subject：使 bufferedValuesFrom 的异步迭代收尾，不留挂着的订阅
    cycles.complete();
  }
}

/** 组装 vite 配置。返回 null 表示选项本身不合法，已输出日志。 */
async function prepareConfig(
  options: GodotViteBuildOptions,
  context: BuilderContext,
): Promise<{ config: InlineConfig; entryCount: number } | null> {
  const {
    entries,
    tsConfig,
    outputPath,
    resRoot,
    polyfills,
    optimization,
    sourceMap,
    define,
    externalDependencies,
    fileReplacements,
    assets,
    styles,
    deleteOutputPath,
    outputHashing,
    preserveSymlinks,
    conditions,
    loader,
    budgets,
    statsJson,
    watch,
    poll,
    verbose,
  } = options;

  const outDir = resolve(context.workspaceRoot, outputPath);

  // 存在 inputOverride 时入口是虚拟模块，`entries` 连配置都不需要
  const input: Record<string, string> = {};
  if (options.inputOverride) {
    Object.assign(input, options.inputOverride);
  } else {
    let entryList: GodotViteEntry[];
    try {
      entryList = resolveEntries(context.workspaceRoot, entries);
    } catch (err) {
      context.logger.error((err as Error).message);
      return null;
    }
    for (const e of entryList) {
      input[e.name] = e.file;
    }
  }
  const entryCount = Object.keys(input).length;
  // 补丁入口是**虚拟的、必带的**：内容第一行写定 `import "godot-angular/polyfills"`，
  // 用户 polyfills 只能往后追加。它作为入口必然单独成文件且不会被摇树，随后由
  // polyfillPlugin 将 require 写回每个入口顶部。inputOverride（引擎测试）同样适用此机制。
  const extras = polyfillExtras(polyfills);
  // 全局样式表挂在补丁入口后面：那个入口的存在就是为了抢在 Angular 之前求值，
  // 而全局 CSS 必须在第一个组件创建前就已存在（application 层样式表）。
  const globalStyles = normalizeGlobalStyles(styles, context.workspaceRoot);
  if (globalStyles.length) extras.push(GLOBAL_CSS_VIRTUAL);

  const log = (level: "warn" | "info", msg: string): void => {
    if (level === "warn") context.logger.warn(msg);
    else context.logger.info(msg);
  };

  // 入口名必须稳定：Godot 的 .tscn 按名字引用脚本，hash 只能加在共享 chunk 上。
  const hashed = outputHashing === "bundles" ? "-[hash]" : "";

  const config: InlineConfig = {
    configFile: false,
    root: context.workspaceRoot,
    mode: optimization ? "production" : "development",
    logLevel: options.logLevel ?? (verbose ? "info" : "warn"),
    cacheDir: resolve(context.workspaceRoot, ".ng-cache"),
    // 裸 `global` 必须编译期替换：GodotJS 中 global/self/window 全不存在，而很多“自动注入
    // 全局”的库写 (typeof self !== "undefined" ? self : global)。运行时补 globalThis.global
    // 无法补救——它在模块体内求值，早于本构建器的任何代码。
    define: { global: "globalThis", ...define },
    resolve: {
      dedupe: ["@angular/core"],
      ...(preserveSymlinks === undefined ? {} : { preserveSymlinks }),
      ...(conditions?.length ? { conditions } : {}),
    },
    plugins: [
      ...loaderPlugin(loader),
      // polyfill 由一个插件同时管理两头（虚拟入口 + 产物层注入 require）。必须在最前面：
      // 它的 resolveId 要抢在 vite 核心解析之前
      polyfillPlugin({ resRoot, extras }),
      ...angularPlugins(tsConfig, fileReplacements, context),
      icuDowngradePlugin((m) => context.logger.info(m)),
      // CSS 通道（源码层 styleUrls 守卫 + 全局样式虚拟模块）。数组位置只决定同阶段的先后，
      // 真正的顺序由 enforce 决定（源码层必须抢在 analog 之前）。
      ...cssPlugins({
        globalStyles,
        workspaceRoot: context.workspaceRoot,
        log: (m) => context.logger.info(m),
      }),
      // 必须在 godotRequirePlugin 之前：它改的是**模块源码**里的 import，而
      // godotRequirePlugin 改的是**产物**里的 require，两者不在一个阶段。
      godotInteropPlugin((m) => context.logger.info(m)),
      godotRequirePlugin(resRoot),
      assetsPlugin(normalizeAssets(assets), context.workspaceRoot),
      budgetsPlugin({ budgets, statsJson, log }),
      ...(options.extraPlugins ?? []),
    ],
    build: {
      outDir,
      emptyOutDir: deleteOutputPath,
      sourcemap: sourceMap,
      minify: optimization ? "esbuild" : false,
      target: "es2022",
      ...(watch
        ? {
            watch: {
              buildDelay: 100,
              ...(poll ? { usePolling: true, pollInterval: poll } : {}),
            },
          }
        : {}),
      rollupOptions: {
        // GodotJS 内建模块 + externalDependencies，产物里原样保留 require(...)
        external: (id: string) =>
          id === "godot" || id.startsWith("godot/") || isExternalDependency(id, externalDependencies),
        input: { ...input, [POLYFILL_ENTRY_NAME]: POLYFILL_ENTRY_SPECIFIER },
        // 不设这个，入口的具名导出会被摇掉且**不报错**（整个 App 组件会跟着一起消失）
        preserveEntrySignatures: "strict",
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
          chunkFileNames: `chunks/[name]${hashed}.js`,
          // 用 named 不用 auto：auto 在只有一个 default 导出时会发
          // `module.exports = Main`，而 GodotJS 从 `exports.default` 取脚本类。
          exports: "named",
        },
      },
    },
  };

  if (options.viteConfig) {
    const merged = await mergeUserViteConfig(config, options.viteConfig, context);
    if (!merged) return null;
    return { config: merged, entryCount };
  }
  return { config, entryCount };
}

function angularPlugins(
  tsConfig: string,
  fileReplacements: FileReplacement[] | undefined,
  context: BuilderContext,
): Plugin[] {
  return angular({
    tsconfig: tsConfig,
    workspaceRoot: context.workspaceRoot,
    fastCompile: false,
    // fileReplacements 直接交给 analog：它自身有一个 resolveId 版的 replaceFiles 插件，语义与
    // 官方一致。不要改为 vite resolve.alias——alias 比对的是**未解析的说明符**（`./env`），
    // 而 fileReplacements 给出的是文件路径，正则永远不会命中。
    ...(fileReplacements?.length ? { fileReplacements } : {}),
    experimental: { useAngularCompilationAPI: true },
  });
}

/**
 * 逃生口：将用户 vite 配置叠加在本构建器的配置之上（vite 的 loadConfigFromFile + mergeConfig）。
 * plugins 是追加而不是替换——本构建器的插件若被顶掉，产物直接无法运行。
 */
async function mergeUserViteConfig(
  config: InlineConfig,
  viteConfig: string,
  context: BuilderContext,
): Promise<InlineConfig | null> {
  const path = resolve(context.workspaceRoot, viteConfig);
  let loaded: { config: UserConfig } | null;
  try {
    loaded = await loadConfigFromFile({ command: "build", mode: config.mode ?? "production" }, path, context.workspaceRoot);
  } catch (err) {
    context.logger.error(`viteConfig 读取失败（${viteConfig}）：${formatBuildError(err)}`);
    return null;
  }
  if (!loaded) {
    context.logger.error(`viteConfig 指向的文件未导出任何配置：${viteConfig}`);
    return null;
  }
  return mergeConfig(config, loaded.config) as InlineConfig;
}

/** vite/rollup 将插件名、文件、代码帧挂在 error 对象上，String() 只剩第一行 */
function formatBuildError(err: unknown): string {
  const e = err as { message?: string; plugin?: string; frame?: string };
  const parts = [e.message ?? String(err)];
  if (e.plugin) parts.unshift(`[${e.plugin}]`);
  if (e.frame) parts.push(e.frame);
  return parts.join("\n");
}
