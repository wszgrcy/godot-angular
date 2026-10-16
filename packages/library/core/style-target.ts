import { Color, Control, StyleBoxFlat, Vector2 } from "godot";
import type {
  ColorLike,
  CssNode,
  FourCorners,
  FourSides,
  StyleBackend,
  StyleBoxHandle,
} from "godot-angular/css";
import { applyCssProperty } from "godot-angular/css";
import { nodeHasProperty } from "./registry";
import { warnOnce } from "./warn";
import { asGodotControl, asGodotNode, type GodotControl } from "./godot-node";

/**
 * 来源：无
 *
 * 某个 CSS 属性名下的全部写入：槽位（`写入种类:item`）→ 如何撤销它。槽位串只用作身份与
 * 展示，从不拆回去读。关键的是种类前缀：Godot 的 color / font_size / constant / stylebox
 * 是四张独立的表，item 名可以重名，不带种类就会撞槽位 → 那条 override 永远无法撤销。
 */
type Slots = Map<string, () => void>;

/**
 * 来源：无
 *
 * 单个节点的账本：CSS 属性名 → 它写过的槽位
 */
type Ledger = Map<string, Slots>;

const ledgers = new WeakMap<object, Ledger>();
/**
 * 来源：NativeScript/packages/core/ui/core/properties/index.ts :: _isCssValueStillApplied
 * 等级：仅思路一致
 * 差异：上游按 cssLocalName 记录“值的来源”，用于判定样式与直接赋值的优先级；本侧只存
 * 上一轮落地的原文，用作 diff 与重复写入的短路。
 *
 * 上一次落地的值（`apply(node, v, prev)` 中 prev 的来源，也是重复写入的短路依据）
 */
const applied = new WeakMap<object, Map<string, string>>();

function ledgerOf(node: CssNode): Ledger {
  const key = node as unknown as object;
  let ledger = ledgers.get(key);
  if (!ledger) {
    ledger = new Map();
    ledgers.set(key, ledger);
  }
  return ledger;
}

/** 取得（必要时创建）某个 CSS 属性名下的槽位表 */
function slotsOf(node: CssNode, cssName: string): Slots {
  const ledger = ledgerOf(node);
  let slots = ledger.get(cssName);
  if (!slots) {
    slots = new Map();
    ledger.set(cssName, slots);
  }
  return slots;
}

function record(node: CssNode, cssName: string, item: string, undo: () => void): void {
  const slots = slotsOf(node, cssName);
  if (slots.has(item)) return; // 同一属性重复写同一 item，撤销动作只需记录一次
  slots.set(item, undo);
}

function toColor(value: ColorLike): Color {
  return new Color(value.r, value.g, value.b, value.a);
}

/**
 * 来源：无
 *
 * StyleBoxFlat 的写入句柄。全部写入均来自已经 duplicate 出的副本
 */
class StyleBoxWrite implements StyleBoxHandle {
  constructor(private readonly box: StyleBoxFlat) {}

  setBackground(color: ColorLike | null): void {
    this.box.bg_color = color ? toColor(color) : new Color(0, 0, 0, 0);
  }

  setCornerRadii(radii: Partial<FourCorners>): void {
    if (radii.topLeft !== undefined) this.box.corner_radius_top_left = radii.topLeft;
    if (radii.topRight !== undefined) this.box.corner_radius_top_right = radii.topRight;
    if (radii.bottomRight !== undefined) this.box.corner_radius_bottom_right = radii.bottomRight;
    if (radii.bottomLeft !== undefined) this.box.corner_radius_bottom_left = radii.bottomLeft;
  }

  setBorderWidths(widths: Partial<FourSides>): void {
    if (widths.top !== undefined) this.box.border_width_top = widths.top;
    if (widths.right !== undefined) this.box.border_width_right = widths.right;
    if (widths.bottom !== undefined) this.box.border_width_bottom = widths.bottom;
    if (widths.left !== undefined) this.box.border_width_left = widths.left;
  }

  setBorderColor(color: ColorLike | null): void {
    this.box.border_color = color ? toColor(color) : new Color(0, 0, 0, 0);
  }

  setShadow(shadow: { color: ColorLike; size: number; offsetX: number; offsetY: number }): void {
    this.box.shadow_size = Math.round(shadow.size);
    this.box.shadow_color = toColor(shadow.color);
    this.box.shadow_offset = new Vector2(shadow.offsetX, shadow.offsetY);
  }

