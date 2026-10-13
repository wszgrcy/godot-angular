export function handlerOf<Fn>(hook: unknown): Fn {
  const h = hook as { handler?: Fn } | Fn;
  return (typeof h === "function" ? h : (h as { handler: Fn }).handler) as Fn;
}

/** 从 `{ filter, handler }` 形式的钩子中取出 filter 定义。 */
export function filterOf(hook: unknown): Parameters<typeof filterMatches>[0] {
  return (hook as { filter?: Parameters<typeof filterMatches>[0] }).filter;
}

type Matcher = string | RegExp;
type Matchers = Matcher | Matcher[] | { include?: Matcher | Matcher[]; exclude?: Matcher | Matcher[] };

/**
 * 按 rolldown 的语义在 JS 中执行一次 filter 判定（对齐 vite 8 / rolldown 1.2.8 的实测行为）：
 * 数组表示“或”；`id` 上的字符串为整串相等，`code` 上的字符串为包含关系；exclude 命中即否定，
 * include 缺席即放行；`id` 比对的是**带查询串的完整 id**。
 *
 * 需要自行执行的原因：被 filter 排除的模块不会进入 handler，测试里直接调用 handler
 * 等于绕过 filter。正则写错时的表现是“少检查”而不是“报错”，因此必须把 filter
 * 本身也纳入被测范围。
 */
export function filterMatches(
  filter: { id?: Matchers; code?: Matchers } | undefined,
  { id, code = "" }: { id: string; code?: string },
): boolean {
  return passes(filter?.id, id, true) && passes(filter?.code, code, false);
}

function passes(matchers: Matchers | undefined, value: string, exact: boolean): boolean {
  if (matchers === undefined) return true;
  if (typeof matchers === "string" || matchers instanceof RegExp) return one(matchers, value, exact);
  if (Array.isArray(matchers)) return matchers.some((m) => one(m, value, exact));
  const exclude = matchers.exclude;
  if (exclude !== undefined && some(exclude, value, exact)) return false;
  return matchers.include === undefined ? true : some(matchers.include, value, exact);
}

function some(list: Matcher | Matcher[], value: string, exact: boolean): boolean {
  return (Array.isArray(list) ? list : [list]).some((m) => one(m, value, exact));
}

function one(matcher: Matcher, value: string, exact: boolean): boolean {
  if (typeof matcher !== "string") return matcher.test(value);
  return exact ? value === matcher : value.includes(matcher);
}
