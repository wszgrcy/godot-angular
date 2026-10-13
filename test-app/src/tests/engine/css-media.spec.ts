import { beforeEach, describe, expect, it } from "vitest";
import { Label, VBoxContainer, type Control } from "godot";
import { bindWindowEnvironment, StyleRuntime } from "godot-angular/core";
import { awaitFrames, captureWarn, expectWarned, makeRenderer, resetWarnOnce } from "godot-angular/testing";

let runtime: StyleRuntime;
let root: Control;

beforeEach(() => {
  resetWarnOnce();
  runtime = new StyleRuntime();
  root = makeRenderer().root;
});

function make<T extends Control>(node: T, cls: string): T {
  root.add_child(node);
  runtime.attach(node);
  (node as unknown as { cssClasses: Set<string> }).cssClasses.add(cls);
  runtime.flush();
  return node;
}

describe("媒体查询", () => {
  it("注入宽度决定 @media 命中与否，切换时样式跟着变", async () => {
    runtime.addCss(`.box { color: rgb(255, 0, 0); }`);
    runtime.addCss(`@media (min-width: 500px) { .box { color: rgb(0, 0, 255); } }`);
    const label = make(new Label(), "box");

    runtime.setEnv({ width: 400 });
    runtime.flush();
    expect(label.get_theme_color("font_color").r).toBeCloseTo(1, 3);

    runtime.setEnv({ width: 600 });
    await awaitFrames(1);
    expect(label.get_theme_color("font_color").b).toBeCloseTo(1, 3);

    // 退回窄屏：媒体查询那条需要撤销，而不是继续保留在节点上
    runtime.setEnv({ width: 320 });
    await awaitFrames(1);
    expect(label.get_theme_color("font_color").r).toBeCloseTo(1, 3);
  });

  it("同值 setEnv 不重算（拖窗口会连发几十次同尺寸）", () => {
    runtime.addCss(`@media (min-width: 100px) { .box { color: rgb(1, 1, 1); } }`);
    make(new Label(), "box");
    runtime.setEnv({ width: 500 });
    runtime.flush();
    const before = runtime.cascade.stats.applied + runtime.cascade.stats.cleared;
    runtime.setEnv({ width: 500 });
    runtime.flush();
    expect(runtime.cascade.stats.applied + runtime.cascade.stats.cleared).toBe(before);
  });

  it("prefers-color-scheme 注入切换深色样式", async () => {
    runtime.addCss(`@media (prefers-color-scheme: dark) { .box { color: rgb(250, 250, 250); } }`);
    const label = make(new Label(), "box");
    expect(label.has_theme_color_override("font_color")).toBe(false);

    runtime.setEnv({ "prefers-color-scheme": "dark" });
    await awaitFrames(1);
    expect(label.get_theme_color("font_color").r).toBeCloseTo(250 / 255, 3);

    runtime.setEnv({ "prefers-color-scheme": "light" });
    await awaitFrames(1);
    expect(label.has_theme_color_override("font_color")).toBe(false);
  });
});

describe("自定义属性", () => {
  it("--c 定义在同一节点上，color: var(--c) 展开成它", () => {
    runtime.addCss(`.box { --c: rgb(9, 9, 9); color: var(--c); }`);
    const label = make(new Label(), "box");
    expect(label.get_theme_color("font_color").r).toBeCloseTo(9 / 255, 5);
  });

  it("变量沿父链继承，子节点看得到祖先的 --c", () => {
    runtime.addCss(`.theme { --c: rgb(0, 255, 0); }`);
    runtime.addCss(`.leaf { color: var(--c); }`);
    const box = make(new VBoxContainer(), "theme");
    const child = new Label();
    box.add_child(child);
    runtime.attach(child);
    (child as unknown as { cssClasses: Set<string> }).cssClasses.add("leaf");
    runtime.flush();
    expect(child.get_theme_color("font_color").g).toBeCloseTo(1, 3);
  });

  it("祖先换变量 → 子树下一轮跟着变（不靠通知）", async () => {
    runtime.addCss(`.theme { --c: rgb(255, 0, 0); }`);
    runtime.addCss(`.leaf { color: var(--c); }`);
    const box = make(new VBoxContainer(), "theme");
    const child = new Label();
    box.add_child(child);
    runtime.attach(child);
    (child as unknown as { cssClasses: Set<string> }).cssClasses.add("leaf");
    runtime.flush();
    expect(child.get_theme_color("font_color").r).toBeCloseTo(1, 3);

    // 更换 class 等价于更换变量（真实场景是主题 class 切换）
    runtime.addCss(`.theme.alt { --c: rgb(0, 0, 255); }`);
    (box as unknown as { cssClasses: Set<string> }).cssClasses.add("alt");
    await awaitFrames(2);
    expect(child.get_theme_color("font_color").b).toBeCloseTo(1, 3);
  });

  it("取不到变量：有 fallback 用兜底，没 fallback 就忽略并告警", () => {
    runtime.addCss(`.a { color: var(--nope, rgb(0, 255, 0)); }`);
    runtime.addCss(`.b { color: var(--nope); }`);
    const { warn } = captureWarn(() => {
      const a = make(new Label(), "a");
      const b = make(new Label(), "b");
      runtime.flush();
      expect(a.get_theme_color("font_color").g).toBeCloseTo(1, 3);
      // 关键：获取不到时是“这条未写”，而不是“写成空”——后者会将原有值刷掉
      expect(b.has_theme_color_override("font_color")).toBe(false);
    });
    expectWarned(warn);
  });
});

describe("calc()", () => {
  it("不支持的形态：告警并忽略，不抛", () => {
    runtime.addCss(`.box { width: calc(100px + 20px); }`);
    const { warn } = captureWarn(() => {
      const label = make(new Label(), "box");
      runtime.flush();
      expect(label.custom_minimum_size.x).toBe(0);
    });
    expectWarned(warn);
  });
});

describe("环境接线", () => {
  it("bindWindowEnvironment 在无头下不炸，且能读到窗口对象就灌一次环境", () => {
    // 无头模式下 size 为 (0,0)：此处只验证“接线可运行 + 卸载函数可用”，
    // 真实尺寸变化必须在实机上确认
    const unbind = bindWindowEnvironment(runtime, root);
    expect(typeof unbind).toBe("function");
    unbind();
  });
});
