/**
 * 状态伪类的**写入位置**取证：一条声明实际写入哪个 Godot 主题属性。
 *
 * 运行于真实引擎，断言仅关注节点上的主题覆盖（has_theme_*_override / get_theme_*），
 * 不涉及像素，也不涉及级联内部计数。「一次重算执行了几次操作」一类计数探针仍位于
 * packages/css/test/ 下的 Node 用例中，两侧不重复。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { Button, ItemList, Label, PanelContainer, TextEdit, ThemeDB, type Control, type StyleBoxFlat } from "godot";
import { StyleRuntime } from "godot-angular/core";
import { awaitFrames, newStyleRuntime, captureWarn, makeRenderer, resetWarnOnce } from "godot-angular/testing";

let runtime: StyleRuntime;
let root: Control;

beforeEach(() => {
  runtime = newStyleRuntime();
  root = makeRenderer().root;
  resetWarnOnce();
});

/** 构造一个已纳入级联、带 class 的节点 */
function make<T extends Control>(node: T, cls: string): T {
  root.add_child(node);
  runtime.attach(node);
  (node as unknown as { cssClasses: Set<string> }).cssClasses.add(cls);
  runtime.flush();
  return node;
}

/** 使节点进入 hover（引擎中 hover 由信号驱动，无对应属性可写） */
async function hover(node: Control): Promise<void> {
  node.emit_signal("mouse_entered");
  await awaitFrames(1);
}

/** 覆盖色 → "#rrggbb"：get_theme_color 返的是 Color 对象，不能直接跟 CSS 原文比 */
function cssColor(node: Control, item: string, type: string): string {
  const c: any = node.get_theme_color(item, type);
  const hex = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
}

/** Godot Array / PackedStringArray → JS string[] */
function strArr(value: any): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value.size === "function" && typeof value.get === "function") {
    const out: string[] = [];
    for (let i = 0, n = Number(value.size()); i < n; i++) out.push(String(value.get(i)));
    return out;
  }
  return Array.from(value, String);
}

describe("一条规则的多个选择器各自决定写入位置", () => {
  /** 在首次写入前即预先设置伪类，避免「基 item 先写入一次」干扰观察 */
  function makeHovered(classes: string[]): Button {
    const btn = new Button();
    root.add_child(btn);
    runtime.attach(btn);
    for (const name of classes) (btn as any).cssClasses.add(name);
    btn.emit_signal("mouse_entered");
    runtime.flush();
    return btn;
  }

  it("同一条声明按选择器各自要求的状态写入位置：状态 item 与基 item 各写一份", () => {
    runtime.addCss(`.btn:hover, .btn.is-off { color: rgb(255, 0, 0); }`);
    const btn = makeHovered(["btn", "is-off"]);
    // 两个选择器共享同一批声明，但要求的状态不同 → 两个写入位置，不存在「后者覆盖前者」
    expect(cssColor(btn, "font_hover_color", "Button")).toBe("#ff0000");
    expect(cssColor(btn, "font_color", "Button")).toBe("#ff0000");
  });

  it("源码顺序反过来结果不变：写入位置不依赖「哪个选择器在后」", () => {
    runtime.addCss(`.btn.is-off, .btn:hover { color: rgb(255, 0, 0); }`);
    const btn = makeHovered(["btn", "is-off"]);
    expect(btn.has_theme_color_override("font_hover_color")).toBe(true);
    expect(btn.has_theme_color_override("font_color")).toBe(true);
  });

  it("每个写入位置各自选胜者：特异度更高的基规则只抢走 font_color，不抢 font_hover_color", () => {
    runtime.addCss(`.btn:hover, .btn.is-off { color: rgb(255, 0, 0); }`);
    runtime.addCss(`.btn.is-off.x { color: rgb(0, 0, 255); }`);
    const btn = makeHovered(["btn", "is-off", "x"]);
    // 旧模型中一条属性仅有一个胜者，会整体变蓝，:hover 的颜色直接消失
    expect(cssColor(btn, "font_hover_color", "Button")).toBe("#ff0000");
    expect(cssColor(btn, "font_color", "Button")).toBe("#0000ff");
  });

  it("!important 分支同样按写入位置各自算", () => {
    runtime.addCss(`.btn:hover, .btn.is-off { color: rgb(255, 0, 0) !important; }`);
    runtime.addCss(`.btn { color: rgb(0, 0, 255); }`);
    const btn = makeHovered(["btn", "is-off"]);
    expect(cssColor(btn, "font_hover_color", "Button")).toBe("#ff0000");
    // important 的基规则仍胜过普通的基规则
    expect(cssColor(btn, "font_color", "Button")).toBe("#ff0000");
  });
});

