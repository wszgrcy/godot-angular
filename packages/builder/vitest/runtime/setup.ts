import "abortcontroller-polyfill/dist/abortcontroller-polyfill-only.js";
import { TextDecoder as Utf8TextDecoder } from "@nberlette/utf8/decoder";
import { TextEncoder as Utf8TextEncoder } from "@nberlette/utf8/encoder";
import { Event, EventTarget } from "event-target-shim";

/**
 * 最小 `DOMException` 实现。
 *
 * polyfill 的 `abort()` 与 `AbortSignal.timeout()` 内部均需要 `new DOMException(...)`。
 * 引擎中不存在该构造器时，`timeout()` 会在定时器里抛 ReferenceError，并且**信号永不 abort**
 * （30ms 后 aborted 仍为 false）——静默失效比显式报错更难定位。
 */
class DOMExceptionShim extends Error {
  readonly code: number;
  constructor(message?: string, name = "Error") {
    super(message);
    this.name = name;
    this.code = 0;
  }
}

function installEngineTestShims(): void {
  const g = globalThis as unknown as Record<string, any>;

  // A. Node 运行时的最小模拟
  if (typeof g["global"] === "undefined") g["global"] = g;

  if (typeof g["process"] === "undefined") {
    g["process"] = {
      env: {},
      argv: [],
      platform: "linux",
      version: "v20.0.0",
      pid: 1,
      nextTick: (fn: () => void) => setTimeout(fn, 0),
      cwd: () => "/",
      exit: () => {},
      on: () => {},
      off: () => {},
      emit: () => {},
      stdout: { isTTY: false, write: () => true },
      stderr: { isTTY: false, write: () => true },
    };
  }

  // B. vitest 依赖的标准 API
  // DOMException 需先装：polyfill 的 abort() / timeout() 会构造它。
  if (typeof g["DOMException"] !== "function") g["DOMException"] = DOMExceptionShim;

  // AbortController / AbortSignal 已由文件头部的副作用 import 挂载，此处不重复处理。

  // 已有原生实现时让位：这份代码在宿主侧（Node）也会被 import，把原生实现覆盖为
  // 近似实现是纯粹的能力退化。
  if (typeof g["TextEncoder"] !== "function") g["TextEncoder"] = Utf8TextEncoder;
  if (typeof g["TextDecoder"] !== "function") g["TextDecoder"] = Utf8TextDecoder;

  // abortcontroller-polyfill 的 `createAbortEvent()` 会 `new Event("abort")`，vitest 的模块
  // 预加载失败路径同样构造 Event。Angular 本身不需要它们，所以补丁入口不装、这里装。
  if (typeof g["Event"] !== "function") g["Event"] = Event;
  if (typeof g["EventTarget"] !== "function") g["EventTarget"] = EventTarget;
}

// 有意的模块副作用：补丁必须在任何读取这些全局的代码之前安装完成。
installEngineTestShims();
