import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectFacts, controlChain, templateTags, chainOf, type EnumFact, type Facts, type PropFact, type SigFact } from "./lib/godot-facts.js";

/**
 * 生成 VS Code 的 HTML custom data（`html.customData` 吃的那份 JSON），让写模板时对 Godot
 * 控件的标签 / 属性 / 信号有补全与悬浮说明。产物只有 `dist/html-data/godot.html-data.json`。
 *
 * 引擎导出与事实表在 `tools/lib/godot-facts.ts`（与 `gen-emmet-snippets.ts` 共用）。
 * 产物形态对着官方 customData.schema.json（version 恒为 1.1），写完自检重名。
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = join(ROOT, "dist", "html-data", "godot.html-data.json");

/* ------------------------------------------------------------------ *
 * 产物结构
 * ------------------------------------------------------------------ */

interface ValueDef {
  name: string;
  description?: string;
}
interface AttrDef {
  name: string;
  description?: string;
  valueSet?: string;
}
interface TagDef {
  name: string;
  description?: string;
  attributes: AttrDef[];
  references?: { name: string; url: string }[];
}
interface HtmlData {
  version: 1.1;
  tags: TagDef[];
  globalAttributes: AttrDef[];
  valueSets: { name: string; values: ValueDef[] }[];
}

/* ------------------------------------------------------------------ *
 * 说明文字：Godot 的 BBCode → markdown
 * ------------------------------------------------------------------ */

/**
 * `[member x]`、`[enum X]` 这类是指向另一个文档条目的链接，VS Code 里点不动，统一降级成行内
 * 代码；`[StyleBox]` 这种自闭合的类名引用同理。认不出的标记原样留着，比猜一个转换安全。
 */
function bbcodeToMarkdown(raw: string): string {
  let s = raw;

  // 代码块先摘出来：后面的逐行 trim 会把它里面的缩进抹平
  const blocks: string[] = [];
  s = s.replace(/\[codeblock\]([\s\S]*?)\[\/codeblock\]/gi, (_m, code: string) => {
    blocks.push("```\n" + code.replace(/^\s*\*+\s?/gm, "").trimEnd() + "\n```");
    return `\u0000${blocks.length - 1}\u0000`;
  });

  s = s.replace(/\[code\]([\s\S]*?)\[\/code\]/gi, "`$1`");
  s = s.replace(/\[b\]([\s\S]*?)\[\/b\]/gi, "**$1**");
  s = s.replace(/\[i\]([\s\S]*?)\[\/i\]/gi, "*$1*");
  s = s.replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi, "[$2]($1)");
  s = s.replace(/\[URL=([^\]]+)\]([\s\S]*?)\[\/URL\]/gi, "[$2]($1)");
  for (const tag of ["constant", "member", "method", "param", "enum", "signal", "theme_item", "ThemeItem", "CClass", "CNode", "Enum", "Signal", "kbd"]) {
    s = s.replace(new RegExp(`\\[${tag}[^\\]]*\\]([\\s\\S]*?)\\[/${tag}\\]`, "gi"), "`$1`");
  }
  s = s.replace(/\[(?:constant|member|method|param|enum|signal|theme_item|ThemeItem)\s+([^\]]+)\]/g, "`$1`");
  s = s.replace(/\[([A-Za-z_][\w.]*)\]/g, "`$1`");

  return s
    .split("\n")
    // Godot 的项目符号是 `*` 加空格；必须要求后面跟空白，否则刚转出来的 `**粗体**` 会被当成项目符号剔掉
    .map((line) => (/\u0000\d+\u0000/.test(line) ? line.trim() : line.replace(/^[ \t]*\*+[ \t]+/, "").trim()))
    .filter((line, i, all) => line !== "" || (i > 0 && all[i - 1] !== ""))
    .join("\n")
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => blocks[Number(i)])
    .trim();
}

/* ------------------------------------------------------------------ *
 * 组装
 * ------------------------------------------------------------------ */

/** 枚举取值表：同值的别名（Godot 里不少，如 LayoutPresetMode）并成一条，免得补全里出现重名 */
function enumValueDefs(facts: Facts, id: string): ValueDef[] {
  const def: EnumFact | undefined = facts.enums[id];
  if (!def) throw new Error(`枚举 ${id} 未写入事实表，生成逻辑可能存在遗漏`);
  const byValue = new Map<string, { names: string[]; docs: string[] }>();
  for (const v of def.values) {
    const hit = byValue.get(String(v.value));
    if (hit) {
      hit.names.push(v.name);
      if (v.doc) hit.docs.push(v.doc);
    } else {
      byValue.set(String(v.value), { names: [v.name], docs: v.doc ? [v.doc] : [] });
    }
  }
  return [...byValue.entries()].map(([value, v]) => ({
    name: value,
    description: `**${v.names.join(" / ")}**${v.docs.length ? ` — ${bbcodeToMarkdown(v.docs.join(" "))}` : ""}`,
  }));
}

