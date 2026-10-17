import { beforeEach, describe, expect, it } from "vitest";
import { Button, CheckBox, GridContainer, HBoxContainer, Label, LineEdit, MarginContainer, PanelContainer, VBoxContainer } from "godot";
import { StyleRuntime } from "godot-angular/core";
import { SUPPORTED_PSEUDO_CLASSES, cssPropertyNames } from "godot-angular/css";
import { awaitFrames, captureWarn, makeRenderer, resetWarnOnce } from "godot-angular/testing";

let runtime: StyleRuntime;
let root: any;

beforeEach(() => {
  runtime = new StyleRuntime();
  root = makeRenderer().root;
  resetWarnOnce();
});

/**
 * 一条规则配一个节点：返回 [节点, 告警]。
 *
 * 告警分为两个窗口：样式表级的（选择器不合法、shorthand 值数不对）在 addCss 时发出，
 * 属性级的（值无法解析、节点没有这个落点）在 flush 时发出。只覆盖一个窗口会漏掉一半。
 */
function apply(css: string, make: () => any): [any, string[]] {
  // 每个用例一套独立级联：共用 runtime 会将历次 `.s { … }` 叠加在同一批节点上，
  // 前一个用例的声明会混进后一个用例的告警中
  const local = new StyleRuntime();
  const host = makeRenderer().root;
  const node = make();
  host.add_child(node);
  local.attach(node);
  node.cssClasses.add("s");
  const onAdd = captureWarn(() => local.addCss(`.s { ${css} }`));
  const onFlush = captureWarn(() => local.flush());
  return [node, [...onAdd.warn.warnings, ...onFlush.warn.warnings]];
}

/** 整张样式表版本：选择器由调用方自行编写 */
function sheet(css: string, make: () => any): [any, string[]] {
  const local = new StyleRuntime();
  const node = make();
  makeRenderer().root.add_child(node);
  local.attach(node);
  node.cssClasses.add("s");
  const onAdd2 = captureWarn(() => local.addCss(css));
  const onFlush2 = captureWarn(() => local.flush());
  return [node, [...onAdd2.warn.warnings, ...onFlush2.warn.warnings]];
}

/** cssClasses 是 attach 时挂载的，Godot 的类型表中没有这个字段 */
function withClass(node: unknown, cls: string): void {
  (node as { cssClasses: Set<string> }).cssClasses.add(cls);
}

/** 有落点的属性：值 → 应使用哪种节点 */
const LANDED: Array<[property: string, value: string, make: () => any]> = [
  ["color", "rgb(10, 20, 30)", () => new Label()],
  ["font-size", "14px", () => new Label()],
  ["opacity", "0.5", () => new Label()],
  ["visibility", "hidden", () => new Label()],
  ["text-align", "center", () => new Label()],
  ["min-width", "40px", () => new Label()],
  ["min-height", "20px", () => new Label()],
  ["flex", "1", () => new Label()],
  ["flex-grow", "2", () => new Label()],
  ["background-color", "rgb(1, 2, 3)", () => new PanelContainer()],
  ["background", "rgb(1, 2, 3)", () => new PanelContainer()],
  ["border-color", "rgb(1, 2, 3)", () => new PanelContainer()],
  ["border-top-width", "2px", () => new PanelContainer()],
  ["border-right-width", "2px", () => new PanelContainer()],
  ["border-bottom-width", "2px", () => new PanelContainer()],
  ["border-left-width", "2px", () => new PanelContainer()],
  ["border-top-left-radius", "3px", () => new PanelContainer()],
  ["border-top-right-radius", "3px", () => new PanelContainer()],
  ["border-bottom-left-radius", "3px", () => new PanelContainer()],
  ["border-bottom-right-radius", "3px", () => new PanelContainer()],
  ["box-shadow", "2px 2px 4px rgb(0, 0, 0)", () => new PanelContainer()],
  ["padding", "4px", () => new PanelContainer()],
  ["padding-top", "4px", () => new PanelContainer()],
  ["padding-right", "4px", () => new PanelContainer()],
  ["padding-bottom", "4px", () => new PanelContainer()],
  ["padding-left", "4px", () => new PanelContainer()],
  ["margin", "4px", () => new MarginContainer()],
  ["margin-top", "4px", () => new MarginContainer()],
  ["margin-right", "4px", () => new MarginContainer()],
  ["margin-bottom", "4px", () => new MarginContainer()],
  ["margin-left", "4px", () => new MarginContainer()],
  ["gap", "8px", () => new VBoxContainer()],
  ["gap", "8px 12px", () => new GridContainer()],
  ["row-gap", "8px", () => new GridContainer()],
  ["column-gap", "8px", () => new GridContainer()],
  ["justify-content", "center", () => new HBoxContainer()],
  ["caret-color", "red", () => new LineEdit()],
  ["cursor", "pointer", () => new Label()],
  ["text-overflow", "ellipsis", () => new Label()],
  ["overflow", "hidden", () => new PanelContainer()],
  ["text-shadow", "2px 3px red", () => new Label()],
  ["white-space", "nowrap", () => new Label()],
  ["direction", "rtl", () => new Label()],
];

