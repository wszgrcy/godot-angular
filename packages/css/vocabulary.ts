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
 * 来源：引擎 dump（各类拥有的 item）+ 引擎绘制规则（BaseButton 的 is_pressed 参与绘制状态判定）
 *
 * 状态伪类 → stylebox 名称（引擎原生就拥有这几个状态盒），颜色 item 由它推出来（见
 * `stateItemCandidates`）。比原版多三个状态：
 *
 * - `checked` 落 `pressed`：开关控件（CheckBox / CheckButton / toggle_mode 的 Button）在
 *   `button_pressed=true` 时画的是 `pressed` 盒与 `font_pressed_color`，而不是 `normal` /
 *   `font_color`。漏掉它就会出现「`:checked` 的样式永远看不见」：样式写进了 `font_color`，
 *   而引擎在勾选态根本不读它，勾选框于是一直是主题默认的白字（浅色主题下＝不可见）。
 * - `selected` 对应 ItemList / Tree 的选中态；该状态没有信号来源，只能手动驱动。
 * - `read-only` 的盒叫 `read_only`，但文字色不叫 `font_read_only_color`，见下面的例外表。
 */
const STATE_STYLEBOX: Readonly<Record<string, string>> = {
  hover: "hover",
  active: "pressed",
  pressed: "pressed",
  checked: "pressed",
  selected: "selected",
  "read-only": "read_only",
  focus: "focus",
  disabled: "disabled",
};

/**
 * 来源：引擎 dump 逐类核对
 *
 * 颜色中缀与 stylebox 名不同名时的例外；同一语义在不同类上叫法也不同，按顺序取该类
 * 真正拥有的那个。只读文字色：TextEdit 叫 `font_readonly_color`，LineEdit 叫 `font_uneditable_color`。
 */
const STATE_COLOR_INFIX: Readonly<Record<string, readonly string[]>> = {
  "read-only": ["readonly", "uneditable"],
};

export function styleboxForState(state: string): string | null {
  return STATE_STYLEBOX[state] ?? null;
}

/**
 * 来源：引擎 `BaseButton.get_draw_mode()`（`if (!is_enabled()) return DRAW_DISABLED;` 是第一句）
 *
 * 状态优先级：多个状态同时成立时引擎绘制哪个盒，就是这个顺序。
 * 顺序不是随意确定——颠倒会出现“按下去但看着仍是 hover 色”。
 * `disabled` 必须排第一：引擎先问 enabled 再问 pressed/hover，所以上一个已勾选的禁用
 * CheckBox 读的是 `font_disabled_color`，把 `checked` 排在前面就会把样式写进引擎不读的
 * `font_pressed_color`（症状：禁用项文字白成一片）。
 * `checked` / `selected` 排在 `hover` 之前：勾选态与选中态是控件的**内容状态**，
 * 引擎在勾选时即使鼠标悬停也走 pressed / hover_pressed，而不是 hover。
 */
export const STATE_PRIORITY: readonly string[] = [
  "disabled",
  "active",
  "pressed",
  "checked",
  "selected",
  "hover",
  "focus",
  "read-only",
];

/** 该状态在这类属性上可选的 item 名（按优先级） */
function stateItemCandidates(className: string, kind: "stylebox" | "color", base: string, state: string): string[] {
  const item = STATE_STYLEBOX[state];
  if (!item) return [];
  if (kind === "stylebox") return [item];
  // 颜色 item 的状态中缀：font_color + hover → font_hover_color（注意下划线不能遗漏）
  if (!base.endsWith("_color")) return [];
  const stem = base.slice(0, -"_color".length);
  return (STATE_COLOR_INFIX[state] ?? [item]).map((infix) => `${stem}_${infix}_color`);
}

/**
 * 来源：无
 *
 * 根据节点当前状态挑选应当写入的 theme item。引擎在 hover 时读取的是 `font_hover_color` / 绘制
 * `hover` 盒，写成基 item 根本不会显示。词汇表中没有这个变体时退回基 item，不告警
 * （“hover 期间整体换色”是 PanelContainer 这类只有一个盒的控件的正常用法，报出来只是噪声）。
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
  // 勾选（checked）与鼠标按下（active/pressed）在这里等价：引擎都走 pressed 那一支。
  // disabled 参与时不能走合成：引擎在 !is_enabled() 时直接返回 DRAW_DISABLED。
  if (
    !states.has("disabled") &&
    states.has("hover") &&
    (states.has("active") || states.has("pressed") || states.has("checked"))
  ) {
    const combo = kind === "stylebox" ? "hover_pressed" : `${base.slice(0, -"_color".length)}_hover_pressed_color`;
    if (kind === "stylebox" || base.endsWith("_color")) {
      if (hasThemeItem(className, kind, combo)) return combo;
    }
  }
  for (const state of STATE_PRIORITY) {
    if (!states.has(state)) continue;
    for (const candidate of stateItemCandidates(className, kind, base, state)) {
      if (hasThemeItem(className, kind, candidate)) return candidate;
    }
  }
  return base;
}

/** 词汇表中出现过的类名。构建期用它校验元素选择器拼写（见 ruleset.ts） */
export function knownClasses(): string[] {
  return Object.keys(vocabulary.classes);
}
