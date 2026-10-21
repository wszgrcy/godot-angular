/**
 * 伪类的**切换过程**：多状态共存、逐个撤销、退出后恢复、顺序无关性。
 *
 * 与 `css-pseudo.spec.ts` 的分工：那份钉「单个伪类怎么被驱动、写在哪个 item」，
 * 本文件钉「状态来回变化时账本是否收敛」。判据始终是节点上的主题覆盖：
 * 该写的 item 写了、不该留的一个不剩。像素表现（引擎在合成态究竟读哪个 item）由
 * `css-pseudo.spec.ts` 的 `get_draw_mode` 实测负责，这里不重复。
 *
 * 三条容易被切换过程暴露的不变量：
 * 1. 状态退出后，基规则声明过的值必须回到节点上，而不是被整条抹掉；
 * 2. 一条状态规则撤销，不得连带撤掉另一条状态规则写过的 item；
 * 3. 状态到达顺序不影响终态（引擎发信号的先后没有契约保证）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  Button,
  CheckBox,
  Label,
  PanelContainer,
  VBoxContainer,
  type Control,
  type StyleBoxFlat,
} from "godot";
import { StyleRuntime } from "godot-angular/core";
import { awaitFrames, newStyleRuntime, makeRenderer, resetWarnOnce } from "godot-angular/testing";

let runtime: StyleRuntime;
let root: Control;

beforeEach(() => {
  runtime = newStyleRuntime();
  root = makeRenderer().root;
  resetWarnOnce();
});

function mount<T extends Control>(node: T, parent: Control, classes: string[] = []): T {
  parent.add_child(node);
  runtime.attach(node);
  for (const name of classes) (node as unknown as { cssClasses: Set<string> }).cssClasses.add(name);
  return node;
}

function settle(): void {
  runtime.flush();
}

function classes(node: Control): Set<string> {
  return (node as unknown as { cssClasses: Set<string> }).cssClasses;
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

/** 立刻发出成对信号（不等帧）：用来验证帧末合并 */
function enterNow(node: Control): void {
  node.emit_signal("mouse_entered");
}

function leaveNow(node: Control): void {
  node.emit_signal("mouse_exited");
}

function color(node: Control, item: string): string {
  const c = node.get_theme_color(item);
  const hex = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
}

function has(node: Control, item: string): boolean {
  return node.has_theme_color_override(item);
}

function boxHex(node: Control, item: string): string {
  const box = node.get_theme_stylebox(item) as StyleBoxFlat;
  const c = box.bg_color;
  const hex = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
}

/* ------------------------------------------------------------------ */

