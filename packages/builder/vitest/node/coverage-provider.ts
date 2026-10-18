import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { globSync } from "tinyglobby";
import type { CoverageProvider, CoverageProviderModule } from "vitest/node";
import { COVERAGE_ENV } from "../../shared/coverage";
import { toPosix } from "../../shared/path";

/**
 * 构建器 → 本模块的配置通道见 `shared/coverage.ts`：provider 由 vitest 的 module runner
 * 加载，与 builder 不是同一个模块实例，同进程也无法传递闭包，环境变量是唯一那条无需写文件的通道。
 */
interface CoverageEnvConfig {
  /** remap 写入根路径（发布物 source map 指回源码的位置） */
  sourceRoot: string;
  /** include / exclude 的基准，与 vitest 一致 = 工作区根 */
  workspaceRoot: string;
  include: string[] | undefined;
  exclude: string[] | undefined;
}

function readList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length ? (parsed as string[]) : undefined;
  } catch {
    return undefined;
  }
}

function readEnv(): CoverageEnvConfig {
  return {
    sourceRoot: process.env[COVERAGE_ENV.sourceRoot] || process.cwd(),
    workspaceRoot: process.env[COVERAGE_ENV.workspaceRoot] || process.cwd(),
    include: readList(process.env[COVERAGE_ENV.include]),
    exclude: readList(process.env[COVERAGE_ENV.exclude]),
  };
}

/** istanbul 的 CoverageMap，仅声明此处使用的几个方法 */
interface CoverageMapLike {
  files(): string[];
  filter(predicate: (filename: string) => boolean): void;
}

const mapCache = new Map<string, object | undefined>();

