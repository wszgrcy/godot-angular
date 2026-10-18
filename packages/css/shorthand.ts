import { CssCode, CssWarnEntry } from "./diagnostics";
import { fourSidesFromParts } from "./value/sides";
import { splitOnSlash, splitValueTokens } from "./value/tokens";
import { splitTopLevel } from "./selector";
import { parseColor } from "./value/color";

/** 开发模式标记：生产构建中整个 `if (ngDevMode)` 分支连同告警文案一并消除（口径见 runtime/properties.ts） */

/**
 * 来源：NativeScript/packages/core/ui/core/properties/index.ts :: _expandCssShorthand
 * 等级：部分修改（主体一致）
 * 改动：上游元组第二项是已转换的值（可为对象），本侧统一保留 CSS 原文，解析推到写入位置。
 *
 * 一条 longhand：[属性名, 值]
 */
export type Longhand = [property: string, value: string];

/**
 * 来源：无
 */
export interface ShorthandExpansion {
  longhands: Longhand[];
  warnings: CssWarnEntry[];
}

/**
 * 来源：NativeScript/packages/core/ui/styling/style-properties.ts :: positioningFromParts
 * 等级：部分修改（主体一致）
 * 改动：上游将四边写入 { top, right, bottom, left } 对象，本侧保留这个顺序但用数组；
 * 上游的边名与 CSS 的 1–4 值映射逐字一致。
 */
const SIDE_NAMES = ["top", "right", "bottom", "left"] as const;

/**
 * 来源：无
 *
 * 这些属性本身就是 longhand，直接透传
 */
const PASSTHROUGH: ReadonlySet<string> = new Set([
  "color",
  "font-size",
  "background-color",
  "background-image",
  // Godot 的 StyleBoxFlat 只有一个 border_color（四边同色），拆成 border-*-color
  // 只会得出生成四条没有对应实现的 longhand，因此 border-color 自身就是写入位置
  "border-color",
  "box-shadow",
  "opacity",
  "width",
  "height",
  "min-width",
  "min-height",
  "max-width",
  "max-height",
  "gap",
  "row-gap",
  "column-gap",
  "justify-content",
  "align-items",
  "align-self",
  "display",
  "position",
  "overflow",
  "visibility",
  "transition",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
]);

/**
 * 来源：NativeScript/packages/core/ui/styling/style-properties.ts :: positioningFromParts
 * 等级：部分修改（主体一致）
 * 相同：1/2/3/4 个值的映射规则逐字相同（上=下、左=右）。
 * 改动：上游抛异常（"Expected 1, 2, 3 or 4 parameters"），本侧返回 null 交由调用方告警；
 * longhand 名由调用方给定（`margin-top` 与 `border-top-width` 构词法不一致）。
 *
 * 四值简写展开。
 */
function sides(build: (side: string) => string, parts: string[]): Longhand[] | null {
  const expanded = fourSidesFromParts(parts);
  if (!expanded) return null;
  return SIDE_NAMES.map((side, index) => [build(side), expanded[index]] as Longhand);
}

/** `border: 1px solid red` 这种三段式（顺序任意，缺省补 medium / currentcolor） */
/**
 * 来源：无
 */
function borderParts(value: string, warnings: CssWarnEntry[]): { width?: string; style?: string; color?: string } {
  const out: { width?: string; style?: string; color?: string } = {};
  const BORDER_STYLES = new Set([
    "none",
    "hidden",
    "solid",
    "dashed",
    "dotted",
    "double",
    "groove",
    "ridge",
    "inset",
    "outset",
  ]);
  for (const token of splitValueTokens(value)) {
    if (out.width === undefined && /^[+-]?(?:\d+\.?\d*|\.\d+)(px)?$/.test(token)) {
      out.width = token;
      continue;
    }
    if (out.width === undefined && /^(thin|medium|thick)$/.test(token)) {
      if (ngDevMode) warnings.push(new CssWarnEntry(CssCode.ShorthandPartUnsupported, `border 中的 "${token}" 关键字按 1px 处理（Godot 的 border_width 为像素值）`));
      out.width = token === "thin" ? "1px" : token === "thick" ? "3px" : "1px";
      continue;
    }
    if (out.style === undefined && BORDER_STYLES.has(token.toLowerCase())) {
      out.style = token.toLowerCase();
      continue;
    }
    if (out.color === undefined && parseColor(token)) {
      out.color = token;
      continue;
    }
    if (ngDevMode) warnings.push(new CssWarnEntry(CssCode.ShorthandInvalid, `border 中包含无法识别的片段 "${token}"`));
  }
  return out;
}

