/**
 * `@font-face` 与 `font-family` 的写入位置取证。
 *
 * 运行于真实引擎：断言的内容是节点上的字体覆盖（has_theme_font_override / get_theme_font），
 * 以及资源能否确实被 ResourceLoader 加载。写法校验（多个 url()、非 res:// 路径、
 * 后缀不支持等）属于纯解析，在 packages/css/test/css-font-face.spec.ts 中约束。
 *
 * 夹具 fixtures/css-font-fixture.tres 是一个 FontVariation：它继承 Font，
 * 因此能遵循与真实字体文件完全相同的加载与覆盖路径，而它本身是文本文件，可以纳入版本库。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { Font, Label, SystemFont, Vector2, type Control } from "godot";
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

/** 与真实字体文件走同一条加载路径的夹具 */
const FIXTURE = "res://fixtures/css-font-fixture.tres";

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

describe("@font-face 登记", () => {
  it("font-family 命中登记时写 font 字体覆盖", () => {
    runtime.addCss(`
      @font-face { font-family: "Fixture"; src: url("${FIXTURE}"); }
      .t { font-family: Fixture; }
    `);
    const label = make(new Label(), "t");
    expect(label.has_theme_font_override("font")).toBe(true);
    expect(label.get_theme_font("font", "Label")).toBeTruthy();
  });

  it("家族名不区分大小写，带引号与不带引号等价", () => {
    runtime.addCss(`
      @font-face { font-family: "Fixture"; src: url("${FIXTURE}"); }
      .t { font-family: "FIXTURE"; }
    `);
    expect(make(new Label(), "t").has_theme_font_override("font")).toBe(true);
  });

  it("样式表移除后字体覆盖随之撤销", () => {
    const handle = runtime.addCss(`
      @font-face { font-family: "Fixture"; src: url("${FIXTURE}"); }
      .t { font-family: Fixture; }
    `);
    const label = make(new Label(), "t");
    expect(label.has_theme_font_override("font")).toBe(true);

    runtime.removeCss(handle);
    runtime.flush();
    expect(label.has_theme_font_override("font")).toBe(false);
  });

  it("@media 内的 @font-face 同样登记：字体存在与否与媒体条件无关", () => {
    runtime.addCss(`
      @media (min-width: 1px) { @font-face { font-family: "Fixture"; src: url("${FIXTURE}"); } }
      .t { font-family: Fixture; }
    `);
    expect(make(new Label(), "t").has_theme_font_override("font")).toBe(true);
  });
});

describe("未登记分支：整串交由 SystemFont", () => {
  it("未登记的家族：写入 SystemFont 覆盖，不输出告警（由引擎兜底回退）", () => {
    const captured = captureWarn(() => {
      runtime.addCss(`.t { font-family: Nowhere; }`);
      runtime.flush();
    });
    const label = make(new Label(), "t");
    expect(label.has_theme_font_override("font")).toBe(true);
    expect(label.get_theme_font("font", "Label")).toBeInstanceOf(SystemFont);
    // 走系统字体是正常路径，不是错误，不该有告警
    expect(captured.warn.warnings.join("\n")).toBe("");
  });

  /*
   * `SystemFont.font_names` 在 GodotJS 中可写入、不可读取（PackedStringArray 的绑定
   * 仅提供一个空壳，length / 迭代 / 下标均不可用，与 `Font.fallbacks` 为同一症状），因此候选列表
   * 是否整串传递到位、顺序是否正确，只能借助度量加以判定：以一个直接构造的同名 SystemFont 作为对照。
   */
  it("候选列表整串写入 font_names，顺序不变（引擎按序选取首个存在的字体）", () => {
    runtime.addCss(`.t { font-family: NowhereX, Consolas; }`);
    const got = make(new Label(), "t").get_theme_font("font", "Label") as SystemFont;

    const yardstick = new SystemFont();
    yardstick.font_names = ["Consolas"];
    expect(got).toBeInstanceOf(SystemFont);
    // 首个名字不存在、第二个存在 → 引擎取到了 Consolas，说明整串均已传入且保持原序
    expect(got.get_height(16)).toBe(yardstick.get_height(16));
    expect(got.get_string_size("Handgloves", 0, -1, 16).x).toBeCloseTo(
      yardstick.get_string_size("Handgloves", 0, -1, 16).x,
      3,
    );
  });

  it("候选中存在已登记项即不使用系统字体（登记优先，与候选顺序无关）", () => {
    runtime.addCss(`
      @font-face { font-family: "Fixture"; src: url("${FIXTURE}"); }
      .t { font-family: Arial, Fixture; }
    `);
    const font = make(new Label(), "t").get_theme_font("font", "Label") as Font;
    expect(font).not.toBeInstanceOf(SystemFont);
    expect((font as unknown as { resource_path: string }).resource_path).toBe(FIXTURE);
  });

  it("相同的候选列表复用同一个 SystemFont 实例（不每次新建资源）", () => {
    runtime.addCss(`.a { font-family: Shared, AlsoShared; }`);
    const one = make(new Label(), "a");
    const two = make(new Label(), "a");
    expect(one.get_theme_font("font", "Label")).toBe(two.get_theme_font("font", "Label"));
  });

  it("SystemFont 覆盖同样可撤销（走 ledger，与其它属性同口径）", () => {
    const handle = runtime.addCss(`.t { font-family: Nowhere; }`);
    const label = make(new Label(), "t");
    expect(label.has_theme_font_override("font")).toBe(true);

    runtime.removeCss(handle);
    runtime.flush();
    expect(label.has_theme_font_override("font")).toBe(false);
  });
});