/**
 * 有落点但不等价：写入生效，同时输出说明（Godot 的 StyleBoxFlat 四边同色）。
 * 若静默按单边生效，比不写入更难排查。
 */
const LANDED_WITH_WARNING: Array<[property: string, value: string, make: () => any]> = [
  ["border-top-color", "red", () => new PanelContainer()],
  ["border-right-color", "red", () => new PanelContainer()],
  ["border-bottom-color", "red", () => new PanelContainer()],
  ["border-left-color", "red", () => new PanelContainer()],
  ["pointer-events", "none", () => new Label()],
];

/** 明确知道没有落点的属性：必须发出提示，不能静默吞掉 */
const IGNORED: Array<[property: string, value: string]> = [
  ["display", "flex"],
  ["flex-direction", "row"],
  ["flex-wrap", "wrap"],
  ["flex-basis", "10px"],
  ["flex-shrink", "1"],
  ["align-items", "center"],
  ["align-self", "center"],
  ["align-content", "center"],
  ["justify-items", "center"],
  ["order", "2"],
  ["aspect-ratio", "1"],
  ["max-width", "10px"],
  ["max-height", "10px"],
  ["width", "40px"],
  ["height", "20px"],
  ["box-sizing", "border-box"],
  ["writing-mode", "vertical-rl"],
  ["filter", "blur(2px)"],
  ["backdrop-filter", "blur(2px)"],
  ["will-change", "transform"],
  ["content", "\"x\""],
  ["flex-flow", "row wrap"],
  ["position", "relative"],
  ["inset", "1px"],
  ["outline", "1px solid red"],
  ["top", "1px"],
  ["right", "1px"],
  ["bottom", "1px"],
  ["left", "1px"],
  ["float", "left"],
  ["grid", "1px 1px"],
  ["grid-template-columns", "1px 1px"],
  ["font-weight", "bold"],
  ["font-style", "italic"],
  ["line-height", "1.5"],
  ["letter-spacing", "1px"],
  ["word-spacing", "1px"],
  ["text-decoration", "underline"],
  ["text-transform", "uppercase"],
  ["transform", "translate(1px)"],
  ["transition", "color 1s"],
  ["animation", "spin 1s"],
  ["animation-name", "spin"],
  ["z-index", "2"],
  ["overflow", "auto"],
  ["user-select", "none"],
];

/**
 * 需要额外上下文才能落点的属性：仅一条 `.s { … }` 无法判定。
 *
 * `font-family` 需先存于 `@font-face` 登记才能解析到资源，登记本身不是声明，
 * 无法纳入上述三张表。其真正的落点取证位于 css-font.spec.ts，列于此仅为满足
 * 「新增属性必须登记」这一项护栏，不得将其作为「未测试」的推据。
 */
