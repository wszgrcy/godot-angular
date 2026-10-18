/**
 * CSS 属性 → theme item 的**落点存在性**与**共用 item 时的撤销粒度**。
 *
 * 运行于真实引擎，判据仍是节点上的主题覆盖。本文件盯的是级联中间抽象与引擎真实读取之间
 * 剩下的那几处错位：
 *
 * 1. 默认主题的 item 表按 theme type 分栏，`LinkButton` 那一栏没有 `font_disabled_color`（它的
 *    父类是 `BaseButton`，画法也不走 `Button`）。但「默认主题没登记」不等于「不可用」：文档把
 *    `LinkButton.font_disabled_color` 列为它的 theme item（默认值 `Color(0, 0, 0, 1)`，与节点解析
 *    结果一致），因此覆盖它有效；退回基 item 反而没人读。真没有的（如 `LinkButton` 的 `normal`
 *    盒，文档也只列 `focus`）才该退回或告警。
* 2. 同一语义在个别类上**整体换名**而不是加中缀：`TabBar` / `TabContainer` 没有 `font_color`，
 *    字色按状态拆成 `font_unselected_color` / `font_selected_color` / `font_hovered_color` /
 *    `font_disabled_color`；`FoldableContainer` 的悬停色叫 `hover_font_color`（前缀而不是中缀）。
 *    两个推论：落点要先按状态解析、再查存在性（否则基 item 缺失会一票否决状态规则）；
 *    基 item 被拆成多个时一条声明要全写。`ItemList` / `Tree` 的 `font_hovered_color` 是行级
 *    状态，不参与映射。
 * 3. 多个 CSS 属性共用一个 theme item（`background-color` / `border` / `padding` 都写同一
 *    个 StyleBox）：`clearProperty` 的粒度是 CSS 属性名，撤销一条不得带走另一条。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  Button, FoldableContainer, Label, LinkButton, ItemList, PanelContainer, RichTextLabel, TabBar,
  TabContainer, Tree, type Control, type StyleBoxFlat,
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

function mount<T extends Control>(node: T, classes: string[] = []): T {
  root.add_child(node);
  runtime.attach(node);
  for (const name of classes) (node as unknown as { cssClasses: Set<string> }).cssClasses.add(name);
  return node;
}

async function enter(node: Control): Promise<void> {
  node.emit_signal("mouse_entered");
  await awaitFrames(2);
}

async function leave(node: Control): Promise<void> {
  node.emit_signal("mouse_exited");
  await awaitFrames(2);
}

async function removeClass(node: Control, name: string): Promise<void> {
  (node as unknown as { cssClasses: Set<string> }).cssClasses.delete(name);
  await awaitFrames(1);
}

const hasColor = (node: Control, item: string) => node.has_theme_color_override(item);
const hasConstant = (node: Control, item: string) => node.has_theme_constant_override(item);

/** StyleBoxFlat 的字段在该绑定里是 snake_case，两种拼法都试 */
function field<T>(box: object, camel: string, snake: string): T | undefined {
  const record = box as Record<string, T | undefined>;
  return record[camel] !== undefined ? record[camel] : record[snake];
}

function boxOf(node: Control, item: string): StyleBoxFlat | null {
  return node.has_theme_stylebox_override(item) ? (node.get_theme_stylebox(item) as StyleBoxFlat) : null;
}

