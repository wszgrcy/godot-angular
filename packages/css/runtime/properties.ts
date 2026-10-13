import type { ColorLike, CssNode, FourCorners, FourSides, StyleBackend, StyleBoxHandle } from "../types";
import { isGlobalKeyword, isVariableReference, hasCalc } from "../value/keyword";
import { parseColor } from "../value/color";
import { isUnsupportedUnit, parseLength, parseNumber } from "../value/length";
import { parseBoxShadow } from "../value/shadow";
import { fourSidesFromParts } from "../value/sides";
import { splitValueTokens } from "../value/tokens";
import { hasThemeItem, itemForStates, pickBackgroundStylebox } from "../vocabulary";

/**
 * 来源：无
 */
export interface ApplyContext {
  backend: StyleBackend;
  warn(key: string, message: string): void;
}

/**
 * 来源：NativeScript/packages/core/ui/core/properties/index.ts :: CssProperty
 * 等级：仅思路一致
 * 差异：上游的 CssProperty 是一个注册对象，靠 Object.defineProperty 在 Style 上生成读写
 * 访问器，并携带 cssName / name / cssLocalName / defaultValue / valueChanged 等元数据，
 * 写入时当场生效；本侧的 CssProperty 只是「解析 + 落地」两个纯函数，调用时机由级联
 * 决定（不在属性自身内部）。level 字段本侧新增，用于区分“等价支持”与“仅翻译提示”。
 *
 * 一条 CSS 属性：将已解析的值落到节点上
 */
export interface CssProperty {
  /** 承诺级别：1 = 等价支持，3 = 只做翻译提示 */
  readonly level: 1 | 3;
  /** 解析。返回 null 表示无法解析（原因已写入 warnings） */
  parse(raw: string, warnings: string[]): unknown;
  /** 落到节点。value 必定是 parse 成功的结果 */
  apply(node: CssNode, value: unknown, ctx: ApplyContext): void;
}

/* ------------------------------------------------------------------ *
 * 值解析的小工具
 * ------------------------------------------------------------------ */

/**
 * 来源：NativeScript/packages/core/ui/styling/style-properties.ts 中各属性的 Length.parse 调用
 * 等级：仅思路一致
 * 差异：上游按属性区分 dip / 像素并走 PercentLength，本侧统一按像素接受。
 *
 * 长度：px 与无单位均接受（Godot 的 theme item 本就是像素）
 */
function px(raw: string): number | null {
  return parseLength(raw)?.value ?? null;
}

/**
 * 来源：NativeScript/packages/core/ui/styling/style-properties.ts :: positioningFromParts
 *      加上各 border-*-width / padding / margin 转换器里的逐边 Length.parse
 * 等级：部分修改（主体一致）
 * 改动：上游先切四段再逐段解析，本侧同序；上游对非法值抛错，本侧返回 null。
 */
function sides(raw: string): FourSides | null {
  const expanded = fourSidesFromParts(splitValueTokens(raw));
  if (!expanded) return null;
  const values = expanded.map((part) => px(part));
  const [top, right, bottom, left] = values;
  if (top === null || right === null || bottom === null || left === null) return null;
  return { top, right, bottom, left };
}

/**
 * 来源：NativeScript/packages/core/ui/styling/style-properties.ts :: backgroundColorProperty 的 valueConverter
 * 等级：仅思路一致
 * 差异：上游用 new Color(value)（失败抛异常），本侧用 parseColor（失败返回 null）。
 */
function color(raw: string): ColorLike | null {
  return parseColor(raw);
}

/**
 * 来源：NativeScript/packages/core/ui/core/view-base/index.ts :: ViewBase.cssPseudoClasses
 * 等级：仅思路一致
 * 差异：上游在 CssState 内维护伪类集并驱动动画，本侧只读节点上的集合做 item 名选择。
 *
 * 节点当前处于哪些伪类状态（缺少该字段 = 一个也未开启）
 */
