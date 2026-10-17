import { beforeEach, describe, expect, it } from "vitest";
import type {
  ColorLike,
  CssNode,
  FontSource,
  FourCorners,
  FourSides,
  StyleBackend,
  StyleBoxHandle,
} from "godot-angular/css";
import {
  applyCssProperty,
  cssPropertyNames,
  isAppearanceProperty,
  lookupProperty,
} from "godot-angular/css";

/** 基落点：这些用例验的是「CSS 名 → theme item」的静态映射，不涉及状态伪类 */
const NO_STATES: ReadonlySet<string> = new Set<string>();

/** 记录所有调用的假 backend。它同时是 StyleBackend 契约的“可实例化证明” */
class FakeBackend implements StyleBackend {
  /** 形如 `color:font_color` / `stylebox:normal` 的调用流水 */
  calls: string[] = [];
  nodeNumbers: Record<string, number> = {};
  styleboxMutations: Array<{ item: string; what: string }> = [];
  warned: string[] = [];
  /** 这个假节点上“存在”的属性——按类名给出，L3 的落点判断完全依赖它 */
  private static readonly PROPS: Record<string, string[]> = {
    Control: ["visible", "size_flags_horizontal", "size_flags_vertical", "size_flags_stretch_ratio", "mouse_default_cursor_shape", "layout_direction"],
    Label: ["visible", "size_flags_horizontal", "size_flags_vertical", "size_flags_stretch_ratio", "horizontal_alignment", "text_overrun_behavior", "autowrap_mode", "mouse_default_cursor_shape", "layout_direction"],
    Button: ["visible", "size_flags_horizontal", "size_flags_vertical", "size_flags_stretch_ratio", "alignment"],
    BoxContainer: ["alignment", "vertical", "size_flags_horizontal", "size_flags_vertical", "size_flags_stretch_ratio"],
    VBoxContainer: ["alignment", "vertical", "size_flags_horizontal", "size_flags_vertical", "size_flags_stretch_ratio"],
    MarginContainer: [],
    // 只有 stretch_ratio、没有两个轴的类：验证 setGrow 中逐轴的落点判断
    HalfFlags: ["size_flags_stretch_ratio"],
  };

  constructor(readonly node: CssNode) {}

  private get cls(): string {
    return String(this.node.cssType ?? "Control");
  }

  classOf(): string {
    return this.cls;
  }
  bulk<T>(_node: CssNode, apply: () => T): T {
    this.calls.push("bulk:begin");
    const out = apply();
    this.calls.push("bulk:end");
    return out;
  }
  mutateStyleBox(_node: CssNode, item: string, apply: (box: StyleBoxHandle) => void): void {
    this.calls.push(`stylebox:${item}`);
    const box = new FakeStyleBox((what) => this.styleboxMutations.push({ item, what }));
    apply(box);
  }
  setColorOverride(_node: CssNode, item: string, color: ColorLike): void {
    this.calls.push(`color:${item}`);
    this.lastColor = color;
  }
  setFontSizeOverride(_node: CssNode, item: string, size: number): void {
    this.calls.push(`font_size:${item}:${size}`);
  }
  setConstantOverride(_node: CssNode, item: string, value: number): void {
    this.calls.push(`constant:${item}:${value}`);
  }
  setFontOverride(_node: CssNode, item: string, source: FontSource): boolean {
    // 仅验证「是否存在落点、落在哪个 item」，不验证加载：资源路径直接记录路径，
    // 系统字体记录名称列表，两者在调用流水中可以区分
    const what = "path" in source ? source.path : `sys:${source.systemFontNames.join("|")}`;
    this.calls.push(`font:${item}:${what}`);
    return true;
  }
  setMinimumSize(_node: CssNode, width: number | null, height: number | null): void {
    this.calls.push(`min:${width ?? "-"}x${height ?? "-"}`);
  }
  setOpacity(_node: CssNode, alpha: number): void {
    this.calls.push(`opacity:${alpha}`);
  }
  setNodeNumber(_node: CssNode, prop: string, value: number): void {
    this.calls.push(`node:${prop}:${value}`);
    this.nodeNumbers[prop] = value;
  }
  getNodeNumber(_node: CssNode, prop: string): number {
    return this.nodeNumbers[prop] ?? 0;
  }
  setNodeBoolean(_node: CssNode, prop: string, value: boolean): void {
    this.calls.push(`node:${prop}:${value}`);
  }
  hasNodeProperty(_node: CssNode, prop: string): boolean {
    // 真实引擎沿继承链查属性（ClassDB），此处也必须沿：只查本类会将
    // Control 上的 size_flags_* 当成不存在（flex 就是这样静默不落地的）
    // 表中点名的类就按点名的算（MarginContainer / HalfFlags 依赖它模拟“缺属性”），
    // 未点名的类退回 Control 那一层——真实引擎沿继承链查找，不会一个属性都没有
    const own = FakeBackend.PROPS[this.cls];
    return (own ?? FakeBackend.PROPS.Control ?? []).includes(prop);
  }
  parentOf(node: CssNode): CssNode | null {
    return (node.parent as CssNode) ?? null;
  }
  childrenOf(node: CssNode): CssNode[] {
    return ((node as { children?: CssNode[] }).children as CssNode[]) ?? [];
  }
  clearProperty(_node: CssNode, cssName: string): void {
    this.calls.push(`clear:${cssName}`);
  }
  applyProperty(
    node: CssNode,
    cssName: string,
    raw: string,
    warnings: string[],
    states: ReadonlySet<string>,
  ): boolean {
    // 假 backend 也要使用真实的属性映射，否则“CSS 名 → theme item”这一层就没有被验到
    return applyCssProperty(node, cssName, raw, { backend: this, warn: (k, m) => this.warned.push(`${k}::${m}`), states }, warnings);
  }

