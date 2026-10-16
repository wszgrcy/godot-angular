import type { ChangeMap } from "../selector";
import type { CssNode, StyleBackend } from "../types";
import type { CombinatorFlags } from "./sheets";
import { NodeStates, TrackingClassSet, type NodeStyleState } from "./state";

/**
 * 来源：NativeScript/packages/core/ui/core/view-base/index.ts :: ViewBase._onCssStateChange
 *      + NativeScript/packages/core/ui/layouts/layout-base-common.ts :: LayoutBase._invalidateSiblingCssState
 *      + NativeScript/packages/core/ui/styling/style-scope.ts :: CssState 的 changeMap 订阅
 * 等级：仅思路一致（合成类）
 * 差异：上游的失效是“推”——属性 setter 直接触发重算，子树与兄弟靠事件厂广播；
 * Godot 侧属性赋值没有任何通知，因此改为“标脏 + 帧末统一拉取”，并额外维护
 * changeMap 的反向索引（上游只有正向的 changeMap，靠逐个订阅事件补救）。
 * 保留的契约：失效范围仍为自身 + 子树 + 兄弟 + 动态依赖者，且只在样式表确实用到
 * 后代 / 兄弟组合器时才展开。
 *
 * 谁需要重算：脏队列、失效范围、动态依赖的反向索引，以及帧末调度。
 */
export class Invalidator {
  /** 反向索引：被依赖的节点 → 依赖它的那些节点 */
  private readonly dependents = new Map<CssNode, Set<CssNode>>();
  private readonly dirty = new Set<CssNode>();
  /** 已 attach 的节点集合（WeakMap 不可遍历，需要遍历时用这个） */
  private readonly attachedSet = new Set<CssNode>();
  private flushScheduled = false;
  /**
   * 正在 flush。期间 `invalidate` 只入队不重复调度：本轮 flush 会把新入脏的节点一并
   * 处理完，另起一次空转的 flush 只会白跑一轮。收尾时由 `endFlush` 统一决定要不要补一次。
   */
  private flushing = false;

  constructor(
    private readonly states: NodeStates,
    private readonly backend: StyleBackend,
    private readonly flags: CombinatorFlags,
    private readonly schedule: ((flush: () => void) => void) | undefined,
    private readonly onFlush: () => void,
  ) {}

  /**
   * 来源：NativeScript/packages/core/ui/core/view-base/index.ts :: ViewBase.onLoaded（创建 CssState）
   * 等级：部分修改（主体一致）
   * 改动：上游在 onLoaded 里当场 lookupRulesets 并写入，本侧只登记与标脏。
   *
   * 登记一个节点：将 cssClasses 替换为 `TrackingClassSet`，并标脏等待下一轮 apply。
   *
   * class 必须在 attach 之后写入：原 `cssClasses` 中的内容不会迁移。生产路径上节点都是
   * 先创建后 attach（携带 class 进入的只有测试），为它保留一条无人使用的迁移分支并不值得。
   */
  attach(node: CssNode): void {
    if (!node) return;
    const state = this.states.of(node);
    if (!(node.cssClasses instanceof TrackingClassSet)) {
      node.cssClasses = new TrackingClassSet(() => this.invalidate(node));
    }
    state.attached = true;
    this.attachedSet.add(node);
    this.invalidate(node);
  }

  /**
   * 来源：NativeScript/packages/core/ui/core/view-base/index.ts :: ViewBase.onUnloaded（释放 _cssState）
   * 等级：部分修改（主体一致）
   * 改动：上游直接丢弃 CssState（事件订阅随之取消），本侧需显式摘除反向索引；
   * keepLedger 分支是本侧新增——Godot 的 reparent 不等于销毁，账本丢了就无法撤销已写样式。
   *
   * 节点离开级联：从强引用集合中移除。
   *
   * `keepLedger` 区分两种离开：
   *   - false（默认）：节点确实即将销毁（destroyNode），账本一并清除。
   *   - true：只是离开了树（reparent / ngIf 暂时移除）。账本必须保留，否则重新入树时
   *     diff 不知道此前写过什么，“应当撤销的那一条”就永远无法撤销。
   */
  detach(node: CssNode, keepLedger = false): void {
    const state = this.states.get(node);
    if (!state) return;
    for (const dep of state.dependencies) this.dependents.get(dep)?.delete(node);
    state.dependencies.clear();
    this.dependents.delete(node);
    this.dirty.delete(node);
    state.attached = false;
    if (!keepLedger) {
      state.applied.clear();
    }
    this.attachedSet.delete(node);
  }

