import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";

/**
 * 生成 VS Code 的 HTML custom data（`html.customData` 吃的那份 JSON），让写模板时对 Godot
 * 控件的标签 / 属性 / 信号有补全与悬浮说明。产物只有 `dist/html-data/godot.html-data.json`。
 *
 * 数据全部来自引擎自带的两个命令行开关，仓库里不留任何探针脚本：
 *   --dump-extension-api-with-docs → extension_api.json：类/继承/属性/信号/枚举 + 全部说明文字
 *   --doctool                      → doc/classes/*.xml ：属性→枚举名、默认值、is_bitfield
 * 两份都出自同一个二进制的 ClassDB，按「类 + 属性名」拼起来，版本必然一致。中间事实只在内存里，
 * 不落盘。
 *
 * 三个实测出来的坑，脚本里都绕过了：
 *   1. `--dump-extension-api-with-docs` 在写完文件之后才崩（上游 bug：`is_cmdline_mode` 里
 *      EditorNode 单例为 null），退出码非 0（实测 134，有时直接是被信号杀掉）。所以不能拿退出码
 *      判断成败，改成校验产物内容。
 *   2. dump 文件写在**当前工作目录**，`--path` 指别处并不会跟着走，所以 cwd 就是输出目录。
 *   3. 必须给一个项目目录，否则编辑器模式起不来。这里用临时目录里的空项目，不碰仓库内的工程目录。
 *
 * 产物形态对着官方 customData.schema.json（version 恒为 1.1），写完自检重名。
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILE = join(ROOT, "dist", "html-data", "godot.html-data.json");

const BIN_TABLE: Record<string, { dir: string; exe: string }> = {
  "linux-x64": { dir: "linux-editor-4.6.1-v8", exe: "godot.linuxbsd.editor.x86_64" },
  "win32-x64": { dir: "windows-editor-4.6.1-v8", exe: "godot.windows.editor.x86_64.exe" },
};

function resolveBin(): string {
  const fromEnv = process.env.GODOT_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const hit = BIN_TABLE[`${process.platform}-${process.arch}`];
  if (!hit)
    throw new Error(`未预置 ${process.platform}-${process.arch} 的二进制表项，请通过 GODOT_BIN 指定`);
  const candidate = join(ROOT, "bin", hit.dir, hit.exe);
  if (!existsSync(candidate))
    throw new Error(`未找到引擎二进制：${candidate}（或通过 GODOT_BIN 指定）`);
  return candidate;
}

/* ------------------------------------------------------------------ *
 * 引擎导出的原始形状
 * ------------------------------------------------------------------ */

interface RawApi {
  header: { version_major: number; version_minor: number; version_full_name: string };
  global_enums: RawEnum[];
  classes: {
    name: string;
    inherits?: string;
    is_instantiable?: boolean;
    api_type?: string;
    brief_description?: string;
    description?: string;
    enums?: RawEnum[];
    properties?: { name: string; type: string; setter?: string; description?: string }[];
    signals?: { name: string; arguments?: { name: string; type: string }[]; description?: string }[];
  }[];
}

interface RawEnum {
  name: string;
  is_bitfield?: boolean;
  values: { name: string; value: number; description?: string }[];
}

function runEngine(bin: string, cwd: string, args: string[]): { status: number | null; output: string } {
  const result = spawnSync(bin, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function readExtensionApi(dir: string, rawOutput: string): RawApi {
  const file = join(dir, "extension_api.json");
  // 崩溃发生在写文件之后，所以这里只认文件内容，不认退出码
  if (!existsSync(file)) throw new Error(`未生成 extension_api.json。引擎输出：\n${rawOutput.slice(-2000)}`);
  const api = JSON.parse(readFileSync(file, "utf8")) as RawApi;
  if (!api.header || !Array.isArray(api.classes) || api.classes.length < 500) {
    throw new Error(`extension_api.json 疑似不完整（类数 ${(api.classes ?? []).length}）`);
  }
  return api;
}

/** doctool 的 XML 只用来补 extension_api.json 缺的三样：属性→枚举名、默认值、is_bitfield */
interface XmlMember {
  enum?: string;
  bitfield: boolean;
  default?: string;
}

/** 类名 → 属性名 → 从 XML 读到的补充信息 */
type XmlFacts = Map<string, Map<string, XmlMember>>;

function readDocXml(root: string): XmlFacts {
  const docDir = join(root, "doc");
  if (!existsSync(docDir)) throw new Error(`--doctool 未生成 ${docDir}`);

  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", parseTagValue: false, trimValues: true });
  const out: XmlFacts = new Map();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name.endsWith(".xml")) {
        const raw = readFileSync(join(dir, entry.name), "utf8");
        // 内建类型（Vector4、PackedVector2Array 等）的文档里有 <constructor> 标签，fast-xml-parser
        // 一律当原型污染抛错（v5 无开关）。Control 系类不会带这种标签；万一漏了，下面那条
        // 「保留类必须能在 XML 里找到」的断言会直接报错，不会静默丢默认值。
        if (raw.includes("<constructor")) continue;
        const node = (parser.parse(raw) as { class?: unknown }).class as Record<string, unknown> | undefined;
        if (!node) continue;
        const name = String(node["@_name"] ?? "");
        if (!name) continue;
        const members = new Map<string, XmlMember>();
        for (const m of asRecords((node.members as Record<string, unknown> | undefined)?.member)) {
          const memberName = String(m["@_name"] ?? "");
          if (!memberName) continue;
          members.set(memberName, {
            enum: m["@_enum"] === undefined ? undefined : String(m["@_enum"]),
            bitfield: String(m["@_is_bitfield"]) === "true",
            default: m["@_default"] === undefined ? undefined : String(m["@_default"]),
          });
        }
        out.set(name, members);
      }
    }
  };
  walk(docDir);
  if (out.size < 500) throw new Error(`doctool XML 解析结果过少（仅 ${out.size} 个类）`);
  return out;
}

