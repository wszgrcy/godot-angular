import { createBirpc } from "birpc";
import { collectTests, setupCommonEnv, startTests } from "vitest/internal/browser";
import type {
  CancelReason,
  RunnerRPC,
  RuntimeRPC,
  VitestTestRunner,
  WorkerGlobalState,
} from "vitest";
import type { WorkerRequest, WorkerResponse } from "vitest/node";
import { CUJ_COVERAGE_KEY, takeCoverageDelta } from "./coverage";
import type { TestModuleRegistry } from "./registry";
import { GodotTestRunner } from "./runner";

/** 将一帧 payload 发给宿主。信封（kind/frame）由调用方拼接，worker 不接触传输层。 */
type SendFrame = (payload: unknown) => void;

/** vitest 用它读当前 worker 状态，必须挂在 globalThis 上。 */
const NAME_WORKER_STATE = "__vitest_worker__";

interface GodotWorkerOptions {
  sendFrame: SendFrame;
  registry: TestModuleRegistry;
  onFileFinished?(filepath: string): void;
}

/** CancelReason 联合中那条 `(string & Record<never,never>)` 兜底分支不接受字面量。 */
const HOST_CANCEL_REASON = "godot-host-cancel" as CancelReason;

function serializeError(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: (error as unknown as { cause?: unknown }).cause,
    };
  }
  return error;
}

/**
 * 引擎侧的 worker：将 WebSocketPeer 作为 vitest 的 worker 通道，接上 WorkerRequest /
 * WorkerResponse 与 birpc 双向 RPC，reporter 完全不知道对端是一个游戏引擎。
 * `vitest` / `vitest/node` 只能 `import type`：它们的运行时是 Node 专用，值导入进包后引擎内必然报错。
 */
export class GodotWorker {
  private readonly rpc: ReturnType<typeof createBirpc<RuntimeRPC, RunnerRPC>>;
  private readonly rpcHandlers = new Set<(message: unknown) => void>();
  private readonly cancelListeners = new Set<(reason: CancelReason) => unknown>();
  private readonly cleanupListeners = new Set<() => unknown>();
  private startContext: Extract<WorkerRequest, { type: "start" }> | undefined;
  private projectName: string | undefined;
  /** 已经发给宿主的 inputSourceMap（同一个文件只发一次） */
  private readonly coverageMaps = new Set<string>();
  private running = false;

  constructor(private readonly options: GodotWorkerOptions) {
    this.rpc = createBirpc<RuntimeRPC, RunnerRPC>(
      {
        // 引擎能响应的反向调用极少，但 cancel 必须实现：未实现时宿主发 cancel 会一直等到超时。
        onCancel: async (reason: CancelReason) => {
          for (const listener of this.cancelListeners) await listener(reason);
        },
      },
      {
        eventNames: ["onCancel"],
        timeout: -1,
        post: (message) => this.options.sendFrame(message),
        on: (handler) => this.rpcHandlers.add(handler as (m: unknown) => void),
        off: (handler) => this.rpcHandlers.delete(handler as (m: unknown) => void),
      },
    );
  }

  /** 传输层收到一条消息时调用；返回 true 表示这条是 RPC 帧，已被消费。 */
  feedRpc(message: unknown): boolean {
    if (!this.looksLikeRpc(message)) return false;
    for (const handler of this.rpcHandlers) handler(message);
    return true;
  }

  /** birpc 帧没有显式标记，只能依靠形状区分：worker 请求带 `__vitest_worker_request__`。 */
  private looksLikeRpc(message: unknown): boolean {
    return (
      typeof message === "object" &&
      message !== null &&
      (message as { __vitest_worker_request__?: unknown }).__vitest_worker_request__ !== true
    );
  }

  private respond(response: WorkerResponse): void {
    this.options.sendFrame(response);
  }

  async handle(message: WorkerRequest): Promise<void> {
    switch (message.type) {
      case "start":
        this.startContext = message;
        this.respond({ __vitest_worker_response__: true, type: "started" });
        return;
      case "run":
      case "collect":
        await this.execute(message.type, message.context);
        return;
      case "cancel":
        for (const listener of this.cancelListeners) await listener(HOST_CANCEL_REASON);
        return;
      case "stop":
        for (const listener of this.cleanupListeners) await listener();
        this.respond({ __vitest_worker_response__: true, type: "stopped" });
        return;
    }
  }

