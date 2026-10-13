import { beforeEach, describe, expect, it } from "vitest";
import { Button, Color, GridContainer, Label, MarginContainer, PanelContainer, StyleBoxFlat, VBoxContainer } from "godot";
import { applyStyle, clearStyle, styleLedger } from "godot-angular/core";
import { captureWarn, expectWarned, resetWarnOnce } from "godot-angular/testing";

beforeEach(() => {
  // warnOnce 是全局去重，不清空表格时“确实告警了”会依赖用例顺序
  resetWarnOnce();
});

/** 取回节点上那个 stylebox 并按 StyleBoxFlat 查看。先断言非空再转类型，优于一路 `as any`：
 * 确实无法获取 item 时会说明是哪个类的哪个 item。 */
function flat(node: any, item: string): StyleBoxFlat {
  const box = node.get_theme_stylebox(item);
  expect(box, `${node.get_class()} 拿不到 stylebox "${item}"`).not.toBeNull();
  return box as StyleBoxFlat;
}

describe("StyleBox：duplicate 与污染", () => {
  it("写背景后节点上的 stylebox 变了，而 Theme 里那个共享实例没被污染", () => {
    const button = new Button();
    const shared = flat(button, "normal");
    const before = { r: shared.bg_color.r, g: shared.bg_color.g, b: shared.bg_color.b };

    applyStyle(button, "background-color", "rgb(255, 136, 0)");

    const after = flat(button, "normal");
    expect(after.bg_color.r).toBeCloseTo(1, 3);
    expect(after.bg_color.g).toBeCloseTo(136 / 255, 3);
    // 关键的一条：共享实例的通道一个也未修改
    expect(shared.bg_color.r).toBeCloseTo(before.r, 6);
    expect(shared.bg_color.g).toBeCloseTo(before.g, 6);
    expect(shared.bg_color.b).toBeCloseTo(before.b, 6);
  });

  it("改 A 的底色不影响兄弟 B（duplicate 隔离）", () => {
    const a = new Button();
    const b = new Button();
    const bBefore = flat(b, "normal").bg_color.r;

    applyStyle(a, "background-color", "red");

    expect(flat(b, "normal").bg_color.r).toBeCloseTo(bBefore, 6);
    expect(b.has_theme_stylebox_override("normal")).toBe(false);
  });

  it("同一个 stylebox 上底色 / 圆角 / 边框互不覆盖（盒模型同箱）", () => {
    const button = new Button();
    applyStyle(button, "background-color", "red");
    applyStyle(button, "border-top-left-radius", "8px");
    applyStyle(button, "border-top-width", "3px");
    applyStyle(button, "border-color", "rgb(0 0 255)");
    applyStyle(button, "box-shadow", "2px 3px 4px rgb(0 0 0)");
    applyStyle(button, "padding", "6px 7px");

    const box = flat(button, "normal");
    expect(box.bg_color.r).toBeCloseTo(1, 3);
    expect(box.corner_radius_top_left).toBe(8);
    expect(box.border_width_top).toBe(3);
    expect(box.border_color.b).toBeCloseTo(1, 3);
    expect(box.shadow_size).toBe(4);
    expect(box.shadow_offset.x).toBe(2);
    expect(box.content_margin_left).toBe(7);
    expect(box.content_margin_top).toBe(6);
  });

  it("PanelContainer 的底色落在 panel 上（不同类不同 item 名）", () => {
    const panel = new PanelContainer();
    applyStyle(panel, "background-color", "red");
    expect(flat(panel, "panel").bg_color.r).toBeCloseTo(1, 3);
  });

  it("不画底的类写背景：告警，且不留任何 override", () => {
    const box = new VBoxContainer();
    const { warn } = captureWarn(() => applyStyle(box, "background-color", "red"));
    expectWarned(warn);
    expect(styleLedger(box)).toEqual([]);
  });
});

