/**
 * 来源：NativeScript/packages/core/css/reworkcss.ts :: Position
 * 等级：仅思路一致
 * 差异：上游 Position 携带 start / end / source / content（整段原文），用于报错时回指；
 * 本类型只留一个起点，不做 source map，也不保留原文。
 *
 * 位置（从 1 起算，足以定位报错即可，不做完整 source map）
 */
export interface CssPosition {
  line: number;
  column: number;
}

/**
 * 来源：NativeScript/packages/core/css/reworkcss.ts :: Declaration
 * 等级：部分修改（主体一致）
 * 改动：新增 important（上游由 cleanupImportantFlags 剥除 `!important` 并告警，不支持其语义）；
 * position 改为单点形状。
 *
 * 一条声明
 */
export interface CssDeclaration {
  type: "declaration";
  property: string;
  value: string;
  important: boolean;
  position: CssPosition;
}

/**
 * 来源：NativeScript/packages/core/css/reworkcss.ts :: Rule
 * 等级：部分修改（主体一致）
 * 改动：mediaQueryString 在解析期就挂在规则上——上游到 style-scope.ts :: _populateRules
 * 才把它挂到 RuleSet；declarations 元素携带 important 与 position。
 */
export interface CssRule {
  type: "rule";
  selectors: string[];
  declarations: CssDeclaration[];
  position: CssPosition;
  /** 由 flattenRules 写入：来自外层 @media 的条件（null 表示无条件） */
  mediaQueryString?: string;
}

/**
 * 来源：NativeScript/packages/core/css/reworkcss.ts :: Media
 * 等级：部分修改（主体一致）
 * 改动：rules 的元素类型收敛为本文件的 CssBlockNode；media 字段名与含义相同。
 */
export interface CssMedia {
  type: "media";
  media: string;
  rules: CssBlockNode[];
  position: CssPosition;
}

/**
 * 来源：NativeScript/packages/core/css/reworkcss.ts :: Keyframes
 * 等级：仅思路一致
 * 差异：上游完整解析 name / vendor / keyframes[] 并交给 CssAnimationParser；本侧只识别
 * “这里有一个 @keyframes”并丢弃块体——Godot 的动画是 Tween / AnimationPlayer，
 * 从 CSS 帧表翻译过去没有可靠的对应物。
 *
 * `@keyframes`——本方案不做动画（Godot 是 Tween / AnimationPlayer 另一套模型）
 */
export interface CssKeyframes {
  type: "keyframes";
  name: string;
  position: CssPosition;
}

/**
 * 来源：无
 *
 * 可识别但暂不支持的 at-rule（@supports / @import / @font-face / @charset / @layer …）
 */
export interface CssUnsupported {
  type: "unsupported";
  name: string;
  prelude: string;
  position: CssPosition;
}

/**
 * 来源：NativeScript/packages/core/css/reworkcss.ts :: Node（type: 'comment'）
 * 等级：部分修改（主体一致）
 * 改动：形状相同，但本解析器在解析前原地抹除注释（见 stripComments），因此该节点
 * 实际不会产生；保留它是为了 CssBlockNode 与 rework 形状对齐。
 */
export interface CssComment {
  type: "comment";
  comment: string;
  position: CssPosition;
}

/**
 * 来源：NativeScript/packages/core/css/reworkcss.ts :: Node（type 联合）
 * 等级：部分修改（主体一致）
 * 改动：上游的 type 联合为 rule / keyframes / declaration / import / media，本侧换成
 * rule / media / keyframes / unsupported / comment（声明不单独成节点，import 归入 unsupported）。
 */
export type CssBlockNode = CssRule | CssMedia | CssKeyframes | CssUnsupported | CssComment;

/**
 * 来源：NativeScript/packages/core/css/reworkcss.ts :: StyleSheet + SyntaxTree
 * 等级：部分修改（主体一致）
 * 改动：上游是 { stylesheet: { rules, parsingErrors } } 两层，本侧扁平为一层；
 * parsingErrors 改名 warnings 且语义放宽（不只收集错误，也收集不支持告警）。
 */