function readRawMap(file: string): { mapFile: string; map: Record<string, unknown> } | undefined {
  const load = (mapFile: string): { mapFile: string; map: Record<string, unknown> } | undefined => {
    try {
      return { mapFile, map: JSON.parse(readFileSync(mapFile, "utf8")) as Record<string, unknown> };
    } catch {
      return undefined;
    }
  };
  const sidecar = `${file}.map`;
  if (existsSync(sidecar)) return load(sidecar);
  // 内联的 sourceMappingURL 注释（发布物使用 sidecar，此处仅作为兜底）
  try {
    const tail = readFileSync(file, "utf8").slice(-512);
    const match = /\/\/[#@] sourceMappingURL=(\S+)\s*$/.exec(tail);
    if (!match) return undefined;
    const target = resolve(dirname(file), match[1]!);
    return existsSync(target) ? load(target) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 将 map 中的一条 source 对应到真实文件上。
 *
 * 发布物中的 map 写的是 `../../packages/library/core/x.ts`，坐标是打包时的 dist 目录；
 * 装进 node_modules 后同样的相对路径指向 `node_modules/packages/...`，而且发布包的根
 * 与 dist 层数不同，按固定层数往上推会随布局失效。因此改为在 sourceRoot 下查找同尾的
 * 真实路径：从最长的尾巴开始尝试，第一个存在的就是它。本来就存在的绝对路径（仓内直接
 * 使用 dist/）第一轮就命中。
 */
function relocate(bogus: string, sourceRoot: string): string | undefined {
  const parts = toPosix(bogus).split("/").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const candidate = resolve(sourceRoot, ...parts.slice(i));
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * 产物 source map → 能够 remap 回源码的 inputSourceMap。
 *
 * 一个源文件都定位不到时返回 undefined：外部用户没有源码，那就按发布物输出报告，
 * 也比一份空报告有用。
 */
function loadInputSourceMap(file: string, sourceRoot: string): object | undefined {
  if (mapCache.has(file)) return mapCache.get(file);
  const raw = readRawMap(file);
  if (!raw) {
    mapCache.set(file, undefined);
    return undefined;
  }
  const sources = Array.isArray(raw.map.sources) ? (raw.map.sources as string[]) : [];
  const real = sources.map((s) => relocate(resolve(dirname(raw.mapFile), s), sourceRoot));
  if (!real.some((s) => s !== undefined)) {
    mapCache.set(file, undefined);
    return undefined;
  }
  // 定位不到的那几条保持原样（指向不存在的文件，istanbul 自身会丢弃）
  raw.map.sources = real.map((s, i) => s ?? toPosix(resolve(dirname(raw.mapFile), sources[i]!)));
  // 源码在磁盘上，报告自身读取得到；这个字段只会将载荷增大几十倍
  delete raw.map.sourcesContent;
  mapCache.set(file, raw.map);
  return raw.map;
}

/**
 * 引擎传来的条目中没有 map（发布物插桩时不携带），在此处按产物路径补上。
 * 引擎自身带来的（应用代码插桩时由构建插件塞入的 transform map）保留，不要覆盖。
 */
function attachInputSourceMaps(coverage: unknown, sourceRoot: string): number {
  if (!coverage || typeof coverage !== "object") return 0;
  let attached = 0;
  for (const [file, entry] of Object.entries(coverage as Record<string, Record<string, unknown> | undefined>)) {
    if (!entry || typeof entry !== "object") continue;
    const disk = loadInputSourceMap(file, sourceRoot);
    if (disk) entry.inputSourceMap = disk;
    if (disk || entry.inputSourceMap) attached += 1;
  }
  return attached;
}

async function loadMatchers(patterns: string[] | undefined): Promise<Array<(s: string) => boolean>> {
  if (!patterns?.length) return [];
  // picomatch 是 CJS，函数本体在 ESM 侧挂在 default 上（Node 与 vitest 的 module runner 形状相同）
  const { default: pm } = await import("picomatch");
  // windows: false —— 比较使用的路径一律经 toPosix，不要让平台差异改变匹配结果
  return patterns.map((p) => pm(p, { dot: true, windows: false }));
}

/**
 * 将 include 展开为“应进入报告的源文件”集合。
 *
 * 基准是 workspaceRoot（与 vitest 的 coverage.include 同口径，`src/**` 这种写法无需改变习惯）；
 * 需要引入工作区外的文件时写 `../` 前缀，tinyglobby 直接接受。
 *
 * exclude 不使用 glob 而是逐文件匹配：glob 的基准是 cwd，`**\/*.spec.ts` 在 test-app 下无法
 * 作用到 `../packages/**`，使用相对路径匹配才能“不管文件位于何处都能排除”。
 */
async function resolveIncludedFiles(env: CoverageEnvConfig): Promise<Set<string>> {
  if (!env.include?.length) return new Set();
  const keep = globSync(env.include, {
    cwd: env.workspaceRoot,
    absolute: true,
    onlyFiles: true,
    dot: true,
    expandDirectories: false,
  }).map(toPosix);
  const matchers = await loadMatchers(env.exclude);
  const out = new Set<string>();
  for (const file of keep) {
    // monorepo 中 packages/*/node_modules 确实存在，无条件排除，不依赖使用方编写 exclude
    if (file.includes("/node_modules/")) continue;
    const rel = toPosix(relative(env.workspaceRoot, file));
    if (matchers.some((m) => m(rel) || m(file))) continue;
    out.add(file);
  }
  return out;
}

/** 只筛不补：keep 中没有的文件一律从报告移除（调用方自行判断 keep 是否可用） */
function applyIncludeFilter(coverageMap: CoverageMapLike, keep: Set<string>): void {
  coverageMap.filter((file) => keep.has(toPosix(file)));
}

const providerModule: CoverageProviderModule = {
  async getProvider(): Promise<CoverageProvider> {
    const mod = await import("@vitest/coverage-istanbul");
    const inner = await mod.default.getProvider();
    const env = readEnv();
    let reports = 0;
    let attached = 0;

    return {
      name: inner.name,
      initialize: (ctx) => inner.initialize(ctx),
      resolveOptions: () => inner.resolveOptions(),
      clean: (clean) => inner.clean(clean),
      onAfterSuiteRun: (meta) => {
        reports += 1;
        attached += attachInputSourceMaps(meta.coverage, env.sourceRoot);
        return inner.onAfterSuiteRun(meta);
      },
      onTestRunStart: () => inner.onTestRunStart?.(),
      onTestFailure: () => inner.onTestFailure?.(),
      generateCoverage: async (reportContext) => {
        const coverageMap = (await inner.generateCoverage(reportContext)) as Partial<CoverageMapLike> | undefined;
        const map =
          coverageMap && typeof coverageMap.filter === "function" ? (coverageMap as CoverageMapLike) : undefined;
        let keep = new Set<string>();
        if (map && env.include?.length) {
          keep = await resolveIncludedFiles(env);
          // 展开为 0 时不能默默不过滤：那会将 node_modules 产物一并写入报告，看起来像“范围很宽”
          // 而不是“include 写错了”。不筛也比交一份空报告好。
          if (keep.size) applyIncludeFilter(map, keep);
          else
            process.stderr.write(
              `[cuj-vitest] 覆盖率：include 未匹配到任何文件（${env.include.join(", ")}），本次未按 include 过滤。` +
                `基准目录为 workspaceRoot（${env.workspaceRoot}），匹配工作区外的文件需使用 ../ 前缀。\n`,
            );
        }
        const fileCount = map ? map.files().length : 0;
        if (!reports) {
          process.stderr.write(
            "[cuj-vitest] 覆盖率：引擎未回传任何数据。产物必须经本次构建插桩" +
              "（启用 coverage 时请勿使用 skipBuild），且引擎侧 runtime 与 builder 版本需保持一致。\n",
          );
        } else {
          // remap 未命中时报告会是空的，这一行是唯一能区分“未运行到”和“remap 失败”的线索；
          // include 展开数则用于区分“确实未运行到”和“include 写错”。
          const includeNote = env.include?.length ? `，include 展开 ${keep.size} 个` : "";
          process.stdout.write(
            `[cuj-vitest] 覆盖率：${reports} 份上报，${attached} 个文件关联到 map，` +
              `报告中 ${fileCount} 个源文件${includeNote}\n`,
          );
        }
        return coverageMap;
      },
      reportCoverage: (coverage, reportContext) => inner.reportCoverage(coverage, reportContext),
      // vitest 原生 CoverageProvider 的接口，原样委托给内层 provider：多个 worker 对同一
      // 文件的计数在 istanbul 层合并一次，范围就是本次运行。
      ...(inner.mergeReports ? { mergeReports: (coverages: unknown[]) => inner.mergeReports?.(coverages) } : {}),
      onEnabled: () => inner.onEnabled?.(),
    };
  },
};

export default providerModule;
