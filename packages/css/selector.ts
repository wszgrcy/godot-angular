import type { CssNode } from "./types";
import { SelectorTier } from "./types";

/** 开发模式标记：生产构建中整个 `if (ngDevMode)` 分支连同告警文案一并消除（口径见 runtime/properties.ts） */

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: Specificity
 * 等级：部分修改（主体一致）
 * 改动：删除 Zero=0（`:where` 直接取 Universal）；const enum 改为导出 enum，
 * 使诊断代码能在运行时读取；保留 SelectorListHighest 的取值约定。
 */
/* eslint-disable @typescript-eslint/no-duplicate-enum-values */
export enum Specificity {
  Inline = 1000,
  Id = 100,
  Attribute = 10,
  Class = 10,
  PseudoClass = 10,
  Type = 1,
  Universal = 0,
  Invalid = 0,
  /** 取参数列表中最高的那个特异度（:is / :not） */
  SelectorListHighest = -1,
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: Rarity
 * 等级：部分修改（主体一致）
 * 改动：删除未使用的 Inline=0；其余取值与用途（head 选择、组合器分组）相同。
 */
export enum Rarity {
  Invalid = 4,
  Id = 3,
  Class = 2,
  Type = 1,
  PseudoClass = 0,
  Attribute = 0,
  Universal = 0,
}
/* eslint-enable @typescript-eslint/no-duplicate-enum-values */

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: Combinator
 * 等级：部分修改（主体一致）
 * 改动：删除上游标记为不支持的 parent('<') 与 column-combinator('||')。
 */
export enum Combinator {
  descendant = " ",
  child = ">",
  adjacent = "+",
  sibling = "~",
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: PseudoClassSelector
 * 等级：仅思路一致
 * 差异：上游对任意 `:x` 都生成 PseudoClassSelector 并读取 view.cssPseudoClasses，
 * 名单由原生控件的 visualState 决定，名单外的伪类静默永不命中；本表是显式白名单，
 * 名单外一律 InvalidSelector 并告警。原因：Godot 侧只有少数信号能驱动伪类，
 * 「写了不生效」与「这个伪类不存在」必须区分开。
 *
 * 能落到 Godot 状态上的伪类，由信号驱动写入 `node.cssPseudoClasses`。
 * 名单之外的伪类一律归为 InvalidSelector 并告警——静默忽略比报错更难定位。
 */
export const SUPPORTED_PSEUDO_CLASSES: ReadonlySet<string> = new Set([
  "hover",
  "active",
  "focus",
  "checked",
  "disabled",
  "enabled",
  "pressed",
  "selected",
  "indeterminate",
  "read-only",
  "required",
  "optional",
  "valid",
  "invalid",
]);

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: createSimpleSelectorFromAst
 * 等级：部分修改（主体一致）
 * 改动：上游为 is / where / not 各建一个子类，此处收敛为名单 + 单类；追加 matches 别名；
 * 上游把 :has() / :nth-child() 之类退化成普通 PseudoClassSelector（静默不命中），
 * 此处显式判为 InvalidSelector。
 *
 * 函数式伪类：参数为选择器列表
 */
const FUNCTIONAL_PSEUDOS: ReadonlySet<string> = new Set(["not", "is", "where", "matches"]);

// ---------------------------------------------------------------- 失效追踪

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: Changes / ChangeMap
 * 等级：部分修改（主体一致）
 * 改动：ChangeMap 去掉泛型参数（节点类型已收敛为 CssNode）。
 */
export interface Changes {
  attributes?: Set<string>;
  pseudoClasses?: Set<string>;
}

export type ChangeMap = Map<CssNode, Changes>;

const emptyChangeMap: ChangeMap = new Map();

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: SelectorsMatch
 * 等级：部分修改（主体一致）
 * 改动：去掉泛型参数；properties 转为私有；selectors 默认空数组。
 * addAttribute / addPseudoClass / properties 的惰性建表逻辑（共享 emptyChangeMap，
 * 首次写入才 materialize）逐字保留。
 *
 * 匹配结果：命中的选择器（已按级联顺序排好）+ 它依赖了哪些节点的哪些状态
 */
export class SelectorsMatch {
  selectors: SelectorCore[] = [];
  changeMap: ChangeMap = emptyChangeMap;

  addAttribute(node: CssNode, attribute: string): void {
    const deps = this.properties(node);
    if (!deps.attributes) deps.attributes = new Set();
    deps.attributes.add(attribute);
  }

  addPseudoClass(node: CssNode, pseudoClass: string): void {
    const deps = this.properties(node);
    if (!deps.pseudoClasses) deps.pseudoClasses = new Set();
    deps.pseudoClasses.add(pseudoClass);
  }

