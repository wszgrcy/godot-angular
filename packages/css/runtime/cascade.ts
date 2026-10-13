import { compareSelectors } from "../selector";
import type { SelectorCore } from "../selector";
import type { CssNode, Declaration, MediaEnvironment, StyleBackend } from "../types";
import { Invalidator } from "./invalidation";
import {
  NodeStates,
  TrackingClassSet,
  pseudoSignature,
  type MergedDeclaration,
  type NodeStyleState,
} from "./state";
import { SheetRegistry } from "./sheets";
import { resolveVars, sameVars, usesVars } from "./vars";
import type { SelectorTier } from "../types";

export type { MergedDeclaration, NodeStyleState } from "./state";
export type { TrackingClassSet } from "./state";

/**
 * 来源：无
 */
export interface CascadeOptions {
  backend: StyleBackend;
  /** 媒体查询环境。**由调用方注入**，本包不读取 DisplayServer */
  env?: MediaEnvironment;
  /** 帧末调度的注入点：引擎侧提供 rAF，不提供则只能手动 flush */
  schedule?: (flush: () => void) => void;
  /** 告警出口，不提供则静默 */
  warn?: (key: string, message: string) => void;
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
 * 来源：NativeScript/packages/core/ui/styling/style-scope.ts :: StyleScope
 *      + NativeScript/packages/core/ui/styling/style-scope.ts :: CssState
 * 等级：仅思路一致（合成类）
 * 差异：上游 StyleScope 同时管样式表文本、解析、作用域与屏幕变化；CssState 同时管匹配、
 * 合并与写入，两者靠事件订阅耦合。本侧拆为 Cascade / SheetRegistry / Invalidator 三块，
 * 并改为“脏队列 + 帧末 flush”拉模型（上游是属性 setter 当场重算）。
 * 保留的契约：级联只在 longhand 上定义、匹配结果按特异度/层级/源码顺序排序、
 * 动态伪类变化只重算受影响节点。
 *
 * 级联：将「已登记的样式表」落到「已登记的节点」上。
 *
 * 三段分工（对应 NativeScript 的 StyleScope / 失效通知 / CssState）：
 *   - `SheetRegistry`（sheets.ts）：样式表与由样式表推出的元信息
 *   - `Invalidator`（invalidation.ts）：谁需要重算、什么时候重算
 *   - 本文件：匹配 → 合并 → diff → 写入，以及变量继承
 *
 * 只重算单个节点时走 `applyNow`，批量则走帧末 `flush`。
 */
export class Cascade {
  private readonly states = new NodeStates();
  private readonly sheets: SheetRegistry;
  private readonly invalidator: Invalidator;

  readonly stats: CascadeStats = { flushes: 0, applied: 0, cleared: 0, nodes: 0, skipped: 0 };