describe("基规则与状态规则是叠加，不是替换", () => {
  it("作者写了 :hover 规则时，两个 item 同时存在", async () => {
    runtime.addCss(`.btn { color: rgb(0, 0, 255); }`);
    runtime.addCss(`.btn:hover { color: rgb(255, 0, 0); }`);
    const btn = make(new Button(), "btn");
    expect(btn.has_theme_color_override("font_color")).toBe(true);
    expect(btn.has_theme_color_override("font_hover_color")).toBe(false);

    await hover(btn);
    // 基 item 的覆盖仍在（引擎在常态读它），hover item 另写一份
    expect(cssColor(btn, "font_color", "Button")).toBe("#0000ff");
    expect(cssColor(btn, "font_hover_color", "Button")).toBe("#ff0000");
  });

  it("仅书写基规则时，进入 hover 后不存在任何状态 item → 该状态交由主题处理", async () => {
    runtime.addCss(`.btn { color: rgb(0, 0, 255); }`);
    const btn = make(new Button(), "btn");

    await hover(btn);
    // 仅余基 item：引擎悬停时读取 font_hover_color，本库未写入 → 使用主题默认色
    expect(btn.has_theme_color_override("font_color")).toBe(true);
    expect(btn.has_theme_color_override("font_hover_color")).toBe(false);
  });
});

describe("写入位置只看选择器自身的主体段", () => {
  it("`.card:hover .btn` 的写入位置不因按钮自身是否被悬停而改变", async () => {
    runtime.addCss(`.card:hover .btn { color: rgb(255, 0, 0); }`);
    const card = new PanelContainer();
    root.add_child(card);
    runtime.attach(card);
    (card as any).cssClasses.add("card");
    const btn = new Button();
    card.add_child(btn);
    runtime.attach(btn);
    (btn as any).cssClasses.add("btn");
    runtime.flush();

    // A：鼠标位于卡片上、未位于按钮上
    await hover(card);
    expect(btn.has_theme_color_override("font_color")).toBe(true);
    expect(btn.has_theme_color_override("font_hover_color")).toBe(false);

    // B：鼠标位于按钮上（卡片与按钮同时 hover）—— 规则命中的理由完全未变
    await hover(btn);
    // 规则表达的是「卡片被悬停」，与按钮自身的 hover 无关 → 不应多出 font_hover_color
    expect(btn.has_theme_color_override("font_hover_color")).toBe(false);
    expect(btn.has_theme_color_override("font_color")).toBe(true);
  });

  it("`:not(:hover)` 不要求任何状态，不应被当成状态声明", async () => {
    runtime.addCss(`.btn:not(:hover) { color: rgb(0, 0, 255); }`);
    const btn = make(new Button(), "btn");
    // 命中（未悬停），但节点随后处于 focus：文本中的 “:hover” 会将声明误标为状态声明
    btn.emit_signal("focus_entered");
    runtime.invalidate(btn);
    await awaitFrames(1);

    expect(btn.has_theme_color_override("font_color")).toBe(true);
    expect(btn.has_theme_color_override("font_focus_color")).toBe(false);
    expect(btn.has_theme_color_override("font_hover_color")).toBe(false);
  });
});

describe("状态 item 的回收", () => {
  it("规则整表移除时，已写入的状态 item 会被清空，基 item 保留", async () => {
    const base = runtime.addCss(`.btn { color: rgb(0, 0, 255); }`);
    const state = runtime.addCss(`.btn:hover { color: rgb(255, 0, 0); }`);
    const btn = make(new Button(), "btn");
    await hover(btn);
    expect(btn.has_theme_color_override("font_hover_color")).toBe(true);

    runtime.removeCss(state);
    await awaitFrames(1);
    // 残留必须撤销：否则引擎在 hover 状态仍会读取上一轮的过期颜色
    expect(btn.has_theme_color_override("font_hover_color")).toBe(false);
    expect(btn.has_theme_color_override("font_hover_color")).toBe(false);
    expect(cssColor(btn, "font_color", "Button")).toBe("#0000ff");

    runtime.removeCss(base);
    await awaitFrames(1);
    expect(btn.has_theme_color_override("font_color")).toBe(false);
  });
});

describe("状态属性名与 CSS 伪类不一致的类", () => {
  it("ItemList 的 hover 属性叫 hovered / font_hovered_color（真引擎事实）", () => {
    const theme: any = ThemeDB.get_default_theme();
    expect(strArr(theme.get_color_list("ItemList"))).toContain("font_hovered_color");
    expect(strArr(theme.get_stylebox_list("ItemList"))).toContain("hovered");
  });

  it("ItemList:hover 仅能退回常态 item —— 词汇表中不含 hover 这一族", async () => {
    runtime.addCss(`ItemList:hover { color: rgb(255, 255, 0); background-color: rgb(0, 255, 0); }`);
    const list = make(new ItemList(), "");
    await hover(list);
    // 写入位置为常态 item：效果整体错位，此为已记录的已知差异
    expect(list.has_theme_color_override("font_color")).toBe(true);
    expect(list.has_theme_color_override("font_hovered_color")).toBe(false);
    expect(list.has_theme_stylebox_override("hovered")).toBe(false);
  });

  it("TextEdit 的只读文字色走例外表：:read-only 写入 font_readonly_color", async () => {
    runtime.addCss(`.field:read-only { color: rgb(128, 128, 128); }`);
    // 仅 TextEdit / CodeEdit 具备 font_readonly_color；LineEdit 中的对应项名为 font_uneditable_color
    const edit = make(new TextEdit(), "field");
    edit.editable = false;
    runtime.invalidate(edit);
    await awaitFrames(1);
    expect(edit.has_theme_color_override("font_readonly_color")).toBe(true);
    expect(edit.has_theme_color_override("font_color")).toBe(false);
  });
});

