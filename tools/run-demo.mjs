#!/usr/bin/env node
// 用 GodotJS 引擎跑 demo。
//   node tools/run-demo.mjs            → 无头 + 打印节点树（默认，可 CI）
//   node tools/run-demo.mjs --window   → 有显示环境时开真窗口
import { spawnSync } from "node:child_process";
import { GODOT_BIN, ensureImported } from "./godot.mjs";

const windowed = process.argv.includes("--window");
const demo = new URL("../demo/", import.meta.url).pathname;
ensureImported(demo);

const args = ["--path", demo];
if (!windowed) args.unshift("--headless");

const res = spawnSync(GODOT_BIN, args, {
  stdio: "inherit",
  // 无头模式下 demo 会自己 quit；没 quit 就是卡住了，别把 CI 挂死
  timeout: windowed ? 0 : 120_000,
  env: { ...process.env, CUJ_MODE: windowed ? "" : "snapshot" },
});
process.exit(res.status ?? 1);
