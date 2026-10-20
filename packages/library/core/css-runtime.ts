import type { CssNode, CssWarning, MediaEnvironment, SelectorTier } from "godot-angular/css";
import { Cascade } from "godot-angular/css";
import type { Node } from "godot";
import { backend } from "./style-target";
import { reportWarning, setDiagnosticSink } from "./warn";
import { bindPseudoClasses, warnUnboundPseudoClasses } from "./css-pseudo";
import { tryConnectGodotSignal } from "./godot-events";
import { asGodotNode, isCssStructural, type GodotNode } from "./godot-node";
import { readGlobalCss } from "./global-css";

/** `new StyleRuntime()` 的选项。 */
export interface StyleRuntimeOptions {
  /** 媒体查询的初始环境（窗口尺寸 / 深色模式）。无头模式下取不到真实值，由调用方提供。 */
  env?: MediaEnvironment;
  /**
   * 预留位，当前未接线：全局样式实际由 `GodotRendererFactory` 首次创建渲染器时显式调用
   * `takeGlobalCss()`，那个时机（第一个组件登记之前）才是正确的。传入不报错，也不生效。
   */
  globalCss?: boolean;
  /**
   * 结构化诊断回调：每产生一条告警就收到一个 `CssWarning`，按 `code` 判断即可，
   * 不需要匹配中文文案。与控制台输出的区别：该通道不去重，每条都送。
   */
  onDiagnostic?: (warning: CssWarning) => void;
}

/** 单个节点上已绑定的伪类信号。版本未变化则不重绑，因此必须保存版本号。 */
interface PseudoBinding {
  version: number;
  unbind: () => void;
}

/**
 * CSS 级联运行时：把纯包的 `Cascade` 接到帧末调度与 Godot 节点树上。
 *
 * 一个实例 = 一套样式表 + 一份节点状态。生命周期与应用一致：`GODOT_APP_PROVIDERS`
 * 为每个应用创建独立实例（DI 中通过 `STYLE_RUNTIME` token 传递）。应用销毁后该实例
 * 不再被引用，脏队列、节点账本与调度标记随之释放，因此同进程运行多个应用、或同一场景
 * 反复销毁重建，每次得到的都是初始状态。`defaultStyleRuntime()` 返回的进程级实例
 * 用于未提供该 token 的场合（见 `GodotRendererFactory`）与测试。
 *
 * 类名同时就是类型：`bindWindowEnvironment(runtime: StyleRuntime, …)`、
 * `InjectionToken<StyleRuntime>` 直接使用它，无需另配一份 interface。
 */
export class StyleRuntime {
  /** 级联本体。测试直接通过它验证内部状态（`stats` / `isDirty` / `stateOf` / `matched`） */
  readonly cascade: Cascade;

  /**
   * 伪类信号绑定：节点 → { 版本, 卸载 }。
   *
   * 记录版本号而不是“绑过即完成”：后登记的组件样式表可能引入新的伪类（`:hover`），
   * 存量节点需要补连。版本未变化则不重绑（否则组件逐个登记时会退化为 O(n²)）。
   */
  private readonly bindings = new WeakMap<object, PseudoBinding>();

  /**
   * 进出场景树的两个信号。节点被释放时引擎不会给 JS 任何通知（GodotJS 未提供
   * `Object.predelete` 信号，也未暴露 `is_instance_valid()`），而 Angular 销毁
   * 组件时只向渲染器递一次 `destroyNode`（只递宿主，内部元素一个不递）。
   *
   * 因此“节点消失”只能依靠 `tree_exited`（queue_free 时子孙也会收到），重新入树通过
   * `tree_entered` 补回登记——缺少后者，reparent / ngFor 移动后的节点会永久脱离管理。
   * 出树走 `retire` 而不是 `detach`：账本需要保留，否则节点回到树上时 diff 不知道撤销哪些。
   * 连接不主动解除：节点销毁时连接随之失效，而在 detach 里解除 tree_entered 会使节点
   * 无法重新登记。
   */
  private readonly lifecycle = new WeakMap<object, boolean>();

  constructor(options: StyleRuntimeOptions = {}) {
    setDiagnosticSink(options.onDiagnostic);
    this.cascade = new Cascade({
      backend,
      env: options.env,
      schedule: scheduleAtFrameEnd,
      warn: (warning) => reportWarning(warning),
    });
  }

  /** 登记一段 CSS，返回句柄供 `removeCss` 使用 */
  addCss(css: string, options?: { tier?: SelectorTier }): number {
    const before = this.cascade.pseudoClassVersion();
    const handle = this.cascade.addCss(css, options);
    if (ngDevMode) warnUnboundPseudoClasses(this.cascade.usedPseudoClasses());
    // 新样式表带来了新的伪类 → 已登记的节点需要补连信号（否则先创建的元素收不到 :hover）
    if (this.cascade.pseudoClassVersion() !== before) {
      for (const node of this.cascade.attachedNodes()) this.bindPseudo(asGodotNode(node));
    }
    return handle;
  }

