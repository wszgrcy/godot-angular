#!/usr/bin/env node
// 环境自检：新机器上先跑 `pnpm check`，缺什么直接告诉你怎么补。
// 退出码 0 = 可以跑 demo 和测试；1 = 有阻塞项。
// 注意：不能叫 `pnpm doctor`，那个名字被 pnpm 自己的内置命令占了。
import { spawnSync } from "node:child_process";
import { existsSync, accessSync, constants } from "node:fs";
import { join } from "node:path";
import { repoRoot, resolveGodotBin } from "./godot.mjs";

const problems = [];
const lines = [];

function ok(msg) { lines.push(`  \x1b[32m✓\x1b[0m ${msg}`); }
function bad(msg, fix) { lines.push(`  \x1b[31m✗\x1b[0m ${msg}`); if (fix) lines.push(`     → ${fix}`); problems.push(msg); }
function warn(msg) { lines.push(`  \x1b[33m!\x1b[0m ${msg}`); }

const isWin = process.platform === "win32";

// --- Node ---
const major = Number(process.versions.node.split(".")[0]);
if (major >= 22) ok(`Node ${process.versions.node} (${process.platform}/${process.arch})`);
else bad(`Node ${process.versions.node} 过低（需 ≥22）`, "装 Node 22+，Angular 22 和 Vite 7 都要求");

// --- pnpm ---
// Windows 上 pnpm 是 pnpm.cmd，spawnSync 不带 shell 直接 ENOENT
const pnpmBin = isWin ? "pnpm.cmd" : "pnpm";
const pm = spawnSync(pnpmBin, ["--version"], { encoding: "utf8", shell: isWin });
if (pm.status === 0) ok(`pnpm ${String(pm.stdout).trim()}`);
else bad("pnpm 不在 PATH 上", "corepack enable pnpm（或 corepack pnpm install）");

// --- 依赖 ---
// pnpm 把依赖装到各 workspace 包自己的 node_modules 里，根目录没有 @angular
const depsOk =
  existsSync(join(repoRoot, "packages", "core", "node_modules", "@angular", "core")) &&
  existsSync(join(repoRoot, "demo", "node_modules", "vite"));
if (depsOk) ok("workspace 依赖已安装");
else bad("依赖未安装", "pnpm install");

// --- GodotJS 二进制 ---
const found = resolveGodotBin();
const bin = found.bin;
if (!bin) {
  bad(
    "找不到 GodotJS 引擎二进制",
    found.expected
      ? `从 GodotJS releases 下载后放到 ${found.expected}（见 bin/README.md），或设 GODOT_BIN`
      : `本平台 ${found.key} 未预置，请设 GODOT_BIN 指向引擎可执行文件`,
  );
} else if (!existsSync(bin)) {
  bad(`引擎路径不存在: ${bin}`, found.source === "环境变量 GODOT_BIN" ? "检查 GODOT_BIN 拼写" : "重新放置二进制");
} else {
  try {
    accessSync(bin, constants.X_OK);
  } catch {
    if (!isWin) warn("二进制没有执行权限，记得 chmod +x");
  }
  const ver = spawnSync(bin, ["--headless", "--version"], { encoding: "utf8", timeout: 30_000 });
  if (ver.error) {
    bad(`二进制跑不起来: ${ver.error.message}`, "Windows 上确认是 .exe；Linux 上确认有执行权限和对应架构");
  } else {
    const out = `${ver.stdout ?? ""}${ver.stderr ?? ""}`.trim().split("\n")[0] || "(无输出)";
    ok(`引擎可执行（来源：${found.source}）: ${out}`);
    lines.push(`     ${bin}`);
    if (/4\.6/.test(out)) ok("版本号符合 GodotJS 4.6.x");
    else warn(`版本号没看到 4.6（GodotJS 目前基于 4.6.1）：${out}`);
  }
  lines.push("  \x1b[33m!\x1b[0m 官方 Godot 也自称 Godot Engine，唯一可靠判据是 pnpm test:engine 能跑通");
}

// --- 产物 ---
if (existsSync(join(repoRoot, "demo", "dist", "app.bundle.js"))) ok("demo/dist/app.bundle.js 已构建");
else warn("还没构建（pnpm build），test:engine 需要它");

console.log("\ncontrol-ui-js 环境自检\n" + "-".repeat(34));
console.log(lines.join("\n"));
console.log(problems.length ? `\n${problems.length} 项待处理\n` : "\n环境就绪\n");
process.exit(problems.length ? 1 : 0);
