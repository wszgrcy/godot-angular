import { beforeEach, describe, expect, it } from "vitest";
import {
  Button,
  CheckBox,
  Color,
  Label,
  LineEdit,
  PanelContainer,
  StyleBoxFlat,
  TabBar,
  Tree,
  type Control,
} from "godot";
import { StyleRuntime } from "godot-angular/core";
import { awaitFrames, captureWarn, makeRenderer, resetWarnOnce } from "godot-angular/testing";

/**
 * 状态盒的层叠语义（v0.3.1 悬停重排回归的回归测试）。
 *
 * 契约只有一条：**没声明的字段一个字节都不碰；声明过的字段必须贯穿所有状态。**
 *
 *   状态盒 = 引擎该状态的默认盒 ⊕ 基规则声明过的字段 ⊕ 该状态声明的字段
 *
 * 全部在 Godot 引擎内跑，断言的是**节点上 theme override 的真实字段值**
 * （`get_theme_stylebox(item)` 返回的 StyleBoxFlat 属性），不测尺寸：属性写对了渲染就对了，
 * 属性对而渲染不对那是引擎的问题，不在本库职责内。
 */

let runtime: StyleRuntime;
let root: Control;

beforeEach(() => {
  runtime = new StyleRuntime();
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

function addClass(node: Control, cls: string): void {
  (node as unknown as { cssClasses: Set<string> }).cssClasses.add(cls);
}

function removeClass(node: Control, cls: string): void {
  (node as unknown as { cssClasses: Set<string> }).cssClasses.delete(cls);
}

/**
 * 引擎默认盒（未挂任何 CSS 的同类节点）。
 * 用它做基准而不是硬编码数字：默认主题随引擎版本 / 深浅色变化。
 */
function engineBox<T extends Control>(makeNode: () => T, item: string): StyleBoxFlat {
  const probe = makeNode();
  const box = probe.get_theme_stylebox(item) as StyleBoxFlat;
  probe.free();
  return box;
}

/** 节点上某个 item 当前真正生效的盒（引擎会沿 override → 主题回落，读到的就是绘制用的那个） */
function box(node: Control, item: string): StyleBoxFlat {
  return node.get_theme_stylebox(item) as StyleBoxFlat;
}

function css(r: number, g: number, b: number): Color {
  return new Color(r / 255, g / 255, b / 255, 1);
}

/** 颜色统一按 html 比较：每次读出来的 Color 都是新实例，只能比序列化结果 */
function hex(value: Color): string {
  return value.to_html(true);
}

/* ------------------------------------------------------------------ */

describe("层叠：基规则声明过的字段贯穿所有状态", () => {
  it("主回归：基规则的圆角 / 边框 / padding 必须出现在 hover 盒里", async () => {
    // 示例工程左侧导航的真实写法
    runtime.addCss(`
      .nav-item {
        background-color: rgb(255, 255, 255); border-color: rgb(207, 216, 227);
        border-width: 1px; border-radius: 9px; padding: 8px 12px;
      }
      .nav-item:hover { background-color: rgb(233, 238, 244); border-color: rgb(108, 178, 245); }
    `);
    const btn = make(new Button(), "nav-item");

    btn.emit_signal("mouse_entered");
    await awaitFrames(1);

    const hover = box(btn, "hover");
    // 基规则声明过的字段（v0.3.1 丢的就是这四个）
    expect(hover.corner_radius_top_left).toBe(9);
    expect(hover.corner_radius_top_right).toBe(9);
    expect(hover.border_width_top).toBe(1);
    expect(hover.content_margin_top).toBe(8);
    expect(hover.content_margin_left).toBe(12);
    // :hover 自己声明的两条覆盖在上面
    expect(hex(hover.bg_color)).toBe(hex(css(233, 238, 244)));
    expect(hex(hover.border_color)).toBe(hex(css(108, 178, 245)));
  });

  it("基规则没声明的字段仍取「引擎该状态的默认值」，不是照抄基盒", async () => {
    // 这条专门防止实现者图省事「整个复制基盒」：那样 hover 底色会变成引擎 normal 的底色，
    // 引擎自己的悬停加深就被抹掉了。
    const engineHoverBg = hex(engineBox(() => new Button(), "hover").bg_color);
    const engineNormalBg = hex(engineBox(() => new Button(), "normal").bg_color);
    expect(engineHoverBg).not.toBe(engineNormalBg); // 前提：两者必须不同，否则本用例没有鉴别力

    runtime.addCss(`.btn { padding: 10px; }\n.btn:hover { color: rgb(255, 213, 79); }`);
    const btn = make(new Button(), "btn");

    btn.emit_signal("mouse_entered");
    await awaitFrames(1);

    const hover = box(btn, "hover");
    expect(hover.content_margin_top).toBe(10); // 声明过 → 来自基规则
    expect(hex(hover.bg_color)).toBe(engineHoverBg); // 没声明 → 来自引擎 hover 盒
    expect(hover.corner_radius_top_left).toBe(
      engineBox(() => new Button(), "hover").corner_radius_top_left,
    );
  });

  it("源盒是 StyleBoxEmpty 时换的新 Flat 必须透底：只写 padding 不得画出灰块", () => {
    // `new StyleBoxFlat()` 的默认 bg_color 是 #999999ff（不透明灰）。Label 的 normal 盒是
    // StyleBoxEmpty，只写 padding 时若直接拿默认 Flat 替身，文字背后会多出一块灰底。
    runtime.addCss(`.cap { padding: 8px 10px; font-size: 11px; }`);
    const label = make(new Label(), "cap");

    const normal = box(label, "normal");
    expect(normal.get_class()).toBe("StyleBoxFlat");
    expect(normal.content_margin_top).toBe(8);
    expect(normal.bg_color.a).toBeCloseTo(0, 5);
    expect(normal.border_color.a).toBeCloseTo(0, 5);
  });

  it("源盒是 StyleBoxEmpty 时，它的 content_margin 必须搬过来（CheckBox 实测带 4px）", () => {
    // 默认主题里 CheckBox 的 normal/hover/pressed/hover_pressed 是 StyleBoxEmpty，
    // 但 content_margin = 4/4/4/4。换成空 Flat 时不搬的话，CSS 只碰一下底色，
    // 内边距就会从 4 塌到 -1，图标与文字位置跟着变。
    runtime.addCss(`.cb { background-color: rgb(10, 20, 30); }`);
    const cb = make(new CheckBox(), "cb");

    const normal = box(cb, "normal");
    expect(normal.get_class()).toBe("StyleBoxFlat");
    expect(normal.bg_color.a).not.toBeCloseTo(0, 5); // 底色确实写进去了
    expect(normal.content_margin_top).toBe(4); // 引擎 Empty 盒的布局语义没丢
    expect(normal.content_margin_left).toBe(4);
  });

  it("声明全部撤掉后必须回到 Godot 自己的默认盒，不得残留我们建的盒", () => {
    // 契约：作者写了什么才变更什么；去掉了就回 Godot 的默认值，
    // 而不是回“我们自己设的某个中间值”。物理上只能整盒替换，所以撤销必须是
    // remove_theme_stylebox_override（让引擎沿主题继承链回落），而不是挂一个透底盒。
    const engineBg = hex(engineBox(() => new Button(), "normal").bg_color);
    const engineRadius = engineBox(() => new Button(), "normal").corner_radius_top_left;
    const handle = runtime.addCss(`.btn { background-color: rgb(1, 2, 3); border-radius: 9px; }`);
    const btn = make(new Button(), "btn");
    expect(btn.has_theme_stylebox_override("normal")).toBe(true);

    runtime.removeCss(handle);
    runtime.flush();

    // 关键：不是“挂了一个透底盒”，而是根本没有 override
    expect(btn.has_theme_stylebox_override("normal")).toBe(false);
    // 读到的就是引擎自己的盒（字段与同类裸节点一致）
    expect(hex(box(btn, "normal").bg_color)).toBe(engineBg);
    expect(box(btn, "normal").corner_radius_top_left).toBe(engineRadius);
  });

  it("状态声明全部撤掉后，状态盒也回到 Godot 默认（基声明还在则回基声明）", async () => {
    const engineHoverBg = hex(engineBox(() => new Button(), "hover").bg_color);
    const stateHandle = runtime.addCss(`.btn:hover { background-color: rgb(9, 9, 9); }`);
    runtime.addCss(`.btn { padding: 8px; }`);
    const btn = make(new Button(), "btn");

    btn.emit_signal("mouse_entered");
    await awaitFrames(1);
    expect(box(btn, "hover").content_margin_top).toBe(8); // 基声明贯穿

    runtime.removeCss(stateHandle);
    await awaitFrames(1);

    // 基规则还声明着 padding → hover 盒仍存在，但底色必须是引擎的 hover 底色
    expect(box(btn, "hover").content_margin_top).toBe(8);
    expect(hex(box(btn, "hover").bg_color)).toBe(engineHoverBg);
  });

  it("完全不写 :hover 时，几何照样进 hover 盒，底色交给引擎（悬停反馈保留）", async () => {
    const engineHoverBg = hex(engineBox(() => new Button(), "hover").bg_color);
    runtime.addCss(`.btn { padding: 10px; border-radius: 6px; }`);
    const btn = make(new Button(), "btn");

    btn.emit_signal("mouse_entered");
    await awaitFrames(1);

    const hover = box(btn, "hover");
    expect(hover.content_margin_top).toBe(10);
    expect(hover.corner_radius_top_left).toBe(6);
    expect(hex(hover.bg_color)).toBe(engineHoverBg); // 作者没写底色 → 引擎的悬停加深还在
  });

  it("基规则只写文字色时，一个状态盒都不许多建出来", async () => {
    runtime.addCss(`.btn { color: rgb(1, 2, 3); }`);
    const btn = make(new Button(), "btn");
    expect(btn.has_theme_stylebox_override("normal")).toBe(false);

    btn.emit_signal("mouse_entered");
    await awaitFrames(1);
    expect(btn.has_theme_stylebox_override("hover")).toBe(false);
    expect(btn.has_theme_stylebox_override("focus")).toBe(false);
  });

  it("状态规则声明的几何盖过基规则（悬停换 padding 是合法写法）", async () => {
    runtime.addCss(`.btn { padding: 8px; }\n.btn:hover { padding: 20px; }`);
    const btn = make(new Button(), "btn");

    btn.emit_signal("mouse_entered");
    await awaitFrames(1);
    expect(box(btn, "hover").content_margin_top).toBe(20);

    btn.emit_signal("mouse_exited");
    await awaitFrames(1);
    // 退出状态后回到基规则的值，不能残留 20
    expect(box(btn, "hover").content_margin_top).toBe(8);
  });

  it("normal 盒本身不受状态声明污染", async () => {
    runtime.addCss(`.btn { padding: 8px; }\n.btn:hover { padding: 20px; border-radius: 30px; }`);
    const btn = make(new Button(), "btn");
    expect(box(btn, "normal").content_margin_top).toBe(8);

    btn.emit_signal("mouse_entered");
    await awaitFrames(1);
    expect(box(btn, "normal").content_margin_top).toBe(8);
    expect(box(btn, "normal").corner_radius_top_left).not.toBe(30);
  });
});

describe("各状态各自核对属性", () => {
  it(":focus（Button）：几何跟随基规则，未声明的描边保留引擎默认", async () => {
    const engineFocus = engineBox(() => new Button(), "focus");
    runtime.addCss(`.btn { padding: 8px 12px; border-radius: 9px; }`);
    const btn = make(new Button(), "btn");

    btn.emit_signal("focus_entered");
    await awaitFrames(1);

    const focus = box(btn, "focus");
    expect(focus.content_margin_top).toBe(8);
    expect(focus.content_margin_left).toBe(12);
    expect(focus.corner_radius_top_left).toBe(9);
    // 作者没写 border-width → 引擎的焦点环粗细不动（这就是"焦点环会不会消失"的答案）
    expect(focus.border_width_top).toBe(engineFocus.border_width_top);
  });

  it(":focus（Button）：作者声明了 border-color 时，焦点环颜色按层叠被覆盖", async () => {
    runtime.addCss(`.btn { border-color: transparent; border-width: 1px; }`);
    const btn = make(new Button(), "btn");

    btn.emit_signal("focus_entered");
    await awaitFrames(1);

    // 浏览器里也一样：作者说边框恒为透明，焦点环就得作者自己用 :focus 画（outline 无落点）
    expect(box(btn, "focus").border_color.a).toBeCloseTo(0, 5);
    expect(box(btn, "focus").border_width_top).toBe(1);
  });

  it(":focus（LineEdit）", async () => {
    runtime.addCss(`.field { padding: 6px 10px; border-radius: 8px; }`);
    const edit = make(new LineEdit(), "field");

    edit.emit_signal("focus_entered");
    await awaitFrames(1);

    expect(box(edit, "focus").content_margin_top).toBe(6);
    expect(box(edit, "focus").content_margin_left).toBe(10);
    expect(box(edit, "focus").corner_radius_top_left).toBe(8);
  });

  it(":pressed / :active：落 pressed 盒且字段跟随", async () => {
    runtime.addCss(`.btn { padding: 8px 12px; border-radius: 9px; }`);
    const btn = make(new Button(), "btn");

    btn.emit_signal("button_down");
    await awaitFrames(1);

    expect(box(btn, "pressed").content_margin_top).toBe(8);
    expect(box(btn, "pressed").corner_radius_top_left).toBe(9);
  });

  it(":disabled：落 disabled 盒且字段跟随", async () => {
    runtime.addCss(`.btn { padding: 8px 12px; border-radius: 9px; }`);
    const btn = make(new Button(), "btn");

    btn.disabled = true;
    runtime.invalidate(btn);
    await awaitFrames(1);

    expect(box(btn, "disabled").content_margin_top).toBe(8);
    expect(box(btn, "disabled").corner_radius_top_left).toBe(9);
  });

  it(":read-only（LineEdit editable=false）：落 read_only 盒且字段跟随", async () => {
    runtime.addCss(`.field { padding: 5px; border-radius: 4px; }`);
    const edit = make(new LineEdit(), "field");

    edit.editable = false;
    runtime.invalidate(edit);
    await awaitFrames(1);

    expect(box(edit, "read_only").content_margin_top).toBe(5);
    expect(box(edit, "read_only").corner_radius_top_left).toBe(4);
  });

  it(":checked（CheckBox）：默认主题给的是 StyleBoxEmpty，必须换成 Flat 才写得进", async () => {
    runtime.addCss(`.cb { background-color: rgb(10, 20, 30); padding: 6px; }`);
    const cb = make(new CheckBox(), "cb");

    cb.button_pressed = true;
    cb.emit_signal("toggled", true);
    await awaitFrames(1);

    const pressed = box(cb, "pressed");
    // CheckBox 的 normal/pressed/hover/hover_pressed 在默认主题里是 StyleBoxEmpty（什么都不画），
    // 保留原类型的话 CSS 的底色与圆角会静默无效，所以这里必须是 Flat。
    expect(pressed.get_class()).toBe("StyleBoxFlat");
    expect(pressed.content_margin_top).toBe(6);
    expect(hex(pressed.bg_color)).toBe(hex(css(10, 20, 30)));
  });

  it("hover + checked 写合成盒（CheckBox 有 hover_pressed）", async () => {
    runtime.addCss(`.cb { padding: 6px; }`);
    const cb = make(new CheckBox(), "cb");

    cb.button_pressed = true;
    cb.emit_signal("toggled", true);
    cb.emit_signal("mouse_entered");
    await awaitFrames(1);

    expect(cb.has_theme_stylebox_override("hover_pressed")).toBe(true);
    expect(box(cb, "hover_pressed").content_margin_top).toBe(6);
  });

  it("Button 没有 hover_pressed 盒 → 不得凭空造一个引擎永远不读的盒", async () => {
    runtime.addCss(`.btn { padding: 6px; }\n.btn:hover:active { background-color: rgb(1, 2, 3); }`);
    const btn = make(new Button(), "btn");

    btn.emit_signal("mouse_entered");
    btn.emit_signal("button_down");
    await awaitFrames(1);

    expect(btn.has_theme_stylebox_override("hover_pressed")).toBe(false);
    // 合成 item 不存在时回落 pressed（vocabulary 的既有口径），字段照样要跟过去
    expect(btn.has_theme_stylebox_override("pressed")).toBe(true);
    expect(box(btn, "pressed").content_margin_top).toBe(6);
  });
});

describe("Godot 没有的能力不硬造", () => {
  it("PanelContainer 只有一个盒：:hover 复用 panel，不造第二个盒，退出后还原", async () => {
    runtime.addCss(`.card { background-color: rgb(255, 255, 255); }\n.card:hover { background-color: rgb(1, 2, 3); }`);
    const card = make(new PanelContainer(), "card");
    expect(card.has_theme_stylebox_override("hover")).toBe(false);

    card.emit_signal("mouse_entered");
    await awaitFrames(1);
    expect(hex(box(card, "panel").bg_color)).toBe(hex(css(1, 2, 3)));

    card.emit_signal("mouse_exited");
    await awaitFrames(1);
    // 退出后必须回到基规则的白，不能残留 hover 色（同 cssName 同 item 时撤销要分得开）
    expect(hex(box(card, "panel").bg_color)).toBe(hex(css(255, 255, 255)));
  });

  it("Tree 的行悬停盒（hovered）是行级状态：:hover 只能落 panel，不去顶 hovered", async () => {
    runtime.addCss(`.tree { background-color: rgb(255, 255, 255); }\n.tree:hover { background-color: rgb(1, 2, 3); }`);
    const tree = make(new Tree(), "tree");

    tree.emit_signal("mouse_entered");
    await awaitFrames(1);

    expect(tree.has_theme_stylebox_override("hovered")).toBe(false);
    expect(tree.has_theme_stylebox_override("panel")).toBe(true);
    expect(hex(box(tree, "panel").bg_color)).toBe(hex(css(1, 2, 3)));
  });

  it("TabBar 没有可当底色的盒：明确告警，而不是偷偷写进 tab_focus", () => {
    const captured = captureWarn(() => {
      const local = new StyleRuntime();
      const bar = new TabBar();
      root.add_child(bar);
      local.attach(bar);
      addClass(bar, "tabs");
      local.addCss(`.tabs { background-color: rgb(43, 127, 255); }`);
      local.flush();
      expect(bar.has_theme_stylebox_override("tab_focus")).toBe(false);
    });
    expect(captured.warn.warnings.join("\n")).toContain("无落点");
  });
});

describe("写入顺序无关", () => {
  it(":hover 规则写在基规则之前（特异度打平）也必须拿到基规则的几何", async () => {
    // compareSelectors = 特异度 → tier → 源码顺序。两条都是 0,2,0，于是源码顺序决定：
    // hover 声明先落。钉的是引擎侧的「基声明落地时连带重建全部状态盒」：
    // 没有这条重建，hover 盒就会在基字段表还是空的时候建出来，而它之后再没人标脏。
    // 场景：节点先处于 hover 态，两条声明在同一帧才第一次命中（数据晚到才渲染出的按钮、
    // 在静止鼠标底下弹出的菜单）。
    const btn = make(new Button(), "nav-item");
    runtime.setPseudoClass(btn, "hover", true);

    runtime.addCss(`.nav-item:hover { background-color: rgb(233, 238, 244); }`); // 0,2,0，源码在前
    runtime.addCss(`.nav-item.active { padding: 8px 12px; border-radius: 9px; }`); // 0,2,0，在后
    addClass(btn, "active");
    await awaitFrames(1);

    const hover = box(btn, "hover");
    expect(hover.content_margin_top).toBe(8);
    expect(hover.content_margin_left).toBe(12);
    expect(hover.corner_radius_top_left).toBe(9);
  });
});

describe("动态变化", () => {
  it("基规则被改写时，正处于 hover 的状态盒必须跟着重建", async () => {
    runtime.addCss(`.btn:hover { background-color: rgb(233, 238, 244); }`);
    const handle = runtime.addCss(`.btn { padding: 8px 12px; }`);
    const btn = make(new Button(), "btn");

    btn.emit_signal("mouse_entered");
    await awaitFrames(1);
    expect(box(btn, "hover").content_margin_top).toBe(8);

    runtime.removeCss(handle);
    runtime.addCss(`.btn { padding: 2px 4px; }`);
    await awaitFrames(1);

    expect(box(btn, "hover").content_margin_top).toBe(2);
    expect(box(btn, "normal").content_margin_top).toBe(2);
  });

  it("主题类切换（相当于 [class.light] 换肤）后，正处于 hover 的状态盒跟着重建", async () => {
    runtime.addCss(`.btn { background-color: rgb(255, 255, 255); padding: 8px; }`);
    runtime.addCss(`.btn.dark { background-color: rgb(20, 20, 20); }`);
    const btn = make(new Button(), "btn");

    btn.emit_signal("mouse_entered");
    await awaitFrames(1);
    expect(hex(box(btn, "hover").bg_color)).toBe(hex(css(255, 255, 255)));

    addClass(btn, "dark");
    await awaitFrames(1);
    expect(hex(box(btn, "hover").bg_color)).toBe(hex(css(20, 20, 20)));
  });

  it("撤销一条 stylebox 声明不得连带抹掉同一盒里别的声明（整盒撤销缺陷）", async () => {
    const engineNormal = engineBox(() => new Button(), "normal");
    runtime.addCss(`.btn { background-color: rgb(214, 69, 69); border-radius: 9px; }`);
    runtime.addCss(`.tight { padding: 2px 4px; }`);
    const btn = make(new Button(), "btn");
    addClass(btn, "tight");
    runtime.flush();
    expect(box(btn, "normal").content_margin_top).toBe(2);

    removeClass(btn, "tight");
    runtime.invalidate(btn);
    await awaitFrames(1);

    const normal = box(btn, "normal");
    // padding 撤掉了，但底色与圆角是另两条仍在命的声明，必须原样留着
    expect(hex(normal.bg_color)).toBe(hex(css(214, 69, 69)));
    expect(normal.corner_radius_top_left).toBe(9);
    // padding 回到引擎默认值（不是 0，也不是残留的 2）
    expect(normal.content_margin_top).toBe(engineNormal.content_margin_top);
  });
});
