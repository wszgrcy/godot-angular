import { describe, expect, it } from "vitest";
import {
  installGodotPolyfills,
  resumeFrameCallbacks,
  runFrameCallbacks,
  stopFrameCallbacks,
} from "../index";

/**
 * GodotJS 的裸 V8 没有 requestAnimationFrame，而 Angular 的 zoneless 调度器
 * 会使用 rAF 与 setTimeout 赛跑。此处验证 rAF 确实由帧驱动，而不是空转。
 */
describe("requestAnimationFrame polyfill", () => {
  it("装上后可用，且重复安装幂等", () => {
    installGodotPolyfills();
    installGodotPolyfills();
    expect(typeof globalThis.requestAnimationFrame).toBe("function");
    expect(typeof globalThis.cancelAnimationFrame).toBe("function");
  });

  it("回调只在 runFrameCallbacks 时触发，不在微任务里自己跑", async () => {
    installGodotPolyfills();
    let ran = false;
    globalThis.requestAnimationFrame(() => (ran = true));
    await Promise.resolve();
    expect(ran).toBe(false);
    runFrameCallbacks(16);
    expect(ran).toBe(true);
  });

  it("回调参数与 performance.now() 同源（不是帧间隔，也不是另一套时钟）", () => {
    installGodotPolyfills();
    const before = performance.now();
    const seen: number[] = [];
    globalThis.requestAnimationFrame((t) => seen.push(t));
    runFrameCallbacks(16);
    expect(seen.length).toBe(1);
    // 两个判据：量级一致、时间不倒退（时间戳必须是真实时钟，不能是从 0 累加的 delta）。
    expect(seen[0]).toBeGreaterThanOrEqual(before);
    expect(seen[0]).toBeLessThanOrEqual(performance.now() + 1);
  });

  it("performance.now() 不可信时退回 delta 累加，不把 NaN 送进回调", () => {
    installGodotPolyfills();
    const real = globalThis.performance;
    (globalThis as { performance: unknown }).performance = { now: () => Number.NaN };
    try {
      const seen: number[] = [];
      globalThis.requestAnimationFrame((t) => seen.push(t));
      runFrameCallbacks(16);
      globalThis.requestAnimationFrame((t) => seen.push(t));
      runFrameCallbacks(16);
      expect(seen.every((t) => Number.isFinite(t))).toBe(true);
      expect(seen[1]).toBeGreaterThan(seen[0]);
    } finally {
      (globalThis as { performance: unknown }).performance = real;
    }
  });

  it("cancelAnimationFrame 取消未触发的回调", () => {
    installGodotPolyfills();
    let ran = false;
    const id = globalThis.requestAnimationFrame(() => (ran = true));
    globalThis.cancelAnimationFrame(id);
    runFrameCallbacks(16);
    expect(ran).toBe(false);
  });

  it("回调里再注册 rAF 留到下一帧（否则同帧无限循环）", () => {
    installGodotPolyfills();
    const order: string[] = [];
    globalThis.requestAnimationFrame(() => {
      order.push("first");
      globalThis.requestAnimationFrame(() => order.push("second"));
    });
    runFrameCallbacks(16);
    expect(order).toEqual(["first"]);
    runFrameCallbacks(16);
    expect(order).toEqual(["first", "second"]);
  });

  it("单个回调抛错不带走整帧", () => {
    installGodotPolyfills();
    let secondRan = false;
    const spy = console.error;
    console.error = () => {};
    globalThis.requestAnimationFrame(() => {
      throw new Error("boom");
    });
    globalThis.requestAnimationFrame(() => (secondRan = true));
    runFrameCallbacks(16);
    console.error = spy;
    expect(secondRan).toBe(true);
  });

  it("stopFrameCallbacks 后不放帧也丢队列，resume 后恢复工作", () => {
    installGodotPolyfills();
    resumeFrameCallbacks();
    let stopped = false;
    globalThis.requestAnimationFrame(() => (stopped = true));
    stopFrameCallbacks();
    runFrameCallbacks(16);
    expect(stopped).toBe(false);

    // 停帧期间注册直接被拒（返回 -1），不会积累到下一个应用头上集体复活
    let stale = false;
    expect(globalThis.requestAnimationFrame(() => (stale = true))).toBe(-1);
    resumeFrameCallbacks();
    runFrameCallbacks(16);
    expect(stale).toBe(false);

    // 重新启动帧驱动后队列正常放行
    let fresh = false;
    globalThis.requestAnimationFrame(() => (fresh = true));
    runFrameCallbacks(16);
    expect(fresh).toBe(true);
  });
});