const NO_STATES: ReadonlySet<string> = new Set<string>();
function activeStates(node: CssNode): { has(name: string): boolean } {
  const set = node.cssPseudoClasses;
  return set instanceof Set ? (set as Set<string>) : NO_STATES;
}

/**
 * 来源：无
 *
 * 将基 item 替换为当前状态真正需要写入的那个：引擎在 hover 时读取的是 `font_hover_color`，
 * 写入 `font_color` 不会显示。词汇表中没有这个变体时退回基 item，不告警。
 */
function stateItem(node: CssNode, ctx: ApplyContext, kind: "color" | "stylebox", base: string): string {
  return itemForStates(ctx.backend.classOf(node), kind, base, activeStates(node));
}

/**
 * 来源：无
 *
 * 该类实际绘制哪个 stylebox（底色落点）。无法落点时告警并说明处理方式
 */
function backgroundItem(node: CssNode, ctx: ApplyContext, cssName: string): string | null {
  const cls = ctx.backend.classOf(node);
  const item = pickBackgroundStylebox(cls);
  if (!item) {
    ctx.warn(
      `bg:${cls}:${cssName}`,
      `${cssName} 在 ${cls} 上无落点：${cls} 不绘制任何 stylebox（Godot 仅为会绘制背景的类提供 item，`
        + "如 Button 的 normal、PanelContainer 的 panel）。如需为其设置底色，请使用 PanelContainer 包裹一层，"
        + "或对该节点调用 add_theme_stylebox_override 传入 StyleBoxFlat。",
    );
  }
  if (!item) return null;
  return itemForStates(cls, "stylebox", item, activeStates(node));
}

/**
 * 来源：无
 *
 * theme item 存在性检查（词汇表来自引擎 dump）
 */
function requireItem(
  node: CssNode,
  ctx: ApplyContext,
  kind: "color" | "font_size" | "constant",
  item: string,
  cssName: string,
): boolean {
  const cls = ctx.backend.classOf(node);
  if (hasThemeItem(cls, kind, item)) return true;
  ctx.warn(
    `item:${cls}:${kind}:${item}:${cssName}`,
    `${cssName} 需要写入 ${cls} 的 ${kind} "${item}"，但 ${cls} 的词汇表中不存在该项（已沿父链查找），已忽略。`,
  );
  return false;
}

/* ------------------------------------------------------------------ *
 * 属性表
 * ------------------------------------------------------------------ */

/**
 * 来源：NativeScript/packages/core/ui/styling/style-properties.ts :: positioningFromParts 的边序
 * 等级：完全来自（一字未改）
 *
 * 四条边 / 四个角：`border-*-width`、`padding-*`、`margin-*` 均按此顺序展开
 */
const BORDER_SIDES = ["top", "right", "bottom", "left"] as const;

/**
 * 来源：NativeScript/packages/core/ui/styling/style-properties.ts :: borderRadiusProperty.converter
 * 等级：完全来自（一字未改）
 */
const CORNERS = ["top-left", "top-right", "bottom-right", "bottom-left"] as const;

const CORNER_KEY: Record<string, keyof FourCorners> = {
  "top-left": "topLeft",
  "top-right": "topRight",
  "bottom-right": "bottomRight",
  "bottom-left": "bottomLeft",
};

/**
 * 来源：无
 *
 * justify-content → BoxContainer.alignment，仅三档
 */
const ALIGNMENT: Record<string, number> = {
  "flex-start": 0,
  start: 0,
  normal: 0,
  left: 0,
  center: 1,
  "flex-end": 2,
  end: 2,
  right: 2,
};

const TEXT_ALIGN: Record<string, number> = { left: 0, center: 1, right: 2, start: 0, end: 2 };

/* ---------------- 明确不做的东西 ---------------- */

/**
 * 来源：无
 *
 * 这些属性**没有**落点。列出来不是为了支持，而是为了让告警能给出有用的描述：
 * 只说“不支持 display”与“display 的落点是容器结构，无权修改节点树”
 * 是两种完全不同的可用性。
 */