/** 悬浮里给一行紧凑的取值对照；取值表本身太长就留给补全去展示 */
function enumLegend(facts: Facts, id: string): string {
  const def = facts.enums[id]!;
  const legend = [...new Set(def.values.map((v) => `\`${v.value}\`=${v.name}`))].join("、");
  return legend.length <= 240 ? legend : "（取值见补全列表）";
}

function describeProp(facts: Facts, prop: PropFact): string {
  const meta: string[] = [`类型 \`${prop.type}\``];
  if (prop.default !== undefined) meta.push(`默认值 \`${prop.default}\``);
  if (prop.ro) meta.push("**只读**，写进去不会生效");
  const lines = [meta.join(" ｜ ")];
  if (prop.enum) {
    lines.push(`枚举 \`${prop.enum}\`（${prop.bitfield ? "按位或" : "取值"}）：${enumLegend(facts, prop.enum)}`);
  }
  const doc = bbcodeToMarkdown(prop.doc);
  return [doc, ...lines].filter(Boolean).join("\n\n");
}

function describeSig(sig: SigFact): string {
  const args = sig.args.map((a) => `\`${a.name}: ${a.type}\``);
  const meta = args.length
    ? `\`$event\` = 第一个参数 ${args[0]}${args.length > 1 ? `（共 ${args.length} 个参数：${args.join("、")}）` : ""}`
    : "无参数";
  return [bbcodeToMarkdown(sig.doc), meta].filter(Boolean).join("\n\n");
}

/** 枚举/布尔属性给取值补全；静态写法与属性绑定两种都挂上（`[flat]="true"` 同样合法） */
function valueSetOf(facts: Facts, prop: PropFact, register: (name: string, values: ValueDef[]) => void): string | undefined {
  if (prop.enum) {
    register(prop.enum, enumValueDefs(facts, prop.enum));
    return prop.enum;
  }
  if (prop.type === "bool") {
    register("bool", [{ name: "true" }, { name: "false" }]);
    return "bool";
  }
  return undefined;
}

/** 静态属性与属性绑定两种写法各出一条：HTML 那边属性名是字面量匹配，`[text]` 不会自动等于 `text` */
function attrPair(name: string, description: string, valueSet?: string): AttrDef[] {
  return [
    { name, description, ...(valueSet ? { valueSet } : {}) },
    { name: `[${name}]`, description, ...(valueSet ? { valueSet } : {}) },
  ];
}

