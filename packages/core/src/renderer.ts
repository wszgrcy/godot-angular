/**
 * GodotRenderer —— 把 Angular 的 Renderer2 落到真实 Godot 节点。
 *
 * 每个 element / text / comment 都是**真实 Godot 节点**，不需要虚拟树代理：
 *   element → Control 子类实例
 *   text    → Label（Godot 没有文本节点）
 *   comment → 非 Control 的 Node —— 实测 Container 布局会跳过非 Control 子节点，
 *             正好当 @if / @for 的锚点，不占排布空间
 *
 * 事件必须经 Callable.create(node, fn) 包装：实测 signal.connect(jsFunction)
 * 直接失败（"Expected: Callable. Found: function"），且 owner 必须是 Godot 对象。
 */
import { Renderer2, RendererFactory2, RendererType2, inject } from "@angular/core";
import { getGodotHost } from "./godot-host";
import { nodeHasProperty, resolveSignalName, resolveTag, toSnakeCase } from "./registry";
import { GODOT_ROOT } from "./tokens";

/** 值为 {x,y}/[x,y] 时需构造 Vector2 的属性 */
const VECTOR_PROPS = new Set([
  "position",
  "size",
  "custom_minimum_size",
  "pivot_offset",
  "scale",
  "grow_amount",
]);
/** 值为字符串 / {r,g,b,a} 时需构造 Color 的属性 */
const COLOR_PROPS = new Set(["modulate", "self_modulate", "default_color", "color", "font_color"]);

const warnedProps = new Set<string>();
const warnedEvents = new Set<string>();
const warnedStyles = new Set<string>();

function isPlainVector(value: any): boolean {
  if (Array.isArray(value) && value.length === 2) return true;
  return (
    !!value &&
    typeof value === "object" &&
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    typeof value.get_class !== "function"
  );
}

function isPlainColor(value: any): boolean {
  if (typeof value === "string") return true;
  return (
    !!value &&
    typeof value === "object" &&
    typeof value.r === "number" &&
    typeof value.g === "number" &&
    typeof value.b === "number" &&
    typeof value.get_class !== "function"
  );
}

function toVector(value: any): any {
  const { Vector2 } = getGodotHost();
  return Array.isArray(value) ? new Vector2(value[0], value[1]) : new Vector2(value.x, value.y);
}

function toColor(value: any): any {
  const { Color } = getGodotHost();
  return typeof value === "string" ? new Color(value) : new Color(value.r, value.g, value.b, value.a ?? 1);
}

