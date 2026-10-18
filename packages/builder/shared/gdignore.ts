import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Godot 依靠这个空文件把目录（含整个子树）排除在资源导入之外：不出现在文件系统面板，
 * 不会被扫描，也不会生成 `.uid` / `.import`。
 */
export const GDIGNORE = ".gdignore";

/**
 * 在目录下写入 `.gdignore`（内容为空，重复调用无副作用）。
 *
 * 适用于「只由 `require()` 读取、不该被当作资源」的产物目录：缺了它，一次 `--import` 就会
 * 为每个 `.js` 生成 `.uid` 并写进 `uid_cache.bin`，而产物每次重建都可能换名字，缓存里只剩噪音。
 */
export function writeGdignore(dir: string): void {
  writeFileSync(join(dir, GDIGNORE), "");
}
