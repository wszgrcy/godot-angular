import {
  compareSelectors,
  ComplexSelector,
  FunctionalPseudoClassSelector,
  PseudoClassSelector,
  SimpleSelectorSequence,
  SUPPORTED_PSEUDO_CLASSES,
} from "../selector";
import type { SelectorCore } from "../selector";
import type {
  CssNode,
  Declaration,
  MediaEnvironment,
  StyleBackend,
  StyleScheduler,
  WarnLevel,
} from "../types";
import { CssCode, CssWarnEntry, CssWarning, type CssWarnDetail, type CssWarnReport } from "../diagnostics";

/** 开发模式标记：生产构建中整个 `if (ngDevMode)` 分支连同告警文案一并消除（口径见 runtime/properties.ts） */
import { Invalidator } from "./invalidation";
import {
  NodeStates,
  propertyOfSlot,
  slotKey,
  statesKey,
  TrackingClassSet,
  type MergedDeclaration,
  type NodeStyleState,
} from "./state";
import { SheetRegistry } from "./sheets";
import { resolveVars, sameVars, usesVars } from "./vars";
import type { SelectorTier } from "../types";

export type { MergedDeclaration, NodeStyleState } from "./state";
export type { TrackingClassSet } from "./state";


export const PROPERTY_STATE_CLASSES: ReadonlyArray<PropertyStateEntry> = [
  // 引擎的 is_pressed() = toggle_mode && button_pressed，但 button_pressed 的 setter 自己就做
  // 了这个门控（toggle_mode=false 时写 true 读回仍是 false，已用引擎 spec 钉住），
  // 所以只读 button_pressed 就够，不必再探 toggle_mode。
  { prop: "button_pressed", state: "checked" },
  { prop: "disabled", state: "disabled" },
  // :enabled 与 :disabled 同源，只是反一下；不登记的话它永远不命中，而作者无从得知
  { prop: "disabled", state: "enabled", invert: true },
  { prop: "editable", state: "read-only", invert: true },
];

/**
 * 来源：无
 *
 * `PROPERTY_STATE_CLASSES` 的一项：一个引擎属性驱动一个伪类
 */
export interface PropertyStateEntry {
  prop: string;
  state: string;
  invert?: boolean;
}

/**
 * 来源：无
 *
 * 某个控件类对「属性驱动的伪类」的支持情况。同一个类的结果永远不变，因此按节点
 * 缓存（见 `Cascade.stateSupport`），不必每个脏节点每轮重探。
 */
interface ClassStateSupport {
  /** 探测时的「用到的属性驱动伪类」签名；样式表引入新状态时签名变化，需要重探 */
  usedKey: string;
  /** 类名，告警文案用（避开每轮再调一次 backend.classOf） */
  className: string;
  /** 这类控件真有那个属性，可以读出来推导 */
  applicable: PropertyStateEntry[];
  /** 推不出的条目，只用来告警 */
  absent: PropertyStateEntry[];
}

/**
 * 来源：无
 */
export interface CascadeOptions {
  backend: StyleBackend;
  /** 媒体查询环境。**由调用方注入**，本包不读取 DisplayServer */
  env?: MediaEnvironment;
  /**
   * 决定重算时机的注入点（见 {@link StyleScheduler}）。未传入时不会自动重算，只能由调用方
   * 显式调用 `flush()`；构建期只解析样式表、不写入节点，用的就是这种配置。
   */
  scheduler?: StyleScheduler;
  /** 告警出口，不提供则静默。收到的是组装好的诊断对象 */
  warn?: (warning: CssWarning) => void;
}

/**
 * 来源：无
 *
 * 计数器：判断“是否每帧都在全量重刷”就看这里
 */
export interface CascadeStats {
  flushes: number;
  applied: number;
  cleared: number;
  /** 本轮 flush 处理的节点数（不含被 diff 短路成 0 次写入的） */
  nodes: number;
  /** 因 diff 无变化而跳过写入的节点数——这一项较高才说明护栏在起作用 */
  skipped: number;
}

/**
 * 来源：无
 *
 * 收集这条选择器**自身的主体段**要求了哪些状态伪类。只有它自己要求的状态，才决定它的值
 * 应当写进哪个 item（详见 `MergedDeclaration.states`）。
 *
 * 必须遍历 AST 而不是匹配选择器文本：文本里出现 `:hover` 不等于“这条规则要求了 hover”。
 * `.card:hover .btn` 要求的是**卡片**悬停，目标节点是 `.btn`；`:not(:hover)` 更是恰好相反。
 * 误判的后果不是“少一个样式”而是“值被送到引擎在另一个状态下读的 item”，
 * 症状是颜色/底色在无关状态下突变。
 *
 * 结果按选择器对象缓存（选择器由样式表长期持有），因此每轮重算不再重新构造选择器文本。
 */
