/**
 * `background-image: url()` → StyleBoxTexture 的写入位置取证。
 *
 * 运行于真实引擎：断言的内容是节点上的 stylebox 变更为何种类型、纹理是否已挂载。
 * `url()` 的写法校验（多个 url、非 res:// 路径、gradient、none）属于纯解析，
 * 在 packages/css/test/css-background-image.spec.ts 中约束。
 *
 * 夹具 fixtures/css-texture-fixture.tres 是一个 NoiseTexture2D（Texture2D 的派生类），
 * 遵循与真实图片完全相同的加载路径，而它本身是文本文件，可以纳入版本库。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { PanelContainer, StyleBoxFlat, StyleBoxTexture, Vector2, type Control } from "godot";
import { CssCode } from "godot-angular/css";
import { StyleRuntime } from "godot-angular/core";
import {
  Screen,
  awaitFrames,
  captureWarn,
  expectWarnCode,
  isHeaded,
  makeRenderer,
  newStyleRuntime,
  resetWarnOnce,
} from "godot-angular/testing";

const FIXTURE = "res://fixtures/css-texture-fixture.tres";
/** 纯色（青色）贴图，像素断言用 */
const SOLID = "res://fixtures/css-solid-cyan.tres";

let runtime: StyleRuntime;
let root: Control;

beforeEach(() => {
  runtime = newStyleRuntime();
  root = makeRenderer().root;
  resetWarnOnce();
});

function make<T extends Control>(node: T, cls: string): T {
  root.add_child(node);
  runtime.attach(node);
  (node as unknown as { cssClasses: Set<string> }).cssClasses.add(cls);
  runtime.flush();
  return node;
}

/** PanelContainer 的底色盒 item */
const PANEL = "panel";

describe("background-image 写入位置", () => {
  it("url() 命中资源时该 stylebox 换为 StyleBoxTexture 并挂载纹理", () => {
    runtime.addCss(`.p { background-image: url("${FIXTURE}"); }`);
    const panel = make(new PanelContainer(), "p");
    const box = panel.get_theme_stylebox(PANEL);
    expect(box).toBeInstanceOf(StyleBoxTexture);
    expect((box as StyleBoxTexture).texture).toBeTruthy();
  });

  it("非填充字段不受互斥影响：padding 仍写入纹理 stylebox", () => {
    runtime.addCss(`.p { background-image: url("${FIXTURE}"); padding: 6px; }`);
    const panel = make(new PanelContainer(), "p");
    const box = panel.get_theme_stylebox(PANEL) as StyleBoxTexture;
    expect(box).toBeInstanceOf(StyleBoxTexture);
    expect(box.content_margin_left).toBe(6);
  });

  it("资源加载失败时输出告警且不写入覆盖，不遗留空纹理 stylebox", () => {
    const captured = captureWarn(() => {
      runtime.addCss(`.p { background-image: url("res://fixtures/no-such-image.png"); }`);
      const panel = make(new PanelContainer(), "p");
      runtime.flush();
      expect(panel.has_theme_stylebox_override(PANEL)).toBe(false);
    });
    expect(captured.warn.codes).toContain(CssCode.TextureLoadFailed);
  });
});

describe("与 background-color 互斥：层叠靠后者胜出", () => {
  it("同一条规则中图片在后 → 纹理生效，底色被丢弃", () => {
    runtime.addCss(`.p { background-color: rgb(0, 0, 255); background-image: url("${FIXTURE}"); }`);
    const panel = make(new PanelContainer(), "p");
    expect(panel.get_theme_stylebox(PANEL)).toBeInstanceOf(StyleBoxTexture);
  });

  it("同一条规则中底色在后 → 底色生效，不创建纹理 stylebox", () => {
    runtime.addCss(`.p { background-image: url("${FIXTURE}"); background-color: rgb(0, 0, 255); }`);
    const panel = make(new PanelContainer(), "p");
    const box = panel.get_theme_stylebox(PANEL);
    expect(box).toBeInstanceOf(StyleBoxFlat);
    expect((box as StyleBoxFlat).bg_color.b).toBeCloseTo(1, 3);
  });

  it("跨规则同样遵循层叠：特异度更高的一条决定填充", () => {
    runtime.addCss(`.p { background-image: url("${FIXTURE}"); }`);
    runtime.addCss(`.p.p2 { background-color: rgb(255, 0, 0); }`);
    const panel = make(new PanelContainer(), "p");
    (panel as any).cssClasses.add("p2");
    runtime.invalidate(panel);
    runtime.flush();
    const box = panel.get_theme_stylebox(PANEL);
    expect(box).toBeInstanceOf(StyleBoxFlat);
    expect((box as StyleBoxFlat).bg_color.r).toBeCloseTo(1, 3);
  });

  it("纹理声明被撤销后，底色重新生效（互斥关系并非永久占用）", () => {
    runtime.addCss(`.p { background-color: rgb(0, 255, 0); }`);
    const handle = runtime.addCss(`.p { background-image: url("${FIXTURE}"); }`);
    const panel = make(new PanelContainer(), "p");
    expect(panel.get_theme_stylebox(PANEL)).toBeInstanceOf(StyleBoxTexture);

    runtime.removeCss(handle);
    runtime.flush();
    const box = panel.get_theme_stylebox(PANEL);
    expect(box).toBeInstanceOf(StyleBoxFlat);
    expect((box as StyleBoxFlat).bg_color.g).toBeCloseTo(1, 3);
  });

  it("状态 stylebox 各自决定自身的填充：:hover 换图不影响常态盒", async () => {
    runtime.addCss(`
      .p { background-color: rgb(0, 0, 255); }
      .p:hover { background-image: url("${FIXTURE}"); }
    `);
    const panel = make(new PanelContainer(), "p");
    expect(panel.get_theme_stylebox(PANEL)).toBeInstanceOf(StyleBoxFlat);

    panel.emit_signal("mouse_entered");
    await awaitFrames(1);
    // PanelContainer 仅有 panel 一个 stylebox：hover 规则写在同一个 stylebox 上，填充按层叠关系换为纹理
    expect(panel.get_theme_stylebox(PANEL)).toBeInstanceOf(StyleBoxTexture);
  });
});

/**
 * 贴图是否真的被画出来。
 *
 * 上面的用例断到 `get_theme_stylebox()` 是 `StyleBoxTexture` 且纹理已挂载为止。属性写对但
 * 画面上看不见（控件尺寸为 0、被其它节点遮住、纹理本身是空的）只有读像素能发现。
 * 夹具是一张纯色（青色）贴图，因此断言就是「面板区域内出现了青色」。
 */
describe.skipIf(!isHeaded())("贴图真的画出来（有头）", () => {
  const CYAN: readonly [number, number, number] = [0, 1, 1];

  it("url() 指向的贴图会出现在面板区域内", async () => {
    runtime.addCss(`.p { background-image: url("${SOLID}"); }`);
    const panel = make(new PanelContainer(), "p");
    panel.position = new Vector2(40, 40);
    panel.size = new Vector2(200, 80);

    const screen = Screen.attach(root);
    expect(await screen.waitForColor(panel, CYAN)).toBe(true);
  });
});
