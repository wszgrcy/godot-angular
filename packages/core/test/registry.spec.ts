import { beforeEach, describe, expect, it } from "vitest";
import { setGodotHost } from "../src/godot-host";
import {
  HTML_TAG_ALIASES,
  isControlClass,
  nodeHasProperty,
  resolveSignalName,
  resolveTag,
  toSnakeCase,
  usableControlClasses,
} from "../src/registry";
import { createMockGodot, MockNode } from "./mock-godot";

const godot = createMockGodot();

beforeEach(() => {
  setGodotHost(godot);
});

describe("toSnakeCase", () => {
  it("转换 Godot 属性名", () => {
    expect(toSnakeCase("customMinimumSize")).toBe("custom_minimum_size");
    expect(toSnakeCase("sizeFlags")).toBe("size_flags");
    expect(toSnakeCase("text")).toBe("text");
    expect(toSnakeCase("anchorsPreset")).toBe("anchors_preset");
  });

  it("连续大写不拆错", () => {
    expect(toSnakeCase("HTTPEnabled")).toBe("http_enabled");
  });
});

describe("resolveTag", () => {
  it("Godot 类名原样解析", () => {
    expect(resolveTag("Label")).toBe("Label");
    expect(resolveTag("Button")).toBe("Button");
    expect(resolveTag("PanelContainer")).toBe("PanelContainer");
  });

  it("首字母小写的 Godot 类名也能解析（label → Label）", () => {
    expect(resolveTag("label")).toBe("Label");
    expect(resolveTag("lineEdit")).toBe("LineEdit");
  });

  it("HTML 标签走别名表", () => {
    expect(HTML_TAG_ALIASES["div"]).toBe("VBoxContainer");
    expect(resolveTag("button")).toBe("Button");
    expect(resolveTag("input")).toBe("LineEdit");
    expect(resolveTag("select")).toBe("OptionButton");
  });

  it("非 Control 的类不认（Node 不是控件）", () => {
    expect(resolveTag("Node")).toBeNull();
  });

  it("认不出来的标签返回 null，由渲染器降级", () => {
    expect(resolveTag("ui-card")).toBeNull();
    expect(resolveTag("TotallyBogus")).toBeNull();
  });
});

describe("isControlClass / usableControlClasses", () => {
  it("继承链判定 Control", () => {
    expect(isControlClass("Label")).toBe(true);
    expect(isControlClass("VBoxContainer")).toBe(true);
    expect(isControlClass("Node")).toBe(false);
  });

  it("清单来自 ClassDB 而不是手写白名单", () => {
    const list = usableControlClasses();
    expect(list).toContain("Label");
    expect(list).toContain("Button");
    expect(list).not.toContain("Node");
  });
});

describe("nodeHasProperty", () => {
  it("本类属性", () => {
    expect(nodeHasProperty(new MockNode("Label"), "text")).toBe(true);
  });

  it("继承来的属性（ClassDB 的 includeInherited 在 GodotJS 里无效，得自己走链）", () => {
    const label = new MockNode("Label");
    expect(nodeHasProperty(label, "size")).toBe(true);
    expect(nodeHasProperty(label, "custom_minimum_size")).toBe(true);
    expect(nodeHasProperty(label, "name")).toBe(true);
  });

  it("不存在的属性", () => {
    expect(nodeHasProperty(new MockNode("Label"), "nonexistent_xyz")).toBe(false);
  });
});

describe("resolveSignalName", () => {
  it("(click) → Button.pressed", () => {
    expect(resolveSignalName(new MockNode("Button"), "click")).toBe("pressed");
  });

  it("(input) 在 LineEdit 上必须是 text_changed，不能被 Control.gui_input 抢走", () => {
    // 回归用例：顺序排错时信号照样接得上，但回调永远不触发，极难查
    expect(resolveSignalName(new MockNode("LineEdit"), "input")).toBe("text_changed");
  });

  it("(change) 按控件类型落到不同信号", () => {
    expect(resolveSignalName(new MockNode("LineEdit"), "change")).toBe("text_changed");
    expect(resolveSignalName(new MockNode("OptionButton"), "change")).toBe("item_selected");
  });

  it("裸信号名直接命中", () => {
    expect(resolveSignalName(new MockNode("Control"), "guiInput")).toBe("gui_input");
    expect(resolveSignalName(new MockNode("Button"), "buttonDown")).toBe("button_down");
  });

  it("找不到返回 null", () => {
    expect(resolveSignalName(new MockNode("Control"), "click")).toBeNull();
    expect(resolveSignalName({}, "click")).toBeNull();
  });
});