const NO_LANDING: Record<string, string> = {
  display: "display 的落点是节点树结构（元素的包含关系），而节点树由 Angular 持有，不做擅自修改",
  "flex-direction": "flex-direction 对应 VBoxContainer / HBoxContainer 的选择，属于节点树结构",
  "flex-wrap": "Godot 的容器不支持换行，无对应能力",
  "flex-basis": "flex-basis 需要确定的尺寸等值，而 Godot 仅提供下界（custom_minimum_size）",
  "flex-shrink": "Godot 的 size_flags 不提供收缩系数",
  "align-items": "BoxContainer 不提供交叉轴对齐属性",
  "align-content": "Godot 的容器不支持换行，无对应能力",
  "justify-items": "无对应能力",
  position: "position / inset 的落点是 anchors / offsets，语义差异过大，不做静默转换",
  inset: "position 的配套属性，同上",
  top: "position 的配套属性，同上",
  right: "position 的配套属性，同上",
  bottom: "position 的配套属性，同上",
  left: "position 的配套属性，同上",
  float: "无对应能力",
  grid: "GridContainer 的列数配置在节点上，不从 CSS 推导",
  "grid-template-columns": "同上",
  "font-family": "Godot 的字体是 Font 资源，CSS 字体名无对应能力（更换字体请使用 Theme 的 font item）",
  "font-weight": "同上（粗体对应另一个 Font 资源）",
  "font-style": "同上",
  "line-height": "Label 不提供行高属性",
  "letter-spacing": "无对应能力",
  "text-decoration": "无对应能力",
  "text-transform": "无对应能力",
  transform: "Godot 的 transform 位于 CanvasItem，语义与 CSS 差异过大",
  transition: "动画不在支持范围内（见文档第七节）；Godot 侧请使用 Tween",
  animation: "动画不在支持范围内（见文档第七节）",
  "animation-name": "动画不在支持范围内（见文档第七节）",
  cursor: "Godot 的鼠标形状由 Control.mouse_default_cursor_shape 决定，取值表与 CSS 不同",
  outline: "StyleBoxFlat 无 outline 对应能力（焦点样式请使用 :focus 的 stylebox）",
  "z-index": "Godot 的绘制顺序由节点顺序决定，修改它等同于修改节点树",
  overflow: "Godot 的裁剪由父容器的 clip_contents 决定",
  "user-select": "无对应能力",
  "pointer-events": "Godot 的 mouse_filter 取值不同，不做静默转换",
};

/**
 * 来源：NativeScript/packages/core/ui/styling/style-properties.ts（CSS 属性 → 落点的注册表）
 * 等级：仅思路一致
 * 差异：上游是运行时注册表（registerCssProperty + Object.defineProperty 生成访问器，带
 * 默认值与变更回调），本侧是一张常量表（无状态、无注册时机、无 setter）；上游收录数百
 * 个属性，本侧只收录有 Godot 落点的那一批，其余归入 NO_LANDING。
 *
 * 属性表就是一张常量表：CSS 属性名 → 落点。没有状态、没有注册时机，
 * 因此直接书写字面量，不包 `define()` 那种包装（包一层只是把 `Map` 的键值对拆成四个位置参数，
 * 阅读时反而需要在脑中拼接回去）。四条边 / 四个角那几组用 `.map()` 展开后 spread 进来。
 */