  setContentMargin(margin: Partial<FourSides>): void {
    if (margin.top !== undefined) this.box.content_margin_top = margin.top;
    if (margin.right !== undefined) this.box.content_margin_right = margin.right;
    if (margin.bottom !== undefined) this.box.content_margin_bottom = margin.bottom;
    if (margin.left !== undefined) this.box.content_margin_left = margin.left;
  }
}

/** 写入节点属性前的原值（撤销时原样恢复）。属性名是运行期字符串，只能按表读。 */
function readProp(node: Control, prop: string): unknown {
  return (node as unknown as Record<string, unknown>)[prop];
}

/* ------------------------------------------------------------------ *
 * 写入实现
 *
 * 首参 cssName 是 ledger 的分组键。它们只由 scopeOf() 的门面调用——缺少属性名就
 * 无法记账，因此对外不存在“直接调用”的入口。
 * ------------------------------------------------------------------ */

function writeStyleBox(
  cssName: string,
  node: GodotControl,
  item: string,
  apply: (box: StyleBoxHandle) => void,
): void {
  const source = node.has_theme_stylebox(item) ? node.get_theme_stylebox(item) : null;
  // 共享实例修改前必须 duplicate。取不到源（该类没有这个 item）时新建一个，
  // 但那种情况 properties.ts 已先告警过，不会走到这里。
  const copy = (source ? source.duplicate() : new StyleBoxFlat()) as StyleBoxFlat;
  apply(new StyleBoxWrite(copy));
  node.add_theme_stylebox_override(item, copy);
  record(node, cssName, `stylebox:${item}`, () => node.remove_theme_stylebox_override(item));
}

function writeColorOverride(cssName: string, node: GodotControl, item: string, color: ColorLike): void {
  node.add_theme_color_override(item, toColor(color));
  record(node, cssName, `color:${item}`, () => node.remove_theme_color_override(item));
}

function writeFontSizeOverride(cssName: string, node: GodotControl, item: string, size: number): void {
  node.add_theme_font_size_override(item, Math.round(size));
  record(node, cssName, `font_size:${item}`, () => node.remove_theme_font_size_override(item));
}

function writeConstantOverride(cssName: string, node: GodotControl, item: string, value: number): void {
  node.add_theme_constant_override(item, Math.round(value));
  record(node, cssName, `constant:${item}`, () => node.remove_theme_constant_override(item));
}

function writeMinimumSize(
  cssName: string,
  node: GodotControl,
  width: number | null,
  height: number | null,
): void {
  const before = node.custom_minimum_size;
  // 两轴分开记账：width 与 height 是两条 CSS 声明，`clearStyle(node, "width")`
  // 不能连带抹掉 height（共用一个槽位就会如此，所以槽位里带轴名）。
  if (width !== null) {
    const x0 = before.x;
    record(node, cssName, "prop:custom_minimum_size:x", () => {
      node.custom_minimum_size = new Vector2(x0, node.custom_minimum_size.y);
    });
  }
  if (height !== null) {
    const y0 = before.y;
    record(node, cssName, "prop:custom_minimum_size:y", () => {
      node.custom_minimum_size = new Vector2(node.custom_minimum_size.x, y0);
    });
  }
  node.custom_minimum_size = new Vector2(width ?? before.x, height ?? before.y);
}

function writeOpacity(cssName: string, node: GodotControl, alpha: number): void {
  const before = node.modulate;
  record(node, cssName, "prop:modulate", () =>
    (node.modulate = new Color(before.r, before.g, before.b, before.a)),
  );
  node.modulate = new Color(before.r, before.g, before.b, alpha);
}

function writeNodeNumber(cssName: string, node: GodotControl, prop: string, value: number): void {
  const bag = node as unknown as Record<string, unknown>;
  const before = bag[prop];
  record(node, cssName, `prop:${prop}`, () => {
    bag[prop] = before;
  });
  bag[prop] = value;
}

function writeNodeBoolean(cssName: string, node: GodotControl, prop: string, value: boolean): void {
  const bag = node as unknown as Record<string, unknown>;
  const before = bag[prop];
  record(node, cssName, `prop:${prop}`, () => {
    bag[prop] = before;
  });
  bag[prop] = value;
}