  /**
   * 来源：NativeScript/packages/core/ui/core/view-base/index.ts :: ViewBase._onCssStateChange
   *      + NativeScript/packages/core/ui/layouts/layout-base-common.ts :: LayoutBase._invalidateSiblingCssState
   * 等级：部分修改（主体一致）
   * 相同：失效范围逐字对应（自身、子树、兄弟、动态依赖者）。
   * 改动：上游直接重算，本侧只入队；上游无条件展开子树，本侧先看 CombinatorFlags
   * （样式表未使用后代的组合器时不走树）。
   *
   * 标脏一个节点，连带它确实能影响到的范围：自身、子树（`.card .title`）、兄弟（`+` / `~`）、
   * changeMap 记录的动态依赖者。class 选择器是静态的、不进入 changeMap，只能依靠子树 / 兄弟覆盖；
   * 误标脏会被 diff 短路，不会多写入一个字节。两者只在样式表确实使用了组合器时才展开。
   */
  invalidate(node: CssNode): void {
    if (!node) return;
    this.markDirty(node);
    if (this.flags.subtreeSensitive) this.markSubtree(node);
    if (this.flags.siblingSensitive) {
      const parent = this.backend.parentOf(node);
      if (parent) for (const sibling of this.backend.childrenOf(parent)) this.markDirty(sibling);
    }
    const dependents = this.dependents.get(node);
    if (dependents) for (const dependent of dependents) this.markDirty(dependent);
    this.scheduleFlush();
  }

  /** 整棵子树标脏（appendChild / removeChild 之后可调用） */
  invalidateTree(root: CssNode): void {
    this.markSubtree(root);
    this.scheduleFlush();
  }

  /**
   * 来源：NativeScript/packages/core/ui/styling/style-scope.ts :: StyleScope._increaseApplicationCssSelectorVersion
   * 等级：部分修改（主体一致）
   * 改动：上游遍历 _cssSelectionsByView 逐个重查，本侧只把已登记节点入队。
   *
   * 全部已登记节点标脏
   */
  invalidateAll(): void {
    for (const node of this.attachedSet) this.markDirty(node);
    this.scheduleFlush();
  }

  /** 已登记的节点（新样式表引入新伪类时，运行时要为存量节点补连信号） */
  attachedNodes(): Iterable<CssNode> {
    return this.attachedSet;
  }

  /** 是否待重算（验证“定向失效有没有误伤”依赖它） */
  isDirty(node: CssNode): boolean {
    return this.dirty.has(node);
  }

  /** 谁依赖了这个节点的状态（changeMap 的反向视图） */
  dependentsOf(node: CssNode): CssNode[] {
    return [...(this.dependents.get(node) ?? [])];
  }

  /**
   * 来源：无
   *
   * 本轮需要处理的节点，已按“父先于子”排好；取走即清空队列
   */
  takeDirty(): CssNode[] {
    if (!this.dirty.size) return [];
    const nodes = [...this.dirty];
    this.dirty.clear();
    // 父先于子：子节点的匹配常依赖父链（`.card .title`），父先算完子节点就不需要返工
    nodes.sort((a, b) => depth(a) - depth(b));
    return nodes;
  }

  /** 从队列中移除一个节点（`applyNow` 已经将它计算完成） */
  drop(node: CssNode): void {
    this.dirty.delete(node);
  }