const props = new Map<string, CssProperty>([
  /* ---------------- L1 外观 ---------------- */

  ["color", {
    level: 1,
    parse: (raw, warnings) => parseColorOr(raw, warnings, "color"),
    apply: (node, value, ctx) => {
      if (!requireItem(node, ctx, "color", "font_color", "color")) return;
      ctx.backend.setColorOverride(node, stateItem(node, ctx, "color", "font_color"), value as ColorLike);
    },
  }],

  ["font-size", {
    level: 1,
    parse: (raw, warnings) => {
      const length = parseLength(raw);
      if (!length) {
        warnings.push(`font-size: "${raw}" 无法解析（支持 px 与无单位数字）`);
        return null;
      }
      return Math.round(length.value);
    },
    apply: (node, value, ctx) => {
      if (!requireItem(node, ctx, "font_size", "font_size", "font-size")) return;
      ctx.backend.setFontSizeOverride(node, "font_size", value as number);
    },
  }],

  ["opacity", {
    level: 1,
    parse: (raw, warnings) => {
      const alpha = parseNumber(raw, 0, 1);
      if (alpha === null) warnings.push(`opacity: "${raw}" 不是 0..1 的数字`);
      return alpha;
    },
    apply: (node, value, ctx) => ctx.backend.setOpacity(node, value as number),
  }],

  ["background-color", {
    level: 1,
    parse: (raw, warnings) => parseColorOr(raw, warnings, "background-color"),
    apply: (node, value, ctx) => {
      const item = backgroundItem(node, ctx, "background-color");
      if (!item) return;
      const colorValue = value as ColorLike;
      ctx.backend.mutateStyleBox(node, item, (box) => box.setBackground(colorValue));
    },
  }],

  /** `background: red`——只识别颜色部分，渐变 / 图片在 shorthand 层已告警并剔除 */
  ["background", {
    level: 1,
    parse: (raw, warnings) => parseColorOr(raw, warnings, "background"),
    apply: (node, value, ctx) => {
      const item = backgroundItem(node, ctx, "background");
      if (!item) return;
      const colorValue = value as ColorLike;
      ctx.backend.mutateStyleBox(node, item, (box) => box.setBackground(colorValue));
    },
  }],

  /* ---- 边框：宽度与颜色（Godot 只有单一 border_color，四边同色） ---- */

  ...BORDER_SIDES.map((side): [string, CssProperty] => [
    `border-${side}-width`,
    {
      level: 1,
      parse: (raw, warnings) => {
        const value = px(raw);
        if (value === null) warnings.push(`border-${side}-width: "${raw}" 不是长度`);
        return value === null ? null : Math.round(value);
      },
      apply: (node, value, ctx) => {
        const item = backgroundItem(node, ctx, `border-${side}-width`);
        if (!item) return;
        const widths: Partial<FourSides> = {};
        widths[side] = value as number;
        ctx.backend.mutateStyleBox(node, item, (box) => box.setBorderWidths(widths));
      },
    },
  ]),

  ["border-color", {
    level: 1,
    parse: (raw, warnings) => parseColorOr(raw, warnings, "border-color"),
    apply: (node, value, ctx) => {
      const item = backgroundItem(node, ctx, "border-color");
      if (!item) return;
      const colorValue = value as ColorLike;
      ctx.backend.mutateStyleBox(node, item, (box) => box.setBorderColor(colorValue));
    },
  }],

  /* ---- 圆角：Godot 四个角各一个 int ---- */

  ...CORNERS.map((corner): [string, CssProperty] => [
    `border-${corner}-radius`,
    {
      level: 1,
      parse: (raw, warnings) => {
        const value = px(raw.split("/")[0]);
        if (value === null) warnings.push(`border-${corner}-radius: "${raw}" 不是长度`);
        return value === null ? null : Math.round(value);
      },
      apply: (node, value, ctx) => {
        const item = backgroundItem(node, ctx, `border-${corner}-radius`);
        if (!item) return;
        const radii: Partial<FourCorners> = {};
        radii[CORNER_KEY[corner]] = value as number;
        ctx.backend.mutateStyleBox(node, item, (box) => box.setCornerRadii(radii));
      },
    },
  ]),

  /* ---- 阴影 ---- */

  ["box-shadow", {
    level: 1,
    parse: (raw, warnings) => {
      const parsed = parseBoxShadow(raw);
      warnings.push(...parsed.warnings);
      return parsed.shadow;
    },
    apply: (node, value, ctx) => {
      const item = backgroundItem(node, ctx, "box-shadow");
      if (!item) return;
      const shadow = value as ReturnType<typeof parseBoxShadow>["shadow"];
      if (!shadow) return;
      const box = shadow;
      ctx.backend.mutateStyleBox(node, item, (handle) =>
        handle.setShadow({
          color: box.color ?? { r: 0, g: 0, b: 0, a: 0.5 },
          size: box.blur,
          offsetX: box.offsetX,
          offsetY: box.offsetY,
        }),
      );
    },
  }],

  /* ---- 内边距：落在 stylebox 的 content_margin ---- */

  ["padding", {
    level: 1,
    parse: (raw, warnings) => {
      const value = sides(raw);
      if (!value) warnings.push(`padding: "${raw}" 期望 1–4 个长度`);
      return value;
    },
    apply: (node, value, ctx) => {
      const item = backgroundItem(node, ctx, "padding");
      if (!item) return;
      const margin = value as FourSides;
      ctx.backend.mutateStyleBox(node, item, (box) => box.setContentMargin(margin));
    },
  }],

  ...BORDER_SIDES.map((side): [string, CssProperty] => [
    `padding-${side}`,
    {
      level: 1,
      parse: (raw, warnings) => {
        const value = px(raw);
        if (value === null) warnings.push(`padding-${side}: "${raw}" 不是长度`);
        return value;
      },
      apply: (node, value, ctx) => {
        const item = backgroundItem(node, ctx, `padding-${side}`);
        if (!item) return;
        const margin: Partial<FourSides> = {};
        margin[side] = value as number;
        ctx.backend.mutateStyleBox(node, item, (box) => box.setContentMargin(margin));
      },
    },
  ]),

  /* ---------------- L3 布局（只做翻译提示） ---------------- */

  /** width / min-width 均落在 custom_minimum_size.x——Godot 中没有“等宽”，只有下界 */
  ["width", {
    level: 3,
    parse: (raw, warnings) => minimumAxis(raw, "width", warnings),
    apply: (node, value, ctx) => ctx.backend.setMinimumSize(node, value as number, null),
  }],

  ["min-width", {
    level: 3,
    parse: (raw, warnings) => minimumAxis(raw, "min-width", warnings),
    apply: (node, value, ctx) => ctx.backend.setMinimumSize(node, value as number, null),
  }],

  ["height", {
    level: 3,
    parse: (raw, warnings) => minimumAxis(raw, "height", warnings),
    apply: (node, value, ctx) => ctx.backend.setMinimumSize(node, null, value as number),
  }],

  ["min-height", {
    level: 3,
    parse: (raw, warnings) => minimumAxis(raw, "min-height", warnings),
    apply: (node, value, ctx) => ctx.backend.setMinimumSize(node, null, value as number),
  }],

  /** margin 仅 MarginContainer 有对应属性；落在其他类上必须发出提示（不自动包裹容器） */
  ["margin", {
    level: 3,
    parse: (raw, warnings) => {
      const value = sides(raw);
      if (!value) warnings.push(`margin: "${raw}" 期望 1–4 个长度`);
      return value;
    },
    apply: (node, value, ctx) => applyMargin(node, value as FourSides, "margin", ctx),
  }],

  ...BORDER_SIDES.map((side): [string, CssProperty] => [
    `margin-${side}`,
    {
      level: 3,
      parse: (raw, warnings) => {
        const value = px(raw);
        if (value === null) warnings.push(`margin-${side}: "${raw}" 不是长度`);
        return value;
      },
      apply: (node, value, ctx) => {
        // 只写入自身这一侧：将其余三侧当 0 一并写入，四条 longhand 会互相覆盖，
        // 最后一条（margin-left）胜出，`margin: 8px` 就变成“只有 left 有边距”
        applyMargin(node, { [side]: value as number }, `margin-${side}`, ctx);
      },
    },
  ]),

  /**
   * gap → separation。Godot 4 的 BoxContainer 没有 `separation` 属性（Godot 3 有），间距是
   * theme 常量，写成属性静默无效。GridContainer 只有 h_separation / v_separation，两个都写。
   */
  ["gap", {
    level: 3,
    parse: (raw, warnings) => {
      const value = px(raw.split(/\s+/)[0]);
      if (value === null) warnings.push(`gap: "${raw}" 不是长度`);
      return value === null ? null : Math.round(value);
    },
    apply: (node, value, ctx) => {
      const cls = ctx.backend.classOf(node);
      if (hasThemeItem(cls, "constant", "separation")) {
        ctx.backend.setConstantOverride(node, "separation", value as number);
        return;
      }
      if (
        hasThemeItem(cls, "constant", "h_separation")
        && hasThemeItem(cls, "constant", "v_separation")
      ) {
        ctx.backend.setConstantOverride(node, "h_separation", value as number);
        ctx.backend.setConstantOverride(node, "v_separation", value as number);
        return;
      }
      ctx.warn(
        `gap:${cls}`,
        `gap 无落点：${cls} 不是 BoxContainer / GridContainer，不存在 separation 间距常量。`
          + "容器间距请使用这两个类，或自行调用 add_theme_constant_override。已忽略。",
      );
    },
  }],

  ["justify-content", {
    level: 3,
    parse: (raw) => raw.trim().toLowerCase(),
    apply: (node, value, ctx) => {
      const mapped = ALIGNMENT[value as string];
      if (mapped === undefined) {
        ctx.warn(
          "justify-content:space",
          `justify-content: ${value} 无落点：Godot 的 BoxContainer.alignment 仅提供 BEGIN / CENTER / END 三档，`
            + "space-between / space-around / space-evenly 无对应取值。已忽略。",
        );
        return;
      }
      if (!hasNodeProperty(ctx, node, "alignment", "justify-content", "BoxContainer")) return;
      ctx.backend.setNodeNumber(node, "alignment", mapped);
    },
  }],

  /** flex: n → size_flags 的 EXPAND + stretch_ratio。没有 flex-basis 的对应物 */
  ["flex", {
    level: 3,
    parse: (raw, warnings) => {
      const first = raw.trim().split(/\s+/)[0];
      if (first === "none") return 0;
      const ratio = parseNumber(first);
      if (ratio === null) {
        warnings.push(`flex: "${raw}" 仅接受单个数字（flex-grow），其余部分无落点`);
        return null;
      }
      return ratio;
    },
    apply: (node, value, ctx) => {
      setGrow(node, value as number, ctx, "flex");
    },
  }],

  ["flex-grow", {
    level: 3,
    parse: (raw, warnings) => {
      const ratio = parseNumber(raw);
      if (ratio === null) warnings.push(`flex-grow: "${raw}" 不是数字`);
      return ratio;
    },
    apply: (node, value, ctx) => {
      // 仅设置 stretch_ratio 不够：Godot 的分配比例只在 SIZE_EXPAND 置位时才起作用，
      // 未置位则维持最小尺寸。而 `flex: 1` 在解析期就被简写展开为 `flex-grow: 1`，
      // 因此 EXPAND 必须在此处赋予，写在 `flex` 的 apply 里根本不会执行到。
      setGrow(node, value as number, ctx, "flex-grow");
    },
  }],

  /** visibility: hidden → visible=false。这是少数拥有直接对应物的 display 类属性 */
  ["visibility", {
    level: 3,
    parse: (raw) => (raw.trim().toLowerCase() === "hidden" ? "hidden" : "visible"),
    apply: (node, value, ctx) => {
      if (!hasNodeProperty(ctx, node, "visible", "visibility", "CanvasItem")) return;
      ctx.backend.setNodeBoolean(node, "visible", value !== "hidden");
    },
  }],

  /** text-align → 拥有 horizontal_alignment 的类（Label / Button / LineEdit…） */
  ["text-align", {
    level: 3,
    parse: (raw) => raw.trim().toLowerCase(),
    apply: (node, value, ctx) => {
      const mapped = TEXT_ALIGN[value as string];
      if (mapped === undefined) {
        ctx.warn("text-align", `text-align: ${value} 无对应值（可用 left / center / right），已忽略。`);
        return;
      }
      if (!hasNodeProperty(ctx, node, "horizontal_alignment", "text-align", "Label")) return;
      ctx.backend.setNodeNumber(node, "horizontal_alignment", mapped);
    },
  }],

  /* ---------------- 明确不做：只为使告警给出有用的描述 ---------------- */

  ...Object.entries(NO_LANDING).map(([name, why]): [string, CssProperty] => [
    name,
    {
      level: 3,
      parse: () => true,
      apply: (_node, _value, ctx) => {
        ctx.warn(`noland:${name}`, `${name} 无落点：${why}。已忽略。`);
      },
    },
  ]),
]);