/**
 * 来源：NativeScript/packages/core/ui/core/properties/index.ts :: _expandCssShorthand
 * 等级：部分修改（主体一致）
 * 相同：对外契约相同——返回 null 表示“不是简写，调用方按 longhand 原样接收”；
 * 都在解析期完成展开（级联定义在 longhand 上）。
 * 改动：上游是注册表 + 转换器（并依赖属性对象实例取 cssLocalName），本侧是硬编码 switch；
 * 上游遇 var()/calc() 返回 undefined 并走待代入路径，本侧无此机制；上游失败只记 Trace，
 * 本侧返回告警列表。
 *
 * 展开一条声明。返回 null 表示不是简写（调用方按 longhand 原样接收）。
 */
export function expandShorthand(property: string, value: string): ShorthandExpansion | null {
  const warnings: CssWarnEntry[] = [];
  const trimmed = value.trim();

  if (PASSTHROUGH.has(property)) return null;

  switch (property) {
    // 来源：NativeScript/packages/core/ui/styling/style-properties.ts :: convertToMargins
    //      / convertToPaddings / borderWidthProperty.converter
    // 等级：部分修改（主体一致）——四边映射与 longhand 命名（`margin-top`、
    // `border-top-width`）逐字相同；上游逐边交给 PercentLength.parse / Length.parse，
    // 本侧保留原文并在此处告警。
    case "margin":
    case "padding": {
      const longhands = sides((side) => `${property}-${side}`, splitValueTokens(trimmed));
      if (!longhands) {
        if (ngDevMode) warnings.push(new CssWarnEntry(CssCode.ShorthandInvalid, `${property} 期望 1–4 个值，收到 "${trimmed}"`));
        return { longhands: [], warnings };
      }
      return { longhands, warnings };
    }

    // 来源：NativeScript/packages/core/ui/styling/style-properties.ts :: borderWidthProperty
    // 等级：部分修改（主体一致）——上游的 ShorthandProperty.converter 展开为四条
    // border-*-width，命名与顺序相同。
    case "border-width": {
      const longhands = sides((side) => `border-${side}-width`, splitValueTokens(trimmed));
      if (!longhands) {
        if (ngDevMode) warnings.push(new CssWarnEntry(CssCode.ShorthandInvalid, `${property} 期望 1–4 个值，收到 "${trimmed}"`));
        return { longhands: [], warnings };
      }
      return { longhands, warnings };
    }

    case "border-style": {
      if (ngDevMode) warnings.push(new CssWarnEntry(CssCode.ShorthandPartUnsupported, "border-style 没有对应实现（Godot 的 StyleBoxFlat 仅提供宽度与颜色，不支持虚线）"));
      return { longhands: [], warnings };
    }

    case "border": {
      const { width, style, color } = borderParts(trimmed, warnings);
      const longhands: Longhand[] = [];
      if (style && style !== "solid" && style !== "none") {
        if (ngDevMode) warnings.push(new CssWarnEntry(CssCode.ShorthandPartUnsupported, `border-style: ${style} 没有对应实现，已丢弃`));
      }
      if (style === "none") {
        for (const side of SIDE_NAMES) longhands.push([`border-${side}-width`, "0px"]);
        return { longhands, warnings };
      }
      if (width) for (const side of SIDE_NAMES) longhands.push([`border-${side}-width`, width]);
      // 颜色只给一条：Godot 的边框四边同色，写四次不如写一次清清楚
      if (color) longhands.push(["border-color", color]);
      return { longhands, warnings };
    }

    case "border-top":
    case "border-right":
    case "border-bottom":
    case "border-left": {
      const side = property.slice("border-".length);
      const { width, style, color } = borderParts(trimmed, warnings);
      const longhands: Longhand[] = [];
      if (style && style !== "solid" && style !== "none") {
        if (ngDevMode) warnings.push(new CssWarnEntry(CssCode.ShorthandPartUnsupported, `border-style: ${style} 没有对应实现，已丢弃`));
      }
      if (width) longhands.push([`border-${side}-width`, style === "none" ? "0px" : width]);
      if (color) {
        longhands.push(["border-color", color]);
        if (ngDevMode) warnings.push(new CssWarnEntry(CssCode.BorderSidesMerged, `border-${side} 的单独颜色没有对应实现（Godot 的边框四边同色），已按整圈边框颜色处理`));
      }
      return { longhands, warnings };
    }

    // 来源：NativeScript/packages/core/ui/styling/style-properties.ts :: borderRadiusProperty
    // 等级：部分修改（主体一致）——上游同样把 top/right/bottom/left 四值映射到
    // 左上 / 右上 / 右下 / 左下四个角，顺序逐字相同；差异是本侧额外处理椭圆写法。
    case "border-radius": {
      // 来源：无
      // `a / b`：横向 / 纵向两套半径。Godot 的 corner_radius 只有单一值，
      // 取横向那套，纵向不同则告警（椭圆圆角无法表达）。
      const [horizontal, vertical] = splitOnSlash(trimmed);
      if (vertical && vertical !== horizontal) {
        if (ngDevMode) warnings.push(new CssWarnEntry(CssCode.ValueUnsupported, "border-radius 的椭圆写法（x / y）仅取横向半径，纵向已忽略"));
      }
      const parts = splitValueTokens(horizontal).map((token) => token.split(/\s+/)[0]);
      const longhands = fourSidesFromParts(parts);
      if (!longhands) {
        if (ngDevMode) warnings.push(new CssWarnEntry(CssCode.ShorthandInvalid, `border-radius 期望 1–4 个值，收到 "${trimmed}"`));
        return { longhands: [], warnings };
      }
      return {
        longhands: [
          ["border-top-left-radius", longhands[0]],
          ["border-top-right-radius", longhands[1]],
          ["border-bottom-right-radius", longhands[2]],
          ["border-bottom-left-radius", longhands[3]],
        ],
        warnings,
      };
    }

    case "background": {
      // 来源：NativeScript/packages/core/ui/styling/style-properties.ts :: convertToBackgrounds
      //      + NativeScript/packages/core/css/parser.ts :: parseBackground
      // 等级：仅思路一致
      // 差异：上游用 parseBackground 完整解析 background 语法（color / image / repeat /
      // position / size，含 url() 与 linear-gradient）；本侧只取颜色。Godot 的 StyleBoxFlat
      // 只有底色一个写入位置，repeat / position / size 无对应物。
      // 只识别颜色；渐变 / url() 没有对应实现
      const longhands: Longhand[] = [];
      for (const token of splitValueTokens(trimmed)) {
        if (/^(url\(|linear-gradient\(|radial-gradient\()/i.test(token)) {
          if (ngDevMode) warnings.push(new CssWarnEntry(CssCode.ShorthandPartUnsupported, "background 的图片/渐变没有对应实现（Godot 的 StyleBoxFlat 纹理属于另一套 API），已丢弃"));
          continue;
        }
        if (parseColor(token)) {
          longhands.push(["background-color", token]);
          continue;
        }
        // CSS 中 background: none 表示“无背景”，Godot 侧对应全透明
        if (/^none$/i.test(token)) {
          longhands.push(["background-color", "transparent"]);
          continue;
        }
        if (/^(repeat|no-repeat|repeat-x|repeat-y|cover|contain|center|left|right|top|bottom)$/i.test(token)) {
          if (ngDevMode) warnings.push(new CssWarnEntry(CssCode.ShorthandPartUnsupported, `background 的位置/平铺片段 "${token}" 没有对应实现，已丢弃`));
          continue;
        }
        if (ngDevMode) warnings.push(new CssWarnEntry(CssCode.ShorthandInvalid, `background 中包含无法识别的片段 "${token}"`));
      }
      return { longhands, warnings };
    }

    case "flex": {
      // 来源：无
      // `flex: n` / `flex: n m` / `flex: n m basis` / `flex: auto` / `flex: none`
      const tokens = splitValueTokens(trimmed);
      if (tokens.length === 1 && tokens[0] === "none") {
        return { longhands: [["flex-grow", "0"], ["flex-shrink", "0"]], warnings };
      }
      if (tokens.length === 1 && tokens[0] === "auto") {
        return { longhands: [["flex-grow", "1"], ["flex-shrink", "1"]], warnings };
      }
      const longhands: Longhand[] = [];
      longhands.push(["flex-grow", tokens[0] ?? "1"]);
      if (tokens[1] !== undefined) longhands.push(["flex-shrink", tokens[1]]);
      if (tokens[2] !== undefined) {
        longhands.push(["flex-basis", tokens[2]]);
        if (ngDevMode) warnings.push(new CssWarnEntry(CssCode.ShorthandPartUnsupported, "flex-basis 没有对应实现（Godot 无 flex-basis 概念），已丢弃"));
      }
      return { longhands, warnings };
    }

    // 来源：无
    // `font: [style || variant || weight || stretch] <size>[/<line-height>] <family>`
    // 仅字号有对应实现。字体族、字重与斜体在 Godot 中对应另一份 Font 资源，行高对应
    // line_spacing（增量语义），三者均无法由该简写可靠推导。
    case "font": {
      const longhands: Longhand[] = [];
      for (const token of splitValueTokens(trimmed)) {
        // `14px/1.5` 的字号部分。取值必须带单位：`font: 700 14px sans-serif` 中的 `700` 为字重，
        // 而本项目的长度解析器将无单位数字按 px 处理，不加此约束会将字重误判为字号
        const head = token.split("/")[0];
        if (longhands.length === 0 && /^[+-]?(?:\d+\.?\d*|\.\d+)(px|em|rem|%)$/i.test(head)) {
          longhands.push(["font-size", head]);
        }
      }
      if (!longhands.length && ngDevMode) {
        warnings.push(new CssWarnEntry(CssCode.ShorthandInvalid, `font: "${trimmed}" 中没找到带单位的字号（如 font: 14px/1.5 sans-serif）`));
      }
      if (ngDevMode) warnings.push(new CssWarnEntry(CssCode.ShorthandPartUnsupported, "font 的字体族 / 字重 / 行高没有对应实现（Godot 的字体是 Font 资源），已提取字号"));
      return { longhands, warnings };
    }

    // 来源：无
    case "inset":
      if (ngDevMode) warnings.push(new CssWarnEntry(CssCode.ShorthandPartUnsupported, "position/inset 没有对应实现（Godot 的 anchors 会与父容器布局产生冲突），已丢弃"));
      return { longhands: [], warnings };

    case "outline":
      if (ngDevMode) warnings.push(new CssWarnEntry(CssCode.PropertyUnsupported, "outline 没有对应实现，已丢弃"));
      return { longhands: [], warnings };

    default:
      return null;
  }
}

/**
 * 来源：无
 *
 * 逗号分隔的多值（`transition: a, b`）——本方案不做动画，仅用于告警
 */
export function isMultiValue(value: string): boolean {
  return splitTopLevel(value, ",").length > 1;
}