  private properties(node: CssNode): Changes {
    if (this.changeMap === emptyChangeMap) this.changeMap = new Map();
    let set = this.changeMap.get(node);
    if (!set) this.changeMap.set(node, (set = {}));
    return set;
  }
}

// ---------------------------------------------------------------- 选择器基类

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: SelectorBase + SelectorCore
 * 等级：部分修改（主体一致）
 * 改动：上游的两层抽象基类合并为一层；删除 combinator（组合符改由 ComplexSelector.parts
 * 携带）与 ruleset（声明挂在规则集上，由 runtime/sheets.ts 维护映射）；新增
 * tracksAncestors。accumulateChanges 自 SimpleSelector 上移，判定逻辑逐字未改；
 * lookupSort 的默认实现逐字未改。
 */
export abstract class SelectorCore {
  /** 求和后的特异度不是枚举成员，所以字段类型是 number */
  specificity: number = Specificity.Universal;
  rarity = Rarity.Universal;
  /** 依赖节点的可变状态（伪类 / 属性），匹配结果会随时间变 */
  dynamic = false;
  hasAdjacentCombinator = false;
  hasSiblingCombinator = false;
  /** 该选择器**自身**的动态部分是否仅位于最右侧序列（可精确追踪失效） */
  tracksAncestors = false;

  /** 源码顺序（在同一棵索引内编号） */
  pos = 0;
  tier: SelectorTier = SelectorTier.Application;

  abstract match(node: CssNode): boolean;
  abstract toString(): string;

  mayMatch(node: CssNode): boolean {
    return this.match(node);
  }

  trackChanges(_node: CssNode, _map: SelectorsMatch): void {}

  /** 静态选择器直接返回匹配结果；动态选择器返回“可能匹配”并将依赖记入 map */
  accumulateChanges(node: CssNode, map: SelectorsMatch): boolean {
    if (!this.dynamic) return this.match(node);
    if (this.mayMatch(node)) {
      this.trackChanges(node, map);
      return true;
    }
    return false;
  }

  lookupSort(sorter: LookupSorter, base?: SelectorCore): void {
    sorter.sortAsUniversal(base ?? this);
  }
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: SimpleSelector
 * 等级：仅思路一致
 * 差异：上游在此类上给出 accumulateChanges / mayMatch / trackChanges 的默认实现，
 * 本实现已将三者上移到 SelectorCore，此处只保留「简单选择器」这一类型分层。
 */
export abstract class SimpleSelector extends SelectorCore {}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: InvalidSelector
 * 等级：部分修改（主体一致）
 * 改动：字段 e 改名 error；toString 不再拼接 combinator；lookupSort 的空实现相同
 * （无效选择器不入索引）。
 */
export class InvalidSelector extends SimpleSelector {
  constructor(readonly error: Error) {
    super();
    this.specificity = Specificity.Invalid;
    this.rarity = Rarity.Invalid;
  }
  override toString(): string {
    return `<${this.error.message}>`;
  }
  override match(): boolean {
    return false;
  }
  /** 无效选择器不进入索引——它永远不会命中，放入桶内只会拖慢查询 */
  override lookupSort(): void {}
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: UniversalSelector
 * 等级：部分修改（主体一致）
 * 改动：toString 不再拼接 combinator；其余（恒匹配、特异度与桶归属）相同。
 */
export class UniversalSelector extends SimpleSelector {
  constructor() {
    super();
    this.specificity = Specificity.Universal;
    this.rarity = Rarity.Universal;
  }
  override toString(): string {
    return "*";
  }
  override match(): boolean {
    return true;
  }
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: IdSelector
 * 等级：部分修改（主体一致）
 * 改动：仅 toString 不再拼接 combinator；match 与 lookupSort 逐字相同。
 */
export class IdSelector extends SimpleSelector {
  constructor(readonly id: string) {
    super();
    this.specificity = Specificity.Id;
    this.rarity = Rarity.Id;
  }
  override toString(): string {
    return `#${this.id}`;
  }
  override match(node: CssNode): boolean {
    return node.id === this.id;
  }
  override lookupSort(sorter: LookupSorter, base?: SelectorCore): void {
    sorter.sortById(this.id, base ?? this);
  }
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: TypeSelector
 * 等级：部分修改（主体一致）
 * 改动：上游在 AST 转换处做 `replace('-', '').toLowerCase()`，此处改为匹配时两侧归一
 * 小写且不再删连字符；另增加 cssType 为空时不匹配的保护。
 *
 * 元素选择器：落点 = 节点类名（Godot 没有可写的 theme_type），大小写不敏感
 */
export class TypeSelector extends SimpleSelector {
  constructor(readonly cssType: string) {
    super();
    this.specificity = Specificity.Type;
    this.rarity = Rarity.Type;
  }
  override toString(): string {
    return this.cssType;
  }
  override match(node: CssNode): boolean {
    return !!node.cssType && node.cssType.toLowerCase() === this.cssType;
  }
  override lookupSort(sorter: LookupSorter, base?: SelectorCore): void {
    sorter.sortByType(this.cssType, base ?? this);
  }
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: ClassSelector
 * 等级：部分修改（主体一致）
 * 改动：仅额外加 cssClasses 为空时的短路；match 与 lookupSort 逐字相同。
 */
export class ClassSelector extends SimpleSelector {
  constructor(readonly cssClass: string) {
    super();
    this.specificity = Specificity.Class;
    this.rarity = Rarity.Class;
  }
  override toString(): string {
    return `.${this.cssClass}`;
  }
  override match(node: CssNode): boolean {
    return !!node.cssClasses && node.cssClasses.has(this.cssClass);
  }
  override lookupSort(sorter: LookupSorter, base?: SelectorCore): void {
    sorter.sortByClass(this.cssClass, base ?? this);
  }
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: AttributeSelectorOperator
 * 等级：部分修改（主体一致）
 * 改动：七个操作符及其字符串值逐字相同，仅由 enum 改为操作符 → 测试名的查表对象，
 * 以便未知名能直接落入告警分支。
 */
type AttributeTest = "exists" | "equals" | "start" | "end" | "any" | "element" | "hyphen";

const ATTRIBUTE_OPERATORS: Record<string, AttributeTest> = {
  "": "exists",
  "=": "equals",
  "^=": "start",
  "$=": "end",
  "*=": "any",
  "~=": "element",
  "|=": "hyphen",
};

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: AttributeSelectorOperator
 * 等级：完全来自（一字未改）
 */
const ATTRIBUTE_OPERATOR_TEXT: Record<string, string> = {
  equals: "=",
  start: "^=",
  end: "$=",
  any: "*=",
  element: "~=",
  hyphen: "|=",
};

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: AttributeSelector
 * 等级：部分修改（主体一致）
 * 相同：七种测试的判定逐条对应；构造时归一大小写一次的优化也在（上游直接覆写
 * this.value，此处改为单独的 normalizedValue）。
 * 改动：
 *   1. mayMatch 改为严格求值（上游恒返 true）——见下方方法注释；
 *   2. trackChanges 不再探测属性是否发通知（上游 attributeNotifiesChanges），
 *      本项目的失效模型是改动方显式 invalidate；
 *   3. element 测试按 `\s+` 分词（上游只按单个空格）。
 */
export class AttributeSelector extends SimpleSelector {
  private readonly normalizedValue: string;

