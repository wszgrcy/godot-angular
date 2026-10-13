/**
 * 来源：无
 *
 * var() 嵌套 / 链的最大深度，超出则视为书写错误
 */
const MAX_DEPTH = 8;

/**
 * 来源：NativeScript/packages/core/ui/core/properties/index.ts :: _evaluateCssVariableExpression
 *      中定位右括号的那段 indexOf(')')
 * 等级：仅思路一致
 * 差异：上游取第一个 `)`（嵌套的 var() 靠多轮迭代逐步消解），本侧一次就配对完成，
 * 因此必须计数深度并跳过字符串。
 *
 * 找到与 `open` 位置的 `(` 配对的 `)`；找不到返回 -1。字符串与嵌套括号均跳过
 */
function matchParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return -1;
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-utils.ts :: splitTopLevel
 *      + NativeScript/packages/core/ui/core/properties/index.ts :: _evaluateCssVariableExpression
 *      中的 matched.join(', ')（上游先按逗号全切，再靠正则区分 fallback）
 * 等级：部分修改（主体一致）
 * 改动：上游切出全部片段后取第一段作名称，本侧只定位第一个顶层逗号；两者同样以括号
 * 深度判定“顶层”，本侧额外跳过引号。
 *
 * 顶层逗号（第一个是名称与 fallback 的分界，嵌套括号内的不算）
 */
function topLevelComma(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) return i;
  }
  return -1;
}

/**
 * 来源：无
 */
export type VarLookup = (name: string) => string | undefined;

/**
 * 来源：NativeScript/packages/core/ui/core/properties/index.ts :: _evaluateCssVariableExpression
 * 等级：部分修改（主体一致）
 * 相同：都是“展开 value 内全部（含嵌套）var()”，都在展开前做一次 includes 快道。
 * 改动：上游取不到变量时静默代入 'unset' 字符串（最终变成一个非法属性值），本侧返回
 * null 并交由调用方告警并丢弃该条声明；上游额外处理 calc()（本侧不做算术求值）。
 *
 * 展开 value 内全部 `var()`。返回 null 表示存在取不到的变量且没有 fallback。
 *
 * 只处理 `var()`，不处理 `calc()`（Godot 的 theme item 是整数像素，没有可参与的
 * 布局盒，见 properties.ts 的告警文案）。
 */
export function resolveVars(value: string, lookup: VarLookup): string | null {
  return expand(value, lookup, 0);
}

/**
 * 来源：NativeScript/packages/core/ui/core/properties/index.ts :: isCssVariableExpression
 * 等级：部分修改（主体一致）
 * 改动：上游查 `var(--`，本侧放宽为 `var(`（使非 `--` 前缀的写法能进入告警而不是静默透传）。
 *
 * value 中是否存在 var()（先做一次低成本的 includes 判断，避免热路径上空跑解析）
 */
export function usesVars(value: string): boolean {
  return value.includes("var(");
}

/**
 * 来源：NativeScript/packages/core/ui/core/properties/index.ts :: _evaluateCssVariableExpression
 *      的迭代体
 * 等级：部分修改（主体一致）
 * 相同：都是“定位 var( → 切出名称与 fallback → 递归展开变量值”。
 * 改动：上游从后往前（lastIndexOf）多轮消解，本侧从前往后单遍完成；上游无递归上限，
 * 本侧受 MAX_DEPTH 约束；上游名称正则要求 `--` 前缀，本侧同样校验但返回 null 而非抛错。
 */
function expand(value: string, lookup: VarLookup, depth: number): string | null {
  if (depth > MAX_DEPTH) return null;
  let out = "";
  let i = 0;
  for (;;) {
    const start = value.indexOf("var(", i);
    if (start < 0) return out + value.slice(i);
    const close = matchParen(value, start + 3);
    if (close < 0) return null; // 括号不配对：书写错误
    out += value.slice(i, start);
    const inner = value.slice(start + 4, close);
    const comma = topLevelComma(inner);
    const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
    const fallback = comma < 0 ? null : inner.slice(comma + 1).trim();
    if (!name.startsWith("--")) return null;
    const found = lookup(name);
    if (found !== undefined) {
      // 变量值本身可能又使用了 var()
      const expanded = expand(found, lookup, depth + 1);
      if (expanded === null) return null;
      out += expanded;
    } else if (fallback !== null) {
      const expanded = expand(fallback, lookup, depth + 1);
      if (expanded === null) return null;
      out += expanded;
    } else {
      return null;
    }
    i = close + 1;
  }
}

/**
 * 来源：无
 *
 * 两个变量表是否等价（只比较键值，不比较顺序）
 */
export function sameVars(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (!b.has(key) || b.get(key) !== value) return false;
  }
  return true;
}
