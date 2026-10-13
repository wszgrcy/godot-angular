import { VOCABULARY_DATA, VOCABULARY_META } from "./vocabulary.data";

// 本文件整体无对应物：下游所有落点都必须先查这份由引擎 dump 出来的词汇表
// （见 vocabulary.data.ts）。

/**
 * 来源：无
 */
export type ThemeItemKind = "stylebox" | "color" | "constant" | "font_size";

/**
 * 来源：无
 */
export interface ThemeClassItems {
  styleboxes: readonly string[];
  colors: readonly string[];
  constants: readonly string[];
  fontSizes: readonly string[];
}

/**
 * 来源：无
 *
 * 类名 → 四类 item 清单，以及类名 → 父类名
 */
export interface ThemeVocabulary {
  engine: string;
  fallbackFontSize: number;
  classes: Record<string, ThemeClassItems>;
  parents: Record<string, string>;
}

const LIST_KEYS: Record<ThemeItemKind, keyof ThemeClassItems> = {
  stylebox: "styleboxes",
  color: "colors",
  constant: "constants",
  font_size: "fontSizes",
};

let vocabulary: ThemeVocabulary = VOCABULARY_DATA as unknown as ThemeVocabulary;

/** 供测试注入一份假词汇表使用（生产代码不要调用） */
export function setVocabulary(next: ThemeVocabulary): void {
  vocabulary = next;
}

export function getVocabulary(): ThemeVocabulary {
  return vocabulary;
}

export function vocabularyMeta(): { engine: string; fallbackFontSize: number; classCount: number } {
  return VOCABULARY_META;
}

/**
 * 来源：无
 *
 * 类名 → 父链（包含自身）。查不到时只返回自身——不猜测引擎的继承关系。
 */
export function classChain(className: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = className;
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = vocabulary.parents[current] || undefined;
  }
  return chain;
}

/**
 * 来源：无
 *
 * 该类（含父链回落）是否真的拥有这个 item
 */
export function hasThemeItem(className: string, kind: ThemeItemKind, item: string): boolean {
  const key = LIST_KEYS[kind];
  for (const cls of classChain(className)) {
    const entry = vocabulary.classes[cls];
    if (entry && (entry[key] as readonly string[]).includes(item)) return true;
  }
  return false;
}

/**
 * 来源：无
 *
 * 列出该类（含父链回落）某类 item 的全集，顺序为“越近的父类越后”
 */
export function themeItems(className: string, kind: ThemeItemKind): string[] {
  const key = LIST_KEYS[kind];
  const out = new Set<string>();
  for (const cls of classChain(className)) {
    const entry = vocabulary.classes[cls];
    if (!entry) continue;
    for (const item of entry[key] as readonly string[]) out.add(item);
  }
  return [...out];
}

/**
 * 来源：无
 *
 * 「CSS 属性 → 该控件的 stylebox 名称」的候选顺序。
 *
 * 不同类的 stylebox 名称不一样，因此按候选逐个尝试，第一个在该类词汇表中存在的即采用。
 * 全部不存在 → 该属性对这类控件无落点（告警并忽略）。
 */
const STYLEBOX_CANDIDATES: readonly string[] = ["panel", "normal", "background", "hover", "focus"];

/** 为控件寻找一个可当作“底色”的 stylebox item */
export function pickBackgroundStylebox(className: string): string | null {
  for (const candidate of STYLEBOX_CANDIDATES) {
    if (hasThemeItem(className, "stylebox", candidate)) return candidate;
  }
  return null;
}

/**
 * 来源：无
 *
 * 状态伪类 → stylebox 名称（引擎原生就拥有这几个状态盒）
 */
const STATE_STYLEBOX: Readonly<Record<string, string>> = {
  hover: "hover",
  active: "pressed",
  pressed: "pressed",
  focus: "focus",
  disabled: "disabled",
};

export function styleboxForState(state: string): string | null {
  return STATE_STYLEBOX[state] ?? null;
}

/**
 * 来源：无
 *
 * 状态优先级：同时 hover 又按下时引擎绘制哪个盒，就是这个顺序。
 * 顺序不是随意确定——颠倒会出现“按下去但看着仍是 hover 色”。
 */
export const STATE_PRIORITY: readonly string[] = ["active", "pressed", "hover", "focus", "disabled"];

/**
 * 来源：无
 *
 * 颜色 item 的状态中缀：font_color + hover → font_hover_color（注意下划线不能遗漏）
 */
function stateColorName(base: string, state: string): string | null {
  if (!base.endsWith("_color")) return null;
  const stateName = STATE_STYLEBOX[state];
  if (!stateName) return null;
  return `${base.slice(0, -"_color".length)}_${stateName}_color`;
}

/**
 * 来源：无
 *
 * 根据节点当前状态挑选应当写入的 theme item。引擎在 hover 时读取的是 `font_hover_color` / 绘制
 * `hover` 盒，写成基 item 根本不会显示。词汇表中没有这个变体时退回基 item，不告警。
 */
export function itemForStates(
  className: string,
  kind: ThemeItemKind,
  base: string,
  states: { has(name: string): boolean },
): string {
  if (kind !== "stylebox" && kind !== "color") return base;
  // 两个状态同时成立时，引擎读取的是**合成 item**（Button.font_hover_pressed_color、
  // CheckBox 的 hover_pressed 盒），而不是先命中哪个就算哪个。遗漏它会出现
  // “按下一个已 hover 的按钮，颜色仍是 hover 色”，而引擎默认画法恰好是合成色。
  if (states.has("hover") && (states.has("active") || states.has("pressed"))) {
    const combo = kind === "stylebox" ? "hover_pressed" : `${base.slice(0, -"_color".length)}_hover_pressed_color`;
    if (kind === "stylebox" || base.endsWith("_color")) {
      if (hasThemeItem(className, kind, combo)) return combo;
    }
  }
  for (const state of STATE_PRIORITY) {
    if (!states.has(state)) continue;
    const candidate = kind === "stylebox" ? STATE_STYLEBOX[state] : stateColorName(base, state);
    if (!candidate) continue;
    if (hasThemeItem(className, kind, candidate)) return candidate;
  }
  return base;
}

/**
 * 来源：无
 *
 * 变体名是否已注册（未注册的变体静默回落到基类，没有任何提示，因此只能自行校验）。
 * 词汇表中没有变体信息，由调用方（构建期 / bootstrap）将已注册的名称写入。
 */
let registeredVariations: Set<string> = new Set();

export function setRegisteredVariations(names: Iterable<string>): void {
  registeredVariations = new Set(names);
}

export function isRegisteredVariation(name: string): boolean {
  return registeredVariations.has(name);
}

/** 词汇表中出现过的类名。构建期用它校验元素选择器拼写（见 ruleset.ts） */
export function knownClasses(): string[] {
  return Object.keys(vocabulary.classes);
}
