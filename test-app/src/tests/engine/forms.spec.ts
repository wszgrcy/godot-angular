import { describe, expect, it } from "vitest";
import { ClassDB, Control, ItemList } from "godot";
import { nodeHasProperty, tryConnectGodotSignal } from "godot-angular/core";
import { newNode } from "godot-angular/testing";

function hasSignal(node: any, signalName: string): boolean {
  return ClassDB.class_has_signal(node.get_class(), signalName);
}

/** 这个控件的禁用写在哪个属性上（三档，见 forms 各指令的 setDisabledState） */
type DisableProp = "editable" | "disabled" | "mouse_filter";

const CONTRACTS: ReadonlyArray<readonly [string, string, string, DisableProp]> = [
  // [控件类名, 值属性, 变更信号, 禁用写入位置]
  ["LineEdit", "text", "text_changed", "editable"],
  ["TextEdit", "text", "text_changed", "editable"],
  ["HSlider", "value", "value_changed", "editable"],
  ["VSlider", "value", "value_changed", "editable"],
  ["SpinBox", "value", "value_changed", "editable"],
  ["HScrollBar", "value", "value_changed", "mouse_filter"],
  ["VScrollBar", "value", "value_changed", "mouse_filter"],
  ["CheckBox", "button_pressed", "toggled", "disabled"],
  ["CheckButton", "button_pressed", "toggled", "disabled"],
  ["OptionButton", "selected", "item_selected", "disabled"],
  ["ColorPicker", "color", "color_changed", "mouse_filter"],
];

describe("forms 指令的值/信号/禁用契约", () => {
  for (const [cls, prop, signal, disableProp] of CONTRACTS) {
    it(`${cls}: ${prop} + ${signal} + ${disableProp}`, () => {
      const node = newNode(cls);
      expect(nodeHasProperty(node, prop)).toBe(true);
      expect(hasSignal(node, signal)).toBe(true);
      expect(nodeHasProperty(node, disableProp)).toBe(true);
    });
  }

  it("禁用属性不是三档都随便：editable 与 disabled 互斥存在", () => {
    // 指令按这张表各自编写，因此“有 editable”就必须“没有 disabled”，反之亦然
    for (const [cls, , , disableProp] of CONTRACTS) {
      const node = newNode(cls);
      const others = (["editable", "disabled", "mouse_filter"] as const).filter((p) => p !== disableProp);
      for (const other of others) {
        if (other === "mouse_filter") continue; // 每个 Control 都有 mouse_filter，它是兜底而不是专属
        expect(nodeHasProperty(node, other), `${cls} 不该同时有 ${other}`).toBe(false);
      }
    }
  });

  it("OptionButton 同时有 toggled，所以候选表必须 item_selected 优先", () => {
    const option = newNode("OptionButton");
    expect(hasSignal(option, "toggled")).toBe(true);
    expect(hasSignal(option, "item_selected")).toBe(true);
  });

  it("CheckBox 没有 button_pressed_changed —— 只能靠 toggled", () => {
    expect(hasSignal(newNode("CheckBox"), "button_pressed_changed")).toBe(false);
  });
});

describe("Godot 4 的命名（指令里写死的名字，变了就该红）", () => {
  it("ScrollBar 的信号是 scrolling()，Godot 3 的 scrolled 已经没了", () => {
    const bar = newNode("HScrollBar");
    expect(hasSignal(bar, "scrolled")).toBe(false);
    expect(hasSignal(bar, "scrolling")).toBe(true);
    // scrolling() 不携带参数，能够提供值的是继承自 Range 的 value_changed
    expect(hasSignal(bar, "value_changed")).toBe(true);
  });

  it("Slider 的拖拽结束是 drag_ended，不是 Godot 3 的 slider_ended", () => {
    const slider = newNode("HSlider");
    expect(hasSignal(slider, "slider_ended")).toBe(false);
    expect(hasSignal(slider, "drag_ended")).toBe(true);
  });

  it("SpinBox 没有 H/V 前缀（那是 Godot 3 的类名）", () => {
    expect(ClassDB.class_exists("SpinBox")).toBe(true);
    expect(ClassDB.class_exists("HSpinBox")).toBe(false);
    expect(ClassDB.class_exists("VSpinBox")).toBe(false);
  });
});