function asRecords(value: unknown): Record<string, unknown>[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]) as Record<string, unknown>[];
}

/* ------------------------------------------------------------------ *
 * 拼成中间事实：只留 Control 系（含 Control 自己的祖先链 CanvasItem / Node / Object）
 * ------------------------------------------------------------------ */

interface Fact {
  parent: string;
  /** 抽象基类（ScrollBar / Slider / Separator 等）为 false，模板里建不出节点 */
  instantiable: boolean;
  /** 编辑器专用控件，模板里用不了 */
  editorOnly: boolean;
  brief: string;
  doc: string;
  props: Record<string, PropFact>;
  sigs: Record<string, SigFact>;
}

interface PropFact {
  /** Godot 原生类型名：`int` / `String` / `Vector2` / `Texture2D` … */
  type: string;
  /** 没有 setter 的属性，写进模板不会生效 */
  ro?: boolean;
  /** 类内枚举形如 `Control.FocusMode`，全局枚举不带前缀 */
  enum?: string;
  bitfield?: boolean;
  /** 引擎给的默认值原文（字符串带引号、枚举是数字、向量是 `Vector2(0, 0)`） */
  default?: string;
  doc: string;
}

interface SigFact {
  args: { name: string; type: string }[];
  doc: string;
}

interface EnumFact {
  bitfield?: boolean;
  values: { name: string; value: number; doc: string }[];
}

interface Facts {
  engine: string;
  /** 文档站版本号，用来拼 references 的 URL，如 `4.6` */
  docsVersion: string;
  classes: Record<string, Fact>;
  /** 键：类内枚举 `Control.FocusMode`，全局枚举 `HorizontalAlignment` */
  enums: Record<string, EnumFact>;
}

