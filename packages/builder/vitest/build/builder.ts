import { createBuilder, type Builder } from "@angular-devkit/architect";
import type { JsonObject } from "@angular-devkit/core";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { globSync } from "tinyglobby";
import { COVERAGE_ENV } from "../../shared/coverage";
import { parseOptions } from "../../shared/parse-options";
import { runGodotViteBuild, type GodotViteBuildInternals } from "../../vite/build-core";
import {
  coverageInstrumentPlugins,
  defaultCoverageRoots,
} from "../../vite/coverage-plugin";
import {
  coverageOptionsSchema,
  vitestOptionsSchema,
  type CoverageOptionInput,
  type CoverageOptions,
  type RawVitestOptions,
  type VitestOptions,
} from "../../vite/options-schema";
import {
  collectSpecFiles,
  VITEST_ENTRY_NAME,
  VITEST_ENTRY_SPECIFIER,
  vitestEntryPlugin,
} from "./virtual-entry";

/**
 * vitest builder 的选项：共享项 + 引擎/跑测专有项，形状全在 options-schema.ts。
 * 此处直接引用导出的 `VitestOptions`（已是 **parse 之后**的形状，默认值已补），
 * 不在此处重新 `v.InferOutput` 一份。它可直接交给 `runGodotViteBuild`：那边比这边多的
 * 只有 `styles`（已降为可选）与内部字段。
 */
type GodotVitestBuildOptions = VitestOptions & GodotViteBuildInternals;

const builder: Builder<RawVitestOptions & JsonObject> =
  createBuilder<RawVitestOptions>(async (raw, context) => {
    const options = parseOptions(vitestOptionsSchema, raw, "vitest");
    const coverage = resolveCoverageOptions(options.coverage);

    if (!options.skipBuild) {
      // 清单不落盘：提前 glob 一次只为“未匹配到时提前退出”，真正的清单由虚拟模块在
      // load 阶段给出（两边共用同一个 collectSpecFiles，不会漂移）
      const files = collectSpecFiles(context.workspaceRoot, options.specInclude, options.exclude);
      if (files.length === 0) {
        context.logger.error(`specInclude 未匹配到任何文件：${options.specInclude.join(", ")}`);
        return { success: false };
      }
      context.logger.info(`spec 清单（虚拟模块，不落盘）：${files.length} 个文件`);
      const built = await runGodotViteBuild(
        {
          ...options,
          entries: options.entries ?? [],
          // 入口也是虚拟的：使用方不需要（也不应该）自行编写场景脚本
          inputOverride: { [VITEST_ENTRY_NAME]: VITEST_ENTRY_SPECIFIER },
          extraPlugins: [
            vitestEntryPlugin({
              workspaceRoot: context.workspaceRoot,
              patterns: options.specInclude,
              ignore: options.exclude,
              defaultPort: options.engine.port,
            }),
            ...(coverage.enabled
              ? coverageInstrumentPlugins(
                  coveragePluginOptions(
                    coverage,
                    context.workspaceRoot,
                    options.sourceMap,
                    context.logger.info.bind(context.logger),
                  ),
                )
              : []),
          ],
        },
        context,
      );
      if (!built.success) return built;
    } else if (coverage.enabled) {
      context.logger.warn(
        "已启用 coverage 但同时启用了 skipBuild：产物未重新插桩，覆盖率报告将为空或来自上一次构建。",
      );
    }

    if (options.skipRun) {
      context.logger.info("skipRun: true —— 仅执行构建，测试需自行运行。");
      return { success: true };
    }

    return runVitest(options, context);
  });

/**
 * 在进程内运行 vitest。配置全部由参数生成（`config: false` 表示不使用外部 vitest 配置），
 * 因此用户仓库中不需要 vitest 配置文件。
 */