describe("状态退出后的恢复", () => {
  it("hover 开→关：回到基规则的值，而不是把颜色抹掉", async () => {
    runtime.addCss(`.btn { color: rgb(10, 10, 10); }`);
    runtime.addCss(`.btn:hover { color: rgb(200, 200, 200); }`);
    const btn = mount(new Button(), root, ["btn"]);
    settle();
    expect(color(btn, "font_color")).toBe("#0a0a0a");

    await enter(btn);
    expect(color(btn, "font_hover_color")).toBe("#c8c8c8");
    // 基 item 不被悬停规则顶掉：引擎在非悬停态读的就是它
    expect(color(btn, "font_color")).toBe("#0a0a0a");

    await leave(btn);
    expect(has(btn, "font_hover_color")).toBe(false);
    expect(color(btn, "font_color")).toBe("#0a0a0a");
  });

  it("状态值与基值相同时也要重写（diff 不能只比值）", async () => {
    runtime.addCss(`.btn { color: rgb(0, 0, 255); }`);
    runtime.addCss(`.btn:hover { color: rgb(0, 0, 255); }`);
    const btn = mount(new Button(), root, ["btn"]);
    settle();
    expect(has(btn, "font_hover_color")).toBe(false);

    // 值没变，但写入位置从 font_color 换成 font_hover_color：只比值的 diff 会跳过写入，
    // 引擎悬停时读 font_hover_color，症状是「写了 :hover 却毫无反应」
    await enter(btn);
    expect(color(btn, "font_hover_color")).toBe("#0000ff");
  });

  it("反复切换 20 次：终态与最后一次状态一致，无残留", async () => {
    runtime.addCss(`.btn { color: rgb(1, 1, 1); }`);
    runtime.addCss(`.btn:hover { color: rgb(2, 2, 2); }`);
    const btn = mount(new Button(), root, ["btn"]);
    settle();

    for (let i = 0; i < 20; i++) {
      enterNow(btn);
      leaveNow(btn);
      await awaitFrames(1);
    }
    expect(has(btn, "font_hover_color")).toBe(false);
    expect(color(btn, "font_color")).toBe("#010101");

    enterNow(btn);
    await awaitFrames(1);
    expect(color(btn, "font_hover_color")).toBe("#020202");
  });

  it("同一帧内进入又离开：净变化为零，不留悬停 override", async () => {
    runtime.addCss(`.btn:hover { color: rgb(9, 9, 9); }`);
    const btn = mount(new Button(), root, ["btn"]);
    settle();

    enterNow(btn);
    leaveNow(btn);
    await awaitFrames(1);
    expect(has(btn, "font_hover_color")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe("多状态共存与逐个撤销", () => {
  it("hover / focus / active 同时成立：各写各的 item", async () => {
    runtime.addCss(`.btn:hover { color: rgb(11, 11, 11); }`);
    runtime.addCss(`.btn:focus { color: rgb(22, 22, 22); }`);
    runtime.addCss(`.btn:active { color: rgb(33, 33, 33); }`);
    const btn = mount(new Button(), root, ["btn"]);
    settle();

    await enter(btn);
    await focus(btn);
    await press(btn);
    expect(color(btn, "font_hover_color")).toBe("#0b0b0b");
    expect(color(btn, "font_focus_color")).toBe("#161616");
    expect(color(btn, "font_pressed_color")).toBe("#212121");
  });

  it("逐个撤销：关掉 active 不动 hover 与 focus", async () => {
    runtime.addCss(`.btn:hover { color: rgb(11, 11, 11); }`);
    runtime.addCss(`.btn:focus { color: rgb(22, 22, 22); }`);
    runtime.addCss(`.btn:active { color: rgb(33, 33, 33); }`);
    const btn = mount(new Button(), root, ["btn"]);
    settle();

    await enter(btn);
    await focus(btn);
    await press(btn);

    await release(btn);
    expect(has(btn, "font_pressed_color")).toBe(false);
    expect(color(btn, "font_hover_color")).toBe("#0b0b0b");
    expect(color(btn, "font_focus_color")).toBe("#161616");

    await blur(btn);
    expect(has(btn, "font_focus_color")).toBe(false);
    expect(color(btn, "font_hover_color")).toBe("#0b0b0b");

    await leave(btn);
    expect(has(btn, "font_hover_color")).toBe(false);
  });

  it("hover+active 写合成 item；松开后合成 item 撤掉、hover item 留下", async () => {
    runtime.addCss(`.btn:hover { color: rgb(11, 11, 11); }`);
    runtime.addCss(`.btn:hover:active { color: rgb(99, 99, 99); }`);
    const btn = mount(new Button(), root, ["btn"]);
    settle();

    await enter(btn);
    await press(btn);
    expect(color(btn, "font_hover_pressed_color")).toBe("#636363");

    await release(btn);
    expect(has(btn, "font_hover_pressed_color")).toBe(false);
    // 仍在悬停中：合成态撤销不能把单状态的那份一起带走
    expect(color(btn, "font_hover_color")).toBe("#0b0b0b");
  });

  it("顺序无关：先 hover 后 active 与先 active 后 hover 得到同一终态", async () => {
    runtime.addCss(`.btn:hover:active { color: rgb(77, 77, 77); }`);
    const a = mount(new Button(), root, ["btn"]);
    const b = mount(new Button(), root, ["btn"]);
    settle();

    await enter(a);
    await press(a);

    await press(b);
    await enter(b);

    expect(color(a, "font_hover_pressed_color")).toBe("#4d4d4d");
    expect(color(b, "font_hover_pressed_color")).toBe("#4d4d4d");
  });

  it("CheckBox：勾选 + 悬停写 hover_pressed 盒，取消勾选退回 hover 盒", async () => {
    runtime.addCss(`.cb:hover { background-color: rgb(10, 10, 10); }`);
    runtime.addCss(`.cb:hover:checked { background-color: rgb(90, 90, 90); }`);
    const cb = mount(new CheckBox(), root, ["cb"]);
    settle();

    await enter(cb);
    expect(boxHex(cb, "hover")).toBe("#0a0a0a");

    cb.button_pressed = true;
    cb.emit_signal("toggled", true);
    await awaitFrames(1);
    expect(boxHex(cb, "hover_pressed")).toBe("#5a5a5a");

    cb.button_pressed = false;
    cb.emit_signal("toggled", false);
    await awaitFrames(1);
    expect(cb.has_theme_stylebox_override("hover_pressed")).toBe(false);
    expect(boxHex(cb, "hover")).toBe("#0a0a0a");
  });

  it("Button：悬停 + 按住写 hover_pressed 盒，松手退回 hover 盒", async () => {
    // 默认主题只给 CheckBox 登记了 hover_pressed 盒，但 Button 的画法同样读它，
    // 所以两个类的合成态写入位置应该一致（而不是退回 pressed 盒）
    runtime.addCss(`.btn:hover { background-color: rgb(10, 10, 10); }`);
    runtime.addCss(`.btn:hover:active { background-color: rgb(90, 90, 90); }`);
    const btn = mount(new Button(), root, ["btn"]);
    settle();

    await enter(btn);
    expect(boxHex(btn, "hover")).toBe("#0a0a0a");

    await press(btn);
    expect(boxHex(btn, "hover_pressed")).toBe("#5a5a5a");
    // 合成盒与单状态盒各写各的，谁也不盖谁
    expect(boxHex(btn, "hover")).toBe("#0a0a0a");

    await release(btn);
    expect(btn.has_theme_stylebox_override("hover_pressed")).toBe(false);
    expect(boxHex(btn, "hover")).toBe("#0a0a0a");
  });

  it("disabled 参与时不走合成 item：引擎在禁用态只读 disabled 那一支", async () => {
    runtime.addCss(`.btn:hover:active { color: rgb(77, 77, 77); }`);
    runtime.addCss(`.btn:disabled { color: rgb(128, 128, 128); }`);
    const btn = mount(new Button(), root, ["btn"]);
    settle();

    await enter(btn);
    await press(btn);
    expect(has(btn, "font_hover_pressed_color")).toBe(true);

    btn.disabled = true;
    runtime.invalidate(btn);
    await awaitFrames(1);
    expect(color(btn, "font_disabled_color")).toBe("#808080");
    // 合成 item 留着：控件重新可用且仍按住时不必等下一轮重算
    expect(has(btn, "font_hover_pressed_color")).toBe(true);

    btn.disabled = false;
    runtime.invalidate(btn);
    await awaitFrames(1);
    expect(has(btn, "font_disabled_color")).toBe(false);
    expect(color(btn, "font_hover_pressed_color")).toBe("#4d4d4d");
  });
});

/* ------------------------------------------------------------------ */

describe("伪类与 class / 样式表变化交叉", () => {
  it("悬停中改 class 使选择器失配：悬停 override 撤干净", async () => {
    runtime.addCss(`.btn:hover { color: rgb(50, 50, 50); }`);
    const btn = mount(new Button(), root, ["btn"]);
    settle();
    await enter(btn);
    expect(color(btn, "font_hover_color")).toBe("#323232");

    classes(btn).delete("btn");
    await awaitFrames(1);
    expect(has(btn, "font_hover_color")).toBe(false);
  });

  it("悬停中把 class 改回来：规则重新命中，悬停色立刻回来", async () => {
    runtime.addCss(`.btn:hover { color: rgb(50, 50, 50); }`);
    const btn = mount(new Button(), root, ["btn"]);
    settle();
    await enter(btn);
    classes(btn).delete("btn");
    await awaitFrames(1);
    expect(has(btn, "font_hover_color")).toBe(false);

    classes(btn).add("btn");
    await awaitFrames(1);
    // 状态没有重新发信号，靠的是 class 变化触发的重算：此刻节点仍挂着 :hover
    expect(color(btn, "font_hover_color")).toBe("#323232");
  });

  it("悬停中撤销整张样式表：所有状态 override 一并撤掉", async () => {
    const handle = runtime.addCss(`.btn:hover { color: rgb(60, 60, 60); background-color: rgb(60, 60, 60); }`);
    const btn = mount(new Button(), root, ["btn"]);
    settle();
    await enter(btn);
    expect(has(btn, "font_hover_color")).toBe(true);
    expect(btn.has_theme_stylebox_override("hover")).toBe(true);

    runtime.removeCss(handle);
    await awaitFrames(1);
    expect(has(btn, "font_hover_color")).toBe(false);
    expect(btn.has_theme_stylebox_override("hover")).toBe(false);
  });

  it("祖先悬停中，后代的 class 变化：后代样式跟着变", async () => {
    runtime.addCss(`.card:hover .title { color: rgb(70, 70, 70); }`);
    const card = mount(new PanelContainer(), root, ["card"]);
    const title = mount(new Label(), card, ["title"]);
    settle();
    await enter(card);
    expect(color(title, "font_color")).toBe("#464646");

    classes(title).delete("title");
    await awaitFrames(1);
    expect(has(title, "font_color")).toBe(false);

    classes(title).add("title");
    await awaitFrames(1);
    expect(color(title, "font_color")).toBe("#464646");
  });

  it("祖先悬停中新增后代：新节点直接拿到悬停态的样式", async () => {
    runtime.addCss(`.card:hover .title { color: rgb(71, 71, 71); }`);
    const card = mount(new PanelContainer(), root, ["card"]);
    settle();
    await enter(card);

    const late = mount(new Label(), card, ["title"]);
    await awaitFrames(1);
    expect(color(late, "font_color")).toBe("#474747");
  });

  it("同 class 的多个节点：一个悬停不牵连另一个", async () => {
    runtime.addCss(`.btn:hover { color: rgb(80, 80, 80); }`);
    const a = mount(new Button(), root, ["btn"]);
    const b = mount(new Button(), root, ["btn"]);
    settle();

    await enter(a);
    expect(color(a, "font_hover_color")).toBe("#505050");
    expect(has(b, "font_hover_color")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe("结构变化时的状态收敛", () => {
  it("悬停中的节点被摘走：祖先不留在悬停态，挂回来后可以再次悬停", async () => {
    runtime.addCss(`.row { background-color: rgb(255, 255, 255); }`);
    runtime.addCss(`.row:hover { background-color: rgb(1, 2, 3); }`);
    const rowA = mount(new PanelContainer(), root, ["row"]);
    const rowB = mount(new PanelContainer(), root, ["row"]);
    const box = mount(new CheckBox(), rowA);
    settle();

    await enter(box);
    expect(boxHex(rowA, "panel")).toBe("#010203");

    rowA.remove_child(box);
    await awaitFrames(1);
    expect(boxHex(rowA, "panel")).toBe("#ffffff");

    rowB.add_child(box);
    await awaitFrames(1);
    await enter(box);
    expect(boxHex(rowB, "panel")).toBe("#010203");
    expect(boxHex(rowA, "panel")).toBe("#ffffff");
  });

  it("悬停中的容器整体移出树：容器自身与祖先一起退出悬停", async () => {
    runtime.addCss(`.outer:hover { background-color: rgb(5, 5, 5); }`);
    const outer = mount(new VBoxContainer(), root, ["outer"]);
    const inner = mount(new PanelContainer(), outer);
    const kid = mount(new Label(), inner);
    settle();

    await enter(kid);
    expect((outer as unknown as { cssPseudoClasses?: Set<string> }).cssPseudoClasses?.has("hover")).toBe(true);

    root.remove_child(outer);
    await awaitFrames(1);
    expect((outer as unknown as { cssPseudoClasses?: Set<string> }).cssPseudoClasses?.has("hover")).toBe(false);
  });

  it("重新挂回后伪类信号仍在：不需要重新 attach 也能再次进入悬停", async () => {
    runtime.addCss(`.btn:hover { color: rgb(12, 12, 12); }`);
    const holder = mount(new VBoxContainer(), root);
    const btn = mount(new Button(), holder, ["btn"]);
    settle();

    holder.remove_child(btn);
    await awaitFrames(1);
    holder.add_child(btn);
    await awaitFrames(1);

    await enter(btn);
    expect(color(btn, "font_hover_color")).toBe("#0c0c0c");
  });
});