  constructor(private readonly options: CascadeOptions) {
    this.sheets = new SheetRegistry(options.env ?? {}, (key, message) => this.warn(key, message));
    this.invalidator = new Invalidator(
      this.states,
      options.backend,
      this.sheets,
      options.schedule,
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
   * 改动：上游在 onLoaded 里直接 lookupRulesets 并一次性应样式，本侧只标脏，写入推到帧末；
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
   * 将全部脏节点落一遍。帧末由调度器调用，测试中手动调用
   */
  flush(): number {
    const nodes = this.invalidator.takeDirty();
    if (!nodes.length) return 0;
    let touched = 0;
    for (const node of nodes) {
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
   * 改动：上游是“样式表变了，全量重查并写入”，本侧是单节点即时重算（不等待帧末）。
   *
   * 立即重算一个节点（不等待帧末）。返回是否确实写入了节点
   */
  applyNow(node: CssNode): boolean {
    const state = this.states.of(node);
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

    const merged = new Map<string, MergedDeclaration>();
    /** delete 再 set：Map.set 对已存在的键**不挪动位置**，而这里的顺序就是级联顺序 */
    const put = (decl: Declaration, inline: boolean) => {
      merged.delete(decl.property);
      merged.set(decl.property, { property: decl.property, value: decl.value, inline });
    };
    const normal: Declaration[] = [];
    const important: Declaration[] = [];
    for (const selector of selectors) {
      for (const decl of declarations.get(selector) ?? []) {
        (decl.important ? important : normal).push(decl);
      }
    }
    // 普通(按级联) → 内联 → !important(按级联)：CSS 定义的三层顺序，important 不能只记录成集合，
    // 否则特异度高的普通声明会覆盖它。
    for (const decl of normal) put(decl, false);
    for (const [property, value] of state.inline) {
      if (important.some((decl) => decl.property === property)) continue;
      merged.delete(property);
      merged.set(property, { property, value, inline: true });
    }
    for (const decl of important) put(decl, false);
    return [...merged.values()];
  }

  /**
   * 来源：NativeScript/packages/core/ui/core/view-base/index.ts :: ViewBase._onCssStateChange 的写入段
   *      + CssState.setPropertyValues 的“只写变化项”部分
   * 等级：仅思路一致
   * 差异：上游把合并后的声明逐个赋给 Style 属性（属性自身不做相等比较，写多少算多少）；
   * 本侧与上一轮账本 diff，只写真正变化的属性，并对“不再命中”的属性显式清除（Godot 的
   * theme override 不会自动回落）。变量继承与 var() 展开也是本侧新增（上游在解析期代入）。
   *
   * 实际写入节点的一段。返回是否发生了写入
   */
  private applyNode(node: CssNode, state: NodeStyleState): boolean {
    const merged = this.merge(node, state);
    const applied = state.applied;

    // 自定义属性拆出来作为变量环境，不作为普通属性（它们没有落点，落点是引用它们的那些值）
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
        this.warn(
          `var:${decl.property}:${decl.value}`,
          `"${decl.value}" 中的变量无法解析且未提供 fallback（${decl.property}），该条声明已忽略。` +
            `如需默认值，请写作 var(--x, 默认值)。`,
        );
        continue;
      }
      resolved.push({ ...decl, value: expanded });
    }

    const toApply: MergedDeclaration[] = [];
    const toClear: string[] = [];
    const states = pseudoSignature(node);
    const stateChanged = states !== state.appliedStates;
    for (const decl of resolved) {
      if (stateChanged || applied.get(decl.property) !== decl.value) toApply.push(decl);
    }
    const mergedProps = new Set(resolved.map((decl) => decl.property));
    for (const property of applied.keys()) {
      if (!mergedProps.has(property)) toClear.push(property);
    }
    if (!toApply.length && !toClear.length) {
      state.appliedStates = states;
      this.stats.skipped++;
      return false;
    }

    const warnings: string[] = [];
    this.options.backend.bulk(node, () => {
      // 先撤销再写入：撤销时节点仍保持旧值，写入时不会被旧值覆盖
      for (const property of toClear) {
        this.options.backend.clearProperty(node, property);
        applied.delete(property);
        this.stats.cleared++;
      }
      for (const decl of toApply) {
        // 必须调用 backend.applyProperty：ledger 按 CSS 属性名记账，绕过它相当于封死“完整撤销”这条路
        const known = this.options.backend.applyProperty(node, decl.property, decl.value, warnings);
        if (!known) {
          this.warn(`unknown:${decl.property}`, `样式 "${decl.property}" 无 Godot 对应，已忽略`);
          continue;
        }
        applied.set(decl.property, decl.value);
        this.stats.applied++;
      }
    });
    for (const message of warnings) this.warn(`value:${message}`, message);
    state.appliedStates = states;
    return true;
  }

  /**
   * 沿父链查找变量（CSS 的继承语义：子节点可见祖先的 `--x`，同名时自身的优先）。
   * 读取的是祖先**上一次落地时**的变量表——祖先变量变化会触发 invalidateTree，子节点下一轮就重算。
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

  private warn(key: string, message: string): void {
    this.options.warn?.(key, message);
  }
}
