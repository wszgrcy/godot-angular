/**
 * 标签 → Godot 类 解析。
 *
 * 不维护 Godot 类白名单：**凡继承 Control 且可实例化的类都可用**。
 * 清单由 ClassDB 现场给（实测 get_inheriters_from_class / is_parent_class /
 * can_instantiate / class_has_signal / class_get_property_list 在 GodotJS 里都可用），
 * 手写清单只会随引擎版本腐烂。
 *
 * ⚠️ GodotJS 的 ClassDB 与 GDScript 的 ClassDB 不同名也不同签名，已实测：
 *   - 没有 class_has_property，只有 class_get_property_list
 *   - class_get_property_list(cls, true) 的 includeInherited 被忽略，得自己走继承链
 *   - 返回的是 Godot Array 包装：不是 JS 数组（无 length/map），但可 for...of；
 *     元素是 Dictionary，`.name` 拿不到，必须用 `.get("name")`
 */
import { getGodotHost, godotClass } from "./godot-host";

/**
 * 常见 HTML 标签 → Godot 类。
 * 不是"支持 HTML"，只是降低肌肉记忆摩擦：<div> 该变成透明 Control 而不是渲染失败。
 */
export const HTML_TAG_ALIASES: Readonly<Record<string, string>> = {
  // div 映射到 VBoxContainer：CSS 块级流就是“子节点竖着排”，裸 Control 不抱紧子节点、会塔
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
const tagCache = new Map<string, string | null>();

export function isControlClass(className: string): boolean {
  const cached = controlCache.get(className);
  if (cached !== undefined) return cached;
  const hit =
    className === "Control" ||
    (className !== "Object" && getGodotHost().ClassDB.is_parent_class(className, "Control"));
  controlCache.set(className, hit);
  return hit;
}

/** 引擎内全部可实例化的 Control 子类（诊断 / 代码生成用） */
export function usableControlClasses(): string[] {
  const ClassDB = getGodotHost().ClassDB;
  const all = ["Control", ...(ClassDB.get_inheriters_from_class("Control") ?? [])];
  return Array.from(new Set<string>(all)).filter((name) => ClassDB.can_instantiate(name));
}

/** 模板标签 → Godot 类名；解析不到返回 null */
export function resolveTag(tag: string): string | null {
  const cached = tagCache.get(tag);
  if (cached !== undefined) return cached;

  const ClassDB = getGodotHost().ClassDB;
  const candidates = [tag, tag.charAt(0).toUpperCase() + tag.slice(1)];
  const alias = HTML_TAG_ALIASES[tag.toLowerCase()];
  if (alias) candidates.push(alias);

  let resolved: string | null = null;
  for (const candidate of candidates) {
    if (!ClassDB.class_exists(candidate) || !isControlClass(candidate)) continue;
    if (godotClass(candidate) === undefined) continue;
    resolved = candidate;
    break;
  }
  tagCache.set(tag, resolved);
  return resolved;
}

const snakeCache = new Map<string, string>();

/** camelCase → snake_case（Godot 属性名），带缓存 */
export function toSnakeCase(name: string): string {
  let out = snakeCache.get(name);
  if (out === undefined) {
    out = name
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
      .toLowerCase();
    snakeCache.set(name, out);
  }
  return out;
}

/**
 * 模板里的 (eventName) → 该节点上真实存在的 Godot 信号名。
 * 先查别名表，再按 snake_case 直接找。找不到返回 null 由调用方告警。
 */
const EVENT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  click: ["pressed", "button_up", "item_selected", "text_selected"],
  change: ["text_changed", "value_changed", "toggled", "item_selected"],
  // DOM 的 (input) 是“文本变了”，不是鼠标输入；LineEdit 上必须优先 text_changed，
  // 否则会被 Control.gui_input 抢走（实测踩过：信号接上了但回调永远不触发）。
  input: ["text_changed", "text_submitted", "gui_input"],
  submit: ["text_submitted", "activated"],
  focus: ["focus_entered"],
  blur: ["focus_exited"],
};

export function resolveSignalName(node: any, eventName: string): string | null {
  if (typeof node?.get_class !== "function") return null;
  const className: string = node.get_class();
  const ClassDB = getGodotHost().ClassDB;

  const candidates = EVENT_ALIASES[eventName.toLowerCase()] ?? [];
  for (const candidate of candidates) {
    if (ClassDB.class_has_signal(className, candidate)) return candidate;
  }
  const direct = toSnakeCase(eventName);
  return ClassDB.class_has_signal(className, direct) ? direct : null;
}

const propertySetCache = new Map<string, Set<string>>();

/** 沿继承链收集一个类的全部属性名（ClassDB 的 includeInherited 在 GodotJS 里无效） */
function collectProperties(className: string): Set<string> {
  const cached = propertySetCache.get(className);
  if (cached) return cached;

  const ClassDB = getGodotHost().ClassDB;
  const out = new Set<string>();
  let cls: string | null = className;
  const seen = new Set<string>();
  while (cls && cls !== "Object" && !seen.has(cls)) {
    seen.add(cls);
    try {
      for (const entry of ClassDB.class_get_property_list(cls, false) as Iterable<any>) {
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
 * 保留这个检查的原因：GodotJS 对不存在的属性赋值**静默接受**（实测写入一个 JS 键，
 * 读回来还是那个值），拼错的绑定会“看起来生效但毫无作用”，属于最难查的一类 bug。
 */
export function nodeHasProperty(node: any, prop: string): boolean {
  if (typeof node?.get_class !== "function") return false;
  return collectProperties(node.get_class()).has(prop);
}

/** 节点上真实存在的信号名列表（诊断用） */
export function nodeSignals(node: any): string[] {
  if (typeof node?.get_class !== "function") return [];
  const out: string[] = [];
  for (const entry of getGodotHost().ClassDB.class_get_signal_list(node.get_class()) as Iterable<any>) {
    out.push(String(entry.get("name")));
  }
  return out;
}