function collectSequenceStates(sequence: SimpleSelectorSequence, out: Set<string>): void {
  for (const simple of sequence.selectors) {
    if (simple instanceof PseudoClassSelector) {
      if (SUPPORTED_PSEUDO_CLASSES.has(simple.cssPseudoClass)) out.add(simple.cssPseudoClass);
    } else if (simple instanceof FunctionalPseudoClassSelector && simple.name !== "not") {
      // :is(:hover) / :where(:hover) 确实要求了状态；:not(:hover) 不要求
      for (const arg of simple.args) {
        if (arg instanceof SimpleSelectorSequence) collectSequenceStates(arg, out);
      }
    }
  }
}
/** 基规则（空集）共用同一个实例，避免为每条基规则分配一个 Set */
const NO_STATES: ReadonlySet<string> = new Set<string>();
/** 选择器要求的状态集 + 它的稳定串（后者参与账本键） */
interface RequiredStates {
  names: ReadonlySet<string>;
  key: string;
}
const EMPTY_REQUIRED: RequiredStates = { names: NO_STATES, key: "" };

const selectorStatesCache = new WeakMap<object, RequiredStates>();

function selectorStates(selector: SelectorCore): RequiredStates {
  const key = selector as unknown as object;
  const cached = selectorStatesCache.get(key);
  if (cached) return cached;

  const names = new Set<string>();
  if (selector instanceof SimpleSelectorSequence) {
    collectSequenceStates(selector, names);
  } else if (selector instanceof ComplexSelector) {
    // 复合选择器被匹配到的那个节点由**最右段**描述，状态伪类只有写在它身上才算要求了状态
    const parts = selector.parts;
    collectSequenceStates(parts[parts.length - 1].sequence, names);
  }
  const result: RequiredStates = names.size === 0 ? EMPTY_REQUIRED : { names, key: statesKey(names) };
  selectorStatesCache.set(key, result);
  return result;
}

/**
 * 来源：无（本侧特有问题的修正）
 *
 * 决定写入位置的状态集 = 选择器要求的状态 ∩ 节点此刻挂着的状态。
 *
 * `:is(:hover, :focus)` 要求的是并集，但让规则成立的可能只有 `:focus`；值要写进引擎此刻
 * 会读的那个 item（font_focus_color），而不是并集里优先级最高的那个。并列伪类
 * （`.b:hover:active`）要求全部成立才匹配，交集等于要求集，行为不变。
 *
 * 账本键跟着换：状态集变了而值没变时，写入位置变了仍属“有变化”，diff 不能跳过。
 * 属性驱动的伪类（:disabled / :checked / :read-only）在 merge 前已同步到节点上
 * （drain 与 applyNow 都先跑 syncPropertyPseudoClasses），因此交集不会漏掉它们。
 */
function landingStates(required: RequiredStates, node: CssNode): RequiredStates {
  if (required.names.size === 0) return required;
  const held = node.cssPseudoClasses;
  if (!held) return required;
  const names = new Set<string>();
  for (const name of required.names) if (held.has(name)) names.add(name);
  if (names.size === required.names.size) return required;
  return names.size === 0 ? EMPTY_REQUIRED : { names, key: statesKey(names) };
}

/**
 * 来源：NativeScript/packages/core/ui/styling/style-scope.ts :: StyleScope
 *      + NativeScript/packages/core/ui/styling/style-scope.ts :: CssState
 * 等级：仅思路一致（合成类）
 * 差异：上游 StyleScope 同时管样式表文本、解析、作用域与屏幕变化；CssState 同时管匹配、
 * 合并与写入，两者靠事件订阅耦合。本侧拆为 Cascade / SheetRegistry / Invalidator 三块，
 * 并改为拉取式：`Invalidator` 先把需要重算的节点加入集合，`flush()` 被调用时一并处理；
 * 调用时机由 `scheduler` 决定（上游是属性 setter 当场重算）。
 * 保留的契约：级联只在 longhand 上定义、匹配结果按特异度/层级/源码顺序排序、
 * 动态伪类变化只重算受影响节点。
 *
 * 级联：将「已登记的样式表」写入「已登记的节点」上。
 *
 * 三段分工（对应 NativeScript 的 StyleScope / 失效通知 / CssState）：
 *   - `SheetRegistry`（sheets.ts）：样式表与由样式表推出的元信息
 *   - `Invalidator`（invalidation.ts）：谁需要重算、什么时候重算
 *   - 本文件：匹配 → 合并 → diff → 写入，以及变量继承
 *
 * 只重算单个节点时调用 `applyNow`，批量则调用 `flush`（`flush` 的调用时机见 `scheduler` 选项）。
 */
