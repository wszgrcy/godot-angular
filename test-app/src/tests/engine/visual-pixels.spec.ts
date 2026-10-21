import { Component, provideZonelessChangeDetection, signal } from "@angular/core";
import type { ComponentFixture } from "@angular/core/testing";
import { TestBed } from "@angular/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Vector2, type Control } from "godot";
import { resetGlobalCssCache } from "godot-angular/core";
import {
  Screen,
  awaitFrames,
  initGodotTestEnvironment,
  isHeaded,
  provideGlobalCss,
} from "godot-angular/testing";

/**
 * 像素级验证：确认样式真的被画到了屏幕上，而不只是写进了节点属性。
 *
 * 与其它引擎测试的区别：其余测试读的是节点的属性（`has_theme_color_override` 之类），
 * 这里读的是窗口实际渲染出来的图像。属性写对但没画出来（渲染器不认、被遮挡、尺寸为 0）
 * 只有这一层能发现。
 *
 * 需要引擎以有头模式运行（angular.json 测试目标的 `engine.headless: false`）。无头下
 * `Viewport.get_texture().get_image()` 返回 null，整组用例自动跳过。
 *
 * 颜色只取纯色原色 / 二次色：Godot 的 UI 颜色要经过 sRGB 与线性空间来回转换，只有 0 与 1
 * 两个端点在转换后保持不变，取中间值（例如绿 200）时截图读回的数值会偏移，断言就得放宽容差。
 *
 * 每条规则各占一行、各用一个颜色，五条写入路径分别是：
 *   title  组件样式（构建期解析）
 *   glob   全局样式表
 *   dyn    class 绑定（signal → 渲染器 addClass → 标记节点 → 样式刷新）
 *   box    背景（StyleBoxFlat，与字体色不同的另一条写入路径）
 *   btn    :hover 伪类（来源是引擎的指针状态，Angular 不跟踪它）
 */

const RED: readonly [number, number, number] = [1, 0, 0];
const BLUE: readonly [number, number, number] = [0, 0, 1];
const MAGENTA: readonly [number, number, number] = [1, 0, 1];
const CYAN: readonly [number, number, number] = [0, 1, 1];
const YELLOW: readonly [number, number, number] = [1, 1, 0];

/** 测试根的尺寸。必须小于引擎默认窗口（1152x640），否则控件会被裁到窗口外。 */
const HOST_WIDTH = 700;
const HOST_HEIGHT = 560;

/** 全局样式表的内容，等价于独立构建时 angular.json 的 `styles` 选项 */
const GLOBAL_CSS = `.glob { color: rgb(255, 0, 255); font-size: 40px; }`;

@Component({
  selector: "visual-root",
  standalone: true,
  styles: [
    `.title { color: rgb(255, 0, 0); font-size: 40px; }`,
    `.dyn { font-size: 40px; }`,
    `.dyn.on { color: rgb(0, 0, 255); }`,
    `.box { background-color: rgb(0, 255, 255); }`,
    `.hb:hover { color: rgb(255, 255, 0); }`,
  ],
  template: `
    <VBoxContainer name="stage" [size_flags]="expand">
      <Label name="title" class="title" text="TITLE"></Label>
      <Label name="dyn" class="dyn" [class.on]="on()" text="DYNAMIC"></Label>
      <Label name="glob" class="glob" text="GLOBAL"></Label>
      <PanelContainer name="box" class="box" [custom_minimum_size]="boxMin">
        <Label name="boxLabel" text="BOX"></Label>
      </PanelContainer>
      <Button name="btn" class="hb" text="HOVER"></Button>
    </VBoxContainer>
  `,
})
class VisualRoot {
  /** Control.SIZE_EXPAND_FILL */
  readonly expand = 3;
  /** 背景块需要可采样的面积，只靠子节点撑不开尺寸 */
  readonly boxMin = new Vector2(360, 72);
  readonly on = signal(false);
}

describe.skipIf(!isHeaded())("像素级验证（有头模式）", () => {
  let host: Control;
  let fixture: ComponentFixture<VisualRoot>;
  let screen: Screen;

  /** 翻动 class 绑定，并等颜色真的出现在画面上（或消失） */
  const setDyn = async (on: boolean): Promise<void> => {
    fixture.componentInstance.on.set(on);
    fixture.detectChanges();
    await screen.waitForColor(screen.byName("dyn"), BLUE, on);
  };

  beforeAll(async () => {
    provideGlobalCss([GLOBAL_CSS]);
    // 不改窗口尺寸：整个测试套件共用一个窗口，改尺寸会把布局影响泄给其它文件
    host = initGodotTestEnvironment({ width: HOST_WIDTH, height: HOST_HEIGHT });
    await TestBed.configureTestingModule({
      imports: [VisualRoot],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
    fixture = TestBed.createComponent(VisualRoot);
    fixture.detectChanges();
    await awaitFrames(2);
    screen = Screen.attach(host);
  });

  afterAll(() => {
    fixture?.destroy();
    // `readGlobalCss()` 会把取到的全局样式缓存下来，之后每个用例的运行时都会再注册一遍。
    // 不清掉的话，本文件的 `.glob` 会泄进后面所有文件。
    resetGlobalCssCache();
  });

  it("组件样式：标题画成红色", () => {
    expect(screen.hasColor(screen.byName("title"), RED)).toBe(true);
    screen.savePng("01-first-frame");
  });

  it("class 未添加时不出现条件色", () => {
    expect(screen.hasColor(screen.byName("dyn"), BLUE)).toBe(false);
  });

  it("class 绑定：加上后画成蓝色，去掉后恢复", async () => {
    await setDyn(true);
    expect(screen.hasColor(screen.byName("dyn"), BLUE)).toBe(true);
    screen.savePng("02-class-on");

    await setDyn(false);
    expect(screen.hasColor(screen.byName("dyn"), BLUE)).toBe(false);
    screen.savePng("03-class-off");
  });

  it("全局样式表：画成品红", () => {
    expect(screen.hasColor(screen.byName("glob"), MAGENTA)).toBe(true);
  });

  it("背景：面板画成青色", () => {
    expect(screen.hasColor(screen.byName("box"), CYAN)).toBe(true);
  });

  it(":hover：指针移到按钮上画成黄色，移开后恢复", async () => {
    await screen.hover(screen.byName("btn"));
    expect(await screen.waitForColor(screen.byName("btn"), YELLOW, true)).toBe(true);
    screen.savePng("04-hover");

    await screen.moveMouseAway();
    expect(await screen.waitForColor(screen.byName("btn"), YELLOW, false)).toBe(true);
    screen.savePng("05-hover-off");
  });
});