  lastColor: ColorLike | null = null;
}

/** 只记录“改了什么”的 StyleBoxFlat 替身 */
class FakeStyleBox implements StyleBoxHandle {
  constructor(private readonly log: (what: string) => void) {}
  setBackground(color: ColorLike | null): void {
    this.log(`bg(${color ? `${color.r},${color.g},${color.b},${color.a}` : "null"})`);
  }
  setTexture(path: string): void {
    this.log(`texture(${path})`);
  }
  setCornerRadii(radii: Partial<FourCorners>): void {
    this.log(`radius(${JSON.stringify(radii)})`);
  }
  setBorderWidths(widths: Partial<FourSides>): void {
    this.log(`borderWidth(${JSON.stringify(widths)})`);
  }
  setBorderColor(color: ColorLike | null): void {
    this.log(`borderColor(${color ? `${color.r},${color.g},${color.b},${color.a}` : "null"})`);
  }
  setShadow(shadow: { color: ColorLike; size: number; offsetX: number; offsetY: number }): void {
    this.log(`shadow(${shadow.size},${shadow.offsetX},${shadow.offsetY})`);
  }
  setContentMargin(margin: Partial<FourSides>): void {
    this.log(`contentMargin(${JSON.stringify(margin)})`);
  }
}

function node(cssType: string): CssNode {
  return { cssType, parent: null };
}

function apply(cssType: string, name: string, value: string) {
  const target = node(cssType);
  const backend = new FakeBackend(target);
  const warnings: string[] = [];
  const known = applyCssProperty(
    target,
    name,
    value,
    // 这些用例验的是「CSS 名 → theme item」的基落点，不涉及状态伪类 → 空状态集
    { backend, warn: (key, message) => backend.warned.push(`${key}::${message}`), states: NO_STATES },
    warnings,
  );
  return { backend, known, warnings, calls: backend.calls };
}