export class Cascade {
  private readonly states = new NodeStates();
  /** 按节点缓存的「这类控件支持哪些属性驱动伪类」（同一类共享同一份内容） */
  private readonly stateSupport = new WeakMap<CssNode, ClassStateSupport>();
  /** 已告警过的「伪类 × 类名」，避开重复拼接告警文案 */
  private readonly warnedStates = new Set<string>();
  private readonly sheets: SheetRegistry;
  private readonly invalidator: Invalidator;
  /**
   * 标记 `flush()` 正在执行。刷新过程中新标记的节点由下一次 `flush()` 处理，不在此处
   * 递归调用：递归会把同一批节点计算两遍，而第二遍读到的父链 / 变量仍是本次执行到一半
   * 的中间状态。
   */
  private flushing = false;

  readonly stats: CascadeStats = { flushes: 0, applied: 0, cleared: 0, nodes: 0, skipped: 0 };

  constructor(private readonly options: CascadeOptions) {
    this.sheets = new SheetRegistry(options.env ?? {}, (code, message, detail, level) =>
      this.warn(code, message, detail, level),
    );
    this.invalidator = new Invalidator(
      this.states,
      options.backend,
      this.sheets,
      options.scheduler,
      () => this.flush(),
    );
  }

  /* ---------------------------------------------------------------- *
   * 样式表
   * ------------------------------------------------------------------ */

  /**
   * 来源：NativeScript/packages/core/ui/styling/style-scope.ts :: StyleScope.addCss
   * 等级：部分修改（主体一致）
   * 改动：上游追加文本后整体重解析并 raiseUpdate，本侧返回可撤销的序号；两者同样
   * 使全量节点标脏（上游靠 _cssSelectionsByView 清空，本侧靠 invalidateAll）。
   *
   * 登记一段 CSS，返回序号，`removeSheet()` 用它撤销。
   *
   * 新样式表会使所有已登记节点全量标脏，因此只应当在启动时登记，不要逐帧调用。
   */
  addCss(css: string, options: { tier?: SelectorTier } = {}): number {
    const handle = this.sheets.add(css, options);
    this.invalidator.invalidateAll();
    return handle;
  }

  /**
   * 来源：NativeScript/packages/core/ui/styling/style-scope.ts :: removeTaggedAdditionalCSS（StyleScope 侧的 changeCssFile）
   * 等级：部分修改（主体一致）
   * 改动：上游按子串删除文本后整体重解析，本侧按登记时返回的序号整张袭除。
   *
   * 撤销一段 CSS（热更新 / 组件销毁时使用），受它影响的值会被撤销。序号无效时不触发重算
   */
  removeSheet(handle: number): void {
    if (this.sheets.remove(handle)) this.invalidator.invalidateAll();
  }

  /**
   * 来源：NativeScript/packages/core/ui/styling/style-scope.ts :: CssState.subscribeForDynamicUpdates
   * 等级：仅思路一致
   * 差异：上游对每个动态伪类逐个订阅视图事件（_addEventListener），本侧改为“样式表究竟
   * 用了哪些伪类”这一集合，由引擎侧一次性决定要不要连信号；伪类集合变化时上游无感知，
   * 本侧额外记版本号以便增量补连。
   *
   * 样式表中实际使用了哪些伪类——attach 时要据此决定是否为节点连接 mouse_entered 之类的信号，
   * 而那时节点上还没有运行时状态，答案只能来自样式表自身。
   */
  usedPseudoClasses(): ReadonlySet<string> {
    return this.sheets.usedPseudoClasses();
  }

  /** 伪类集合的版本号（仅在集合确实变化时递增） */
  pseudoClassVersion(): number {
    return this.sheets.pseudoClassVersion();
  }

  /** 已登记的节点（新样式表引入新伪类时，运行时要为存量节点补连信号） */
  attachedNodes(): Iterable<CssNode> {
    return this.invalidator.attachedNodes();
  }

  /**
   * 来源：NativeScript/packages/core/ui/styling/style-scope.ts :: StyleScope._createSelectors
   *      （媒体查询在重建选择器时经 matchMediaQueryString 重判）
   * 等级：部分修改（主体一致）
   * 改动：上游从 Screen.mainScreen 自取新环境并只重建变化了的媒体查询作用域，本侧环境
   * 由外部注入，且只在确实变化时全量标脏。
   *
   * 更换媒体查询环境（窗口尺寸变化时调用）
   */
  setEnv(next: MediaEnvironment): void {
    if (this.sheets.setEnv(next)) this.invalidator.invalidateAll();
  }

