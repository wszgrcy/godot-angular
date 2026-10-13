import isRelative from "is-relative";
import normalizePath from "normalize-path";

/**
 * 分隔符归一为 `/`（同时合并 `a//b` 的重复斜杠）。尾分隔符保留，是否保留由调用方决定。
 *
 * 用途：产物中的路径字符串、emitFile 的 fileName，以及任何需要与 bundle key 比较的内容。
 */
export function toPosix(p: string): string {
  return normalizePath(p, false);
}

/**
 * 是否为绝对路径——识别当前平台原生绝对路径、Windows 盘符与 UNC。
 *
 * 不使用 `path.isAbsolute`：它按当前平台判断，而待判断的字符串可能来自其他平台形态
 *（配置中写 `C:/x`，在 Linux 上 isAbsolute 会判定为“相对”）。
 */
export function isAbsoluteish(p: string): boolean {
  return !isRelative(p);
}

/**
 * 移除 `?query` / `#fragment`，取得 id 真正指向的文件。
 * vite 传递给钩子的 id 是带查询串的（`?raw`、`?v=hash`），用于打开文件前均需先经过此处。
 */
export function withoutQuery(id: string): string {
  const i = id.search(/[?#]/);
  return i === -1 ? id : id.slice(0, i);
}
