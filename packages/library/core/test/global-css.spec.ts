/**
 * 全局样式交接（**node** 环境，vitest.node.config.mts）。
 *
 * 覆盖「销毁重建多次结果必须一致」这条约束中能用纯逻辑验证的部分：
 * `GODOT_APP_PROVIDERS` 为每个应用创建独立 `StyleRuntime`，而构建期写入
 * `__CUJ_GLOBAL_CSS__` 的全局样式只能取走一次，因此需要缓存下来，供每个运行时
 * （同进程的第二个应用、或同一场景重建后的新实例）各自注册。
 *
 * 不缓存的后果：第二个应用取到空数组，全局样式全部缺失，且现象随应用创建顺序变化。
 * 模板工程中的真机现象：主应用 → 混合场景 → 回主应用，回来那一趟整屏无样式。
 *
 * 本文件只 import `global-css.ts`：`css-runtime.ts` 会连带 `style-target.ts` 在运行期
 * import 真 `godot` 包，node 环境加载不了，因此「每个运行时各自注册」那部分在引擎侧验证。
 */
import { describe, expect, it, vi } from "vitest";
import { readGlobalCss, takeGlobalCss } from "../global-css";

const CSS = "Label.title { color: #ff0000 }";

function setBag(value: unknown): void {
  (globalThis as Record<string, unknown>).__CUJ_GLOBAL_CSS__ = value;
}

describe("全局样式的交接", () => {
  it("第一个运行时 drain，之后的运行时拿到同一份副本", () => {
    setBag([CSS]);

    // 第一个应用：drain 到全局样式并记住
    expect(readGlobalCss()).toEqual([CSS]);
    // 交接变量已被取走：此后任何人再 drain 都拿不到东西
    expect(takeGlobalCss()).toEqual([]);
    // 第二个应用 / 销毁重建后的新实例：同一份副本，注册结果与第一个一致
    expect(readGlobalCss()).toEqual([CSS]);
    expect(readGlobalCss()).toEqual([CSS]);
  });

  it("空白与非字符串条目在交接时就被过滤", async () => {
    setBag(["   ", 42, null, "Label { color: #00ff00 }", ""]);
    // 换一个全新的模块实例，避免上一条测试已经填好的缓存
    vi.resetModules();
    const fresh = await import("../global-css");
    expect(fresh.readGlobalCss()).toEqual(["Label { color: #00ff00 }"]);
  });

  it("没有全局样式时返回空数组而不是抛错", async () => {
    setBag(undefined);
    vi.resetModules();
    const fresh = await import("../global-css");
    expect(fresh.readGlobalCss()).toEqual([]);
    expect(fresh.takeGlobalCss()).toEqual([]);
  });
});
