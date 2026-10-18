import { parseCss, flattenRules, collectFontFaces, type CssRule } from "./parser";
import { parseFontFace, type FontFace } from "./runtime/fonts";
import {
  InvalidSelector,
  SelectorScope,
  createSelector,
  matchSelectorCandidates,
  type SelectorCore,
  type SelectorsMatch,
} from "./selector";
import { expandShorthand } from "./shorthand";
import { matchQuery } from "./mediaquery";
import { knownClasses } from "./vocabulary";
import { SelectorTier, type CssNode, type Declaration, type MediaEnvironment } from "./types";

/** 开发模式标记：生产构建中整个 `if (ngDevMode)` 分支连同告警文案一并消除（口径见 runtime/properties.ts） */

/**
 * 来源：无
 * 懒构建：词汇表是生成数据，不必在 import 期就将其展开为 Set
 */
let knownClassSet: Set<string> | undefined;
function isKnownClass(name: string): boolean {
  knownClassSet ??= new Set(knownClasses().map((n) => n.toLowerCase()));
  return knownClassSet.has(name.toLowerCase());
}

/** 取得选择器开头的元素名（`.x` / `*` / `:hover` 等没有，返回空字符串） */
const LEADING_ELEMENT = /^([A-Za-z][\w-]*)/;

/**
 * 来源：无
 *
 * 元素选择器拼错 Godot 类名时静默零命中，这里是若不提示就无人提示的唯一渠道。
 * 放在 buildRuleSets 而不是构建期插件：选择器原文与告警通道都现成，且组件 CSS 与
 * 全局 CSS 一次覆盖。
 */
/**
 * 来源：无
 *
 * 元素选择器拼错 Godot 类名时静默零命中，这里是若不提示就无人提示的唯一渠道。
 * 放在 buildRuleSets 而不是构建期插件：选择器原文与告警通道都现成，且组件 CSS 与
 * 全局 CSS 一次覆盖。调用点已按 `ngDevMode` 门控，生产构建里整个检查（含正则与集合
 * 查找）不执行，也不负责「摇除文案」以外的任何开销。
 */
function checkElementNames(selectors: readonly string[], line: number, warnings: string[]): void {
  for (const text of selectors) {
    const element = LEADING_ELEMENT.exec(text)?.[1];
    if (!element || isKnownClass(element)) continue;
    warnings.push(
      `第 ${line} 行：元素选择器 "${element}" 不是已知的 Godot 类名，不会命中任何节点` +
        `（元素选择器的落点就是节点类名，不可覆写）`,
    );
  }
}

/** `#id` 的开头（先剔除属性选择器，`[title="#x"]` 里的 `#` 不算） */
const ID_SELECTOR = /#-?[A-Za-z_]/;
const ATTRIBUTE_SELECTOR = /\[[^\]]*\]/g;

/**
 * 来源：无
 *
 * `#id` 能解析但无落点：Godot 节点没有 id 属性，`name` 可重名不能当 id。解析能力保留
 * （纯选择器引擎仍照 id 比较），但接到 Godot 上时它永远零命中，不提示就是假可用。
 */