function buildFacts(api: RawApi, xml: XmlFacts): Facts {
  const byName = new Map(api.classes.map((c) => [c.name, c]));
  const parentOf = (name: string): string | undefined => byName.get(name)?.inherits;
  const controlChain = chainOf(parentOf, "Control");
  if (!controlChain.includes("Control")) throw new Error("extension_api.json 中未找到 Control 的继承链");

  const keep = new Set<string>(controlChain);
  for (const cls of api.classes) if (chainOf(parentOf, cls.name).includes("Control")) keep.add(cls.name);

  const enums = new Map<string, EnumFact>();
  for (const e of api.global_enums) enums.set(e.name, { bitfield: e.is_bitfield, values: e.values.map(enumValue) });
  for (const cls of api.classes) for (const e of cls.enums ?? []) enums.set(`${cls.name}.${e.name}`, { bitfield: e.is_bitfield, values: e.values.map(enumValue) });

  const classes: Record<string, Fact> = {};
  const referenced = new Set<string>();
  for (const name of [...keep].sort()) {
    const cls = byName.get(name)!;
    const xmlProps = xml.get(name);
    if (!xmlProps && (cls.properties ?? []).length > 0) {
      throw new Error(`${name} 在 doctool XML 中未找到，属性→枚举映射与默认值将缺失（请检查是否被 <constructor> 过滤排除）`);
    }
    const props: Record<string, PropFact> = {};
    for (const p of cls.properties ?? []) {
      const fromXml = xmlProps?.get(p.name);
      const prop: PropFact = { type: p.type, doc: p.description ?? "" };
      if (!p.setter) prop.ro = true;
      if (fromXml?.enum) {
        prop.enum = fromXml.enum;
        referenced.add(fromXml.enum);
      }
      if (fromXml?.bitfield) prop.bitfield = true;
      if (fromXml?.default !== undefined) prop.default = fromXml.default;
      props[p.name] = prop;
    }
    const sigs: Record<string, SigFact> = {};
    for (const s of cls.signals ?? []) {
      sigs[s.name] = { args: (s.arguments ?? []).map((a) => ({ name: a.name, type: a.type })), doc: s.description ?? "" };
    }
    classes[name] = {
      parent: cls.inherits ?? "",
      instantiable: cls.is_instantiable !== false,
      editorOnly: cls.api_type === "editor",
      brief: cls.brief_description ?? "",
      doc: cls.description ?? "",
      props,
      sigs,
    };
  }

  for (const ref of referenced) if (!enums.has(ref)) throw new Error(`属性引用的枚举 ${ref} 在 extension_api.json 中未找到（两份产物可能不一致）`);
  const usedEnums: Record<string, EnumFact> = {};
  for (const ref of [...referenced].sort()) usedEnums[ref] = enums.get(ref)!;

  return {
    engine: api.header.version_full_name.replace(/^Godot Engine v?/, ""),
    docsVersion: `${api.header.version_major}.${api.header.version_minor}`,
    classes,
    enums: usedEnums,
  };
}

function enumValue(v: { name: string; value: number; description?: string }): { name: string; value: number; doc: string } {
  return { name: v.name, value: v.value, doc: v.description ?? "" };
}

/** 沿继承链自下而上收齐类名（引擎每个类只声明自有成员） */
function chainOf(parentOf: (name: string) => string | undefined, cls: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let cur: string | undefined = cls;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    chain.push(cur);
    cur = parentOf(cur);
  }
  return chain;
}

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
  const controlChain = chainOf((name) => facts.classes[name]?.parent, "Control");
  const isGlobal = new Set(controlChain);
  /** Control 自己可以当标签用（`<Control>` 是个通用容器），它真正的祖先不是控件 */
  const aboveControl = new Set(controlChain.filter((name) => name !== "Control"));

  /** Control 及其祖先的成员 = 所有控件共有的那一层，只写一遍，落在 globalAttributes */
  const globalNames = new Set<string>();
  for (const cls of controlChain) {
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
  const tags: TagDef[] = [];
  for (const [name, cls] of Object.entries(facts.classes)) {
    // 抽象基类与编辑器专用控件建不出节点；CanvasItem / Node / Object 不是控件
    if (!cls.instantiable || cls.editorOnly || aboveControl.has(name)) continue;
    const description = [bbcodeToMarkdown(cls.brief), bbcodeToMarkdown(cls.doc)].filter(Boolean);
    if (cls.parent && cls.parent !== "Object") description.push(`继承自 \`${cls.parent}\`。`);
    tags.push({
      name,
      description: description.length ? description.join("\n\n") : `Godot \`${name}\` 控件。`,
      attributes: attributesOf(name),
      references: [{ name: "Godot 文档", url: `${docBase}/class_${name.toLowerCase()}.html` }],
    });
  }
  tags.sort((a, b) => a.name.localeCompare(b.name));

  const globalAttributes: AttrDef[] = [];
  for (const cls of controlChain) {
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
  const bin = resolveBin();
  const scratch = mkdtempSync(join(tmpdir(), "cuj-html-data-"));
  writeFileSync(join(scratch, "project.godot"), '[application]\n\nconfig/name="cuj_html_data"\n', "utf8");
  mkdirSync(join(scratch, ".godot"), { recursive: true });

  try {
    console.log(`[gen:html-data] 引擎 ${bin}`);
    const apiRun = runEngine(bin, scratch, ["--headless", "--path", ".", "--dump-extension-api-with-docs"]);
    const api = readExtensionApi(scratch, apiRun.output);
    if (apiRun.status !== 0) {
      console.log(`[gen:html-data] 注意：dump 进程退出码 ${apiRun.status}（上游在写完文件后崩溃，产物不受影响），已按内容校验通过`);
    }

    const docRun = runEngine(bin, scratch, ["--headless", "--path", ".", "--doctool", "."]);
    if (docRun.status !== 0) throw new Error(`--doctool 退出码 ${docRun.status}：\n${docRun.output.slice(-2000)}`);

    const facts = buildFacts(api, readDocXml(scratch));
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
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

main();
