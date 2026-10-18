/**
 * 伪类在**选择器里的位置与组合形态** → 节点属性落点。
 *
 * 运行于真实引擎，断言只看节点上的主题覆盖（`has_theme_*_override` / `get_theme_*`）：
 * 「CSS 里写了」与「引擎真能读到」是两件事，后者才是判据。伪类的**驱动方式**（信号 / 属性 /
 * 手动）由 `css-pseudo.spec.ts` 负责，`:hover` 向祖先冒泡由 `css-hover-bubble.spec.ts` 负责，
 * 本文件一律假定驱动已就位，专注在「同一种状态换一种写法，落点是否还正确」。
 *
 * 落点规则（见 css 包 `itemForStates`）：一条声明写进哪个 item，由**它所在那一段要求的状态
 * ∩ 节点此刻挂着的状态**决定。`.card:hover .title` 要求的是卡片悬停（`.title` 这段没要求
 * 状态）→ 值写在 `.title` 的基 item 上；`.btn:is(:hover, :focus)` 要求两支之一，只有 focus
 * 成立时值必须落在 font_focus_color，否则引擎聚焦时读不到。
 *
 * 各类可用的状态 item 取自引擎 dump（`vocabulary.data.ts`）：
 * - `Button`：font_color / font_hover_color / font_focus_color / font_pressed_color /
 *   font_hover_pressed_color / font_disabled_color；盒 normal / hover / pressed / disabled / focus
 * - `CheckBox`：另有 hover_pressed 盒
 * - `Label`：只有 font_color（无状态变体）→ 状态声明退回基 item
 * - `PanelContainer`：只有 panel 盒
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  Button,
  CheckBox,
  HBoxContainer,
  Label,
  PanelContainer,
  VBoxContainer,
  type Control,
  type StyleBoxFlat,
} from "godot";
import { StyleRuntime } from "godot-angular/core";
import { awaitFrames, makeRenderer, resetWarnOnce } from "godot-angular/testing";

let runtime: StyleRuntime;
let root: Control;

beforeEach(() => {
  runtime = new StyleRuntime();
  root = makeRenderer().root;
  resetWarnOnce();
});

/** 挂到 parent 下并纳入级联；class 必须在 attach 之后写（attach 会替换成会通知的集合） */
function mount<T extends Control>(node: T, parent: Control, classes: string[] = []): T {
  parent.add_child(node);
  runtime.attach(node);
  for (const name of classes) (node as unknown as { cssClasses: Set<string> }).cssClasses.add(name);
  return node;
}

/** 容器 + 一个 class，返回节点本身（后代选择器的祖先侧常用） */
function panel(parent: Control, classes: string[] = []): PanelContainer {
  return mount(new PanelContainer(), parent, classes);
}

/** 立即结算本轮级联（信号驱动的状态变化需要等帧，见 `enter`） */
function settle(): void {
  runtime.flush();
}

async function enter(node: Control): Promise<void> {
  node.emit_signal("mouse_entered");
  await awaitFrames(1);
}

async function leave(node: Control): Promise<void> {
  node.emit_signal("mouse_exited");
  await awaitFrames(1);
}

async function focus(node: Control): Promise<void> {
  node.emit_signal("focus_entered");
  await awaitFrames(1);
}

async function blur(node: Control): Promise<void> {
  node.emit_signal("focus_exited");
  await awaitFrames(1);
}

async function press(node: Control): Promise<void> {
  node.emit_signal("button_down");
  await awaitFrames(1);
}

async function release(node: Control): Promise<void> {
  node.emit_signal("button_up");
  await awaitFrames(1);
}

function hasColor(node: Control, item: string): boolean {
  return node.has_theme_color_override(item);
}

/** 取 font_size 覆盖值（无状态变体，所有类都只有这一个） */
function fontSize(node: Control): number {
  return node.get_theme_font_size("font_size");
}

/** 运行中加 class：集合是 attach 时换上的会通知版本，改完等帧末结算 */
function addClass(node: Control, name: string): Promise<void> {
  (node as unknown as { cssClasses: Set<string> }).cssClasses.add(name);
  return awaitFrames(1);
}

/** 覆盖色 → "#rrggbb"：`get_theme_color` 每次返回新 Color，只能按值比较 */
function color(node: Control, item: string): string {
  const c = node.get_theme_color(item);
  const hex = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
}