function buildHtmlData(facts: Facts): HtmlData {
  const globalChain = controlChain(facts);
  const isGlobal = new Set(globalChain);

  /** Control 自己可以当标签用（`<Control>` 是个通用容器），它真正的祖先不是控件 */
  const aboveControl = new Set(globalChain.filter((name) => name !== "Control"));

  /** Control 及其祖先的成员 = 所有控件共有的那一层，只写一遍，落在 globalAttributes */
  const globalNames = new Set<string>();
  for (const cls of globalChain) {
    for (const name of Object.keys(facts.classes[cls].props)) globalNames.add(name);
    for (const name of Object.keys(facts.classes[cls].sigs)) globalNames.add(name);
  }

  const valueSets = new Map<string, ValueDef[]>();
  const register = (name: string, values: ValueDef[]): void => void valueSets.set(name, values);

  /** 沿继承链向上收自有成员，遇到 Control 那层停（那层归 globalAttributes） */
  const membersOf = (cls: string): { props: [string, PropFact][]; sigs: [string, SigFact][] } => {
    const props: [string, PropFact][] = [];
    const sigs: [string, SigFact][] = [];
    const seen = new Set<string>(globalNames);
    for (const name of chainOf((parent) => facts.classes[parent]?.parent, cls)) {
      if (isGlobal.has(name)) continue;
      for (const [propName, prop] of Object.entries(facts.classes[name].props)) {
        if (!seen.has(propName)) (seen.add(propName), props.push([propName, prop]));
      }
      for (const [sigName, sig] of Object.entries(facts.classes[name].sigs)) {
        if (!seen.has(sigName)) (seen.add(sigName), sigs.push([sigName, sig]));
      }
    }
    return { props, sigs };
  };

  const attributesOf = (cls: string): AttrDef[] => {
    const { props, sigs } = membersOf(cls);
    const attributes: AttrDef[] = [];
    for (const [name, prop] of props) {
      attributes.push(...attrPair(name, describeProp(facts, prop), valueSetOf(facts, prop, register)));
    }
    for (const [name, sig] of sigs) attributes.push({ name: `(${name})`, description: describeSig(sig) });
    return attributes;
  };

  const docBase = `https://docs.godotengine.org/en/${facts.docsVersion}/classes`;
  const tags: TagDef[] = templateTags(facts).map((name) => {
    const cls = facts.classes[name];
    const description = [bbcodeToMarkdown(cls.brief), bbcodeToMarkdown(cls.doc)].filter(Boolean);
    if (cls.parent && cls.parent !== "Object") description.push(`继承自 \`${cls.parent}\`。`);
    return {
      name,
      description: description.length ? description.join("\n\n") : `Godot \`${name}\` 控件。`,
      attributes: attributesOf(name),
      references: [{ name: "Godot 文档", url: `${docBase}/class_${name.toLowerCase()}.html` }],
    };
  });

  const globalAttributes: AttrDef[] = [];
  for (const cls of globalChain) {
    const fact = facts.classes[cls];
    for (const [name, prop] of Object.entries(fact.props)) {
      globalAttributes.push(...attrPair(name, describeProp(facts, prop), valueSetOf(facts, prop, register)));
    }
    for (const [name, sig] of Object.entries(fact.sigs)) {
      globalAttributes.push({ name: `(${name})`, description: describeSig(sig) });
    }
  }

  return {
    version: 1.1,
    tags,
    globalAttributes,
    valueSets: [...valueSets.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, values]) => ({ name, values })),
  };
}

/* ------------------------------------------------------------------ *
 * 自检与写盘
 * ------------------------------------------------------------------ */

/** 这份产物会被编辑器直接吃，出错时宁可在这里挡住，也不要让用户面对一个缺补全的编辑器 */
function validate(data: HtmlData): void {
  const problems: string[] = [];
  const checkAttrs = (where: string, attrs: AttrDef[]): void => {
    const names = new Set<string>();
    for (const attr of attrs) {
      if (!attr.name) problems.push(`${where}: 空属性名`);
      if (names.has(attr.name)) problems.push(`${where}: 属性重复 ${attr.name}`);
      names.add(attr.name);
      if (attr.valueSet && !data.valueSets.some((v) => v.name === attr.valueSet)) {
        problems.push(`${where}: valueSet 悬空 ${attr.valueSet}`);
      }
    }
  };

  // HTML 标签名大小写不敏感（实测 <vboxcontainer> 也能命中 VBoxContainer），所以只差大小写的
  // 两个标签名在编辑器里就是一条重复项，必须挡住
  const seenTags = new Map<string, string>();
  for (const tag of data.tags) {
    if (!tag.name) problems.push("存在空标签名");
    const key = tag.name.toLowerCase();
    const prev = seenTags.get(key);
    if (prev) problems.push(`标签重复：${tag.name}（与 ${prev} 仅大小写不同）`);
    seenTags.set(key, tag.name);
    checkAttrs(tag.name, tag.attributes);
  }
  checkAttrs("(globalAttributes)", data.globalAttributes);
  for (const set of data.valueSets) {
    const names = new Set<string>();
    for (const v of set.values) {
      if (names.has(v.name)) problems.push(`valueSet ${set.name} 取值重复 ${v.name}`);
      names.add(v.name);
    }
  }
  if (problems.length) throw new Error(`产物自检失败：\n  ${problems.slice(0, 20).join("\n  ")}`);
}

function main(): void {
  const facts = collectFacts();
  const data = buildHtmlData(facts);
  validate(data);

  const json = `${JSON.stringify(data, null, 1)}\n`;
  const attrCount = data.tags.reduce((n, t) => n + t.attributes.length, 0);
  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, json, "utf8");
  console.log(
    `[gen:html-data] ${facts.engine} ｜ 标签 ${data.tags.length}（属性 ${attrCount}）` +
      ` ｜ 全局属性 ${data.globalAttributes.length} ｜ 取值表 ${data.valueSets.length} ｜ ${(json.length / 1024).toFixed(0)} KB → ${OUT_FILE}`,
  );
}

main();
