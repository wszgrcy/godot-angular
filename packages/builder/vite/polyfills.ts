import "abortcontroller-polyfill/dist/abortcontroller-polyfill-only.js";

import './atob-shim'
import { URL as WhatWGURL, URLSearchParams as WhatWGURLSearchParams } from "whatwg-url-minimum";



type RafCallback = (time: number) => void;


const CUJ_FRAME_KEY = "__CUJ_FRAME__";

const rafCallbacks = new Map<number, RafCallback>();
let rafSeq = 1;
/** 上一帧传给回调的时间戳，仅在时钟不可靠时作为累加基准。 */
let lastFrameTime = 0;
let pumpStopped = false;

/**
 * 帧时间戳，与 `performance.now()` 使用同一个时钟。这里故意传递绝对时间戳而不是帧间隔：
 * `rAF(t => t - last)` 传入 delta 会算出接近 0 的值（动画冻结），`performance.now()` 那种则算出
 * 天文数字。需要帧间隔时请自行记录上一帧，或使用 `_process(delta)` 中的 delta。
 */
function frameTimestamp(deltaMs: number): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  const now = typeof perf?.now === "function" ? perf.now() : Number.NaN;
  if (Number.isFinite(now)) return now;
  // 时钟不可靠（若日后 GodotJS 提供的原生 performance 异常）：退回“上一帧 + delta”，
  // delta 也不可靠时保持原地不动。总之不允许 NaN 进入回调。
  const step = Number.isFinite(deltaMs) ? Math.max(deltaMs, 0) : 0;
  return Number.isFinite(lastFrameTime) ? lastFrameTime + step : 0;
}

/**
 * 由 Godot 的 `_process` 每帧调用一次，驱动 rAF 队列。
 * 时间戳在队列为空时也需要推进，因此该调用位于提前返回之前。
 */
function runFrameCallbacks(deltaMs: number): void {
  if (pumpStopped) return;
  lastFrameTime = frameTimestamp(deltaMs);
  if (rafCallbacks.size === 0) return;
  // 快照：回调内再注册的 rAF 应留到下一帧执行，避免同帧无限循环
  const pending = Array.from(rafCallbacks.entries());
  rafCallbacks.clear();
  for (const [, cb] of pending) {
    try {
      cb(lastFrameTime);
    } catch (err) {
      // 单个回调失败不应影响整帧
      console.error("[godot-angular] requestAnimationFrame 回调抛出异常", err);
    }
  }
}

/**
 * 停止帧驱动：应用 destroy 之后 rAF 不再放行，队列直接丢弃。
 *
 * 不停帧的后果是“销毁前注册的回调在销毁后一帧重新执行”，回调里访问已销毁的 signal /
 * 已移除的节点，报错位置与真实原因相距甚远。
 */
function stopFrameCallbacks(): void {
  pumpStopped = true;
  rafCallbacks.clear();
}

/** 重新启动帧驱动：bootstrap 新应用时调用（引擎测试会反复创建 / 销毁应用，不能一停就无法恢复）。 */
function resumeFrameCallbacks(): void {
  pumpStopped = false;
}

/** Angular 的 zoneless 调度器会赛跑式地使 rAF / setTimeout，这里提供真实的帧驱动 */
function requestAnimationFrameShim(cb: RafCallback): number {
  // 停帧后直接拒收（返回 -1，与 opentui 的 canRender 不通过时 return -1 同一语义）：
  // 仅阻止放行而不阻止注册，这些回调会在下一次 resume
  // （例如下一个应用启动）时集体重新执行。
  if (pumpStopped) return -1;
  const id = rafSeq++;
  rafCallbacks.set(id, cb);
  return id;
}

function cancelAnimationFrameShim(id: number): void {
  rafCallbacks.delete(id);
}

/**
 * document 占位对象。存在的理由：`getDocument()`（样式宿主 `DomSharedStylesHost` 走它）
 * 拿不到 document 就直接抛 NG0210，bootstrap 当场失败。
 *
 * 内容一概不填，空对象是有意为之：伪造得越接近真实，越容易使“绕过 Renderer2 直接访问
 * DOM”的代码看起来可运行、实际静默无效。`document.documentElement` 为 undefined 也使
 * Angular 的 `areAnimationSupported` 恒为假，动画路径整体失效而不是部分生效。
 *
 * 这里不用 DOM 的 `Document` 类型：构建器的编译范围不含 DOM lib，而本模块只需要
 * “有个对象占住 globalThis.document”这一件事。
 */
type DocumentStub = Record<string, unknown>;

const documentStub: DocumentStub = {};

let installed = false;

/**
 * 补丁要写入的那几个全局成员。不直接沿用 globalThis 上的声明：DOM lib 里的 Performance 是
 * 完整接口，而 GodotJS 里这个位置本来什么都没有，补丁给的是“够 Angular 探测”的最小实现，
 * 因此按补丁自己的形状声明。
 */
interface PatchedGlobals {
  queueMicrotask?: (cb: () => void) => void;
  requestAnimationFrame?: (cb: RafCallback) => number;
  cancelAnimationFrame?: (id: number) => void;
  performance?: {
    now(): number;
    timeOrigin: number;
    mark(): void;
    measure(): void;
    clearMarks(): void;
    clearMeasures(): void;
  };
  document?: DocumentStub;
  URL?: unknown;
  URLSearchParams?: unknown;
}


function installGodotPolyfills(): void {
  if (installed) return;
  installed = true;
  const g = globalThis as unknown as PatchedGlobals;

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
      mark() { },
      measure() { },
      clearMarks() { },
      clearMeasures() { },
    };
  }

  if (g.document === undefined) g.document = documentStub;
  if (typeof (g as any).URL !== "function") {
    (g as any).URL = WhatWGURL;
    (g as any).URLSearchParams = WhatWGURLSearchParams;
  }


  // 帧钟句柄：主入口的 tick() 依赖它泵送队列。使用 defineProperty 设为只读，
  // 避免后续误赋值将整个帧驱动替换掉（那种缺陷只表现为“界面不刷新”）。
  Object.defineProperty(g, CUJ_FRAME_KEY, {
    value: Object.freeze({
      run: runFrameCallbacks,
      stop: stopFrameCallbacks,
      resume: resumeFrameCallbacks,
    }),
    writable: false,
    configurable: false,
    enumerable: false,
  });
}

// 唯一安装点。
installGodotPolyfills();
