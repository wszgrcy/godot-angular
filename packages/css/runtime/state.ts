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
  /** 已落地的声明：CSS 属性名 → 落地时的原始值（diff 的唯一依据） */
  readonly applied: Map<string, string>;
  /** 内联声明（`[style.x]` 绑定）：优先级高于样式表的普通声明，低于 `!important` */
  readonly inline: Map<string, string>;
  /** 已登记（attach 过）：未登记的节点不参与全量重算 */
  attached: boolean;
  dirty: boolean;
  /** 上一次匹配依赖了哪些节点（清理 dependents 反向索引要用） */
  dependencies: Set<CssNode>;
  /**
   * 上一次落地时节点处于哪些伪类状态（排序后的名称串）。
   * diff 只看值是否变化，但状态变了而值未变时也需要重写：`.btn{background:blue}` 与
   * `.btn:hover{background:blue}` 前后都是 blue，要写入的 item 却从 `normal` 换成了 `hover`。
   */
  appliedStates: string;
  /** 本节点当前的自定义属性表（不包含继承）：`var()` 展开的第一站，也是变量继承的比对依据 */
  vars: Map<string, string>;
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
 * 节点当前伪类签名的稳定形式（空集 = 空串），diff 用它识别“值未变但 item 已更换”
 */
export function pseudoSignature(node: CssNode): string {
  const set = node.cssPseudoClasses;
  if (!(set instanceof Set) || set.size === 0) return "";
  return [...set].sort().join(",");
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
        appliedStates: "",
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
