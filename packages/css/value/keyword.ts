/**
 * 来源：NativeScript/packages/core/ui/core/properties/property-shared.ts :: isCssWideKeyword
 * 等级：部分修改（主体一致）
 * 改动：上游逐个 === 比较 initial / inherit / unset / revert，本侧改用 Set 并追加
 * revert-layer；上游的判定散在每个属性 setter 开头，本侧在 applyCssProperty 一处集中拦截。
 *
 * CSS 全局关键字：Godot 侧没有“回退到继承值”这套机制，一律按“撤销本条声明”处理
 */
export const GLOBAL_KEYWORDS: ReadonlySet<string> = new Set([
  "unset",
  "initial",
  "inherit",
  "revert",
  "revert-layer",
]);

export function isGlobalKeyword(value: string): boolean {
  return GLOBAL_KEYWORDS.has(value.trim().toLowerCase());
}

/**
 * 来源：NativeScript/packages/core/ui/core/properties/index.ts :: isCssVariableExpression
 * 等级：部分修改（主体一致）
 * 改动：上游查 `var(--`，本侧放宽为 `var(`（使非 `--` 前缀的写法也能进入告警而不是静默透传）。
 *
 * `var(--x)` / `var(--x, fallback)`——解析期能展开就展开，无法展开则告警并忽略
 */
export function isVariableReference(value: string): boolean {
  return value.includes("var(");
}

/**
 * 来源：NativeScript/packages/core/ui/core/properties/index.ts :: isCssCalcExpression
 * 等级：完全来自（一字未改）
 *
 * `calc(...)`：本方案不做算术求值（仅支持极简单形态，见 vars.ts）
 */
export function hasCalc(value: string): boolean {
  return value.includes("calc(");
}

/**
 * 来源：NativeScript/packages/core/ui/core/properties/index.ts :: isCssVariable
 * 等级：部分修改（主体一致）
 * 改动：上游用正则 `^--[^,\s]+$`（禁止名称内含空白与逗号），本侧只看前缀；
 * 名称合法性在 vars.ts 展开时再校验。
 *
 * CSS 自定义属性声明（`--x: red`）
 */
export function isCustomPropertyDeclaration(property: string): boolean {
  return property.startsWith("--");
}