  constructor(
    readonly attribute: string,
    readonly test: AttributeTest,
    readonly value: string,
    readonly ignoreCase: boolean,
  ) {
    super();
    this.specificity = Specificity.Attribute;
    this.rarity = Rarity.Attribute;
    this.dynamic = true;
    // 大小写不敏感时仅在构造时归一一次，不在每次匹配时计算
    this.normalizedValue = ignoreCase && value ? value.toLowerCase() : value;
  }

  override toString(): string {
    if (this.test === "exists") return `[${this.attribute}]`;
    const op = ATTRIBUTE_OPERATOR_TEXT[this.test] ?? this.test;
    return `[${this.attribute}${op}${this.value}${this.ignoreCase ? " i" : ""}]`;
  }

  override match(node: CssNode): boolean {
    const raw = (node as Record<string, unknown>)[this.attribute];
    if (this.test === "exists") return raw !== undefined && raw !== null;
    if (!this.value) return false;
    let attr = String(raw);
    if (this.ignoreCase) attr = attr.toLowerCase();
    const want = this.normalizedValue;
    switch (this.test) {
      case "equals":
        return attr === want;
      case "start":
        return attr.startsWith(want);
      case "end":
        return attr.endsWith(want);
      case "any":
        return attr.includes(want);
      case "element":
        return attr.split(/\s+/).includes(want);
      case "hyphen":
        return attr === want || attr.startsWith(`${want}-`);
      default:
        return false;
    }
  }

  /**
   * 属性缺失一律不匹配（严格求值）：`_ngcontent-*` 这类标记由渲染器直接赋值为普通 JS 属性、
   * 没有变更通知，“当前没有这个属性”若先当作候选就永远当作候选——组件样式隔离会直接失效。
   * 失效模型是改动方显式 invalidate，不依赖 mayMatch 放宽判定。
   */
  override mayMatch(node: CssNode): boolean {
    return this.match(node);
  }

  override trackChanges(node: CssNode, map: SelectorsMatch): void {
    map.addAttribute(node, this.attribute);
  }
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: PseudoClassSelector
 * 等级：部分修改（主体一致）
 * 改动：mayMatch 改为严格求值（上游恒返 true）；其余逐字相同。
 */
export class PseudoClassSelector extends SimpleSelector {
  constructor(readonly cssPseudoClass: string) {
    super();
    this.specificity = Specificity.PseudoClass;
    this.rarity = Rarity.PseudoClass;
    this.dynamic = true;
  }
  override toString(): string {
    return `:${this.cssPseudoClass}`;
  }
  override match(node: CssNode): boolean {
    return !!node.cssPseudoClasses && node.cssPseudoClasses.has(this.cssPseudoClass);
  }

  /** 同上：伪类由 `setPseudoClass` 显式标脏重算，不能当作“可能命中”放过 */
  override mayMatch(node: CssNode): boolean {
    return this.match(node);
  }
  override trackChanges(node: CssNode, map: SelectorsMatch): void {
    map.addPseudoClass(node, this.cssPseudoClass);
  }
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: FunctionalPseudoClassSelector
 *      及其子类 NotFunctionalPseudoClassSelector / IsFunctionalPseudoClassSelector /
 *      WhereFunctionalPseudoClassSelector
 * 等级：部分修改（主体一致）
 * 改动：上游的「抽象基类 + 三个子类 + 装饰器写入特异度」压成一个按 name 分支的类；
 * 特异度规则（:is / :not 取参数最高值、:where 恒为 0）与 dynamic 汇总逐字对应。
 * 丢弃：forgiving selector list（`:is()` 参数中一条无效则整条选择器作废，仅 :is/:where
 * 可忽略），以及单子选择器时直接借用参数分桶的 lookupSort 短路。
 *
 * `:not()` / `:is()` / `:where()` —— 参数是完整选择器列表
 */
export class FunctionalPseudoClassSelector extends SimpleSelector {
  readonly args: SelectorCore[];