/* ------------------------------------------------------------------ *
 * 对外入口
 * ------------------------------------------------------------------ */

/**
 * 来源：无
 */
export function cssPropertyNames(): string[] {
  return [...props.keys()].sort();
}

/**
 * 来源：无
 */
export function lookupProperty(name: string): CssProperty | undefined {
  return props.get(name);
}

/**
 * 来源：无
 *
 * 本属性是否“拥有真实落点”（L1）。L3 的属性在文档中需要单独标注
 */
export function isAppearanceProperty(name: string): boolean {
  return props.get(name)?.level === 1;
}

/**
 * 来源：NativeScript/packages/core/ui/core/properties/index.ts :: CssProperty 的写入路径
 *      （_setCssProperty / valueChanged）+ property-shared.ts :: isCssWideKeyword
 *      + index.ts :: isCssVariableExpression / isCssCalcExpression
 * 等级：部分修改（主体一致）
 * 相同：全局关键字 / var() / calc() 的拦截规则逐条对应（上游在每个属性 setter 里各自判，
 * 本侧集中一处）。
 * 改动：上游写入即生效且无“属性名不认识”这一说（不认识的属性根本不会进入样式系统），
 * 本侧需要区分“不认识属性名”与“认识但本条值无法落地”；上游会先做变量与 calc 求值再写入，
 * 本侧的 var() 已在级联层展开，走到这里的仍是引用则直接告警。
 *
 * 应用一条声明。返回 false 表示该属性名不在识别范围内（由调用方决定是否告警）。
 *
 * 解析失败（值书写错误、em/rem、var()、calc()）一律返回 true 且**不修改节点**：
 * 不认识属性名与“认识但本条值无法落地”是两件事，仅前者应当报“不支持”。
 */
