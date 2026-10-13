import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateGodotTypings } from "../packages/builder/typings-gen/generator";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 四份 typings 的落点。每项都是 `<宿主目录>/typings`——必须是专用子目录而不是宿主目录
 * 自身：重写是整目录删除，指向宿主目录就等于删除源码（生成器内有 .gdignore 判据兜底，
 * 但不应依赖它拦截笔误）。
 */
const TARGETS = [
  "demo/typings",
  "test-app/typings",
  "packages/library/typings",
  "packages/builder/typings",
];

const result = generateGodotTypings({ workspaceRoot: repoRoot, outDirs: TARGETS });
console.log(
  `[gen:typings] 完成（引擎 ${result.engine}，${result.fileCount} 个文件 × ${TARGETS.length} 处）`,
);