  /* ---------------------------------------------------------------- *
   * 节点登记与失效
   * ------------------------------------------------------------------ */

  /**
   * 来源：NativeScript/packages/core/ui/core/view-base/index.ts :: ViewBase.onLoaded 中的 CssState 创建
   *      + CssState.subscribeForDynamicUpdates
   * 等级：部分修改（主体一致）
   * 相同：都是“节点进入样式系统”的唯一入口，并在这一刻换上可追踪的 class 集合。
   * 改动：上游在 onLoaded 里直接 lookupRulesets 并一次性应样式，本侧只标脏，写入推到下一次刷新；
   * 上游的 cssClasses 本来就是 Observable 集合，本侧需要主动替换为 TrackingClassSet。
   *
   * 登记一个节点：将 cssClasses 替换为 `TrackingClassSet`，并标脏等待下一轮 apply。
   *
   * class 必须在 attach 之后写入：原 `cssClasses` 中的内容不会迁移。生产路径上节点都是
   * 先创建后 attach（携带 class 进入的只有测试），为它保留一条无人使用的迁移分支并不值得。
   */
  attach(node: CssNode): void {
    this.invalidator.attach(node);
  }

  /**
   * 来源：NativeScript/packages/core/ui/core/view-base/index.ts :: ViewBase.onUnloaded（释放 CssState）
   * 等级：部分修改（主体一致）
   * 改动：上游直接丢弃 CssState 并取消事件订阅，本侧还需从反向索引中摘除节点（无 GC 可依赖）。
   *
   * 节点即将销毁：清理反向索引与账本，不要让已释放节点挂在其他对象上
   */
  detach(node: CssNode): void {
    this.invalidator.detach(node);
  }

  /**
   * 来源：无
   *
   * 节点离开了树（reparent / ngIf 暂时移除）：只释放强引用，账本保留。
   *
   * 状态存在 WeakMap 中，因此不会丢失；重新入树时 `attach` 会继续使用这份账本，
   * diff 才能把“现在不应命中了”的那条撤销。
   */
  retire(node: CssNode): void {
    this.invalidator.detach(node, true);
  }

  /**
   * 来源：NativeScript/packages/core/ui/core/view-base/index.ts :: ViewBase._onCssStateChange
   *      + LayoutBase._invalidateSiblingCssState
   * 等级：部分修改（主体一致）
   * 相同：失效范围相同——自身、子树（后代组合器）、兄弟（`+` / `~`）、动态依赖者。
   * 改动：上游直接重算并写入，本侧只入队；上游的兄弟失效靠事件广播，本侧靠 changeMap。
   *
   * 标脏一个节点，连带它确实能影响到的范围：自身、子树（`.card .title`）、兄弟（`+` / `~`）、
   * changeMap 记录的动态依赖者。误标脏会被 diff 短路，不会多写入一个字节。
   */
  invalidate(node: CssNode): void {
    this.invalidator.invalidate(node);
  }

  /** 整棵子树标脏（appendChild / removeChild 之后可调用） */
  invalidateTree(root: CssNode): void {
    this.invalidator.invalidateTree(root);
  }

  /**
   * 某个父节点的子集合发生变化（插入 / 删除 / 移动）后标脏它的直接子级。
   *
   * `+` / `~` 的匹配结果取决于邻居是谁，而邻居换人引擎不发任何通知，只能由结构变更方显式
   * 标脏；样式表未使用兄弟组合器时该调用不产生任何标记。
   */
  invalidateSiblings(parent: CssNode): void {
    this.invalidator.invalidateSiblings(parent);
  }

  /** 全部已登记节点标脏 */
  invalidateAll(): void {
    this.invalidator.invalidateAll();
  }

  /* ---------------------------------------------------------------- *
   * 内联声明与伪类
   * ------------------------------------------------------------------ */

  /**
   * 来源：NativeScript/packages/core/ui/core/view-base/index.ts :: ViewBase.style / setInlineStyle
   * 等级：部分修改（主体一致）
   * 改动：上游的内联 style 是一个逐属性写 Style 对象的解析器，本侧只存“属性→原文”然
   * 后交给同一套展开与解析流程；上游内联始终最高优先，本侧它高于样式表普通声明但低于
   * `!important`（本侧支持 !important，上游不支持）。
   *
   * 内联样式（Angular 的 `[style.x]`）：优先级高于样式表的普通声明，低于 `!important`
   */
  setInline(node: CssNode, property: string, value: string): void {
    const state = this.states.of(node);
    if (state.inline.get(property) === value) return;
    state.inline.set(property, value);
    this.invalidator.invalidate(node);
  }