async function runVitest(
  options: GodotVitestBuildOptions,
  context: BuilderContextLike,
): Promise<{ success: boolean }> {
  // 路径拼接为 `string`（而不是字面量）：TS 不会解析它（源树中该位置是 .ts），
  // 打包器也无法静态解析，不会将 ESM 插件内联进 CJS 产物。运行时从
  // dist/builder/vitest/build/ 解析到 dist/builder/vitest/node/index.mjs。
  const specifier = "../node/index.mjs" as string;
  const { godotEngineTest } = (await import(specifier)) as unknown as {
    godotEngineTest: (o: Record<string, unknown>) => unknown;
  };
  const { startVitest } = (await import("vitest/node")) as typeof import("vitest/node");

  const engine = options.engine;
  const coverage = resolveCoverageOptions(options.coverage);
  const coverageOptions = coverage.enabled ? coverageVitestOptions(coverage, context.workspaceRoot) : undefined;
  const cliOptions = {
    // 不加载外部 vitest 配置：本 builder 就是配置的唯一来源（angular.json）。
    config: false as const,
    root: context.workspaceRoot,
    include: options.specInclude,
    // exclude 在此处是第二道：bundle 中的清单已按它筛过（generateSpecEntry），
    // 此处同步过去，避免 vitest 的 include/exclude 与产物清单各自为政。
    ...(options.exclude?.length ? { exclude: options.exclude } : {}),
    // 引擎中没有 DOM，也不应该有：宿主侧只负责调度，环境必须是纯 node。
    environment: "node",
    globals: true,
    // 引擎是常驻单 worker，文件之间共享状态，不应开启并发。
    fileParallelism: false,
    // 引擎中运行的是真实节点树，但均为 CPU 侧操作，单个用例为毫秒级。默认 5s/10s
    // 只会把“卡住了”变成“等待很久才报告卡住”。
    testTimeout: 5_000,
    hookTimeout: 5_000,
    teardownTimeout: 2_000,
    watch: !!options.watch,
    ...(options.reporters?.length ? { reporter: options.reporters } : {}),
    ...(options.filter ? { testNamePattern: options.filter } : {}),
    ...(coverageOptions ? { coverage: coverageOptions } : {}),
  };

  const vitest = await startVitest(
    "test",
    options.fileFilters ?? [],
    cliOptions as never,
    {
      plugins: [
        godotEngineTest({
          port: engine.port,
          host: "127.0.0.1",
          projectPath: engine.projectPath,
          scene: engine.scene,
          godotBin: engine.godotBin,
          noLaunch: engine.noLaunch,
          connectTimeout: engine.connectTimeout,
          // glob 的唯一来源就是 angular.json 的 specInclude。同进程，直接传参，不经磁盘。
          specInclude: options.specInclude,
        }),
      ],
    } as never,
  );

  try {
    // 成败判定沿用官方 unit-test builder：看每个 testModule 自身的 ok 状态。
    const modules = vitest.state.getTestModules();
    let success = modules.length > 0 && modules.every((m) => m.ok());
    if (!success && modules.length === 0) {
      context.logger.error("vitest 未执行任何测试文件，请检查 specInclude 是否匹配到文件。");
    }
    // vitest 覆盖率阈值不达标时不修改结果，只将 process.exitCode 设为 1。
    if (success && process.exitCode === 1) {
      success = false;
      process.exitCode = 0;
    }
    return { success };
  } finally {
    await vitest.close();
  }
}

/** 仅使用 workspaceRoot + logger，抽取出来避免绑定 BuilderContext 的具体类型 */
interface BuilderContextLike {
  workspaceRoot: string;
  logger: { info(m: string): void; error(m: string): void; warn(m: string): void };
}

/* ------------------------------------------------------------------ *
 * 覆盖率
 * ------------------------------------------------------------------ */

/**
 * `coverage` 允许写成布尔速记（`--coverage=false`）或完整对象，此处归一为同一个形状。
 * 对象分支在 `vitestOptionsSchema` 中已经 parse 过（默认值已补），只有布尔需要补默认值。
 */
function resolveCoverageOptions(raw: CoverageOptionInput): CoverageOptions {
  const input = raw === true ? {} : raw === false || raw === undefined ? { enabled: false } : raw;
  return parseOptions(coverageOptionsSchema, input, "coverage");
}