  /**
   * 取构建期写入的全局样式（`styles` 选项）并注册到**本实例**的 cascade。
   *
   * 每个应用一份 runtime，因此每个都得自己注册一遍（全局样式只 drain 一次，见
   * `readGlobalCss`）。“只取一次”的旧写法在共享 cascade 下成立，改成应用级之后会使
   * 第 N 个应用一条全局样式都没有（外观随启动顺序变，极难归因）。
   */
  takeGlobalCss(): void {
    for (const css of readGlobalCss()) this.cascade.addCss(css, { tier: 0 /* Application */ });
  }

  removeCss(handle: number): void {
    this.cascade.removeSheet(handle);
  }

  /** 将节点纳入级联：把 `cssClasses` 替换为会通知的 `TrackingClassSet`，此后修改 class 自动标脏 */
  attach(node: Node): void {
    const target = asGodotNode(node);
    // 元素选择器读取的是 `cssType`。渲染器创建节点时会写入，但直接由 `new Label()` 创建的
    // 节点（测试、命令式拼装）没有——attach 时补上，否则同一份 CSS 在两条路径上
    // 行为不一致，元素选择器会静默不命中。
    if (target.cssType === undefined) target.cssType = node.get_class();
    this.bindSiblingAccessors(target);
    this.cascade.attach(target);
    this.bindPseudo(target);
    this.bindLifecycle(target);
  }

  /**
   * 兄弟组合器（`+` / `~`）依靠父节点上的三个 JS 风格方法回溯（selector.ts 的
   * previousSibling 读取 getChildIndex / getChildAt / getChildrenCount），而 Godot 节点
   * 只有 get_index / get_child / get_child_count。不挂载这三个方法，`Label + Button` 会静默不命中。
   *
   * 三个访问器只在「作者写的元素」上计数：模板锚点是 Angular 的记账节点，
   * DOM 里 `nextElementSibling` 会跳过它，这里也必须跳过（两个方向都跳：既不占兄弟位，
   * 也不被兄弟选择器命中），否则 `@if` / `@for` 一展开，锚点卡在两个元素中间，
   * 相邻兄弟选择器就静默失配。插值文本不在考虑范围内（文字一律用 `<Label text>` 写）。
   */
  private bindSiblingAccessors(node: GodotNode): void {
    if (node.getChildIndex !== undefined) return; // 重复 attach 不重复挂载
    node.getChildIndex = (child: CssNode) => {
      const target = asGodotNode(child);
      if (isCssStructural(target)) return -1;
      let index = 0;
      const count = Number(node.get_child_count());
      for (let i = 0; i < count; i++) {
        const current = node.get_child(i);
        if (current === target) return index;
        if (!isCssStructural(current)) index++;
      }
      return -1;
    };
    node.getChildAt = (index: number) => {
      let seen = 0;
      const count = Number(node.get_child_count());
      for (let i = 0; i < count; i++) {
        const current = node.get_child(i);
        if (isCssStructural(current)) continue;
        if (seen === index) return current;
        seen++;
      }
      return null as unknown as CssNode;
    };
    node.getChildrenCount = () => {
      let seen = 0;
      const count = Number(node.get_child_count());
      for (let i = 0; i < count; i++) {
        if (!isCssStructural(node.get_child(i))) seen++;
      }
      return seen;
    };
  }

  detach(node: Node): void {
    this.bindings.get(node)?.unbind();
    this.bindings.delete(node);
    this.cascade.detach(asGodotNode(node));
  }

  /** 节点子树发生变化（appendChild / removeChild 之后） */
  invalidateTree(node: Node): void {
    this.cascade.invalidateTree(asGodotNode(node));
  }

  /**
   * 某个父节点的子集合变了（插入 / 删除 / 移动）：`+` / `~` 匹配的是「邻居是谁」，而邻居换人
   * 引擎不发任何通知，只能由结构变更方显式标脏。样式表未用兄弟组合器时不产生标记。
   */
  invalidateSiblings(node: Node): void {
    this.cascade.invalidateSiblings(asGodotNode(node));
  }

  /**
   * 只标脏这一个节点（连带子树与依赖者，范围由级联判定）。
   *
   * 给「写了不会发信号的属性」用：渲染器写完 button_pressed / disabled / editable、
   * 表单指令改完值之后调它，帧末重算时会把伪类从属性上读回来。
   */
  invalidate(node: Node): void {
    this.cascade.invalidate(asGodotNode(node));
  }

