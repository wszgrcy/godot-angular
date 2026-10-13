import { parse as flatParse, stringify as flatStringify } from "flatted";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { PORT_RETRIES, startPort } from "../../shared/engine-port.js";
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

  private boundPort: number | undefined;

  constructor(
    private readonly options: {
      /** 起始端口，被占用则 +1 继续试 */
      port?: number;
      host?: string;
      connectTimeout?: number;
      /** 占用时最多再试几个；noLaunch（引擎自己读产物里的端口）下传 0，换了端口引擎就连不上 */
      portTries?: number;
    },
  ) {}

  /**
   * 实际监听的端口。端口会因“起始值被占”而自增，所以启动引擎、写进产物的缺省端口
   * 都必须读这里，不能读配置里那个起始值。
   */
  get port(): number {
    return this.boundPort ?? startPort(this.options.port);
  }

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
    const host = this.options.host ?? "127.0.0.1";
    // 重听沿用首次绑定到的端口：换了端口，引擎那边已经拿到的 CUJ_WS_PORT 就作废了
    const start = this.boundPort ?? startPort(this.options.port);
    const tries = this.options.portTries ?? PORT_RETRIES;

    const attempt = (port: number, left: number): Promise<void> =>
      new Promise((resolve, reject) => {
        const server = new WebSocketServer({ port, host });
        this.server = server;
        // 只有“开不起来”属于 start() 的失败；开始监听之后的错误不能反过来拆掉正在用的服务
        let listening = false;
        server.once("listening", () => {
          listening = true;
          this.boundPort = port;
          process.stdout.write(`[cuj-vitest] 已监听 ws://${host}:${String(port)}，等待引擎连接\n`);
          resolve();
        });
        server.once("error", (err: Error) => {
          if (listening) return;
          server.close();
          // 起始端口被占就 +1 再试：这个监听先于构建开起来，自增后的端口才是写进产物那个
          if (left > 0 && (err as NodeJS.ErrnoException).code === "EADDRINUSE") {
            attempt(port + 1, left - 1).then(resolve, reject);
            return;
          }
          // 失败的这次监听不能留下：否则 start() 永远返回同一个 rejection，重试无门
          this.startPromise = undefined;
          reject(
            new Error(
              `监听 ${host}:${String(port)} 失败：${err.message}。` +
                (left > 0
                  ? "已自增重试仍未拿到可用端口，请确认没有未退出的测试进程。"
                  : "引擎自行启动时端口不能换（它只读产物里写死的值），请释放该端口或改 engine.port。"),
            ),
          );
        });
        server.on("connection", (socket) => this.onConnection(socket));
      });

    return attempt(start, tries);
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
            `引擎在 ${timeout}ms 内未连接（本端 ws://${this.options.host ?? "127.0.0.1"}:${String(this.port)}）。`
              + `请确认引擎已以 --headless 启动测试场景，且 startupGodotVitest 的 port 与此处一致。`,
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
