import { join, resolve } from "node:path";
import { globSync } from "tinyglobby";

/** 带 glob 的输入项：entries、scriptClassEntries、assets 三处用的是同一个形状。 */
export interface GlobInput {
  /** 查找根目录（相对 workspaceRoot，缺省为工程根）；`glob` 相对它写 */
  input?: string;
  glob: string;
  ignore?: string[];
}

/**
 * 展开一个输入项，返回匹配到的文件（相对 `input`，一律 `/` 分隔），已排序。
 * `expandDirectories: false` 避免把整个目录当匹配项展开，`onlyFiles: true` 只要文件。
 */
export function globInputFiles(workspaceRoot: string, p: GlobInput): string[] {
  const cwd = resolve(workspaceRoot, p.input ?? "");
  return globSync([p.glob], {
    cwd,
    ignore: p.ignore,
    expandDirectories: false,
    onlyFiles: true,
  })
    .map((rel) => rel.replace(/\\/g, "/"))
    .sort();
}

/** 展开并给出绝对路径。 */
export function globInputPaths(workspaceRoot: string, p: GlobInput): Array<{ rel: string; abs: string }> {
  const cwd = resolve(workspaceRoot, p.input ?? "");
  return globInputFiles(workspaceRoot, p).map((rel) => ({ rel, abs: join(cwd, rel) }));
}