  /**
   * 该节点是否待重算。给「写完属性后想知道有没有真的标脏」用（诊断 / 测试），
   * 误标脏会被 diff 短路，但标脏范围（子树 / 兄弟）只有这里看得见。
   */
  isDirty(node: Node): boolean {
    return this.cascade.isDirty(asGodotNode(node));
  }

  /** 内联样式（`[style.x]`）。 */
  setInline(node: Node, property: string, value: string): void {
    this.cascade.setInline(asGodotNode(node), property, value);
  }

  removeInline(node: Node, property: string): void {
    this.cascade.removeInline(asGodotNode(node), property);
  }

  /** 媒体查询环境（窗口尺寸 / 深色模式）。无头模式下取不到真实值，由调用方提供。 */
  setEnv(env: MediaEnvironment): void {
    this.cascade.setEnv(env);
  }

  /**
   * 手动开启 / 关闭一个伪类。**只适用于既无信号也无属性可推的伪类**
   * （`:selected` / `:valid` / `:indeterminate` …）。
   *
   * `:checked` / `:disabled` / `:enabled` / `:read-only` 由节点属性驱动（见 css 包
   * `PROPERTY_STATE_CLASSES`）：级联每次重算前会把属性读成伪类，因此脱离属性的
   * 手动开关会在同一轮重算里被读回去——要改这几个状态请改属性（`button_pressed` /
   * `disabled` / `editable`），或直接走模板绑定。
   */
  setPseudoClass(node: Node, name: string, on: boolean): void {
    this.cascade.setPseudoClass(asGodotNode(node), name, on);
  }

  /** 立即 flush（供测试或退出前收尾使用） */
  flush(): void {
    this.cascade.flush();
  }

  /** 立即重算**这一个**节点（不等到帧末）。`setStyle` 依托它保持“设置后立即生效”的既有语义 */
  applyNow(node: Node): void {
    this.cascade.applyNow(asGodotNode(node));
  }

  /** 根据当前伪类集合为节点（重新）绑定信号。版本一致时直接返回，见 `bindings` 注释 */
  private bindPseudo(node: GodotNode): void {
    const version = this.cascade.pseudoClassVersion();
    if (!this.cascade.usedPseudoClasses().size) return;
    const current = this.bindings.get(node);
    if (current && current.version === version) return;
    current?.unbind();
    // `target` 只有 :hover 会传：悬停向祖先冒泡是 CSS 语义，引擎不会替我们发那些信号。
    // 不属于本级联的祖先（挂载点、使用方自己接在上面的引擎节点）一律跳过：标脏一个未登记
    // 节点会把它的整棵子树拉进脏队列，而 flush 又会全部跳过——白跑一轮全量重算。
    const unbind = bindPseudoClasses(node, this.cascade.usedPseudoClasses(), (name, on, target) => {
      if (target === undefined) {
        this.cascade.setPseudoClass(node, name, on);
        return;
      }
      if (this.cascade.stateOf(asGodotNode(target))?.attached !== true) return;
      this.cascade.setPseudoClass(asGodotNode(target), name, on);
    });
    if (unbind) this.bindings.set(node, { version, unbind });
    else this.bindings.delete(node);
  }

  /** 连接一次进出树信号：出树时将自己从级联中摘除，入树时重新登记 */
  private bindLifecycle(node: GodotNode): void {
    if (this.lifecycle.has(node)) return;
    this.lifecycle.set(node, true);
    tryConnectGodotSignal(node, "tree_entered", () => this.attach(node));
    tryConnectGodotSignal(node, "tree_exited", () => this.cascade.retire(node));
  }
}

/**
 * 帧末调度。rAF 由 polyfills 提供，队列由帧钟泵送。两种「排不上」的情形一律同步 flush，
 * 以保证样式修改总能被刷新（代价是少合并一轮）：
 *
 *  - 未安装补丁的环境（没有 rAF）；
 *  - 帧钟停摆（上一个应用 destroy 之后、新应用 start 之前）：此时 rAF 直接拒收并返回 -1。
 *
 * 返回 `false` 表示本次刷新未被接管，由 `Invalidator` 复位调度标记后同步执行。
 */
function scheduleAtFrameEnd(flush: () => void): boolean {
  const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number })
    .requestAnimationFrame;
  if (typeof raf !== "function") {
    flush();
    return true;
  }
  if (raf(() => flush()) < 0) return false;
  return true;
}

let shared: StyleRuntime | null = null;

/** 常规路径的默认运行时（一个进程只跑一个应用时使用）。测试请自行 `new StyleRuntime()` */
export function defaultStyleRuntime(): StyleRuntime {
  if (!shared) shared = new StyleRuntime();
  return shared;
}

/** `ViewEncapsulation`：0 Emulated / 1 None / 2 ShadowDom / 3 ShadowDomSsr */
export const enum ViewEncapsulationKind {
  Emulated = 0,
  None = 1,
  ShadowDom = 2,
  ShadowDomSsr = 3,
}