function hexOf(c: { r: number; g: number; b: number }): string {
  const hex = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
}

/* ------------------------------------------------------------------ *
 * 伪类与主体并列：`x:hover`
 * ------------------------------------------------------------------ */

describe("伪类与主体并列", () => {
  it("Button:hover：状态 item 写入与撤销", async () => {
    runtime.addCss(`.btn:hover { color: rgb(255, 0, 0); }`);
    const btn = mount(new Button(), root, ["btn"]);
    settle();
    expect(hasColor(btn, "font_hover_color")).toBe(false);

    await enter(btn);
    expect(hasColor(btn, "font_hover_color")).toBe(true);
    expect(color(btn, "font_hover_color")).toBe("#ff0000");

    await leave(btn);
    expect(hasColor(btn, "font_hover_color")).toBe(false);
  });

  it("裸 :hover：不带主体的选择器命中任何悬停节点", async () => {
    runtime.addCss(`:hover { color: rgb(0, 255, 0); }`);
    const a = mount(new Label(), root);
    const b = mount(new Label(), root);
    settle();
    expect(hasColor(a, "font_color")).toBe(false);
    expect(hasColor(b, "font_color")).toBe(false);

    await enter(a);
    // 只有悬停那一个命中；同级的另一个不受牵连
    expect(color(a, "font_color")).toBe("#00ff00");
    expect(hasColor(b, "font_color")).toBe(false);
  });

  it("类型选择器 + 伪类：Button:hover 不牵连 Label", async () => {
    runtime.addCss(`Button:hover { color: rgb(1, 1, 1); }`);
    const btn = mount(new Button(), root);
    const label = mount(new Label(), root);
    settle();

    await enter(btn);
    expect(hasColor(btn, "font_hover_color")).toBe(true);
    expect(hasColor(label, "font_color")).toBe(false);
  });

  it("Label 无状态色 item：:hover 声明退回基 item（词汇表里没有就不假装）", async () => {
    runtime.addCss(`.lbl:hover { color: rgb(2, 2, 2); }`);
    const lbl = mount(new Label(), root, ["lbl"]);
    settle();
    expect(hasColor(lbl, "font_color")).toBe(false);

    await enter(lbl);
    // Label 的词汇表只有 font_color，状态变体不存在 → 写基 item，引擎悬停时读的就是它
    expect(color(lbl, "font_color")).toBe("#020202");
  });
});

/* ------------------------------------------------------------------ *
 * 伪类在祖先段：`:hover x` / `x:hover y`
 * ------------------------------------------------------------------ */

