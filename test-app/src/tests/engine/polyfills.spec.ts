import { describe, expect, it } from "vitest";
import {
  CUJ_FRAME_KEY,
  installGodotPolyfills,
  resumeFrameCallbacks,
  runFrameCallbacks,
  stopFrameCallbacks,
} from "godot-angular/polyfills";
import { awaitFrames } from "godot-angular/testing";

const g = globalThis as any;

describe("装出来的东西", () => {
  it("Godot 没有 document，装的是空占位（故意不填内容）", () => {
    expect(g.document).toBeTypeOf("object");
    expect(Object.keys(g.document)).toEqual([]);
  });

  it("帧钟句柄钉成只读，赋值不会把帧驱动换掉", () => {
    const clock = g[CUJ_FRAME_KEY];
    expect(typeof clock.run).toBe("function");
    expect(typeof clock.stop).toBe("function");
    expect(typeof clock.resume).toBe("function");
    expect(Object.isFrozen(clock)).toBe(true);
    const run = clock.run;
    try {
      g[CUJ_FRAME_KEY] = {};
    } catch {
      // 非严格模式下赋值静默失败，严格模式抛 —— 两种都算"没换掉"
    }
    expect(g[CUJ_FRAME_KEY].run).toBe(run);
  });

  it("installGodotPolyfills 幂等：再装一次不覆盖已装好的实现", () => {
    const raf = g.requestAnimationFrame;
    const perf = g.performance;
    installGodotPolyfills();
    installGodotPolyfills();
    expect(g.requestAnimationFrame).toBe(raf);
    expect(g.performance).toBe(perf);
  });

  it("performance.now 给有限数，mark/measure 是可叫的空操作", () => {
    const now = g.performance.now();
    expect(Number.isFinite(now)).toBe(true);
    expect(() => {
      g.performance.mark("a");
      g.performance.measure("b", "a");
      g.performance.clearMeasures();
      g.performance.clearMarks();
    }).not.toThrow();
  });

  it("queueMicrotask 在下一个微任务里跑", async () => {
    let ran = false;
    g.queueMicrotask(() => {
      ran = true;
    });
    expect(ran).toBe(false);
    await Promise.resolve();
    expect(ran).toBe(true);
  });
});

describe("帧驱动", () => {
  it("rAF 注册的回调在真帧里拿到有限时间戳", async () => {
    const seen: number[] = [];
    g.requestAnimationFrame((t: number) => seen.push(t));
    expect(seen).toEqual([]);
    await awaitFrames(2);
    expect(seen.length).toBe(1);
    expect(Number.isFinite(seen[0])).toBe(true);
  });

  it("cancelAnimationFrame 之后不再执行", async () => {
    let ran = false;
    const id = g.requestAnimationFrame(() => {
      ran = true;
    });
    g.cancelAnimationFrame(id);
    await awaitFrames(2);
    expect(ran).toBe(false);
  });

  it("同帧里再注册 rAF 留到下一帧，不会当场无限循环", async () => {
    let depth = 0;
    g.requestAnimationFrame(() => {
      depth++;
      g.requestAnimationFrame(() => depth++);
    });
    await awaitFrames(1);
    expect(depth).toBe(1);
    await awaitFrames(1);
    expect(depth).toBe(2);
  });

  it("单个回调抛出异常不影响整帧，其余回调继续执行", async () => {
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void errors.push(args.map(String).join(" "));
    let after = 0;
    try {
      g.requestAnimationFrame(() => {
        throw new Error("回调抛出异常");
      });
      g.requestAnimationFrame(() => {
        after++;
      });
      await awaitFrames(2);
    } finally {
      console.error = original;
    }
    expect(after).toBe(1);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("回调抛出异常");
  });

  it("停帧后 rAF 拒收（-1）且已排队的丢掉，resume 后恢复", async () => {
    try {
      let pending = 0;
      g.requestAnimationFrame(() => pending++);
      stopFrameCallbacks();
      expect(g.requestAnimationFrame(() => pending++)).toBe(-1);
      await awaitFrames(2);
      expect(pending).toBe(0);
    } finally {
      resumeFrameCallbacks();
    }
    let after = 0;
    g.requestAnimationFrame(() => after++);
    await awaitFrames(2);
    expect(after).toBe(1);
  });

  it("performance.now 不可信时退回「上一帧 + delta」，NaN 不进回调", async () => {
    const real = g.performance;
    try {
      g.performance = { now: () => Number.NaN };
      const seen: number[] = [];
      g.requestAnimationFrame((t: number) => seen.push(t));
      runFrameCallbacks(16);
      expect(seen.length).toBe(1);
      expect(Number.isFinite(seen[0])).toBe(true);
      expect(seen[0]).toBeGreaterThan(0);
    } finally {
      g.performance = real;
    }
  });
});