  private async execute(
    method: "run" | "collect",
    context: Extract<WorkerRequest, { type: "run" }>["context"],
  ): Promise<void> {
    if (!this.startContext)
      throw new Error("收到 run/collect 请求前必须先收到 start 消息");
    if (this.running)
      throw new Error("上一个测试文件尚未执行完成，却收到新的 run 请求");
    this.running = true;
    this.projectName = context.providedContext?.["__vitest_project_name"] as string | undefined;
    const state = this.createState(context);
    (globalThis as Record<string, unknown>)[NAME_WORKER_STATE] = state;
    try {
      // 安装 vitest 的运行期全局（expect 的 global state、fake timers 依赖等）。
      // Node worker 由 pool 负责，引擎需要自行调用。
      await setupCommonEnv(this.startContext.context.config);
      const runner: VitestTestRunner = new GodotTestRunner({
        config: this.startContext.context.config,
        registry: this.options.registry,
        onTaskUpdate: async (packs, events) => {
          await this.rpc.onTaskUpdate(packs, events);
        },
        onQueued: (file) => {
          void this.rpc.onQueued(file);
        },
        onCollected: (files) => this.rpc.onCollected(files),
        onFileFinished: async (filepath) => {
          this.options.onFileFinished?.(filepath);
          await this.reportCoverage(filepath);
        },
      });
      if (method === "run") await startTests(context.files, runner);
      else await collectTests(context.files, runner);
    } finally {
      this.running = false;
      this.respond({ __vitest_worker_response__: true, type: "testfileFinished" });
    }
  }

  /**
   * 一个文件跑完，将这段时间内增长的计数交给宿主，经 vitest 原生的
   * `onAfterSuiteRun`：宿主侧的 coverage provider 收到的形状与标准 worker 一致，
   * reporter / 阈值均无需重做。
   *
   * 挂在 `onFileFinished` 而不是整个 run 结束：中途失败时，前面文件的覆盖率仍然保留。
   */
  private async reportCoverage(filepath: string): Promise<void> {
    if (!this.startContext?.context.config.coverage?.enabled) return;
    const store = (globalThis as Record<string, unknown>)[CUJ_COVERAGE_KEY];
    const coverage = takeCoverageDelta(store as Record<string, never> | undefined, this.coverageMaps);
    if (!Object.keys(coverage).length) return;
    await this.rpc.onAfterSuiteRun({
      coverage,
      testFiles: [filepath],
      environment: this.startContext.context.environment.name,
      projectName: this.projectName,
    });
  }

  private createState(
    context: Extract<WorkerRequest, { type: "run" }>["context"],
  ): WorkerGlobalState {
    const start = this.startContext as Extract<WorkerRequest, { type: "start" }>;
    const config = start.context.config;
    return {
      ctx: {
        pool: start.context.pool,
        projectName: context.providedContext?.["__vitest_project_name"] ?? "",
        config,
        environment: start.context.environment,
        rpc: this.rpc,
        metaEnv: {},
        files: context.files,
        providedContext: context.providedContext,
        invalidates: context.invalidates,
        workerId: context.workerId,
        concurrencyId: context.workerId,
      },
      config,
      rpc: this.rpc,
      metaEnv: {},
      // 引擎没有 jsdom / happy-dom，环境就是引擎自身那套全局。
      environment: { name: context.environment.name, options: null } as never,
      // 不引入 `vite/module-runner`：它在求值期就需要 TextDecoder，引擎没有。将 shim 放同模块
      // 也无法解决（import 永远先于模块体执行）。本运行时的 importFile 从包内注册表取模块，
      // 本来就不经过 module runner。
      evaluatedModules: undefined,
      resolvingModules: new Set<string>(),
      moduleExecutionInfo: new Map<string, unknown>(),
      durations: { environment: 0, prepare: 0, fetch: 0 },
      providedContext: context.providedContext,
      onCancel: (listener: (reason: CancelReason) => unknown) => {
        this.cancelListeners.add(listener);
        return () => this.cancelListeners.delete(listener);
      },
      onCleanup: (listener: () => unknown) => {
        this.cleanupListeners.add(listener);
      },
      onFilterStackTrace: (stack: string) => stack,
    } as unknown as WorkerGlobalState;
  }

  /** 将内部错误上报给宿主，避免引擎内静默失败。 */
  reportError(message: string): void {
    void this.rpc.onUnhandledError(serializeError(new Error(message)), "godot-worker");
  }
}
