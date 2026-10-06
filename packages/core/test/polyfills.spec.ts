import { describe, expect, it } from "vitest";
import { installGodotPolyfills, runFrameCallbacks } from "../src/polyfills";

/**
 * GodotJS 的裸 V8 没有 requestAnimationFrame，而 Angular 的 zoneless 调度器
 * 会拿 rAF 和 setTimeout 赛跑。这里验证 rAF 是真的被帧驱动，不是空转。
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

  it("时间按 delta 累加", () => {
    installGodotPolyfills();
    const seen: number[] = [];
    globalThis.requestAnimationFrame((t) => seen.push(t));
    runFrameCallbacks(100);
    expect(seen.length).toBe(1);
    expect(seen[0]).toBeGreaterThanOrEqual(100);
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
});