  constructor(
    readonly name: string,
    args: SelectorCore[],
  ) {
    super();
    this.args = args;
    // 特异度按规范计算：:is() / :not() 取参数中最高的那一条，:where() 恒为 0
    const highest = args.reduce((max, sel) => Math.max(max, sel.specificity), 0);
    this.specificity = name === "where" ? Specificity.Universal : highest;
    this.rarity = Rarity.PseudoClass;
    this.dynamic = args.some((sel) => sel.dynamic);
  }
  override toString(): string {
    return `:${this.name}(${this.args.join(", ")})`;
  }
  override match(node: CssNode): boolean {
    const hit = this.args.some((sel) => sel.match(node));
    return this.name === "not" ? !hit : hit;
  }
  /** 同上，严格求值（`:not(.x)` 返回 true 会使它命中一切） */
  override mayMatch(node: CssNode): boolean {
    return this.match(node);
  }
  override trackChanges(node: CssNode, map: SelectorsMatch): void {
    for (const sel of this.args) sel.trackChanges(node, map);
  }
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: SimpleSelectorSequence
 * 等级：部分修改（主体一致）
 * 改动：新增 rarity 取子选择器最大值——上游未给序列设 rarity，落到原型上恒为
 * Universal，使 head 选择退化为「取第一个」；其余（特异度求和、head、match /
 * mayMatch / trackChanges / lookupSort）逐字对应。
 *
 * 无组合符的一串简单选择器，如 `Button.big:hover`
 */
export class SimpleSelectorSequence extends SimpleSelector {
  readonly head: SimpleSelector;

  constructor(readonly selectors: SimpleSelector[]) {
    super();
    this.specificity = selectors.reduce<number>((sum, sel) => sum + sel.specificity, 0);
    this.rarity = selectors.reduce<Rarity>((best, sel) => (sel.rarity > best ? sel.rarity : best), Rarity.Universal);
    this.dynamic = selectors.some((sel) => sel.dynamic);
    this.head = selectors.reduce((prev, curr) => (!prev || curr.rarity > prev.rarity ? curr : prev), null as SimpleSelector | null) as SimpleSelector;
  }

  override toString(): string {
    return this.selectors.join("");
  }
  override match(node: CssNode): boolean {
    return this.selectors.every((sel) => sel.match(node));
  }
  override mayMatch(node: CssNode): boolean {
    return this.selectors.every((sel) => sel.mayMatch(node));
  }
  override trackChanges(node: CssNode, map: SelectorsMatch): void {
    for (const sel of this.selectors) sel.trackChanges(node, map);
  }
  override lookupSort(sorter: LookupSorter, base?: SelectorCore): void {
    this.head?.lookupSort(sorter, base ?? this);
  }
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: ComplexSelector 构造期的
 *      combinator 分组（上游将组合符存在各 SimpleSelector.combinator 上，再归组为
 *      Selector.ChildGroup / Selector.SiblingGroup）
 * 等级：仅思路一致（合成结构）
 * 差异：上游不存在「序列 + 左侧组合符」这一对外结构，它只在 ComplexSelector 内部以
 * groups 形式存在且不对外暴露分段；本结构直接暴露，使 walk 能逐段回溯并记录命中节点。
 *
 * 一个“序列 + 它前面的组合符”
 */
interface SelectorPart {
  sequence: SimpleSelectorSequence;
  /** 该序列**左边**的组合符；第一段是 undefined */
  combinator: Combinator | undefined;
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: ComplexSelector
 * 等级：部分修改（主体一致）
 * 相同：对外契约完全对应——特异度为各段求和、dynamic 取任一动态段、hasAdjacent /
 * hasSibling 标志、mayMatch 恒返 false、lookupSort 取最右段、accumulateChanges
 * 先匹配再只为动态段记依赖。
 * 改动：匹配从「按后代/子代分组后逐组回溯」（Selector.ChildGroup + Selector.SiblingGroup）
 * 改为 parts 逐段右起回溯；依赖记录从 bounds 区间改为按下标写入的 visited 数组；
 * 不再沿 _modalParent 跳模态父（无这一概念）。
 *
 * 组合选择器：`Card > Label.big`、`HBox Label`、`Button + Button`。
 *
 * 匹配从右往左进行（CSS 的标准做法）：最右序列先对齐节点，再按组合符向父 / 兄弟方向回溯。
 */
export class ComplexSelector extends SelectorCore {
  readonly parts: SelectorPart[];
  private readonly last: SimpleSelectorSequence;

