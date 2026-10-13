// 对外入口。本包与 NativeScript/packages/core 的对应关系（逐符号的等级与差异见各文件）：
//   selector.ts   ← ui/styling/css-selector.ts
//   parser.ts     ← css/lib/parse/index.ts + css/css-tree-parser.ts（产物形状见 css/reworkcss.ts）
//   ruleset.ts    ← ui/styling/style-scope.ts :: CSSSource + css-selector.ts :: RuleSet
//   shorthand.ts  ← ui/core/properties/index.ts :: _expandCssShorthand + ui/styling/style-properties.ts
//   mediaquery.ts ← css-mediaquery/index.ts
//   value/        ← color/color-utils.ts、known-colors.ts、ui/styling/{length-shared,css-shadow,css-utils}.ts
//   runtime/      ← ui/styling/{style-scope,css-selector}.ts 的 CssState + ui/core 的失效通知
//   vocabulary.ts ← 无对应物
export type {
  CssNode,
  CssWarning,
  Declaration,
  ColorLike,
  FourCorners,
  FourSides,
  MediaEnvironment,
  RuleSet as CssRuleSetShape,
  StyleBackend,
  StyleBoxHandle,
} from "./types";
export { SelectorTier } from "./types";

export {
  parseCss,
  flattenRules,
  splitSelectors,
  type CssStyleSheet,
  type CssRule,
  type CssDeclaration,
  type CssMedia,
  type CssPosition,
} from "./parser";

export {
  createSelector,
  splitTopLevel,
  compareSelectors,
  matchSelectorCandidates,
  SelectorsMatch,
  SelectorScope,
  SelectorCore,
  SimpleSelector,
  SimpleSelectorSequence,
  ComplexSelector,
  InvalidSelector,
  UniversalSelector,
  IdSelector,
  TypeSelector,
  ClassSelector,
  AttributeSelector,
  PseudoClassSelector,
  FunctionalPseudoClassSelector,
  Specificity,
  Rarity,
  Combinator,
  SUPPORTED_PSEUDO_CLASSES,
  collectPseudoClasses,
  type ChangeMap,
  type Changes,
  type LookupSorter,
} from "./selector";

export { buildRuleSets, StyleSheetIndex, type BuildResult, type RuleSet } from "./ruleset";
export { expandShorthand, isMultiValue, type Longhand, type ShorthandExpansion } from "./shorthand";

export {
  Cascade,
  type CascadeOptions,
  type CascadeStats,
  type MergedDeclaration,
  type NodeStyleState,
} from "./runtime/cascade";
export { readStashedState, stashState } from "./runtime/state";
// 只导出类型，不导出构造入口：它只能由 `Cascade.attach` 装在节点上，自行 new 出的实例不会发出通知。
// 保留它只为让调用方的签名能表达“这个 Set 被修改后会标脏”，而不是让人误以为它是普通 Set。
export type { TrackingClassSet } from "./runtime/state";
// 自定义属性：级联内部展开 var() 用的就是这三个；导出它们是为了让测试能单独验证 var() 语义
export { resolveVars, sameVars, usesVars, type VarLookup } from "./runtime/vars";

export { matchQuery, parseQuery, mediaQueryDependencies } from "./mediaquery";

export {
  getVocabulary,
  setVocabulary,
  vocabularyMeta,
  classChain,
  hasThemeItem,
  themeItems,
  pickBackgroundStylebox,
  styleboxForState,
  itemForStates,
  STATE_PRIORITY,
  setRegisteredVariations,
  isRegisteredVariation,
  knownClasses,
  type ThemeItemKind,
  type ThemeVocabulary,
} from "./vocabulary";

export {
  applyCssProperty,
  cssPropertyNames,
  isAppearanceProperty,
  lookupProperty,
  type ApplyContext,
  type CssProperty,
} from "./runtime/properties";

export { parseColor, parseHexColor, colorToCss, TRANSPARENT } from "./value/color";
export { parseLength, parsePx, parseNumber, isUnsupportedUnit, isZero, type CssLength } from "./value/length";
export { parseBoxShadow, type CssShadow } from "./value/shadow";
export { fourSidesFromParts, toFourSides, sidesAsArray } from "./value/sides";
export { splitValueTokens, splitOnSlash } from "./value/tokens";
export {
  isGlobalKeyword,
  isVariableReference,
  hasCalc,
  isCustomPropertyDeclaration,
  GLOBAL_KEYWORDS,
} from "./value/keyword";