export function applyCssProperty(
  node: CssNode,
  name: string,
  raw: string,
  ctx: ApplyContext,
  warnings: string[] = [],
): boolean {
  const property = props.get(name);
  if (!property) return false;

  const text = String(raw ?? "").trim();
  if (!text) return true;

  // 全局关键字 / var() / calc() 统一在此处拦截：每个属性各写一遍必然遗漏
  if (isGlobalKeyword(text)) {
    ctx.warn(`kw:${text}`, `CSS 关键字 "${text}" 无落点（Godot 的 theme 不提供继承链上的 unset），已忽略。`);
    return true;
  }
  if (isVariableReference(text)) {
    ctx.warn(
      "kw:var",
      `var(--x) 需要运行时变量求值（"${text}"），当前不支持，已忽略。请在构建期将变量展开为字面量。`,
    );
    return true;
  }
  if (hasCalc(text)) {
    ctx.warn("kw:calc", `calc() 需要布局引擎配合（"${text}"），当前不支持，已忽略。`);
    return true;
  }

  const value = property.parse(text, warnings);
  if (value === null || value === undefined) return true;
  property.apply(node, value, ctx);
  return true;
}

/* ------------------------------------------------------------------ *
 * 内部小工具
 * ------------------------------------------------------------------ */

/**
 * 来源：无
 *
 * `flex-grow` / `flex` 的共同落点：SIZE_EXPAND + stretch_ratio，两个轴一并置位（CSS 的
 * flex 不区分主轴）。ratio 为 0 时既不置位也不清位——清位会抹除模板 sizeFlags 设置的标志。
 */