describe("两条入口对同一条基规则必须写在同一个盒", () => {
  it("已禁用的按钮 + 未书写 :disabled 的底色规则 → 两条入口均写入 normal stylebox", async () => {
    runtime.addCss(`.btn { background-color: rgb(0, 0, 255); }`);
    const btn = new Button();
    root.add_child(btn);
    runtime.attach(btn);
    (btn as any).cssClasses.add("btn");
    btn.disabled = true;
    runtime.flush();

    // 级联入口：节点当前处于 disabled 不改变基规则的写入位置
    expect((btn.get_theme_stylebox("normal") as StyleBoxFlat).bg_color.b).toBeCloseTo(1, 3);
    // disabled stylebox 仅将基声明继承过去，并非另写一份：两者必须同色
    expect((btn.get_theme_stylebox("disabled") as StyleBoxFlat).bg_color.b).toBeCloseTo(1, 3);

    // 内联入口：同一属性名、同样未要求状态，必须写在同一个 stylebox（两侧需同步修改）
    runtime.setInline(btn, "background-color", "rgb(255, 0, 0)");
    await awaitFrames(1);
    expect((btn.get_theme_stylebox("normal") as StyleBoxFlat).bg_color.r).toBeCloseTo(1, 3);
    expect((btn.get_theme_stylebox("disabled") as StyleBoxFlat).bg_color.r).toBeCloseTo(1, 3);
  });
});

describe(":enabled 由 disabled 反推", () => {
  it("节点可用时 .btn:enabled 命中，禁用后写入位置撤销", async () => {
    runtime.addCss(`.btn:enabled { color: rgb(0, 255, 0); }`);
    const btn = make(new Button(), "btn");
    expect(cssColor(btn, "font_color", "Button")).toBe("#00ff00");

    btn.disabled = true;
    runtime.invalidate(btn);
    await awaitFrames(1);
    expect(btn.has_theme_color_override("font_color")).toBe(false);
  });

  it("控件类上不具备该属性时，告警点名具体类名与应走的通道", () => {
    runtime.addCss(`ItemList:disabled { color: rgb(128, 128, 128); }`);
    const captured = captureWarn(() => {
      const list = make(new ItemList(), "");
      runtime.invalidate(list);
      runtime.flush();
    });
    const text = captured.warn.warnings.join("\n");
    expect(text).toContain("ItemList 没有 disabled 属性");
    expect(text).toContain("class 通道");
  });

  it("同一个（状态 × 类名）仅报告一次，不逐节点重复输出", () => {
    runtime.addCss(`ItemList:disabled { color: rgb(128, 128, 128); }`);
    const captured = captureWarn(() => {
      for (let i = 0; i < 3; i++) {
        const list = make(new ItemList(), "");
        runtime.invalidate(list);
        runtime.flush();
      }
    });
    const hits = captured.warn.warnings.filter((line) => line.includes("没有 disabled 属性"));
    expect(hits.length).toBe(1);
  });
});

describe("属性驱动伪类的通道", () => {
  it("仅修改伪类而不修改属性 → 会被属性同步清除（已记录的内部契约）", async () => {
    runtime.addCss(`.btn:disabled { color: rgb(128, 128, 128); }`);
    const btn = make(new Button(), "btn");

    runtime.setPseudoClass(btn, "disabled", true);
    runtime.invalidate(btn);
    await awaitFrames(1);
    // 属性读回为 false，同步会将其恢复：外部仅设置伪类不会生效
    expect(btn.has_theme_color_override("font_disabled_color")).toBe(false);
  });

  it("后代节点的状态变化在同一轮 flush 内处理完毕", async () => {
    runtime.addCss(`.btn:disabled .title { color: rgb(0, 255, 255); }`);
    const btn = new Button();
    root.add_child(btn);
    runtime.attach(btn);
    (btn as any).cssClasses.add("btn");
    const title = new Label();
    btn.add_child(title);
    runtime.attach(title);
    (title as any).cssClasses.add("title");
    runtime.flush();
    expect(title.has_theme_color_override("font_color")).toBe(false);

    btn.disabled = true;
    runtime.invalidate(btn);
    await awaitFrames(1);
    expect(title.has_theme_color_override("font_color")).toBe(true);
  });
});
