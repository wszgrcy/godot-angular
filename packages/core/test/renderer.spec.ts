import { beforeEach, describe, expect, it, vi } from "vitest";
import { setGodotHost } from "../src/godot-host";
import { GodotRenderer } from "../src/renderer";
import { createMockGodot, MockColor, MockNode, MockVector2 } from "./mock-godot";

const godot = createMockGodot();

function makeRenderer() {
  const root = new MockNode("Control");
  root.name = "AngularRoot";
  return { root, renderer: new GodotRenderer(root) };
}

beforeEach(() => {
  setGodotHost(godot);
});

describe("createElement", () => {
  it("标签 → 真实 Godot 类实例", () => {
    const { renderer } = makeRenderer();
    expect(renderer.createElement("Label").get_class()).toBe("Label");
    expect(renderer.createElement("VBoxContainer").get_class()).toBe("VBoxContainer");
  });

  it("认不出的标签降级为 VBoxContainer（裸 Control 不抱紧子节点会塌成 0 高）", () => {
    const { renderer } = makeRenderer();
    expect(renderer.createElement("ui-card").get_class()).toBe("VBoxContainer");
    expect(renderer.createElement("TotallyBogus").get_class()).toBe("VBoxContainer");
  });

  it("第一个创建的元素挂到入口给的 root 上（根组件宿主）", () => {
    const { root, renderer } = makeRenderer();
    const first = renderer.createElement("Label");
    expect(root.get_child(0)).toBe(first);
    const second = renderer.createElement("Label");
    expect(second.get_parent()).toBeNull();
  });
});

describe("文本与锚点", () => {
  it("文本节点是 Label", () => {
    const { renderer } = makeRenderer();
    const text = renderer.createText("hello");
    expect(text.get_class()).toBe("Label");
    expect(text.text).toBe("hello");
  });

  it("@if/@for 的锚点用非 Control 节点，容器布局会跳过它", () => {
    const { renderer } = makeRenderer();
    const anchor = renderer.createComment("anchor");
    expect(anchor.get_class()).toBe("Node");
    expect(renderer.createElement("Label").get_class()).not.toBe("Node");
  });

  it("setValue 改的是 text", () => {
    const { renderer } = makeRenderer();
    const label = renderer.createText("a");
    renderer.setValue(label, "b");
    expect(label.text).toBe("b");
  });
});

describe("树操作", () => {
  it("appendChild / insertBefore / removeChild 维护顺序", () => {
    const { renderer } = makeRenderer();
    const parent = renderer.createElement("VBoxContainer");
    const a = renderer.createText("a");
    const b = renderer.createText("b");
    const c = renderer.createText("c");
    renderer.appendChild(parent, a);
    renderer.appendChild(parent, b);
    renderer.insertBefore(parent, c, b);
    expect(parent.children.map((n) => n.text)).toEqual(["a", "c", "b"]);
    renderer.removeChild(parent, c);
    expect(parent.children.map((n) => n.text)).toEqual(["a", "b"]);
  });

  it("已有父节点时先摘再挂（引擎对重复 add_child 只打错误不抛异常）", () => {
    const { renderer } = makeRenderer();
    const p1 = renderer.createElement("VBoxContainer");
    const p2 = renderer.createElement("VBoxContainer");
    const child = renderer.createText("x");
    renderer.appendChild(p1, child);
    renderer.appendChild(p2, child);
    expect(p1.get_child_count()).toBe(0);
    expect(p2.get_child(0)).toBe(child);
  });

  it("parentNode / nextSibling", () => {
    const { renderer } = makeRenderer();
    const parent = renderer.createElement("VBoxContainer");
    const a = renderer.createText("a");
    const b = renderer.createText("b");
    renderer.appendChild(parent, a);
    renderer.appendChild(parent, b);
    expect(renderer.parentNode(a)).toBe(parent);
    expect(renderer.nextSibling(a)).toBe(b);
    expect(renderer.nextSibling(b)).toBeNull();
  });

  it("destroyNode 摘父并 queue_free", () => {
    const { renderer } = makeRenderer();
    const parent = renderer.createElement("VBoxContainer");
    const child = renderer.createText("x");
    renderer.appendChild(parent, child);
    renderer.destroyNode(child);
    expect(parent.get_child_count()).toBe(0);
    expect(child.is_queued_for_deletion()).toBe(true);
  });
});

