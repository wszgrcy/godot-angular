import { buildRuleSets, StyleSheetIndex, type RuleSet } from "../ruleset";
import {
  Combinator,
  ComplexSelector,
  collectPseudoClasses,
  type ChangeMap,
  type SelectorCore,
} from "../selector";
import { SelectorTier, type CssNode, type Declaration, type MediaEnvironment } from "../types";
import { CssCode, type CssWarnReport } from "../diagnostics";
import { fontFamilyKey, type FontFace } from "./fonts";

/** 开发模式标记：生产构建中整个 `if (ngDevMode)` 分支连同告警文案一并消除（口径见 runtime/properties.ts） */

/**
 * 来源：NativeScript/packages/core/ui/styling/style-scope.ts :: CSSSource
 * 等级：部分修改（主体一致）
 * 改动：上游存的是原始 CSS 文本与解析后的 RuleSet / Keyframes，本侧只存已索引的
 * StyleSheetIndex；上游一个源对应一段文本，本侧一个句柄可对应多张表（组件 / 全局）。
 */
interface Sheet {
  index: StyleSheetIndex;
  /** 选择器 → 它所在规则集的声明（选择器自身不携带声明，映射建立在这里） */
  declarations: Map<SelectorCore, Declaration[]>;
  ruleSets: RuleSet[];
  /** 本表中 `@font-face` 登记下来的字体（整表移除时一并失效） */
  fontFaces: FontFace[];
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: SelectorsMatch
 * 等级：部分修改（主体一致）
 * 相同：三件套完全对应——命中选择器 / 声明 / changeMap（上游是 dynamicStateNodes）。
 * 改动：上游的 SelectorsMatch 自带 dynamicPseudoClasses 与 addChange 逻辑，本侧只留数据；
 * 上游在匹配时就按级联排序，本侧把排序推给 Cascade（跨样式表合并后才能排）。
 *
 * 单个节点在当前样式表集合上的匹配结果（已跨表合并）
 */
export interface MatchedSelectors {
  /** 命中的选择器，**未排序**（排序是级联的职责） */
  selectors: SelectorCore[];
  changeMap: ChangeMap;
  declarations: Map<SelectorCore, Declaration[]>;
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: SelectorScope.hasAdjacentCombinatorSelectors
 *      / hasSiblingCombinatorSelectors（StyleScope 同名转发）
 * 等级：部分修改（主体一致）
 * 改动：上游区分 `+`（adjacent）与 `~`（sibling）两个标志，本侧归成一个 siblingSensitive
 * （失效时两种都要连带整个父下的全部兄弟，分开记不带来任何收益）；上游无 subtree 概念，
 * 后代组合器靠无条件展开子树，本侧改为按需展开。
 *
 * 样式表使用了哪些组合器——失效调度据此决定是否需要展开子树 / 兄弟
 */
export interface CombinatorFlags {
  readonly subtreeSensitive: boolean;
  readonly siblingSensitive: boolean;
}

/**
 * 来源：NativeScript/packages/core/ui/styling/style-scope.ts :: StyleScope（样式表部分）
 *      + CSSSource
 * 等级：部分修改（主体一致）
 * 相同：职责对应——登记样式表、由样式表推导元信息、回答“谁匹配这个节点”。
 * 改动：上游只有 application + local 两个固定槽位，本侧是可变长数组（每张表一个句柄，
 * 可单独袭除）；上游靠版本号延迟重建选择器（ensureSelectors），本侧在 add 时直接建索引。
 *
 * 已登记的样式表集合：登记 / 撤销 / 媒体环境，以及由样式表自身推导出的元信息
 * （使用了哪些伪类、是否存在组合器）。
 *
 * 这里只回答“谁匹配这个节点”，不访问节点状态，也不标脏——标脏是调用方的职责。
 */
export class SheetRegistry implements CombinatorFlags {
  private readonly sheets: Sheet[] = [];
  /**
   * 来源：无
   *
   * 样式表中出现过的伪类名（addCss / removeSheet 后重算）
   */
  private usedPseudo = new Set<string>();
  /** usedPseudo 每次确实变化时 +1：运行时用它判断存量节点是否需要重新绑定 */
  private pseudoVersion = 0;
  /** 样式表中出现过 descendants / child 组合器（决定 class 变化是否需要连带子树） */
  subtreeSensitive = false;
  /** 样式表中出现过 + / ~ 组合器（决定是否需要连带兄弟） */
  siblingSensitive = false;