/** 写入类方法在基 backend 上必须抛错：缺少属性名 = 无法记账 = 永远无法撤销 */
function needsScope(method: string): never {
  throw new Error(
    `StyleBackend.${method} 必须经 applyProperty 给出的作用域门面调用（ledger 需要 CSS 属性名才能记账）`,
  );
}

/**
 * 来源：NativeScript/packages/core/ui/styling/style-properties.ts（CSS 属性 → 原生 setter 的写入层）
 * 等级：仅思路一致
 * 差异：上游的写入层是 Style 上的属性访问器（写入即生效，无需撤销记录）；本侧的写入
 * 全部要记账，而记账需要 CSS 属性名，因此基 backend 上的写入方法一律抛错（needsScope），
 * 真实实现只能由 applyProperty 给出的作用域门面调用。
 *
 * 纯包识别的唯一落点实现，只保留读取与基础设施；写入方法一律抛错（needsScope），真实现在
 * 上方，由 scopeOf() 按 CSS 属性名包装成门面。使用方刷新样式请使用 `applyStyle`。
 */
export const backend: StyleBackend = {
  classOf: (node) => asGodotControl(node).get_class(),

  bulk<T>(node: CssNode, apply: () => T): T {
    const target = asGodotControl(node);
    // 批量期间 theme 通知只发一次，避开 N 次重排
    target.begin_bulk_theme_override();
    try {
      return apply();
    } finally {
      target.end_bulk_theme_override();
    }
  },

  mutateStyleBox: () => needsScope("mutateStyleBox"),
  setColorOverride: () => needsScope("setColorOverride"),
  setFontSizeOverride: () => needsScope("setFontSizeOverride"),
  setConstantOverride: () => needsScope("setConstantOverride"),

  setMinimumSize: () => needsScope("setMinimumSize"),
  setOpacity: () => needsScope("setOpacity"),
  setNodeNumber: () => needsScope("setNodeNumber"),
  getNodeNumber: (node, prop) => Number(readProp(asGodotControl(node), prop) ?? 0),
  setNodeBoolean: () => needsScope("setNodeBoolean"),

  hasNodeProperty: (node, prop) => nodeHasProperty(asGodotNode(node), prop),

  // 级联写入样式的唯一入口：将 cssName 关进作用域门面，下方的写入在记账时
  // 才知道应当记到哪个属性名下。
  applyProperty(
    node: CssNode,
    cssName: string,
    raw: string,
    warnings: string[],
    states: ReadonlySet<string>,
  ): boolean {
    return applyCssProperty(
      node,
      cssName,
      raw,
      {
        backend: scopeOf(cssName),
        warn: (key, message) => warnOnce(`css:${key}`, message),
        states,
      },
      warnings,
    );
  },

  parentOf: (node) => {
    const parent = asGodotNode(node).get_parent();
    return parent === null ? null : asGodotNode(parent);
  },

  childrenOf: (node) => [...asGodotNode(node).get_children()].map(asGodotNode),

  // 级联算出“这条 CSS 属性不再被认领”时进入此处。ledger 的外层键就是属性名
  //（见 record / slotsOf），因此“只撤销这一条”在这里对应一次 get。
  clearProperty: (node, cssName) => clearStyle(asGodotControl(node), cssName),
};

/**
 * 属性作用域门面：将 CSS 属性名关进写入方法。若用模块级变量做动态作用域，绕过门面的
 * 写入会静默记到错误的属性名下（永远无法撤销）。读方法通过原型委托复用 backend，写入方法
 * 作为自有属性覆盖上去，每个属性名只创建一次并存入缓存。
 */
const scopes = new Map<string, StyleBackend>();
/** 属性名本应是个小闭集；设上限是为了防止“把任意字符串当属性名”使缓存无限增长 */
const MAX_SCOPES = 256;

