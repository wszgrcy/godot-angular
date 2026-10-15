import { beforeEach, describe, expect, it } from "vitest";
import { Control, Label, VBoxContainer, Vector2, Vector2i, Window } from "godot";
import { bindWindowEnvironment, readEnvironment, StyleRuntime } from "godot-angular/core";
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
    // 无头下根窗口是个 dummy 尺寸（实测 64×64）：此处只验证“接线可运行 + 卸载函数可用”，
    // 真实尺寸变化必须在实机上确认（坐标系语义由下面两个用例在引擎里直接断言）
    const unbind = bindWindowEnvironment(runtime, root);
    expect(typeof unbind).toBe("function");
    unbind();
  });

  // 独立窗口做被测对象：动测试运行器自己的根窗口会连带影响后续用例。
  // 基准 1280×720 + EXPAND，窗口 900×1000 → 布局坐标系 1280×1422（与窗口物理尺寸差一个缩放因子）。
  function scaledWindow(): { win: Window; probe: Control } {
    const win = new Window();
    win.content_scale_mode = Window.ContentScaleMode.CONTENT_SCALE_MODE_CANVAS_ITEMS;
    win.content_scale_aspect = Window.ContentScaleAspect.CONTENT_SCALE_ASPECT_EXPAND;
    win.content_scale_size = new Vector2i(1280, 720);
    root.get_window()!.add_child(win);
    const probe = new Control();
    probe.set_anchors_preset(Control.LayoutPreset.PRESET_FULL_RECT);
    win.add_child(probe);
    win.size = new Vector2i(900, 1000);
    return { win, probe };
  }

  it("readEnvironment 取布局坐标系：内容缩放下与 Control.size 同值，不是窗口物理像素", () => {
    const { win, probe } = scaledWindow();
    expect([probe.size.x, probe.size.y]).toEqual([1280, 1422]);

    const env = readEnvironment(win);
    expect([env.width, env.height]).toEqual([1280, 1422]);
    win.free();
  });

  it("断点跟着布局走：窗口物理宽 900 但布局宽 1280 时 max-width:980 不命中", () => {
    runtime.addCss(`.box { color: rgb(255, 0, 0); }`);
    runtime.addCss(`@media (max-width: 980px) { .box { color: rgb(0, 0, 255); } }`);
    const label = make(new Label(), "box");

    const { win } = scaledWindow();
    runtime.setEnv(readEnvironment(win));
    runtime.flush();
    expect(label.get_theme_color("font_color").r).toBeCloseTo(1, 3);

    // 同一个窗口关掉内容缩放，物理像素即布局像素，900 宽就应当命中
    win.content_scale_mode = Window.ContentScaleMode.CONTENT_SCALE_MODE_DISABLED;
    runtime.setEnv(readEnvironment(win));
    runtime.flush();
    expect(label.get_theme_color("font_color").b).toBeCloseTo(1, 3);
    win.free();
  });

  // 挂载点（GODOT_ROOT）才是本工程的“视口”：局部挂载就该局部判断点。
  // 窗口固定 1600×900（无内容缩放），挂载点尺寸由用例定。
  function mounted(size: Vector2 | "full" | "bare"): { win: Window; mount: Control } {
    const win = new Window();
    root.get_window()!.add_child(win);
    win.size = new Vector2i(1600, 900);
    const mount = new Control();
    win.add_child(mount);
    if (size === "full") mount.set_anchors_and_offsets_preset(Control.LayoutPreset.PRESET_FULL_RECT);
    else if (size !== "bare") mount.size = size;
    return { win, mount };
  }

  it("局部挂载：媒体查询按挂载点区域判定，不是整窗口", () => {
    const { win, mount } = mounted(new Vector2(600, 400));
    expect([readEnvironment(mount).width, readEnvironment(mount).height]).toEqual([600, 400]);

    runtime.addCss(`.box { color: rgb(255, 0, 0); }`);
    runtime.addCss(`@media (max-width: 800px) { .box { color: rgb(0, 0, 255); } }`);
    const label = make(new Label(), "box");
    runtime.setEnv(readEnvironment(mount));
    runtime.flush();
    // 窗口宽 1600，但 UI 只有 600 可用：按局部判就该命中
    expect(label.get_theme_color("font_color").b).toBeCloseTo(1, 3);
    win.free();
  });

  it("挂载点铺满窗口时，量挂载点与量窗口视口等价（内容缩放下也一样）", () => {
    const { win, mount } = mounted("full");
    win.content_scale_mode = Window.ContentScaleMode.CONTENT_SCALE_MODE_CANVAS_ITEMS;
    win.content_scale_aspect = Window.ContentScaleAspect.CONTENT_SCALE_ASPECT_EXPAND;
    win.content_scale_size = new Vector2i(1280, 720);
    win.size = new Vector2i(900, 1000);

    expect([mount.size.x, mount.size.y]).toEqual([1280, 1422]);
    expect(readEnvironment(mount)).toEqual(readEnvironment(win));
    win.free();
  });

  it("挂载点还没被布局（0×0）：退回窗口视口，而不是把所有 max-width 都判成命中", () => {
    const { win, mount } = mounted("bare");
    expect([mount.size.x, mount.size.y]).toEqual([0, 0]);

    const rect = win.get_visible_rect();
    expect([readEnvironment(mount).width, readEnvironment(mount).height]).toEqual([
      rect.size.x,
      rect.size.y,
    ]);
    win.free();
  });

  it("挂载点变尺寸会重算媒体查询（resized 驱动，窗口没动也算）", async () => {
    runtime.addCss(`.box { color: rgb(255, 0, 0); }`);
    runtime.addCss(`@media (max-width: 500px) { .box { color: rgb(0, 0, 255); } }`);
    const label = make(new Label(), "box");

    const { win, mount } = mounted(new Vector2(800, 600));
    const unbind = bindWindowEnvironment(runtime, mount);
    runtime.flush();
    expect(label.get_theme_color("font_color").r).toBeCloseTo(1, 3);

    // 只改挂载点尺寸，窗口全程没动
    mount.size = new Vector2(400, 300);
    await awaitFrames(1);
    expect(label.get_theme_color("font_color").b).toBeCloseTo(1, 3);

    unbind();
    win.free();
  });
});