const NEEDS_CONTEXT: Array<[property: string, value: string]> = [
  ["font-family", "Fixture"],
  ["background-image", 'url("res://fixtures/css-texture-fixture.tres")'],
];

describe("属性全表", () => {
  it("有落点的每个都过一遍：不许出声", () => {
    for (const [property, value, make] of LANDED) {
      const [, warnings] = apply(`${property}: ${value}`, make);
      expect(warnings, `${property}: ${value}`).toEqual([]);
    }
  });

  it("有落点但不等价的属性：写入生效，且输出说明", () => {
    for (const [property, value, make] of LANDED_WITH_WARNING) {
      const [, warnings] = apply(`${property}: ${value}`, make);
      expect(warnings.length, `${property}: ${value} 该告警`).toBeGreaterThan(0);
    }
  });

  it("无落点的每个都出声说明为什么", () => {
    for (const [property, value] of IGNORED) {
      const [, warnings] = apply(`${property}: ${value}`, () => new Label());
      expect(warnings.length, `${property}: ${value} 该告警`).toBeGreaterThan(0);
    }
  });

  it("属性表没被偷偷加东西：新增的属性必须进上面三张表之一", () => {
    const listed = new Set([
      ...LANDED.map(([p]) => p),
      ...LANDED_WITH_WARNING.map(([p]) => p),
      ...IGNORED.map(([p]) => p),
      ...NEEDS_CONTEXT.map(([p]) => p),
    ]);
    const unlisted = cssPropertyNames().filter((n) => !listed.has(n));
    expect(unlisted, "这些属性还没进扫表").toEqual([]);
  });

  it("边框：宽度分四边，颜色只能整圈（Godot 的 StyleBoxFlat 如此）", () => {
    const [box, warnings] = apply("border: 2px solid rgb(1, 2, 3)", () => new PanelContainer());
    expect(warnings).toEqual([]);
    const style = box.get_theme_stylebox("panel") as any;
    expect(style.border_width_top).toBe(2);
    expect(style.border_width_left).toBe(2);
    expect(style.border_color.r).toBeCloseTo(1 / 255, 4);

    // 单边带颜色：宽度只修改一边，颜色必须发出提示（它无法只染一边）
    const [, sideWarn] = apply("border-top: 3px solid red", () => new PanelContainer());
    expect(sideWarn.join(" ")).toContain("四边同色");
  });
});

describe("颜色", () => {
  it("深测一种：#ff8000 的分量真的对上", () => {
    const [node] = apply("color: #ff8000", () => new Label());
    const c = node.get_theme_color("font_color");
    expect(Math.round(c.r * 255)).toBe(255);
    expect(Math.round(c.g * 255)).toBe(128);
    expect(Math.round(c.b * 255)).toBe(0);
    expect(c.a).toBe(1);
  });

  it("其余记法各来一个：写进去了、分量在 [0,1] 就算过", () => {
    const notations = [
      "#fff",
      "#ffffffff",
      "#ffff",
      "#f0f8",
      "#ffffff80",
      "rgb(255, 0, 128)",
      "rgb(255 0 128)",
      "rgba(255, 0, 128, 0.5)",
      "rgba(255, 0, 128, 50%)",
      "rgb(100%, 0%, 50%)",
      "hsl(120, 50%, 50%)",
      "hsla(120, 50%, 50%, .25)",
      "hsl(120 50% 50% / 25%)",
      "hwb(120, 30%, 30%)",
      "hwb(120 30% 30% / 50%)",
      "transparent",
      "red",
      "rebeccapurple",
      "aliceblue",
      "mintcream",
    ];
    for (const text of notations) {
      const [node, warnings] = apply(`color: ${text}`, () => new Label());
      expect(warnings, text).toEqual([]);
      expect(node.has_theme_color_override("font_color"), text).toBe(true);
      const c = node.get_theme_color("font_color");
      for (const part of [c.r, c.g, c.b, c.a]) {
        expect(Number.isFinite(part) && part >= 0 && part <= 1, `${text} 分量 ${part}`).toBe(true);
      }
    }
  });

  it("认不出的颜色要出声，且不许留下半个值", () => {
    for (const text of ["notacolor", "#12", "#gg0000", "rgb(1,2)", "hsl(1 2)", "rgb()"]) {
      const [node, warnings] = apply(`color: ${text}`, () => new Label());
      expect(warnings.length, text).toBeGreaterThan(0);
      expect(node.has_theme_color_override("font_color"), text).toBe(false);
    }
  });
});