describe("L1 外观属性", () => {
  it("color → font_color 覆盖，值按 0..1 浮点", () => {
    const { calls, backend } = apply("Label", "color", "#ff8800");
    expect(calls).toEqual(["color:font_color"]);
    expect(backend.lastColor).toMatchObject({ r: 1, g: 136 / 255, b: 0 });
  });

  it("font-size 认 px 也认无单位数字；em 明确不接", () => {
    expect(apply("Label", "font-size", "28").calls).toEqual(["font_size:font_size:28"]);
    expect(apply("Label", "font-size", "28px").calls).toEqual(["font_size:font_size:28"]);
    const em = apply("Label", "font-size", "1.5em");
    expect(em.calls).toEqual([]);
    expect(em.warnings.join("\n")).toContain("font-size");
  });

  it("background-color 落在该类的底色 stylebox（Button→normal，PanelContainer→panel）", () => {
    expect(apply("Button", "background-color", "red").calls).toEqual(["stylebox:normal"]);
    expect(apply("PanelContainer", "background-color", "red").calls).toEqual(["stylebox:panel"]);
  });

  it("不绘制背景的类（VBoxContainer）写入背景 → 输出告警并说明处理方式，不假装成功", () => {
    const { calls, backend } = apply("VBoxContainer", "background-color", "red");
    expect(calls).toEqual([]);
    expect(backend.warned.join("\n")).toContain("不绘制任何 stylebox");
    expect(backend.warned.join("\n")).toContain("PanelContainer");
  });

  it("圆角按角名落位（top-left 不会被归到 left）", () => {
    const topLeft = apply("Button", "border-top-left-radius", "8px");
    expect(topLeft.backend.styleboxMutations[0].what).toBe('radius({"topLeft":8})');
    const topRight = apply("Button", "border-top-right-radius", "4px");
    expect(topRight.backend.styleboxMutations[0].what).toBe('radius({"topRight":4})');
    const bottomLeft = apply("Button", "border-bottom-left-radius", "2px");
    expect(bottomLeft.backend.styleboxMutations[0].what).toBe('radius({"bottomLeft":2})');
  });

  it("border-*-width 落到对应边的宽度", () => {
    const { backend } = apply("Button", "border-bottom-width", "3px");
    expect(backend.styleboxMutations[0].what).toBe('borderWidth({"bottom":3})');
  });

  it("border-color 单色（Godot 没有四边异色）", () => {
    const { backend } = apply("Button", "border-color", "rgb(1 2 3)");
    expect(backend.styleboxMutations[0].what).toContain("borderColor(0.00392156862745098,0.00784313725490196,0.011764705882352941,1)");
  });

  it("box-shadow → shadow(size, offsetX, offsetY)", () => {
    const { backend } = apply("Button", "box-shadow", "2px 3px 4px rgba(0 0 0 / 50%)");
    expect(backend.styleboxMutations[0].what).toBe("shadow(4,2,3)");
  });

  it("padding → content_margin（四值一次给全）", () => {
    const { backend } = apply("Button", "padding", "1px 2px");
    expect(backend.styleboxMutations[0].what).toBe('contentMargin({"top":1,"right":2,"bottom":1,"left":2})');
  });

  it("opacity → modulate.a，越界钳到 0..1", () => {
    expect(apply("Label", "opacity", "0.5").calls).toEqual(["opacity:0.5"]);
    expect(apply("Label", "opacity", "3").calls).toEqual(["opacity:1"]);
  });
});