export interface CssStyleSheet {
  type: "stylesheet";
  rules: CssBlockNode[];
  /** 解析期的告警（未闭合、不支持的 at-rule、畸形声明…） */
  warnings: string[];
}

/**
 * 来源：NativeScript/packages/core/css/css-tree-parser.ts :: mapSelectors
 *      以及 NativeScript/packages/core/css/lib/parse/index.ts :: selector
 * 等级：仅思路一致
 * 差异：上游用正则前瞻 `\s*(?![^(]*\)),\s*` 跳过括号内的逗号，并用 \u200C 掩码引号串与
 * 转义逗号；本侧改为单遍扫描，同时覆盖圆括号、方括号与引号（上游只处理圆括号，
 * `[title="a,b"]` 在上游会被误切）。
 *
 * 按顶层逗号切分选择器列表。
 * 括号 / 方括号 / 引号内的逗号不算分隔符（`:is(a,b)`、`[title="a,b"]`）。
 */
export function splitSelectors(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === "," && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

/**
 * 来源：NativeScript/packages/core/css/lib/parse/index.ts :: declaration（其中的 `;` 消耗）
 * 等级：仅思路一致
 * 差异：上游是逐个声明的正则递进匹配（match 逐段消耗前缀），本侧先按顶层分号切串再逐段解析；
 * 括号 / 引号内的分号不算分隔符这一条是本侧新增（上游靠 `[^};]` 字符集排除）。
 */
function splitDeclarations(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * 来源：NativeScript/packages/core/css/lib/parse/index.ts :: comment
 * 等级：仅思路一致
 * 差异：上游将注释解析为独立节点并推进游标；本侧原地抹除且以空格回填，目的是让后续
 * 一切偏移仍能与原文对齐（否则需要上游那套 updatePosition 游标维护）。
 *
 * 移除注释；长度保持不变（以空格替换），使 position 仍能与原文对齐
 */
function stripComments(css: string): string {
  let out = "";
  let i = 0;
  let quote = "";
  while (i < css.length) {
    const ch = css[i];
    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += css[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (ch === quote) quote = "";
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      const stop = end === -1 ? css.length : end + 2;
      // 换行需要保留，否则后续所有行号都会错位
      out += css.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const IMPORTANT = /\s*!\s*important\s*$/i;

/**
 * 来源：NativeScript/packages/core/css/lib/parse/index.ts :: declaration
 *      + NativeScript/packages/core/ui/styling/css-utils.ts :: cleanupImportantFlags
 *      + NativeScript/packages/core/ui/styling/css-selector.ts :: appendDeclaration（属性名大小写规则）
 * 等级：部分修改（主体一致）
 * 相同：缺冒号 → 告警并忽略（上游是 error("property missing ':'")）；`--` 开头的自定义属性
 * 保留原大小写、其余转小写，这条规则逐字来自 appendDeclaration。
 * 改动：上游把 `!important` 剥掉并告警“暂不支持”，本侧解析成 important 标志交给级联；
 * 上游靠正则取属性名与值，本侧用顶层冒号切分。
 */
function parseDeclaration(text: string, position: CssPosition, warnings: string[]): CssDeclaration | null {
  const colon = indexOfTopLevel(text, ":");
  if (colon <= 0) {
    warnings.push(`第 ${position.line} 行：无法解析为声明，已忽略 —— ${text.slice(0, 40)}`);
    return null;
  }
  let property = text.slice(0, colon).trim();
  let value = text.slice(colon + 1).trim();
  if (!property) return null;

  let important = false;
  if (IMPORTANT.test(value)) {
    value = value.replace(IMPORTANT, "").trim();
    important = true;
  }
  // CSS 自定义属性（--x）保留原大小写，其余属性名转为小写
  if (!property.startsWith("--")) property = property.toLowerCase();
  return { type: "declaration", property, value, important, position };
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-utils.ts :: splitTopLevel
 * 等级：部分修改（主体一致）
 * 改动：上游一次切完并返回全部片段，本侧只定位首个字符；同样用括号深度判定“顶层”，
 * 本侧额外跳过引号与转义。
 *
 * 查找顶层（括号 / 引号外）的第一个指定字符
 */
function indexOfTopLevel(text: string, needle: string): number {
  let depth = 0;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === needle && depth === 0) return i;
  }
  return -1;
}

/**
 * 来源：NativeScript/packages/core/css/lib/parse/index.ts :: open / close
 * 等级：仅思路一致
 * 差异：上游靠递进消耗字符串后的 match 判定右括号，无需配对；本侧不消耗输入，必须自行
 * 计数配对，并额外跳过引号。未配对时上游抛错，本侧返回 -1 交由调用方告警。
 *
 * 查找与 start 处 `{` 配对的 `}`；找不到时返回 -1（未闭合）
 */
function matchBrace(css: string, start: number): number {
  let depth = 0;
  let quote = "";
  for (let i = start; i < css.length; i++) {
    const ch = css[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 来源：NativeScript/packages/core/css/lib/parse/index.ts :: parse 内部的函数集
 * （rules / declarations / atrule / atmedia / atkeyframes / match / whitespace）
 * 等级：仅思路一致（合成类）
 * 差异：上游是一组共享 `css` 变量与 lineno/column 游标的闭包函数，每匹配一段就消耗前缀；
 * 本侧不消耗输入，改为按偏移量定位（因此需要 matchBrace / findNext / blockEnd 这些
 * 上游没有的辅助）。职责对应：parseBlock ↔ rules()、parseDeclarations ↔ declarations()、
 * parseAtRule ↔ atrule()（含 atmedia / atkeyframes）。
 */
class CssScanner {
  constructor(
    private readonly css: string,
    readonly warnings: string[],
  ) {}

  /**
   * 来源：NativeScript/packages/core/css/lib/parse/index.ts :: position / updatePosition / Position
   * 等级：仅思路一致
   * 差异：上游在每次 match 后增量维护 lineno / column；本侧的扫描不是严格从左到右消费，
   * 因此改为偏移量→行列的反查。
   *
   * 行首下标表（延迟构建，仅构建一次）。
   *
   * 每次从 0 计数换行到 offset 会使整体退化为 O(n²)（每条规则都需要一个 position），而真实
   * 工程的样式表很容易达到几千条。建表 O(n) + 二分 O(log n)。
   */
  private lineStarts: number[] | null = null;

  private starts(): number[] {
    if (this.lineStarts) return this.lineStarts;
    const starts = [0];
    for (let i = 0; i < this.css.length; i++) {
      if (this.css[i] === "\n") starts.push(i + 1);
    }
    return (this.lineStarts = starts);
  }

  lineColumn(offset: number): CssPosition {
    const starts = this.starts();
    // 二分查找最后一个 ≤ offset 的行首
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - starts[lo] + 1 };
  }

  /**
   * 来源：NativeScript/packages/core/css/lib/parse/index.ts :: rules
   * 等级：部分修改（主体一致）
   * 改动：上游每匹配一段就消耗 `css` 前缀，本侧按 [start, end) 区间扫描；上游遇到无法
   * 解析的内容直接停止，本侧先告警再停（未闭合 / 缺少 `{` 各一条）。
   *
   * 解析一段块**内部**的内容（规则 / at-rule / 声明）
   */
  parseBlock(start: number, end: number): CssBlockNode[] {
    const out: CssBlockNode[] = [];
    let i = start;
    while (i < end) {
      // 跳过空白
      while (i < end && /\s/.test(this.css[i])) i++;
      if (i >= end) break;

      if (this.css[i] === "@") {
        const node = this.parseAtRule(i, end);
        if (node) out.push(node);
        i = node ? node.next : end;
        continue;
      }

      const brace = this.findNext(i, end, "{");
      if (brace === -1) {
        const rest = this.css.slice(i, end).trim();
        if (rest) this.warnings.push(`第 ${this.lineColumn(i).line} 行：缺少 "{"，已忽略 —— ${rest.slice(0, 40)}`);
        break;
      }
      const close = matchBrace(this.css, brace);
      if (close === -1) {
        this.warnings.push(`第 ${this.lineColumn(brace).line} 行：括号未闭合，其后的内容已被丢弃`);
        break;
      }
      const selectorText = this.css.slice(i, brace).trim();
      const declarations = this.parseDeclarations(brace + 1, close);
      if (selectorText) {
        out.push({
          type: "rule",
          selectors: splitSelectors(selectorText),
          declarations,
          position: this.lineColumn(i),
        });
      }
      i = close + 1;
    }
    return out;
  }

  /**
   * 来源：NativeScript/packages/core/css/lib/parse/index.ts :: declarations
   * 等级：部分修改（主体一致）
   * 改动：上游逐条匹配 declaration() 并允许块内混注释；本侧先按顶层分号切分再逐段解析，
   * 块内出现 at-rule 直接告警丢弃。
   *
   * 声明块：只允许声明（嵌套规则不在本方案范围内）
   */
  parseDeclarations(start: number, end: number): CssDeclaration[] {
    const body = this.css.slice(start, end);
    const out: CssDeclaration[] = [];
    for (const chunk of splitDeclarations(body)) {
      if (chunk.startsWith("@")) {
        this.warnings.push(`声明块内的 @${chunk.slice(1, 12)} 不支持，已忽略`);
        continue;
      }
      const decl = parseDeclaration(chunk, this.lineColumn(start), this.warnings);
      if (decl) out.push(decl);
    }
    return out;
  }

  /**
   * 来源：NativeScript/packages/core/css/lib/parse/index.ts :: atrule / atmedia / atkeyframes
   *      / _compileAtrule
   * 等级：部分修改（主体一致）
   * 相同：@media 取 prelude 作为 media 文本并递归解析块内规则；@keyframes 单独识别。
   * 改动：上游还解析 @supports / @host / @page / @document / @font-face / @custom-media /
   * @import / @charset / @namespace，本侧统一归入 unsupported 并告警；上游缺 `{` 直接
   * 抛错，本侧告警后继续。
   */
  private parseAtRule(start: number, end: number): (CssBlockNode & { next: number }) | null {
    const brace = this.findNext(start, end, "{");
    const semi = this.findNext(start, end, ";");
    const preludeEnd = brace === -1 ? semi : semi !== -1 && semi < brace ? semi : brace;
    if (preludeEnd === -1) {
      this.warnings.push(`第 ${this.lineColumn(start).line} 行：at-rule 缺少结尾，已忽略`);
      return { type: "unsupported", name: "?", prelude: "", position: this.lineColumn(start), next: end };
    }
    const prelude = this.css.slice(start + 1, preludeEnd).trim();
    const name = (prelude.split(/[\s(]/)[0] ?? "").toLowerCase();
    const position = this.lineColumn(start);
    const hasBlock = brace !== -1 && (semi === -1 || brace < semi);

    if (name === "media") {
      const condition = prelude.slice("media".length).trim();
      const rules = hasBlock ? this.parseBlockInside(preludeEnd, end) : [];
      return { type: "media", media: condition, rules, position, next: hasBlock ? this.blockEnd(preludeEnd, end) : preludeEnd + 1 };
    }

    if (name === "keyframes" || name === "-webkit-keyframes") {
      const animName = prelude.slice(name.length).trim();
      this.warnings.push(`@${name} ${animName} 已忽略 —— Godot 的动画由 Tween / AnimationPlayer 承担，与 CSS 动画模型不兼容`);
      const next = hasBlock ? this.blockEnd(preludeEnd, end) : preludeEnd + 1;
      return { type: "keyframes", name: animName, position, next };
    }

    // @supports / @import / @charset / @font-face / @layer / @page …
    this.warnings.push(`@${name} 不支持，已忽略`);
    const next = hasBlock ? this.blockEnd(preludeEnd, end) : preludeEnd + 1;
    return { type: "unsupported", name, prelude, position, next };
  }

  /**
   * 来源：无
   *
   * `{` 之后到配对 `}` 之间的内容
   */
  private parseBlockInside(preludeEnd: number, outerEnd: number): CssBlockNode[] {
    const brace = this.css.indexOf("{", preludeEnd);
    if (brace === -1 || brace >= outerEnd) return [];
    const close = matchBrace(this.css, brace);
    if (close === -1) {
      this.warnings.push(`第 ${this.lineColumn(brace).line} 行：at-rule 的块未闭合`);
      return this.parseBlock(brace + 1, outerEnd);
    }
    return this.parseBlock(brace + 1, close);
  }

  private blockEnd(preludeEnd: number, outerEnd: number): number {
    const brace = this.css.indexOf("{", preludeEnd);
    if (brace === -1 || brace >= outerEnd) return outerEnd;
    const close = matchBrace(this.css, brace);
    return close === -1 ? outerEnd : close + 1;
  }

  private findNext(from: number, end: number, char: string): number {
    let quote = "";
    for (let i = from; i < end; i++) {
      const ch = this.css[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === char) return i;
    }
    return -1;
  }
}

/**
 * 来源：NativeScript/packages/core/css/lib/parse/index.ts :: parse
 *      （默认解析器为 css-tree，见 style-scope.ts :: parseCSSAst）
 * 等级：部分修改（主体一致）
 * 相同：入口只有一个、输出 rework 形状的样式表、错误不中断而是收集。
 * 改动：上游靠 options.silent 在“抛错 / 收集到 parsingErrors”间切换，本侧永不抛异常；
 * 上游逐条正则递进解析，本侧先抹注释再交给 CssScanner；上游还处理 @import 链，
 * 本侧将 import 归入 unsupported。
 *
 * 解析一份样式表。**永不抛异常**。
 */
export function parseCss(css: string): CssStyleSheet {
  const warnings: string[] = [];
  const stripped = stripComments(css);
  const scanner = new CssScanner(stripped, warnings);
  const rules = scanner.parseBlock(0, stripped.length);
  return { type: "stylesheet", rules, warnings };
}

/**
 * 来源：NativeScript/packages/core/ui/styling/style-scope.ts :: _populateRules
 * 等级：部分修改（主体一致）
 * 相同：都是“将 @media 摄平，把条件挂到每条规则上”（上游写入 ruleset.mediaQueryString）。
 * 改动：上游嵌套 @media 时将多个条件累参加入一个 string[] 并全部求交，本侧直接
 * 告警并丢弃内层；上游还同时收集 @keyframes，本侧在解析期已丢弃。
 *
 * 将样式表摊平为规则序列，并将外层 `@media` 条件挂到每条规则上。
 *
 * 嵌套 `@media`（`@media` 内再套 `@media`）**不做条件求交**——求交写错是静默错误，
 * 宁可告警并忽略内层。
 */
export function flattenRules(sheet: CssStyleSheet): CssRule[] {
  const out: CssRule[] = [];
  const walk = (nodes: CssBlockNode[], currentMedia?: string) => {
    for (const node of nodes) {
      if (node.type === "rule") {
        if (currentMedia) node.mediaQueryString = currentMedia;
        out.push(node);
      } else if (node.type === "media") {
        if (currentMedia) {
          sheet.warnings.push(`不支持 @media 嵌套 @media（${node.media}），内层已忽略`);
          continue;
        }
        walk(node.rules, node.media);
      }
    }
  };
  walk(sheet.rules, undefined);
  return out;
}