  env: MediaEnvironment;

  constructor(
    env: MediaEnvironment,
    private readonly warn: CssWarnReport,
  ) {
    this.env = env;
  }

  /**
   * 来源：NativeScript/packages/core/ui/styling/style-scope.ts :: StyleScope.addCss
   *      + CSSSource 构造（解析文本 → RuleSet）
   * 等级：部分修改（主体一致）
   * 改动：上游追加文本后整体重解析，本侧新增一张独立索引并返回可撤销句柄。
   *
   * 登记一段 CSS，返回序号（`remove()` 用它撤销）。解析告警在此处输出
   */
  add(css: string, options: { tier?: SelectorTier } = {}): number {
    const built = buildRuleSets(css);
    const index = new StyleSheetIndex(built.ruleSets, options.tier ?? SelectorTier.Application);
    const declarations = new Map<SelectorCore, Declaration[]>();
    for (const ruleSet of built.ruleSets) {
      for (const selector of ruleSet.selectors) declarations.set(selector, ruleSet.declarations);
    }
    // 解析期的告警自带各自的码（语法、选择器、@font-face……），按码上报
    if (ngDevMode) for (const entry of built.warnings) this.warn(entry.code, entry.message);
    this.sheets.push({ index, declarations, ruleSets: built.ruleSets, fontFaces: built.fontFaces });
    this.noteCombinators(built.ruleSets);
    this.notePseudoClasses();
    return this.sheets.length - 1;
  }

  /** 撤销一段 CSS（热更新 / 组件销毁时使用）。序号越界返回 false，调用方不必跟随重算 */
  remove(handle: number): boolean {
    if (handle < 0 || handle >= this.sheets.length) return false;
    this.sheets.splice(handle, 1);
    this.notePseudoClasses();
    return true;
  }

  /**
   * 样式表中实际使用了哪些伪类——attach 时要据此决定是否为节点连接 mouse_entered 之类的信号，
   * 而那时节点上还没有运行时状态，答案只能来自样式表自身。
   */
  usedPseudoClasses(): ReadonlySet<string> {
    return this.usedPseudo;
  }

  /**
   * 按家族名查已登记的字体。后登记的表覆盖先登记的（与声明的层叠同口径），
   * 名称不区分大小写。未命中时返回 null，由调用方决定如何输出告警。
   */
  findFontFace(family: string): FontFace | null {
    const key = fontFamilyKey(family);
    for (let i = this.sheets.length - 1; i >= 0; i--) {
      for (const face of this.sheets[i].fontFaces) {
        if (fontFamilyKey(face.family) === key) return face;
      }
    }
    return null;
  }

  /** 伪类集合的版本号（仅在集合确实变化时递增） */
  pseudoClassVersion(): number {
    return this.pseudoVersion;
  }

  /**
   * 来源：NativeScript/packages/core/ui/styling/style-scope.ts :: StyleScope._createSelectors
   *      （媒体查询在重建选择器时经 matchMediaQueryString 重判）
   * 等级：部分修改（主体一致）
   * 改动：上游从屏幕自取新值并只重建受影响的媒体查询作用域，本侧环境由外部注入，
   * 并先做同值比较（无变化时连重算也不发起）。
   *
   * 更换媒体查询环境（窗口尺寸变化时调用）。返回是否确实发生变化
   */
  setEnv(next: MediaEnvironment): boolean {
    // 环境未变化时直接返回：拖动窗口时 size_changed 会触发大量回调，而全量标脏代价很高
    if (sameEnv(this.env, next)) return false;
    this.env = next;
    return true;
  }

