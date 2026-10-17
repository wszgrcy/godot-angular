import type { ColorLike } from "../types";
import { parseColor } from "./color";
import { parsePx } from "./length";
import { splitValueTokens } from "./tokens";
import { splitTopLevel } from "../selector";

/** 开发模式标记：生产构建中整个 `if (ngDevMode)` 分支连同告警文案一并消除（口径见 runtime/properties.ts） */

/**
 * 来源：NativeScript/packages/core/ui/styling/css-shadow.ts :: ShadowCSSValues
 * 等级：部分修改（主体一致）
 * 改动：字段名 blurRadius / spreadRadius 缩短为 blur / spread；上游存的是未解析的
 * CoreTypes.LengthType（可为百分比），本侧直接存已解析的像素数；上游的
 * blurRadius / spreadRadius / color 可缺省，本侧颜色必有值（缺省补默认色）。
 */
export interface CssShadow {
  inset: boolean;
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  color: ColorLike;
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-utils.ts :: parseCSSShorthand 的 color = 'black'
 * 等级：部分修改（主体一致）
 * 改动：上游默认黑色不透明（CSS 规范如此），本侧改为半透黑——无落点时宁可弱一点。
 */
const DEFAULT_SHADOW_COLOR: ColorLike = { r: 0, g: 0, b: 0, a: 0.5 };

/**
 * 来源：无
 */
export interface ShadowParseResult {
  shadow: CssShadow | null;
  warnings: string[];
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-utils.ts :: isLength
 * 等级：仅思路一致
 * 差异：上游用 startsWithLengthUnit 逐个比对单位后缀（含 dip / em / vh 等全部 CSS 单位），
 * 本侧只判断“是否以数字或符号开头”，具体单位交给 parsePx 判定。
 */
const NUMERIC_START = /^[+-]?(?:\d+\.?\d*|\.\d+)/;

/**
 * 来源：NativeScript/packages/core/ui/styling/css-shadow.ts :: parseCSSShadow
 *      + NativeScript/packages/core/ui/styling/css-utils.ts :: parseCSSShorthand
 * 等级：部分修改（主体一致）
 * 相同：都是“逐段分类为 inset / 长度 / 颜色，再按位置赋给 offset / blur / spread”；
 * 默认颜色、至少两个偏移量的约束也相同。
 * 改动：上游只取首段或尾段作颜色（颜色不在两端则丢成长度），本侧逐段试解析颜色；
 * 上游无法解析的长度静默归为 0，本侧告警；上游支持多层（逗号分隔）全部返回，
 * 本侧只取第一层；本侧额外对 inset / spread 给出“无落点”告警。
 */
function parseOne(text: string, warnings: string[]): CssShadow | null {
  let inset = false;
  let color: ColorLike | null = null;
  const numbers: number[] = [];

  for (const token of splitValueTokens(text)) {
    if (/^inset$/i.test(token)) {
      inset = true;
      continue;
    }
    // 数字优先按长度解释：`0` 既不是颜色，也不应被当作其他内容
    if (NUMERIC_START.test(token)) {
      const px = parsePx(token);
      if (px === null) {
        if (ngDevMode) warnings.push(`box-shadow 中包含无法识别的长度 "${token}"`);
        continue;
      }
      numbers.push(px);
      continue;
    }
    const parsed = parseColor(token);
    if (parsed) {
      if (color && ngDevMode) warnings.push(`box-shadow 中出现第二个颜色 "${token}"，以第一个为准`);
      else color = parsed;
      continue;
    }
    if (ngDevMode) warnings.push(`box-shadow 中包含无法识别的片段 "${token}"`);
  }

  if (numbers.length < 2) {
    if (ngDevMode) warnings.push(`box-shadow 至少需要 x/y 两个偏移量：${text}`);
    return null;
  }
  return {
    inset,
    offsetX: numbers[0],
    offsetY: numbers[1],
    blur: numbers.length > 2 ? numbers[2] : 0,
    spread: numbers.length > 3 ? numbers[3] : 0,
    color: color ?? DEFAULT_SHADOW_COLOR,
  };
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-shadow.ts :: parseCSSShadow
 * 等级：部分修改（主体一致）
 * 改动：上游对 none / unset 返回 null 且无告警通道，本侧返回结构化结果；多层阴影的
 * 截断告警与 inset / spread 无落点告警是本侧新增。
 *
 * 解析 `box-shadow` 的值；`none` 或无法解析时返回 shadow = null
 */
export function parseBoxShadow(text: string): ShadowParseResult {
  const warnings: string[] = [];
  const trimmed = text.trim();
  if (!trimmed || trimmed.toLowerCase() === "none") return { shadow: null, warnings };

  const layers = splitTopLevel(trimmed, ",");
  if (layers.length > 1) {
    if (ngDevMode) warnings.push("box-shadow 的多层阴影仅取第一层（Godot 的 StyleBoxFlat 仅支持一层 shadow）");
  }
  const shadow = parseOne(layers[0], warnings);
  if (shadow?.inset && ngDevMode) warnings.push("box-shadow: inset 无落点（Godot 无内阴影），已按外阴影处理");
  if (shadow && shadow.spread !== 0 && ngDevMode) warnings.push("box-shadow 的 spread 无落点，已忽略");
  return { shadow, warnings };
}
