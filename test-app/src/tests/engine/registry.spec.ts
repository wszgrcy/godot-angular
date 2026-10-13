import { describe, expect, it } from "vitest";
import { ClassDB } from "godot";
import { newNode } from "godot-angular/testing";
import {
  GODOT_TYPE,
  HTML_TAG_ALIASES,
  coerceToProperty,
  godotClass,
  isControlClass,
  nodeHasProperty,
  propertyVariantType,
  resolveSignalName,
  resolveTag,
} from "godot-angular/core";

describe("resolveTag", () => {
  it("Godot 类名原样返回", () => {
    expect(resolveTag("Label")).toBe("Label");
    expect(resolveTag("Button")).toBe("Button");
    expect(resolveTag("PanelContainer")).toBe("PanelContainer");
  });

  it("不做大小写变形：小写开头的类名原样退回", () => {
    // label 能变成 Label 是因为别名表里有 label → Label，而不是因为首字母大写
    expect(resolveTag("label")).toBe("Label");
    expect(resolveTag("lineEdit")).toBe("lineEdit");
    expect(resolveTag("vBoxContainer")).toBe("vBoxContainer");
  });

  it("大小写不参与解析：别名表也只认表里写好的名字", () => {
    expect(resolveTag("DIV")).toBe("DIV");
    expect(resolveTag("Button")).toBe("Button");
  });

  it("HTML 标签走别名表", () => {
    expect(HTML_TAG_ALIASES["div"]).toBe("VBoxContainer");
    expect(resolveTag("button")).toBe("Button");
    expect(resolveTag("input")).toBe("LineEdit");
    expect(resolveTag("select")).toBe("OptionButton");
  });

  it("别名表的键不会与 Godot 类名撞车（命中别名就完全以表为准的前提）", () => {
    for (const [tag, className] of Object.entries(HTML_TAG_ALIASES)) {
      expect(ClassDB.class_exists(tag), `<${tag}> 本身不是类名`).toBe(false);
      expect(resolveTag(tag), `<${tag}>`).toBe(className);
    }
  });

  it("只查表不校验：认不出的标签原样交出，能不能用由创建时决定", () => {
    expect(resolveTag("ui-card")).toBe("ui-card");
    expect(resolveTag("TotallyBogus")).toBe("TotallyBogus");
    expect(resolveTag("Node")).toBe("Node");
  });
});

/**
 * godot 命名空间是 Proxy：按不存在的键取成员会当场抛 `godot class not found 'xxx'`。
 * 未知标签降级依赖 godotClass 能安静地返回 undefined；少了 ClassDB 那道闸门，
 * <ui-card> 这类组件宿主会使整个 bootstrap 失败。
 */
describe("godotClass", () => {
  it("存在的类拿到构造函数", () => {
    expect(typeof godotClass("Label")).toBe("function");
  });

  it("不存在的类返回 undefined 而不是抛错", () => {
    expect(godotClass("ui-card")).toBeUndefined();
    expect(godotClass("TotallyBogus")).toBeUndefined();
  });
});

describe("isControlClass", () => {
  it("继承链判定 Control", () => {
    expect(isControlClass("Label")).toBe(true);
    expect(isControlClass("VBoxContainer")).toBe(true);
    expect(isControlClass("Node")).toBe(false);
  });
});

describe("nodeHasProperty", () => {
  it("本类属性", () => {
    expect(nodeHasProperty(newNode("Label"), "text")).toBe(true);
  });

  it("继承来的属性（ClassDB 的 includeInherited 在 GodotJS 里无效，得自己走链）", () => {
    const label = newNode("Label");
    expect(nodeHasProperty(label, "size")).toBe(true);
    expect(nodeHasProperty(label, "custom_minimum_size")).toBe(true);
    expect(nodeHasProperty(label, "name")).toBe(true);
  });

  it("不存在的属性", () => {
    expect(nodeHasProperty(newNode("Label"), "nonexistent_xyz")).toBe(false);
  });
});