  removeInline(node: CssNode, property: string): void {
    const state = this.states.of(node);
    if (!state.inline.delete(property)) return;
    this.invalidator.invalidate(node);
  }

  clearInline(node: CssNode): void {
    const state = this.states.of(node);
    if (!state.inline.size) return;
    state.inline.clear();
    this.invalidator.invalidate(node);
  }

  /**
   * 来源：NativeScript/packages/core/ui/styling/style-scope.ts :: CssState.updateDynamicState
   * 等级：部分修改（主体一致）
   * 改动：上游直接往 cssPseudoClasses 加/删并靠集合变更事件触发重算，本侧先做幂等判定
   * 再写入（Godot 信号会重复触发，enter/exit 不成对时不能靠集合自身判变更）。
   *
   * 伪类开关（:hover 这类，由 Godot 信号驱动）
   */
  setPseudoClass(node: CssNode, name: string, on: boolean): void {
    if (!node) return;
    let set = node.cssPseudoClasses;
    if (!(set instanceof TrackingClassSet)) {
      const previous = node.cssPseudoClasses;
      set = node.cssPseudoClasses = new TrackingClassSet(() => this.invalidator.invalidate(node));
      if (previous) for (const value of previous) set.add(value);
    }
    const changed = on ? !set.has(name) : set.has(name);
    if (!changed) return;
    if (on) set.add(name);
    else set.delete(name);
  }

  /* ---------------------------------------------------------------- *
   * 应用
   * ------------------------------------------------------------------ */

  /**
   * 来源：NativeScript/packages/core/ui/core/view-base/index.ts :: ViewBase._batchUpdate
   * 等级：部分修改（主体一致）
   * 改动：上游的批量入口靠 _ignoreDynamicStyleUpdatesChanged 暂停事件后逐条处理，本侧
   * 改为从脏队列取整批；上游处完直接写 Style 对象，本侧写入交给 applyNode（可被 diff 短路）。
   *
   * 写入所有被标记的节点。由刷新调度器调用，测试中也可以手动调用
   */
  flush(): number {
    if (this.flushing) return 0;
    this.flushing = true;
    try {
      return this.drain();
    } finally {
      this.flushing = false;
    }
  }

  private drain(): number {
    const queue = this.invalidator.takeDirty();
    if (!queue.length) return 0;

    /*
     * 属性 → 伪类先走一遍，不放在 applyNode 里。
     *
     * setPseudoClass 会回调 invalidate，而 flush 已经 takeDirty() 取空了队列并置好
     * dirty=false：在 applyNode 内部改伪类，本节点会被重新入脏，依赖它的兄弟 / 后代
     * 也跟着延一帧（现象：勾选后相邻元素晚一帧才变色），然且下一帧还要整轮重算一次
     * 才被 diff 短路。前置后，同步产生的脏节点直接并入本轮。
     *
     * 每个节点至多同步一次（setPseudoClass 幂等，重同步只是白读属性）；同步期间新入脏
     * 的节点追加到队尾，因此一轮 flush 内收敛。
     */
    const synced = new Set<CssNode>();
    const usedKey = this.propertyStateKey();
    for (let i = 0; i < queue.length; i++) {
      const node = queue[i];
      if (synced.has(node)) continue;
      synced.add(node);
      if (this.states.get(node)?.attached) this.syncPropertyPseudoClasses(node, usedKey);
      const extra = this.invalidator.takeDirty();
      if (extra.length) queue.push(...extra);
    }

    let touched = 0;
    for (const node of queue) {
      const state = this.states.get(node);
      if (!state || !state.attached) continue;
      state.dirty = false;
      if (this.applyNode(node, state)) touched++;
    }
    this.stats.flushes++;
    this.stats.nodes += touched;
    return touched;
  }

  /**
   * 来源：NativeScript/packages/core/ui/styling/style-scope.ts :: CssState.updateMatch
   * 等级：部分修改（主体一致）
   * 改动：上游是“样式表变了，全量重查并写入”，本侧是单节点即时重算（不等到下一次刷新）。
   *
   * 立即重算一个节点（不排进刷新队列）。返回是否确实写入了节点
   */
  applyNow(node: CssNode): boolean {
    const state = this.states.of(node);
    // 与 flush 同一口径：先同步伪类，再把自己从脏队列摘掉（依赖者留在队列里等下一轮）
    this.syncPropertyPseudoClasses(node, this.propertyStateKey());
    this.invalidator.drop(node);
    state.dirty = false;
    return this.applyNode(node, state);
  }

  /**
   * 来源：无
   *
   * 合并出单个节点当前应得的声明序列（已按级联顺序排好，供诊断与测试使用）
   */
  matched(node: CssNode): MergedDeclaration[] {
    return this.merge(node, this.states.of(node));
  }

