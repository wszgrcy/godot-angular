/**
 * GodotJS V8 裸环境 polyfill。
 *
 * 实测（Godot 4.6.1 + GodotJS v8，无头）全局只有：
 *   setTimeout / setInterval / clearTimeout / clearInterval / console
 *   Promise / Proxy / Reflect / Map / Set / WeakMap / Symbol
 * 缺：document window navigator location requestAnimationFrame queueMicrotask
 *     performance PerformanceObserver MutationObserver Event EventTarget CustomEvent
 *     fetch TextEncoder structuredClone Intl localStorage XMLHttpRequest
 *
 * 本文件只做"让 Angular 不炸"的最小补齐，不伪造 DOM 语义。
 *
 * 安装点只有一个：本模块被 import 时就装（文件末尾）。core 的 provider 常量数组在
 * 模块求值阶段就会调 provideZonelessChangeDetection()，而它要 performance.mark；
 * Angular 自己也在模块求值阶段就要 performance / rAF。所以“装 polyfill”必须
 * 在它们之前，只能绑在 import 上，不能放到 bootstrapGodotApp 这种运行期入口里。
 */

type RafCallback = (time: number) => void;

const rafCallbacks = new Map<number, RafCallback>();
let rafSeq = 1;
let frameTime = 0;

/** 由 Godot 的 _process 每帧调用一次，驱动 rAF 队列 */
export function runFrameCallbacks(deltaMs: number): void {
  frameTime += deltaMs;
  if (rafCallbacks.size === 0) return;
  // 快照：回调里再注册 rAF 应留到下一帧，避免同帧无限循环
  const pending = Array.from(rafCallbacks.entries());
  rafCallbacks.clear();
  for (const [, cb] of pending) {
    try {
      cb(frameTime);
    } catch (err) {
      // 单个回调失败不应带走整帧
      console.error("[control-ui-js] requestAnimationFrame 回调抛错", err);
    }
  }
}

/** Angular 的 zoneless 调度器会 rAF/setTimeout 赛跑，这里给出真实帧驱动 */
function requestAnimationFrameShim(cb: RafCallback): number {
  const id = rafSeq++;
  rafCallbacks.set(id, cb);
  return id;
}

function cancelAnimationFrameShim(id: number): void {
  rafCallbacks.delete(id);
}

/** 探测型 API 一律"空手而归"，而不是抛错 —— 参考 nativescript 的 NO_DOM_QUERIES 思路 */
const NO_DOM_QUERIES = {
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  getElementsByTagName: () => [],
  getElementsByClassName: () => [],
  getElementsByName: () => [],
  createTextNode: (v: unknown) => ({ nodeValue: String(v ?? "") }),
  createEvent: () => undefined,
};

function makeDocumentStub(): any {
  const doc: any = {
    documentElement: { clientWidth: 0, clientHeight: 0, style: {}, getAttribute: () => null },
    head: { ...NO_DOM_QUERIES, appendChild: () => {}, removeChild: () => {} },
    body: {
      ...NO_DOM_QUERIES,
      style: {},
      classList: { add() {}, remove() {}, contains: () => false },
      appendChild: () => {},
      removeChild: () => {},
    },
    defaultView: undefined,
    ...NO_DOM_QUERIES,
    addEventListener: () => {},
    removeEventListener: () => {},
    createElement: (tag: string) => {
      throw new Error(
        `[control-ui-js] 不该在这里 createElement("${tag}")：Godot 宿主没有 DOM，` +
          `请检查是否有代码绕过了 Renderer2`,
      );
    },
  };
  return doc;
}

class EventShim {
  type: string;
  defaultPrevented = false;
  bubbles: boolean;
  cancelable: boolean;
  target: any = null;
  currentTarget: any = null;
  constructor(type: string, init?: any) {
    this.type = String(type);
    this.bubbles = !!init?.bubbles;
    this.cancelable = !!init?.cancelable;
  }
  preventDefault(): void {
    this.defaultPrevented = true;
  }
  stopPropagation(): void {}
  stopImmediatePropagation(): void {}
  composedPath(): any[] {
    return [];
  }
}