describe("L3 布局属性（只做翻译提示）", () => {
  it("width / height 无落点：说明 Godot 无确定宽度，并给出替代写法", () => {
    // 无落点走 ctx.warn（按「属性 + 原因」去重），不是 parse 阶段的 warnings 列表
    const width = apply("Label", "width", "120px");
    expect(width.calls).toEqual([]);
    expect(width.backend.warned.join("\n")).toContain("min-width");
    const height = apply("Label", "height", "40px");
    expect(height.calls).toEqual([]);
    expect(height.backend.warned.join("\n")).toContain("min-height");
  });

  it("min-width: 50% 明确不接受（Godot 仅有像素下界）", () => {
    const { calls, warnings } = apply("Label", "min-width", "50%");
    expect(calls).toEqual([]);
    expect(warnings.join("\n")).toContain("百分比");
  });

  it("margin → MarginContainer 的 theme 常量（不是节点属性！）", () => {
    const ok = apply("MarginContainer", "margin", "4px");
    expect(ok.calls).toEqual([
      "constant:margin_top:4",
      "constant:margin_right:4",
      "constant:margin_bottom:4",
      "constant:margin_left:4",
    ]);
    const bad = apply("Label", "margin", "8px");
    expect(bad.calls).toEqual([]);
    expect(bad.backend.warned.join("\n")).toContain("不会擅自向节点树插入容器");
  });

  it("gap → theme 常量 separation（Godot 4 没这个属性！），GridContainer 写 h/v 两条", () => {
    // 写成 `node.separation = 10` 在 JS 侧不报错也不生效，静默无效最难排查，
    // 因此这条将“落点是 theme 常量”固定住（引擎侧另有 get_theme_constant 对账）。
    expect(apply("VBoxContainer", "gap", "10px").calls).toEqual(["constant:separation:10"]);
    expect(apply("GridContainer", "gap", "6px").calls).toEqual([
      "constant:h_separation:6",
      "constant:v_separation:6",
    ]);
    const bad = apply("Label", "gap", "10px");
    expect(bad.calls).toEqual([]);
    expect(bad.backend.warned.join("\n")).toContain("separation");
  });

  it("justify-content 三档能落，space-* 告警", () => {
    expect(apply("VBoxContainer", "justify-content", "center").calls).toEqual(["node:alignment:1"]);
    expect(apply("VBoxContainer", "justify-content", "flex-end").calls).toEqual(["node:alignment:2"]);
    const space = apply("VBoxContainer", "justify-content", "space-between");
    expect(space.calls).toEqual([]);
    expect(space.backend.warned.join("\n")).toContain("BEGIN / CENTER / END");
  });

  it("justify-content 仅作用于容器：Button 的 alignment 是文本对齐，不在此接管", () => {
    const r = apply("Button", "justify-content", "center");
    expect(r.calls).toEqual([]);
    expect(r.backend.warned.join("\n")).toContain("不是容器");
  });

  it("flex: n → size_flags 加 EXPAND 并设 stretch_ratio", () => {
    const { backend } = apply("VBoxContainer", "flex", "2");
    expect(backend.nodeNumbers).toMatchObject({
      size_flags_horizontal: 2,
      size_flags_vertical: 2,
      size_flags_stretch_ratio: 2,
    });
  });

  it("visibility: hidden → visible=false", () => {
    expect(apply("Label", "visibility", "hidden").calls).toEqual(["node:visible:false"]);
    expect(apply("Label", "visibility", "visible").calls).toEqual(["node:visible:true"]);
  });

  it("text-align → horizontal_alignment", () => {
    expect(apply("Label", "text-align", "center").calls).toEqual(["node:horizontal_alignment:1"]);
    const bad = apply("VBoxContainer", "text-align", "center");
    expect(bad.calls).toEqual([]);
    expect(bad.backend.warned.join("\n")).toContain("horizontal_alignment");
  });

  it("text-align 在 Button / LineEdit 上回退到 alignment（容器类除外）", () => {
    // Button、LineEdit 的同义属性叫 alignment，两个枚举取值一致
    expect(apply("Button", "text-align", "center").calls).toEqual(["node:alignment:1"]);
    // FlowContainer 也有 alignment，但那是布局对齐，不属于 text-align
    expect(apply("FlowContainer", "text-align", "center").calls).toEqual([]);
  });

  it("RichTextLabel：正文色与正文字号不带 font_ 前缀，由别名表接住", () => {
    expect(apply("RichTextLabel", "color", "red").calls).toEqual(["color:default_color"]);
    expect(apply("RichTextLabel", "font-size", "20px").calls).toEqual(["font_size:normal_font_size:20"]);
  });
});

describe("明确不做的东西必须出声", () => {
  it("display / position / transition 各有自己的说法，不是一句「不支持」", () => {
    for (const [name, value, needle] of [
      ["display", "flex", "节点树结构"],
      ["position", "absolute", "anchors"],
      ["transition", "all 1s", "动画不在支持范围内"],
    ] as const) {
      const { calls, backend } = apply("Label", name, value);
      expect(calls, name).toEqual([]);
      expect(backend.warned.join("\n"), name).toContain(needle);
    }
  });

  it("无法识别的属性名返回 false（与「可识别但无落点」区分开）", () => {
    expect(apply("Label", "mystery-prop", "x").known).toBe(false);
    expect(apply("Label", "color", "red").known).toBe(true);
  });

  it("var() / calc() / 全局关键字统一兜住，不改节点", () => {
    for (const value of ["var(--x)", "calc(100% - 8px)", "inherit", "unset", "initial"]) {
      const { calls, backend } = apply("Label", "color", value);
      expect(calls, value).toEqual([]);
      expect(backend.warned.length, value).toBe(1);
    }
  });

  it("空值什么都不做（Angular 解绑时会传空串）", () => {
    expect(apply("Label", "color", "").calls).toEqual([]);
  });
});