function hex(c: { r: number; g: number; b: number }): string {
  const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

const bgColor = (node: Control, item = "panel") => {
  const box = boxOf(node, item);
  return box ? hex(box.bg_color) : "-";
};

const borderColor = (node: Control, item = "panel") => {
  const box = boxOf(node, item);
  if (!box) return "-";
  const color = field<{ r: number; g: number; b: number }>(box, "borderColor", "border_color");
  return color ? hex(color) : "-";
};

const borderWidthLeft = (node: Control, item = "panel") => {
  const box = boxOf(node, item);
  if (!box) return -1;
  return field<number>(box, "borderWidthLeft", "border_width_left") ?? -1;
};

const contentMarginLeft = (node: Control, item = "panel") => {
  const box = boxOf(node, item);
  if (!box) return -1;
  return field<number>(box, "contentMarginLeft", "content_margin_left") ?? -1;
};

/* ------------------------------------------------------------------ *
 * 基 item 缺失，但状态 item 存在
 * ------------------------------------------------------------------ */

describe("基 item 缺失不等于状态规则无落点", () => {
  it("TabBar:selected 落 font_selected_color（该类没有 font_color）", () => {
    runtime.addCss(`.t:selected { color: rgb(20, 20, 20); }`);
    const t = mount(new TabBar(), ["t"]);
    runtime.setPseudoClass(t, "selected", true);
    runtime.flush();
    expect(hasColor(t, "font_selected_color")).toBe(true);
    expect(hasColor(t, "font_unselected_color")).toBe(false);
  });

  it("TabBar 的 color 无通用 item，一次写全 unselected + selected", () => {
    runtime.addCss(`.t { color: rgb(10, 10, 10); }`);
    const t = mount(new TabBar(), ["t"]);
    runtime.flush();
    // 引擎把标签字色按选中与否拆成两个 item；只写一个会让作者看到“就选中那个标签没变色”
    expect(hasColor(t, "font_unselected_color")).toBe(true);
    expect(hasColor(t, "font_selected_color")).toBe(true);
    expect(hasColor(t, "font_color")).toBe(false);
  });

  it("TabBar:hover 落 font_hovered_color（悬停字色的方言名，中缀推不出来）", async () => {
    runtime.addCss(`.t:hover { color: rgb(20, 20, 20); }`);
    const t = mount(new TabBar(), ["t"]);
    runtime.flush();
    await enter(t);
    expect(hasColor(t, "font_hovered_color")).toBe(true);
    expect(hasColor(t, "font_unselected_color")).toBe(false);

    await leave(t);
    expect(hasColor(t, "font_hovered_color")).toBe(false);
  });

  it("TabContainer:hover 同样落 font_hovered_color", async () => {
    runtime.addCss(`.c:hover { color: rgb(30, 30, 30); }`);
    const c = mount(new TabContainer(), ["c"]);
    runtime.flush();
    await enter(c);
    expect(hasColor(c, "font_hovered_color")).toBe(true);
  });

  it("FoldableContainer:hover 落 hover_font_color（前缀方言）", async () => {
    runtime.addCss(`.f:hover { color: rgb(40, 40, 40); }`);
    const f = mount(new FoldableContainer(), ["f"]);
    runtime.flush();
    await enter(f);
    expect(hasColor(f, "hover_font_color")).toBe(true);
    expect(hasColor(f, "font_color")).toBe(false);
  });

  it("撤掉 hover 规则后方言 item 跟着撤销", async () => {
    runtime.addCss(`.t.a:hover { color: rgb(20, 20, 20); }`);
    const t = mount(new TabBar(), ["t", "a"]);
    await enter(t);
    expect(hasColor(t, "font_hovered_color")).toBe(true);

    await removeClass(t, "a");
    expect(hasColor(t, "font_hovered_color")).toBe(false);
  });

  it("RichTextLabel 的 item 别名不受落点解析顺序影响", () => {
    runtime.addCss(`.r { color: rgb(12, 12, 12); }`);
    const r = mount(new RichTextLabel(), ["r"]);
    runtime.flush();
    // RichTextLabel 的正文色叫 default_color，不叫 font_color
    expect(hasColor(r, "default_color")).toBe(true);
    expect(hasColor(r, "font_color")).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 状态 item 的存在性：默认主题未登记 ≠ 不可用
 * ------------------------------------------------------------------ */

describe("状态 item 的存在性判定", () => {
  it("LinkButton:disabled 写 font_disabled_color（默认主题未登记，但绘制分支读它）", async () => {
    runtime.addCss(`.k:disabled { color: rgb(30, 30, 30); }`);
    const k = mount(new LinkButton(), ["k"]);
    // :disabled 由属性驱动，手动 setPseudoClass 会在重算时被属性读回覆盖；置属性并标脏
    k.disabled = true;
    (k as unknown as { cssClasses: Set<string> }).cssClasses.add("nudge");
    await awaitFrames(1);
    // 文档把 font_disabled_color 列为 LinkButton 的 theme item，默认值 Color(0,0,0,1)
    // 与节点解析结果一致；默认主题没登记它，但 override 照样会被禁用分支读到
    expect(hasColor(k, "font_disabled_color")).toBe(true);
    expect(hasColor(k, "font_color")).toBe(false);
  });

  it("Tree / ItemList 的 :hover 落整棵列表的 font_color，不是行级 hovered", async () => {
    runtime.addCss(`.l:hover { color: rgb(40, 40, 40); }`);
    const tree = mount(new Tree(), ["l"]);
    const list = mount(new ItemList(), ["l"]);
    await enter(tree);
    await enter(list);
    // font_hovered_color 是"悬停某一行"的行级状态，CSS 的 :hover 说的不是它
    expect(hasColor(tree, "font_color")).toBe(true);
    expect(hasColor(tree, "font_hovered_color")).toBe(false);
    expect(hasColor(list, "font_color")).toBe(true);
    expect(hasColor(list, "font_hovered_color")).toBe(false);
  });

  it("Button 的 padding 落 stylebox 的 content margin，不是 theme constant", () => {
    runtime.addCss(`.b { padding: 6px; }`);
    const b = mount(new Button(), ["b"]);
    runtime.flush();
    // Button 的词汇表里没有 padding_left 这类常量，底色盒的 content margin 才是落点
    expect(hasConstant(b, "padding_left")).toBe(false);
    expect(contentMarginLeft(b, "normal")).toBe(6);
  });
});

/* ------------------------------------------------------------------ *
 * 交集落点：状态并集里真正成立的那一支
 * ------------------------------------------------------------------ */

describe("状态并集的落点跟随实际成立的状态", () => {
  it(":is(:hover, :disabled)：禁用时落 disabled 支，悬停时落 hover 支", async () => {
    runtime.addCss(`.b:is(:hover, :disabled) { color: rgb(255, 0, 0); }`);
    const b = mount(new Button(), ["b"]);
    runtime.flush();
    await enter(b);
    expect(hasColor(b, "font_hover_color")).toBe(true);
    expect(hasColor(b, "font_disabled_color")).toBe(false);

    await leave(b);
    b.disabled = true;
    (b as unknown as { cssClasses: Set<string> }).cssClasses.add("nudge");
    await awaitFrames(1);
    expect(hasColor(b, "font_disabled_color")).toBe(true);
    expect(hasColor(b, "font_hover_color")).toBe(false);
  });

  it(":is(:focus, :pressed)：盒落点跟着实际成立的状态走", async () => {
    runtime.addCss(`.b:is(:focus, :pressed) { background-color: rgb(10, 10, 10); }`);
    const b = mount(new Button(), ["b"]);
    runtime.flush();
    b.emit_signal("focus_entered");
    await awaitFrames(2);
    expect(b.has_theme_stylebox_override("focus")).toBe(true);
    expect(b.has_theme_stylebox_override("pressed")).toBe(false);

    b.emit_signal("button_down");
    await awaitFrames(2);
    expect(b.has_theme_stylebox_override("pressed")).toBe(true);
    expect(b.has_theme_stylebox_override("focus")).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 多个 CSS 属性共用一个 theme item
 * ------------------------------------------------------------------ */

describe("共用同一个 StyleBox item 时的撤销粒度", () => {
  it("background-color 与 border 共存，撤前者不带走后者", async () => {
    runtime.addCss(`.p.a { background-color: rgb(10, 10, 10); }`);
    runtime.addCss(`.p.b { border: 2px solid rgb(200, 0, 0); }`);
    const p = mount(new PanelContainer(), ["p", "a", "b"]);
    runtime.flush();
    expect(bgColor(p)).toBe("#0a0a0a");
    expect(borderColor(p)).toBe("#c80000");
    expect(borderWidthLeft(p)).toBe(2);

    await removeClass(p, "a");
    expect(borderColor(p)).toBe("#c80000");
    expect(borderWidthLeft(p)).toBe(2);
  });

  it("padding 与 background-color 共存，撤前者不带走后者", async () => {
    runtime.addCss(`.p.a { padding: 6px; }`);
    runtime.addCss(`.p.b { background-color: rgb(30, 30, 30); }`);
    const p = mount(new PanelContainer(), ["p", "a", "b"]);
    runtime.flush();
    expect(contentMarginLeft(p)).toBe(6);
    expect(bgColor(p)).toBe("#1e1e1e");

    await removeClass(p, "a");
    expect(bgColor(p)).toBe("#1e1e1e");
    expect(contentMarginLeft(p)).not.toBe(6);
  });

  it("border 与 padding 共存，撤 border 不带走 padding", async () => {
    runtime.addCss(`.p.a { padding: 7px; }`);
    runtime.addCss(`.p.b { border: 1px solid rgb(0, 0, 200); }`);
    const p = mount(new PanelContainer(), ["p", "a", "b"]);
    runtime.flush();
    expect(contentMarginLeft(p)).toBe(7);
    expect(borderWidthLeft(p)).toBe(1);

    await removeClass(p, "b");
    expect(contentMarginLeft(p)).toBe(7);
    expect(borderWidthLeft(p)).toBe(0);
  });

  it("基声明底色、hover 声明描边：退出悬停后基盒不残留 hover 字段", async () => {
    runtime.addCss(`.p { background-color: rgb(11, 11, 11); }`);
    runtime.addCss(`.p:hover { border: 3px solid rgb(0, 200, 0); }`);
    const p = mount(new PanelContainer(), ["p"]);
    runtime.flush();
    await enter(p);
    expect(bgColor(p)).toBe("#0b0b0b");
    expect(borderWidthLeft(p)).toBe(3);

    await leave(p);
    expect(bgColor(p)).toBe("#0b0b0b");
    expect(borderWidthLeft(p)).toBe(0);
  });

  it("text-shadow 写进去的三个 item 一起撤销", async () => {
    runtime.addCss(`.l.a { text-shadow: 2px 3px 4px rgb(50, 50, 50); }`);
    const l = mount(new Label(), ["l", "a"]);
    runtime.flush();
    expect(hasColor(l, "font_shadow_color")).toBe(true);
    expect(hasConstant(l, "shadow_offset_x")).toBe(true);
    expect(hasConstant(l, "shadow_offset_y")).toBe(true);

    await removeClass(l, "a");
    expect(hasColor(l, "font_shadow_color")).toBe(false);
    expect(hasConstant(l, "shadow_offset_x")).toBe(false);
    expect(hasConstant(l, "shadow_offset_y")).toBe(false);
  });
});
