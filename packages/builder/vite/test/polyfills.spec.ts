import { describe, expect, it } from "vitest";
// 只 import 副作用：补丁模块不导出任何东西，帧钟从全局句柄拿（与库主入口、引擎测试运行时
// 走同一条路）。这里如果改成 import 内部函数，测的就不是真实取用了。
import "../polyfills";

const CUJ_FRAME_KEY = "__CUJ_FRAME__";

interface FrameClock {
  run(deltaMs: number): void;
  stop(): void;
  resume(): void;
}

const clock = (): FrameClock =>
  (globalThis as unknown as Record<string, FrameClock>)[CUJ_FRAME_KEY];

/**
 * GodotJS 的裸 V8 没有 requestAnimationFrame，而 Angular 的 zoneless 调度器
 * 会使用 rAF 与 setTimeout 赛跑。此处验证 rAF 确实由帧驱动，而不是空转。
 */
describe("requestAnimationFrame polyfill", () => {
  it("装上后可用，句柄只读且重复求值不换实现", () => {
    expect(typeof globalThis.requestAnimationFrame).toBe("function");
    expect(typeof globalThis.cancelAnimationFrame).toBe("function");
    const raf = globalThis.requestAnimationFrame;
    const handle = clock();
    expect(Object.isFrozen(handle)).toBe(true);
    // 模块只求值一次，再 import 也不会重装一遍
    return import("../polyfills").then(() => {
      expect(globalThis.requestAnimationFrame).toBe(raf);
      expect(clock()).toBe(handle);
    });
  });

  it("回调只在 run 时触发，不在微任务里自己跑", async () => {
    let ran = false;
    globalThis.requestAnimationFrame(() => (ran = true));
    await Promise.resolve();
    expect(ran).toBe(false);
    clock().run(16);
    expect(ran).toBe(true);
  });

  it("回调参数与 performance.now() 同源（不是帧间隔，也不是另一套时钟）", () => {
    const before = performance.now();
    const seen: number[] = [];
    globalThis.requestAnimationFrame((t) => seen.push(t));
    clock().run(16);
    expect(seen.length).toBe(1);
    // 两个判据：量级一致、时间不倒退（时间戳必须是真实时钟，不能是从 0 累加的 delta）。
    expect(seen[0]).toBeGreaterThanOrEqual(before);
    expect(seen[0]).toBeLessThanOrEqual(performance.now() + 1);
  });

  it("performance.now() 不可信时退回 delta 累加，不把 NaN 送进回调", () => {
    const real = globalThis.performance;
    (globalThis as { performance: unknown }).performance = { now: () => Number.NaN };
    try {
      const seen: number[] = [];
      globalThis.requestAnimationFrame((t) => seen.push(t));
      clock().run(16);
      globalThis.requestAnimationFrame((t) => seen.push(t));
      clock().run(16);
      expect(seen.every((t) => Number.isFinite(t))).toBe(true);
      expect(seen[1]).toBeGreaterThan(seen[0]);
    } finally {
      (globalThis as { performance: unknown }).performance = real;
    }
  });

  it("cancelAnimationFrame 取消未触发的回调", () => {
    let ran = false;
    const id = globalThis.requestAnimationFrame(() => (ran = true));
    globalThis.cancelAnimationFrame(id);
    clock().run(16);
    expect(ran).toBe(false);
  });

  it("回调里再注册 rAF 留到下一帧（否则同帧无限循环）", () => {
    const order: string[] = [];
    globalThis.requestAnimationFrame(() => {
      order.push("first");
      globalThis.requestAnimationFrame(() => order.push("second"));
    });
    clock().run(16);
    expect(order).toEqual(["first"]);
    clock().run(16);
    expect(order).toEqual(["first", "second"]);
  });

  it("单个回调抛错不带走整帧", () => {
    let secondRan = false;
    const spy = console.error;
    console.error = () => {};
    globalThis.requestAnimationFrame(() => {
      throw new Error("boom");
    });
    globalThis.requestAnimationFrame(() => (secondRan = true));
    clock().run(16);
    console.error = spy;
    expect(secondRan).toBe(true);
  });

  it("stop 后不放帧也丢队列，resume 后恢复工作", () => {
    clock().resume();
    let stopped = false;
    globalThis.requestAnimationFrame(() => (stopped = true));
    clock().stop();
    clock().run(16);
    expect(stopped).toBe(false);

    // 停帧期间注册直接被拒（返回 -1），不会积累到下一个应用头上集体复活
    let stale = false;
    expect(globalThis.requestAnimationFrame(() => (stale = true))).toBe(-1);
    clock().resume();
    clock().run(16);
    expect(stale).toBe(false);

    // 重新启动帧驱动后队列正常放行
    let fresh = false;
    globalThis.requestAnimationFrame(() => (fresh = true));
    clock().run(16);
    expect(fresh).toBe(true);
  });
});