describe("ScrollBar 是滚筒条，不是滚动容器", () => {
  it("HScrollBar 是 Range：有 min/max/page，且不收子节点", () => {
    const bar = newNode("HScrollBar");
    expect(nodeHasProperty(bar, "min_value")).toBe(true);
    expect(nodeHasProperty(bar, "max_value")).toBe(true);
    expect(nodeHasProperty(bar, "page")).toBe(true);
    // 只有容器才承载子节点；ScrollBar 容纳子节点没有意义
    expect(bar.get_child_count()).toBe(0);
  });

  it("滚动偏移就是 value，可写可读", () => {
    const bar = newNode("VScrollBar");
    bar.max_value = 1000;
    bar.page = 100;
    bar.value = 250;
    expect(bar.value).toBe(250);
    // value 的上界是 max_value - page，超出会被 Godot 夹取
    bar.value = 5000;
    expect(bar.value).toBe(900);
  });

  it("容器是 ScrollContainer，它的滚动条要自己取", () => {
    const box = newNode("ScrollContainer");
    const bar = box.get_v_scroll_bar();
    expect(bar?.get_class()).toBe("VScrollBar");
    expect(hasSignal(box, "scroll_started")).toBe(true);
    expect(hasSignal(box, "scroll_ended")).toBe(true);
  });
});

describe("OptionButton 的候选项不是子节点", () => {
  it("add_item 只加数据，节点数不变", () => {
    const option = newNode("OptionButton");
    expect(option.get_child_count()).toBe(0);
    option.add_item("甲");
    option.add_item("乙");
    expect(option.item_count).toBe(2);
    // 没有 <option> 那种父子结构，可双向绑定的只有下标
    expect(option.get_item_text(1)).toBe("乙");
    expect(option.selected).toBe(0);
  });

  it("没有候选项时 selected 夹回 -1", () => {
    expect(newNode("OptionButton").selected).toBe(-1);
  });
});

describe("ItemList 的选中集是数组，不是单个属性", () => {
  it("没有 selected 属性，只能 select() / deselect_all() / get_selected_items()", () => {
    const list = newNode("ItemList");
    expect(nodeHasProperty(list, "selected")).toBe(false);
    for (const method of ["select", "deselect", "deselect_all", "get_selected_items", "is_selected"]) {
      expect(typeof list[method], method).toBe("function");
    }
  });

  it("get_selected_items() 不行代：只有 size() / get(i)", () => {
    const list = newNode("ItemList");
    list.add_item("甲");
    list.add_item("乙");
    list.select_mode = ItemList.SelectMode.SELECT_MULTI;
    list.select(0, false);
    list.select(1, false);
    const packed = list.get_selected_items();
    expect(Array.isArray(packed)).toBe(false);
    expect(typeof packed[Symbol.iterator]).toBe("undefined");
    expect(packed.size()).toBe(2);
    expect([packed.get(0), packed.get(1)]).toEqual([0, 1]);
  });

  it("select() 不触发信号 —— writeValue 重铺不会打转", () => {
    const list = newNode("ItemList");
    list.add_item("甲");
    list.select_mode = ItemList.SelectMode.SELECT_MULTI;
    let hits = 0;
    const off = tryConnectGodotSignal(list, "multi_selected", () => hits++);
    list.select(0, false);
    expect(off).not.toBeNull();
    expect(hits).toBe(0);
    off?.();
  });

  it("单选是 item_selected(index)，多选是 multi_selected(index, selected)", () => {
    const list = newNode("ItemList");
    const argCount = (signalName: string): number => {
      for (const entry of ClassDB.class_get_signal_list("ItemList") as Iterable<any>) {
        if (String(entry.get("name")) !== signalName) continue;
        const args = entry.get("args");
        return Number(args.size?.() ?? args.length ?? 0);
      }
      return -1;
    };
    expect(argCount("item_selected")).toBe(1);
    expect(argCount("multi_selected")).toBe(2);
    // 两者均连接：单选模式只发出前者，多选 / 切换模式只发出后者
    expect(hasSignal(list, "item_selected")).toBe(true);
    expect(hasSignal(list, "multi_selected")).toBe(true);
  });
});

describe("禁用兜底：mouse_filter 的存取", () => {
  it("ScrollBar / ColorPicker 没有 editable / disabled，只有 mouse_filter", () => {
    for (const cls of ["HScrollBar", "ColorPicker"]) {
      const node = newNode(cls);
      expect(nodeHasProperty(node, "editable")).toBe(false);
      expect(nodeHasProperty(node, "disabled")).toBe(false);
      expect(nodeHasProperty(node, "mouse_filter")).toBe(true);
    }
  });

  it("MouseFilter 常量在 GodotJS 里挂在类上（不是 SCREAMING_SNAKE）", () => {
    // 误写为 Control.MOUSE_FILTER_IGNORE 会得到 undefined，随后 set_mouse_filter 报
    // "Unable to convert JS undefined to Godot int"——因此需要固定数值
    expect(Control.MouseFilter.MOUSE_FILTER_STOP).toBe(0);
    expect(Control.MouseFilter.MOUSE_FILTER_IGNORE).toBe(2);
  });
});
