import { Label, PanelContainer } from "godot";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyStyle, warnEnabled } from "godot-angular/core";
import { captureWarn, expectWarned, resetWarnOnce, setWarnEnabled } from "godot-angular/testing";

beforeEach(() => resetWarnOnce());
afterEach(() => setWarnEnabled(undefined));

/**
 * 运行期告警的门控。
 *
 * 构建器在两个方向均将 ngDevMode 固定（脚本优化开启时 false，否则 true），告警连同文案一并
 * 摇除。本进程运行的是未优化的构建，ngDevMode 为 true，因此使用 setWarnEnabled 验证同一道
 * 闸门的两侧，而非再次执行一次优化构建。
 */
describe("运行期告警开关", () => {
  it("开发模式下，没有对应实现的属性会输出告警", () => {
    // 未优化构建：ngDevMode 被 define 为 true
    expect(warnEnabled()).toBe(true);
    const { warn } = captureWarn(() => applyStyle(new Label(), "display", "flex"));
    expectWarned(warn);
  });

  it("关闭后完全静默，且不会将 key 记入已告警表", () => {
    setWarnEnabled(false);
    const off = captureWarn(() => applyStyle(new Label(), "display", "flex"));
    expect(off.warn.count).toBe(0);

    // 恢复后仍会输出：说明关闭期间未消耗去重 key，否则本条会因“已告警过”而不再输出
    setWarnEnabled(undefined);
    const on = captureWarn(() => applyStyle(new Label(), "display", "flex"));
    expectWarned(on.warn);
  });
});

/**
 * 告警等级。两者的区别是读者要不要改代码：`[忽略]` 必须改写，`[兼容]` 自行判断能否接受。
 */
describe("运行期告警等级", () => {
  it("声明被丢弃：标 [忽略]", () => {
    const { warn } = captureWarn(() => applyStyle(new Label(), "display", "flex"));
    expectWarned(warn);
    expect(warn.warnings.join("\n")).toContain("[忽略]");
  });

  it("声明写进去了但语义不同：标 [兼容]", () => {
    // Godot 的 StyleBoxFlat 只有一个 border_color，单边颜色只能整圈同色
    const { warn } = captureWarn(() => applyStyle(new PanelContainer(), "border-top-color", "red"));
    expectWarned(warn);
    expect(warn.warnings.join("\n")).toContain("[兼容]");
  });
});