describe("长度与四边", () => {
  it("深测一种：margin 四值分别落到 margin_*", () => {
    const [node] = apply("margin: 1px 2px 3px 4px", () => new MarginContainer());
    expect(node.get_theme_constant("margin_top")).toBe(1);
    expect(node.get_theme_constant("margin_right")).toBe(2);
    expect(node.get_theme_constant("margin_bottom")).toBe(3);
    expect(node.get_theme_constant("margin_left")).toBe(4);
  });

  it("单值 margin 是四边，不是只有某一边", () => {
    const [node] = apply("margin: 8px", () => new MarginContainer());
    for (const side of ["top", "right", "bottom", "left"]) {
      expect(node.get_theme_constant(`margin_${side}`), side).toBe(8);
    }
  });

  it("longhand 只改自己那一侧，不许把别侧清零", () => {
    const [node] = apply("margin: 8px; margin-top: 5px", () => new MarginContainer());
    expect(node.get_theme_constant("margin_top")).toBe(5);
    expect(node.get_theme_constant("margin_right")).toBe(8);
  });

  it("padding 走 StyleBox 的 content_margin，四值各归各位", () => {
    const [node] = apply("padding: 1px 2px 3px 4px", () => new PanelContainer());
    const box = node.get_theme_stylebox("panel") as any;
    expect(box.content_margin_top).toBe(1);
    expect(box.content_margin_right).toBe(2);
    expect(box.content_margin_bottom).toBe(3);
    expect(box.content_margin_left).toBe(4);
  });

  it("1–4 个值都能拆，第 5 个值要出声", () => {
    for (const value of ["4px", "4px 6px", "4px 6px 8px", "4px 6px 8px 10px"]) {
      const [, warnings] = apply(`margin: ${value}`, () => new MarginContainer());
      expect(warnings, value).toEqual([]);
    }
    const [, warnings] = apply("margin: 1px 2px 3px 4px 5px", () => new MarginContainer());
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("单位：px 与 0 收，百分比 / em / calc 要出声", () => {
    for (const value of ["12px", "0"]) {
      const [, warnings] = apply(`min-width: ${value}`, () => new Label());
      expect(warnings, value).toEqual([]);
    }
    for (const value of ["50%", "2em", "2rem", "calc(1px + 2px)", "abc", "12px 12px"]) {
      const [, warnings] = apply(`min-width: ${value}`, () => new Label());
      expect(warnings.length, value).toBeGreaterThan(0);
    }
  });

  it("百分比一律不落地，不得被当成像素", () => {
    // 此前的行为：`50%` 被当作 50 像素静默生效。Godot 的落点均为像素，且无可参照的
    // 父盒，百分比只能输出告警并忽略，不得推测
    const [padding] = apply("padding: 50%", () => new PanelContainer());
    expect(padding.has_theme_stylebox_override("panel")).toBe(false);

    const [radius] = apply("border-top-left-radius: 50%", () => new PanelContainer());
    expect(radius.has_theme_stylebox_override("panel")).toBe(false);

    const [font] = apply("font-size: 50%", () => new Label());
    expect(font.has_theme_font_size_override("font_size")).toBe(false);

    const [alpha] = apply("opacity: 50%", () => new Label());
    expect(alpha.modulate.a).toBe(1);

    const [grow] = apply("flex-grow: 50%", () => new Label());
    // 未生效时必须停在引擎默认值上：stretch_ratio 的默认是 1，不是 0
    expect(grow.size_flags_stretch_ratio).toBe(1);

    const [gap] = apply("gap: 50%", () => new HBoxContainer());
    expect(gap.has_theme_constant_override("separation")).toBe(false);
  });

  it("百分比的告警需写明为百分比，而非笼统的解析失败", () => {
    const cases: Array<[string, () => any]> = [
      ["padding: 50%", () => new PanelContainer()],
      ["font-size: 50%", () => new Label()],
      ["opacity: 50%", () => new Label()],
      ["flex-grow: 50%", () => new Label()],
      ["gap: 50%", () => new HBoxContainer()],
      ["min-width: 50%", () => new Label()],
    ];
    for (const [css, make] of cases) {
      const [, warnings] = apply(css, make);
      expect(warnings.join("\n"), css).toContain("百分比");
    }
  });

  it("像素与无单位数字仍正常落地", () => {
    const [node] = apply("padding: 8px; font-size: 12; opacity: .5", () => new Label());
    const box = node.get_theme_stylebox("normal") as any;
    expect(box.content_margin_left).toBe(8);
    expect(node.get_theme_font_size("font_size")).toBe(12);
    expect(node.modulate.a).toBe(0.5);
  });
});

describe("盒阴影与背景", () => {
  it("深测一种：box-shadow 落成 StyleBoxFlat 的 shadow_*", () => {
    const [node] = apply("box-shadow: 2px 3px 4px rgb(0, 0, 0)", () => new PanelContainer());
    const box = node.get_theme_stylebox("panel") as any;
    expect(box.shadow_offset.x).toBe(2);
    expect(box.shadow_offset.y).toBe(3);
    expect(box.shadow_size).toBe(4);
  });

  it("其余写法各来一个：不出声就算过", () => {
    for (const value of ["2px 2px", "2px 2px 4px red", "none"]) {
      const [, warnings] = apply(`box-shadow: ${value}`, () => new PanelContainer());
      expect(warnings, value).toEqual([]);
    }
  });

  it("Godot 没有的东西要明说：内阴影按外阴影处理、spread 无落点、多层仅取第一层", () => {
    const [, inset] = apply("box-shadow: inset 1px 1px 2px red", () => new PanelContainer());
    expect(inset.join(" ")).toContain("inset");
    const [, spread] = apply("box-shadow: 1px 1px 2px 3px red", () => new PanelContainer());
    expect(spread.join(" ")).toContain("spread");
    const [, multi] = apply("box-shadow: 1px 1px red, 2px 2px 3px blue", () => new PanelContainer());
    expect(multi.join(" ")).toContain("仅取第一层");
  });

  it("background 的几种写法与 background-color 走同一条落点", () => {
    for (const value of ["rgb(1, 2, 3)", "#fff", "transparent", "none"]) {
      const [, warnings] = apply(`background: ${value}`, () => new PanelContainer());
      expect(warnings, value).toEqual([]);
    }
  });
});

describe("选择器", () => {
  const CASES: Array<[selector: string, target: "label" | "button" | "both"]> = [
    ["Label", "label"],
    [".a", "label"],
    ["Label.a", "label"],
    ["VBoxContainer Label", "label"],
    ["VBoxContainer > Label", "label"],
    ["VBoxContainer > Button", "button"],
    ["VBoxContainer Button", "button"],
    ["Label:not(.zzz)", "label"],
    ["Label, Button", "both"],
    ["Button:not(.a)", "button"],
  ];

  it("常见选择器各命中一次（写进去才算命中）", () => {
    for (const [selector, which] of CASES) {
      const local = new StyleRuntime();
      const box = new VBoxContainer();
      const label = new Label();
      const button = new Button();
      box.add_child(label);
      box.add_child(button);
      root.add_child(box);
      local.attach(box);
      local.attach(label);
      local.attach(button);
      withClass(label, "a");
      local.addCss(`${selector} { color: rgb(9, 9, 9); }`);
      const { warn } = captureWarn(() => local.flush());
      expect(warn.warnings, selector).toEqual([]);
      const hit = (node: any) => node.has_theme_color_override("font_color");
      if (which === "both") expect(hit(label) && hit(button), selector).toBe(true);
      else if (which === "label") expect(hit(label) && !hit(button), selector).toBe(true);
      else expect(!hit(label) && hit(button), selector).toBe(true);
    }
  });

  it("兄弟组合符：+ 看紧邻前一个，~ 看任意前面的", () => {
    // selector.ts 的 previousSibling 需要父节点暴露 getChildIndex / getChildAt /
    // getChildrenCount，这三个是 StyleRuntime.attach 时挂载的（Godot 只有
    // get_index / get_child / get_child_count）
    for (const [selector, expectHit] of [
      ["Label + Button", true],
      ["Label ~ Button", true],
      ["Button + Label", false], // Label 前面是容器开头，没有 Button
      ["VBoxContainer > Label + Button", true],
    ] as Array<[string, boolean]>) {
      const local = new StyleRuntime();
      const box = new VBoxContainer();
      const label = new Label();
      const button = new Button();
      box.add_child(label);
      box.add_child(button);
      root.add_child(box);
      local.addCss(`${selector} { color: rgb(9, 9, 9); }`);
      local.attach(box);
      local.attach(label);
      local.attach(button);
      const { warn } = captureWarn(() => local.flush());
      expect(warn.warnings, selector).toEqual([]);
      expect(button.has_theme_color_override("font_color"), selector).toBe(expectHit);
    }
  });

  it("伪类表里每个都能命中：Label 无状态变体，统一落 font_color", async () => {
    const pseudo = [...SUPPORTED_PSEUDO_CLASSES];
    expect(pseudo.length).toBeGreaterThan(6);
    for (const name of pseudo) {
      const local = new StyleRuntime();
      const label = new Label();
      root.add_child(label);
      // addCss 需要在 attach 之前：伪类的信号绑定是 attach 时按“表中使用了哪些”建立的
      const onAdd = captureWarn(() => local.addCss(`.s:${name} { color: rgb(8, 8, 8); }`));
      local.attach(label);
      withClass(label, "s");
      local.flush();
      expect(label.has_theme_color_override("font_color"), `:${name} 不该自己生效`).toBe(false);
      // 没有推送通道的那几个（:disabled / :valid …）使用这个手动通道，而不是假装可以自动
      local.setPseudoClass(label, name, true);
      await awaitFrames(1);
      expect(label.has_theme_color_override("font_color"), `:${name} 驱动后应命中`).toBe(true);
      local.setPseudoClass(label, name, false);
      await awaitFrames(1);
      expect(label.has_theme_color_override("font_color"), `:${name} 关掉要撤干净`).toBe(false);
      // 告警只允许是“没有推送通道”那一句，其余一律计为回归
      for (const message of onAdd.warn.warnings) expect(message, name).toContain("不会自动生效");
    }
  });

  it("有推送通道的伪类：信号真能驱动它", async () => {
    runtime.addCss(".s:hover { color: rgb(8, 8, 8); }");
    const hover = new Button();
    root.add_child(hover);
    runtime.attach(hover);
    withClass(hover, "s");
    runtime.flush();
    hover.emit_signal("mouse_entered");
    await awaitFrames(1);
    // 引擎 hover 时读取的是 font_hover_color，写 font_color 不会显示
    expect(hover.has_theme_color_override("font_hover_color")).toBe(true);
    hover.emit_signal("mouse_exited");
    await awaitFrames(1);
    expect(hover.has_theme_color_override("font_hover_color")).toBe(false);

    runtime.addCss(".t:checked { color: rgb(9, 9, 9); }");
    const checked = new CheckBox();
    root.add_child(checked);
    runtime.attach(checked);
    withClass(checked, "t");
    runtime.flush();
    checked.button_pressed = true;
    checked.emit_signal("toggled", true);
    await awaitFrames(1);
    // 勾选态引擎读的是 font_pressed_color（开关控件的 pressed 就是“已勾选”），写 font_color 不会显示
    expect(checked.has_theme_color_override("font_pressed_color")).toBe(true);
    expect(checked.has_theme_color_override("font_color")).toBe(false);
  });

  it("无法识别的伪类 / 伪元素使整条规则失效并输出告警", () => {
    // 告警在 addCss 那一刻发出（不是 flush）：此处必须将两个窗口都覆盖
    for (const selector of ["Label:hoverry", "Label::before", "Label:nth-child(2)"]) {
      const local = new StyleRuntime();
      const label = new Label();
      root.add_child(label);
      local.attach(label);
      const onAdd = captureWarn(() => local.addCss(`${selector} { color: rgb(7, 7, 7); }`));
      const onFlush = captureWarn(() => local.flush());
      expect(onAdd.warn.count + onFlush.warn.count, selector).toBeGreaterThan(0);
      expect(label.has_theme_color_override("font_color"), selector).toBe(false);
    }
  });
});

describe("样式表本身", () => {
  it("注释、!important、自定义属性、空规则、@media 都能过", () => {
    const css = `
      /* 头部注释 */
      .s { /* 行内注释 */ color: rgb(3, 3, 3) !important; }
      .s { --brand: rgb(4, 4, 4); }
      .empty { }
      @media (min-width: 1px) { .s { font-size: 13px; } }
    `;
    const [node, warnings] = sheet(css, () => new Label());
    expect(warnings).toEqual([]);
    expect(node.get_theme_color("font_color").r).toBeGreaterThan(0);
  });

  it("var() 展开成真实值，取不到又没兜底要出声", () => {
    const [node, warnings] = sheet(`.s { --c: rgb(6, 6, 6); color: var(--c); }`, () => new Label());
    expect(warnings).toEqual([]);
    expect(node.has_theme_color_override("font_color")).toBe(true);

    const [, missing] = apply("color: var(--nope)", () => new Label());
    expect(missing.join(" ")).toContain("var(--nope)");
  });

  it("值解析不了要出声；结构烂掉是静默丢弃（解析器故意宽松）", () => {
    // 结构问题（未闭合、多余右括号、缺值）整条丢弃且不提示：宽松是故意的，
    // 但值无法识别时必须说明，否则“写了没效果”难以定位
    const [, bad] = apply("color: rgb(1,1,1", () => new Label());
    expect(bad.length).toBeGreaterThan(0);
    for (const css of [".s { color: rgb(1,1,1)", "} .s { color: rgb(1,1,1); }", ".s { color: }", "@media {"]) {
      const [node] = sheet(css, () => new Label());
      expect(node.has_theme_color_override("font_color"), css).toBe(false);
    }
  });

  it("落点不成立的组合要出声：margin 落在 Label 上、text-align 落在 PanelContainer 上", () => {
    const [, margin] = apply("margin: 4px", () => new Label());
    expect(margin.join(" ")).toContain("MarginContainer");
    const [, align] = apply("text-align: center", () => new PanelContainer());
    expect(align.join(" ")).toContain("horizontal_alignment");
  });
});

describe("表单类节点", () => {
  it("同一批属性在 Button / CheckBox 上也走通", () => {
    for (const make of [() => new Button(), () => new CheckBox()]) {
      for (const [property, value] of [
        ["color", "rgb(1, 2, 3)"],
        ["font-size", "13px"],
        ["padding", "3px"],
        ["border-top-width", "1px"],
      ]) {
        const [, warnings] = apply(`${property}: ${value}`, make);
        expect(warnings, `${make().get_class()} ${property}`).toEqual([]);
      }
    }
  });
});