  constructor(parts: SelectorPart[]) {
    super();
    this.parts = parts;
    this.last = parts[parts.length - 1].sequence;
    this.specificity = parts.reduce<number>((sum, part) => sum + part.sequence.specificity, 0);
    this.dynamic = parts.some((part) => part.sequence.dynamic);
    this.hasAdjacentCombinator = parts.some((part) => part.combinator === Combinator.adjacent);
    this.hasSiblingCombinator = parts.some((part) => part.combinator === Combinator.sibling);
    // 动态部分只要出现在非最右段，失效追踪就需要记录祖先节点
    this.tracksAncestors = parts.slice(0, -1).some((part) => part.sequence.dynamic);
  }

  override toString(): string {
    return this.parts
      .map((part) => (part.combinator ? `${part.combinator} ${part.sequence}` : `${part.sequence}`))
      .join(" ")
      .trim();
  }

  override match(node: CssNode): boolean {
    return this.walk(node, null);
  }

  override mayMatch(): boolean {
    // 组合选择器的“可能匹配”需要遍历祖先才能确定，不值得省这一步
    return false;
  }

  override accumulateChanges(node: CssNode, map: SelectorsMatch): boolean {
    const visited: CssNode[] = [];
    if (!this.walk(node, visited)) return false;
    // 只为动态的那几段记录依赖：静态段永远不会因为状态变化而改变结果
    for (let i = 0; i < this.parts.length; i++) {
      if (!this.parts[i].sequence.dynamic) continue;
      this.parts[i].sequence.trackChanges(visited[i], map);
    }
    return true;
  }

  override trackChanges(node: CssNode, map: SelectorsMatch): void {
    this.last.trackChanges(node, map);
  }

  override lookupSort(sorter: LookupSorter, base?: SelectorCore): void {
    this.last.lookupSort(sorter, base ?? this);
  }

  /**
   * 从右往左匹配。`visited` 非空时记录每段实际命中的节点，供失效追踪使用。
   * 必须按下标写入而不能 push：匹配是从最后一段往前进行的，push 得到的顺序相反，
   * 写错不会报错，只会把依赖记录到错误的节点上（定向失效静默失效）。
   */
  private walk(node: CssNode, visited: CssNode[] | null): boolean {
    let current: CssNode | null = node;
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const part = this.parts[i];
      if (i === this.parts.length - 1) {
        if (!part.sequence.match(current)) return false;
        if (visited) visited[i] = current;
        continue;
      }
      const combinator = this.parts[i + 1].combinator;
      if (combinator === Combinator.child) {
        current = current.parent ?? null;
        if (!current || !part.sequence.match(current)) return false;
        if (visited) visited[i] = current;
      } else if (combinator === Combinator.descendant) {
        let found: CssNode | null = null;
        let ancestor: CssNode | null = current.parent ?? null;
        while (ancestor) {
          if (part.sequence.match(ancestor)) {
            found = ancestor;
            break;
          }
          ancestor = ancestor.parent ?? null;
        }
        if (!found) return false;
        current = found;
        if (visited) visited[i] = found;
      } else if (combinator === Combinator.adjacent) {
        current = previousSibling(current);
        if (!current || !part.sequence.match(current)) return false;
        if (visited) visited[i] = current;
      } else if (combinator === Combinator.sibling) {
        let found: CssNode | null = null;
        let prev: CssNode | null = previousSibling(current);
        while (prev) {
          if (part.sequence.match(prev)) {
            found = prev;
            break;
          }
          prev = previousSibling(prev);
        }
        if (!found) return false;
        current = found;
        if (visited) visited[i] = found;
      } else {
        return false;
      }
    }
    return true;
  }
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: getNodePreviousDirectSibling
 * 等级：部分修改（主体一致）
 * 改动：上游另有 eachNodePreviousGeneralSibling 负责通用兄弟（`~`）的逆序遍历，
 * 该循环已内联进 ComplexSelector.walk；对父节点三个访问器的 duck-typing 校验相同。
 *
 * 前一个兄弟。需要父节点暴露 getChildIndex / getChildAt / getChildrenCount
 * （Godot 节点有 get_index / get_child / get_child_count，由引擎侧的适配层挂载）。
 * 取不到时返回 null——兄弟组合器不匹配，而不是崩溃。
 */
function previousSibling(node: CssNode): CssNode | null {
  const parent = node.parent as CssNode | undefined | null;
  if (!parent) return null;
  const bag = parent as Record<string, unknown>;
  const getIndex = bag["getChildIndex"];
  const getChildAt = bag["getChildAt"];
  if (typeof getIndex !== "function" || typeof getChildAt !== "function") return null;
  const index = Number((getIndex as (node: CssNode) => number).call(parent, node));
  if (!Number.isFinite(index) || index <= 0) return null;
  return ((getChildAt as (i: number) => CssNode).call(parent, index - 1) as CssNode) ?? null;
}

// ---------------------------------------------------------------- 分词 + 构建
//
// 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: createSelector /
//      createSelectorFromAst / createSimpleSelectorFromAst
// 等级：仅思路一致
// 差异：上游选择器文本由第三方 css-what 分词，本侧无这一依赖，分词器（IDENT /
// tokenizeSelector / simpleFromToken）自写。沿用上游的对外契约：createSelector
// 永不抛异常，失败时返回 InvalidSelector 并将错误保留在其中。

const IDENT = /^-?[a-zA-Z_\u0080-\uFFFF][-a-zA-Z0-9_\u0080-\uFFFF]*/;

type Token =
  | { kind: "universal" }
  | { kind: "id"; value: string }
  | { kind: "class"; value: string }
  | { kind: "type"; value: string }
  | { kind: "attr"; name: string; op: string; value: string; ignoreCase: boolean }
  | { kind: "pseudo"; name: string; argument: string | null; element: boolean }
  | { kind: "combinator"; value: Combinator };

class SelectorSyntaxError extends Error {}

function tokenizeSelector(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let pendingDescendant = false;

  const pushCombinator = (value: Combinator) => {
    const last = tokens[tokens.length - 1];
    if (value === Combinator.descendant) {
      // 显式组合符旁边的空白不算作后代组合符
      if (!last || last.kind === "combinator") return;
      pendingDescendant = true;
      return;
    }
    pendingDescendant = false;
    tokens.push({ kind: "combinator", value });
  };
  const flushDescendant = () => {
    if (pendingDescendant) {
      tokens.push({ kind: "combinator", value: Combinator.descendant });
      pendingDescendant = false;
    }
  };

  const readIdent = (): string => {
    const m = IDENT.exec(text.slice(i));
    if (!m) throw new SelectorSyntaxError(`选择器中包含无法识别的字符：'${text[i] ?? ""}'（位置 ${i}）`);
    i += m[0].length;
    return m[0];
  };

  const readQuoted = (): string => {
    const quote = text[i];
    const end = text.indexOf(quote, i + 1);
    if (end === -1) throw new SelectorSyntaxError(`引号未闭合（位置 ${i}）`);
    const value = text.slice(i + 1, end);
    i = end + 1;
    return value;
  };

  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
      pushCombinator(Combinator.descendant);
      continue;
    }
    if (ch === ">" || ch === "+" || ch === "~") {
      i++;
      // `~=` 只出现在属性选择器中，此处已经越过 `[ ]`，因此 `~` 一定是兄弟组合符
      pushCombinator(ch as Combinator);
      flushDescendant();
      continue;
    }
    flushDescendant();