describe("属性表面", () => {
  it("L1 那批都在，且都标着「等价支持」", () => {
    const names = cssPropertyNames();
    for (const name of [
      "color",
      "background-color",
      "border-color",
      "border-top-left-radius",
      "box-shadow",
      "padding",
      "font-size",
      "opacity",
    ]) {
      expect(names, name).toContain(name);
      expect(isAppearanceProperty(name), name).toBe(true);
    }
  });

  it("L3 的属性存在但不承诺等价", () => {
    expect(isAppearanceProperty("width")).toBe(false);
    expect(isAppearanceProperty("display")).toBe(false);
  });

  it("每个属性名都是 kebab-case（CSS 口径，不做 camelCase 两套并存）", () => {
    const bad = cssPropertyNames().filter((name) => /[A-Z_]/.test(name));
    expect(bad).toEqual([]);
  });
});

describe("beforeEach 占位（防止误加全局状态）", () => {
  beforeEach(() => {
    /* 每个用例自行构造 backend，此处没有共享状态会被污染 */
  });

  it("两次 apply 互不影响", () => {
    expect(apply("Label", "color", "red").calls).toEqual(["color:font_color"]);
    expect(apply("Label", "opacity", "1").calls).toEqual(["opacity:1"]);
  });
});

describe("值不合法或没有落点：告警 + 放弃写入", () => {
  /** 两条告警通道：解析期的 warnings 与落点判断的 ctx.warn（进入 backend.warned） */
  const warned = (r: { warnings: string[]; backend: FakeBackend }) =>
    [...r.warnings, ...r.backend.warned].join("");

  it("background 是 background-color 的别名，同样落底色", () => {
    expect(apply("Button", "background", "red").calls).toContain("stylebox:normal");
  });

  it("在不绘制背景的类上写入底色：告警说明处理方式，不发出任何写入", () => {
    const r = apply("VBoxContainer", "background", "red");
    expect(warned(r)).toContain("不绘制任何 stylebox");
    expect(r.calls).toEqual([]);
  });

  it("词汇表中不存在的 theme item：告警并放弃（不是写个不生效的 override）", () => {
    const color = apply("MarginContainer", "color", "red");
    expect(warned(color)).toContain("词汇表中不存在");
    expect(color.calls).toEqual([]);
    const size = apply("MarginContainer", "font-size", "20px");
    expect(warned(size)).toContain("词汇表中不存在");
    expect(size.calls).toEqual([]);
  });

  it("颜色 / 数字 / 长度无法解析：各属性自己的文案", () => {
    expect(warned(apply("Label", "color", "notacolor"))).toContain("不是可解析的颜色");
    expect(warned(apply("Label", "opacity", "abc"))).toContain("不是 0..1 的数字");
    expect(warned(apply("Label", "font-size", "abc"))).toContain("不是长度");
    expect(warned(apply("Button", "border-top-width", "thick"))).toContain("border-top-width");
    expect(warned(apply("Button", "border-top-left-radius", "thick"))).toContain("border-top-left-radius");
    expect(warned(apply("Button", "padding", "a b c d e"))).toContain("padding");
    expect(warned(apply("MarginContainer", "margin-top", "thick"))).toContain("margin-top");
    expect(warned(apply("VBoxContainer", "gap", "thick"))).toContain("gap");
  });

  it("min-width / min-height 各写一轴，相对单位与百分比明确无落点", () => {
    expect(apply("Label", "min-width", "100px").calls).toContain("min:100x-");
    expect(apply("Label", "min-height", "40px").calls).toContain("min:-x40");
    expect(warned(apply("Label", "min-width", "3em"))).toContain("相对单位无落点");
    expect(warned(apply("Label", "min-width", "50%"))).toContain("百分比");
    expect(warned(apply("Label", "min-height", "abc"))).toContain("不是长度");
  });

  it("flex：none 当 0，首段不是数字就整条不写，flex-grow 非数字告警", () => {
    expect(apply("Label", "flex", "none").calls).toContain("node:size_flags_stretch_ratio:0");
    expect(warned(apply("Label", "flex", "auto 1 1"))).toContain("仅接受单个数字");
    expect(warned(apply("Label", "flex-grow", "abc"))).toContain("不是数字");
  });

  it("没有对应属性的类：justify-content / visibility / text-align 都不硬写", () => {
    // MarginContainer 的假 backend 没有 alignment / horizontal_alignment
    expect(apply("MarginContainer", "justify-content", "center").calls).toEqual([]);
    expect(apply("MarginContainer", "text-align", "center").calls).toEqual([]);
    expect(warned(apply("Label", "text-align", "justify"))).toContain("无对应值");
    expect(apply("Label", "text-align", "center").calls).toContain("node:horizontal_alignment:1");
  });

  it("lookupProperty：认得的返回定义，不认得的返回 undefined", () => {
    expect(lookupProperty("color")?.level).toBe(1);
    expect(lookupProperty("nope")).toBeUndefined();
  });

  it("不传 warnings 数组也能跑（默认参数）", () => {
    const target = node("Label");
    const backend = new FakeBackend(target);
    expect(() => applyCssProperty(target, "color", "notacolor", { backend, warn: () => {}, states: NO_STATES })).not.toThrow();
  });
});