describe("伪类落在祖先段（悬停的是祖先，被样式化的是后代）", () => {
  it(".card:hover .title：祖先悬停 → 后代变色，撤销后一并撤干净", async () => {
    runtime.addCss(`.card:hover .title { color: rgb(255, 0, 0); }`);
    const card = panel(root, ["card"]);
    const title = mount(new Label(), card, ["title"]);
    settle();
    expect(hasColor(title, "font_color")).toBe(false);

    await enter(card);
    expect(color(title, "font_color")).toBe("#ff0000");

    await leave(card);
    expect(hasColor(title, "font_color")).toBe(false);
  });

  it("祖先伪类的值写在后代的基 item 上，不占用后代自己的状态 item", async () => {
    runtime.addCss(`.card:hover .title { color: rgb(255, 0, 0); }`);
    const card = panel(root, ["card"]);
    const title = mount(new Button(), card, ["title"]);
    settle();

    await enter(card);
    // 悬停的是卡片，被样式化的是按钮：值必须落在 font_color。写进 font_hover_color 的话，
    // 引擎只在「按钮自身被悬停」时才读到它，症状是悬停卡片时文字颜色不动
    expect(color(title, "font_color")).toBe("#ff0000");
    expect(hasColor(title, "font_hover_color")).toBe(false);
  });

  it("子组合器 + 祖先伪类：.card:hover > .title 只命中直接子级", async () => {
    runtime.addCss(`.card:hover > .title { color: rgb(7, 7, 7); }`);
    const card = panel(root, ["card"]);
    const direct = mount(new Label(), card, ["title"]);
    const deep = mount(new Label(), direct, ["title"]);
    settle();

    await enter(card);
    expect(color(direct, "font_color")).toBe("#070707");
    expect(hasColor(deep, "font_color")).toBe(false);
  });

  it("三层后代：.card:hover .box .title", async () => {
    runtime.addCss(`.card:hover .box .title { color: rgb(8, 8, 8); }`);
    const card = panel(root, ["card"]);
    const box = panel(card, ["box"]);
    const title = mount(new Label(), box, ["title"]);
    settle();
    expect(hasColor(title, "font_color")).toBe(false);

    await enter(card);
    expect(color(title, "font_color")).toBe("#080808");
  });

  it("祖先伪类 + 非颜色落点：.card:hover { gap } 写进容器自己的 constant", async () => {
    runtime.addCss(`.row:hover { gap: 12px; }`);
    const row = mount(new HBoxContainer(), root, ["row"]);
    settle();
    expect(row.has_theme_constant_override("separation")).toBe(false);

    await enter(row);
    expect(row.get_theme_constant("separation")).toBe(12);

    await leave(row);
    expect(row.has_theme_constant_override("separation")).toBe(false);
  });

  it("祖先伪类 + 几何：.card:hover { padding } 落在祖先的盒上，后代不受影响", async () => {
    runtime.addCss(`.card:hover { padding: 10px; }`);
    const card = panel(root, ["card"]);
    const title = mount(new Label(), card, ["title"]);
    settle();

    await enter(card);
    const box = card.get_theme_stylebox("panel") as StyleBoxFlat;
    expect(box.content_margin_top).toBe(10);
    expect(hasColor(title, "font_color")).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 伪类在主体段：`x :hover` / `x y:hover`
 * ------------------------------------------------------------------ */

describe("伪类落在主体段（被样式化的节点自己带状态）", () => {
  it(".box :hover：后代自身悬停才命中", async () => {
    runtime.addCss(`.box :hover { color: rgb(11, 12, 13); }`);
    const box = mount(new VBoxContainer(), root, ["box"]);
    const kid = mount(new Label(), box);
    const other = mount(new Label(), root);
    settle();

    await enter(kid);
    expect(color(kid, "font_color")).toBe("#0b0c0d");
    expect(hasColor(other, "font_color")).toBe(false);

    await leave(kid);
    expect(hasColor(kid, "font_color")).toBe(false);
  });

  it(".box .title:hover：class 与伪类分写两段，仍要求同一个节点同时满足", async () => {
    runtime.addCss(`.box .title:hover { color: rgb(14, 14, 14); }`);
    const box = mount(new VBoxContainer(), root, ["box"]);
    const hit = mount(new Label(), box, ["title"]);
    const noClass = mount(new Label(), box);
    const outside = mount(new Label(), root, ["title"]);
    settle();

    await enter(hit);
    expect(color(hit, "font_color")).toBe("#0e0e0e");
    expect(hasColor(noClass, "font_color")).toBe(false);
    expect(hasColor(outside, "font_color")).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 伪类 + 兄弟组合器
 * ------------------------------------------------------------------ */

describe("伪类与兄弟组合器", () => {
  it(".a:hover + .b：悬停的前一个兄弟决定后一个的样式", async () => {
    runtime.addCss(`.a:hover + .b { color: rgb(21, 21, 21); }`);
    const row = mount(new HBoxContainer(), root);
    const a = mount(new Button(), row, ["a"]);
    const b = mount(new Label(), row, ["b"]);
    const c = mount(new Label(), row, ["b"]);
    settle();

    await enter(a);
    expect(color(b, "font_color")).toBe("#151515");
    // `+` 只看紧邻的那一个：c 的前一个不是悬停的 a
    expect(hasColor(c, "font_color")).toBe(false);

    await leave(a);
    expect(hasColor(b, "font_color")).toBe(false);
  });

  it(".a:hover ~ .b：一般兄弟取后面全部", async () => {
    runtime.addCss(`.a:hover ~ .b { color: rgb(22, 22, 22); }`);
    const row = mount(new HBoxContainer(), root);
    const a = mount(new Button(), row, ["a"]);
    const b = mount(new Label(), row, ["b"]);
    const c = mount(new Label(), row, ["b"]);
    settle();

    await enter(a);
    expect(color(b, "font_color")).toBe("#161616");
    expect(color(c, "font_color")).toBe("#161616");
  });

  it("兄弟组合器的主体段带伪类：.a + .b:hover", async () => {
    runtime.addCss(`.a + .b:hover { color: rgb(23, 23, 23); }`);
    const row = mount(new HBoxContainer(), root);
    mount(new Button(), row, ["a"]);
    const b = mount(new Label(), row, ["b"]);
    settle();

    await enter(b);
    expect(color(b, "font_color")).toBe("#171717");
  });
});

/* ------------------------------------------------------------------ *
 * 多个伪类同时参与
 * ------------------------------------------------------------------ */

describe("多个伪类同时参与", () => {
  it("同节点双伪类 .b:hover:active：落点是合成 item", async () => {
    runtime.addCss(`.b:hover:active { color: rgb(31, 31, 31); }`);
    const b = mount(new Button(), root, ["b"]);
    settle();

    await enter(b);
    // 只悬停不按下：选择器整体不成立，合成 item 不该提前写
    expect(hasColor(b, "font_hover_pressed_color")).toBe(false);

    await press(b);
    expect(color(b, "font_hover_pressed_color")).toBe("#1f1f1f");
  });

  it("两个伪类分处不同节点：.card:hover .btn:active", async () => {
    runtime.addCss(`.card:hover .btn:active { color: rgb(32, 32, 32); }`);
    const card = panel(root, ["card"]);
    const btn = mount(new Button(), card, ["btn"]);
    settle();

    await enter(card);
    // 只有祖先悬停：主体段还缺 :active
    expect(hasColor(btn, "font_pressed_color")).toBe(false);

    await press(btn);
    // 主体段只要求了 active → 落点是 pressed 那一支，不是 hover_pressed
    expect(color(btn, "font_pressed_color")).toBe("#202020");
    expect(hasColor(btn, "font_hover_pressed_color")).toBe(false);
  });

  it(":not(:hover)：状态取反，进入后规则失效", async () => {
    runtime.addCss(`.n:not(:hover) { color: rgb(41, 41, 41); }`);
    const n = mount(new Label(), root, ["n"]);
    settle();
    expect(color(n, "font_color")).toBe("#292929");

    await enter(n);
    expect(hasColor(n, "font_color")).toBe(false);

    await leave(n);
    expect(color(n, "font_color")).toBe("#292929");
  });

  it(":not(.off):hover：类取反与伪类叠加", async () => {
    runtime.addCss(`.n:hover:not(.off) { color: rgb(42, 42, 42); }`);
    const on = mount(new Button(), root, ["n"]);
    const off = mount(new Button(), root, ["n", "off"]);
    settle();

    await enter(on);
    await enter(off);
    expect(hasColor(on, "font_hover_color")).toBe(true);
    expect(hasColor(off, "font_hover_color")).toBe(false);
  });

  it(":is(:hover, :focus)：值写进此刻真正成立的那支状态 item", async () => {
    runtime.addCss(`.i:is(:hover, :focus) { color: rgb(43, 43, 43); }`);
    const i = mount(new Button(), root, ["i"]);
    settle();
    expect(hasColor(i, "font_hover_color")).toBe(false);
    expect(hasColor(i, "font_focus_color")).toBe(false);

    // 只成立 focus：引擎聚焦时读 font_focus_color，值写去 hover 支就是“鼠标能用、键盘没反应”
    await focus(i);
    expect(hasColor(i, "font_focus_color")).toBe(true);
    expect(hasColor(i, "font_hover_color")).toBe(false);

    // 再悬停：两支都成立，按优先级归 hover 支，focus 支要清掉
    await enter(i);
    expect(hasColor(i, "font_hover_color")).toBe(true);
    expect(hasColor(i, "font_focus_color")).toBe(false);

    // 移出：回到 focus 支，不能停在 hover 支上
    await leave(i);
    expect(hasColor(i, "font_focus_color")).toBe(true);
    expect(hasColor(i, "font_hover_color")).toBe(false);

    await blur(i);
    expect(hasColor(i, "font_focus_color")).toBe(false);
  });

  it(":is(:hover, :checked)：勾选与悬停各写各的 item", async () => {
    runtime.addCss(`.c:is(:hover, :checked) { color: rgb(44, 44, 44); }`);
    const c = mount(new CheckBox(), root, ["c"]);
    settle();

    // 只勾选：引擎在 pressed 画法下读 font_pressed_color
    c.button_pressed = true;
    c.emit_signal("toggled", true);
    await awaitFrames(1);
    expect(hasColor(c, "font_pressed_color")).toBe(true);
    expect(hasColor(c, "font_hover_pressed_color")).toBe(false);

    // 勾选 + 悬停：引擎读合成 item
    await enter(c);
    expect(hasColor(c, "font_hover_pressed_color")).toBe(true);
    expect(hasColor(c, "font_pressed_color")).toBe(false);

    await leave(c);
    expect(hasColor(c, "font_pressed_color")).toBe(true);
    expect(hasColor(c, "font_hover_pressed_color")).toBe(false);
  });

  it(":where(:hover)：特异度归零，与基规则打平时由源码顺序决定", async () => {
    runtime.addCss(`.w { color: rgb(50, 50, 50); }`);
    runtime.addCss(`.w:where(:hover) { color: rgb(60, 60, 60); }`);
    const w = mount(new Label(), root, ["w"]);
    settle();
    expect(color(w, "font_color")).toBe("#323232");

    await enter(w);
    // `:where()` 不贡献特异度，两条规则同为 0,1,0 → 在后的那条赢
    expect(color(w, "font_color")).toBe("#3c3c3c");
  });

  it("选择器列表里各段独立：.a:hover, .b:focus 各写各的落点", async () => {
    runtime.addCss(`.a:hover, .b:focus { color: rgb(70, 70, 70); }`);
    const a = mount(new Button(), root, ["a"]);
    const b = mount(new Button(), root, ["b"]);
    settle();

    await enter(a);
    expect(color(a, "font_hover_color")).toBe("#464646");
    expect(hasColor(b, "font_focus_color")).toBe(false);

    await focus(b);
    expect(color(b, "font_focus_color")).toBe("#464646");
  });
});

/* ------------------------------------------------------------------ *
 * 特异度与状态伪类的交叉
 * ------------------------------------------------------------------ */

describe("特异度与伪类交叉", () => {
  it(":hover 与 .class 特异度打平：各写各的 item，互不顶掉", async () => {
    runtime.addCss(`.x:hover { color: rgb(80, 80, 80); }`);
    runtime.addCss(`.x.on { color: rgb(90, 90, 90); }`);
    const x = mount(new Button(), root, ["x", "on"]);
    settle();
    expect(color(x, "font_color")).toBe("#5a5a5a");

    await enter(x);
    // 两条同为 0,2,0，但各自落在自己的 item 上：悬停色写 font_hover_color，基色不动
    expect(color(x, "font_hover_color")).toBe("#505050");
    expect(color(x, "font_color")).toBe("#5a5a5a");
  });

  it("类无状态 item 时（Label）：两条声明抢同一个 font_color，按级联顺序定输赢", async () => {
    runtime.addCss(`.x:hover { color: rgb(80, 80, 80); }`); // 0,2,0 在前
    runtime.addCss(`.x.on { color: rgb(90, 90, 90); }`); // 0,2,0 在后 → 它赢
    const x = mount(new Label(), root, ["x", "on"]);
    settle();
    expect(color(x, "font_color")).toBe("#5a5a5a");

    // Label 没有 font_hover_color，两条声明都落在 font_color 上。悬停不能把源码在后的那条压过去；
    // 退出后基值同样必须回来，不能残留悬停色
    await enter(x);
    expect(color(x, "font_color")).toBe("#5a5a5a");
    await leave(x);
    expect(color(x, "font_color")).toBe("#5a5a5a");
  });

  it("状态槽压不外特异度更高的基规则（Label 无状态 item）", async () => {
    runtime.addCss(`.x:hover { color: rgb(80, 80, 80); }`); // 0,2,0
    runtime.addCss(`.x.on.hi { color: rgb(90, 90, 90); }`); // 0,3,0
    const x = mount(new Label(), root, ["x", "on", "hi"]);
    settle();
    expect(color(x, "font_color")).toBe("#5a5a5a");

    await enter(x);
    expect(color(x, "font_color")).toBe("#5a5a5a");
  });

  it("font-size 全类无状态变体：展开的按钮悬停时字号不被悬停规则压回去", async () => {
    runtime.addCss(`.m { font-size: 14px; }`);
    runtime.addCss(`.m:hover { font-size: 18px; }`);
    runtime.addCss(`.m.open { font-size: 20px; }`);
    const m = mount(new Button(), root, ["m"]);
    settle();
    expect(fontSize(m)).toBe(14);

    await enter(m);
    expect(fontSize(m)).toBe(18);
    await leave(m);

    await addClass(m, "open");
    expect(fontSize(m)).toBe(20);

    // `.m.open` 与 `.m:hover` 同为 0,2,0 且源码在后 → 展开态的字号不能被悬停压回去
    await enter(m);
    expect(fontSize(m)).toBe(20);
  });

  it("同为 :hover 的两条规则特异度打平：源码在后者赢", async () => {
    runtime.addCss(`.x:hover { color: rgb(80, 80, 80); }`);
    runtime.addCss(`.y:hover { color: rgb(90, 90, 90); }`);
    const x = mount(new Button(), root, ["x", "y"]);
    settle();

    await enter(x);
    // 两条同为 0,2,0 且都要求 hover → 同一个落点，源码在后的那条赢
    expect(color(x, "font_hover_color")).toBe("#5a5a5a");
  });

  it("伪类叠加 class 提高特异度：.x:hover.on 压过 .x:hover", async () => {
    runtime.addCss(`.x:hover { color: rgb(80, 80, 80); }`);
    runtime.addCss(`.x:hover.on { color: rgb(100, 100, 100); }`);
    const x = mount(new Label(), root, ["x", "on"]);
    settle();

    await enter(x);
    expect(color(x, "font_color")).toBe("#646464");
  });
});

/* ------------------------------------------------------------------ *
 * 状态伪类与盒（stylebox）
 * ------------------------------------------------------------------ */

describe("伪类与 stylebox 落点", () => {
  it("Button:hover 换底色：写 hover 盒，normal 盒保持", async () => {
    runtime.addCss(`.btn { background-color: rgb(1, 1, 1); }`);
    runtime.addCss(`.btn:hover { background-color: rgb(2, 2, 2); }`);
    const btn = mount(new Button(), root, ["btn"]);
    settle();
    expect(hexOf((btn.get_theme_stylebox("normal") as StyleBoxFlat).bg_color)).toBe("#010101");

    await enter(btn);
    expect(hexOf((btn.get_theme_stylebox("hover") as StyleBoxFlat).bg_color)).toBe("#020202");
    // normal 盒是引擎在非悬停态读的，不该被悬停规则改写
    expect(hexOf((btn.get_theme_stylebox("normal") as StyleBoxFlat).bg_color)).toBe("#010101");
  });

  it("PanelContainer 只有一个盒：.card:hover 复用 panel，退出后还原", async () => {
    runtime.addCss(`.card { background-color: rgb(200, 200, 200); }`);
    runtime.addCss(`.card:hover { background-color: rgb(210, 210, 210); }`);
    const card = panel(root, ["card"]);
    settle();
    expect(hexOf((card.get_theme_stylebox("panel") as StyleBoxFlat).bg_color)).toBe("#c8c8c8");

    await enter(card);
    expect(hexOf((card.get_theme_stylebox("panel") as StyleBoxFlat).bg_color)).toBe("#d2d2d2");

    await leave(card);
    expect(hexOf((card.get_theme_stylebox("panel") as StyleBoxFlat).bg_color)).toBe("#c8c8c8");
  });

  it("CheckBox:hover:checked 写合成盒 hover_pressed", async () => {
    runtime.addCss(`.cb:hover:checked { background-color: rgb(30, 30, 30); }`);
    const cb = mount(new CheckBox(), root, ["cb"]);
    settle();
    expect(cb.has_theme_stylebox_override("hover_pressed")).toBe(false);

    cb.button_pressed = true;
    cb.emit_signal("toggled", true);
    await enter(cb);
    expect(hexOf((cb.get_theme_stylebox("hover_pressed") as StyleBoxFlat).bg_color)).toBe("#1e1e1e");
  });

  it("祖先伪类 + 后代盒：.card:hover .box { background-color }", async () => {
    runtime.addCss(`.card:hover .box { background-color: rgb(40, 40, 40); }`);
    const card = panel(root, ["card"]);
    const box = panel(card, ["box"]);
    settle();
    expect(box.has_theme_stylebox_override("panel")).toBe(false);

    await enter(card);
    expect(hexOf((box.get_theme_stylebox("panel") as StyleBoxFlat).bg_color)).toBe("#282828");
  });
});
