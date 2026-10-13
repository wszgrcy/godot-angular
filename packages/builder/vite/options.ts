import { isAbsolute, resolve } from "node:path";
import type { AssetPattern, EntryPattern, StyleEntry } from "./options-schema";
import { toPosix } from "../shared/path";

/**
 * `externalDependencies` 的匹配口径（官方原文）：`@foo/bar` 把该包内**所有路径**
 * 都算外部，含 `@foo/bar/baz` 这样的子路径。裸名同理。
 */
export function isExternalDependency(id: string, packages: string[]): boolean {
  for (const pkg of packages) {
    if (id === pkg || id.startsWith(`${pkg}/`)) return true;
  }
  return false;
}

/**
 * 归一化 assets：字符串分支展开为 `{ glob }`，可选字段补默认值。`input` = 搜索根（相对
 * workspaceRoot），`output` = 落点子目录（相对 outputPath）。返回类型故意不写，由这份
 * 实现推导得出，`NormalizedAsset` 由它派生，两者不可能分叉。
 */
export function normalizeAssets(patterns: AssetPattern[] | undefined) {
  return (patterns ?? []).map((p) =>
    typeof p === "string"
      ? { glob: p, input: "", output: "", ignore: [] }
      : { glob: p.glob, input: p.input ?? "", output: p.output ?? "", ignore: p.ignore ?? [] },
  );
}

/** 归一化后的 asset 条目 = 上述函数返回数组的元素类型，不另抄一份形状。 */
export type NormalizedAsset = ReturnType<typeof normalizeAssets>[number];

/**
 * 归一化全局样式表：`string | { input }` → 绝对路径列表。只去重、只拼接路径，不验证存在性
 * —— 那是 css 插件的职责，那里才有 `this.error()` 可以携带文件位置。
 */
export function normalizeGlobalStyles(entries: StyleEntry[] | undefined, workspaceRoot: string): string[] {
  return [
    ...new Set(
      (entries ?? []).map((entry) => {
        const input = typeof entry === "string" ? entry : entry.input;
        return isAbsolute(input) ? toPosix(input) : toPosix(resolve(workspaceRoot, input));
      }),
    ),
  ];
}

/** 含这些字符的段就是“模式段”，不再是静态目录名。 */
const GLOB_MAGIC = /[*?[{!]/;

/**
 * 将未显式给定 input 的 glob 拆为「静态前缀（作为 input）+ 剩余模式」。
 * 只看 glob 文本、不看命中了什么：由命中文件的公共目录反推，多一个文件就能使已有入口
 * 改名，而名称是 .tscn 中写死的引用。整条无通配符时 input 需要退一段，否则相对路径为空。
 */
export function splitStaticInput(glob: string): { input: string; glob: string } {
  const segs = glob.split("/");
  let i = 0;
  while (i < segs.length && !GLOB_MAGIC.test(segs[i])) i++;
  const cut = i === segs.length ? Math.max(segs.length - 1, 0) : i;
  return { input: segs.slice(0, cut).join("/"), glob: segs.slice(cut).join("/") };
}

/**
 * 归一化 entries：字符串分支展开为 `{ glob }`，可选字段补默认值。口径同 normalizeAssets，
 * 差别仅在 input 缺省值取 glob 的静态前缀（见 splitStaticInput）。显式给定 input 时
 * 完全按用户所述处理。返回类型故意不写，由实现推导得出。
 */
export function normalizeEntries(patterns: EntryPattern[]) {
  return patterns.map((p) => {
    const raw = typeof p === "string" ? { glob: p } : p;
    const glob = toPosix(raw.glob).replace(/^\.\//, "");
    const output = raw.output ? trimSlashes(toPosix(raw.output)) : "";
    const ignore = raw.ignore ?? [];
    if (raw.input !== undefined) {
      return { glob, input: trimSlashes(toPosix(raw.input)), output, ignore };
    }
    const split = splitStaticInput(glob);
    return { glob: split.glob, input: trimSlashes(split.input), output, ignore };
  });
}

/** 归一化后的 entry 条目 = 上述函数返回数组的元素类型。 */
export type NormalizedEntry = ReturnType<typeof normalizeEntries>[number];

/** 去除首尾斜杠（空串仍为空串 = “就是根目录”）。 */
function trimSlashes(p: string): string {
  return p.replace(/^\/+/, "").replace(/\/+$/, "");
}