function setGrow(node: CssNode, ratio: number, ctx: ApplyContext, cssName: string): void {
  if (!hasNodeProperty(ctx, node, "size_flags_stretch_ratio", cssName, "Control")) return;
  if (ratio > 0) {
    for (const flag of ["size_flags_horizontal", "size_flags_vertical"]) {
      if (!hasNodeProperty(ctx, node, flag, cssName, "Control")) return;
      // SIZE_EXPAND = 2
      ctx.backend.setNodeNumber(node, flag, ctx.backend.getNodeNumber(node, flag) | 2);
    }
  }
  ctx.backend.setNodeNumber(node, "size_flags_stretch_ratio", Math.max(ratio, 0));
}

function parseColorOr(raw: string, warnings: string[], cssName: string): ColorLike | null {
  const parsed = color(raw);
  if (!parsed) {
    warnings.push(
      `${cssName}: "${raw}" 不是可解析的颜色（支持 #hex / 命名色 / rgb() / rgba() / hsl() / hwb()）`,
    );
  }
  return parsed;
}

function minimumAxis(raw: string, cssName: string, warnings: string[]): number | null {
  const length = parseLength(raw);
  if (!length) {
    warnings.push(
      isUnsupportedUnit(raw)
        ? `${cssName}: "${raw}" 的相对单位无落点（Godot 仅提供像素下界 custom_minimum_size）`
        : `${cssName}: "${raw}" 不是长度`,
    );
    return null;
  }
  if (length.unit === "%") {
    warnings.push(`${cssName}: "${raw}" 的百分比需要父容器尺寸才能计算，无落点`);
    return null;
  }
  return Math.round(length.value);
}