class CustomEventShim extends EventShim {
  detail: any;
  constructor(type: string, init?: any) {
    super(type, init);
    this.detail = init?.detail;
  }
}

class EventTargetShim {
  private readonly _listeners = new Map<string, Set<any>>();
  addEventListener(type: string, listener: any): void {
    if (!listener) return;
    let set = this._listeners.get(type);
    if (!set) {
      set = new Set();
      this._listeners.set(type, set);
    }
    set.add(listener);
  }
  removeEventListener(type: string, listener: any): void {
    this._listeners.get(type)?.delete(listener);
  }
  dispatchEvent(event: any): boolean {
    const set = this._listeners.get(event?.type);
    if (!set) return true;
    for (const listener of Array.from(set)) {
      try {
        typeof listener === "function" ? listener(event) : listener.handleEvent?.(event);
      } catch (err) {
        console.error("[control-ui-js] 事件监听器抛错", err);
      }
    }
    return !event?.defaultPrevented;
  }
}

let installed = false;

/** 幂等：重复调用只装一次 */
export function installGodotPolyfills(): void {
  if (installed) return;
  installed = true;
  const g = globalThis as any;

  if (typeof g.queueMicrotask !== "function") {
    g.queueMicrotask = (cb: () => void) => {
      Promise.resolve().then(cb);
    };
  }

  if (typeof g.requestAnimationFrame !== "function") {
    g.requestAnimationFrame = requestAnimationFrameShim;
    g.cancelAnimationFrame = cancelAnimationFrameShim;
  }

  if (typeof g.performance !== "object" || g.performance === null) {
    g.performance = {
      now: () => Date.now(),
      timeOrigin: Date.now(),
      mark() {},
      measure() {},
      clearMarks() {},
      clearMeasures() {},
    };
  }

  // Angular dev mode 会探测 PerformanceObserver 决定是否走 tracing 分支
  if (typeof g.PerformanceObserver !== "function") {
    class PerformanceObserverShim {
      constructor(_cb?: unknown) {}
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
      takeRecords(): any[] {
        return [];
      }
    }
    g.PerformanceObserver = PerformanceObserverShim;
  }

  if (typeof g.Event !== "function") g.Event = EventShim;
  if (typeof g.CustomEvent !== "function") g.CustomEvent = CustomEventShim;
  if (typeof g.EventTarget !== "function") g.EventTarget = EventTargetShim;

  if (typeof g.MutationObserver !== "function") {
    class MutationObserverShim {
      constructor(_cb?: unknown) {}
      observe(): void {}
      disconnect(): void {}
      takeRecords(): any[] {
        return [];
      }
    }
    g.MutationObserver = MutationObserverShim;
  }

  if (g.document === undefined) g.document = makeDocumentStub();

  if (g.navigator === undefined) {
    g.navigator = { userAgent: "godotjs", language: "en", platform: "godot" };
  }

  if (g.location === undefined) {
    g.location = {
      href: "godot://local/",
      protocol: "godot:",
      host: "",
      hostname: "",
      port: "",
      pathname: "/",
      search: "",
      hash: "",
      origin: "godot://local",
    };
  }

  if (typeof g.structuredClone !== "function") {
    g.structuredClone = (value: any) => JSON.parse(JSON.stringify(value));
  }
}

/** 供平台层注入的 DOCUMENT 值（本模块求值完 polyfill 已装，拿到的就是 globalThis.document） */
export function getDocumentStub(): any {
  return (globalThis as any).document ?? makeDocumentStub();
}

// 唯一安装点。core 内部所有模块都依赖本文件，且排在 @angular/core 之前被求值，
// 于是“polyfill 先于 Angular”这条约定不需要任何调用方配合就成立。
installGodotPolyfills();
