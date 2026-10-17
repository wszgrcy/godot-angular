import { Color, Control, Font, ResourceLoader, StyleBox, StyleBoxEmpty, StyleBoxFlat, StyleBoxTexture, SystemFont, Texture2D, Vector2 } from "godot";
import type {
  ColorLike,
  CssNode,
  FontSource,
  FourCorners,
  FourSides,
  StyleBackend,
  StyleBoxHandle,
} from "godot-angular/css";
import { applyCssProperty, pickBackgroundStylebox, themeItems } from "godot-angular/css";
import { classHasProperty, nodeHasProperty } from "./registry";
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
 * StyleBoxFlat 的写入句柄。**只记录字段，不直接写盒**：盒最终由 `rebuildBoxes` 按
 * 「引擎该状态的默认盒 ⊕ 基规则声明过的字段 ⊕ 该状态声明过的字段」整体重建，
 * 因此每条声明写了哪些字段必须留痕，否则状态盒拿不到基规则的几何（悬停即重排）。
 */
class StyleBoxWrite implements StyleBoxHandle {
  /** StyleBoxFlat 属性名 → 值 */
  readonly fields = new Map<string, unknown>();

  setBackground(color: ColorLike | null): void {
    this.fields.set("bg_color", color ? toColor(color) : new Color(0, 0, 0, 0));
  }

  setTexture(path: string): void {
    this.fields.set("texture", path);
  }

  setCornerRadii(radii: Partial<FourCorners>): void {
    if (radii.topLeft !== undefined) this.fields.set("corner_radius_top_left", radii.topLeft);
    if (radii.topRight !== undefined) this.fields.set("corner_radius_top_right", radii.topRight);
    if (radii.bottomRight !== undefined) this.fields.set("corner_radius_bottom_right", radii.bottomRight);
    if (radii.bottomLeft !== undefined) this.fields.set("corner_radius_bottom_left", radii.bottomLeft);
  }

  setBorderWidths(widths: Partial<FourSides>): void {
    if (widths.top !== undefined) this.fields.set("border_width_top", widths.top);
    if (widths.right !== undefined) this.fields.set("border_width_right", widths.right);
    if (widths.bottom !== undefined) this.fields.set("border_width_bottom", widths.bottom);
    if (widths.left !== undefined) this.fields.set("border_width_left", widths.left);
  }

  setBorderColor(color: ColorLike | null): void {
    this.fields.set("border_color", color ? toColor(color) : new Color(0, 0, 0, 0));
  }

  setShadow(shadow: { color: ColorLike; size: number; offsetX: number; offsetY: number }): void {
    this.fields.set("shadow_size", Math.round(shadow.size));
    this.fields.set("shadow_color", toColor(shadow.color));
    this.fields.set("shadow_offset", new Vector2(shadow.offsetX, shadow.offsetY));
  }

  setContentMargin(margin: Partial<FourSides>): void {
    if (margin.top !== undefined) this.fields.set("content_margin_top", margin.top);
    if (margin.right !== undefined) this.fields.set("content_margin_right", margin.right);
    if (margin.bottom !== undefined) this.fields.set("content_margin_bottom", margin.bottom);
    if (margin.left !== undefined) this.fields.set("content_margin_left", margin.left);
  }
}

/**
 * 全新的、**什么都不画**的 Flat 盒（用来替身 StyleBoxEmpty / 根本没有盒）。
 *
 * 两件必须处好的事：
 *
 * 1. **抹掉默认底色**。`new StyleBoxFlat()` 的默认 `bg_color` 是 `#999999ff`（不透明灰，
 *    文档写的是 `Color(0.6, 0.6, 0.6, 1)`）、`border_color` 是 `#ccccccff`。这个类存在的
 *    目的就是画一个看得见的盒子，所以属性默认值必须是可见的（否则在 Inspector 里看不出自己
 *    建了个空盒）。直接拿来用会让「只写了 padding」的 Label 被画上一个灰块（示例工程的
 *    `.nav-title` / `.nav-foot` 就是这么踩到的）。而它替身的是 StyleBoxEmpty——语义就是
 *    「什么都不画」，所以透底才是忠实还原。
 * 2. **把源盒的 content_margin 搬过来**。`content_margin_*` 是 StyleBox 基层的属性（布局语义），
 *    不是 Flat 独有。默认主题里 `CheckBox` 的 normal/hover/pressed/hover_pressed 是
 *    **StyleBoxEmpty 但 content_margin = 4/4/4/4**（实测），不搬的话 CSS 只要碰一下
 *    CheckBox 的底色，它的内边距就从 4 塌到 -1，图标与文字的位置跟着变。
 *    `expand_margin_*` / `shadow_*` 是 Flat 子类才有的，Empty 上本来就没值，保持默认 0。
 */