function applyMargin(node: CssNode, margin: Partial<FourSides>, cssName: string, ctx: ApplyContext): void {
  // Godot 4 的 MarginContainer 没有 margin_* 属性，边距是 theme 常量。写入
  // `node.margin_top = 12` 在 GodotJS 中不报错，但引擎完全无感知——静默无效最难定位。
  // 落在没有 margin_* 的类上必须发出提示（不自动包裹容器）。
  const cls = ctx.backend.classOf(node);
  if (!hasThemeItem(cls, "constant", "margin_top")) {
    ctx.warn(
      `margin:${cls}`,
      `${cssName} 在 ${cls} 上无落点：Godot 的 margin 是 MarginContainer 的 theme 常量 margin_*。` +
        "（不会擅自向节点树插入容器，节点引用由 Angular 持有。）已忽略。",
    );
    return;
  }
  for (const side of BORDER_SIDES) {
    const value = margin[side];
    // undefined 表示本条声明未提及那一侧，不要修改它（撤销走 clearProperty，不依赖写入 0）
    if (value !== undefined) ctx.backend.setConstantOverride(node, `margin_${side}`, Math.round(value));
  }
}

/** 节点上是否存在该属性（不存在则告警，不强行写入） */
function hasNodeProperty(
  ctx: ApplyContext,
  node: CssNode,
  prop: string,
  cssName: string,
  need: string,
): boolean {
  if (ctx.backend.hasNodeProperty(node, prop)) return true;
  ctx.warn(
    `prop:${ctx.backend.classOf(node)}:${prop}`,
    `${cssName} 需要写入 ${ctx.backend.classOf(node)}.${prop}，但该节点不具备此属性（它属于 ${need}）。已忽略。`,
  );
  return false;
}

/** 供 style-target 复用：一条声明展开后可能同时影响多个 theme item */
export type { StyleBoxHandle };
