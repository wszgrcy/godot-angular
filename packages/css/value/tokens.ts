/**
 * 来源：NativeScript/packages/core/ui/styling/css-utils.ts :: splitOnTopLevelWhiteSpace
 * 等级：部分修改（主体一致）
 * 相同：都是“按顶层空白切分，括号内的空白不切”，以保证 `rgb(a, b, c)` 不被拆散。
 * 改动：上游先走正则快路径、嵌套括号才降级到 charCode 扫描，本侧只保留扫描一条路径；
 * 本侧额外跟踪引号（上游不处理）。
 *
 * 按顶层空白切分，括号内的空白不切分
 */
export function splitValueTokens(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (const ch of text) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (/\s/.test(ch) && depth === 0) {
      if (current) out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

/**
 * 来源：NativeScript/packages/core/css/parser.ts :: parseSlash
 * 等级：仅思路一致
 * 差异：上游的 parseSlash 只用于 `background-position / background-size` 这一处，
 * 匹配单个斜杠即可；本侧是通用的顶层斜杠切分（`border-radius: a / b`、`rgb(x y z / a)`），
 * 需自行计数括号深度。
 *
 * 按顶层 `/` 切分（`border-radius: 4px / 8px`、`rgb(x y z / a)`）
 */
export function splitOnSlash(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "/" && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out.filter((s) => s.length > 0);
}