    if (ch === "*") {
      i++;
      tokens.push({ kind: "universal" });
      continue;
    }
    if (ch === "#") {
      i++;
      tokens.push({ kind: "id", value: readIdent() });
      continue;
    }
    if (ch === ".") {
      i++;
      tokens.push({ kind: "class", value: readIdent() });
      continue;
    }
    if (ch === "[") {
      const close = text.indexOf("]", i);
      if (close === -1) throw new SelectorSyntaxError(`属性选择器缺少 "]"（位置 ${i}）`);
      const body = text.slice(i + 1, close);
      i = close + 1;
      const m = /^\s*([-_a-zA-Z0-9]+)\s*(?:([~^$*|]?=)\s*("(?:[^"]*)"|'(?:[^']*)'|[^\s\]]+))?\s*(i)?\s*$/i.exec(body);
      if (!m) throw new SelectorSyntaxError(`无法识别的属性选择器：[${body}]`);
      const rawValue = m[3] ?? "";
      const value = /^["']/.test(rawValue) ? rawValue.slice(1, -1) : rawValue;
      tokens.push({
        kind: "attr",
        name: m[1],
        op: m[2] ?? "",
        value,
        ignoreCase: !!m[4],
      });
      continue;
    }
    if (ch === ":") {
      const element = text[i + 1] === ":";
      if (element) {
        // 名称必须整段读出后再报出。原先按固定长度截断，超过八个字符的伪元素会被截去后半
        // （`::selection` 报成 `::select`），依据告警排查的人会被引入错误的方向。
        const name = (IDENT.exec(text.slice(i + 2)) ?? [""])[0].toLowerCase();
        throw new SelectorSyntaxError(
          name
            ? `不支持伪元素 "::${name}"（Godot 无伪元素概念，样式只能落在控件自身的主题属性上）`
            : `伪元素缺少名称（位置 ${i}）`,
        );
      }
      i++;
      const name = readIdent().toLowerCase();
      let argument: string | null = null;
      if (text[i] === "(") {
        let depth = 0;
        let j = i;
        for (; j < text.length; j++) {
          if (text[j] === "(") depth++;
          else if (text[j] === ")") {
            depth--;
            if (depth === 0) break;
          }
        }
        if (depth !== 0) throw new SelectorSyntaxError(`函数式伪类缺少 ")"（位置 ${i}）`);
        argument = text.slice(i + 1, j);
        i = j + 1;
      }
      tokens.push({ kind: "pseudo", name, argument, element });
      continue;
    }
    if (/[-a-zA-Z_\u0080-\uFFFF]/.test(ch)) {
      tokens.push({ kind: "type", value: readIdent().toLowerCase() });
      continue;
    }
    throw new SelectorSyntaxError(`选择器中包含无法识别的字符：'${ch}'（位置 ${i}）`);
  }
  flushDescendant();
  return tokens;
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: createSimpleSelectorFromAst
 * 等级：仅思路一致
 * 差异：输入从 css-what 的 AST 节点换成本文件的 Token；上游将 `attribute[name=id]` /
 * `[attribute=id]` 提升为 IdSelector / ClassSelector 的捷径在此不需要（`#id` / `.cls`
 * 在分词阶段已直接产出对应 Token）。
 */
function simpleFromToken(token: Token, warn: (message: string) => void): SimpleSelector {
  switch (token.kind) {
    case "universal":
      return new UniversalSelector();
    case "id":
      return new IdSelector(token.value);
    case "class":
      return new ClassSelector(token.value);
    case "type":
      return new TypeSelector(token.value);
    case "attr": {
      const test = ATTRIBUTE_OPERATORS[token.op];
      if (!test) {
        if (ngDevMode) warn(`不支持属性操作符 "${token.op}"`);
        return new InvalidSelector(new SelectorSyntaxError(`不支持的属性操作符 ${token.op}`));
      }
      return new AttributeSelector(token.name, test, token.value, token.ignoreCase);
    }
    case "pseudo": {
      if (token.argument !== null) {
        if (!FUNCTIONAL_PSEUDOS.has(token.name)) {
          if (ngDevMode) warn(`不支持函数式伪类 ":${token.name}()"（:has / :nth-child 在 Godot 侧无对应能力）`);
          return new InvalidSelector(new SelectorSyntaxError(`不支持的函数式伪类 :${token.name}`));
        }
        const args = splitTopLevel(token.argument, ",").map((arg) => createSelector(arg, warn));
        return new FunctionalPseudoClassSelector(token.name === "matches" ? "is" : token.name, args);
      }
      if (!SUPPORTED_PSEUDO_CLASSES.has(token.name)) {
        if (ngDevMode) warn(`伪类 ":${token.name}" 在 Godot 侧无对应落点，整条选择器已忽略`);
        return new InvalidSelector(new SelectorSyntaxError(`不支持的伪类 :${token.name}`));
      }
      return new PseudoClassSelector(token.name);
    }
    default:
      return new InvalidSelector(new SelectorSyntaxError("组合符位置不合法"));
  }
}

/**
 * 来源：NativeScript/packages/core/ui/styling/style-scope.ts :: CssState.subscribeForDynamicUpdates
 * 等级：仅思路一致
 * 差异：上游的“只订阅真正用到的伪类”依赖运行期 changeMap 的结果；本侧必须在 attach
 * 时（节点尚无运行状态）就从静态选择器求出伪类名单，才能决定连哪些信号。
 *
 * 收集一棵选择器中出现过的伪类名（懒订阅依赖它）。`:is()` / `:not()` 自身不是状态，
 * 仅递归进入参数。未使用的伪类一个信号也不连接——每个连接都有常驻开销。
 */
export function collectPseudoClasses(selector: SelectorCore, out: Set<string> = new Set()): Set<string> {
  if (selector instanceof PseudoClassSelector) {
    out.add(selector.cssPseudoClass);
  } else if (selector instanceof FunctionalPseudoClassSelector) {
    for (const arg of selector.args) collectPseudoClasses(arg, out);
  } else if (selector instanceof ComplexSelector) {
    for (const part of selector.parts) for (const one of part.sequence.selectors) collectPseudoClasses(one, out);
  } else if (selector instanceof SimpleSelectorSequence) {
    for (const one of selector.selectors) collectPseudoClasses(one, out);
  }
  return out;
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-utils.ts :: splitOnTopLevelComma
 * 等级：部分修改（主体一致）
 * 改动：上游先试正则快路径、嵌套括号才降级到字符扫描，且按 charCode 比较；本实现
 * 只保留扫描一条路径并接受任意分隔符。上游保留空段，本实现 trim + 去空。
 * 两者同样不跳过引号：`[title="a,b"]` 作参数时会被误切，因此选择器列表走
 * splitSelectors（带引号与方括号处理），本函数只用于括号内不会出现引号的场合。
 *
 * 顶层（括号外）按分隔符切分
 */
export function splitTopLevel(text: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === separator && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: createSelector
 * 等级：仅思路一致
 * 差异：上游 = css-what 分词 + createSelectorFromAst；本侧分词自写（见本文件
 * 「分词 + 构建」一节）。沿用的契约：失败不抛异常，返回 InvalidSelector。
 *
 * 解析一条选择器。**不抛异常**：失败时返回 InvalidSelector，错误信息保留在其中，
 * 由调用方决定告警还是忽略（构建期需要告警，运行时只需要不崩溃）。
 */
export function createSelector(text: string, warn: (message: string) => void = () => {}): SelectorCore {
  const trimmed = text.trim();
  if (!trimmed) return new InvalidSelector(new SelectorSyntaxError("空选择器"));
  try {
    const tokens = tokenizeSelector(trimmed);
    if (!tokens.length) return new InvalidSelector(new SelectorSyntaxError("空选择器"));

    const parts: SelectorPart[] = [];
    let current: SimpleSelector[] = [];
    let combinator: Combinator | undefined;

    const flush = () => {
      if (!current.length) return;
      parts.push({ sequence: new SimpleSelectorSequence(current), combinator });
      current = [];
    };

    for (const token of tokens) {
      if (token.kind === "combinator") {
        flush();
        if (!parts.length) throw new SelectorSyntaxError(`选择器不能以组合符 "${token.value}" 开头`);
        combinator = token.value;
        continue;
      }
      const simple = simpleFromToken(token, warn);
      if (simple instanceof InvalidSelector) return simple;
      current.push(simple);
    }
    flush();
    if (!parts.length) return new InvalidSelector(new SelectorSyntaxError("空选择器"));
    if (parts.length === 1) return parts[0].sequence;
    return new ComplexSelector(parts);
  } catch (error) {
    return new InvalidSelector(error instanceof Error ? error : new Error(String(error)));
  }
}

// ---------------------------------------------------------------- 四桶索引
//
// 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: SelectorScope 一节
// 等级：部分修改（主体一致）——四桶倒排索引、候选集收集与级联排序逐行对应。

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: LookupSorter
 * 等级：完全来自（一字未改）
 */
export interface LookupSorter {
  sortById(id: string, sel: SelectorCore): void;
  sortByClass(cssClass: string, sel: SelectorCore): void;
  sortByType(cssType: string, sel: SelectorCore): void;
  sortAsUniversal(sel: SelectorCore): void;
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: SelectorMap
 * 等级：完全来自（一字未改）
 */
interface SelectorMap {
  [key: string]: SelectorCore[];
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: appendSelectorCandidates
 * 等级：完全来自（一字未改）
 */
function appendAll(into: SelectorCore[], from: SelectorCore[] | undefined): void {
  if (from) for (let i = 0; i < from.length; i++) into.push(from[i]);
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: SelectorScope
 * 等级：部分修改（主体一致）
 * 改动：去掉 `<T extends Node>` 泛型；sortByType 与 getSelectorCandidates 将 cssType
 * 归一小写（上游区分大小写）；不维护 ruleset 反指与 scopedTag。
 * getSelectorCandidates / sortById / sortByClass / sortByType / sortAsUniversal /
 * addToMap / makeDocSelector 的逐行逻辑相同（含 position 自增与 tier 写入）。
 *
 * 一棵选择器索引（全局样式表 / 组件样式表 / @media 子作用域各一棵）
 */
export class SelectorScope implements LookupSorter {
  private id: SelectorMap = {};
  private class: SelectorMap = {};
  private type: SelectorMap = {};
  private universal: SelectorCore[] = [];

  position = 0;
  tier: SelectorTier = SelectorTier.Application;
  hasAdjacentCombinatorSelectors = false;
  hasSiblingCombinatorSelectors = false;

  getSelectorCandidates(node: CssNode, candidates: SelectorCore[] = []): SelectorCore[] {
    appendAll(candidates, this.universal);
    if (node.id) appendAll(candidates, this.id[node.id]);
    if (node.cssType) appendAll(candidates, this.type[node.cssType.toLowerCase()]);
    if (node.cssClasses) {
      for (const cssClass of node.cssClasses) appendAll(candidates, this.class[cssClass]);
    }
    return candidates;
  }

  sortById(id: string, sel: SelectorCore): void {
    this.addToMap(this.id, id, sel);
  }
  sortByClass(cssClass: string, sel: SelectorCore): void {
    this.addToMap(this.class, cssClass, sel);
  }
  sortByType(cssType: string, sel: SelectorCore): void {
    this.addToMap(this.type, cssType.toLowerCase(), sel);
  }
  sortAsUniversal(sel: SelectorCore): void {
    this.universal.push(this.makeDocSelector(sel));
  }

  private addToMap(map: SelectorMap, head: string, sel: SelectorCore): void {
    if (!map[head]) map[head] = [];
    map[head].push(this.makeDocSelector(sel));
  }

  private makeDocSelector(sel: SelectorCore): SelectorCore {
    if (sel.hasAdjacentCombinator) this.hasAdjacentCombinatorSelectors = true;
    if (sel.hasSiblingCombinator) this.hasSiblingCombinatorSelectors = true;
    sel.pos = this.position++;
    sel.tier = this.tier;
    return sel;
  }
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: compareSelectors
 * 等级：完全来自（一字未改）
 *
 * 级联顺序：特异度 → 样式表层级 → 源码顺序。
 * 这是整个引擎唯一决定“谁优先”的地方，仅此一例。
 */
export function compareSelectors(a: SelectorCore, b: SelectorCore): number {
  return a.specificity - b.specificity || a.tier - b.tier || a.pos - b.pos;
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: matchSelectorCandidates
 * 等级：部分修改（主体一致）
 * 改动：去掉 scopedTags 过滤（组件作用域已在构建期按选择器文本处理）；就地压缩
 * 候选数组与末尾排序的写法逐字相同。
 *
 * 运行候选集，返回命中的选择器（已排序）+ 失效依赖
 */
export function matchSelectorCandidates(node: CssNode, candidates: SelectorCore[]): SelectorsMatch {
  const result = new SelectorsMatch();
  let matched = 0;
  for (let i = 0; i < candidates.length; i++) {
    const selector = candidates[i];
    if (selector.accumulateChanges(node, result)) candidates[matched++] = selector;
  }
  candidates.length = matched;
  result.selectors = candidates.sort(compareSelectors);
  return result;
}