describe("落点缺失的逐个属性（每个属性自己那条告警）", () => {
  const warned = (r: { warnings: string[]; backend: FakeBackend }) =>
    [...r.warnings, ...r.backend.warned].join("");

  /**
   * 这些属性全部落在 stylebox 上。VBoxContainer 不绘制底色，因此每一条都需自行告警并
   * 放弃——漏掉任意一条，症状都是“写了没反应、也没有提示”。
   */
  it("不画底的类：border / radius / padding / box-shadow 各自告警，零写入", () => {
    const cases: Array<[string, string]> = [
      ["background-color", "red"],
      ["border-color", "red"],
      ["border-top-width", "2px"],
      ["border-right-width", "2px"],
      ["border-bottom-width", "2px"],
      ["border-left-width", "2px"],
      ["border-top-left-radius", "4px"],
      ["border-top-right-radius", "4px"],
      ["border-bottom-left-radius", "4px"],
      ["border-bottom-right-radius", "4px"],
      ["box-shadow", "2px 3px 4px rgba(0,0,0,0.5)"],
      ["padding", "4px"],
      ["padding-top", "4px"],
      ["padding-right", "4px"],
      ["padding-bottom", "4px"],
      ["padding-left", "4px"],
    ];
    for (const [property, value] of cases) {
      const r = apply("VBoxContainer", property, value);
      expect(r.calls, property).toEqual([]);
      expect(warned(r), property).toContain(property);
    }
  });

  it("box-shadow: none 是合法值：不写阴影也不告警", () => {
    const r = apply("Button", "box-shadow", "none");
    expect(r.calls).toEqual([]);
    expect(warned(r)).toBe("");
  });

  it("margin 简写段数不符：说明期望几个长度", () => {
    expect(warned(apply("Label", "margin", "a b c d e"))).toContain("期望 1–4 个长度");
  });

  it("节点上没有对应属性时 visibility / flex 也不硬写", () => {
    // 假 backend 中 MarginContainer 一个节点属性都没有
    const vis = apply("MarginContainer", "visibility", "hidden");
    expect(vis.calls).toEqual([]);
    expect(warned(vis)).toContain("visible");
    const grow = apply("MarginContainer", "flex", "1");
    expect(grow.calls).toEqual([]);
    expect(warned(grow)).toContain("size_flags_stretch_ratio");
    // 有 stretch_ratio、没有两个轴：ratio 不写，轴也不置位
    const half = apply("HalfFlags", "flex", "2");
    expect(half.calls).toEqual([]);
    expect(warned(half)).toContain("size_flags_horizontal");
    // 两个轴都在 → 置 SIZE_EXPAND 并写 ratio
    expect(apply("Label", "flex", "2").calls).toContain("node:size_flags_stretch_ratio:2");
    expect(apply("Label", "visibility", "hidden").calls).toContain("node:visible:false");
  });
});

/* ------------------------------------------------------------------ *
 * 新增映射：gap 的两轴、单边边框颜色、光标、文本裁切、换行策略、书写方向
 * ------------------------------------------------------------------ */