  /** 匹配到的选择器文本（定位“为什么这条样式没生效”的第一站） */
  matchedSelectors(node: CssNode): string[] {
    return this.sheets.matched(node).selectors.map((selector) => String(selector));
  }

  stateOf(node: CssNode): NodeStyleState | undefined {
    return this.states.get(node);
  }

  /** 是否待重算（验证“定向失效有没有误伤”依赖它） */
  isDirty(node: CssNode): boolean {
    return this.invalidator.isDirty(node);
  }

  /** 谁依赖了这个节点的状态（changeMap 的反向视图） */
  dependentsOf(node: CssNode): CssNode[] {
    return this.invalidator.dependentsOf(node);
  }

  /* ---------------------------------------------------------------- *
   * 内部
   * ------------------------------------------------------------------ */


  /**
   * 来源：无
   *
   * 把节点属性读成伪类（:checked / :disabled / :enabled / :read-only，见
   * `PROPERTY_STATE_CLASSES`）。这些属性在 Godot 里不发任何变更信号，只能由重算方主动读。
   *
   * 「这类控件到底有没有那个属性」按节点缓存一次（`stateSupport`）：真实 backend 里
   * `hasNodeProperty` = `get_class()` + 属性表 `Set.has`，不缓存的话每个脏节点每轮都
   * 要为每个状态伪类重查一遍，而结果对同一个类永远不变。控件类上没有那个属性时
   *（`ItemList` 没有 `disabled`）不猜、不抖：按「状态 × 类名」告警一次。
   */
  private syncPropertyPseudoClasses(node: CssNode, usedKey: string): void {
    if (usedKey === "") return;
    let support = this.stateSupport.get(node);
    if (!support || support.usedKey !== usedKey) {
      support = this.probeStateSupport(node, this.sheets.usedPseudoClasses(), usedKey);
      this.stateSupport.set(node, support);
    }
    const backend = this.options.backend;
    // applicable / absent 在探测时已按「样式表用到的状态」筛过，这里不再重复判
    for (const { prop, state, invert } of support.applicable) {
      const truthy = backend.getNodeNumber(node, prop) !== 0;
      this.setPseudoClass(node, state, invert ? !truthy : truthy);
    }
    for (const { prop, state } of support.absent) {
      const key = `pseudo-state:${state}:${support.className}`;
      // 去重放在前面：告警文案是拼出来的，不能每个节点每轮都拼一遗
      if (this.warnedStates.has(key)) continue;
      this.warnedStates.add(key);
      if (ngDevMode) this.warn(
        CssCode.PseudoNotDerivable,
        `${support.className} 没有 ${prop} 属性，:${state} 在它身上推不出来（不会自动生效）。`
          + `如需该外观，请走 class 通道（[class."${state}"]="…" 配合 CSS .x.${state}）。`,
        { class: support.className, pseudo: state, prop },
      );
    }
  }

  /**
   * 当前样式表用到的「属性驱动伪类」签名。每轮 flush 只算一遗；它变了意味着新引入了
   * 一个属性驱动的伪类，各类的支持情况需要重探。
   */
  private propertyStateKey(): string {
    const used = this.sheets.usedPseudoClasses();
    let key = "";
    for (const { state } of PROPERTY_STATE_CLASSES) {
      if (used.has(state)) key += (key ? "," : "") + state;
    }
    return key;
  }

