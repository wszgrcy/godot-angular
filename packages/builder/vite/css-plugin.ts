import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { exactRegex, makeIdFiltersToMatchWithQuery } from "@rolldown/pluginutils";
import type { Plugin, ResolvedConfig } from "vite";
import { buildRuleSets } from "godot-angular/css";
import { toPosix, withoutQuery } from "../shared/path";

/** 全局样式表进入产物的载体模块（由 polyfill 入口以副作用 import 引入） */
export const GLOBAL_CSS_VIRTUAL = "virtual:godot-angular/css-global";
const GLOBAL_CSS_RESOLVED = `\0${GLOBAL_CSS_VIRTUAL}`;

/**
 * 全局 CSS 的构建期 → 运行时交接位。使用 globalThis 而不是 import：这个模块必须排在
 * Angular 之前求值，而 import 会将库连同 Angular 一起提前引入。
 */
export const GLOBAL_CSS_GLOBAL = "__CUJ_GLOBAL_CSS__";

export interface CssPluginOptions {
  /** angular.json 的 `styles`：全局样式表文件，相对 workspaceRoot */
  globalStyles?: string[];
  /** workspaceRoot，用于将 id 转为相对路径（哈希需要稳定，机器绝对路径不可用） */
  workspaceRoot?: string;
  log?: (msg: string) => void;
  /**
   * 预处理器（scss / sass / less）。缺省就是 vite 自身的 `preprocessCSS`，
   * 与 analog 调用的是同一个函数、使用同一份 `css.preprocessorOptions`，因此不会出现
   * “本插件报错而构建其实可以通过”的假阳性。
   *
   * 保留这个入口是为了可测：单测中无法构造出一份真实的 ResolvedConfig（vite 的 preprocessCSS
   * 会去读取 config 上一堆内部字段），而“语法错误的 scss 必须硬失败”这条需要能够固定。
   */
  preprocessCss?: (code: string, file: string, config: ResolvedConfig) => Promise<string>;
}

type Logger = (msg: string) => void;

async function vitePreprocess(code: string, file: string, config: ResolvedConfig): Promise<string> {
  const { preprocessCSS } = await import("vite");
  return (await preprocessCSS(code, file, config)).code;
}

/* ------------------------------------------------------------------ *
 * 极小的 JS 字面量扫描器
 *
 * 为何不使用正则：`styles: [...]` 中的 CSS 自身就包含 `[` `]` `(` `)` `{` `}`
 * （`[_ngcontent-%COMP%]` 是最常见的那个），正则配对括号一定会被选择器干扰。
 * 为何不使用 babel：此处只需要“找到字符串内容”，babel 需要 parse + 重新生成整个模块。
 * ------------------------------------------------------------------ */

const OPENERS: Record<string, string> = { "[": "]", "{": "}", "(": ")" };

/** 跳过字符串字面量，返回闭合引号之后的下标 */
function skipString(code: string, at: number): number {
  const quote = code[at];
  let i = at + 1;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i++;
  }
  return code.length;
}

/**
 * 从 `open`（指向 `[` / `{` / `(`）扫到配对的闭合符，返回**闭合符下标**；不配对返回 -1。
 * 字符串与注释里的括号一律跳过。
 */
function scanBalanced(code: string, open: number): number {
  const stack: string[] = [];
  let i = open;
  while (i < code.length) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(code, i);
      continue;
    }
    if (ch === "/" && (code[i + 1] === "/" || code[i + 1] === "*")) {
      const end = code.indexOf(ch === "/" && code[i + 1] === "/" ? "\n" : "*/", i);
      i = end < 0 ? code.length : end + (code[i + 1] === "/" ? 0 : 2);
      continue;
    }
    if (OPENERS[ch]) stack.push(OPENERS[ch]);
    else if (ch === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return i;
    }
    i++;
  }
  return -1;
}

/** 一个字符串字面量在源码中的位置与解码后的内容 */
interface StringLiteral {
  start: number;
  /** 闭合引号的下标 */
  end: number;
  value: string;
}