  /**
   * 来源：NativeScript/packages/core/ui/styling/style-scope.ts :: StyleScope.matchSelectors
   *      + css-selector.ts :: StyleSheetSelectorScope.query
   * 等级：部分修改（主体一致）
   * 相同：逐表查询后合并 changeMap，匹配阶段不排序。
   * 改动：上游将 application / local 两棵索引的候选合并后就地排序，本侧把排序推给
   * 级联（跨表合并后才能按 tier 排）。
   *
   * 当前节点命中了哪些选择器、各自的声明、以及动态依赖了谁
   */
  matched(node: CssNode): MatchedSelectors {
    const selectors: SelectorCore[] = [];
    const changeMap: ChangeMap = new Map();
    const declarations = new Map<SelectorCore, Declaration[]>();
    for (const sheet of this.sheets) {
      const match = sheet.index.query(node, this.env);
      for (const selector of match.selectors) {
        selectors.push(selector);
        const decls = sheet.declarations.get(selector);
        if (decls) declarations.set(selector, decls);
      }
      mergeChangeMap(changeMap, match.changeMap);
    }
    return { selectors, changeMap, declarations };
  }

  /**
   * 来源：NativeScript/packages/core/ui/styling/style-scope.ts :: CssState.subscribeForDynamicUpdates
   * 等级：仅思路一致
   * 差异：上游在匹配时逐节点发现动态伪类并订阅，本侧改为构建期扫描全部选择器一次，
   * 得到一张全局集合（不在匹配热路径上，也不养监听器）。
   *
   * 重算“样式表使用了哪些伪类”，只在样式表增删时运行，不在匹配热路径上
   */
  private notePseudoClasses(): void {
    const next = new Set<string>();
    for (const sheet of this.sheets) {
      for (const ruleSet of sheet.ruleSets) {
        for (const selector of ruleSet.selectors) collectPseudoClasses(selector, next);
      }
    }
    // 确实变化时才递增版本号：否则每次 addCss 都会使运行时全量重绑一遍（组件逐个登记时就是 O(n²)）
    if (next.size === this.usedPseudo.size && [...next].every((name) => this.usedPseudo.has(name))) return;
    this.usedPseudo = next;
    this.pseudoVersion++;
  }

  /**
   * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: SelectorScope 中置位
   * hasAdjacentCombinatorSelectors / hasSiblingCombinatorSelectors 的那两处
   * 等级：部分修改（主体一致）
   * 改动：上游在索引入库时逐选择器置位，本侧同样在 add 时扫描，但只记两个布尔；
   * 两者都是“只由 false 变 true”，remove 不回退（宁多勿漏）。
   *
   * 记录组合器敏感度（只会由 false 变 true，remove 不回退，宁多勿漏）
   */
  private noteCombinators(ruleSets: RuleSet[]): void {
    for (const ruleSet of ruleSets) {
      for (const selector of ruleSet.selectors) {
        if (selector.hasSiblingCombinator || selector.hasAdjacentCombinator) this.siblingSensitive = true;
        if (selector instanceof ComplexSelector) {
          for (const part of selector.parts) {
            if (part.combinator === Combinator.descendant || part.combinator === Combinator.child) {
              this.subtreeSensitive = true;
              break;
            }
          }
        }
      }
    }
  }
}

/**
 * 来源：无
 *
 * 环境值比较：键顺序不同的同一个对象不算“发生变化”
 */
function sameEnv(a: MediaEnvironment, b: MediaEnvironment): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) return false;
  }
  return true;
}

function mergeChangeMap(target: ChangeMap, source: ChangeMap): void {
  for (const [node, changes] of source) {
    let mine = target.get(node);
    if (!mine) target.set(node, (mine = {}));
    if (changes.attributes) {
      mine.attributes ??= new Set();
      for (const value of changes.attributes) mine.attributes.add(value);
    }
    if (changes.pseudoClasses) {
      mine.pseudoClasses ??= new Set();
      for (const value of changes.pseudoClasses) mine.pseudoClasses.add(value);
    }
  }
}