function num(value: any): number {
  if (typeof value === "number") return value;
  const parsed = parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

export class GodotRenderer implements Renderer2 {
  data: Record<string, any> = {};

  /** 根组件宿主元素只挂一次 */
  private hostAttached = false;

  constructor(private readonly root: any) {}

  // ------------------------------------------------------------------ 创建

  createElement(tagName: string): any {
    const host = getGodotHost();
    const className = resolveTag(tagName);
    // 认不出来的标签（自定义组件宿主 <ui-card>、<div> 等）降级为 VBoxContainer 而不是 Control：
    // 裸 Control 不会抱紧子节点（实测尺寸 248x0），包装层直接塌掉；
    // VBoxContainer 会自适应子节点尺寸，语义上也最接近 CSS 块级流。
    const node = new host.ns[className ?? "VBoxContainer"]();
    if (!className && /^[A-Z]/.test(tagName)) {
      // 大写开头说明作者本意是某个 Godot 类，值得提醒；小写（div / ui-card）静默降级
      this.warn(
        warnedProps,
        `tag:${tagName}`,
        `<${tagName}> 不是可用的 Godot Control，已降级为 VBoxContainer（可用类清单见 usableControlClasses()）`,
      );
    }
    node.name = tagName;
    if (!this.hostAttached) {
      this.hostAttached = true;
      this.root.add_child(node);
    }
    return node;
  }

  createText(value: string): any {
    const node = new (getGodotHost().ns.Label)();
    node.name = "text";
    node.text = value ?? "";
    return node;
  }

  createComment(value: string): any {
    const node = new (getGodotHost().ns.Node)();
    node.name = "anchor";
    return node;
  }

  /** 根组件的宿主就是入口给的 Control */
  selectRootElement(): any {
    this.hostAttached = true;
    return this.root;
  }

  // ------------------------------------------------------------------ 结构

  appendChild(parent: any, newChild: any): void {
    if (!parent || !newChild) return;
    // 实测：对已挂父节点的子节点再 add_child，引擎只打错误不抛异常，必须自己先摘
    const oldParent = newChild.get_parent();
    if (oldParent) oldParent.remove_child(newChild);
    parent.add_child(newChild);
  }

  insertBefore(parent: any, newChild: any, refChild: any): void {
    if (!parent || !newChild) return;
    if (newChild.get_parent() !== parent) {
      const oldParent = newChild.get_parent();
      if (oldParent) oldParent.remove_child(newChild);
      parent.add_child(newChild);
    }
    if (refChild && refChild.get_parent() === parent) {
      const index = refChild.get_index();
      if (newChild.get_index() !== index) parent.move_child(newChild, index);
    }
  }

  removeChild(_parent: any, child: any): void {
    if (!child) return;
    const parent = child.get_parent();
    if (parent) parent.remove_child(child);
  }

  destroyNode(node: any): void {
    if (!node || typeof node.get_instance_id !== "function") return;
    const parent = node.get_parent();
    if (parent) parent.remove_child(node);
    node.queue_free();
  }

  parentNode(node: any): any {
    return node?.get_parent() ?? null;
  }

  nextSibling(node: any): any {
    const parent = node?.get_parent();
    if (!parent) return null;
    const index = node.get_index();
    return index + 1 < parent.get_child_count() ? parent.get_child(index + 1) : null;
  }

  // ------------------------------------------------------------------ 属性

  setProperty(target: any, name: string, value: any): void {
    if (!target || typeof target !== "object") return;
    const prop = toSnakeCase(name);

    if (VECTOR_PROPS.has(prop) && isPlainVector(value)) {
      target[prop] = toVector(value);
      return;
    }
    if (COLOR_PROPS.has(prop) && isPlainColor(value)) {
      target[prop] = toColor(value);
      return;
    }
    // sizeFlags 是 Godot 一对属性的合写糖
    if (prop === "size_flags" && typeof value === "number") {
      target.size_flags_horizontal = value;
      target.size_flags_vertical = value;
      return;
    }
    if (prop === "anchors_preset" && typeof target.set_anchors_preset === "function") {
      target.set_anchors_preset(value);
      return;
    }
    if (!nodeHasProperty(target, prop)) {
      this.warn(warnedProps, `${target.get_class()}.${prop}`, `${target.get_class()}.${prop} 不是真实属性，赋值已忽略`);
      return;
    }
    target[prop] = value;
  }

  setAttribute(target: any, name: string, value: any): void {
    if (name.startsWith("ng-") || name.startsWith("_ng")) return;
    this.setProperty(target, name, value);
  }

  removeAttribute(target: any, name: string): void {
    const prop = toSnakeCase(name);
    if (nodeHasProperty(target, prop)) target[prop] = null;
  }

  setValue(node: any, value: string): void {
    if (node && nodeHasProperty(node, "text")) node.text = value ?? "";
  }

  // ------------------------------------------------------------------ 样式
  // 不做 CSS 级联：Godot 的对应物是 Theme + 节点属性。只支持有真实对应的少数键。

  setStyle(el: any, style: string, value: any): void {
    if (!el) return;
    const { Vector2 } = getGodotHost();
    // Angular 的 [style.font-size] 传的是 CSS 名（kebab-case），先归一成 camelCase
    const key = style.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
    switch (key) {
      case "width":
      case "minWidth":
        el.custom_minimum_size = new Vector2(num(value), el.custom_minimum_size.y);
        return;
      case "height":
      case "minHeight":
        el.custom_minimum_size = new Vector2(el.custom_minimum_size.x, num(value));
        return;
      case "opacity": {
        const m = el.modulate;
        el.modulate = new (getGodotHost().Color)(m.r, m.g, m.b, num(value));
        return;
      }
      case "color":
        el.add_theme_color_override?.("font_color", toColor(value));
        return;
      case "fontSize":
        el.add_theme_font_size_override?.("font_size", num(value));
        return;
      default:
        this.warn(warnedStyles, key, `样式 "${key}" 无 Godot 对应，已忽略（布局用容器+sizeFlags，外观用 Theme）`);
    }
  }

  removeStyle(el: any, style: string): void {
    const key = style.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
    if (key === "color") el?.remove_theme_color_override?.("font_color");
    else if (key === "fontSize") el?.remove_theme_font_size_override?.("font_size");
    else if (key === "width" || key === "minWidth" || key === "height" || key === "minHeight") {
      el.custom_minimum_size = new (getGodotHost().Vector2)(0, 0);
    }
  }

  addClass(_el: any, name: string): void {
    this.warn(warnedStyles, `class:${name}`, `class "${name}" 被忽略：Godot 用 Theme，不用 CSS 类`);
  }

  removeClass(): void {}

  // ------------------------------------------------------------------ 事件

  listen(target: any, eventName: string, callback: (event: any) => any): () => void {
    const signalName = resolveSignalName(target, eventName);
    if (!signalName) {
      const cls = typeof target?.get_class === "function" ? target.get_class() : String(target);
      this.warn(warnedEvents, `${cls}:${eventName}`, `${cls} 上没有 (${eventName}) 对应的 Godot 信号`);
      return () => {};
    }
    const { Callable } = getGodotHost();
    const callable = Callable.create(target, callback);
    const signal = target[signalName];
    signal.connect(callable);
    return () => {
      try {
        signal.disconnect(callable);
      } catch {
        /* 节点已释放 */
      }
    };
  }

  destroy(): void {}

  /** 同类问题只告警一次，避免每帧刷屏 */
  private warn(bucket: Set<string>, key: string, message: string): void {
    if (bucket.has(key)) return;
    bucket.add(key);
    console.warn(`[control-ui-js] ${message}`);
  }
}

export class GodotRendererFactory implements RendererFactory2 {
  private readonly renderer: GodotRenderer;

  constructor() {
    this.renderer = new GodotRenderer(inject(GODOT_ROOT));
  }

  createRenderer(_hostElement: any, _type: RendererType2 | null): Renderer2 {
    return this.renderer;
  }

  end(): void {}
}