function scopeOf(cssName: string): StyleBackend {
  let scope = scopes.get(cssName);
  if (scope) return scope;
  scope = Object.assign(Object.create(backend) as StyleBackend, {
    mutateStyleBox: (node: CssNode, item: string, apply: (box: StyleBoxHandle) => void) =>
      writeStyleBox(cssName, asGodotControl(node), item, apply),
    setColorOverride: (node: CssNode, item: string, color: ColorLike) =>
      writeColorOverride(cssName, asGodotControl(node), item, color),
    setFontSizeOverride: (node: CssNode, item: string, size: number) =>
      writeFontSizeOverride(cssName, asGodotControl(node), item, size),
    setConstantOverride: (node: CssNode, item: string, value: number) =>
      writeConstantOverride(cssName, asGodotControl(node), item, value),
    setMinimumSize: (node: CssNode, width: number | null, height: number | null) =>
      writeMinimumSize(cssName, asGodotControl(node), width, height),
    setOpacity: (node: CssNode, alpha: number) => writeOpacity(cssName, asGodotControl(node), alpha),
    setNodeNumber: (node: CssNode, prop: string, value: number) =>
      writeNodeNumber(cssName, asGodotControl(node), prop, value),
    setNodeBoolean: (node: CssNode, prop: string, value: boolean) =>
      writeNodeBoolean(cssName, asGodotControl(node), prop, value),
  });
  if (scopes.size < MAX_SCOPES) scopes.set(cssName, scope);
  return scope;
}

/* ------------------------------------------------------------------ *
 * 对外入口
 * ------------------------------------------------------------------ */

/** 裸声明的状态集：空集 = 不要求任何状态，落基 item */
const NO_STATES: ReadonlySet<string> = new Set<string>();

/**
 * 将一条 CSS 声明落到节点上。value 传空串表示撤销这一条。
 *
 * 这是一条**裸声明**通道（没有选择器），因此永远只写基 item：需要状态外观请走样式表
 * （`styles` / class 选择器 + `:hover` / `:disabled` …），那里才有「选择器要求了哪个状态」这个信息。
 */
export function applyStyle(node: Control, cssName: string, value: unknown): void {
  const raw = value === null || value === undefined ? "" : String(value);
  if (!raw) {
    clearStyle(node, cssName);
    return;
  }
  let values = applied.get(node);
  if (!values) {
    values = new Map();
    applied.set(node, values);
  }
  if (values.get(cssName) === raw) return; // Angular 每轮变更检测都会重递同样的值
  values.set(cssName, raw);

  const warnings: string[] = [];
  const target = asGodotControl(node);
  // 裸声明没有选择器，也就无从要求状态 → 空集 = 永远写基 item。
  // 否则一个 hover 中的节点会把基色写进 hover 盒，与级联对基规则的口径不一致。
  const known = backend.bulk(target, () => backend.applyProperty(target, cssName, raw, warnings, NO_STATES));
  if (!known) {
    warnOnce(
      `css:unknown:${cssName}`,
      `样式 "${cssName}" 无 Godot 对应，已忽略（布局请使用容器 + sizeFlags，外观请使用 Theme）`,
    );
  }
  for (const message of warnings) warnOnce(`css:value:${cssName}:${message}`, message);
}

/** 撤销：给出属性名时只撤销那一条，未给出则全部撤销（只处理 ledger 记录过的项） */
export function clearStyle(node: Control, cssName?: string): void {
  const ledger = ledgers.get(node);
  if (ledger) {
    // 快照后再遍历：撤销动作理论上可能写回账本，边遍历边删除会遗漏
    if (cssName) {
      const slots = ledger.get(cssName);
      if (slots) {
        for (const undo of [...slots.values()]) undo();
        ledger.delete(cssName);
      }
      // 未记录过也不能提前返回：下方 applied 中的残留必须清除，否则下次 applyStyle
      // 碰上“值未变化”短路，该条样式无法再次写入
    } else {
      for (const [property, slots] of [...ledger]) {
        for (const undo of [...slots.values()]) undo();
        ledger.delete(property);
      }
    }
  }
  const values = applied.get(node);
  if (values) {
    if (cssName) values.delete(cssName);
    else values.clear();
  }
}

/**
 * 该节点上已写入的项（供测试与 diff 使用）。
 *
 * 拼成 `CSS属性名|种类:item` 只是展示格式，没有代码将它拆回去读。
 */
export function styleLedger(node: Control): string[] {
  const ledger = ledgers.get(node);
  if (!ledger) return [];
  const keys: string[] = [];
  for (const [property, slots] of ledger) {
    for (const slot of slots.keys()) keys.push(`${property}|${slot}`);
  }
  return keys;
}

function warn(key: string, message: string): void {
  warnOnce(`css:${key}`, message);
}
