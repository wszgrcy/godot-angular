import { beforeEach, describe, expect, it } from "vitest";
import { Button, CheckBox, Label, type Control } from "godot";
import { StyleRuntime } from "godot-angular/core";
import { awaitFrames, makeRenderer } from "godot-angular/testing";

let runtime: StyleRuntime;
let root: Control;

beforeEach(() => {
  runtime = new StyleRuntime();
  root = makeRenderer().root;
});

/** 构造一个已纳入级联、带 class 的节点 */
function make<T extends Control>(node: T, cls: string): T {
  root.add_child(node);
  runtime.attach(node);
  (node as unknown as { cssClasses: Set<string> }).cssClasses.add(cls);
  runtime.flush();
  return node;
}

describe("hover", () => {
  it("mouse_entered → hover 值生效；mouse_exited → 撤干净", async () => {
    runtime.addCss(`.btn:hover { background-color: rgb(255, 0, 0); color: rgb(255, 255, 0); }`);
    const btn = make(new Button(), "btn");
    expect(btn.has_theme_stylebox_override("hover")).toBe(false);

    btn.emit_signal("mouse_entered");
    await awaitFrames(1);
    expect(btn.has_theme_stylebox_override("hover")).toBe(true);
    // 颜色也需要写状态变体：引擎 hover 时读取的是 font_hover_color，写 font_color 不会显示
    expect(btn.has_theme_color_override("font_hover_color")).toBe(true);
    expect(btn.has_theme_color_override("font_color")).toBe(false);

    btn.emit_signal("mouse_exited");
    await awaitFrames(1);
    expect(btn.has_theme_stylebox_override("hover")).toBe(false);
    expect(btn.has_theme_color_override("font_hover_color")).toBe(false);
  });

  it("值没变但 item 换了，也要重写（diff 不能只比值）", async () => {
    // 普通态与 hover 态使用同一个颜色：只比较 value 会判定“没变化”而跳过，
    // 结果 hover 盒始终未被写入，引擎继续绘制它自身的——看着像 CSS 未生效
    runtime.addCss(`.btn { background-color: rgb(0, 0, 255); }`);
    runtime.addCss(`.btn:hover { background-color: rgb(0, 0, 255); }`);
    const btn = make(new Button(), "btn");
    expect(btn.has_theme_stylebox_override("normal")).toBe(true);
    expect(btn.has_theme_stylebox_override("hover")).toBe(false);

    btn.emit_signal("mouse_entered");
    await awaitFrames(1);
    expect(btn.has_theme_stylebox_override("hover")).toBe(true);
  });

  it("样式表没写 :hover 时，emit 不产生任何写入（引擎自己画）", async () => {
    runtime.addCss(`.btn { background-color: rgb(0, 0, 255); }`);
    const btn = make(new Button(), "btn");
    const before = runtime.cascade.stats.applied;

    btn.emit_signal("mouse_entered");
    await awaitFrames(1);
    expect(runtime.cascade.stats.applied).toBe(before);
    expect(btn.has_theme_stylebox_override("hover")).toBe(false);
  });

  it("懒订阅：样式表不含伪类时不连信号", async () => {
    runtime.addCss(`.btn { color: rgb(1, 2, 3); }`);
    const btn = make(new Button(), "btn");
    expect(runtime.cascade.usedPseudoClasses().size).toBe(0);
    // has_connections 是引擎的真实情况：未连接才说明“懒绑定”确实未发生
    expect(btn.has_connections("mouse_entered")).toBe(false);
  });

  it("样式表后登记（节点已创建）也要补连信号", async () => {
    runtime.addCss(`.btn { color: rgb(1, 2, 3); }`);
    const btn = make(new Button(), "btn");
    expect(btn.has_connections("mouse_entered")).toBe(false);

    runtime.addCss(`.btn:hover { background-color: rgb(9, 9, 9); }`);
    expect(btn.has_connections("mouse_entered")).toBe(true);
    btn.emit_signal("mouse_entered");
    await awaitFrames(1);
    expect(btn.has_theme_stylebox_override("hover")).toBe(true);
  });
});

