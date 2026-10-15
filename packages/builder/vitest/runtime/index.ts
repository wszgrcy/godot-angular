export const CUJ_VITEST_PROTOCOL_VERSION = 1;


import { parse as flatParse, stringify as flatStringify } from "flatted";
/**
 * 测试运行时的帧泵。应用构建里这一泵在库内（`core/bootstrap.ts` 的 `GodotAngularApp.tick`，
 * 由 Godot 脚本的 `_process(delta)` 每帧调），引擎测试没有那个 `_process`，帧由 vitest
 * 自己驱动，所以在这里泵同一个句柄。两边读的都是补丁装的 `globalThis.__CUJ_FRAME__`。
 */
function pumpFrameClock(deltaMs: number): void {
  const clock = (globalThis as unknown as { __CUJ_FRAME__?: { run(delta: number): void } })
    .__CUJ_FRAME__;
  if (!clock) {
    throw new Error("[godot-angular] 帧钟未安装：补丁模块未先于测试运行时求值");
  }
  clock.run(deltaMs);
}
// builder 消费库只能经过发布出去的公开 API（库的二级入口之间靠包名互引），
// 看上去像“自己 import 自己”，但那是 ng-packagr 重写依赖的唯一入口。
import { pumpEngineFrames, setEngineSceneRoot } from "godot-angular/testing";
import { forwardConsole } from "./console-forward";
import { createTestModuleRegistry, type TestModuleMap } from "./registry";
import { reviveContext } from "./regexp-codec";
import { connectChannel, type EngineChannel } from "./transport";
import { GodotWorker } from "./worker";

export type { TestModuleMap } from "./registry";
export { createGodotVitestScene, type GodotVitestSceneDeps } from "./scene";

export interface GodotVitestOptions {
  /**
   * spec 模块表：key 是构建期给出的相对路径，value 是 `() => import(...)`。
   * 必须是懒函数——vitest 依赖 importFile 的求值时机来收集，提前求值则收集不到。
   */
  modules: TestModuleMap;
  port: number;
  host?: string;
  /** 场景根节点，spec 创建的 Control 需要挂在它下面才能获得真实布局尺寸 */
  sceneRoot?: unknown;
  /** 宿主静默多久后引擎自行退出（毫秒）。用于防止宿主异常退出时引擎永久常驻。 */
  idleTimeoutMs?: number;
  log?(...args: unknown[]): void;
}

export interface GodotVitestSession {
  /** 每帧调用：poll 通道 + 派发待处理消息 */
  tick(): void;
  readonly finished: boolean;
  readonly exitCode: number;
}

/**
 * 在 GodotJS 中启动一个 vitest worker，宿主侧对应 `godotEngineTest()` 插件。
 * 使用自定义 pool 而不是 browser provider：browser 模式需要页面从 dev server 拉取 ES 模块，
 * 引擎不执行远程模块，spec 只能事先编入包内。
 */
export function startupGodotVitest(options: GodotVitestOptions): GodotVitestSession {
  if (options.sceneRoot) setEngineSceneRoot(options.sceneRoot as never);

  const log = options.log ?? ((...a: unknown[]) => console.log("[EVITEST]", ...a));
  const registry = createTestModuleRegistry(options.modules);

  let finished = false;
  let exitCode = 1;
  let helloSent = false;
  let stopSeen = false;
  let lastActivity = Date.now();

  const send = (payload: unknown): void => {
    channel.send(payload);
  };
  const sendFrame = (payload: unknown): void => {
    channel.send({ kind: "worker-message", frame: flatStringify(payload) });
  };

  const worker = new GodotWorker({
    sendFrame,
    registry,
    onFileFinished: (filepath) => {
      lastActivity = Date.now();
      log(`测试文件执行完成：${filepath}`);
    },
  });

  const channel: EngineChannel = connectChannel(options.port, {
    host: options.host,
    onMessage: (msg) => {
      lastActivity = Date.now();
      if (!msg || typeof msg !== "object") return;
      if ((msg as { kind?: string }).kind !== "worker-message") return;
      let frame: unknown;
      try {
        frame = reviveContext(flatParse((msg as { frame: string }).frame));
      } catch {
        return;
      }
      if (worker.feedRpc(frame)) return;
      const request = frame as { type?: string };
      void worker.handle(frame as never)
        .catch((err: unknown) => {
          const message = String((err as Error)?.stack ?? err);
          log(`worker 处理失败：${message.slice(0, 400)}`);
          worker.reportError(message.slice(0, 400));
        })
        .then(() => {
          // vitest 跑完会下发 stop。引擎必须自行收尾：不主动退出时，宿主
          // pool 会一直等待 worker 响应，最后靠超时收场。
          if (request?.type === "stop") stopSeen = true;
        });
    },
  });

  // 引擎内的 console（包含 Angular ErrorHandler）转发给宿主。缺少它时，
  // “测试全绿但中间一行 warn 已经指出真正问题”完全无法察觉。
  forwardConsole((payload) => channel.send(payload));

  return {
    tick() {
      // 先执行帧等待者：spec 中 `await awaitFrames(n)` 依赖它跨到下一帧，
      // 容器布局只有真实帧才会重算，用 CD tick 顶替会静默拿到旧布局。
      pumpEngineFrames();
      // 再泵 rAF 队列：zoneless 排 CD 是 setTimeout(0) 与 rAF 赛跑，rAF 这一侧不响应
      // 就会表现为“慢一帧”而不是“不刷”，测试容易侥幸通过。帧泵由运行时统一驱动。
      pumpFrameClock(16);
      channel.poll();
      if (finished) return;
      if (!helloSent && channel.connected) {
        helloSent = true;
        send({
          kind: "hello",
          protocol: CUJ_VITEST_PROTOCOL_VERSION,
          engine: "godotjs",
        });
        send({ kind: "worker-ready" });
        log(`已连接宿主 ws://127.0.0.1:${options.port}`);
      }
      if (channel.closed) {
        finished = true;
        exitCode = 0;
        return;
      }
      if (stopSeen) {
        // 响应已在 handle 内同步发出，此处多 poll 几帧将其推上线路。
        for (let i = 0; i < 3; i++) channel.poll();
        log("收到宿主 stop 指令，引擎退出");
        finished = true;
        exitCode = 0;
        return;
      }
      // 宿主异常退出但未正常关闭 socket 时，引擎不能永久常驻。
      const idle = options.idleTimeoutMs ?? 10_000;
      if (helloSent && Date.now() - lastActivity > idle) {
        log(`宿主在 ${idle}ms 内未下发指令，引擎主动退出`);
        finished = true;
        exitCode = 1;
      }
    },
    get finished() {
      return finished;
    },
    get exitCode() {
      return exitCode;
    },
  };
}

export { createTestModuleRegistry } from "./registry";
export { GodotWorker } from "./worker";
export { GodotTestRunner } from "./runner";