  /** 按类探一次：只探样式表真的用到的那些，没用到就不花这个钱 */
  private probeStateSupport(node: CssNode, used: ReadonlySet<string>, usedKey: string): ClassStateSupport {
    const backend = this.options.backend;
    const applicable: PropertyStateEntry[] = [];
    const absent: PropertyStateEntry[] = [];
    for (const entry of PROPERTY_STATE_CLASSES) {
      if (!used.has(entry.state)) continue;
      (backend.hasNodeProperty(node, entry.prop) ? applicable : absent).push(entry);
    }
    return { usedKey, className: backend.classOf(node), applicable, absent };
  }
  /**
   * 来源：NativeScript/packages/core/ui/styling/style-scope.ts :: CssState.setPropertyValues
   * 等级：部分修改（主体一致）
   * 相同：先按 compareSelectors 排序、再逐条覆盖同一属性，后写入者赢；都只保留 longhand。
   * 改动：上游不区分 !important（解析阶段已剔），本侧按「普通→内联→!important」三层
   * 叠加；上游额外处理 keyframes 与动画属性合并，本侧无动画。
   *
   * 合并 + 更新依赖索引。返回合并结果（已按级联顺序排好）
   */
  private merge(node: CssNode, state: NodeStyleState): MergedDeclaration[] {
    const { selectors, changeMap, declarations } = this.sheets.matched(node);
    selectors.sort(compareSelectors);
    this.invalidator.updateDependencies(node, state, changeMap);

    // 分组键是「属性名 + 选择器要求的状态」而不是单看属性名：基规则与每条状态规则各自写入
    // 不同的 theme item，它们之间不存在覆盖关系。只有要求了同一组状态的定义才互相竞争。
    const merged = new Map<string, MergedDeclaration>();
    /** 声明与其来源选择器所要求的状态成对保存：一条规则的多个选择器共享同一个 Declaration，
     * 按 Declaration 反查会让“最后一个选择器”的要求套到所有选择器头上 */
    interface Pending {
      decl: Declaration;
      required: RequiredStates;
    }
    /** delete 再 set：Map.set 对已存在的键**不挪动位置**，而这里的顺序就是级联顺序 */
    const put = (decl: Declaration, inline: boolean, required: RequiredStates) => {
      const key = slotKey(decl.property, required.key);
      merged.delete(key);
      merged.set(key, {
        property: decl.property,
        value: decl.value,
        inline,
        states: required.names,
        statesKey: required.key,
      });
    };
    const normal: Pending[] = [];
    const important: Pending[] = [];
    for (const selector of selectors) {
      const required = landingStates(selectorStates(selector), node);
      for (const decl of declarations.get(selector) ?? []) {
        (decl.important ? important : normal).push({ decl, required });
      }
    }
    // 普通(按级联) → 内联 → !important(按级联)：CSS 定义的三层顺序，important 不能只记录成集合，
    // 否则特异度高的普通声明会覆盖它。
    for (const { decl, required } of normal) put(decl, false, required);
    for (const [property, value] of state.inline) {
      if (important.some((item) => item.decl.property === property)) continue;
      const key = slotKey(property, "");
      merged.delete(key);
      // 内联样式没有选择器，也就无从要求状态 → 永远写基 item
      merged.set(key, { property, value, inline: true, states: NO_STATES, statesKey: "" });
    }
    for (const { decl, required } of important) put(decl, false, required);
    return [...merged.values()];
  }