/** 列出 `[start, end)` 区间内的字符串字面量（模板串也计入） */
function stringLiterals(code: string, start: number, end: number): StringLiteral[] {
  const out: StringLiteral[] = [];
  let i = start;
  while (i < end) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const close = skipString(code, i);
      out.push({ start: i, end: close - 1, value: decodeLiteral(code.slice(i, close)) });
      i = close;
      continue;
    }
    i++;
  }
  return out;
}

/** 将一段字符串字面量源码解码为实际值（覆盖 CSS 与路径所需的子集） */
function decodeLiteral(raw: string): string {
  const body = raw.slice(1, -1);
  if (!body.includes("\\")) return body;
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = body[++i];
    switch (next) {
      case "n":
        out += "\n";
        break;
      case "t":
        out += "\t";
        break;
      case "r":
        out += "\r";
        break;
      case "u": {
        // \u{1F600}（模板串/ES6）与 \uXXXX 两种形式均会出现
        if (body[i + 1] === "{") {
          const close = body.indexOf("}", i + 1);
          const code = Number.parseInt(body.slice(i + 2, close), 16);
          if (Number.isFinite(code)) out += String.fromCodePoint(code);
          i = close;
        } else {
          const code = Number.parseInt(body.slice(i + 1, i + 5), 16);
          if (Number.isFinite(code)) out += String.fromCharCode(code);
          i += 4;
        }
        break;
      }
      default:
        out += next ?? "";
    }
  }
  return out;
}

interface PropertyHit {
  /** 属性名起始下标 */
  key: number;
  /** 冒号之后第一个非空白字符的下标 */
  value: number;
}

/**
 * `key` 作为一个**属性名**出现的位置：前面不能是标识符字符，后面紧跟冒号。
 * “后面紧跟冒号”同时避开两个陷阱：`styleUrls` 不会被当作 `styleUrl`（下一个字符是 `s`），
 * `stylesheets:` 不会被当作 `styles:`。
 */
function findProperty(code: string, key: string, from = 0): PropertyHit | null {
  const ident = /[A-Za-z0-9_$]/;
  let at = from;
  for (;;) {
    const hit = code.indexOf(key, at);
    if (hit < 0) return null;
    const after = hit + key.length;
    const before = hit > 0 ? code[hit - 1] : " "; // 行首视为合法位置
    let cursor = after;
    while (cursor < code.length && /\s/.test(code[cursor])) cursor++;
    if (!ident.test(before) && !ident.test(code[after] ?? "x") && code[cursor] === ":") {
      let value = cursor + 1;
      while (value < code.length && /\s/.test(code[value])) value++;
      return { key: hit, value };
    }
    at = after;
  }
}

/* ------------------------------------------------------------------ *
 * 插件 1：源码层守卫（styleUrls / styleUrl）
 * ------------------------------------------------------------------ */

const PREPROCESSABLE = /\.(scss|sass|less)$/i;

/**
 * 守卫只可能落在组件模块上，而它需要对图中**每个**模块被询问一次，因此闸门写在 `filter` 中
 * （写在 handler 中也需要先支付一趟 Rust → JS 的往返）：
 *   - `id`：组件源码后缀，排除 node_modules；后缀判定为 `?query` 预留了位置
 *   - `code`：`styleUrl` / `styleUrls` / `styles` 任一出现才值得进入 JS
 */
const COMPONENT_ID = makeIdFiltersToMatchWithQuery(/\.[cm]?[jt]sx?$/);
const STYLE_KEY = /styleUrls?|styles/;

/** 从组件源码中提取 styleUrls / styleUrl 的字面量值 */
function collectStyleUrls(code: string): string[] {
  return collectStringArray(code, ["styleUrls", "styleUrl"]);
}

/**
 * 获取组件内联 `styles: [...]` 的原文。pre 阶段看到的是用户自行编写的 TS，字面量就在
 * 装饰器中。静态无法求值的（`styles: [someVar]`）返回空——lint 是尽力而为。
 */