describe("setProperty", () => {
  it("camelCase → snake_case", () => {
    const { renderer } = makeRenderer();
    const label = renderer.createText("x");
    renderer.setProperty(label, "horizontalAlignment", 1);
    expect(label.horizontal_alignment).toBe(1);
  });

  it("{x,y} 强制成 Vector2", () => {
    const { renderer } = makeRenderer();
    const label = renderer.createText("x");
    renderer.setProperty(label, "customMinimumSize", { x: 10, y: 40 });
    expect(label.custom_minimum_size).toBeInstanceOf(MockVector2);
    expect(label.custom_minimum_size.y).toBe(40);
  });

  it("[x, y] 数组也认", () => {
    const { renderer } = makeRenderer();
    const label = renderer.createText("x");
    renderer.setProperty(label, "size", [64, 32]);
    expect(label.size).toBeInstanceOf(MockVector2);
    expect(label.size.x).toBe(64);
  });

  it("sizeFlags 一次写横竖两个", () => {
    const { renderer } = makeRenderer();
    const label = renderer.createText("x");
    renderer.setProperty(label, "sizeFlags", 3);
    expect(label.size_flags_horizontal).toBe(3);
    expect(label.size_flags_vertical).toBe(3);
  });

  it("不存在的属性不写，并告警（GodotJS 会静默接受，不告警就是隐形 bug）", () => {
    const { renderer } = makeRenderer();
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const label = renderer.createText("x");
    renderer.setProperty(label, "nonexistentXyz", 5);
    expect((label as any).nonexistent_xyz).toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("ng-* 内部属性不透传给节点", () => {
    const { renderer } = makeRenderer();
    const label = renderer.createText("x");
    renderer.setAttribute(label, "ng-reflect-kwd", "y");
    expect((label as any).ng_reflect_kwd).toBeUndefined();
  });
});

describe("setStyle", () => {
  it("color → theme 覆盖", () => {
    const { renderer } = makeRenderer();
    const label = renderer.createText("x");
    renderer.setStyle(label, "color", "#ff8800");
    expect(label.has_theme_color_override("font_color")).toBe(true);
    expect(label.themeColorOverrides.get("font_color")).toBeInstanceOf(MockColor);
  });

  it("kebab-case 的 font-size 也能落到 theme（Angular 传的是 CSS 名）", () => {
    const { renderer } = makeRenderer();
    const label = renderer.createText("x");
    renderer.setStyle(label, "font-size", "28");
    expect(label.has_theme_font_size_override("font_size")).toBe(true);
    expect(label.themeFontSizeOverrides.get("font_size")).toBe(28);
  });

  it("width → custom_minimum_size", () => {
    const { renderer } = makeRenderer();
    const label = renderer.createText("x");
    renderer.setStyle(label, "width", "120px");
    expect(label.custom_minimum_size.x).toBe(120);
  });

  it("无 Godot 对应的样式告警而不是假装成功", () => {
    const { renderer } = makeRenderer();
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    renderer.setStyle(renderer.createText("x"), "display", "flex");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("listen（Godot 信号 → Angular 回调）", () => {
  it("(click) 接上 Button.pressed 并触发", () => {
    const { renderer } = makeRenderer();
    const button = new MockNode("Button");
    const calls: unknown[] = [];
    renderer.listen(button, "click", (v) => calls.push(v));
    button.emit_signal("pressed");
    expect(calls.length).toBe(1);
  });

  it("返回的卸载函数真的 disconnect（重复挂载不能双触发）", () => {
    const { renderer } = makeRenderer();
    const button = new MockNode("Button");
    const calls: unknown[] = [];
    const off = renderer.listen(button, "click", () => calls.push(1));
    button.emit_signal("pressed");
    off();
    button.emit_signal("pressed");
    expect(calls.length).toBe(1);
  });

  it("信号不存在时告警并返回空卸载函数", () => {
    const { renderer } = makeRenderer();
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const control = new MockNode("Control");
    const off = renderer.listen(control, "click", () => {});
    expect(() => off()).not.toThrow();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("LineEdit.text_changed 把字符串参数透传给回调", () => {
    const { renderer } = makeRenderer();
    const edit = new MockNode("LineEdit");
    let got = "";
    renderer.listen(edit, "input", (v) => (got = String(v)));
    edit.emit_signal("text_changed", "typed");
    expect(got).toBe("typed");
  });
});
