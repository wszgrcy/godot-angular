import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chainOf, collectFacts, templateTags, type Facts, type PropFact } from "./lib/godot-facts.js";

/**
 * 生成 Emmet 的 `snippets.json`：把 Godot 控件编译成模板里的标签补全。消费方把
 * `emmet.extensionsPath` 指到 `node_modules/godot-angular/emmet` 即可生效。
 *
 * 只写 `html.snippets` 这一段，`filters` / `extends` / `abbreviations` / `variables` 一概不碰。
 * 属性与信号的补全、悬浮说明是 `dist/html-data/godot.html-data.json` 的活，Emmet 只管展开骨架，
 * 两边不重复也不互相覆盖。标签全集与 html-data 同源（`tools/lib/godot-facts.ts`）。
 *
 * ⚠ snippet 的值是 **Emmet 缩写**，不是字面 HTML（实测 emmet 2.4：`resolveSnippets()` 拿
 * `parseAbbreviation()` 解析 snippet 值，解析失败只 `warn` 不报错，展开默默退回成用户敲的那个标签名）。
 * 所以 `<Button text="${1}"></Button>` 这种写法不报错也不生效，必须写 `Button[text=${1}]`。
 * 自检里靠「值里不得出现尖括号」钉住这条。
 *
 * 每个标签出两条键：PascalCase 与全小写，展开值一律 PascalCase（模板里就这么写，小写键只是让
 * 手敲小写也能命中，展开后仍是 PascalCase）。小写的 `button` / `label` 会顶掉 Emmet 自带的同名
 * snippet——已确认接受。
 *
 * 有可写 `text` 的控件（Label / Button 系）把首个 tabstop 放进 text 的值；其余标签不预写属性名，
 * 展开后光标落在内容里（Emmet 对非空标签自动补的位）。
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = join(ROOT, "dist", "emmet", "snippets.json");

interface EmmetSnippets {
  html: { snippets: Record<string, string> };
}

/** 沿继承链找可写的 `text`（Button 系是从 Button 继承来的，不是自有属性） */
function textPropOf(facts: Facts, cls: string): PropFact | undefined {
  for (const name of chainOf((parent) => facts.classes[parent]?.parent, cls)) {
    const prop = facts.classes[name]?.props["text"];
    if (prop && !prop.ro && prop.type === "String") return prop;
  }
  return undefined;
}

/**
 * 值用缩写语法：`Button[text=${1}]` / `VBoxContainer`（后者等价于内置 `btn` → `button` 那种
 * 纯别名，展开后 Emmet 自己把光标补在非空标签的内容里）。
 */
function snippetBody(facts: Facts, tag: string): string {
  return textPropOf(facts, tag) ? `${tag}[text=\${1}]` : tag;
}

function buildSnippets(facts: Facts): EmmetSnippets {
  const snippets: Record<string, string> = {};
  for (const tag of templateTags(facts)) {
    const body = snippetBody(facts, tag);
    snippets[tag] = body;
    snippets[tag.toLowerCase()] = body;
  }
  return { html: { snippets } };
}

/* ------------------------------------------------------------------ *
 * 自检与写盘
 * ------------------------------------------------------------------ */

/** 值只允许两种形状：`Tag` 或 `Tag[text=${1}]`。形状跑偏往往不是报错而是静默失效，所以在这里钉住 */
function validate(data: EmmetSnippets, facts: Facts): void {
  const problems: string[] = [];
  const snippets = data.html.snippets;
  const tags = new Set(templateTags(facts));

  if (Object.keys(data).length !== 1 || Object.keys(data.html).length !== 1) {
    problems.push("只允许 html.snippets 两段结构");
  }
  if (Object.keys(snippets).length !== tags.size * 2) {
    problems.push(`条目数 ${Object.keys(snippets).length} ≠ 标签数 ${tags.size} × 2（大小写）`);
  }

  for (const [key, body] of Object.entries(snippets)) {
    // 每个键都得有个内容相同的小写兄弟，否则「大小写两种提示」就只有一半
    if (snippets[key.toLowerCase()] !== body) problems.push(`${key}: 缺内容相同的小写键`);

    // 尖括号 = 字面 HTML 值：Emmet 2 解析不了，展开会静默退回成用户敲的标签名（不报错，最难查的那种）
    if (/[<>]/.test(body)) problems.push(`${key}: 值是字面 HTML 而不是缩写 ${body}`);

    const tag = /^[A-Za-z_]\w*/.exec(body)?.[0];
    if (!tag || !tags.has(tag)) {
      problems.push(`${key}: 值里的标签 ${tag ?? "(空)"} 不在标签全集里`);
    } else if (body !== tag && body !== `${tag}[text=\${1}]`) {
      problems.push(`${key}: 值形状不在允许列表里 ${body}`);
    }

    // 每个 $ 都必须是 ${1}；顺带挡住 ${0}、${child} 和裸 |
    const stops = [...body.matchAll(/\$\{(\d+)\}/g)].map((m) => m[1]);
    if ((body.match(/\$/g) ?? []).length !== stops.length) problems.push(`${key}: 存在非 tabstop 的 $ ${body}`);
    if (stops.some((n) => n !== "1")) problems.push(`${key}: tabstop 只能是 1 ${body}`);
    if (body.includes("|")) problems.push(`${key}: 值里不该出现 | ${body}`);
  }

  // 产物是编辑器直接吃的，序列化失败 / 形状漂移比少几条补全严重得多
  if (JSON.stringify(JSON.parse(JSON.stringify(data))) !== JSON.stringify(data)) {
    problems.push("序列化不幂等（存在 undefined / 非法值）");
  }
  if (problems.length) throw new Error(`产物自检失败：\n  ${problems.slice(0, 20).join("\n  ")}`);
}

function main(): void {
  const facts = collectFacts();
  const data = buildSnippets(facts);
  validate(data, facts);

  const json = `${JSON.stringify(data, null, 2)}\n`;
  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, json, "utf8");

  const entries = Object.entries(data.html.snippets);
  const withText = entries.filter(([key, body]) => key !== key.toLowerCase() && body.includes("text=")).length;
  console.log(
    `[gen:emmet] ${facts.engine} ｜ 标签 ${templateTags(facts).length}（带 text ${withText}）` +
      ` ｜ 条目 ${entries.length} ｜ ${(json.length / 1024).toFixed(0)} KB → ${OUT_FILE}`,
  );
}

main();
