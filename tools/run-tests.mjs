#!/usr/bin/env node
// 在 GodotJS 引擎里跑集成测试（demo/test.tscn）。
// 解析 [TEST] passed=N failed=M 决定退出码，可直接进 CI。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { requireGodotBin, demoDir, ensureImported } from "./godot.mjs";

const bin = requireGodotBin();
if (!existsSync(join(demoDir, "dist", "app.bundle.js"))) {
  console.error("缺 demo/dist/app.bundle.js —— 先跑 pnpm build");
  process.exit(1);
}
ensureImported(demoDir, bin);

const res = spawnSync(bin, ["--headless", "--path", demoDir, "res://test.tscn"], {
  encoding: "utf8",
  timeout: 180_000,
  env: { ...process.env },
});
const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
process.stdout.write(out);

const summary = /\[TEST\] passed=(\d+) failed=(\d+)/.exec(out);
if (!summary) {
  console.error("\n[run-tests] 没拿到测试汇总，测试场景可能没跑起来");
  process.exit(1);
}
const [, passed, failed] = summary;
console.log(`\n[run-tests] 引擎集成测试：${passed} 通过 / ${failed} 失败`);
process.exit(Number(failed) > 0 ? 1 : 0);
