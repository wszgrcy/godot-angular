import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin, ViteUserConfig } from "vitest/config";
import type { PoolRunnerInitializer, VitestPluginContext } from "vitest/node";
import type { EngineOptions } from "../../vite/options-schema";
import { ensureImported, requireGodotBin } from "../../shared/godot-bin.js";
import { GodotPoolWorker } from "./pool-worker.js";
import { GodotVitestSession } from "./session.js";

/** 引擎侧选项：端口与超时不在此列，它们属于会话，见 `session` 字段 */
export type GodotEngineLaunchOptions = Partial<
  Omit<EngineOptions, "port" | "connectTimeout">
>;

export interface GodotEngineVitestOptions extends GodotEngineLaunchOptions {
  /**
   * 已 `start()` 的宿主会话。端口在它 start 的那一刻就定了（起始值被占则已自增），
   * 写进产物的、宿主监听的、启动引擎时传的都是同一个 `session.port`。
   *
   * 为什么由调用方创建而不是插件内部：顺序必须是“开监听 → 构建 → 启动引擎”，
   * 端口晚一步确定就来不及写进产物，而插件挂钩子时构建已经跑完了。
   */
  session: GodotVitestSession;
  /** spec 文件 glob（相对 workspaceRoot），直接用作 vitest 的 `include`；不传则用调用方配的 `test.include` */
  specInclude?: string[];
  exclude?: string[];
}

/**
 * 将 vitest 的文件执行搬进真实 GodotJS 进程：宿主照常运行 vitest，只将
 * “执行一个文件”换成往 WebSocket 发一条 WorkerRequest，由引擎内的常驻 worker 执行。
 *
 * 使用自定义 pool 而不是 browser provider：引擎中 fetch / XHR / 动态 import 全不可用，
 * 无法获取 vitest 那个 `/__vitest_test__/` 页面和它的模块图，provider 换不掉这一层地基。
 */
export function godotEngineTest(options: GodotEngineVitestOptions): Plugin {
  const { session } = options;
  let child: ChildProcess | undefined;

  return {
    name: "vitest-godot-pool",
    /** 默认开启 `test.globals`：引擎端据此决定是否需要 `registerApiGlobally()`，未开启则裸 `describe` 直接 ReferenceError 并一直等到超时 */
    config(config: ViteUserConfig): void {
      const test = (config.test ??= {});
      if (test.globals === undefined) test.globals = true;
    },

    configureVitest(context: VitestPluginContext): void {
      const { project } = context;
      const poolRunner: PoolRunnerInitializer = {
        name: "godot",
        // 引擎只有一个常驻 worker，所有 PoolWorker 都是它的代理，不传递序号
        createPoolWorker: () => new GodotPoolWorker(session),
      };

      project.config.pool = poolRunner.name;
      project.config.poolRunner = poolRunner;
      // 并发固定为 1：引擎只有一个运行环境，session 也只保存一条 socket
      project.config.maxWorkers = 1;
      // 常驻环境，而不是可丢弃进程：隔离会让每个文件重新等待一次 worker-ready
      project.config.isolate = false;
      if (options.specInclude?.length) {
        project.config.include = options.specInclude;
      }
      if (options.exclude) project.config.exclude = options.exclude;


      void session
        .start()
        .then(() => launchEngine(options, session.port))
        .then((proc: ChildProcess | undefined) => {
          child = proc;
        })
        .catch((err: Error) => {
          process.stderr.write(`[cuj-vitest] ${err.message}\n`);
        });
    },

    closeBundle(): void {
      terminate(child);
      child = undefined;
    },
  };
}

/** SIGTERM 后给出有限宽限期，未退出则 SIGKILL（引擎卡在未返回的调用中时会接收 SIGTERM 但不退出） */
function terminate(proc: ChildProcess | undefined): void {
  if (!proc || proc.exitCode !== null) return;
  proc.kill("SIGTERM");
  const hard = setTimeout(() => {
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }, 5_000);
  // 已正常退出时不要让这个 timer 继续维持事件循环
  proc.once("exit", () => clearTimeout(hard));
  hard.unref?.();
}

/** 拉起引擎进程。返回 undefined 表示按配置不应由宿主启动。 */
async function launchEngine(
  options: GodotEngineLaunchOptions,
  port: number,
): Promise<ChildProcess | undefined> {
  if (options.noLaunch || !options.projectPath || !options.scene) return undefined;
  const root = process.cwd();
  const projectDir = resolve(root, options.projectPath);
  if (!existsSync(projectDir)) {
    throw new Error(`projectPath 不存在：${projectDir}`);
  }
  const bin = requireGodotBin(root, options.godotBin);
  ensureImported(projectDir, bin);
  const proc = spawn(bin, ["--headless", "--path", projectDir, options.scene], {
    env: { ...process.env, CUJ_WS_PORT: String(port) },
  });
  // 引擎自身的 stdout 中 [EVITEST]/[JS] 那些行是有用的诊断，透传输出。
  proc.stdout?.on("data", (d: Buffer) => process.stdout.write(d));
  proc.stderr?.on("data", (d: Buffer) => process.stderr.write(d));
  proc.on("exit", (code) => {
    process.stdout.write(`[cuj-vitest] 引擎进程已退出（退出码 ${String(code)}）\n`);
  });
  const bye = (): void => {
    terminate(proc);
  };
  process.once("exit", bye);
  process.once("SIGINT", bye);
  return proc;
}
