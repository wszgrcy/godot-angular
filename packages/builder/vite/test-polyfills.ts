import { TextDecoder as Utf8TextDecoder } from "@nberlette/utf8/decoder";
import { TextEncoder as Utf8TextEncoder } from "@nberlette/utf8/encoder";
import { Event, EventTarget } from "event-target-shim";


class DOMExceptionShim extends Error {
  readonly code: number;
  constructor(message?: string, name = "Error") {
    super(message);
    this.name = name;
    this.code = 0;
  }
}

function installEngineTestPolyfills(): void {
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
      exit: () => { },
      on: () => { },
      off: () => { },
      emit: () => { },
      stdout: { isTTY: false, write: () => true },
      stderr: { isTTY: false, write: () => true },
    };
  }

  // B. vitest 依赖的标准 API
  // DOMException 需先装：abort() / timeout() 会构造它。
  if (typeof g["DOMException"] !== "function") g["DOMException"] = DOMExceptionShim;

  // 已有原生实现时让位：这份代码在宿主侧（Node）也会被 import，把原生实现覆盖为
  // 近似实现是纯粹的能力退化。
  if (typeof g["TextEncoder"] !== "function") g["TextEncoder"] = Utf8TextEncoder;
  if (typeof g["TextDecoder"] !== "function") g["TextDecoder"] = Utf8TextDecoder;

  // vitest 的模块预加载失败路径构造 `new Event(...)`，abort 事件的派发同样要它。
  // Angular 本身不需要它们，所以只有测试这一侧装。
  if (typeof g["Event"] !== "function") g["Event"] = Event;
  if (typeof g["EventTarget"] !== "function") g["EventTarget"] = EventTarget;
}

// 有意的模块副作用：补丁必须在任何读取这些全局的代码之前安装完成。
installEngineTestPolyfills();
