// GodotJS 运行时的公共工具：定位二进制 + 自动刷新脚本资源缓存。
//
// 为什么需要自动 --import：GodotJS 会把 .js 当 Script 资源缓存。改了 demo/main.js
// 但不跑 --import，引擎会静默用旧副本 —— 实测症状是「一行都不打印 + 挂到超时」，
// 不报任何错，非常费时间。这里用入口 .js 的哈希做戳，变了就先补一次 import。
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

/**
 * 引擎二进制解析。
 *
 * 查找顺序：
 *   1. 环境变量 GODOT_BIN（显式覆盖，CI / 非常规路径用）
 *   2. 仓库内 bin/<平台目录>/<可执行文件>（预定义映射，日常不需要设环境变量）
 *
 * 子目录名 = GodotJS release 资产的解压目录名，文件名 = 里面的可执行文件名。
 * 二进制本身在 .gitignore 里（175 MB/个），放置说明见 bin/README.md。
 */
export const repoRoot = fileURLToPath(new URL("../", import.meta.url));
export const demoDir = join(repoRoot, "demo");
const binRoot = join(repoRoot, "bin");

/** 平台键（process.platform + process.arch）→ GodotJS 资产目录 / 可执行文件名 */
export const BIN_TABLE = {
  "linux-x64": { dir: "linux-editor-4.6.1-v8", exe: "godot.linuxbsd.editor.x86_64" },
  "win32-x64": { dir: "windows-editor-4.6.1-v8", exe: "godot.windows.editor.x86_64.exe" },
};

/** 返回 { bin, source } 或 { bin: null, expected, key } */
export function resolveGodotBin() {
  if (process.env.GODOT_BIN) {
    return { bin: process.env.GODOT_BIN, source: "环境变量 GODOT_BIN" };
  }
  const key = `${process.platform}-${process.arch}`;
  const hit = BIN_TABLE[key];
  if (!hit) return { bin: null, expected: null, key };
  const expected = join(binRoot, hit.dir, hit.exe);
  if (existsSync(expected)) return { bin: expected, source: `bin/ (${key})` };
  return { bin: null, expected, key };
}

export function requireGodotBin() {
  const found = resolveGodotBin();
  if (!found.bin) {
    console.error("找不到 GodotJS 引擎二进制（官方 Godot 跑不了 .js，必须 GodotJS 构建）。\n");
    if (found.expected) {
      console.error(`它找过了：
  ${found.expected}

从 https://github.com/godotjs/GodotJS/releases 下载 ${found.key} 的编辑器构建，
把可执行文件放到上面那个路径（子目录不存在就自己建），详见 bin/README.md。
或者用环境变量指向任意位置：
`);
      console.error(
        process.platform === "win32"
          ? '  $env:GODOT_BIN = "C:\\path\\to\\godot.windows.editor.x86_64.exe"\n'
          : "  export GODOT_BIN=/path/to/godot.linuxbsd.editor.x86_64\n",
      );
    } else {
      console.error(`当前平台 ${found.key} 未预置。已知映射：
`);
      for (const [k, v] of Object.entries(BIN_TABLE)) console.error(`  ${k}  ->  bin/${v.dir}/${v.exe}`);
      console.error("\n本平台请用环境变量指定：export GODOT_BIN=/path/to/引擎\n");
    }
    process.exit(1);
  }
  if (!existsSync(found.bin)) {
    console.error(`GODOT_BIN 指向的文件不存在：${found.bin}`);
    process.exit(1);
  }
  return found.bin;
}

/** 只戳入口脚本（bundle 是 require 读的，不走资源缓存） */
function entryHash(demoDir) {
  const hash = createHash("sha256");
  for (const file of readdirSync(demoDir).filter((f) => f.endsWith(".js")).sort()) {
    hash.update(file).update("\0").update(readFileSync(join(demoDir, file))).update("\0");
  }
  for (const file of readdirSync(demoDir).filter((f) => f.endsWith(".tscn")).sort()) {
    hash.update(file).update("\0").update(readFileSync(join(demoDir, file))).update("\0");
  }
  return hash.digest("hex");
}

/** 入口脚本变过就先跑一次 --import，避免静默用旧脚本 */
export function ensureImported(demoDir, bin = GODOT_BIN) {
  const stampDir = join(demoDir, ".godot");
  if (!existsSync(stampDir)) mkdirSync(stampDir, { recursive: true });
  const stampFile = join(stampDir, "cuj-entry-hash");
  const current = entryHash(demoDir);  if (existsSync(stampFile) && readFileSync(stampFile, "utf8") === current) return;

  process.stderr.write("[godot] 入口脚本有变化，先刷新资源缓存 (--import)\n");
  const res = spawnSync(bin, ["--headless", "--path", demoDir, "--import"], {
    stdio: "ignore",
  });
  if (res.status !== 0) {
    process.stderr.write("[godot] --import 失败，继续尝试运行（可能用的是旧脚本）\n");
    return;
  }
  writeFileSync(stampFile, current);
}