function collectInlineStyles(code: string): string[] {
  return collectStringArray(code, ["styles"]);
}

/** `key: "…"` 与 `key: ["…", "…"]` 两种写法均接受，模板串也计入 */
function collectStringArray(code: string, keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    let at = 0;
    for (;;) {
      const hit = findProperty(code, key, at);
      if (!hit) break;
      at = hit.key + key.length;
      const cursor = hit.value;
      if (code[cursor] === "[") {
        const close = scanBalanced(code, cursor);
        if (close < 0) continue;
        out.push(...stringLiterals(code, cursor, close).map((s) => s.value));
      } else if (code[cursor] === '"' || code[cursor] === "'" || code[cursor] === "`") {
        out.push(decodeLiteral(code.slice(cursor, skipString(code, cursor))));
      }
    }
  }
  return out;
}

/**
 * 源码层守卫：`styleUrls` 指向的文件必须存在、必须可以编译，并顺带将组件 CSS 过一遍 lint。
 *
 * 不改写任何内容（一律返回 null），只负责“应当失败时失败”与“写了等于没写时给出提示”。
 * lint 调用的是纯包中的 `buildRuleSets`，运行时 `Cascade.addCss` 调用的是同一份，两边不会漂移。
 */
export function cssSourceGuardPlugin(options: CssPluginOptions = {}): Plugin {
  const log: Logger = options.log ?? (() => {});
  const preprocess = options.preprocessCss ?? vitePreprocess;
  let config: ResolvedConfig | undefined;
  /** 已校验过的文件 → mtime，watch 时同一个文件不重复经过预处理器 */
  const checked = new Map<string, number>();
  /** 已 lint 过的文件 → mtime，同上（lint 比预处理器便宜，但重复报告同样会刷屏） */
  const linted = new Map<string, number>();

  return {
    name: "godot-angular-css-source-guard",
    enforce: "pre",
    configResolved(resolved) {
      config = resolved;
    },

    transform: {
      filter: { id: { include: COMPONENT_ID, exclude: /node_modules/ }, code: STYLE_KEY },
      async handler(code, id) {
        const file = withoutQuery(id);
        const urls = collectStyleUrls(code);
        const inline = collectInlineStyles(code);
        if (!urls.length && !inline.length) return null;

        const module = relativeModule(file, config);
        /** 同一次 transform 中同一条告警只报一次（两个组件使用同一份样式很常见） */
        const reported = new Set<string>();
        const lint = (css: string, sourceId: string, where: string): void => {
          for (const warning of buildRuleSets(css).warnings) {
            // 去重键使用 sourceId 而不是 where：两段内联 styles 碰巧使用同一份样式（sourceId
            // 都是 inline）报一次即可；但两个不同 styleUrls 文件内容相同时必须各报一次，
            // 否则第二个文件的同名告警会被静默吞掉（告警中只有行号，无法区分文件）。
            const key = `${module}::${sourceId}::${warning}`;
            if (reported.has(key)) continue;
            reported.add(key);
            log(`${module}（${where}）：${warning}`);
          }
        };

        for (const url of urls) {
          const target = isAbsolute(url) ? url : resolve(dirname(file), url);
          // watch：修改被引用的样式也需要重跑（analog 的 serve HMR 逻辑在 build/watch 下不生效）
          this.addWatchFile(target);
          if (!existsSync(target)) {
            this.error(
              `组件样式文件不存在：styleUrls 中的 "${url}"（相对 ${relativeModule(file, config)}）` +
                `解析为 ${target}，该文件不存在。Angular 无法读取 styleUrls 时会不输出、不告警地跳过它，` +
                `本构建将其视为硬错误，不允许其静默进入产物。`,
            );
          }

          const mtime = statSync(target).mtimeMs;
          const raw = readFileSync(target, "utf8");
          if (!PREPROCESSABLE.test(target)) {
            if (linted.get(target) !== mtime) {
              lint(raw, target, `styleUrls ${url}`);
              linted.set(target, mtime);
            }
            continue;
          }

          if (checked.get(target) === mtime) continue;
          try {
            // lint 的对象是**预处理后**的 CSS：scss 嵌套在原文中选择器是缩进，解析器无法识别
            const processed = await preprocess(raw, target, config as ResolvedConfig);
            if (linted.get(target) !== mtime) {
              lint(processed, target, `styleUrls ${url}`);
              linted.set(target, mtime);
            }
            checked.set(target, mtime);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.error(`组件样式预处理失败：${target}\n${message}`);
          }
        }

        // 内联 styles：源码字面量，没有预处理（inlineStyleLanguage 默认 css）
        inline.forEach((css, index) => lint(css, "inline", `第 ${index + 1} 段内联 styles`));

        if (urls.length) {
          log(`样式文件校验：${module} 的 ${urls.length} 个 styleUrls 均可用`);
        }
        return null;
      },
    },
  };
}