function blankFlat(src: StyleBox | null): StyleBoxFlat {
  const box = new StyleBoxFlat();
  // Color.TRANSPARENT = 白底零 alpha（typings 注释：white with zero alpha）。
  // alpha=0 时 RGB 不参与混合结果，所以黑透/白透渲染等价；用引擎自带的常量而不是手造值。
  box.bg_color = Color.TRANSPARENT;
  box.border_color = Color.TRANSPARENT;
  if (src !== null) {
    // -1 = 未设置（StyleBox 基层的默认），原样搬过去就是“未设置”
    box.content_margin_top = src.content_margin_top;
    box.content_margin_right = src.content_margin_right;
    box.content_margin_bottom = src.content_margin_bottom;
    box.content_margin_left = src.content_margin_left;
  }
  return box;
}

/**
 * 某个 item 的「引擎默认盒」快照。
 *
 * 分三种情况：
 * - StyleBoxFlat：直接 duplicate，字段全支持；
 *   StyleBoxEmpty / 根本没有盒：换成全新的空 Flat。StyleBoxEmpty 的含义就是「什么都不画」，
 *   没有任何引擎外观会被抹掉，而它没有 bg_color / corner_radius / border_width 属性，
 *   不换成 Flat 的话作者写的底色永远静默无效（CheckBox 的 normal、Label 的 normal、
 *   ScrollContainer 的 panel 在默认主题里都是 StyleBoxEmpty）。布局语义的 content_margin
 *   由 blankFlat() 从源盒搬过来（CheckBox 的 Empty 盒就带着 4px，不搬会塌）；外观则保持
 *   透底，作者声明什么才画什么；
 * - 其它子类（StyleBoxTexture / StyleBoxLine）：**必须保留原类型**，它们携带真实图形
 *   （拖条、分隔线），换成 Flat 会把图形抹掉；不支持的字段由 applyBoxFields 逐项挡掉并告警。
 */
function seedBoxFor(node: GodotControl, cls: string, item: string, src: StyleBox | null): StyleBox {
  if (src === null) return blankFlat(null);
  if (src instanceof StyleBoxEmpty) return blankFlat(src);
  if (!(src instanceof StyleBoxFlat)) {
    if (ngDevMode) warnOnce(
      `css:boxflat:${cls}:${item}`,
      `${cls} 的 ${item} 盒是 ${src.get_class()}，只有 content_margin_* 可写（底色 / 圆角 / 边框粗细 / 阴影`
        + "只有 StyleBoxFlat 支持）。本库不会把它的图形换成色块，如需底色请自行 add_theme_stylebox_override。",
    );
  }
  return src.duplicate() as StyleBox;
}

/**
 * 把一批字段写进盒。
 *
 * 盒不一定是 StyleBoxFlat（见 `seedBoxFor`）。GodotJS 对不存在的属性赋值是**静默接受**的，
 * 所以必须先用 ClassDB 查属性存在，否则“写了没效果”无法定位。
 */
