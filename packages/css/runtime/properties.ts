import type { ColorLike, CssNode, FontSource, FourCorners, FourSides, StyleBackend, StyleBoxHandle, WarnLevel } from "../types";
import { isGlobalKeyword, isVariableReference, hasCalc } from "../value/keyword";
import { parseColor } from "../value/color";
import { isPercentage, isUnsupportedUnit, parseNumber, parsePx } from "../value/length";
import { parseBoxShadow } from "../value/shadow";
import { fourSidesFromParts } from "../value/sides";
import { splitValueTokens } from "../value/tokens";
import { extractResourceUrl, unquote } from "../value/resource-url";
import { hasThemeItem, itemForStates, pickBackgroundStylebox, colorItemsForStates, themeItems, classChain } from "../vocabulary";

/**
 * 告警点约定：每一条 `warnings.push` 均整条包裹于 `if (ngDevMode)` 中。
 *
 * 仅将守卫置于被调用函数内部是无效的——调用点的模板字符串依旧会进入产物。整条包裹后，
 * `ngDevMode` 被替换为 false 时，esbuild 才能连同文案一并摇除（由
 * `packages/builder/vite/test/devmode-dce.spec.ts` 在产物层面加以约束）。
 * 该标识符在仓库内唯一的 `typings/ng-dev-mode.d.ts` 中声明。
 */

/** 引擎可导入为 Texture2D 的图片格式 */
const IMAGE_EXTENSIONS = new Set(["png", "svg", "jpg", "jpeg", "webp", "bmp", "ktx2"]);
/** 包含派生资源的 Godot 资源文件（与字体侧同口径） */
const RESOURCE_EXTENSIONS = new Set(["tres", "res"]);
const TEXTURE_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...RESOURCE_EXTENSIONS]);

/**
 * 来源：无
 */
export interface ApplyContext {
  backend: StyleBackend;
  /**
   * 输出一条告警。`level` 省略时不带等级标记（非 CSS 落点的告警经由该路径）。
   *
   * 取值口径：声明被丢弃 → `ignore`；声明已写入但 Godot 语义不同 → `compat`。
   * 解析阶段仅能报出「值被丢弃」，因此该通道（`warnings: string[]`）一律按 `ignore` 输出。
   */
  warn(key: string, message: string, level?: WarnLevel): void;
  /**
   * 声明所在的选择器自身要求的状态集（基规则与内联为空集）。
   * 落点完全由它推导，不读节点当前的伪类集。
   */
  states: ReadonlySet<string>;

