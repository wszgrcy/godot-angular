import { describe, expect, it } from "vitest";
import { Color, Control, Label, Theme, Vector2 } from "godot";
import { captureWarn, childNodes, expectWarned, makeRenderer } from "godot-angular/testing";

/** 真 Vector2 才有的方法，用它区分"真 Vector2"和"普通 {x,y}" */
function isVector2(v: any): boolean {
  return !!v && typeof v.normalized === "function";
}

describe("createElement", () => {
  it("标签 → 真实 Godot 类实例", () => {
    const { renderer } = makeRenderer();
    expect(renderer.createElement("Label").get_class()).toBe("Label");
    expect(renderer.createElement("VBoxContainer").get_class()).toBe("VBoxContainer");
  });

  it("认不出的标签降级为 VBoxContainer", () => {
    const { renderer } = makeRenderer();
    expect(renderer.createElement("ui-card").get_class()).toBe("VBoxContainer");
    expect(renderer.createElement("TotallyBogus").get_class()).toBe("VBoxContainer");
  });

  it("非 Control 但是节点的类（Node / Node3D）照建，值类型（Color）仍降级", () => {
    const { renderer } = makeRenderer();
    expect(renderer.createElement("Node").get_class()).toBe("Node");
    expect(renderer.createElement("Node3D").get_class()).toBe("Node3D");
    const { warn } = captureWarn(() => {
      expect(renderer.createElement("Color").get_class()).toBe("VBoxContainer");
    });
    expectWarned(warn);
  });

  it("createElement 只创建，不挂载：位置由后面的 appendChild / insertBefore 决定", () => {
    // 根组件的宿主另有来路（Angular 递 selector 给 selectRootElement，返回入口 root），
    // 因此 createElement 无论第几个都只负责造节点，不能自行挂到 root 上。
    const { root, renderer } = makeRenderer();
    const first = renderer.createElement("Label");
    const second = renderer.createElement("Label");
    expect(first.get_parent()).toBeNull();
    expect(second.get_parent()).toBeNull();
    expect(root.get_child_count()).toBe(0);

    renderer.appendChild(root, second);
    expect(root.get_child(0)).toBe(second);
  });

  /** 根组件的宿主另有来路：Angular 把 selector 递给 selectRootElement，而不是靠 createElement 挂载 */
  it("selectRootElement 就是入口 root，且不往上面塞子节点", () => {
    const { root, renderer } = makeRenderer();
    expect(renderer.selectRootElement()).toBe(root);
    expect(root.get_child_count()).toBe(0);
  });
});