/**
 * 构建期的插桩范围。
 *
 * 默认只插桩发布物（`node_modules/godot-angular/fesm2022/`）：引擎中运行的就是它，插桩它才做到
 * “测试的就是发布的代码”。builder 自身的 runtime、第三方依赖一律不插桩，否则报告充斥无用信息。
 */
function coveragePluginOptions(
  coverage: CoverageOptions,
  workspaceRoot: string,
  sourceMap: boolean,
  log: (m: string) => void,
) {
  // 发布物插桩是否开启，由插件自身读取 `COVERAGE_PACKAGE_ENV` 决定（见 coverage-plugin.ts），
  // 此处只负责将目录找出来。`instrument` 是追加，不是替换：若做成替换，想要连同 src 一起
  // 统计的人还需要自行写出 node_modules/godot-angular/fesm2022/*.mjs，那就不算配置了。
  const roots = defaultCoverageRoots(workspaceRoot);
  // 插桩是否交 map，与构建是否输出 sourcemap 绑定：未开 sourcemap 时产物本来就没有映射，
  // 多交一份只会使体积变大；开启时若不交，被插桩的 chunk 在 map 中会被抹为零映射。
  if (!coverage.instrument?.length) return { roots, sourceMap, log };
  const files = globSync(coverage.instrument, {
    cwd: workspaceRoot,
    absolute: true,
    onlyFiles: true,
    expandDirectories: false,
  });
  if (!files.length) {
    log(`覆盖率：instrument 未匹配到文件（${coverage.instrument.join(", ")}）`);
  }
  return { roots, files, sourceMap, log };
}

/**
 * 传给 vitest 的 coverage 配置 + 传递给 provider 的环境变量。
 *
 * provider 使用 `provider: "custom"`：内部委托 `@vitest/coverage-istanbul`，reporter /
 * 阈值 / 临时文件全是它原生的行为，本构建器只在中间补充 source map。
 *
 * 此处故意**不**将 include/exclude 交给 vitest，两条结论均来自实测：
 * - 它那份 include 匹配发生在 remap 之前，对着一堆 node_modules 产物路径空转（remap 后的
 *   源码在 vitest root 之外，且仍是 .ts）；写成 `../packages/**` 又匹配不到 remap 后的绝对路径。
 * - include 一非空，istanbul 必然枚举未测文件并逐个走 vite 转换链插桩，而 root 外的文件
 *   在转换链上找不到归属——不是口径不同，是直接失败。
 * include 的语义由 provider 在 remap 之后自行实现：只做过滤，不往报告里补充未运行的文件。
 */
function coverageVitestOptions(coverage: CoverageOptions, workspaceRoot: string): Record<string, unknown> {
  const sourceRoot = resolve(workspaceRoot, coverage.sourceRoot);
  process.env[COVERAGE_ENV.sourceRoot] = sourceRoot;
  process.env[COVERAGE_ENV.workspaceRoot] = workspaceRoot;
  process.env[COVERAGE_ENV.include] = coverage.include?.length ? JSON.stringify(coverage.include) : "";
  process.env[COVERAGE_ENV.exclude] = coverage.exclude?.length ? JSON.stringify(coverage.exclude) : "";

  // provider 与 builder 同包不同目录，路径由本模块位置推导（发布物中也是这个布局）。
  // 写成非字面量：不让打包器将其作为静态依赖内联进来，它必须作为独立文件被 vitest 加载。
  const specifier = "../node/coverage-provider.mjs" as string;
  const providerPath = resolve(dirname(fileURLToPath(import.meta.url)), specifier);
  if (!existsSync(providerPath)) {
    throw new Error(
      `未找到 coverage provider：${providerPath}。发布物不完整，请重新构建 builder。`,
    );
  }

  return {
    enabled: true,
    provider: "custom",
    customProviderModule: providerPath,
    reportsDirectory: resolve(workspaceRoot, coverage.reportsDirectory),
    clean: true,
    allowExternal: true,
    reportOnFailure: coverage.reportOnFailure,
    ...(coverage.reporter?.length ? { reporter: coverage.reporter } : {}),
    ...(coverage.thresholds ? { thresholds: coverage.thresholds } : {}),
  };
}

export default builder;
