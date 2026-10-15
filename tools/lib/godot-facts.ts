import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";

/**
 * 引擎事实表：把引擎自己导出的两份东西拼成「Control 系类 → 自有属性 / 信号 / 枚举」。
 * `gen-html-data.ts`（VSCode customData）与 `gen-emmet-snippets.ts`（Emmet 标签补全）共用它，
 * 两份产物的标签集合因此不可能漂移。
 *
 * 数据全部来自引擎自带的两个命令行开关，仓库里不留任何探针脚本：
 *   --dump-extension-api-with-docs → extension_api.json：类/继承/属性/信号/枚举 + 全部说明文字
 *   --doctool                      → doc/classes/*.xml ：属性→枚举名、默认值、is_bitfield
 * 两份都出自同一个二进制的 ClassDB，按「类 + 属性名」拼起来，版本必然一致。中间事实只在内存里，
 * 不落盘。
 *
 * 三个实测出来的坑，这里都绕过了：
 *   1. `--dump-extension-api-with-docs` 在写完文件之后才崩（上游 bug：`is_cmdline_mode` 里
 *      EditorNode 单例为 null），退出码非 0（实测 134，有时直接是被信号杀掉）。所以不能拿退出码
 *      判断成败，改成校验产物内容。
 *   2. dump 文件写在**当前工作目录**，`--path` 指别处并不会跟着走，所以 cwd 就是输出目录。
 *   3. 必须给一个项目目录，否则编辑器模式起不来。这里用临时目录里的空项目，不碰仓库内的工程目录。
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const BIN_TABLE: Record<string, { dir: string; exe: string }> = {
  "linux-x64": { dir: "linux-editor-4.6.1-v8", exe: "godot.linuxbsd.editor.x86_64" },
  "win32-x64": { dir: "windows-editor-4.6.1-v8", exe: "godot.windows.editor.x86_64.exe" },
};

export function resolveBin(): string {
  const fromEnv = process.env.GODOT_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const hit = BIN_TABLE[`${process.platform}-${process.arch}`];
  if (!hit)
    throw new Error(`未预置 ${process.platform}-${process.arch} 的二进制表项，请通过 GODOT_BIN 指定`);
  const candidate = join(REPO_ROOT, "bin", hit.dir, hit.exe);
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

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: false,
    trimValues: true,
  });
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
 * 中间事实：只留 Control 系（含 Control 自己的祖先链 CanvasItem / Node / Object）
 * ------------------------------------------------------------------ */

export interface Fact {
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

export interface PropFact {
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

export interface SigFact {
  args: { name: string; type: string }[];
  doc: string;
}

export interface EnumFact {
  bitfield?: boolean;
  values: { name: string; value: number; doc: string }[];
}

export interface Facts {
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
export function chainOf(parentOf: (name: string) => string | undefined, cls: string): string[] {
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

/** Control 及其祖先（CanvasItem / Node / Object）：所有控件共有成员所在的那一层 */
export function controlChain(facts: Facts): string[] {
  const chain = chainOf((name) => facts.classes[name]?.parent, "Control");
  if (!chain.includes("Control")) throw new Error("事实表中缺 Control，生成逻辑可能存在遗漏");
  return chain;
}

/**
 * 可实例化、非编辑器专用、且本身是控件（排除 Control 的祖先）的类名，按字母序。
 * 两份产物都以此为标签全集。
 */
export function templateTags(facts: Facts): string[] {
  const aboveControl = new Set(controlChain(facts).filter((name) => name !== "Control"));
  return Object.entries(facts.classes)
    .filter(([name, cls]) => cls.instantiable && !cls.editorOnly && !aboveControl.has(name))
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));
}

/* ------------------------------------------------------------------ *
 * 跑引擎
 * ------------------------------------------------------------------ */

/** 起引擎两次（dump + doctool），返回事实表；临时工程用完即删 */
export function collectFacts(): Facts {
  const bin = resolveBin();
  const scratch = mkdtempSync(join(tmpdir(), "cuj-facts-"));
  writeFileSync(join(scratch, "project.godot"), '[application]\n\nconfig/name="cuj_facts"\n', "utf8");
  mkdirSync(join(scratch, ".godot"), { recursive: true });

  try {
    console.log(`[godot-facts] 引擎 ${bin}`);
    const apiRun = runEngine(bin, scratch, ["--headless", "--path", ".", "--dump-extension-api-with-docs"]);
    const api = readExtensionApi(scratch, apiRun.output);
    if (apiRun.status !== 0) {
      console.log(`[godot-facts] 注意：dump 进程退出码 ${apiRun.status}（上游在写完文件后崩溃，产物不受影响），已按内容校验通过`);
    }

    const docRun = runEngine(bin, scratch, ["--headless", "--path", ".", "--doctool", "."]);
    if (docRun.status !== 0) throw new Error(`--doctool 退出码 ${docRun.status}：\n${docRun.output.slice(-2000)}`);

    return buildFacts(api, readDocXml(scratch));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
