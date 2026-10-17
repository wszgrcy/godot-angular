import {
  APP_ID,
  EnvironmentProviders,
  InjectionToken,
  makeEnvironmentProviders,
  Renderer2,
  RendererFactory2,
  RendererType2,
  inject,
} from "@angular/core";
import { ClassDB, Control, Label, Node, VBoxContainer } from "godot";
import type { TrackingClassSet } from "godot-angular/css";
import { PROPERTY_STATE_CLASSES } from "godot-angular/css";
import { godotClass } from "./godot-host";
import { warnOnce } from "./warn";
import { coerceToProperty, isControlClass, nodeHasProperty, resolveTag } from "./registry";
import { NOOP, tryConnectGodotSignal } from "./godot-events";
import { isGodotNode } from "./godot-node";
import {
  defaultStyleRuntime,
  ViewEncapsulationKind,
  type StyleRuntime,
} from "./css-runtime";
import { GODOT_ROOT, STYLE_RUNTIME } from "./tokens";

// ---------------------------------------------------------------------------
// 常量 → CSS_VAR_NAMESPACE token → provideCssVarNamespacing → shim* 三件套 → 工厂
// ---------------------------------------------------------------------------

const COMPONENT_REGEX = /%COMP%/g;

export const COMPONENT_VARIABLE = "%COMP%";
export const HOST_ATTR = `_nghost-${COMPONENT_VARIABLE}`;
export const CONTENT_ATTR = `_ngcontent-${COMPONENT_VARIABLE}`;

/**
 * CSS 变量命名空间前缀，由 `provideCssVarNamespacing()` 提供。
 * 同一个引擎进程可以运行多个应用，两个应用都定义 `--brand` 就会串扰，命名空间正是为了防止这种情况。
 */
export const CSS_VAR_NAMESPACE = new InjectionToken<string>("CSS_VAR_NAMESPACE");

/** 配置 CSS 变量命名空间。未传入时使用 APP_ID（本库默认 `"godot"`），末尾无条件拼接下划线。 */
export function provideCssVarNamespacing(namespace?: string): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: CSS_VAR_NAMESPACE,
      useFactory: (appId: string) => `${namespace ?? appId}_`,
      deps: [APP_ID],
    },
  ]);
}

export function shimContentAttribute(componentShortId: string): string {
  return CONTENT_ATTR.replace(COMPONENT_REGEX, componentShortId);
}

export function shimHostAttribute(componentShortId: string): string {
  return HOST_ATTR.replace(COMPONENT_REGEX, componentShortId);
}

export function shimStylesContent(compId: string, styles: string[]): string[] {
  return styles.map((s) => s.replace(COMPONENT_REGEX, compId));
}

/**
 * 归一化样式名：`[style.font-size]` 传入 CSS 名，`[style.fontSize]` 传入 camelCase，而注册表
 * 只识别 CSS 名。同时还原 `%NS%`（构建期已处理一道，此处作为兜底，避免插件被 viteConfig 替换时
 * 静默使用错误的名称）。
 */
