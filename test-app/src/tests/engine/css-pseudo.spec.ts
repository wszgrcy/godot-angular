import { beforeEach, describe, expect, it } from "vitest";
import { Button, CheckBox, Label, LineEdit, ItemList, Vector2, type Control, type StyleBoxFlat } from "godot";
import { CssCode } from "godot-angular/css";
import { GodotRenderer, StyleRuntime } from "godot-angular/core";
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

let runtime: StyleRuntime;
let root: Control;

beforeEach(() => {
  runtime = newStyleRuntime();
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
    // 普通态与 hover 态声明同一个颜色：只比较 value 会判定“没变化”而跳过，
    // 结果 font_hover_color 永远不写，引擎 hover 时继续画它自身的颜色——看着像 CSS 未生效
    runtime.addCss(`.btn { background-color: rgb(0, 0, 255); color: rgb(0, 0, 255); }`);
    runtime.addCss(`.btn:hover { background-color: rgb(0, 0, 255); color: rgb(0, 0, 255); }`);
    const btn = make(new Button(), "btn");
    expect(btn.has_theme_stylebox_override("normal")).toBe(true);
    expect(btn.has_theme_color_override("font_hover_color")).toBe(false);

    btn.emit_signal("mouse_entered");
    await awaitFrames(1);
    // 颜色的写入位置仍由选择器要求的状态决定：引擎 hover 时读的是 font_hover_color
    expect(btn.has_theme_color_override("font_hover_color")).toBe(true);
    expect((btn.get_theme_stylebox("hover") as StyleBoxFlat).bg_color.b).toBeCloseTo(1, 3);
  });

  it("没写 :hover 时：基规则声明过的字段必须贯穿到 hover 盒", async () => {
    // 层叠语义：作者没写 :hover 不等于“悬停时交给引擎”，而是“悬停时沿用基规则的全部声明”。
    // 几何不跟过去就会悬停即重排（v0.3.1 的回归）。
    runtime.addCss(`.btn { background-color: rgb(0, 0, 255); padding: 10px; border-radius: 6px; }`);
    const btn = make(new Button(), "btn");
    const before = runtime.cascade.stats.applied;
    const h0 = btn.get_minimum_size().y;

    btn.emit_signal("mouse_entered");
    await awaitFrames(1);
    // 没有新声明命中 → 本轮不应产生任何写入（几何在基规则写入时就已同步过了）
    expect(runtime.cascade.stats.applied).toBe(before);

    const hover = btn.get_theme_stylebox("hover") as StyleBoxFlat;
    expect(hover.content_margin_top).toBe(10);
    expect(hover.corner_radius_top_left).toBe(6);
    expect(hover.bg_color.b).toBeCloseTo(1, 3); // 作者声明了底色 → 悬停时仍是它（浏览器同样如此）
    expect(btn.get_minimum_size().y).toBe(h0); // 悬停不得改变最小尺寸
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

  it("button_down / button_up → :active 写入 pressed 盒", async () => {
    runtime.addCss(`.btn:active { background-color: rgb(3, 3, 3); }`);
    const btn = make(new Button(), "btn");
    btn.emit_signal("button_down");
    await awaitFrames(1);
    expect(btn.has_theme_stylebox_override("pressed")).toBe(true);
    btn.emit_signal("button_up");
    await awaitFrames(1);
    expect(btn.has_theme_stylebox_override("pressed")).toBe(false);
  });

  it("hover 与 active 各写自己的 item；合成 item 需要显式写组合选择器", async () => {
    runtime.addCss(`.btn:hover { color: rgb(0, 255, 0); }`);
    runtime.addCss(`.btn:active { color: rgb(255, 0, 0); }`);
    const btn = make(new Button(), "btn");
    btn.emit_signal("mouse_entered");
    btn.emit_signal("button_down");
    await awaitFrames(1);
    // 写入位置由选择器自身要求的状态决定：两条规则各写自己的 item，互不挤掉。
    // 引擎在 hover+pressed 时读 font_hover_pressed_color，那里没被写过 → 走主题默认；
    // 想要自定义的组合态颜色，就得显式写 .btn:hover:active（下面那条用例钉的就是这个）。
    expect(btn.has_theme_color_override("font_hover_color")).toBe(true);
    expect(btn.has_theme_color_override("font_pressed_color")).toBe(true);
    expect(btn.has_theme_color_override("font_hover_pressed_color")).toBe(false);
  });

  it("CheckBox 勾选 → :checked 写入 pressed 家族", async () => {
    runtime.addCss(`.cb:checked { color: rgb(0, 255, 255); }`);
    const cb = make(new CheckBox(), "cb");
    // 引擎的 button_pressed setter 会自己发 toggled（typings 里注明了），
    // 这里两者都写，不依赖“赋值是否发信号”这个实现细节
    cb.button_pressed = true;
    cb.emit_signal("toggled", true);
    await awaitFrames(1);
    // 开关控件在 button_pressed=true 时引擎读的是 font_pressed_color（与鼠标按下同一个 item），
    // 写 font_color 在勾选态根本不会显示——浅色主题下就是“勾选框白字看不见”的根因
    expect(cb.has_theme_color_override("font_pressed_color")).toBe(true);
    expect(cb.has_theme_color_override("font_color")).toBe(false);
    cb.button_pressed = false;
    cb.emit_signal("toggled", false);
    await awaitFrames(1);
    expect(cb.has_theme_color_override("font_pressed_color")).toBe(false);
  });

  it("勾选 + hover 写合成 item（CheckBox 有 hover_pressed 家族）", async () => {
    runtime.addCss(`.cb:hover:checked { color: rgb(0, 255, 255); }`);
    runtime.addCss(`.cb:hover:checked { background-color: rgb(0, 255, 255); }`);
    const cb = make(new CheckBox(), "cb");
    cb.button_pressed = true;
    cb.emit_signal("toggled", true);
    cb.emit_signal("mouse_entered");
    await awaitFrames(1);
    expect(cb.has_theme_color_override("font_hover_pressed_color")).toBe(true);
    expect(cb.has_theme_stylebox_override("hover_pressed")).toBe(true);
  });

  it("勾选与 hover 各写各的盒；引擎在勾选时只读 pressed", async () => {
    runtime.addCss(`.cb:hover { background-color: rgb(0, 255, 0); }`);
    runtime.addCss(`.cb:checked { background-color: rgb(255, 0, 0); }`);
    const btn = make(new Button(), "cb");
    btn.toggle_mode = true;
    btn.button_pressed = true;
    btn.emit_signal("toggled", true);
    btn.emit_signal("mouse_entered");
    await awaitFrames(1);
    expect(btn.has_theme_stylebox_override("pressed")).toBe(true);
    // hover 盒也写着：它服务的是「只悬停没勾选」那一面。引擎在勾选时走 DRAW_PRESSED，
    // 不会读它（上面 get_draw_mode 已实测），所以多写一个盒不会改变勾选态的外观。
    expect(btn.has_theme_stylebox_override("hover")).toBe(true);
  });

  it(":selected 写入 selected 盒与 font_selected_color（ItemList / Tree）", async () => {
    runtime.addCss(`.list:selected { color: rgb(0, 255, 255); }`);
    const list = make(new ItemList(), "list");
    runtime.setPseudoClass(list, "selected", true);
    await awaitFrames(1);
    expect(list.has_theme_color_override("font_selected_color")).toBe(true);
    runtime.setPseudoClass(list, "selected", false);
    await awaitFrames(1);
    expect(list.has_theme_color_override("font_selected_color")).toBe(false);
  });

  it("没有推送通道的状态不假装自动：:valid 这类靠 class 通道或手动驱动", async () => {
    // :valid 既无信号也无属性可推，因此不能假装它会自动生效（虚假可用比不支持更具误导性）。
    // :disabled / :checked / :read-only 不同，它们有属性可推，见下方“属性驱动的伪类”。
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

  it("状态变体 item：disabled 属性驱动 font_disabled_color", async () => {
    runtime.addCss(`.btn:disabled { color: rgb(128, 128, 128); }`);
    const btn = make(new Button(), "btn");
    // disabled 没有变更信号，所以下面要手动 invalidate（渲染器与表单指令已经做了这一步）
    btn.disabled = true;
    runtime.invalidate(btn);
    await awaitFrames(1);
    expect(btn.has_theme_color_override("font_disabled_color")).toBe(true);
    btn.disabled = false;
    runtime.invalidate(btn);
    await awaitFrames(1);
    expect(btn.has_theme_color_override("font_disabled_color")).toBe(false);
  });
});

describe("属性驱动的伪类", () => {
  /**
   * button_pressed / disabled / editable 在 Godot 里没有变更信号（property_list_changed 是
   * 编辑器通知），所以（1）写入方标脏（2）级联重算前读属性。渲染器与表单指令就是那两个写入方。
   */
  function viaRenderer(): GodotRenderer {
    return new GodotRenderer(root, runtime);
  }

  it("渲染器写 button_pressed → :checked（创建时就勾选的控件）", async () => {
    runtime.addCss(`.cb:checked { color: rgb(0, 255, 255); }`);
    const renderer = viaRenderer();
    const cb = renderer.createElement("CheckBox") as CheckBox;
    renderer.addClass(cb, "cb");
    // 只写属性，不发 toggled：这正是 [button_pressed]="true" 的行为
    renderer.setProperty(cb, "button_pressed", true);
    await awaitFrames(1);
    expect(cb.has_theme_color_override("font_pressed_color")).toBe(true);

    renderer.setProperty(cb, "button_pressed", false);
    await awaitFrames(1);
    expect(cb.has_theme_color_override("font_pressed_color")).toBe(false);
  });

  it("渲染器写 disabled → :disabled", async () => {
    runtime.addCss(`.btn:disabled { color: rgb(128, 128, 128); }`);
    const renderer = viaRenderer();
    const btn = renderer.createElement("Button") as Button;
    renderer.addClass(btn, "btn");
    renderer.setProperty(btn, "disabled", true);
    await awaitFrames(1);
    expect(btn.has_theme_color_override("font_disabled_color")).toBe(true);

    renderer.setProperty(btn, "disabled", false);
    await awaitFrames(1);
    expect(btn.has_theme_color_override("font_disabled_color")).toBe(false);
  });

  it("重复写同一个状态属性不再标脏（Forms 的 setDisabledState 是无条件写的）", async () => {
    runtime.addCss(`.btn:disabled { color: rgb(128, 128, 128); }`);
    const renderer = viaRenderer();
    const btn = renderer.createElement("Button") as Button;
    renderer.addClass(btn, "btn");
    renderer.setProperty(btn, "disabled", true);
    await awaitFrames(1);
    expect(btn.has_theme_color_override("font_disabled_color")).toBe(true);

    // 值没变：写入与标脏一起跳过。标脏会连带子树与兄弟（样式表含组合器时），
    // 不该为一次空写入换一整轮重算
    renderer.setProperty(btn, "disabled", true);
    expect(runtime.isDirty(btn)).toBe(false);

    // 值变了仍旧要标脏，别把护栏做成失效
    renderer.setProperty(btn, "disabled", false);
    expect(runtime.isDirty(btn)).toBe(true);
    await awaitFrames(1);
    expect(btn.has_theme_color_override("font_disabled_color")).toBe(false);
  });

  it("toggle_mode=false 的 Button 存不住 button_pressed → :checked 不开", async () => {
    runtime.addCss(`.tab:checked { color: rgb(0, 255, 255); }`);
    const renderer = viaRenderer();
    const tab = renderer.createElement("Button") as Button;
    renderer.addClass(tab, "tab");
    renderer.setProperty(tab, "button_pressed", true);
    await awaitFrames(1);

    // 引擎自己就在 setter 里做了门控（is_pressed() = toggle_mode && button_pressed）：
    // toggle_mode=false 时写 true 也存不住，读回来就是 false
    expect(tab.button_pressed).toBe(false);
    expect(tab.get_draw_mode()).toBe(0); // DRAW_NORMAL
    expect(tab.has_theme_color_override("font_pressed_color")).toBe(false);

    // 先开 toggle_mode 再写 button_pressed，才是开关控件的正确写法
    const toggle = renderer.createElement("Button") as Button;
    renderer.addClass(toggle, "tab");
    renderer.setProperty(toggle, "toggle_mode", true);
    renderer.setProperty(toggle, "button_pressed", true);
    await awaitFrames(1);
    expect(toggle.has_theme_color_override("font_pressed_color")).toBe(true);
  });

  it("editable=false → :read-only（写入 read_only 盒）", async () => {
    runtime.addCss(`.field:read-only { background-color: rgb(20, 20, 20); }`);
    const renderer = viaRenderer();
    const edit = renderer.createElement("LineEdit") as LineEdit;
    renderer.addClass(edit, "field");
    renderer.setProperty(edit, "editable", false);
    await awaitFrames(1);
    expect(edit.has_theme_stylebox_override("read_only")).toBe(true);

    renderer.setProperty(edit, "editable", true);
    await awaitFrames(1);
    expect(edit.has_theme_stylebox_override("read_only")).toBe(false);
  });

  it(":readonly 不是 CSS 伪类：名单外就是名单外，不当同义词收下", async () => {
    // CSS 规范里只有 :read-only。默默兼容 `:readonly` 会把拼错永久吞掉：
    // 选择器不命中与“状态未触发”在现象上完全一样，只能靠告警区分
    resetWarnOnce();
    const captured = captureWarn(() => runtime.addCss(`.field:readonly { background-color: rgb(20, 20, 20); }`));
    // 解析期告警自带码：名单外的伪类就是 PseudoUnsupported，具体是哪个伪类看文案
    expectWarnCode(captured.warn, CssCode.PseudoUnsupported);
    expect(captured.warn.warnings.join("\n")).toContain(":readonly");

    const edit = make(new LineEdit(), "field");
    edit.editable = false;
    runtime.invalidate(edit);
    await awaitFrames(1);
    expect(edit.has_theme_stylebox_override("read_only")).toBe(false);
  });

  it("不发信号的属性写入：invalidate 后帧末从属性读回来", async () => {
    runtime.addCss(`.cb:checked { color: rgb(0, 255, 255); }`);
    const cb = make(new CheckBox(), "cb");
    // set_pressed_no_signal 不发 toggled（typings 里注明了），也没有任何写入方标脏：
    // 这就是“直接对节点赋值”那条路，必须自行 invalidate
    cb.set_pressed_no_signal(true);
    runtime.flush(); // 脏集合为空，此处不应提前生效
    expect(cb.has_theme_color_override("font_pressed_color")).toBe(false);
    runtime.invalidate(cb);
    await awaitFrames(1);
    expect(cb.has_theme_color_override("font_pressed_color")).toBe(true);
  });

  it("样式表没用到该伪类时，属性写入不会开任何状态", async () => {
    runtime.addCss(`.cb { color: rgb(0, 255, 255); }`);
    const cb = make(new CheckBox(), "cb");
    cb.button_pressed = true;
    runtime.invalidate(cb);
    await awaitFrames(1);
    // 基 item 仍然只写 font_color：没写 :checked 规则时库不会替引擎补状态色
    expect(cb.has_theme_color_override("font_color")).toBe(true);
    expect(cb.has_theme_color_override("font_pressed_color")).toBe(false);
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

/**
 * 状态优先级不是我们定的，是引擎 `BaseButton.get_draw_mode()` 定的。
 * 直接问引擎要答案，比读源码记忆可靠：这里把「多状态同时成立时引擎画哪一支」钉成断言，
 * STATE_PRIORITY 的顺序必须与之一致，否则样式写进了引擎根本不读的 item。
 */
describe("引擎绘制优先级（get_draw_mode 实测）", () => {
  it("disabled 压过 pressed：引擎画的是 disabled 那一支", () => {
    const btn = new CheckBox();
    root.add_child(btn);
    btn.button_pressed = true;
    expect(btn.get_draw_mode()).toBe(1); // DRAW_PRESSED
    btn.disabled = true;
    // DRAW_DISABLED：勾选与 hover 全部让位。hover_pressed 那一支靠真实指针验证，
    // 见本文件末尾的“悬停合成态的真实绘制（有头）”（无头下移动不了指针，那组会自动跳过）
    expect(btn.get_draw_mode()).toBe(3);
  });

  it("disabled 生效时写 disabled 那一支；pressed 的 item 不会被读到", async () => {
    runtime.addCss(`.cb:disabled { color: rgb(128, 128, 128); }`);
    runtime.addCss(`.cb:checked { color: rgb(0, 255, 255); }`);
    const cb = make(new CheckBox(), "cb");
    cb.button_pressed = true;
    cb.disabled = true;
    runtime.invalidate(cb);
    await awaitFrames(1);
    expect(cb.has_theme_color_override("font_disabled_color")).toBe(true);
    // :checked 的 item 也写着，但引擎此时走 DRAW_DISABLED（上面已实测），不会读它；
    // 留着它的好处是：控件重新可用且仍按住时，勾选色已经在位，不需要等下一轮重算。
    expect(cb.has_theme_color_override("font_pressed_color")).toBe(true);
  });
});

/**
 * 写入位置分两套口径，这里钉住它们的分界：
 * - **颜色**：只重定向「自己要求了该状态」的声明。基规则的 `color` 永远写 `font_color`，
 *   不能被顶进 `font_disabled_color`（那条 override 属于 `:disabled` 规则，基规则没资格写）。
 * - **stylebox**：基规则声明过的字段必须贯穿所有状态（层叠）。因此 `.btn { background-color: 蓝 }`
 *   会让禁用盒也是蓝的——与浏览器一致（作者写了 background，UA 的禁用底色就被覆盖）；
 *   想要专属禁用外观必须显式写 `:disabled`。
 */
describe("基规则不被状态顶掉", () => {
  it("禁用时基规则仍写 font_color，不顶进 font_disabled_color", async () => {
    runtime.addCss(`.btn { background-color: rgb(0, 0, 255); color: rgb(0, 255, 255); }`);
    const btn = make(new Button(), "btn");
    btn.disabled = true;
    runtime.invalidate(btn);
    await awaitFrames(1);
    expect(btn.has_theme_stylebox_override("normal")).toBe(true);
    expect(btn.has_theme_color_override("font_color")).toBe(true);
    expect(btn.has_theme_color_override("font_disabled_color")).toBe(false);
    // stylebox 走另一套：基规则声明过的字段贯穿到 disabled 盒
    expect((btn.get_theme_stylebox("disabled") as StyleBoxFlat).bg_color.b).toBeCloseTo(1, 3);
  });

  it("hover 时基规则仍写 font_color", async () => {
    runtime.addCss(`.btn { color: rgb(0, 255, 255); }`);
    const btn = make(new Button(), "btn");
    btn.emit_signal("mouse_entered");
    await awaitFrames(1);
    expect(btn.has_theme_color_override("font_color")).toBe(true);
    expect(btn.has_theme_color_override("font_hover_color")).toBe(false);
  });

  it("同一条属性上，带状态的声明胜出时才写状态 item", async () => {
    runtime.addCss(`.btn { color: rgb(0, 255, 255); }`);
    runtime.addCss(`.btn:disabled { color: rgb(128, 128, 128); }`);
    const btn = make(new Button(), "btn");
    expect(btn.has_theme_color_override("font_color")).toBe(true);

    btn.disabled = true;
    runtime.invalidate(btn);
    await awaitFrames(1);
    // :disabled 特异度更高 → 胜出的声明要求了状态，改写 font_disabled_color
    expect(btn.has_theme_color_override("font_disabled_color")).toBe(true);

    btn.disabled = false;
    runtime.invalidate(btn);
    await awaitFrames(1);
    // 重新可用后回到基 item：每个状态各占一个 item，引擎自己挑该读哪个
    expect(btn.get_theme_color("font_color").b).toBeCloseTo(1, 3);
  });
});

/**
 * `hover_pressed` 这一支的真实绘制。
 *
 * 上面的用例靠 `emit_signal` 伪造状态，能证明「我们往对的 item 里写了值」，但证明不了
 * 「引擎在这个状态下真的会读那个 item」——`get_draw_mode` 那组就留了这个缺口（无头下
 * 移动不了指针）。有头下可以把指针真的移到控件上，由引擎自己决定画哪一支。
 *
 * 颜色取纯原色 / 二次色：UI 颜色要经过 sRGB 与线性空间来回转换，只有 0 与 1 两个端点
 * 转换后不变，中间值读回来会偏移。
 */
describe.skipIf(!isHeaded())("悬停合成态的真实绘制（有头）", () => {
  const GREEN: readonly [number, number, number] = [0, 1, 0];
  const YELLOW: readonly [number, number, number] = [1, 1, 0];

  /** 控件默认 0x0，像素断言需要实际的画面面积 */
  const place = (node: Control): void => {
    node.position = new Vector2(40, 40);
    node.size = new Vector2(200, 60);
  };

  it("勾选后真实悬停：画的是 hover_pressed 那一支", async () => {
    runtime.addCss(`.cb:checked { background-color: rgb(0, 255, 0); }`);
    runtime.addCss(`.cb:hover:checked { background-color: rgb(255, 255, 0); }`);
    const cb = make(new CheckBox(), "cb");
    cb.button_pressed = true;
    place(cb);
    runtime.invalidate(cb);
    const screen = Screen.attach(root);

    await screen.moveMouseAway();
    // 只勾选没悬停：引擎走 DRAW_PRESSED，读的是 checked 那一支
    expect(await screen.waitForColor(cb, GREEN)).toBe(true);
    expect(screen.hasColor(cb, YELLOW)).toBe(false);

    await screen.hover(cb);
    // 引擎走 DRAW_HOVER_PRESSED：只有真的把 hover_pressed 写对了才会变黄
    expect(await screen.waitForColor(cb, YELLOW)).toBe(true);
  });

  it("悬停后取消勾选：退回 hover 那一支", async () => {
    runtime.addCss(`.cb:hover { background-color: rgb(0, 0, 255); }`);
    runtime.addCss(`.cb:hover:checked { background-color: rgb(255, 255, 0); }`);
    const cb = make(new CheckBox(), "cb");
    cb.button_pressed = true;
    place(cb);
    runtime.invalidate(cb);
    const screen = Screen.attach(root);

    await screen.hover(cb);
    expect(await screen.waitForColor(cb, YELLOW)).toBe(true);

    cb.button_pressed = false;
    runtime.invalidate(cb);
    expect(await screen.waitForColor(cb, [0, 0, 1])).toBe(true);
    expect(screen.hasColor(cb, YELLOW)).toBe(false);
  });
});
