import type { PoolTask, PoolWorker, WorkerRequest } from "vitest/node";
import type { GodotVitestSession } from "./session.js";

type EventCallback = (argument: unknown) => void;

/**
 * 引擎内那个常驻 vitest worker 的 PoolWorker 代理。
 *
 * vitest 只要求“worker 是一个能 send/on 的双向通道”，不关心对端是子进程还是
 * 一个游戏引擎——此处就是把这条通道接到 WebSocket 上。
 */
export class GodotPoolWorker implements PoolWorker {
  readonly name = "godot";
  readonly reportMemory = false;

  private readonly listeners = new Map<string, Set<EventCallback>>();
  private readonly unsubscribe: () => void;
  private stopped = false;

  constructor(private readonly session: GodotVitestSession) {
    session.retain();
    this.unsubscribe = session.subscribe((message) => this.emit("message", message));
  }

  on(event: string, callback: EventCallback): void {
    let callbacks = this.listeners.get(event);
    if (!callbacks) {
      callbacks = new Set();
      this.listeners.set(event, callbacks);
    }
    callbacks.add(callback);
  }

  off(event: string, callback: EventCallback): void {
    this.listeners.get(event)?.delete(callback);
  }

  deserialize(data: unknown): unknown {
    return data;
  }

  async start(): Promise<void> {
    await this.session.start();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe();
    await this.session.release();
  }

  /** 引擎是常驻运行环境，切换文件无需重建，复用可省掉每次重开引擎的几秒。 */
  canReuse(_task: PoolTask): boolean {
    return true;
  }

  send(message: WorkerRequest): void {
    // `start` 的对端没有真实 worker 进程可以回 `started`，此处就地补一个，
    // 否则 vitest 一直等不到 worker 启动完成。
    if (message.type === "start") {
      this.emit("message", { __vitest_worker_response__: true, type: "started" });
    }
    // `stop` 同理就地合成：引擎侧的 teardown 语义就是“连接断开”，等待它回 `stopped`
    // 只会每次多等一个 teardownTimeout。转发照旧发送，但不将其作为屏障。
    if (message.type === "stop") {
      this.emit("message", { __vitest_worker_response__: true, type: "stopped" });
    }
    void this.forwardWhenReady(message);
  }

  private async forwardWhenReady(message: WorkerRequest): Promise<void> {
    try {
      await this.session.start();
      await this.session.waitForWorker();
      this.session.send(message);
    } catch (error) {
      // 即使连接不上也要给 vitest 一个收尾响应，否则整个 run 挂在 pending 上。
      this.emit("message", {
        __vitest_worker_response__: true,
        type: message.type === "stop" ? "stopped" : "testfileFinished",
        error,
      });
    }
  }

  private emit(event: string, argument: unknown): void {
    this.listeners.get(event)?.forEach((callback) => callback(argument));
  }
}