  /**
   * 来源：NativeScript/packages/core/ui/core/view-base/index.ts :: ViewBase._onCssStateChange 的写入段
   *      + CssState.setPropertyValues 的“只写变化项”部分
   * 等级：仅思路一致
   * 差异：上游把合并后的声明逐个赋给 Style 属性（属性自身不做相等比较，写多少算多少）；
   * 本侧与上一轮账本 diff，只写真正变化的属性，并对“不再命中”的属性显式清除（Godot 的
   * theme override 不会自动退回默认值）。变量继承与 var() 展开也是本侧新增（上游在解析期代入）。
   *
   * 实际写入节点的一段。返回是否发生了写入
   */
  private applyNode(node: CssNode, state: NodeStyleState): boolean {
    const merged = this.merge(node, state);
    const applied = state.applied;

    // 自定义属性拆出来作为变量环境，不作为普通属性（它们本身不写任何东西，写的是引用它们的那些值）
    const ownVars = new Map<string, string>();
    const usable: MergedDeclaration[] = [];
    for (const decl of merged) {
      if (decl.property.startsWith("--")) ownVars.set(decl.property, decl.value);
      else usable.push(decl);
    }
    // 自身变量发生变化 → 子树内引用它的节点全部重算（Godot 属性赋值没有通知，只能自行标脏）
    if (!sameVars(state.vars, ownVars)) {
      state.vars = ownVars;
      this.invalidator.invalidateTree(node);
    }

    // var() 在此处展开：只有此时才知道当前节点可以取得哪些变量（包含继承）
    const resolved: MergedDeclaration[] = [];
    for (const decl of usable) {
      if (!usesVars(decl.value)) {
        resolved.push(decl);
        continue;
      }
      const expanded = resolveVars(decl.value, (name) => this.lookupVar(node, name));
      if (expanded === null) {
        if (ngDevMode) this.warn(
          CssCode.VarUnresolved,
          `"${decl.value}" 中的变量无法解析且未提供 fallback（${decl.property}），该条声明已丢弃。` +
            `如需默认值，请写作 var(--x, 默认值)。`,
          { prop: decl.property, value: decl.value },
        );
        continue;
      }
      resolved.push({ ...decl, value: expanded });
    }

    const toWrite: MergedDeclaration[] = [];
    /** 账本键 → 声明：用来判断哪些条目从本轮消失了 */
    const want = new Map<string, MergedDeclaration>();
    /**
     * 账本键 → 该槽胜者在合并序列里的位置。同一个槽被多条规则抢时，Map 记下的是它**首次**出现的
     * 位置，而胜者是最后写入的那条，因此整组重写时必须按这里的位置排写入顺序，
     * 否则低优先级的槽会反而后写。
     */
    const slotRank = new Map<string, number>();
    resolved.forEach((decl, index) => {
      const key = slotKey(decl.property, decl.statesKey);
      want.set(key, decl);
      slotRank.set(key, index);
    });

    // 条目消失 = 该 CSS 属性名下有 theme item 不再被声明。`clearProperty` 的粒度是整个属性名，
    // 只能整组撤销再整组重写。残留必须撤掉：否则引擎在那个状态下仍会读到上一轮的过期值。
    const regrouped = new Set<string>();
    for (const key of applied.keys()) {
      if (!want.has(key)) regrouped.add(propertyOfSlot(key));
    }
    /*
     * 基槽与状态槽写进同一个 theme item 时（`Label` 只有 font_color；font-size / constant 全类
     * 无状态变体），只写“变了的那一格”会让状态槽后写覆盖基槽，特异度与源码顺序全部不参与。
     * 因此同一属性名下有两格以上参与、且其中一格变了，就把整个属性名按级联顺序重写一遍：
     * 同一个 item 的最终归属由级联顺序决定（后写者赢），写在不同 item 上的槽重写一次也不改变结果。
     * 只有一格时仍直接覆盖：值本身就是它，先撤再写会多一次无意义的 clearProperty。
     */
    const slotCount = new Map<string, number>();
    for (const key of want.keys()) {
      const property = propertyOfSlot(key);
      slotCount.set(property, (slotCount.get(property) ?? 0) + 1);
    }
    for (const [key, decl] of want) {
      if (regrouped.has(decl.property)) continue;
      if (applied.get(key) === decl.value) continue;
      if ((slotCount.get(decl.property) ?? 1) > 1) regrouped.add(decl.property);
    }
    for (const [key, decl] of want) {
      if (regrouped.has(decl.property)) toWrite.push(decl); // 整组重写，连带重写
      else if (applied.get(key) !== decl.value) toWrite.push(decl);
    }
    if (toWrite.length > 1) {
      toWrite.sort((a, b) => slotRank.get(slotKey(a.property, a.statesKey))! - slotRank.get(slotKey(b.property, b.statesKey))!);
    }
    if (toWrite.length === 0 && regrouped.size === 0) {
      this.stats.skipped++;
      return false;
    }

    const warnings: CssWarnEntry[] = [];
    this.options.backend.bulk(node, () => {
      // 先撤销再写入：撤销时节点仍保持旧值，写入时不会被旧值覆盖
      for (const property of regrouped) {
        this.options.backend.clearProperty(node, property);
        for (const key of [...applied.keys()]) {
          if (propertyOfSlot(key) === property) applied.delete(key);
        }
        this.stats.cleared++;
      }
      for (const decl of toWrite) {
        // 必须调用 backend.applyProperty：ledger 按 CSS 属性名记账，绕过它相当于封死“完整撤销”这条路
        const known = this.options.backend.applyProperty(
          node,
          decl.property,
          decl.value,
          warnings,
          decl.states,
          // 字体登记仅存在于样式表文本中，因此只有经由样式表这条路径才能查到
          (family) => this.sheets.findFontFace(family)?.path ?? null,
        );
        if (!known) {
          if (ngDevMode) this.warn(CssCode.UnknownProperty, `样式 "${decl.property}" 在 Godot 侧没有对应实现，已丢弃`, {
            prop: decl.property,
          });
          continue;
        }
        applied.set(slotKey(decl.property, decl.statesKey), decl.value);
        this.stats.applied++;
      }
    });
    // 解析阶段的告警自带各自的码（颜色、长度、简写……），按码上报
    if (ngDevMode) for (const entry of warnings) this.warn(entry.code, entry.message);
    return true;
  }

  /**
   * 沿父链查找变量（CSS 的继承语义：子节点可见祖先的 `--x`，同名时自身的优先）。
   * 读取的是祖先**上一次写入时**的变量表——祖先变量变化会触发 invalidateTree，子节点下一轮就重算。
   */
  private lookupVar(node: CssNode, name: string): string | undefined {
    let current: CssNode | null = node;
    let hops = 0;
    while (current && hops++ < 64) {
      const value = this.states.get(current)?.vars.get(name);
      if (value !== undefined) return value;
      current = current.parent ?? null;
    }
    return undefined;
  }

  private warn(code: CssCode, message: string, detail?: CssWarnDetail, level?: WarnLevel): void {
    this.options.warn?.(new CssWarning(code, message, level, detail));
  }
}