function toCssName(style: string): string {
  return style.replace("--%NS%", "--").replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** `createRenderer` 递来的 ComponentDef 中本渲染器真正需要的几项（Angular 22 递的是 ComponentDef，不是 RendererType2） */
export interface ComponentDefLike {
  /** core 在 `ɵɵdefineComponent` 中计算得出，每个组件必有 */
  id: string;
  styles?: string[];
  encapsulation?: number;
}

/** 作用域标记（`_ngcontent-*` / `_nghost-*`）是纯 JS 键，引擎类上没有，只能按表写入。 */
function writeJsKey(node: Node, key: string): void {
  (node as unknown as Record<string, unknown>)[key] = "";
}

/**
 * 来源：无（由 css 包的 PROPERTY_STATE_CLASSES 推导）
 *
 * 哪些属性写入后需要标脏：它们驱动着 :checked / :disabled / :read-only 这几个伪类，
 * 而引擎不会为它们发任何信号。名单只有一份，就在级联那边，避免两边漂移。
 */
const STATE_PROPERTIES: ReadonlySet<string> = new Set(PROPERTY_STATE_CLASSES.map((entry) => entry.prop));

export class GodotRenderer implements Renderer2 {
  data: Record<string, unknown> = {};

  /** 本组件的 CSS（已把 %COMP% / %NS% 展开） */
  private readonly styles: string[] = [];
  /** 组件 id，用来生成作用域标记（真正决定作用域的是选择器里的 [_ngcontent-*]） */
  private readonly compId?: string;
  /** 作用域标记（无 compId 时不构造） */
  private readonly contentAttr?: string;
  private readonly hostAttr?: string;
  /** 级联是全局状态，同一组件类型只登记一次 */
  private stylesApplied = false;

  constructor(
    private readonly root: Node,
    private readonly runtime: StyleRuntime = defaultStyleRuntime(),
    component: ComponentDefLike | null = null,
    cssVarNamespace = "",
    compId?: string,
  ) {
    this.compId = compId;
    // compId 存在 = 作用域层，不存在 = 全局层；%COMP% 替换为 compId，%NS% 替换为命名空间
    const styles = component?.styles ?? [];
    const shimmed = compId ? shimStylesContent(compId, styles) : styles;
    this.styles = shimmed.map((s) => s.replace(/%NS%/g, cssVarNamespace));

    if (compId) {
      this.contentAttr = shimContentAttribute(compId);
      this.hostAttr = shimHostAttribute(compId);
    }
  }

  /**
   * 将本组件的 CSS 交给级联。级联是全局状态，重复登记就会重复构建索引，因此只在首次生效
   * （工厂按 compId 缓存 renderer，这个入口实际也只执行一次）。
   */
  applyStyles(): void {
    if (this.stylesApplied) return;
    this.stylesApplied = true;
    for (const css of this.styles) {
      this.runtime.addCss(css, { tier: this.compId ? 1 /* Local */ : 0 /* Application */ });
    }
  }

  /**
   * 将作用域标记写到宿主元素上并登记组件样式。不能走 `this.setAttribute`：它有意忽略
   * `_ng*` 属性，而作用域标记恰好就是 `_ngcontent-` / `_nghost-`，因此直接写入 JS 属性。
   */
  applyToHost(element: Node): void {
    this.applyStyles();
    if (this.hostAttr) writeJsKey(element, this.hostAttr);
  }

  /** 将节点纳入级联（未纳入的节点 class 变化不会重算样式），同时写入作用域标记 */
  private enroll(node: Node): void {
    // 先写入作用域标记再 attach：attach 会标脏并排一次重算，标记晚到就浪费一帧（中间态是错误的）
    if (this.contentAttr) writeJsKey(node, this.contentAttr);
    this.runtime.attach(node);
  }

  // ------------------------------------------------------------------ 创建

  createElement(tagName: string): Node {
    const className = resolveTag(tagName);
    // 按类名取构造函数。取不到、或取到的不是 Control（<Node>、<Color>）时降级为 VBoxContainer
    // 而不是 Control：裸 Control 不会跟随子节点调整尺寸（尺寸塌缩为 248x0），VBoxContainer 会
    // 自适应，语义上也最接近 CSS 块级流。
    let Ctor = godotClass(className);
    if (Ctor !== undefined && !isControlClass(className)) Ctor = undefined;
    if (Ctor === undefined) {
      // 大写开头说明作者本意是某个 Godot 类，值得提醒；小写（div / ui-card）静默降级
      if (/^[A-Z]/.test(tagName)) {
        if (ngDevMode) this.warn(
          `tag:${tagName}`,
          `<${tagName}> 不是可用的 Godot Control，已降级为 VBoxContainer`,
        );
      }
      Ctor = VBoxContainer;
    }
    const node = new Ctor();
    node.name = tagName;
    this.enroll(node);
    return node;
  }

  createText(value: string): Node {
    const node = new Label();
    node.name = "text";
    node.text = value
    return node;
  }

  createComment(value: string): Node {
    const node = new Node();
    node.name = "anchor";
    return node;
  }

  /** 根组件的宿主就是入口传入的 Control（已在工厂构造时纳入级联） */
  selectRootElement(): Node {
    return this.root;
  }

  // ------------------------------------------------------------------ 结构
  // 结构变化需要标脏（祖先变化后，后代可能命中不同的后代选择器）。只标受影响的子树，
  // 否则一个大模板创建完就是 O(n²)。removeChild 不标脏：剩下的兄弟组合器需要时由
  // 调用方 invalidateTree(父)。

  appendChild(parent: Node, newChild: Node): void {
    // 对已挂父节点的子节点再次 add_child，引擎只打错误不抛异常，必须自己先摘除
    const oldParent = newChild.get_parent();
    if (oldParent) oldParent.remove_child(newChild);
    parent.add_child(newChild);
    this.runtime.invalidateTree(newChild);
  }

  /**
   * 与 DOM 的 `insertBefore` 同语义：refChild 为空就是追加到末尾，有就插在它之前。
   *
   * Angular 递来的 newChild 一律处于未挂载状态（重排、ViewContainerRef.move 都是先 detach
   * 再 insert），因此先摘掉可能存在的旧父（引擎对重复 add_child 只打错误不抛异常），
   * 再入父。引擎没有 insert_at（`add_sibling` 要求目标无父且只能插在锚点之后），
   * add_child 只能追加到末尾，有参照时再 move_child 搬一次位——此时 newChild 已在末尾，
   * 参照的索引就是它该落的位置，无需修正。
   */
  insertBefore(parent: Node, newChild: Node, refChild: Node | null): void {
    const oldParent = newChild.get_parent();
    if (oldParent) oldParent.remove_child(newChild);

    const ref = refChild && refChild.get_parent() === parent ? refChild : null;
    parent.add_child(newChild);
    if (ref) parent.move_child(newChild, ref.get_index());

    this.runtime.invalidateTree(newChild);
  }

  removeChild(_parent: Node | null, child: Node): void {
    const parent = child.get_parent();
    if (parent) parent.remove_child(child);
  }

  destroyNode(node: Node): void {
    const parent = node.get_parent();
    if (parent) parent.remove_child(node);
    // 必须在 queue_free 前断开级联登记：`attachedNodes()` 与反向索引是强引用，不 detach
    // 相当于每个销毁过的节点被永久保留，反向索引里还会留着指向已 free 节点的键。
    // removeChild 不 detach：节点可能只是被移动，下一帧还要依靠原状态重算。
    this.runtime.detach(node);
    node.queue_free();
  }

  parentNode(node: Node): Node | null {
    return node.get_parent();
  }

  nextSibling(node: Node): Node | null {
    const parent = node.get_parent();
    if (!parent) return null;
    const index = node.get_index();
    return index + 1 < parent.get_child_count() ? parent.get_child(index + 1) : null;
  }

  // ------------------------------------------------------------------ 属性

  /**
   * 属性名逐字使用，不做任何变形：模板里写 `size_flags` 就是 `size_flags`，写 `sizeFlags`
   * 就是 `sizeFlags`（后者会被存在性检查拦下并告警）。与事件名同一套口径：
   * 名字与引擎里看到的一致，调用方无需额外记一张转换表。
   *
   * 值也原样写入：Vector2 / Color 这类结构体由调用方给出引擎对象（`new Vector2(0, 40)`），
   * 渲染器不推断哪些属性需要构造。写入前只拦两件事：null 在 Godot 里不是合法值，只能按
   * 撤销处理（见 revertProperty）；静态属性永远是字符串（`min_value="0"`），需按声明类型转换。
   */
  setProperty(target: Node, name: string, value: unknown): void {
    // 唯一一名多属性的写法：Godot 把横竖两个属性合写成 size_flags，就地展开，不传染给其他名字
    if (name === "size_flags") {
      this.writeProperty(target, "size_flags_horizontal", value);
      this.writeProperty(target, "size_flags_vertical", value);
      return;
    }
    this.writeProperty(target, name, value);
  }

  /**
   * 撤销一条写入：名字与 setProperty 认同一样（写进去有效的名字必须同样撤得回来），
   * 值则写回该类新建时的默认值。
   */
  removeAttribute(target: Node, name: string): void {
    if (name === "class") {
      this.setClasses(target, "");
      return;
    }
    if (name === "size_flags") {
      this.revertProperty(target, "size_flags_horizontal");
      this.revertProperty(target, "size_flags_vertical");
      return;
    }
    this.revertProperty(target, name);
  }

  /** 写一个属性。anchors_preset 在属性表里只读，直接赋值引擎只记 preset 不搬锚点，只能转方法 */
  private writeProperty(target: Node, prop: string, value: unknown): void {
    // null / undefined 在 DOM 里的意思是“这条不要了”，Godot 属性不吃 null（preset 也只吃 int）
    if (value == null) {
      this.revertProperty(target, prop);
      return;
    }
    // 渲染器创建的节点清一色是 Control 后代（createElement 只放行 Control），因此直接按 Control 用
    if (prop === "anchors_preset") {
      (target as Control).set_anchors_preset(value as Control.LayoutPreset);
      return;
    }
    if (!nodeHasProperty(target, prop)) {
      if (ngDevMode) this.warn(`${target.get_class()}.${prop}`, `${target.get_class()}.${prop} 不是真实属性，赋值已忽略`);
      return;
    }
    // 属性名是运行期字符串，而引擎类上没有“任意属性名”索引，只能按表写
    const next = coerceToProperty(target, prop, value);
    const drivesState = STATE_PROPERTIES.has(prop);
    // 状态属性没有变更信号，只能由这里标脏；而一次标脏会连带子树与兄弟（样式表含组合器
    // 时），所以先比一次现值：Forms 的 writeValue / setDisabledState 是无条件写的，
    // 重复写同一个值不该换一整轮重算
    if (drivesState && (target as unknown as Record<string, unknown>)[prop] === next) return;
    (target as unknown as Record<string, unknown>)[prop] = next;
    // 伪类本身在帧末重算时读属性（见 css 包 PROPERTY_STATE_CLASSES），此处不必再读一次
    if (drivesState) this.runtime.invalidate(target);
  }

  /**
   * 还原到该类新建时的默认值：Godot 属性强类型，写 null 会被引擎当场拒掉，撤销只能是还原。
   * 默认值由 ClassDB 直接给（引擎内部按需实例化一次并缓存，沿继承链）；`property_get_revert`
   * 用不了，它只回答脚本自己声明的自定义默认值，内建属性一律回 null。
   */
  private revertProperty(target: Node, prop: string): void {
    if (prop === "anchors_preset") {
      // preset 是命令不是状态（它改的是四个锚点与四个偏移），撤销只能回到默认 preset
      (target as Control).set_anchors_preset(0 /* PRESET_TOP_LEFT */);
      return;
    }
    // Angular 清理 attr 绑定会递来 Godot 不认的名字，撤一个没写过的东西无害，静默
    if (!nodeHasProperty(target, prop)) return;
    const value = ClassDB.class_get_property_default_value(target.get_class(), prop);
    if (value === undefined) return;
    // 引用型属性（theme / material）的默认就是 null，它们吃 null
    (target as unknown as Record<string, unknown>)[prop] = value;
    if (STATE_PROPERTIES.has(prop)) this.runtime.invalidate(target);
  }

  setAttribute(target: Node, name: string, value: unknown): void {
    // 静态 class 属性进入此处（`<Label class="a b">`）：它驱动 CSS 选择器，
    // 不能当噪声丢弃。ng- / _ng* 是 Angular 自己的记账属性，忽略。
    if (name === "class") {
      this.setClasses(target, value);
      return;
    }
    this.setProperty(target, name, value);
  }

  setValue(node: Node, value: string): void {
    // 文本节点由 createText 创建（Label），但 Angular 也会向宿主节点递 setValue，
    // 而 text 只存在于 Label / Button 那一支，因此先查属性是否真的存在。
    if (nodeHasProperty(node, "text")) (node).text = value
  }

  // ------------------------------------------------------------------ 样式
  // 内联样式进入级联的 inline 层，`[style.color]` 才能压过普通声明、输给 `!important`。
  // 但仍旧当场 apply：Angular 的既有行为是 setStyle 同步生效，推迟到帧末会静默晚一帧。

  setStyle(el: Control, style: string, value: unknown): void {
    const name = toCssName(style);
    const raw = value === null || value === undefined ? "" : String(value);
    if (!raw) {
      this.runtime.removeInline(el, name);
    } else {
      this.runtime.setInline(el, name, raw);
    }
    this.runtime.applyNow(el);
  }

  removeStyle(el: Control, style: string): void {
    this.runtime.removeInline(el, toCssName(style));
    this.runtime.applyNow(el);
  }

  /**
   * class 是 CSS 选择器的主要输入（`.card` / `.card.on .title`）：写入级联的会通知集合，
   * 改动自动标脏，帧末统一重算。（class 同时也是 `ng-content select=".body"` 的投影标记，
   * 那个在编译期就被 Angular 消费掉了，不经过这里。）
   */
  addClass(el: Node, name: string): void {
    this.mutateClasses(el, name, true);
  }

  removeClass(el: Node, name: string): void {
    this.mutateClasses(el, name, false);
  }

  /**
   * 取回节点的 class 集合。返回的是 `TrackingClassSet` 而不是普通 Set：向其中 add / delete
   * 会直接标脏节点并排一次帧末重算——因此下面两个方法里看不到任何“刷新”调用，样式却会更新。
   * 集合由 `Cascade.attach` 在节点入树时安装（全库唯一赋值点）。
   */
  private classesOf(el: Node): TrackingClassSet {
    return (el as unknown as { cssClasses: TrackingClassSet }).cssClasses;
  }

  private mutateClasses(el: Node, name: string, on: boolean): void {
    const set = this.classesOf(el);
    for (const cls of name.split(/\s+/)) {
      if (!cls) continue;
      if (on) set.add(cls);
      else set.delete(cls);
    }
  }

  /** `class="a b"` 这种整串赋值：以新值为准，旧的全部替换 */
  private setClasses(el: Node, value: unknown): void {
    const set = this.classesOf(el);
    set.clear();
    for (const cls of String(value ?? "").split(/\s+/)) {
      if (cls) set.add(cls);
    }
  }

  // ------------------------------------------------------------------ 事件

  listen(target: unknown, eventName: string, callback: (event: unknown) => void): () => void {
    // 接不到信号时静默忽略，与浏览器行为一致（addEventListener 对不认识的名字不报错）。
    // Angular 会把非 Godot 信号的名字（ngModelChange / ngSubmit 这类指令 output）递到
    // renderer.listen，也会按自己的约定递 'window' / 'document' / 'body' 这几个字符串目标，
    // 因此此处必须宽容；用户自行点名接信号也走 tryConnectGodotSignal。
    if (!isGodotNode(target)) return NOOP;
    return tryConnectGodotSignal(target, eventName, callback) ?? NOOP;
  }

  destroy(): void { }

  /** 同类问题只告警一次，避免每帧刷屏（去重口径全库共用 warnOnce） */
  private warn(key: string, message: string): void {
    warnOnce(`prop:${key}`, message);
  }
}

export class GodotRendererFactory implements RendererFactory2 {
  private readonly root = inject(GODOT_ROOT);
  private readonly runtime: StyleRuntime = inject(STYLE_RUNTIME, { optional: true }) ?? defaultStyleRuntime();
  private readonly appId: string = inject(APP_ID);
  /** 按组件类型缓存渲染器，键是 `type.id` */
  private readonly rendererByCompId = new Map<string, GodotRenderer>();
  private readonly defaultRenderer: GodotRenderer;
  private readonly cssVarNamespace: string;
  private globalCssTaken = false;

  constructor() {
    this.cssVarNamespace = inject(CSS_VAR_NAMESPACE, { optional: true }) ?? "";
    this.defaultRenderer = new GodotRenderer(this.root, this.runtime, null, this.cssVarNamespace);

    this.runtime.attach(this.root);
  }

  /**
   * 每个组件类型复用一个渲染器（按 `type.id` 缓存），并为宿主元素写入作用域标记。
   * Godot 没有 shadow root，ShadowDom 只能按 None 处理。
   */
  createRenderer(element: Node | null, type: RendererType2 | null): Renderer2 {
    if (!element || !type) {
      return this.defaultRenderer;
    }
    const renderer = this.getOrCreateRenderer(type as unknown as ComponentDefLike);
    renderer.applyToHost(element);
    return renderer;
  }

  private getOrCreateRenderer(type: ComponentDefLike): GodotRenderer {
    const rendererByCompId = this.rendererByCompId;
    let renderer = rendererByCompId.get(type.id);

    if (!renderer) {
      // 全局样式表只取一次（浏览器没有这一步：它的全局 CSS 在 index.html 里）
      if (!this.globalCssTaken) {
        this.globalCssTaken = true;
        this.runtime.takeGlobalCss();
      }
      switch (type.encapsulation) {
        case ViewEncapsulationKind.None:
        case ViewEncapsulationKind.ShadowDom:
        case ViewEncapsulationKind.ShadowDomSsr:
          if (type.encapsulation !== ViewEncapsulationKind.None) {
            if (ngDevMode) warnOnce(
              `css:shadow-dom:${type.encapsulation}`,
              "组件的 encapsulation 为 ShadowDom，Godot 无 shadow root，已按 None（全局）处理。",
            );
          }
          // 不传 compId = 归入全局层
          renderer = new GodotRenderer(this.root, this.runtime, type, this.cssVarNamespace);
          break;
        default:
          renderer = new GodotRenderer(
            this.root,
            this.runtime,
            type,
            this.cssVarNamespace,
            this.appId + "-" + type.id,
          );
      }
      rendererByCompId.set(type.id, renderer);
    }
    return renderer;
  }

  end(): void { }
}
