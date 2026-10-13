import { describe, expect, it } from "vitest";
import { Button, Callable, ClassDB, Color, Label, VBoxContainer } from "godot";
import godotDefault from "godot";
import * as godotNs from "godot";

describe("真节点树", () => {
  it("add_child 后 get_child_count / get_index 与顺序一致", () => {
    const box = new VBoxContainer();
    const a = new Label();
    const b = new Label();
    a.name = "a";
    b.name = "b";
    box.add_child(a);
    box.add_child(b);
    expect(box.get_child_count()).toBe(2);
    expect(a.get_index()).toBe(0);
    expect(b.get_index()).toBe(1);
    expect(box.get_child(1).name).toBe("b");
    box.free();
  });

  it("move_child 会改变 index", () => {
    const box = new VBoxContainer();
    const a = new Label();
    const b = new Label();
    box.add_child(a);
    box.add_child(b);
    box.move_child(b, 0);
    expect(b.get_index()).toBe(0);
    expect(a.get_index()).toBe(1);
    box.free();
  });

  it("queue_free 之后 is_queued_for_deletion 为真", () => {
    const label = new Label();
    expect(label.is_queued_for_deletion()).toBe(false);
    label.queue_free();
    expect(label.is_queued_for_deletion()).toBe(true);
  });
});

describe("真属性与 ClassDB", () => {
  it("Label.text 可读写", () => {
    const label = new Label();
    label.text = "hello";
    expect(label.text).toBe("hello");
    label.free();
  });

  it("theme override 写入后 has_theme_*_override 为真", () => {
    const label = new Label();
    label.add_theme_color_override("font_color", new Color(1, 0, 0, 1));
    label.add_theme_font_size_override("font_size", 24);
    expect(label.has_theme_color_override("font_color")).toBe(true);
    expect(label.has_theme_font_size_override("font_size")).toBe(true);
    label.remove_theme_color_override("font_color");
    expect(label.has_theme_color_override("font_color")).toBe(false);
    label.free();
  });

  it("ClassDB 能列出 Button 的 pressed 信号", () => {
    const list = ClassDB.class_get_signal_list("Button");
    const names: string[] = [];
    for (const entry of list as Iterable<any>) names.push(String(entry.get("name")));
    expect(names).toContain("pressed");
  });
});

describe("真信号桥接", () => {
  it("Callable.create 连上后 emit_signal 会回调", () => {
    const button = new Button();
    let hits = 0;
    const cb = Callable.create(button, () => {
      hits++;
    });
    button.connect("pressed", cb);
    button.emit_signal("pressed");
    expect(hits).toBe(1);
    button.disconnect("pressed", cb);
    button.emit_signal("pressed");
    expect(hits).toBe(1);
    button.free();
  });
});

describe("三种 import 写法共处一个 chunk", () => {
  it("具名：直接可用", () => {
    const label = new Label();
    expect(label.get_class()).toBe("Label");
    label.free();
    expect(ClassDB.class_exists("Label")).toBe(true);
  });

  it("default：拿到的就是模块对象本身", () => {
    const mod = godotDefault as unknown as Record<string, new () => any>;
    const ctor = mod.Label;
    expect(typeof ctor).toBe("function");
    const label = new ctor();
    expect(label.get_class()).toBe("Label");
    label.free();
    expect((godotDefault as unknown as Record<string, any>).ClassDB.class_exists("Label")).toBe(true);
  });

  it("namespace：同上", () => {
    const ctor = (godotNs as unknown as Record<string, new () => any>).Label;
    expect(typeof ctor).toBe("function");
    const label = new ctor();
    expect(label.get_class()).toBe("Label");
    label.free();
  });

  it("动态取类（default 路径）与具名取类是同一个构造器", () => {
    // godotClass() 使用的就是 default 绑定；此处固定它与具名 Label 未被拆为两份
    expect((godotDefault as unknown as Record<string, unknown>).Label).toBe(Label);
  });
});
