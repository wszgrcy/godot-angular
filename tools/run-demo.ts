import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureImported, requireGodotBin } from "../packages/builder/shared/godot-bin";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const demoProjectDir = join(repoRoot, "demo");

const argv = process.argv.slice(2);
const windowed = argv.includes("--window");
const sceneIdx = argv.indexOf("--scene");
const scene = sceneIdx >= 0 ? argv[sceneIdx + 1] : undefined;

// builder 的 requireGodotBin 采用**抛异常**而不是 process.exit（builder 内 exit 会将
// CLI 的收尾逻辑一并终止），脚本这边接住后再退出。它抛出的文案已是可操作指引，直接输出。
let bin: string;
try {
  bin = requireGodotBin(repoRoot);
  ensureImported(demoProjectDir, bin);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

const args = ["--path", demoProjectDir];
if (!windowed) args.unshift("--headless");
if (scene) args.push(scene);

// CUJ_MODE=snapshot 使 demo/main.js 输出节点树后退出；有头模式留空，正常运行。
const env: NodeJS.ProcessEnv = { ...process.env, CUJ_MODE: windowed ? "" : "snapshot" };

const proc = spawnSync(bin, args, { stdio: "inherit", env });
process.exit(proc.status ?? 1);