  /**
   * 来源：NativeScript/packages/core/ui/styling/style-scope.ts :: CssState.subscribeForDynamicUpdates
   *      + ChangeMap / Changes
   * 等级：部分修改（主体一致）
   * 相同：changeMap 的语义相同（本次匹配读了哪些其他节点的状态），并且都须先清理已失效的
   * 旧依赖再登记新依赖。
   * 改动：上游为每个依赖节点注册一个事件订阅（节点数×依赖数个监听器），本侧只维护一张
   * 反向 Map，失效时查表调用，不养任何监听器。
   *
   * 记录已落地的依赖：下一次这些节点变化时，本节点需要跟随重算
   */
  updateDependencies(node: CssNode, state: NodeStyleState, changeMap: ChangeMap): void {
    for (const dep of state.dependencies) {
      if (!changeMap.has(dep)) this.dependents.get(dep)?.delete(node);
    }
    state.dependencies.clear();
    for (const dep of changeMap.keys()) {
      if (dep === node) continue;
      let set = this.dependents.get(dep);
      if (!set) this.dependents.set(dep, (set = new Set()));
      set.add(node);
      state.dependencies.add(dep);
    }
  }

  /**
   * 来源：无
   */
  private markDirty(node: CssNode): void {
    // 父链只在这一处入口维护：选择器的 `>` / 空格 / `+` 回溯读取的是 `node.parent` 这个 JS
    // 字段，而 Godot 节点只有 `get_parent()`；变量继承也走同一条链。每次标脏时重读一次，
    // 重新挂父（move_child / 更换容器）后父链才不会是旧值。
    const parent = this.backend.parentOf(node) as CssNode | null;
    node.parent = parent ?? null;
    const state = this.states.of(node);
    state.dirty = true;
    this.dirty.add(node);
  }

  /**
   * 来源：NativeScript/packages/core/ui/core/view-base/index.ts :: ViewBase._onCssStateChange 的子树部分
   * 等级：部分修改（主体一致）
   * 改动：上游递归调用子节点的 onCssStateChange（带 _changingCnt 防重入），本侧改为显式
   * 栈迭代（脏集合本身就是幂等的，不需要计数器）。
   */
  private markSubtree(root: CssNode): void {
    const stack: CssNode[] = [root];
    while (stack.length) {
      const node = stack.pop() as CssNode;
      this.markDirty(node);
      for (const child of this.backend.childrenOf(node)) stack.push(child);
    }
  }

  /**
   * 来源：NativeScript/packages/core/ui/core/view-base/index.ts :: ViewBase._batchUpdate
   *      的批处理计数（CssState 用它合并一次同步调用栈内的重算）
   * 等级：仅思路一致
   * 差异：上游的批处理靠 _changingCnt 在同步调用栈内合并，本侧改为帧末异步调度（可注入）。
   */
  private scheduleFlush(): void {
    // flush 内部产生的脏交给 endFlush，不在这里抢排下一次调度
    if (this.flushing) return;
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    if (this.schedule) this.schedule(this.onFlush);
  }

  /**
   * 来源：无
   *
   * flush 开始：进入「不再重复调度」区间。必须在 `takeDirty()` 之前调。
   */
  beginFlush(): void {
    this.flushing = true;
  }

  /**
   * 来源：无
   *
   * flush 收尾：退出区间，并补上期间新入脏的节点。
   *
   * 队列已排空（状态跃迁在本轮内收敛）时**不**另起一次空转的 flush；确实还有残留
   * （`applyNode` 里 `var()` 变化触发的 `invalidateTree`）才补排一次，那一轮是有活的。
   */
  endFlush(): void {
    this.flushing = false;
    // 先释放调度权：本轮期间被 `scheduleFlush` 拦下的那些脏节点，现在才有机会排上去
    this.flushScheduled = false;
    if (this.dirty.size > 0) this.scheduleFlush();
  }
}

/**
 * 来源：无
 *
 * 节点深度（父链长度），组合器回溯使用同一套 parent 字段
 */
function depth(node: CssNode): number {
  let n = 0;
  let current = node.parent;
  while (current) {
    n++;
    current = current.parent;
  }
  return n;
}