function checkIdSelectors(selectors: readonly string[], line: number, warnings: string[]): void {
  for (const text of selectors) {
    if (!ID_SELECTOR.test(text.replace(ATTRIBUTE_SELECTOR, ""))) continue;
    warnings.push(
      `第 ${line} 行：选择器里的 "#id" 在 Godot 无落点（节点没有 id 属性，name 可重名不能当 id），` +
        `不会命中任何节点；单点选中请改用 class`,
    );
  }
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: RuleSet
 * 等级：部分修改（主体一致）
 * 改动：上游是类（携带 toString / lookupSort，并将自身反指到每个 selector.ruleset），
 * 本侧是纯数据，索引在 StyleSheetIndex 完成，声明→选择器的映射建在 runtime/sheets.ts；
 * 上游的 tag / scopedTag 本侧只需要组件作用域那一个。
 */
export interface RuleSet {
  selectors: SelectorCore[];
  declarations: Declaration[];
  /** 所在 @media 的原文；undefined 表示无条件 */
  mediaQueryString?: string;
}

/**
 * 来源：无
 *
 * 构建结果：规则集 + 解析期告警
 */
export interface BuildResult {
  ruleSets: RuleSet[];
  warnings: string[];
  /** 样式表中登记成功的 `@font-face`（登记失败者仅输出告警，不纳入此处） */
  fontFaces: FontFace[];
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: appendDeclaration
 * 等级：部分修改（主体一致）
 * 相同：都在解析期展开简写（级联定义在 longhand 上）；自定义属性（`--`）保留原样。
 * 改动：上游在 var()/calc() 无法展开时走 _pendingCssShorthandSubstitution，每个 longhand
 * 挂一个待代入占位值，运行期再解；本侧无这套挂起机制，变量在级联内先展开再落属性。
 * 新增：`!important` 随简写分发到每条 longhand（上游不支持 !important）。
 *
 * 将一条 CSS 规则的声明展开为 longhand 序列
 */
function toDeclarations(rule: CssRule, warnings: string[]): Declaration[] {
  const out: Declaration[] = [];
  for (const decl of rule.declarations) {
    if (decl.property.startsWith("--")) {
      // 自定义属性：留给 vars.ts 在解析期展开，此处原样接收
      out.push({ property: decl.property, value: decl.value });
      continue;
    }
    const expanded = expandShorthand(decl.property, decl.value);
    if (!expanded) {
      out.push({ property: decl.property, value: decl.value, important: decl.important });
      continue;
    }
    for (const warning of expanded.warnings) if (ngDevMode) warnings.push(warning);
    // `!important` 跟随简写一起分发：`border: 1px solid red !important` 的每条
    // longhand 都是 important，而不是只有第一条。
    for (const [property, value] of expanded.longhands) {
      out.push({ property, value, important: decl.important });
    }
  }
  return out;
}

/**
 * 来源：NativeScript/packages/core/ui/styling/style-scope.ts :: CSSSource.parse
 *      + _populateRules + css-selector.ts :: fromAstNode
 * 等级：部分修改（主体一致）
 * 相同：流程对应——解析 → 摊平 @media → 逐规则建选择器与声明。
 * 改动：上游按三种外部解析器（css-tree / nativescript / rework）产出 AST 再转 RuleSet，
 * 本侧直接吃自有 parser；上游遇错只记一条 Trace 并返回空规则集，本侧逐条告警；
 * 元素选择器拼写校验与 @keyframes 丢弃告警是本侧新增。
 *
 * 解析 CSS 文本并构建规则集。**永不抛异常**。
 * 一条规则内全部选择器都无效时，整条规则会被丢弃（不会产生“空选择器命中一切”）。
 */
export function buildRuleSets(css: string): BuildResult {
  const sheet = parseCss(css);
  const warnings = [...sheet.warnings];
  const ruleSets: RuleSet[] = [];

  // 字体登记不参与级联（其无选择器），但告警仍需与普通规则共用同一条通道，
  // 构建期 lint 与运行期 addCss 方能输出完全一致的文案
  const fontFaces: FontFace[] = [];
  for (const face of collectFontFaces(sheet)) {
    const parsed = parseFontFace(face, face.position.line, warnings);
    if (parsed) fontFaces.push(parsed);
  }

  for (const rule of flattenRules(sheet)) {
    if (ngDevMode) {
      checkElementNames(rule.selectors, rule.position.line, warnings);
      checkIdSelectors(rule.selectors, rule.position.line, warnings);
    }
    const selectors: SelectorCore[] = [];
    for (const text of rule.selectors) {
      const selector = createSelector(text, (message) => {
        if (ngDevMode) warnings.push(`第 ${rule.position.line} 行 "${text}"：${message}`);
      });
      if (selector instanceof InvalidSelector) {
        if (ngDevMode) warnings.push(`第 ${rule.position.line} 行：选择器 "${text}" 已忽略 —— ${selector.error.message}`);
        continue;
      }
      selectors.push(selector);
    }
    if (!selectors.length) continue;
    const declarations = toDeclarations(rule, warnings);
    if (!declarations.length) continue;
    const ruleSet: RuleSet = { selectors, declarations };
    if (rule.mediaQueryString) ruleSet.mediaQueryString = rule.mediaQueryString;
    ruleSets.push(ruleSet);
  }
  return { ruleSets, warnings, fontFaces };
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: MediaQuerySelectorScope
 * 等级：部分修改（主体一致）
 * 改动：上游继承 SelectorScope 并持有 mediaQueryString；本侧组合一个 SelectorScope
 * 并另存条件文本，判定交给注入的 MediaEnvironment。
 */
interface MediaQueryScope {
  media: string;
  scope: SelectorScope;
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: StyleSheetSelectorScope
 * 等级：部分修改（主体一致）
 * 相同：index() 与上游 lookupRulesets 逐行对应（含“媒体段结束时将父索引的 position
 * 接回”这一手）；collectCandidates / query 同名同职，媒体查询结果同样按原文缓存一轮。
 * 改动：媒体查询判定由注入的 MediaEnvironment 完成（上游调 checkIfMediaQueryMatches
 * 读全局屏幕）；不维护 scopedTag 过滤；append 从头重编而非上游的 appendRulesets(from)。
 *
 * 一棵已索引的样式表。查询一个节点 = 收集候选 → 匹配 → 按级联顺序返回。
 */
export class StyleSheetIndex {
  private readonly scope = new SelectorScope();
  private mediaScopes: MediaQueryScope[] | null = null;

  constructor(
    ruleSets: RuleSet[],
    readonly tier: SelectorTier = SelectorTier.Application,
  ) {
    this.scope.tier = tier;
    this.index(ruleSets, 0);
  }

  /** 追加规则（已有序号不重排）——全局样式后注册时使用 */
  append(ruleSets: RuleSet[]): void {
    this.index(ruleSets, 0);
  }

  /**
   * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: StyleSheetSelectorScope.lookupRulesets
   * 等级：部分修改（主体一致）
   * 改动：上游将媒体段选择器索引进 MediaQuerySelectorScope 并汇总组合器标志，本侧只记
   * 媒体段与 position 交接；上游支持从 from 起追加，本侧每次从头遍历。
   */
  private index(ruleSets: RuleSet[], from: number): void {
    let lastMediaScope: MediaQueryScope | null = null;

    for (let i = from; i < ruleSets.length; i++) {
      const ruleSet = ruleSets[i];

      if (lastMediaScope && lastMediaScope.media !== ruleSet.mediaQueryString) {
        // 媒体查询段结束：将父索引的位置接回，下一段从这里继续编号
        this.scope.position = lastMediaScope.scope.position;
        lastMediaScope = null;
      }

      if (ruleSet.mediaQueryString) {
        if (!lastMediaScope || lastMediaScope.media !== ruleSet.mediaQueryString) {
          const mediaScope = new SelectorScope();
          mediaScope.tier = this.tier;
          mediaScope.position = this.scope.position;
          lastMediaScope = { media: ruleSet.mediaQueryString, scope: mediaScope };
          this.mediaScopes ??= [];
          this.mediaScopes.push(lastMediaScope);
        }
        for (const selector of ruleSet.selectors) selector.lookupSort(lastMediaScope.scope);
      } else {
        for (const selector of ruleSet.selectors) selector.lookupSort(this.scope);
      }
    }

    if (lastMediaScope) this.scope.position = lastMediaScope.scope.position;
  }

  /**
   * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: StyleSheetSelectorScope.collectCandidates
   * 等级：部分修改（主体一致）
   * 改动：上游用数组 validatedMediaQueries 去重已验证的查询，本侧改用 Map（同时缓存
   * “不命中”的结果）；判定从全局屏幕改为注入的 env。
   *
   * 收集所有可能命中该节点的选择器（包含命中的媒体查询段）。
   * 媒体查询结果按原文缓存一轮，同一条查询不重复求值。
   */
  collectCandidates(node: CssNode, env: MediaEnvironment, candidates: SelectorCore[] = []): SelectorCore[] {
    this.scope.getSelectorCandidates(node, candidates);
    if (this.mediaScopes) {
      const matched = new Map<string, boolean>();
      for (const mediaScope of this.mediaScopes) {
        let hit = matched.get(mediaScope.media);
        if (hit === undefined) {
          hit = matchQuery(mediaScope.media, env);
          matched.set(mediaScope.media, hit);
        }
        if (hit) mediaScope.scope.getSelectorCandidates(node, candidates);
      }
    }
    return candidates;
  }

  query(node: CssNode, env: MediaEnvironment): SelectorsMatch {
    return matchSelectorCandidates(node, this.collectCandidates(node, env));
  }
}