describe("颜色 / 字号 / 透明度", () => {
  it("color → font_color 覆盖，值按通道对得上", () => {
    const label = new Label();
    applyStyle(label, "color", "#ff8800");
    expect(label.has_theme_color_override("font_color")).toBe(true);
    const color = label.get_theme_color("font_color");
    expect(color.r).toBeCloseTo(1, 3);
    expect(color.g).toBeCloseTo(136 / 255, 3);
  });

  it("font-size → font_size 覆盖（整数）", () => {
    const label = new Label();
    applyStyle(label, "font-size", "20px");
    expect(label.get_theme_font_size("font_size")).toBe(20);
  });

  it("opacity → modulate.a，rgb 三通道不动", () => {
    const label = new Label();
    const before = label.modulate;
    applyStyle(label, "opacity", "0.25");
    expect(label.modulate.a).toBeCloseTo(0.25, 5);
    expect(label.modulate.r).toBe(before.r);
  });
});

describe("ledger 记账", () => {
  it("写几条记几条；clear 之后 override 全撤干净", () => {
    const button = new Button();
    applyStyle(button, "background-color", "red");
    applyStyle(button, "color", "#ff8800");
    applyStyle(button, "font-size", "20");
    expect(button.has_theme_stylebox_override("normal")).toBe(true);
    expect(button.has_theme_color_override("font_color")).toBe(true);
    expect(button.has_theme_font_size_override("font_size")).toBe(true);
    expect(styleLedger(button)).toHaveLength(3);

    clearStyle(button);

    expect(button.has_theme_stylebox_override("normal")).toBe(false);
    expect(button.has_theme_color_override("font_color")).toBe(false);
    expect(button.has_theme_font_size_override("font_size")).toBe(false);
    expect(styleLedger(button)).toEqual([]);
  });

  it("重复写同一条只记一次（Angular 每轮变更检测都会重递）", () => {
    const button = new Button();
    applyStyle(button, "color", "red");
    applyStyle(button, "color", "red");
    applyStyle(button, "color", "red");
    expect(styleLedger(button)).toHaveLength(1);
    clearStyle(button);
    expect(button.has_theme_color_override("font_color")).toBe(false);
  });

  it("clearStyle(node, 'color') 只撤 color，background 留着", () => {
    const button = new Button();
    applyStyle(button, "background-color", "red");
    applyStyle(button, "color", "red");
    clearStyle(button, "color");
    expect(button.has_theme_color_override("font_color")).toBe(false);
    expect(button.has_theme_stylebox_override("normal")).toBe(true);
  });

  it("margin 这类 theme 常量也能撤销：clear 之后原样放回", () => {
    const box = new MarginContainer();
    const before = box.get_theme_constant("margin_top");
    applyStyle(box, "margin-top", "12px");
    expect(box.get_theme_constant("margin_top")).toBe(12);
    clearStyle(box, "margin-top");
    expect(box.has_theme_constant_override("margin_top")).toBe(false);
    expect(box.get_theme_constant("margin_top")).toBe(before);
  });

  it("我们没写过的 override 不会被 clear 顺手清掉", () => {
    const label = new Label();
    label.add_theme_color_override("font_color", new Color(1, 0, 0, 1));
    clearStyle(label);
    expect(label.has_theme_color_override("font_color")).toBe(true);
  });
});