describe("文本与锚点", () => {
  it("文本节点是 Label", () => {
    const { renderer } = makeRenderer();
    expect(renderer.createText("hello").get_class()).toBe("Label");
    expect((renderer.createText("hello") as Label).text).toBe("hello");
  });

  it("@if/@for 的锚点用非 Control 节点，容器布局会跳过它", () => {
    const { renderer } = makeRenderer();
    expect(renderer.createComment("anchor").get_class()).toBe("Node");
    expect(renderer.createElement("Label").get_class()).not.toBe("Node");
  });

  it("setValue 改的是 text", () => {
    const { renderer } = makeRenderer();
    const label = renderer.createText("a") as Label;
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
    expect(childNodes<Label>(parent).map((n) => n.text)).toEqual(["a", "c", "b"]);
    renderer.removeChild(parent, c);
    expect(childNodes<Label>(parent).map((n) => n.text)).toEqual(["a", "b"]);
  });

  it("insertBefore 同父内往后搬：依旧写在参照之前（@for 重排走的就是这条）", () => {
    const { renderer } = makeRenderer();
    const box = renderer.createElement("VBoxContainer");
    const a = renderer.createText("a");
    const x = renderer.createText("x");
    const b = renderer.createText("b");
    const c = renderer.createText("c");
    const texts = () => childNodes<Label>(box).map((n) => n.text);
    for (const n of [a, x, b, c]) renderer.appendChild(box, n);
    expect(texts()).toEqual(["a", "x", "b", "c"]);

    // x 往后搬：move_child 是“摘出后按新列表插”，索引不修正就会写入 c 后面
    renderer.insertBefore(box, x, c);
    expect(texts()).toEqual(["a", "b", "x", "c"]);

    renderer.insertBefore(box, a, c); // 再往前搬，两个方向都要对
    expect(texts()).toEqual(["b", "x", "a", "c"]);
  });

  it("insertBefore 跳父：先摘旧父，再写入新父的参照之前", () => {
    const { renderer } = makeRenderer();
    const from = renderer.createElement("VBoxContainer");
    const to = renderer.createElement("VBoxContainer");
    const keep = renderer.createText("keep");
    const moved = renderer.createText("moved");
    const tail = renderer.createText("tail");
    renderer.appendChild(from, moved);
    renderer.appendChild(to, keep);
    renderer.appendChild(to, tail);

    renderer.insertBefore(to, moved, tail);
    expect(from.get_child_count()).toBe(0);
    expect(childNodes<Label>(to).map((n) => n.text)).toEqual(["keep", "moved", "tail"]);
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
  it("属性名逐字使用：引擎里叫什么，模板里就写什么", () => {
    const { renderer } = makeRenderer();
    const label = renderer.createText("x") as Label;
    renderer.setProperty(label, "horizontal_alignment", 1);
    expect(label.horizontal_alignment).toBe(1);
  });

  it("驼峰写法不再转换：不是真实属性，告警并忽略", () => {
    const { renderer } = makeRenderer();
    const label = renderer.createText("x") as Label;
    const { warn } = captureWarn(() => renderer.setProperty(label, "horizontalAlignment", 1));
    expect(label.horizontal_alignment).toBe(0);
    expect((label as unknown as Record<string, unknown>).horizontalAlignment).toBeUndefined();
    expectWarned(warn);
  });

  it("结构体原样写入：调用方递什么就是什么", () => {
    const { renderer } = makeRenderer();
    const label = renderer.createText("x") as Label;
    renderer.setProperty(label, "custom_minimum_size", new Vector2(10, 40));
    expect(isVector2(label.custom_minimum_size)).toBe(true);
    expect(label.custom_minimum_size.y).toBe(40);
  });

  it("size_flags 一次写横竖两个", () => {
    const { renderer } = makeRenderer();
    const label = renderer.createText("x") as Label;
    renderer.setProperty(label, "size_flags", 3);
    expect(label.size_flags_horizontal).toBe(3);
    expect(label.size_flags_vertical).toBe(3);
  });

  it("不存在的属性不写，并告警（GodotJS 会静默接受，不告警就是隐形 bug）", () => {
    const { renderer } = makeRenderer();
    const label = renderer.createText("x") as Label;
    const { warn } = captureWarn(() => renderer.setProperty(label, "nonexistent_xyz", 5));
    expect((label as unknown as Record<string, unknown>).nonexistent_xyz).toBeUndefined();
    expectWarned(warn);
  });

  it("ng-* 内部属性不透传给节点", () => {
    const { renderer } = makeRenderer();
    const label = renderer.createText("x") as Label;
    renderer.setAttribute(label, "ng-reflect-kwd", "y");
    expect((label as unknown as Record<string, unknown>).ng_reflect_kwd).toBeUndefined();
  });
});

describe("setStyle", () => {
  it("color → theme 覆盖", () => {
    const { renderer } = makeRenderer();
    const label = renderer.createText("x") as Label;
    renderer.setStyle(label, "color", "#ff8800");
    expect(label.has_theme_color_override("font_color")).toBe(true);
    const c = label.get_theme_color("font_color");
    expect(typeof c.r).toBe("number");
    expect(typeof c.a).toBe("number");
  });

  it("kebab-case 的 font-size 也能写入 theme（Angular 传的是 CSS 名）", () => {
    const { renderer } = makeRenderer();
    const label = renderer.createText("x") as Label;
    renderer.setStyle(label, "font-size", "28");
    expect(label.has_theme_font_size_override("font_size")).toBe(true);
    expect(label.get_theme_font_size("font_size")).toBe(28);
  });

  it("min-width → custom_minimum_size", () => {
    const { renderer } = makeRenderer();
    const label = renderer.createText("x") as Label;
    renderer.setStyle(label, "min-width", "120px");
    expect(label.custom_minimum_size.x).toBe(120);
  });

  it("无 Godot 对应的样式告警而不是假装成功", () => {
    const { renderer } = makeRenderer();
    const { warn } = captureWarn(() => renderer.setStyle(renderer.createText("x") as Label, "display", "flex"));
    expectWarned(warn);
  });
});

describe("listen（Godot 信号 → Angular 回调）", () => {
  it("(click) 接上 Button.pressed 并触发", () => {
    const { renderer } = makeRenderer();
    const button = renderer.createElement("Button");
    const calls: unknown[] = [];
    renderer.listen(button, "click", (v) => calls.push(v));
    button.emit_signal("pressed");
    expect(calls.length).toBe(1);
  });

  it("返回的卸载函数真的 disconnect（重复挂载不能双触发）", () => {
    const { renderer } = makeRenderer();
    const button = renderer.createElement("Button");
    const calls: unknown[] = [];
    const off = renderer.listen(button, "click", () => calls.push(1));
    button.emit_signal("pressed");
    off();
    button.emit_signal("pressed");
    expect(calls.length).toBe(1);
  });

  it("信号不存在时静默忽略（不告警不抛）", () => {
    // 和浏览器对齐：addEventListener("nope") 不报错也不告警。Angular 会把
    // 不是 Godot 信号的名字递进来（ngModelChange / ngSubmit 是指令 output，
    // 但 listenerInternal 仍会先走一遍 renderer.listen），这里必须宽容。
    const { renderer } = makeRenderer();
    const control = renderer.createElement("Control");
    const { warn, result: off } = captureWarn(() => renderer.listen(control, "click", () => {}));
    expect(() => off()).not.toThrow();
    expect(warn.count).toBe(0);
  });

  it("LineEdit.text_changed 把字符串参数透传给回调", () => {
    const { renderer } = makeRenderer();
    const edit = renderer.createElement("LineEdit");
    let got = "";
    renderer.listen(edit, "input", (v) => (got = String(v)));
    edit.emit_signal("text_changed", "typed");
    expect(got).toBe("typed");
  });
});

/** class 是 CSS 选择器的主要输入：静态 class、[class.x]、ngClass 最后都写入这三个方法上 */
describe("class（选择器的输入）", () => {
  const classes = (node: any): string[] => [...(node.cssClasses ?? [])].sort();

  it('静态 class="a b" 整串替换，不是累加', () => {
    const { renderer } = makeRenderer();
    const label = renderer.createElement("Label");
    renderer.setAttribute(label, "class", "card title");
    expect(classes(label)).toEqual(["card", "title"]);
    renderer.setAttribute(label, "class", "other");
    expect(classes(label)).toEqual(["other"]);
  });

  it("removeAttribute('class') 清空", () => {
    const { renderer } = makeRenderer();
    const label = renderer.createElement("Label");
    renderer.setAttribute(label, "class", "a b");
    renderer.removeAttribute(label, "class");
    expect(classes(label)).toEqual([]);
  });

  it("addClass / removeClass 增量改，多余空白与重复都无害", () => {
    const { renderer } = makeRenderer();
    const label = renderer.createElement("Label");
    renderer.addClass(label, "  a   b ");
    renderer.addClass(label, "a");
    expect(classes(label)).toEqual(["a", "b"]);
    renderer.removeClass(label, "a");
    renderer.removeClass(label, "gone");
    expect(classes(label)).toEqual(["b"]);
  });

  it("空类名不产生任何 class", () => {
    const { renderer } = makeRenderer();
    const label = renderer.createElement("Label");
    expect(() => renderer.addClass(label, "")).not.toThrow();
    expect(() => renderer.removeClass(label, "  ")).not.toThrow();
    expect(classes(label)).toEqual([]);
  });
});

describe("setStyle / removeStyle 的撤销路径", () => {
  it("空串与 removeStyle 都能撤掉已写的 theme 覆盖", () => {
    const { renderer } = makeRenderer();
    const label = renderer.createText("x") as Label;
    renderer.setStyle(label, "color", "#ff8800");
    expect(label.has_theme_color_override("font_color")).toBe(true);
    renderer.setStyle(label, "color", "");
    expect(label.has_theme_color_override("font_color")).toBe(false);

    renderer.setStyle(label, "font-size", "28");
    renderer.removeStyle(label, "font-size");
    expect(label.has_theme_font_size_override("font_size")).toBe(false);
  });
});

describe("setProperty 剩下的分支", () => {
  it("anchors_preset 走 set_anchors_preset（直接赋值 anchors_preset 是不存在的属性）", () => {
    const { renderer } = makeRenderer();
    const box = renderer.createElement("Control") as Control;
    const { warn } = captureWarn(() => renderer.setProperty(box, "anchors_preset", 8)); // PRESET_CENTER
    expect(warn.count).toBe(0);
    expect(box.anchor_left).toBe(0.5);
    expect(box.anchor_right).toBe(0.5);
  });

  it("Color 型属性收真 Color", () => {
    const { renderer } = makeRenderer();
    const box = renderer.createElement("Control") as Control;
    renderer.setProperty(box, "modulate", new Color(1, 0.5, 0, 1));
    expect(typeof box.modulate.g).toBe("number");
    expect(box.modulate.g).toBeCloseTo(0.5);
  });
});

describe("结构操作与属性写入的收尾用例", () => {
  it("destroyNode：从父上摘下来并断开级联登记", () => {
    const { renderer, root } = makeRenderer();
    const box = renderer.createElement("VBoxContainer") as Control;
    const label = renderer.createElement("Label") as Control;
    renderer.appendChild(root, box); // 创建不带父，挂哪儿由这里决定
    renderer.appendChild(box, label);
    renderer.destroyNode(label);
    expect(label.get_parent()).toBeNull();
    expect(box.get_child_count()).toBe(0);
    expect(root.get_child_count()).toBe(1); // 只剩 box
  });

  it("insertBefore：参照缺失就是搬到末尾，跨父搬运要先摘", () => {
    const { renderer } = makeRenderer();
    const box = renderer.createElement("VBoxContainer") as Control;
    const other = renderer.createElement("VBoxContainer") as Control;
    const a = renderer.createElement("Label") as Control;
    const b = renderer.createElement("Label") as Control;
    renderer.appendChild(box, a);
    renderer.appendChild(box, b);
    renderer.insertBefore(box, b, null as any); // b 本来就在末尾：不动
    expect(b.get_index()).toBe(1);
    renderer.insertBefore(box, b, renderer.createElement("Label") as Control); // 参照不在本父下：同样按末尾处理
    expect(b.get_index()).toBe(1);
    renderer.insertBefore(box, b, a); // 真的往前搬
    expect(b.get_index()).toBe(0);
    renderer.insertBefore(box, b, null as any); // 搬到末尾：Angular 的 move-to-end 递的就是 null
    expect(b.get_index()).toBe(1);
    renderer.insertBefore(other, b, null as any); // 换父：先从旧父摘掉，不重复挂
    expect(box.get_child_count()).toBe(1);
    expect(b.get_parent()).toBe(other);
  });

  it("parentNode / nextSibling 对无父节点返回 null", () => {
    const { renderer } = makeRenderer();
    const box = renderer.createElement("VBoxContainer") as Control;
    const lone = renderer.createElement("Label") as Control; // 刚创建，还没被挂到任何父下
    expect(renderer.parentNode(box)).toBeNull();
    expect(renderer.parentNode(lone)).toBeNull();
    const a = renderer.createElement("Label") as Control;
    const b = renderer.createElement("Label") as Control;
    renderer.appendChild(box, a);
    renderer.appendChild(box, b);
    expect(renderer.nextSibling(a)).toBe(b);
    expect(renderer.nextSibling(b)).toBeNull(); // 最后一个没有下一个
    renderer.removeChild(null, b); // removeChild 自己找父
    expect(b.get_parent()).toBeNull();
  });

  it("setValue 只写给真有 text 的节点", () => {
    const { renderer } = makeRenderer();
    const text = renderer.createText("x") as Label;
    expect(text.text).toBe("x");
    renderer.setValue(text, "");
    expect(text.text).toBe("");
    renderer.setValue(renderer.createElement("Control"), "y"); // 没有 text 属性的节点：静默
  });

  it("class 属性走 class 通道：整串替换，removeAttribute 清空", () => {
    const { renderer } = makeRenderer();
    const label = renderer.createElement("Label") as any;
    renderer.setAttribute(label, "class", "a b");
    expect([...(label.cssClasses as Set<string>)].sort().join(",")).toBe("a,b");
    renderer.setAttribute(label, "class", "c"); // 以新值为准，旧的替换掉
    expect([...(label.cssClasses as Set<string>)].sort().join(",")).toBe("c");
    renderer.removeAttribute(label, "class");
    expect(label.cssClasses.size).toBe(0);
  });

  it("removeAttribute 还原 Object 型属性（theme 的默认就是 null）", () => {
    const { renderer } = makeRenderer();
    const label = renderer.createElement("Label") as Label;
    label.theme = new Theme();
    renderer.removeAttribute(label, "theme");
    expect(label.theme).toBeNull();
  });

  it("setStyle 传空值等于删掉这条内联样式", () => {
    const { renderer } = makeRenderer();
    const label = renderer.createElement("Label") as Control;
    renderer.setStyle(label, "color", "rgb(10, 20, 30)");
    expect(label.has_theme_color_override("font_color")).toBe(true);
    renderer.setStyle(label, "color", null);
    expect(label.has_theme_color_override("font_color")).toBe(false);
    renderer.removeStyle(label, "color"); // 没设过也能撤，不报错
  });
});