describe("resolveSignalName", () => {
  it("(click) → Button.pressed", () => {
    expect(resolveSignalName(newNode("Button"), "click")).toBe("pressed");
  });

  it("(input) 在 LineEdit 上解析为 text_changed，而非继承自 Control 的 gui_input", () => {
    // 回归用例：顺序排错时信号仍然可以连接，但回调永远不触发，极难排查
    expect(resolveSignalName(newNode("LineEdit"), "input")).toBe("text_changed");
  });

  it("(change) 按控件类型落到不同信号", () => {
    expect(resolveSignalName(newNode("LineEdit"), "change")).toBe("text_changed");
    expect(resolveSignalName(newNode("OptionButton"), "change")).toBe("item_selected");
  });

  it("信号名原样匹配：gui_input / button_down / pressed", () => {
    expect(resolveSignalName(newNode("Control"), "gui_input")).toBe("gui_input");
    expect(resolveSignalName(newNode("Button"), "button_down")).toBe("button_down");
    expect(resolveSignalName(newNode("Button"), "pressed")).toBe("pressed");
  });

  it("驼峰形式的事件名不参与解析，返回 null", () => {
    expect(resolveSignalName(newNode("Control"), "guiInput")).toBeNull();
    expect(resolveSignalName(newNode("Button"), "buttonDown")).toBeNull();
  });

  it("xxxChange 不映射为 xxx_changed：双向绑定由组件的 @Output 承担", () => {
    // `[(text)]` 会编译出 (textChange)，但 Godot 节点上没有这个 output，因此解析不到
    expect(resolveSignalName(newNode("LineEdit"), "textChange")).toBeNull();
    expect(resolveSignalName(newNode("HSlider"), "valueChange")).toBeNull();
    expect(resolveSignalName(newNode("LineEdit"), "text_changed")).toBe("text_changed");
  });

  it("找不到返回 null", () => {
    expect(resolveSignalName(newNode("Control"), "click")).toBeNull();
  });
});

/**
 * 模板中的静态属性永远是字符串（`<HSlider min_value="0">`），而 Godot 属性强类型。
 * 转换错误的直接症状是引擎报 "Unable to convert JS string to Godot float"，
 * 而转换方向错误（布尔写进 float 属性）的症状是数值默默变为 0/1，更难排查。
 */
describe("propertyVariantType：属性的 Variant 类型", () => {
  it("数值 / 布尔 / 字符串各归各位", () => {
    expect(propertyVariantType(newNode("HSlider"), "value")).toBe(GODOT_TYPE.FLOAT);
    expect(propertyVariantType(newNode("CheckBox"), "button_pressed")).toBe(GODOT_TYPE.BOOL);
    expect(propertyVariantType(newNode("Label"), "text")).toBe(GODOT_TYPE.STRING);
  });

  it("查不到就返回 undefined（继承链上也没有）", () => {
    expect(propertyVariantType(newNode("Label"), "nonexistent_xyz")).toBeUndefined();
  });
});

describe("coerceToProperty：按声明类型转值", () => {
  it("字符串 → 数值属性：能转就转，转不动原样交出去", () => {
    const slider = newNode("HSlider");
    expect(coerceToProperty(slider, "value", "12")).toBe(12);
    expect(coerceToProperty(slider, "value", " 7.5 ")).toBe(7.5);
    expect(coerceToProperty(slider, "value", "abc")).toBe("abc");
  });

  it("字符串 → 布尔属性：true/1 与 false/0/空串，其余原样", () => {
    const check = newNode("CheckBox");
    for (const text of ["true", "1"]) {
      expect(coerceToProperty(check, "button_pressed", text), text).toBe(true);
    }
    for (const text of ["false", "0", ""]) {
      expect(coerceToProperty(check, "button_pressed", text), JSON.stringify(text)).toBe(false);
    }
    expect(coerceToProperty(check, "button_pressed", "yes")).toBe("yes");
  });

  it("方向反了也修：字符串属性收到数字转成串，数值属性收到布尔转 0/1", () => {
    expect(coerceToProperty(newNode("Label"), "text", 5)).toBe("5");
    expect(coerceToProperty(newNode("Label"), "text", true)).toBe("true");
    expect(coerceToProperty(newNode("HSlider"), "value", true)).toBe(1);
    expect(coerceToProperty(newNode("HSlider"), "value", false)).toBe(0);
  });

  it("类型未知 / 值为空：原样返回，让引擎的报错说话", () => {
    expect(coerceToProperty(newNode("Label"), "nonexistent_xyz", "x")).toBe("x");
    expect(coerceToProperty(newNode("Label"), "text", null)).toBeNull();
  });

  it("真写一次：静态字符串落到 float 属性上不被引擎拒", () => {
    const slider = newNode("HSlider");
    slider.min_value = coerceToProperty(slider, "min_value", "10") as number;
    expect(slider.min_value).toBe(10);
  });
});