describe("font-family 输出告警的情形", () => {
  it("已登记但资源加载失败：告警点名路径，不写入覆盖", () => {
    const captured = captureWarn(() => {
      runtime.addCss(`
        @font-face { font-family: "Ghost"; src: url("res://fixtures/does-not-exist.ttf"); }
        .t { font-family: Ghost; }
      `);
      const label = make(new Label(), "t");
      runtime.flush();
      expect(label.has_theme_font_override("font")).toBe(false);
    });
    expect(captured.warn.codes).toContain(CssCode.FontLoadFailed);
  });

  it("候选列表不再告警：整串均有意义，不再仅取第一个", () => {
    const captured = captureWarn(() => {
      runtime.addCss(`
        @font-face { font-family: "Fixture"; src: url("${FIXTURE}"); }
        .t { font-family: Fixture, sans-serif; }
      `);
      make(new Label(), "t");
      runtime.flush();
    });
    expect(captured.warn.warnings.join("\n")).toBe("");
  });
});

describe("字体覆盖不影响其它字体属性", () => {
  it("font-family 与 font-size 各不干扰，撤销一条不影响另一条", async () => {
    runtime.addCss(`
      @font-face { font-family: "Fixture"; src: url("${FIXTURE}"); }
      .t { font-family: Fixture; font-size: 24px; }
    `);
    const label = make(new Label(), "t");
    expect(label.has_theme_font_override("font")).toBe(true);
    expect(label.get_theme_font_size("font_size", "Label")).toBe(24);

    // 仅撤销 font-family：字号属于另一条 CSS 属性名，账本按属性名分组，不应被牵连
    runtime.removeCss(0);
    await awaitFrames(1);
    expect(label.has_theme_font_override("font")).toBe(false);
  });

  it("get_theme_font 返回的即为夹具本身", () => {
    runtime.addCss(`
      @font-face { font-family: "Fixture"; src: url("${FIXTURE}"); }
      .t { font-family: Fixture; }
    `);
    const label = make(new Label(), "t");
    const font = label.get_theme_font("font", "Label") as Font;
    expect(font).toBeInstanceOf(Font);
    expect((font as unknown as { resource_path: string }).resource_path).toBe(FIXTURE);
  });
});

/**
 * 字号是否真的改变了画面。
 *
 * 其余用例断到 `has_theme_font_size_override("font_size")` 为止。属性写对但画面没变
 * （字号被其它规则盖掉、写到了引擎不读的 item）只有读像素能发现：同一段文字，
 * 40px 画出的有色像素明显多于 20px。
 */
describe.skipIf(!isHeaded())("字号真的改变画面（有头）", () => {
  const RED: readonly [number, number, number] = [1, 0, 0];

  it("40px 比 20px 画出更多有色像素", async () => {
    runtime.addCss(`.big { color: rgb(255, 0, 0); font-size: 40px; }`);
    runtime.addCss(`.small { color: rgb(255, 0, 0); font-size: 20px; }`);

    const big = make(new Label(), "big");
    big.text = "TEXT";
    big.position = new Vector2(40, 40);
    const small = make(new Label(), "small");
    small.text = "TEXT";
    small.position = new Vector2(40, 120);
    // 控件矩形默认 0x0，给两块同样大的采样面积，两者只差在字号
    big.size = new Vector2(320, 60);
    small.size = new Vector2(320, 60);

    const screen = Screen.attach(root);
    expect(await screen.waitForColor(big, RED)).toBe(true);
    expect(await screen.waitForColor(small, RED)).toBe(true);
    expect(screen.countColor(big, RED)).toBeGreaterThan(screen.countColor(small, RED));
  });
});