describe("gap 家族（行轴与列轴）", () => {
  const warned = (r: { warnings: string[]; backend: FakeBackend }) =>
    [...r.warnings, ...r.backend.warned].join("");

  /** 需要预设节点属性（如 BoxContainer.vertical）时走这个入口 */
  function applyWith(cssType: string, name: string, value: string, numbers: Record<string, number>) {
    const target = node(cssType);
    const backend = new FakeBackend(target);
    Object.assign(backend.nodeNumbers, numbers);
    const warnings: string[] = [];
    applyCssProperty(
      target,
      name,
      value,
      { backend, warn: (key, message) => backend.warned.push(`${key}::${message}`), states: NO_STATES },
      warnings,
    );
    return { backend, warnings, calls: backend.calls };
  }

  it("双轴容器：column-gap → h_separation，row-gap → v_separation", () => {
    expect(apply("GridContainer", "column-gap", "6px").calls).toEqual(["constant:h_separation:6"]);
    expect(apply("GridContainer", "row-gap", "4px").calls).toEqual(["constant:v_separation:4"]);
    // gap 的两值写法：行在前、列在后（CSS 轴序与 h/v 相反）
    expect(apply("GridContainer", "gap", "4px 6px").calls).toEqual([
      "constant:h_separation:6",
      "constant:v_separation:4",
    ]);
  });

  it("单轴容器：BoxContainer 只有一个 separation，另一轴输出告警", () => {
    // HBoxContainer（vertical = 0）：列间距即 separation，行间距无落点
    expect(applyWith("BoxContainer", "column-gap", "8px", {}).calls).toEqual(["constant:separation:8"]);
    const rowOnHBox = applyWith("BoxContainer", "row-gap", "8px", {});
    expect(rowOnHBox.calls).toEqual([]);
    expect(warned(rowOnHBox)).toContain("无落点");
    // VBoxContainer（vertical = 1）：轴向相反
    expect(applyWith("VBoxContainer", "row-gap", "8px", { vertical: 1 }).calls).toEqual(["constant:separation:8"]);
    const colOnVBox = applyWith("VBoxContainer", "column-gap", "8px", { vertical: 1 });
    expect(colOnVBox.calls).toEqual([]);
    expect(warned(colOnVBox)).toContain("无落点");
    // `gap: 8px` 两轴同值：单轴容器仅写入一次，且不告警
    expect(applyWith("VBoxContainer", "gap", "8px", { vertical: 1 }).calls).toEqual(["constant:separation:8"]);
    expect(warned(applyWith("VBoxContainer", "gap", "8px", { vertical: 1 }))).toBe("");
    // 两个取值不相等时，无法落地的另一轴必须输出告警
    expect(warned(applyWith("VBoxContainer", "gap", "4px 6px", { vertical: 1 }))).toContain("column-gap");
  });

  it("不具备间距常量的类：三者均输出告警且不写入", () => {
    for (const name of ["gap", "row-gap", "column-gap"]) {
      const r = apply("Label", name, "8px");
      expect(r.calls, name).toEqual([]);
      expect(warned(r), name).toContain("separation");
    }
  });

  it("取值不合法：说明期望的长度个数", () => {
    expect(warned(apply("GridContainer", "gap", "a b c"))).toContain("期望 1–2 个长度");
    expect(warned(apply("GridContainer", "row-gap", "thick"))).toContain("row-gap");
  });
});

describe("边框单边颜色（Godot 四边同色）", () => {
  const warned = (r: { warnings: string[]; backend: FakeBackend }) =>
    [...r.warnings, ...r.backend.warned].join("");

  it("写入 border_color，同时说明其作用于整圈", () => {
    for (const side of ["top", "right", "bottom", "left"]) {
      const r = apply("Button", `border-${side}-color`, "red");
      expect(r.backend.styleboxMutations.map((m) => m.what), side).toContain(
        "borderColor(1,0,0,1)",
      );
      expect(warned(r), side).toContain("四边同色");
    }
  });

  it("不绘制 stylebox 的类：输出各自的告警，而非静默成功", () => {
    const r = apply("VBoxContainer", "border-top-color", "red");
    expect(r.calls).toEqual([]);
    expect(warned(r)).toContain("border-top-color");
  });
});

