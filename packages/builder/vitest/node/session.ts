import { parse as flatParse, stringify as flatStringify } from "flatted";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { packContext } from "./regexp-codec.js";

/** 修改协议时需同步修改 `vitest/runtime/index.ts` 中的同名常量。 */
export const CUJ_VITEST_PROTOCOL_VERSION = 1;

export type VitestWireMessage =
  | { kind: "hello"; protocol: number; engine?: string }
  | { kind: "worker-ready" }
  | { kind: "worker-message"; frame: string }
  | { kind: "error"; message: string };

type MessageListener = (message: unknown) => void;

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function createDeferred(): Deferred {
  let resolveReady: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  return { promise, resolve: () => resolveReady?.() };
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

/**
 * 宿主侧的 WebSocket 会话：只有一个 worker、一条连接，新连接替换旧连接（重编译后新旧
 * 并存会串台）。引用计数归零才关闭服务，否则先结束的会掉断仍在运行的其他文件。
 */
export class GodotVitestSession {
  private server: WebSocketServer | undefined;
  private socket: WebSocket | undefined;
  private startPromise: Promise<void> | undefined;
  private references = 0;
  private workerReady = false;
  private ready: Deferred = createDeferred();
  private readonly listeners = new Set<MessageListener>();

  constructor(
    private readonly options: { port: number; host?: string; connectTimeout?: number },
  ) {}

  retain(): void {
    this.references += 1;
  }

  async release(): Promise<void> {
    this.references = Math.max(0, this.references - 1);
    if (this.references === 0) await this.close();
  }

  start(): Promise<void> {
    this.startPromise ??= this.listen();
    return this.startPromise;
  }

  private listen(): Promise<void> {
    const { port, host = "127.0.0.1" } = this.options;
    return new Promise((resolve, reject) => {
      const server = new WebSocketServer({ port, host });
      this.server = server;
      server.once("listening", () => {
        process.stdout.write(`[cuj-vitest] 已监听 ws://${host}:${port}，等待引擎连接\n`);
        resolve();
      });
      server.once("error", (err: Error) => {
        reject(
          new Error(
            `监听 ${host}:${port} 失败：${err.message}。若端口被占用请更换 port，` +
              `并同步修改引擎侧 startupGodotVitest 的 port。`,
          ),
        );
      });
      server.on("connection", (socket) => this.onConnection(socket));
    });
  }

  private onConnection(socket: WebSocket): void {
    this.socket?.close();
    this.socket = socket;
    socket.on("message", (data) => this.onMessage(rawToString(data)));
    socket.once("close", () => {
      if (this.socket === socket) {
        this.socket = undefined;
        this.workerReady = false;
        // 重连后需要重新等待一次 worker-ready，旧的 deferred 已经 resolve。
        this.ready = createDeferred();
      }
    });
    socket.once("error", () => {
      // close 会随之到来，错误在 close 分支统一收敛
    });
  }

  private onMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const hello = parsed as { kind?: string; protocol?: unknown } | null;
    if (hello?.kind === "hello" && hello.protocol !== CUJ_VITEST_PROTOCOL_VERSION) {
      process.stderr.write(
        `[cuj-vitest] 协议版本不匹配：引擎端 ${String(hello.protocol)}，宿主 ${CUJ_VITEST_PROTOCOL_VERSION}。` +
          `请重新构建测试产物（ng run <app>:engine-test-build）。\n`,
      );
      return;
    }
    const msg = parsed as VitestWireMessage | null;
    if (!msg || typeof msg !== "object" || !("kind" in msg)) return;
    switch (msg.kind) {
      case "hello":
        process.stdout.write(`[cuj-vitest] 引擎已连接${msg.engine ? `（${msg.engine}）` : ""}\n`);
        break;
      case "worker-ready":
        this.workerReady = true;
        this.ready.resolve();
        break;
      case "worker-message": {
        let frame: unknown;
        try {
          // frame 是 flatted 字符串，外层再套一层 JSON，这样控制帧可以使用最朴素的
          // JSON.parse 分流。
          frame = flatParse(msg.frame);
        } catch {
          break;
        }
        this.listeners.forEach((cb) => cb(frame));
        break;
      }
      case "error":
        process.stderr.write(`[cuj-vitest] 引擎侧错误：${msg.message}\n`);
        break;
    }
  }

  /** 等待引擎侧 worker 上线。 */
  async waitForWorker(): Promise<void> {
    if (this.workerReady) return;
    await this.start();
    const deferred = this.ready;
    const timeout = this.options.connectTimeout ?? 30_000;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(
            `引擎在 ${timeout}ms 内未连接。请确认引擎已以 --headless 启动测试场景，` +
              `且 startupGodotVitest 的 port 与此处一致。`,
          ),
        );
      }, timeout);
      timer.unref?.();
      void deferred.promise.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  send(message: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("引擎端未连接，无法下发 vitest 指令");
    }
    this.socket.send(
      JSON.stringify({ kind: "worker-message", frame: flatStringify(packContext(message)) }),
    );
  }

  subscribe(listener: MessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async close(): Promise<void> {
    this.workerReady = false;
    this.ready = createDeferred();
    this.listeners.clear();
    this.socket?.close();
    this.socket = undefined;
    this.startPromise = undefined;
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      // server.close() 只停止接受新连接，已建立的连接需要自行掉断，否则回调
      // 永远不会到来，vitest 侧就是 "Timeout terminating godot worker"。
      for (const client of server.clients) client.terminate();
      server.close(() => resolve());
    });
  }
}
