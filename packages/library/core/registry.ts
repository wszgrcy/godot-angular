import { ClassDB } from "godot";
import type { Label, Node } from "godot";

/**
 * 常见 HTML 标签 → Godot 类。
 * 目的是降低从 HTML 迁移时的书写成本：<div> 应映射为透明 Control，而不是渲染失败。
 */
export const HTML_TAG_ALIASES: Readonly<Record<string, string>> = {
  // div 映射到 VBoxContainer：CSS 的块级流就是“子节点竖向排列”，裸 Control 不会自适应子节点尺寸，布局会塌缩
  div: "VBoxContainer",
  section: "VBoxContainer",
  main: "VBoxContainer",
  header: "HBoxContainer",
  footer: "HBoxContainer",
  nav: "HBoxContainer",
  form: "VBoxContainer",
  p: "Label",
  span: "Label",
  label: "Label",
  h1: "Label",
  h2: "Label",
  h3: "Label",
  h4: "Label",
  hr: "Separator",
  ul: "VBoxContainer",
  ol: "VBoxContainer",
  li: "HBoxContainer",
  button: "Button",
  input: "LineEdit",
  textarea: "TextEdit",
  select: "OptionButton",
  progress: "ProgressBar",
  img: "TextureRect",
  a: "LinkButton",
  table: "GridContainer",
};

const controlCache = new Map<string, boolean>();

export function isControlClass(className: string): boolean {
  const cached = controlCache.get(className);
  if (cached !== undefined) return cached;
  const hit =
    className === "Control" ||
    (className !== "Object" && ClassDB.is_parent_class(className, "Control"));
  controlCache.set(className, hit);
  return hit;
}

/**
 * 模板标签 → Godot 类名：别名表命中就完全以表为准（表里的键都是 HTML 标签，不会与 Godot
 * 类名撞车），否则原样返回。不做任何大小写变形，也不校验类是否存在——能不能用由创建
 * 节点的那一刻决定（见 renderer.createElement）。
 */
export function resolveTag(tag: string): string {
  return HTML_TAG_ALIASES[tag] ?? tag;
}

const EVENT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  click: ["pressed", "button_up", "item_selected", "text_selected"],
  // 数组顺序即优先级：取第一个“该控件确实拥有”的信号。OptionButton 继承 Button，
  // 同时拥有 toggled 与 item_selected；toggled 排在前面时 (change) 会静默
  // 绑到 toggled，下拉选择不会触发。
  change: ["text_changed", "value_changed", "item_selected", "toggled"],
  // DOM 的 (input) 含义是“文本发生变化”，而不是鼠标输入；LineEdit 上必须优先 text_changed，
  // 否则会被 Control.gui_input 抢走（信号接上了但回调永不触发）。
  input: ["text_changed", "text_submitted", "gui_input"],
  submit: ["text_submitted", "activated"],
  focus: ["focus_entered"],
  blur: ["focus_exited"],
};

/**
 * 将模板中的 (eventName) 解析为该节点上真实存在的 Godot 信号名，先命中先返回：
 *   1. DOM 习惯名（click / change / input / submit / focus / blur）查别名表，取该控件确实拥有的第一个
 *   2. 其余原样当 Godot 信号名查：pressed / text_changed / gui_input
 * 事件名不做任何变形（大小写、后缀均不转换）：模板里要么写引擎的真实信号名，要么写 DOM 事件名。
 * `[(xxx)]` 双向绑定不经过这里：它对应 Angular 组件声明的 `@Output() xxxChange`，
 * Godot 节点没有 output，因此这类名字在此处解析不到。
 * 找不到时返回 null，静默还是报错由调用方决定。
 */
export function resolveSignalName(node: Node, eventName: string): string | null {
  const className: string = node.get_class();

  for (const candidate of EVENT_ALIASES[eventName] ?? []) {
    if (ClassDB.class_has_signal(className, candidate)) return candidate;
  }
  return ClassDB.class_has_signal(className, eventName) ? eventName : null;
}

const propertySetCache = new Map<string, Set<string>>();

/** 沿继承链收集一个类的全部属性名（ClassDB 的 includeInherited 在 GodotJS 里无效） */
function collectProperties(className: string): Set<string> {
  const cached = propertySetCache.get(className);
  if (cached) return cached;

  const out = new Set<string>();
  let cls: string | null = className;
  const seen = new Set<string>();
  while (cls && cls !== "Object" && !seen.has(cls)) {
    seen.add(cls);
    try {
      for (const entry of ClassDB.class_get_property_list(cls, false)) {
        out.add(String(entry.get("name")));
      }
    } catch {
      /* 某些内建类拿不到列表，跳过 */
    }
    cls = ClassDB.get_parent_class(cls) ?? null;
  }
  propertySetCache.set(className, out);
  return out;
}

/**
 * 属性是否真实存在（含继承）。
 * 保留这项检查的原因：GodotJS 对不存在的属性赋值静默接受（写入一个 JS 键，读回来仍是
 * 那个值），拼错的绑定看似生效实则无效，难以定位。
 */
export function nodeHasProperty(node: Node, prop: string): node is Label {
  return collectProperties(node.get_class()).has(prop);
}

const propertyTypeCache = new Map<string, Map<string, number>>();

/** Godot Variant 类型常量（Variant::Type 中本库使用到的那几个） */
export const GODOT_TYPE = { NIL: 0, BOOL: 1, INT: 2, FLOAT: 3, STRING: 4 } as const;

/** 沿继承链收集 属性名 → Variant 类型 */
function collectPropertyTypes(className: string): Map<string, number> {
  const cached = propertyTypeCache.get(className);
  if (cached) return cached;

  const out = new Map<string, number>();
  let cls: string | null = className;
  while (cls) {
    try {
      for (const entry of ClassDB.class_get_property_list(cls, false)) {
        const name = String(entry.get("name"));
        if (!out.has(name)) out.set(name, Number(entry.get("type")));
      }
    } catch {
      /* 某些内建类拿不到列表 */
    }
    cls = ClassDB.get_parent_class(cls) ?? null;
  }
  propertyTypeCache.set(className, out);
  return out;
}

/** 取得属性的 Variant 类型（未知时返回 undefined） */
export function propertyVariantType(node: Node, prop: string): number | undefined {
  return collectPropertyTypes(node.get_class()).get(prop);
}

/**
 * 按 ClassDB 声明的类型转换一下值。模板中的静态属性永远是字符串，而 Godot 属性是强类型的：
 * `<HSlider min_value="0">` 会直接报 Unable to convert JS string to Godot float。
 * 无法转换时原样交出，交由引擎的报错说明问题。
 */
export function coerceToProperty(node: Node, prop: string, value: unknown): unknown {
  if (value == null) return value;
  const type = collectPropertyTypes(node.get_class()).get(prop);
  if (type == null) return value;

  if (typeof value === "string") {
    if (type === GODOT_TYPE.FLOAT || type === GODOT_TYPE.INT) {
      const n = Number(value.trim());
      return Number.isFinite(n) ? n : value;
    }
    if (type === GODOT_TYPE.BOOL) {
      if (value === "true" || value === "1") return true;
      if (value === "false" || value === "0" || value === "") return false;
      return value;
    }
    return value;
  }

  if (type === GODOT_TYPE.STRING && (typeof value === "number" || typeof value === "boolean")) {
    return String(value);
  }
  if ((type === GODOT_TYPE.FLOAT || type === GODOT_TYPE.INT) && typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return value;
}