  /**
   * 按家族名查 `@font-face` 登记下来的字体资源路径，未登记时返回 null。
   *
   * 设为可选：内联样式与 `applyStyle` 裸声明通道共用同一个 ApplyContext，而字体登记
   * 仅存在于样式表中（`@font-face` 只能出现在样式表文本中）。
   */
  resolveFont?: (family: string) => string | null;
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
 * 长度：px 与无单位均接受（Godot 的 theme 项本身即以像素计）。
 * 百分比不在接受范围内：本包不参与布局计算，百分比缺少可参照的父盒。
 */
function px(raw: string): number | null {
  return parsePx(raw);
}

/**
 * 来源：无
 *
 * 百分比的拒绝说明。仅提示“解析失败”无法定位问题，必须点明百分比无落点
 */
function percentReject(cssName: string, raw: string): string {
  return (
    `${cssName}: "${raw}" 是百分比。Godot 的落点全部以像素计，` +
    "百分比缺少可参照的父盒，该条声明已忽略"
  );
}

/**
 * 来源：无
 *
 * 长度解析失败的说明。百分比与无法识别的单位分别给出原因，而非统一提示为“不是长度”
 */
function lengthReject(cssName: string, raw: string): string {
  if (isPercentage(raw)) return percentReject(cssName, raw);
  if (isUnsupportedUnit(raw)) {
    return `${cssName}: "${raw}" 的相对单位无落点（仅接受 px 与无单位数字）`;
  }
  return `${cssName}: "${raw}" 不是长度`;
}

/**
 * 来源：NativeScript/packages/core/ui/styling/style-properties.ts :: positioningFromParts
 *      加上各 border-*-width / padding / margin 转换器里的逐边 Length.parse
 * 等级：部分修改（主体一致）
 * 改动：上游先切四段再逐段解析，本侧同序；上游对非法值抛错，本侧返回 null。
 */
function sides(raw: string, cssName: string, warnings: string[]): FourSides | null {
  const expanded = fourSidesFromParts(splitValueTokens(raw));
  if (!expanded) {
    if (ngDevMode) warnings.push(`${cssName}: "${raw}" 期望 1–4 个长度`);
    return null;
  }
  const values = expanded.map((part) => px(part));
  const [top, right, bottom, left] = values;
  if (top === null || right === null || bottom === null || left === null) {
    const bad = expanded.find((_part, index) => values[index] === null) ?? raw;
    if (ngDevMode) warnings.push(lengthReject(cssName, bad));
    return null;
  }
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
 * 差异：上游在 CssState 内维护伪类集并驱动动画，本侧的当前伪类集只参与**匹配**，
 * 不参与落点选择（落点由 `ApplyContext.states`、即选择器自身要求的状态决定）。
 */

/**
 * 来源：无
 *
 * 颜色的落点解析集中在 `colorItemsForStates`：一条声明可能要写多个 item（见那边注释）。
 */

/**
 * 来源：无
 *
 * 该类实际绘制哪个 stylebox（底色落点）。无法落点时告警并说明处理方式
 */
function backgroundItem(node: CssNode, ctx: ApplyContext, cssName: string): string | null {
  const cls = ctx.backend.classOf(node);
  const item = pickBackgroundStylebox(cls);
  if (!item) {
    if (ngDevMode) ctx.warn(
      `bg:${cls}:${cssName}`,
      `${cssName} 在 ${cls} 上无落点：${cls} 不绘制任何 stylebox（Godot 仅为会绘制背景的类提供 item，`
        + "如 Button 的 normal、PanelContainer 的 panel）。如需为其设置底色，请使用 PanelContainer 包裹该节点，"
        + "或对该节点调用 add_theme_stylebox_override 传入 StyleBoxFlat。",
    );
  }
  if (!item) return null;
  return itemForStates(cls, "stylebox", item, ctx.states);
}

/**
 * 来源：引擎 dump 逐类核对
 *
 * 同一语义的 theme item 在个别类上名称不同。CSS 属性只写通用名，这里换成该类真正的 item 名；
 * 不做模糊匹配，表外的类名一律按通用名查。
 */
const ITEM_ALIAS: Record<string, Record<string, string>> = {
  // RichTextLabel 的正文色与正文字号不带 font_ 前缀
  font_color: { RichTextLabel: "default_color" },
  font_size: { RichTextLabel: "normal_font_size" },
};

/**
 * 来源：无
 *
 * theme item 存在性检查（词汇表来自引擎 dump），同时完成别名替换。
 * 返回该类真正要写的 item 名；不存在时告警并返回 null。
 */
function requireItem(
  node: CssNode,
  ctx: ApplyContext,
  kind: "color" | "font_size" | "constant",
  item: string,
  cssName: string,
): string | null {
  const cls = ctx.backend.classOf(node);
  const alias = ITEM_ALIAS[item]?.[cls];
  const target = alias && hasThemeItem(cls, kind, alias) ? alias : item;
  if (hasThemeItem(cls, kind, target)) return target;
  if (ngDevMode) ctx.warn(
    `item:${cls}:${kind}:${item}:${cssName}`,
    `${cssName} 需要写入 ${cls} 的 ${kind} "${item}"，但 ${cls} 的词汇表中不存在该项（已沿父链查找），已忽略。` +
      sameFamilyHint(cls, kind, target),
  );
  return null;
}

/**
 * 来源：无
 *
 * 同一语义在该类上换了名字时（TabBar 的字色按状态分成 font_unselected_color /
 * font_selected_color / font_hovered_color / font_disabled_color，没有通用的 font_color），
 * 只说“不存在”等于把作者卡住。这里把同类项列出来，作者照着写状态规则就能落地。
 */
function sameFamilyHint(cls: string, kind: "color" | "font_size" | "constant", item: string): string {
  const cut = item.lastIndexOf("_");
  if (cut <= 0) return "";
  const prefix = item.slice(0, cut);
  const suffix = item.slice(cut);
  const near = themeItems(cls, kind).filter((name) => name !== item && name.startsWith(prefix) && name.endsWith(suffix));
  if (!near.length) return "";
  const shown = near.slice(0, 6).join(", ");
  return `${cls} 上同类的 ${kind} 有：${shown}${near.length > 6 ? " 等" : ""}，需要时请直接写这些 item 对应的状态规则。`;
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

/**
 * 来源：引擎 dump（Control.CursorShape）
 *
 * CSS cursor 关键字 → `Control.mouse_default_cursor_shape` 的枚举值。表外的关键字
 * （zoom-in、alias、cell、none 等）输出告警，不做近似映射。
 */
const CURSOR_SHAPE: Record<string, number> = {
  default: 0,
  auto: 0,
  arrow: 0,
  text: 1,
  "vertical-text": 1,
  pointer: 2,
  crosshair: 3,
  wait: 4,
  progress: 5,
  busy: 5,
  grab: 6,
  grabbing: 6,
  "not-allowed": 8,
  "no-drop": 8,
  "n-resize": 9,
  "s-resize": 9,
  "ns-resize": 9,
  "row-resize": 9,
  "e-resize": 10,
  "w-resize": 10,
  "ew-resize": 10,
  "col-resize": 10,
  "ne-resize": 11,
  "sw-resize": 11,
  "nesw-resize": 11,
  "nw-resize": 12,
  "se-resize": 12,
  "nwse-resize": 12,
  move: 13,
  "all-scroll": 13,
  help: 16,
};

/**
 * 来源：引擎 dump（TextServer.OverrunBehavior）
 *
 * CSS text-overflow → `Label.text_overrun_behavior`。1 = 按字符裁切，3 = 按字符裁切并加 …
 */
const TEXT_OVERRUN: Record<string, number> = { clip: 1, ellipsis: 3 };

/**
 * 来源：引擎 dump（TextServer.AutowrapMode）
 *
 * CSS white-space → `Label.autowrap_mode`。Godot 不做空白折叠，因此 `pre` 与 `nowrap`
 * 同样落在 AUTOWRAP_OFF（差异只在源码里的连续空格，那部分本方案不处理）。
 */
const AUTOWRAP: Record<string, number> = {
  normal: 2,
  "pre-wrap": 2,
  "pre-line": 2,
  "break-spaces": 2,
  pre: 0,
  nowrap: 0,
  "break-all": 3,
  anywhere: 3,
};

/**
 * 来源：引擎 dump（Control.LayoutDirection）
 *
 * CSS direction → `Control.layout_direction`（LTR 2 / RTL 3）。`inherit` / `initial`
 * 不在此列：它们先被 applyCssProperty 的全局关键字拦截（Godot 的 theme 没有继承链上的 unset）。
 */
const LAYOUT_DIRECTION: Record<string, number> = { ltr: 2, rtl: 3 };

/* ---------------- 明确不做的东西 ---------------- */

/**
 * 来源：无
 *
 * 这些属性**没有**落点。列出来不是为了支持，而是为了让告警能给出有用的描述：
 * 只说“不支持 display”与“display 的落点是容器结构，无权修改节点树”，
 * 是两种完全不同的可用性。
 *
 * 整张表包裹于 `ngDevMode ? … : {}` 中：其内容是一批中文文案**数据**，而非代码分支，
 * 不如此写则无法摇除。生产构建中它折叠为空对象，这些属性因此退回「未知属性」处理，
 * 静默忽略——本就不输出告警，保留文案仅占用体积。
 */
const NO_LANDING: Record<string, string> = ngDevMode ? {
  display: "display 的落点是节点树结构（元素的包含关系），而节点树由 Angular 持有，不会擅自修改",
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
  order: "Godot 的排列与绘制顺序由节点顺序决定，修改它等同于修改节点树",
  "aspect-ratio": "宽高比在 AspectRatioContainer.ratio 上，属于节点树结构",
  "max-width": "Godot 的 Control 只有下界 custom_minimum_size，没有上界；上限由父容器的尺寸与锚点约束",
  "max-height": "同上",
  width: "Godot 无「确定宽度」的概念：容器内子节点的宽度由容器分配，容器外为节点自身的 size。如需表达下界请使用 min-width，如需分配剩余空间请使用 flex-grow",
  height: "同上（如需表达下界请使用 min-height）",
  "align-self": "BoxContainer 不为单个子节点提供交叉轴对齐",
  "font-weight": "同上（粗体对应另一个 Font 资源）",
  "font-style": "同上",
  "line-height": "Label 的 line_spacing 是「行与行之间的增量」，与 CSS 行高（整行盒高度）定义不同，不做静默换算",
  "letter-spacing": "无对应能力",
  "word-spacing": "无对应能力",
  "text-decoration": "无对应能力",
  "text-transform": "无对应能力",
  transform: "Godot 的 transform 位于 CanvasItem，语义与 CSS 差异过大",
  transition: "动画不在支持范围内（见文档第七节）；Godot 侧请使用 Tween",
  animation: "动画不在支持范围内（见文档第七节）",
  "animation-name": "动画不在支持范围内（见文档第七节）",
  outline: "StyleBoxFlat 无 outline 对应能力（焦点样式请使用 :focus 的 stylebox）",
  "z-index": "Godot 的绘制顺序由节点顺序决定，修改它等同于修改节点树",
  "user-select": "无对应能力",
  "box-sizing": "Godot 的尺寸不区分 content-box / border-box",
  "writing-mode": "Godot 不支持竖排文本；横向左右方向请使用 direction",
  filter: "Godot 的视觉效果由 material / WorldEnvironment 承担，与 CSS 滤镜是另一套模型",
  "backdrop-filter": "同上",
  "will-change": "无对应能力",
  content: "content 依附于伪元素 ::before / ::after，Godot 无伪元素概念",
  "flex-flow": "flex-flow 是 flex-direction 与 flex-wrap 的简写，两者均无落点",
} : {};

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
      // 先按状态解析落点、再查存在性：TabBar 这类没有 font_color、只有 font_selected_color /
      // font_disabled_color 的类，状态规则本身有落点，先查基 item 会被一票否决。基 item 被拆成
      // 多个状态 item 时这里返回多个，逐个写（撤销由后端逐次 undo 登记兼顾）。
      for (const target of colorItemsForStates(ctx.backend.classOf(node), "font_color", ctx.states)) {
        const item = requireItem(node, ctx, "color", target, "color");
        if (item) ctx.backend.setColorOverride(node, item, value as ColorLike);
      }
    },
  }],

  ["font-family", {
    level: 1,
    parse: (raw, warnings) => {
      // 候选列表整串保留：已登记者按序查找，未登记者则将整串交给
      // `SystemFont.font_names`，由引擎按序选取首个存在的字体
      const families = raw.split(",").map((name) => unquote(name.trim())).filter((name) => name !== "");
      if (!families.length) {
        if (ngDevMode) warnings.push(`font-family 的值 "${raw}" 中不含任何字体名，已忽略`);
        return null;
      }
      return families;
    },
    apply: (node, value, ctx) => {
      const families = value as string[];
      // 登记优先：`res://` 资源是工程内的确定答案，跨平台一致；系统字体仅为尽力回退。
      // 此处偏离 CSS 严格语义（规范上候选应逐个尝试、可用者先生效，已安装的系统字体亦可插队），
      // 但 TextServer 未提供「查询系统是否安装某字体」的 API，我们无法判定是否应当让位。
      for (const family of families) {
        const path = ctx.resolveFont ? ctx.resolveFont(family) : null;
        if (!path) continue;
        // 字体 item 名统一为 font：词汇表仅 dump 了 stylebox / color / constant / font_size，
        // 未包含 font 这一族，因此此处不经过 requireItem 的存在性校验
        if (!ctx.backend.setFontOverride(node, "font", { path }) && ngDevMode) {
          ctx.warn(`font-load:${path}`, `字体资源加载失败：${path}（来自 @font-face "${family}"）`, "ignore");
        }
        return;
      }
      // 全部未登记：整串交由引擎处理。引擎按序选取系统中首个存在的字体；若全部不存在，
      // 则由引擎静默回退至默认字体。本库不探测结果，也不输出告警。
      ctx.backend.setFontOverride(node, "font", { systemFontNames: families });
    },
  }],

  ["font-size", {
    level: 1,
    parse: (raw, warnings) => {
      const value = px(raw);
      if (ngDevMode && value === null) warnings.push(lengthReject("font-size", raw));
      return value === null ? null : Math.round(value);
    },
    apply: (node, value, ctx) => {
      const item = requireItem(node, ctx, "font_size", "font_size", "font-size");
      if (!item) return;
      ctx.backend.setFontSizeOverride(node, item, value as number);
    },
  }],

  ["opacity", {
    level: 1,
    parse: (raw, warnings) => {
      const alpha = parseNumber(raw, 0, 1);
      if (alpha === null) {
        if (ngDevMode) warnings.push(
          isPercentage(raw)
            ? percentReject("opacity", raw)
            : `opacity: "${raw}" 不是 0..1 的数字`,
        );
      }
      return alpha;
    },
    apply: (node, value, ctx) => ctx.backend.setOpacity(node, value as number),
  }],

  ["caret-color", {
    level: 1,
    parse: (raw, warnings) => parseColorOr(raw, warnings, "caret-color"),
    apply: (node, value, ctx) => {
      const item = requireItem(node, ctx, "color", "caret_color", "caret-color");
      if (!item) return;
      ctx.backend.setColorOverride(node, item, value as ColorLike);
    },
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

  /**
   * `background-image: url("res://…")` → StyleBoxTexture 的 `texture`。
   *
   * 与 `background-color` 互斥（一个 stylebox 只能绘制一种填充），何者生效由层叠顺序决定，口径与
   * `width:1px;width:2px` 一致；本库不叠加，也不回退。
   */
  ["background-image", {
    level: 1,
    parse: (raw, warnings) => {
      if (/gradient\s*\(/i.test(raw)) {
        if (ngDevMode)
          warnings.push(
            "background-image 的 gradient 无落点：Godot 的 StyleBoxTexture 仅接受纹理资源，" +
              "渐变请预先导出为贴图，或改用 background-color",
          );
        return null;
      }
      if (/^\s*none\s*$/i.test(raw)) {
        if (ngDevMode) warnings.push("background-image: none 无落点：本库不会主动为控件设置纹理，已忽略");
        return null;
      }
      return extractResourceUrl(raw, warnings, {
        subject: "background-image",
        extensions: TEXTURE_EXTENSIONS,
        extensionsText: `图片：${[...IMAGE_EXTENSIONS].join(" / ")}；或包含 Texture2D 的 ${[...RESOURCE_EXTENSIONS].join(" / ")} 资源`,
        example: "res://assets/ui/panel.png",
      });
    },
    apply: (node, value, ctx) => {
      const item = backgroundItem(node, ctx, "background-image");
      if (!item) return;
      ctx.backend.mutateStyleBox(node, item, (box) => box.setTexture(value as string));
    },
  }],

  /* ---- 边框：宽度与颜色（Godot 只有单一 border_color，四边同色） ---- */

  ...BORDER_SIDES.map((side): [string, CssProperty] => [
    `border-${side}-width`,
    {
      level: 1,
      parse: (raw, warnings) => {
        const value = px(raw);
        if (ngDevMode && value === null) warnings.push(lengthReject(`border-${side}-width`, raw));
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

  /** 单边颜色：Godot 的 StyleBoxFlat 只有一个 border_color，必须说明它作用于整圈边框 */
  ...BORDER_SIDES.map((side): [string, CssProperty] => [
    `border-${side}-color`,
    {
      level: 1,
      parse: (raw, warnings) => parseColorOr(raw, warnings, `border-${side}-color`),
      apply: (node, value, ctx) => {
        const item = backgroundItem(node, ctx, `border-${side}-color`);
        if (!item) return;
        if (ngDevMode) ctx.warn(
          `border-single:${side}`,
          `border-${side}-color 无单边落点：Godot 的 StyleBoxFlat 只有一个 border_color（四边同色），已按整圈边框颜色处理。`,
          "compat",
        );
        const colorValue = value as ColorLike;
        ctx.backend.mutateStyleBox(node, item, (box) => box.setBorderColor(colorValue));
      },
    },
  ]),

  /* ---- 圆角：Godot 四个角各一个 int ---- */

  ...CORNERS.map((corner): [string, CssProperty] => [
    `border-${corner}-radius`,
    {
      level: 1,
      parse: (raw, warnings) => {
        const value = px(raw.split("/")[0]);
        if (ngDevMode && value === null) warnings.push(lengthReject(`border-${corner}-radius`, raw.split("/")[0]));
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
      if (ngDevMode) warnings.push(...parsed.warnings);
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

  /**
   * text-shadow → Label / RichTextLabel 的文字阴影三项：颜色 `font_shadow_color`
   * 加两个常量 `shadow_offset_x` / `shadow_offset_y`。它不属于 stylebox 阴影，
   * 因此与 `box-shadow` 各有独立落点。Godot 的文字阴影无模糊，仅有偏移与颜色。
   */
  ["text-shadow", {
    level: 3,
    parse: (raw, warnings) => {
      const parsed = parseBoxShadow(raw);
      if (ngDevMode) warnings.push(...parsed.warnings);
      return parsed.shadow;
    },
    apply: (node, value, ctx) => {
      const shadow = value as ReturnType<typeof parseBoxShadow>["shadow"];
      if (!shadow) return; // `none`：不写入任何项，上一轮的写入由 ledger 撤销
      const colorItem = requireItem(node, ctx, "color", "font_shadow_color", "text-shadow");
      const xItem = requireItem(node, ctx, "constant", "shadow_offset_x", "text-shadow");
      const yItem = requireItem(node, ctx, "constant", "shadow_offset_y", "text-shadow");
      if (!colorItem || !xItem || !yItem) return;
      ctx.backend.setColorOverride(node, colorItem, shadow.color);
      ctx.backend.setConstantOverride(node, xItem, Math.round(shadow.offsetX));
      ctx.backend.setConstantOverride(node, yItem, Math.round(shadow.offsetY));
      if (shadow.blur !== 0 && ngDevMode) {
        ctx.warn(
          "text-shadow:blur",
          "text-shadow 的模糊半径无落点：Godot 的文字阴影仅有偏移与颜色，无模糊。已忽略模糊值。",
          "compat",
        );
      }
    },
  }],

  /* ---- 内边距：落在 stylebox 的 content_margin ---- */

  ["padding", {
    level: 1,
    parse: (raw, warnings) => {
      const value = sides(raw, "padding", warnings);
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
        if (ngDevMode && value === null) warnings.push(lengthReject(`padding-${side}`, raw));
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

  /** 尺寸下界：Godot 的 Control 仅有下界，`width` / `height` 因此无落点（见 NO_LANDING） */
  ["min-width", {
    level: 3,
    parse: (raw, warnings) => minimumAxis(raw, "min-width", warnings),
    apply: (node, value, ctx) => ctx.backend.setMinimumSize(node, value as number, null),
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
      const value = sides(raw, "margin", warnings);
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
        if (ngDevMode && value === null) warnings.push(lengthReject(`margin-${side}`, raw));
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
   *
   * `gap: <行> <列>` 的两值写法一并支持（CSS 的轴序是 row 在前，与 h/v 相反）。
   */
  ["gap", {
    level: 3,
    parse: (raw, warnings) => gapAxes(raw, "gap", warnings),
    apply: (node, value, ctx) => applyGap(node, value as GapAxes, "gap", ctx),
  }],

  ["row-gap", {
    level: 3,
    parse: (raw, warnings) => singleAxis(raw, "row-gap", warnings, "row"),
    apply: (node, value, ctx) => applyGap(node, value as GapAxes, "row-gap", ctx),
  }],

  ["column-gap", {
    level: 3,
    parse: (raw, warnings) => singleAxis(raw, "column-gap", warnings, "column"),
    apply: (node, value, ctx) => applyGap(node, value as GapAxes, "column-gap", ctx),
  }],

  ["justify-content", {
    level: 3,
    parse: (raw) => raw.trim().toLowerCase(),
    apply: (node, value, ctx) => {
      const mapped = ALIGNMENT[value as string];
      if (mapped === undefined) {
        if (ngDevMode) ctx.warn(
          "justify-content:space",
          `justify-content: ${value} 无落点：Godot 的 BoxContainer.alignment 仅提供 BEGIN / CENTER / END 三档，`
            + "space-between / space-around / space-evenly 无对应取值。已忽略。",
        );
        return;
      }
      // Button、LineEdit 等也有 `alignment`，但那是文本对齐（text-align 的落点），
      // 只有容器类的 `alignment` 才是主轴对齐
      if (!classChain(ctx.backend.classOf(node)).includes("Container")) {
        if (ngDevMode) ctx.warn(
          `prop:${ctx.backend.classOf(node)}:alignment`,
          `justify-content 需要写入 ${ctx.backend.classOf(node)} 的 alignment，但该节点不属于容器`
            + "（其属于 BoxContainer / FlowContainer 一类）。已忽略。",
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
        if (ngDevMode) warnings.push(
          isPercentage(raw)
            ? percentReject("flex", raw)
            : `flex: "${raw}" 仅接受单个数字（flex-grow），其余部分无落点`,
        );
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
      if (ratio === null) {
        if (ngDevMode) warnings.push(
          isPercentage(raw)
            ? percentReject("flex-grow", raw)
            : `flex-grow: "${raw}" 不是数字`,
        );
      }
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

  /**
   * overflow → Control.clip_contents。Godot 仅有「是否裁剪子节点」这一个开关，
   * 因此 hidden / visible 有对应项，滚动（auto / scroll）没有。
   */
  ["overflow", {
    level: 3,
    parse: (raw) => raw.trim().toLowerCase(),
    apply: (node, value, ctx) => {
      const mode = value as string;
      if (mode !== "hidden" && mode !== "visible") {
        if (ngDevMode) ctx.warn(
          `overflow:${mode}`,
          `overflow: ${mode} 无落点：Godot 的滚动由 ScrollContainer 承担，Control 仅有 clip_contents 这一个裁剪开关。已忽略。`,
        );
        return;
      }
      if (!hasNodeProperty(ctx, node, "clip_contents", "overflow", "Control")) return;
      ctx.backend.setNodeBoolean(node, "clip_contents", mode === "hidden");
    },
  }],

  /**
   * pointer-events: none → mouse_filter = IGNORE。Godot 的 IGNORE 仅使节点自身不接收事件，
   * 不会像 CSS 那样连带屏蔽子节点，因此属于近似。
   */
  ["pointer-events", {
    level: 3,
    parse: (raw) => raw.trim().toLowerCase(),
    apply: (node, value, ctx) => {
      const mode = value as string;
      if (mode !== "none") {
        if (ngDevMode) ctx.warn(
          `pointer-events:${mode}`,
          `pointer-events: ${mode} 无落点：Godot 的默认鼠标过滤方式因类而异（Button 接收、Label 不接收），`
            + "无法由 CSS 恢复。如需恢复请删除该条声明。已忽略。",
        );
        return;
      }
      if (!hasNodeProperty(ctx, node, "mouse_filter", "pointer-events", "Control")) return;
      // Control.MOUSE_FILTER_IGNORE
      ctx.backend.setNodeNumber(node, "mouse_filter", 2);
      if (ngDevMode) ctx.warn(
        "pointer-events:none",
        "pointer-events: none 已写入 mouse_filter = IGNORE，但 Godot 的 IGNORE 不屏蔽子节点：子节点仍会接收鼠标事件。",
        "compat",
      );
    },
  }],

  /** text-align → 拥有水平对齐属性的类（Label / RichTextLabel / Button / LineEdit…） */
  ["text-align", {
    level: 3,
    parse: (raw) => raw.trim().toLowerCase(),
    apply: (node, value, ctx) => {
      const mapped = TEXT_ALIGN[value as string];
      if (mapped === undefined) {
        if (ngDevMode) ctx.warn("text-align", `text-align: ${value} 无对应值（可用 left / center / right），已忽略。`);
        return;
      }
      const prop = textAlignProperty(node, ctx);
      if (!prop) {
        if (ngDevMode) ctx.warn(
          `prop:${ctx.backend.classOf(node)}:horizontal_alignment`,
          `text-align 需要写入 ${ctx.backend.classOf(node)} 的 horizontal_alignment 或 alignment，`
            + "但该节点不具备这两个属性（其属于 Label、RichTextLabel、Button、LineEdit 一类）。已忽略。",
        );
        return;
      }
      ctx.backend.setNodeNumber(node, prop, mapped);
    },
  }],

  /** cursor → Control.mouse_default_cursor_shape（仅影响悬停时的形状） */
  ["cursor", {
    level: 3,
    parse: (raw) => (raw.split(",")[0] ?? "").trim().toLowerCase(),
    apply: (node, value, ctx) => {
      const shape = CURSOR_SHAPE[value as string];
      if (shape === undefined) {
        if (ngDevMode) ctx.warn(
          `cursor:${value}`,
          `cursor: ${value} 无对应取值（Godot 的 mouse_default_cursor_shape 取值表不同，可用：`
            + `${Object.keys(CURSOR_SHAPE).join(" / ")}）。已忽略。`,
        );
        return;
      }
      if (!hasNodeProperty(ctx, node, "mouse_default_cursor_shape", "cursor", "Control")) return;
      ctx.backend.setNodeNumber(node, "mouse_default_cursor_shape", shape);
    },
  }],

  /** text-overflow → Label.text_overrun_behavior（仅在文本被约束住时看得出来） */
  ["text-overflow", {
    level: 3,
    parse: (raw, warnings) => {
      const parts = splitValueTokens(raw);
      const key = (parts[0] ?? "").toLowerCase();
      if (key === "ellipsis" && parts.length > 1) {
        if (ngDevMode) warnings.push("text-overflow 的自定义省略号字符串无落点（Godot 固定使用 …），该字符串已忽略，按 ellipsis 处理");
      }
      const mapped = TEXT_OVERRUN[key];
      if (mapped === undefined) {
        if (ngDevMode) warnings.push(`text-overflow: "${raw}" 无对应取值（可用 clip / ellipsis）`);
        return null;
      }
      return mapped;
    },
    apply: (node, value, ctx) => {
      if (!hasNodeProperty(ctx, node, "text_overrun_behavior", "text-overflow", "Label")) return;
      ctx.backend.setNodeNumber(node, "text_overrun_behavior", value as number);
    },
  }],

  /** white-space → Label.autowrap_mode（Godot 不折叠空白，只映射换行策略） */
  ["white-space", {
    level: 3,
    parse: (raw) => raw.trim().toLowerCase(),
    apply: (node, value, ctx) => {
      const mode = AUTOWRAP[value as string];
      if (mode === undefined) {
        if (ngDevMode) ctx.warn(
          `white-space:${value}`,
          `white-space: ${value} 无对应取值（可用 normal / nowrap / pre / pre-wrap / break-all），已忽略。`
            + "Godot 不折叠空白，源码中的连续空格按原样绘制。",
        );
        return;
      }
      if (!hasNodeProperty(ctx, node, "autowrap_mode", "white-space", "Label")) return;
      ctx.backend.setNodeNumber(node, "autowrap_mode", mode);
    },
  }],

  /** direction → Control.layout_direction（竖排文本无落点，见 writing-mode） */
  ["direction", {
    level: 3,
    parse: (raw) => raw.trim().toLowerCase(),
    apply: (node, value, ctx) => {
      const mapped = LAYOUT_DIRECTION[value as string];
      if (mapped === undefined) {
        if (ngDevMode) ctx.warn("direction", `direction: ${value} 无对应取值（可用 ltr / rtl），已忽略。`);
        return;
      }
      if (!hasNodeProperty(ctx, node, "layout_direction", "direction", "Control")) return;
      ctx.backend.setNodeNumber(node, "layout_direction", mapped);
    },
  }],

  /* ---------------- 明确不做：仅为使告警给出有用的描述 ---------------- */

  ...Object.entries(NO_LANDING).map(([name, why]): [string, CssProperty] => [
    name,
    {
      level: 3,
      parse: () => true,
      apply: (_node, _value, ctx) => {
        if (ngDevMode) ctx.warn(`noland:${name}`, `${name} 无落点：${why}。已忽略。`);
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
    if (ngDevMode) ctx.warn(`kw:${text}`, `CSS 关键字 "${text}" 无落点（Godot 的 theme 不提供继承链上的 unset），已忽略。`);
    return true;
  }
  if (isVariableReference(text)) {
    if (ngDevMode) ctx.warn(
      "kw:var",
      `var(--x) 需要运行时变量求值（"${text}"），当前不支持，已忽略。请在构建期将变量展开为字面量。`,
    );
    return true;
  }
  if (hasCalc(text)) {
    if (ngDevMode) ctx.warn("kw:calc", `calc() 需要布局引擎配合（"${text}"），当前不支持，已忽略。`);
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
    if (ngDevMode) warnings.push(
      `${cssName}: "${raw}" 不是可解析的颜色（支持 #hex / 命名色 / rgb() / rgba() / hsl() / hwb()）`,
    );
  }
  return parsed;
}

function minimumAxis(raw: string, cssName: string, warnings: string[]): number | null {
  const value = px(raw);
  if (value === null) {
    if (ngDevMode) warnings.push(lengthReject(cssName, raw));
    return null;
  }
  return Math.round(value);
}

/** gap / row-gap / column-gap 的解析结果：两轴各自可选（null = 本条声明未提及那一轴） */
interface GapAxes {
  row: number | null;
  column: number | null;
}

/** 一个长度 → 一轴；非长度返回 null 并告警 */
function axisLength(raw: string, cssName: string, warnings: string[]): number | null {
  const value = px(raw);
  if (ngDevMode && value === null) warnings.push(lengthReject(cssName, raw));
  return value === null ? null : Math.round(value);
}

/** `gap: <行> <列>`：单值时两轴同值（CSS 口径），两值时行在前 */
function gapAxes(raw: string, cssName: string, warnings: string[]): GapAxes | null {
  const parts = String(raw).trim().split(/\s+/).filter(Boolean);
  if (!parts.length || parts.length > 2) {
    if (ngDevMode) warnings.push(`${cssName}: "${raw}" 期望 1–2 个长度`);
    return null;
  }
  const row = axisLength(parts[0], cssName, warnings);
  const column = parts[1] === undefined ? row : axisLength(parts[1], cssName, warnings);
  if (row === null && column === null) return null;
  return { row, column };
}

function singleAxis(
  raw: string,
  cssName: string,
  warnings: string[],
  axis: "row" | "column",
): GapAxes | null {
  const value = axisLength(String(raw).trim().split(/\s+/)[0] ?? "", cssName, warnings);
  if (value === null) return null;
  return axis === "row" ? { row: value, column: null } : { row: null, column: value };
}

/**
 * 来源：无
 *
 * gap、row-gap、column-gap 的共用落点。Godot 的两套容器命名不同：BoxContainer 只有单轴的
 * `separation`（轴向由 `vertical` 决定），GridContainer、FlowContainer、ItemList 为
 * h_separation 与 v_separation。写入 `node.separation = 8` 在 JS 侧不报错也不生效，
 * 因此必须使用 theme 常量覆盖。
 *
 * 单轴容器只有一根轴。另一轴仅在两个取值不相同时告警；`gap: 8px` 这类两轴同值的写法
 * 不告警，以免最常见的用法持续产生噪声。
 */
function applyGap(node: CssNode, axes: GapAxes, cssName: string, ctx: ApplyContext): void {
  const { row, column } = axes;
  const cls = ctx.backend.classOf(node);
  if (hasThemeItem(cls, "constant", "h_separation") && hasThemeItem(cls, "constant", "v_separation")) {
    if (column !== null) ctx.backend.setConstantOverride(node, "h_separation", column);
    if (row !== null) ctx.backend.setConstantOverride(node, "v_separation", row);
    return;
  }
  if (hasThemeItem(cls, "constant", "separation")) {
    const vertical = ctx.backend.hasNodeProperty(node, "vertical")
      ? ctx.backend.getNodeNumber(node, "vertical") !== 0
      : null;
    if (vertical === true) {
      if (row !== null) ctx.backend.setConstantOverride(node, "separation", row);
      if (column !== null && column !== row) noGapAxis(node, ctx, cssName, "column", cls);
    } else if (vertical === false) {
      if (column !== null) ctx.backend.setConstantOverride(node, "separation", column);
      if (row !== null && row !== column) noGapAxis(node, ctx, cssName, "row", cls);
    } else {
      const single = column ?? row;
      if (single !== null) ctx.backend.setConstantOverride(node, "separation", single);
    }
    return;
  }
  if (ngDevMode) ctx.warn(
    `gap:${cls}`,
    `${cssName} 无落点：${cls} 不属于 BoxContainer / GridContainer，不存在 separation 间距常量。`
      + "容器间距请使用这两个类，或自行调用 add_theme_constant_override。已忽略。",
  );
}

function noGapAxis(node: CssNode, ctx: ApplyContext, cssName: string, axis: "row" | "column", cls: string): void {
  if (ngDevMode) ctx.warn(
    `gap-axis:${cls}:${axis}`,
    `${cssName} 的 ${axis === "row" ? "row-gap" : "column-gap"} 在 ${cls} 上无落点：BoxContainer 仅有单个`
      + " `separation`（单轴），另一轴不产生间距。已忽略。",
  );
}

function applyMargin(node: CssNode, margin: Partial<FourSides>, cssName: string, ctx: ApplyContext): void {
  // Godot 4 的 MarginContainer 并无 margin_* 属性，边距是 theme 常量。写入
  // `node.margin_top = 12` 在 GodotJS 中不报错，但引擎完全无感知——静默无效最难定位。
  // 落在不具备 margin_* 的类上必须发出提示（不会自动包裹容器）。
  const cls = ctx.backend.classOf(node);
  if (!hasThemeItem(cls, "constant", "margin_top")) {
    if (ngDevMode) ctx.warn(
      `margin:${cls}`,
      `${cssName} 在 ${cls} 上无落点：Godot 的 margin 是 MarginContainer 的 theme 常量 margin_*。` +
        "（不会擅自向节点树插入容器，节点引用由 Angular 持有。）已忽略。",
    );
    return;
  }
  for (const side of BORDER_SIDES) {
    const value = margin[side];
    // undefined 表示本条声明未提及该侧，不要修改它（撤销走 clearProperty，不依赖写入 0）
    if (value !== undefined) ctx.backend.setConstantOverride(node, `margin_${side}`, Math.round(value));
  }
}

/**
 * 来源：无
 *
 * text-align 的落点属性名。Label、RichTextLabel 用 `horizontal_alignment`，Button、LineEdit
 * 的同义属性叫 `alignment`（两个枚举取值一致：LEFT 0 / CENTER 1 / RIGHT 2）。
 *
 * BoxContainer 系也有 `alignment`，但那是 justify-content 的落点（布局对齐而非文本对齐），
 * 因此容器类不参与回退。
 */
function textAlignProperty(node: CssNode, ctx: ApplyContext): string | null {
  if (ctx.backend.hasNodeProperty(node, "horizontal_alignment")) return "horizontal_alignment";
  if (classChain(ctx.backend.classOf(node)).includes("Container")) return null;
  return ctx.backend.hasNodeProperty(node, "alignment") ? "alignment" : null;
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
  if (ngDevMode) ctx.warn(
    `prop:${ctx.backend.classOf(node)}:${prop}`,
    `${cssName} 需要写入 ${ctx.backend.classOf(node)}.${prop}，但该节点不具备此属性（它属于 ${need}）。已忽略。`,
  );
  return false;
}

/** 供 style-target 复用：一条声明展开后可能同时影响多个 theme item */
export type { StyleBoxHandle };