function applyBoxFields(box: StyleBox, fields: ReadonlyMap<string, unknown>): void {
  const cls = box.get_class();
  for (const [key, value] of fields) {
    if (!classHasProperty(cls, key)) {
      if (ngDevMode) warnOnce(
        `css:boxfield:${cls}:${key}`,
        `${cls} 没有 ${key} 属性（底色 / 圆角 / 边框粗细 / 阴影只有 StyleBoxFlat 支持，`
          + "纹理盒只能接 content_margin_*），该字段已忽略。",
      );
      continue;
    }
    switch (key) {
      case "bg_color": (box as StyleBoxFlat).bg_color = value as Color; break;
      case "texture": {
        const texture = loadTexture(value as string);
        // 写入前已校验，至此仅可能为缓存命中；保留守卫是为了避免加载失败时默默写入 null
        if (texture) (box as StyleBoxTexture).texture = texture;
        break;
      }
      case "border_color": (box as StyleBoxFlat).border_color = value as Color; break;
      case "corner_radius_top_left": (box as StyleBoxFlat).corner_radius_top_left = value as number; break;
      case "corner_radius_top_right": (box as StyleBoxFlat).corner_radius_top_right = value as number; break;
      case "corner_radius_bottom_right": (box as StyleBoxFlat).corner_radius_bottom_right = value as number; break;
      case "corner_radius_bottom_left": (box as StyleBoxFlat).corner_radius_bottom_left = value as number; break;
      case "border_width_top": (box as StyleBoxFlat).border_width_top = value as number; break;
      case "border_width_right": (box as StyleBoxFlat).border_width_right = value as number; break;
      case "border_width_bottom": (box as StyleBoxFlat).border_width_bottom = value as number; break;
      case "border_width_left": (box as StyleBoxFlat).border_width_left = value as number; break;
      case "content_margin_top": box.content_margin_top = value as number; break;
      case "content_margin_right": box.content_margin_right = value as number; break;
      case "content_margin_bottom": box.content_margin_bottom = value as number; break;
      case "content_margin_left": box.content_margin_left = value as number; break;
      case "shadow_size": (box as StyleBoxFlat).shadow_size = value as number; break;
      case "shadow_color": (box as StyleBoxFlat).shadow_color = value as Color; break;
      case "shadow_offset": (box as StyleBoxFlat).shadow_offset = value as Vector2; break;
      default: if (ngDevMode) warnOnce(`css:boxfield:${cls}:${key}`, `stylebox 字段 "${key}" 无对应属性，已忽略`);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 状态盒模型（CSS 层叠在 Godot Theme 上的落地形状）
 *
 * Godot 为每个状态各存一个完整、互不继承的盒；CSS 的 `:hover` 只覆盖它自己声明的那几条，
 * 其余沿用基规则。所以状态盒必须由本库合成，规则是：
 *
 *   状态盒 = 引擎该状态的默认盒 ⊕ 基规则【声明过】的字段 ⊕ 该状态声明的字段
 *
 * 中间那层是「作者真正声明过的字段」，不是整个基盒（那会把基盒的引擎默认底色也搬过去，
 * 抹掉引擎的悬停加深），也不是只有几何字段（那会让基规则声明的底色在悬停时跳回引擎默认）。
 * ------------------------------------------------------------------ */

/**
 * 来源：引擎 dump（各类拥有的 item）
 *
 * 状态盒 item 的封闭集合。只有这几个名字是「某个状态的盒」；Tree 的 `hovered`、TabBar 的
 * `tab_hovered`、FoldableContainer 的 `title_hover_panel` 是**行级 / 标签级 / 标题条级**状态，
 * CSS 的 `:hover` 表达的不是它们，不参与同步（硬映射过去语义就错了）。
 */
const STATE_STYLEBOX_ITEMS: readonly string[] = [
  "hover",
  "pressed",
  "disabled",
  "focus",
  "selected",
  "read_only",
  "hover_pressed",
];

/** 按类缓存「该类真正拥有的状态盒 item」 */
const stateItemsByClass = new Map<string, string[]>();

function stateItemsOf(cls: string, baseItem: string): string[] {
  let list = stateItemsByClass.get(cls);
  if (!list) {
    const owned = themeItems(cls, "stylebox");
    list = STATE_STYLEBOX_ITEMS.filter((item) => item !== baseItem && owned.includes(item));
    stateItemsByClass.set(cls, list);
  }
  return list;
}

type FieldMap = Map<string, unknown>;

interface BoxModel {
  readonly baseItem: string;
  /** 基规则（选择器不要求任何状态）声明过的字段：CSS 属性名 → 字段 */
  readonly base: Map<string, FieldMap>;
  /** 状态规则声明过的字段：item → CSS 属性名 → 字段 */
  readonly states: Map<string, Map<string, FieldMap>>;
  /** 引擎在各 item 上的默认盒，必须在写入任何 override 之前整体快照（保留原类型） */
  readonly engine: Map<string, StyleBox>;
  /** 本库当前建出了 override 的 item */
  readonly built: Set<string>;
  readonly stateItems: string[];
}

const boxModels = new WeakMap<object, BoxModel>();

/**
 * 取（必要时建）节点的盒模型。引擎默认盒必须在这里**一次性整体快照**：一旦本库写入了
 * override，`get_theme_stylebox` 就会先返回我们自己的副本，届时再取就取不到引擎的值了。
 */
function boxModelOf(node: GodotControl): BoxModel | null {
  const key = node as unknown as object;
  const existing = boxModels.get(key);
  if (existing) return existing;

  const cls = node.get_class();
  const baseItem = pickBackgroundStylebox(cls);
  if (!baseItem) return null; // 该类不绘制任何 stylebox，properties.ts 已先告警
  const stateItems = stateItemsOf(cls, baseItem);

  const engine = new Map<string, StyleBox>();
  for (const item of [baseItem, ...stateItems]) {
    if (engine.has(item)) continue;
    const src = node.has_theme_stylebox(item) ? node.get_theme_stylebox(item) : null;
    engine.set(item, seedBoxFor(node, cls, item, src));
  }

  const model: BoxModel = { baseItem, base: new Map(), states: new Map(), engine, built: new Set(), stateItems };
  boxModels.set(key, model);
  return model;
}

/**
 * 按字段来源重建盒。`items` 省略 = 基盒 + 全部状态盒（基规则的字段变了，状态盒必须跟着变）。
 *
 * 基规则没声明任何 stylebox 字段、该状态也没声明 → **不建盒**，引擎默认画法完全保留。
 */
/** 底色与纹理均占据「该位置绘制何种内容」这一个位置，同时出现时仅能保留其一 */
const FILL_FIELDS = new Set(["bg_color", "texture"]);

/**
 * 把多份「CSS 属性名 → 字段」按写入顺序合成一份。
 *
 * 底色与纹理互斥：Godot 的一个 StyleBox 只能绘制其中一种（StyleBoxFlat 无 texture，
 * StyleBoxTexture 无 bg_color），而 CSS 允许两者同时声明。本库不叠加，也不代为推断，
 * 按层叠顺序取最后一条（与 `width:1px;width:2px` 同口径），前面几条的填充字段直接丢弃。
 * 其余字段（圆角 / 边框 / padding）不受影响，仍由后写者胜出。
 */
function mergeFields(bags: readonly (Map<string, FieldMap> | undefined)[]): FieldMap {
  const entries: FieldMap[] = [];
  for (const bag of bags) if (bag) for (const fields of bag.values()) entries.push(fields);

  let winner = -1;
  entries.forEach((fields, index) => {
    for (const key of fields.keys()) {
      if (FILL_FIELDS.has(key)) winner = index;
    }
  });

  const merged: FieldMap = new Map();
  entries.forEach((fields, index) => {
    for (const [key, value] of fields) {
      if (FILL_FIELDS.has(key) && index !== winner) continue;
      merged.set(key, value);
    }
  });
  return merged;
}

function rebuildBoxes(node: GodotControl, model: BoxModel, items?: readonly string[]): void {
  const targets = items ?? [model.baseItem, ...model.stateItems];
  for (const item of targets) {
    const stateBag = model.states.get(item);
    if (model.base.size === 0 && !stateBag) {
      if (model.built.delete(item)) node.remove_theme_stylebox_override(item);
      continue;
    }
    const fields = mergeFields([model.base, stateBag]);
    const engine = model.engine.get(item) ?? null;
    // 胜出的是纹理就得更换盒类：StyleBoxFlat 无 texture 属性，写入亦为静默无效
    const box = fields.has("texture")
      ? textureBoxFor(engine)
      : (engine ?? new StyleBoxFlat()).duplicate() as StyleBox;
    applyBoxFields(box, fields);
    node.add_theme_stylebox_override(item, box);
    model.built.add(item);
  }
}

/** 同名字段后写者赢：每次写入都把该 CSS 属性挪到末尾，保持与写入顺序一致的级联顺序 */
function putFields(bag: Map<string, FieldMap>, cssName: string, fields: FieldMap): void {
  bag.delete(cssName);
  bag.set(cssName, fields);
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

/**
 * 一条 stylebox 类声明的落地。
 *
 * `isBase` = 该声明所在的选择器**不要求任何状态**（基规则 / 内联）。只有基规则的字段才
 * 需要同步到其它状态的盒；状态规则只写它自己那个盒。
 */
function writeStyleBox(
  cssName: string,
  isBase: boolean,
  stateTag: string,
  node: GodotControl,
  item: string,
  apply: (box: StyleBoxHandle) => void,
): void {
  const model = boxModelOf(node);
  if (!model) return; // 该类没有任何可当底色的 stylebox（properties.ts 已告警）

  const write = new StyleBoxWrite();
  apply(write);
  // 纹理在写入前即校验一次：加载失败则该条声明根本无落点，不能先将其记入模型
  // 再于重建时静默丢弃——那将遗留一个不绘制任何内容的盒，还会将其计入「本库创建过的盒」
  const wanted = write.fields.get("texture");
  if (wanted !== undefined && !loadTexture(String(wanted))) {
    if (ngDevMode) warnOnce(`css:texture:${wanted}`, `纹理资源加载不到：${wanted}（background-image 已忽略）`);
    write.fields.delete("texture");
  }
  if (write.fields.size === 0) return;

  const onBase = isBase && item === model.baseItem;
  if (onBase) putFields(model.base, cssName, write.fields);
  else {
    let bag = model.states.get(item);
    if (!bag) {
      bag = new Map();
      model.states.set(item, bag);
    }
    putFields(bag, cssName, write.fields);
  }

  // 基盒的字段变了，所有状态盒都得跟着重建，否则状态盒停在旧几何上（主题切换、@media 命中
  // 变化、基规则被改写都走这里）。
  rebuildBoxes(node, model, onBase ? undefined : [item]);

  // 槽位必须带上状态标记：`.card` 与 `.card:hover` 在 PanelContainer 这类只有一个盒的控件上
  // 会落同一个 item，不带标记就是同一个槽位 → record 去重后只记下一条 undo，
  // 退出状态时只能撑掉其中一条贡献，另一条永久残留。
  const slot = `stylebox:${item}${stateTag ? `@${stateTag}` : ""}`;
  record(node, cssName, slot, () => {
    if (onBase) model.base.delete(cssName);
    else {
      const bag = model.states.get(item);
      bag?.delete(cssName);
      if (bag && bag.size === 0) model.states.delete(item);
    }
    // 撤销同样是「按剩余声明重建」，不是 remove_theme_stylebox_override 整个盒：
    // 整个盒一删，同盒里别的 CSS 属性写的字段会一起消失，而那些属性的值没变、不会被重写。
    rebuildBoxes(node, model, onBase ? undefined : [item]);
  });
}

function writeColorOverride(cssName: string, node: GodotControl, item: string, color: ColorLike): void {
  node.add_theme_color_override(item, toColor(color));
  record(node, cssName, `color:${item}`, () => node.remove_theme_color_override(item));
}

function writeFontSizeOverride(cssName: string, node: GodotControl, item: string, size: number): void {
  node.add_theme_font_size_override(item, Math.round(size));
  record(node, cssName, `font_size:${item}`, () => node.remove_theme_font_size_override(item));
}

/**
 * 纹理资源缓存（口径与 `loadFont` 一致：加载失败同样记录，不逐节点重复尝试）。
 */
const textureCache = new Map<string, Texture2D | null>();

function loadTexture(path: string): Texture2D | null {
  const hit = textureCache.get(path);
  if (hit !== undefined) return hit;
  let texture: Texture2D | null = null;
  if (ResourceLoader.exists(path)) {
    const resource = ResourceLoader.load(path);
    if (resource instanceof Texture2D) texture = resource;
  }
  textureCache.set(path, texture);
  return texture;
}

/**
 * 纹理盒：若引擎原有的盒本就是 StyleBoxTexture，则保留其取景参数（region_rect /
 * axis_stretch 等）；否则新建一个并将 content_margin 一并迁移（布局留白不可丢失）。
 */
function textureBoxFor(src: StyleBox | null): StyleBox {
  if (src instanceof StyleBoxTexture) return src.duplicate() as StyleBox;
  const box = new StyleBoxTexture();
  if (src) {
    box.content_margin_top = src.content_margin_top;
    box.content_margin_right = src.content_margin_right;
    box.content_margin_bottom = src.content_margin_bottom;
    box.content_margin_left = src.content_margin_left;
  }
  return box;
}

function writeConstantOverride(cssName: string, node: GodotControl, item: string, value: number): void {
  node.add_theme_constant_override(item, Math.round(value));
  record(node, cssName, `constant:${item}`, () => node.remove_theme_constant_override(item));
}

/**
 * 字体资源缓存：路径 → Font（加载失败记 null，不重复尝试）。
 *
 * 自行缓存的原因：`font-family` 属于高频声明（一个界面中数十个节点使用同一字体），而
 * `ResourceLoader.load` 每次均需执行一遍路径解析与资源查找。加载失败同样记录，是因为
 * 路径书写错误时每个节点都会再次尝试，不加记录则每个节点都会输出一条引擎错误。
 */
const fontCache = new Map<string, Font | null>();

function loadFont(path: string): Font | null {
  const hit = fontCache.get(path);
  if (hit !== undefined) return hit;
  let font: Font | null = null;
  // 先过一道 exists：load 找不到文件时引擎自身会向控制台输出错误，而这条路径本库
  // 已需输出告警（font-family 的告警），不应再追加一份重复的引擎报错
  if (ResourceLoader.exists(path)) {
    const resource = ResourceLoader.load(path);
    if (resource instanceof Font) font = resource;
  }
  fontCache.set(path, font);
  return font;
}

/**
 * 系统字体实例缓存（key = 候选名拼接）。
 *
 * 必须复用：`font-family` 会在每次重排 / 重算时重新落点，若每次均 `new SystemFont()`，
 * 相当于为同一节点更换新的资源对象，既浪费资源，也会使“同一个字体”在引擎眼中成为两个。
 */
const systemFontCache = new Map<string, SystemFont>();

function systemFontFor(names: readonly string[]): SystemFont {
  const key = names.join("\u0000");
  const hit = systemFontCache.get(key);
  if (hit) return hit;
  const font = new SystemFont();
  font.font_names = [...names];
  systemFontCache.set(key, font);
  return font;
}

function writeFontOverride(
  cssName: string,
  node: GodotControl,
  item: string,
  source: FontSource,
): boolean {
  // path 分支加载失败时需返回报错；systemFontNames 分支由引擎兜底，恒返回成功
  const font = "path" in source ? loadFont(source.path) : systemFontFor(source.systemFontNames);
  if (!font) return false;
  node.add_theme_font_override(item, font);
  record(node, cssName, `font:${item}`, () => node.remove_theme_font_override(item));
  return true;
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
  setFontOverride: () => needsScope("setFontOverride"),
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
    resolveFont?: (family: string) => string | null,
  ): boolean {
    return applyCssProperty(
      node,
      cssName,
      raw,
      {
        backend: scopeOf(cssName, states),
        // 本包仅输出「落点相关」的告警，未标等级的按忽略级处理
        warn: (key, message, level) => warnOnce(`css:${key}`, message, level ?? "ignore"),
        states,
        resolveFont,
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

/** 门面缓存键：同一属性名在不同状态下要落不同的盒，所以状态集也必须进键 */
function scopeKey(cssName: string, states: ReadonlySet<string>): string {
  return states.size === 0 ? cssName : `${cssName}\u0000${[...states].sort().join(",")}`;
}

function scopeOf(cssName: string, states: ReadonlySet<string>): StyleBackend {
  const key = scopeKey(cssName, states);
  let scope = scopes.get(key);
  if (scope) return scope;
  // 选择器不要求任何状态 = 基规则，它的 stylebox 字段必须同步到该类的所有状态盒
  const isBase = states.size === 0;
  const stateTag = isBase ? "" : [...states].sort().join(",");
  scope = Object.assign(Object.create(backend) as StyleBackend, {
    mutateStyleBox: (node: CssNode, item: string, apply: (box: StyleBoxHandle) => void) =>
      writeStyleBox(cssName, isBase, stateTag, asGodotControl(node), item, apply),
    setColorOverride: (node: CssNode, item: string, color: ColorLike) =>
      writeColorOverride(cssName, asGodotControl(node), item, color),
    setFontSizeOverride: (node: CssNode, item: string, size: number) =>
      writeFontSizeOverride(cssName, asGodotControl(node), item, size),
    setConstantOverride: (node: CssNode, item: string, value: number) =>
      writeConstantOverride(cssName, asGodotControl(node), item, value),
    setFontOverride: (node: CssNode, item: string, source: FontSource) =>
      writeFontOverride(cssName, asGodotControl(node), item, source),
    setMinimumSize: (node: CssNode, width: number | null, height: number | null) =>
      writeMinimumSize(cssName, asGodotControl(node), width, height),
    setOpacity: (node: CssNode, alpha: number) => writeOpacity(cssName, asGodotControl(node), alpha),
    setNodeNumber: (node: CssNode, prop: string, value: number) =>
      writeNodeNumber(cssName, asGodotControl(node), prop, value),
    setNodeBoolean: (node: CssNode, prop: string, value: boolean) =>
      writeNodeBoolean(cssName, asGodotControl(node), prop, value),
  });
  if (scopes.size < MAX_SCOPES) scopes.set(key, scope);
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
    if (ngDevMode) warnOnce(
      `css:unknown:${cssName}`,
      `样式 "${cssName}" 无 Godot 对应，已忽略（布局请使用容器 + sizeFlags，外观请使用 Theme）`,
    );
  }
  // 解析期的告警只会是「值被丢弃」，统一按忽略型输出
  if (ngDevMode) for (const message of warnings) warnOnce(`css:value:${cssName}:${message}`, message, "ignore");
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