describe("focus / active / checked", () => {
  it("focus_entered / focus_exited", async () => {
    runtime.addCss(`.btn:focus { color: rgb(0, 255, 0); }`);
    const btn = make(new Button(), "btn");
    btn.emit_signal("focus_entered");
    await awaitFrames(1);
    expect(btn.has_theme_color_override("font_focus_color")).toBe(true);
    btn.emit_signal("focus_exited");
    await awaitFrames(1);
    expect(btn.has_theme_color_override("font_focus_color")).toBe(false);
  });

  it("button_down / button_up → :active 落到 pressed 盒", async () => {
    runtime.addCss(`.btn:active { background-color: rgb(3, 3, 3); }`);
    const btn = make(new Button(), "btn");
    btn.emit_signal("button_down");
    await awaitFrames(1);
    expect(btn.has_theme_stylebox_override("pressed")).toBe(true);
    btn.emit_signal("button_up");
    await awaitFrames(1);
    expect(btn.has_theme_stylebox_override("pressed")).toBe(false);
  });

  it("同时 hover + 按下时按优先级写合成 item（pressed 盖 hover）", async () => {
    runtime.addCss(`.btn:hover { color: rgb(0, 255, 0); }`);
    runtime.addCss(`.btn:active { color: rgb(255, 0, 0); }`);
    const btn = make(new Button(), "btn");
    btn.emit_signal("mouse_entered");
    btn.emit_signal("button_down");
    await awaitFrames(1);
    // Button 有 font_hover_pressed_color，两个状态同时成立时引擎读取的就是它
    expect(btn.has_theme_color_override("font_hover_pressed_color")).toBe(true);
  });

  it("CheckBox.toggled → :checked", async () => {
    runtime.addCss(`.cb:checked { color: rgb(0, 255, 255); }`);
    const cb = make(new CheckBox(), "cb");
    cb.emit_signal("toggled", true);
    await awaitFrames(1);
    // CheckBox 没有 checked 颜色变体，退回基 item（引擎绘制使用的就是它）
    expect(cb.has_theme_color_override("font_color")).toBe(true);
    cb.emit_signal("toggled", false);
    await awaitFrames(1);
    expect(cb.has_theme_color_override("font_color")).toBe(false);
  });

  it("没有推送通道的状态不假装自动：:disabled 靠 class 通道或手动驱动", async () => {
    // Godot 的 property_list_changed 是编辑器通知，运行时修改 disabled 不会触发，
    // 因此此处**不能**期望 `btn.disabled = true` 就将 :disabled 打开（虚假可用比不支持更具误导性）。
    runtime.addCss(`.btn.disabled { color: rgb(128, 128, 128); }`);
    const btn = make(new Button(), "btn");
    expect(btn.has_theme_color_override("font_color")).toBe(false);

    (btn as unknown as { cssClasses: Set<string> }).cssClasses.add("disabled");
    await awaitFrames(1);
    expect(btn.has_theme_color_override("font_color")).toBe(true);

    (btn as unknown as { cssClasses: Set<string> }).cssClasses.delete("disabled");
    await awaitFrames(1);
    expect(btn.has_theme_color_override("font_color")).toBe(false);
  });

  it("状态变体 item：disabled 状态写 font_disabled_color（手动驱动也能用）", async () => {
    runtime.addCss(`.btn:disabled { color: rgb(128, 128, 128); }`);
    const btn = make(new Button(), "btn");
    runtime.setPseudoClass(btn, "disabled", true);
    await awaitFrames(1);
    expect(btn.has_theme_color_override("font_disabled_color")).toBe(true);
    runtime.setPseudoClass(btn, "disabled", false);
    await awaitFrames(1);
    expect(btn.has_theme_color_override("font_disabled_color")).toBe(false);
  });
});

describe("teardown", () => {
  it("detach 之后 emit 不报错、也不再写样式", async () => {
    runtime.addCss(`.btn:hover { background-color: rgb(255, 0, 0); }`);
    const btn = make(new Button(), "btn");
    expect(btn.has_connections("mouse_entered")).toBe(true);

    runtime.detach(btn);
    expect(btn.has_connections("mouse_entered")).toBe(false);
    btn.emit_signal("mouse_entered");
    await awaitFrames(1);
    expect(btn.has_theme_stylebox_override("hover")).toBe(false);
  });

  it("节点 free 之后再 flush 不炸（连接随节点一起没了）", async () => {
    runtime.addCss(`.btn:hover { background-color: rgb(255, 0, 0); }`);
    const btn = make(new Button(), "btn");
    const other = make(new Button(), "btn");

    btn.emit_signal("mouse_entered"); // free 之前先把它送进脏集合
    btn.free();
    // 另留一个脏节点：脏集合为空时 flush 直接 return，没有它这条用例又是空的
    other.emit_signal("mouse_entered");

    // 帧钟会把 rAF 回调里的异常吞成 console.error，不接住的话抛异常也不会让用例失败
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...a: unknown[]) => errors.push(a.map(String).join(" "));
    try {
      runtime.flush();
      await awaitFrames(2);
    } finally {
      console.error = originalError;
    }
    expect(errors, `free 之后 flush 撞上了已释放节点：${errors.join(" | ")}`).toEqual([]);
    // flush 确实跑了而不是提前返回：另一个节点的 hover 已写入
    expect(other.has_theme_stylebox_override("hover")).toBe(true);
  });
});

describe("没有信号来源的伪类", () => {
  it("手动 setPseudoClass 是正路，一样走级联", async () => {
    runtime.addCss(`.field:valid { color: rgb(0, 255, 0); }`);
    const label = make(new Label(), "field");
    runtime.setPseudoClass(label, "valid", true);
    await awaitFrames(1);
    expect(label.get_theme_color("font_color").g).toBeCloseTo(1, 3);
    runtime.setPseudoClass(label, "valid", false);
    await awaitFrames(1);
    expect(label.has_theme_color_override("font_color")).toBe(false);
  });
});
