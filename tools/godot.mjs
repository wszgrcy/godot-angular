// GodotJS 运行时的公共工具：定位二进制 + 自动刷新脚本资源缓存。
//
// 为什么需要自动 --import：GodotJS 会把 .js 当 Script 资源缓存。改了 demo/main.js
// 但不跑 --import，引擎会静默用旧副本 —— 实测症状是「一行都不打印 + 挂到超时」，
// 不报任何错，非常费时间。这里用入口 .js 的哈希做戳，变了就先补一次 import。
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export const GODOT_BIN =
  process.env.GODOT_BIN ??
  "/workspace/godot-test/tools_dl/godotjs/linux-editor-4.6.1-v8/godot.linuxbsd.editor.x86_64";

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