/* ------------------------------------------------------------------ *
 * 插件 2：全局样式表（angular.json 的 styles）
 * ------------------------------------------------------------------ */

export function cssGlobalStylesPlugin(options: CssPluginOptions = {}): Plugin {
  const files = (options.globalStyles ?? []).map((entry) =>
    isAbsolute(entry) ? entry : resolve(options.workspaceRoot ?? process.cwd(), entry),
  );
  const log: Logger = options.log ?? (() => {});
  const preprocess = options.preprocessCss ?? vitePreprocess;
  let config: ResolvedConfig | undefined;
  let payload: string[] | null = null;

  return {
    name: "godot-angular-css-global",
    configResolved(resolved) {
      config = resolved;
    },
    resolveId: {
      filter: { id: exactRegex(GLOBAL_CSS_VIRTUAL) },
      handler() {
        return GLOBAL_CSS_RESOLVED;
      },
    },
    async buildStart() {
      if (!files.length) return;
      const sheets: string[] = [];
      for (const file of files) {
        this.addWatchFile(file);
        if (!existsSync(file)) {
          this.error(
            `全局样式表不存在：angular.json 的 styles 中的 "${file}" 不存在（相对 workspaceRoot 解析）。`,
          );
        }
        let css = readFileSync(file, "utf8");
        if (PREPROCESSABLE.test(file)) {
          css = await preprocess(css, file, config as ResolvedConfig);
        }
        // 全局样式也过一遍 lint：调用的是与组件同一个 buildRuleSets，“构建期更早发现”两边均分
        for (const warning of buildRuleSets(css).warnings) {
          log(`全局样式 ${relativeModule(file, config)}：${warning}`);
        }
        sheets.push(css);
      }
      payload = sheets;
    },
    load: {
      filter: { id: exactRegex(GLOBAL_CSS_RESOLVED) },
      handler() {
        const sheets = payload ?? [];
        // 纯 JS、纯赋值：虚拟模块没有 transform 兜底，而且它排在 Angular 之前
        return `globalThis.${GLOBAL_CSS_GLOBAL} = ${JSON.stringify(sheets)};\n`;
      },
    },
  };
}

function relativeModule(id: string, config?: ResolvedConfig): string {
  const root = config?.root;
  const clean = withoutQuery(id);
  // 报错与日志里的路径一律 posix：Windows 上 node:path 给的是反斜杠，同一条消息里
  // `src\a.ts` 与 `src/a.ts` 混着出现既难看也没法直接复制去命令行用
  if (root && clean.startsWith(root)) return toPosix(relative(root, clean)) || clean;
  return clean;
}

/** 两个插件一起挂载：pre / 默认 由 enforce 决定，数组顺序只影响同阶段 */
export function cssPlugins(options: CssPluginOptions = {}): Plugin[] {
  return [cssSourceGuardPlugin(options), cssGlobalStylesPlugin(options)];
}