describe("caret-color", () => {
  it("落在 LineEdit 的 caret_color theme 色上", () => {
    expect(apply("LineEdit", "caret-color", "red").calls).toEqual(["color:caret_color"]);
  });

  it("不具备 caret_color 的类：输出词汇表告警，不写入无效 override", () => {
    const r = apply("Label", "caret-color", "red");
    expect(r.calls).toEqual([]);
    expect(r.backend.warned.join("\n")).toContain("词汇表中不存在");
  });
});

describe("文本与交互（L3）", () => {
  const warned = (r: { warnings: string[]; backend: FakeBackend }) =>
    [...r.warnings, ...r.backend.warned].join("");

  it("cursor → mouse_default_cursor_shape 的枚举值", () => {
    expect(apply("Label", "cursor", "pointer").calls).toEqual(["node:mouse_default_cursor_shape:2"]);
    expect(apply("Label", "cursor", "text").calls).toEqual(["node:mouse_default_cursor_shape:1"]);
    expect(apply("Label", "cursor", "not-allowed").calls).toEqual(["node:mouse_default_cursor_shape:8"]);
    // 候选列表取首个；大小写不敏感
    expect(apply("Label", "cursor", "Pointer, auto").calls).toEqual(["node:mouse_default_cursor_shape:2"]);
    const unknown = apply("Label", "cursor", "zoom-in");
    expect(unknown.calls).toEqual([]);
    expect(warned(unknown)).toContain("无对应取值");
  });

  it("text-overflow → text_overrun_behavior（clip 1 / ellipsis 3）", () => {
    expect(apply("Label", "text-overflow", "clip").calls).toEqual(["node:text_overrun_behavior:1"]);
    expect(apply("Label", "text-overflow", "ellipsis").calls).toEqual(["node:text_overrun_behavior:3"]);
    // 自定义省略号字符串无落点（引擎固定用 …）
    const custom = apply("Label", "text-overflow", 'ellipsis "…"');
    expect(custom.calls).toEqual(["node:text_overrun_behavior:3"]);
    expect(warned(custom)).toContain("自定义省略号");
    expect(warned(apply("Label", "text-overflow", "fade"))).toContain("无对应取值");
    // 不具备该属性的类不写入
    expect(apply("MarginContainer", "text-overflow", "ellipsis").calls).toEqual([]);
  });

  it("white-space → autowrap_mode（nowrap 0 / normal 2 / break-all 3）", () => {
    expect(apply("Label", "white-space", "nowrap").calls).toEqual(["node:autowrap_mode:0"]);
    expect(apply("Label", "white-space", "normal").calls).toEqual(["node:autowrap_mode:2"]);
    expect(apply("Label", "white-space", "break-all").calls).toEqual(["node:autowrap_mode:3"]);
    expect(warned(apply("Label", "white-space", "collapse"))).toContain("无对应取值");
  });

  it("direction → layout_direction（ltr 2 / rtl 3）", () => {
    expect(apply("Label", "direction", "rtl").calls).toEqual(["node:layout_direction:3"]);
    expect(apply("Label", "direction", "ltr").calls).toEqual(["node:layout_direction:2"]);
    expect(warned(apply("Label", "direction", "rtl-vertical"))).toContain("无对应取值");
    // inherit / initial 属于全局关键字，在进入属性表前即被拦截（Godot 的 theme 无 unset）
    const kw = apply("Label", "direction", "inherit");
    expect(kw.calls).toEqual([]);
    expect(warned(kw)).toContain("无落点");
  });
});

describe("新增属性均在属性表中，且承诺级别标记正确", () => {
  it("L1：caret-color / border-*-color 是等价支持", () => {
    expect(isAppearanceProperty("caret-color")).toBe(true);
    expect(isAppearanceProperty("border-top-color")).toBe(true);
  });

  it("L3：gap 家族与文本类只做翻译提示", () => {
    for (const name of ["row-gap", "column-gap", "cursor", "text-overflow", "white-space", "direction"]) {
      expect(cssPropertyNames(), name).toContain(name);
      expect(isAppearanceProperty(name), name).toBe(false);
    }
  });

  it("此前无法识别的常见写法，现在要么有落点、要么有明确说明", () => {
    for (const name of ["max-width", "max-height", "background-image", "align-self", "order", "word-spacing"]) {
      expect(cssPropertyNames(), name).toContain(name);
    }
  });
});
