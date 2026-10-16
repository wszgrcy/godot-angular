import type { CssNode } from "../types";

/**
 * 来源：NativeScript/packages/core/ui/styling/style-scope.ts :: CssState（字段部分）
 * 等级：部分修改（主体一致）
 * 相同：都需记录“当前处于哪些伪类”与“匹配依赖了哪些节点”（对应上游的 cssPseudoClasses
 * 与 changeMap 订阅）。
 * 改动：上游的状态直接挂在 View 上（_cssState 字段）且靠 GC 回收，本侧集中存在 WeakMap；
 * applied / vars 两个账本本侧新增——上游写入 Style 属性时不做相等比较，无需上一轮基准。
 *
 * 单个节点上由本库记录的状态
 */
export interface NodeStyleState {
  /**
   * 已落地的声明：账本键 → 落地时的原始值（diff 的唯一依据）。
   *
   * 一个 CSS 属性名可以对应多条落地声明（基规则与各个状态规则各占一个 theme item），
   * 所键是 `\u0000` 分隔的 `属性名 + 选择器要求的状态串`（见 `slotKey`）。
   */
  readonly applied: Map<string, string>;
  /** 内联声明（`[style.x]` 绑定）：优先级高于样式表的普通声明，低于 `!important` */
  readonly inline: Map<string, string>;
  /** 已登记（attach 过）：未登记的节点不参与全量重算 */
  attached: boolean;
  dirty: boolean;
  /** 上一次匹配依赖了哪些节点（清理 dependents 反向索引要用） */
  dependencies: Set<CssNode>;
  /** 本节点当前的自定义属性表（不包含继承）：`var()` 展开的第一站，也是变量继承的比对依据 */
  vars: Map<string, string>;
}

/** 账本键的分隔符：CSS 属性名与伪类名均不可能包含 NUL */
export const SLOT_SEP = "\u0000";

/**
 * 来源：无
 *
 * 状态集的稳定串（排序后拼接，空集 = 空串）。同一个状态集必须总是得到同一个串，
 * 否则 diff 会把它当成新条目。
 */
export function statesKey(states: ReadonlySet<string>): string {
  return states.size === 0 ? "" : [...states].sort().join(",");
}

/** 一条落地声明在账本里的键 */
export function slotKey(property: string, states: string): string {
  return states ? property + SLOT_SEP + states : property;
}

/** 从账本键取回 CSS 属性名（`clearProperty` 的粒度是属性名，需要按它归组） */
export function propertyOfSlot(key: string): string {
  const at = key.indexOf(SLOT_SEP);
  return at < 0 ? key : key.slice(0, at);
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: Declaration（合并后的形态）
 * 等级：部分修改（主体一致）
 * 改动：上游合并过后的声明就是普通 Declaration，不区分来源；本侧额外标记 inline，
 * 因为内联与 !important 的三层优先级在本侧是真实存在的（上游剔除了 !important）。
 *
 * 一条已排序待应用的声明（合并后的产物）
 */
export interface MergedDeclaration {
  property: string;
  value: string;
  /** 来自内联而不是样式表 */
  inline: boolean;
  /**
   * 命中的那条选择器**自身要求**的状态伪类（`:hover` / `:disabled` …），基规则与内联为空集。
   *
   * 它直接决定落点：状态 item 由「选择器要求了哪个状态」推出来，而不是由「节点当前处于
   * 哪些状态」猜出来。两者差别很大：后者需要知道引擎在 hover+focus 同时成立时究竟读哪个
   * item（无文档保证），前者不需要——每个状态各自写自己的 item，引擎读哪个都拿到正确值。
   *
   * 副作用是残留自然消失：一个 item 只有一个主人，规则不再命中时它的账本键也就消失了。
   */
  states: ReadonlySet<string>;
  /** `statesKey(states)` 的缓存，参与账本键，避免每轮重算重复排序 */
  statesKey: string;
}

/**
 * 来源：NativeScript/packages/core/ui/core/view-base/index.ts :: ViewBase.cssClasses（普通 Set）
 *      + NativeScript/packages/core/ui/styling/style-scope.ts :: CssState 对集合变更的订阅
 * 等级：仅思路一致
 * 差异：上游的 cssClasses 是普通 Set，变更由 className 等 setter 主动调 _onCssStateChange 触发；
 * 本侧无响应式集合基础设施，改为继承 Set 并直接回调 invalidate。行为契约相同：
 * 集合变化必须自动标脏，调用方不得自行提醒。
 *
 * 会发出通知的 class 集合：普通 Set 被修改后无人感知，级联就永远不会被标脏，
 * 因此 attach 时替换为这个子类，把每次增删直接接到 invalidate 上。
 *
 * 对外只以类型身份导出（见 index.ts）：看到 `TrackingClassSet` 就应当知道“此处 add()
 * 会直接标脏节点”，不需要也不应该自行构造它。
 */
export class TrackingClassSet extends Set<string> {
  constructor(private readonly onChange: () => void) {
    super();
  }
  override add(value: string): this {
    if (!this.has(value)) {
      super.add(value);
      this.onChange();
    }
    return this;
  }
  override delete(value: string): boolean {
    const removed = super.delete(value);
    if (removed) this.onChange();
    return removed;
  }
  override clear(): void {
    if (this.size === 0) return;
    super.clear();
    this.onChange();
  }
}

/**
 * 来源：无
 *
 * 状态存放处。WeakMap 是默认存放处，`stashState` 那条兜底通道见文件末尾。
 *
 * 单独成类而不是分散在调用方：失效调度、变量继承、落地三处都要读取同一份状态，
 * 任何一方都不应自行持有一份 Map。
 */
export class NodeStates {
  private readonly states = new WeakMap<CssNode, NodeStyleState>();

  /** 取得状态，不存在则创建一个空状态 */
  of(node: CssNode): NodeStyleState {
    let state = this.states.get(node);
    if (!state) {
      state = {
        applied: new Map(),
        inline: new Map(),
        attached: false,
        dirty: false,
        dependencies: new Set(),
        vars: new Map(),
      };
      this.states.set(node, state);
    }
    return state;
  }

  get(node: CssNode): NodeStyleState | undefined {
    return this.states.get(node);
  }
}

/**
 * 来源：无
 *
 * 将状态额外挂载一份到节点自身（GodotJS 节点可挂载自定义 JS 属性）。
 * WeakMap 是默认存放处，这里只是**兜底通道**：包装对象身份不稳定时可以从节点本体取回。
 */
const STASH_KEY = "__cujStyleState";

export function stashState(node: CssNode, state: NodeStyleState): void {
  (node as Record<string, unknown>)[STASH_KEY] = state;
}

export function readStashedState(node: CssNode): NodeStyleState | undefined {
  return (node as Record<string, unknown>)[STASH_KEY] as NodeStyleState | undefined;
}