describe("布局落点：只做提示式翻译", () => {
  it("gap → theme 常量 separation（Godot 4 的 BoxContainer 没这个属性）", () => {
    const box = new VBoxContainer();
    applyStyle(box, "gap", "10px");
    expect(box.get_theme_constant("separation")).toBe(10);
    expect(box.has_theme_constant_override("separation")).toBe(true);

    const grid = new GridContainer();
    applyStyle(grid, "gap", "6px");
    expect(grid.get_theme_constant("h_separation")).toBe(6);
    expect(grid.get_theme_constant("v_separation")).toBe(6);

    clearStyle(box, "gap");
    expect(box.has_theme_constant_override("separation")).toBe(false);
  });

  it("justify-content 三档能落；space-* 告警且节点没被动", () => {
    const box = new VBoxContainer();
    applyStyle(box, "justify-content", "center");
    expect(box.alignment).toBe(1);

    const other = new VBoxContainer();
    const before = other.alignment;
    const { warn } = captureWarn(() => applyStyle(other, "justify-content", "space-between"));
    expectWarned(warn);
    expect(other.alignment).toBe(before);
    expect(styleLedger(other)).toEqual([]);
  });

  it("margin 落在 Label 上：告警且无 override 残留", () => {
    const label = new Label();
    const { warn } = captureWarn(() => applyStyle(label, "margin", "8px"));
    expectWarned(warn);
    expect(styleLedger(label)).toEqual([]);
  });

  it("margin 落在 MarginContainer 上：四条边都写进去", () => {
    const box = new MarginContainer();
    applyStyle(box, "margin", "4px 5px");
    expect(box.get_theme_constant("margin_top")).toBe(4);
    expect(box.get_theme_constant("margin_right")).toBe(5);
    expect(box.get_theme_constant("margin_bottom")).toBe(4);
    expect(box.get_theme_constant("margin_left")).toBe(5);
  });

  it("width 是下界不是等值", () => {
    const label = new Label();
    applyStyle(label, "width", "120px");
    expect(label.custom_minimum_size.x).toBe(120);
    expect(label.custom_minimum_size.y).toBe(0);
    applyStyle(label, "height", "40px");
    // 另一个轴不会被本次写入抹除——这是 setMinimumSize 分轴的意义
    expect(label.custom_minimum_size.x).toBe(120);
    expect(label.custom_minimum_size.y).toBe(40);
  });

  it("撤 width 不抹 height：两轴各自记账", () => {
    const label = new Label();
    applyStyle(label, "width", "120px");
    applyStyle(label, "height", "40px");
    clearStyle(label, "width");
    expect(label.custom_minimum_size.x).toBe(0);
    expect(label.custom_minimum_size.y).toBe(40);
  });

  it("flex: 2 → size_flags 带 EXPAND 且 stretch_ratio = 2", () => {
    const label = new Label();
    applyStyle(label, "flex", "2");
    // Control.SIZE_EXPAND = 2
    expect(label.size_flags_vertical & 2).toBe(2);
    expect(label.size_flags_stretch_ratio).toBe(2);
  });

  it("display 无落点：告警，节点树一个子都没多", () => {
    const box = new VBoxContainer();
    const childrenBefore = box.get_child_count();
    const { warn } = captureWarn(() => applyStyle(box, "display", "flex"));
    expectWarned(warn);
    expect(box.get_child_count()).toBe(childrenBefore);
  });
});

describe("重复应用与撤销", () => {
  it("同样的值重复应用不重复写（幂等）", () => {
    const label = new Label();
    applyStyle(label, "font-size", "20");
    const first = label.get_theme_font_size("font_size");
    applyStyle(label, "font-size", "20");
    expect(label.get_theme_font_size("font_size")).toBe(first);
  });

  it("传空串 = 撤销这一条（Angular 解绑 [style.x] 时就是这样）", () => {
    const label = new Label();
    applyStyle(label, "color", "red");
    expect(label.has_theme_color_override("font_color")).toBe(true);
    applyStyle(label, "color", "");
    expect(label.has_theme_color_override("font_color")).toBe(false);
  });

  it("传 null / undefined 也等于撤销（Angular 解绑给的就是 null）", () => {
    for (const empty of [null, undefined]) {
      const label = new Label();
      applyStyle(label, "color", "red");
      expect(label.has_theme_color_override("font_color"), String(empty)).toBe(true);
      applyStyle(label, "color", empty);
      expect(label.has_theme_color_override("font_color"), String(empty)).toBe(false);
    }
  });

  it("撤销没记过的东西：不炸、也不把别的连带清掉", () => {
    const label = new Label();
    expect(() => clearStyle(label)).not.toThrow();
    expect(styleLedger(label)).toEqual([]); // 什么都没应用过
    applyStyle(label, "color", "red");
    clearStyle(label, "font-size"); // 没记过这条：只清账，不动 color
    expect(label.has_theme_color_override("font_color")).toBe(true);
    // 清完再写同样的值必须写得回去（“值没变”的短路不能使这条永久无法写入）
    clearStyle(label, "color");
    applyStyle(label, "color", "red");
    expect(label.has_theme_color_override("font_color")).toBe(true);
  });
});
