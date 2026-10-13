import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { requireGodotBin, resolveGodotBin } from "../../shared/godot-bin";

const savedEnv = process.env.GODOT_BIN;
// 模块加载时就清掉：下面要拿 resolveGodotBin 问平台布局，不能被机器上的 GODOT_BIN 污染。
// 显式那条用例自己临时设、自己还原。afterAll 里统一恢复。
delete process.env.GODOT_BIN;

const TMP = mkdtempSync(join(tmpdir(), "cuj-godot-bin-"));
/** 空工作区：用来问出本平台的期望路径（未预置的平台拿不到，相关用例整组跳过） */
const EMPTY = join(TMP, "empty-workspace");
mkdirSync(EMPTY, { recursive: true });

/** 本平台在 <ws>/bin/ 下期望的完整路径；未预置的平台（如 macOS）为 undefined */
const LAYOUT = resolveGodotBin(EMPTY).expected;
const HAS_PLATFORM = LAYOUT !== undefined;
/** 期望路径相对工作区根的部分，通常是 bin/<平台目录>/<可执行文件> */
const REL = LAYOUT ? relative(EMPTY, LAYOUT) : "";

/** 在某个工作区根下造一个假"二进制"，返回它的路径 */
function plantBin(workspaceRoot: string): string {
  const file = join(workspaceRoot, REL);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "#!/bin/sh\necho fake\n");
  return file;
}

afterAll(() => {
  if (savedEnv === undefined) delete process.env.GODOT_BIN;
  else process.env.GODOT_BIN = savedEnv;
  rmSync(TMP, { recursive: true, force: true });
});

describe("bin/ 只在工作区根里找", () => {
  it.runIf(HAS_PLATFORM)("工作区根下的 bin/ 命中", () => {
    const ws = join(TMP, "ws-hit");
    const planted = plantBin(ws);
    const r = resolveGodotBin(ws);
    expect(r.bin).toBe(planted);
    expect(r.source).toContain("bin/");
  });

  it.runIf(HAS_PLATFORM)("父目录里的 bin/ 不会被捡走", () => {
    // 危险的正主：父目录放着一个"引擎"，子工作区里什么都没有。
    const parent = join(TMP, "parent");
    const ws = join(parent, "ws");
    const planted = plantBin(parent);
    mkdirSync(ws, { recursive: true });

    const r = resolveGodotBin(ws);
    expect(r.bin).toBeNull();
    // 只找了一个位置，而且就在工作区根里面。
    expect(r.searched).toEqual([join(ws, REL)]);
    expect(r.expected).toBe(join(ws, REL));
    expect(existsSync(planted)).toBe(true); // 那个文件确实在，只是不该被用
  });

  it.runIf(HAS_PLATFORM)("找不到时报错说清期望位置，而不是静默用外面的", () => {
    const ws = join(TMP, "ws-missing");
    mkdirSync(ws, { recursive: true });
    let message = "";
    try {
      requireGodotBin(ws);
      expect.unreachable("应该抛");
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).toContain(join(ws, REL));
    expect(message).toContain("不向上级目录搜索");
  });
});

describe("显式路径（godotBin / GODOT_BIN）", () => {
  it("相对路径按工作区根解，不按进程 CWD", () => {
    expect(resolveGodotBin("/proj/app", "bin/x/godot").bin).toBe(resolve("/proj/app", "bin/x/godot"));
  });

  it("绝对路径原样保留", () => {
    expect(resolveGodotBin("/proj/app", "/opt/godot").bin).toBe("/opt/godot");
  });

  it.runIf(HAS_PLATFORM)("指目录时按平台表补上子目录与文件名", () => {
    // 存在的理由：一份配置跨平台通用。仓库内的 test-app/ 就靠这个指回仓库根的 bin/。
    const ws = join(TMP, "ws-dir");
    const planted = plantBin(ws);
    expect(resolveGodotBin(ws, "bin").bin).toBe(planted);
    expect(resolveGodotBin(ws, join(ws, "bin")).bin).toBe(planted);
    expect(requireGodotBin(ws, "bin")).toBe(planted);
  });

  it.runIf(HAS_PLATFORM)("指目录但里面没有本平台文件 → 报解析后的完整路径", () => {
    const ws = join(TMP, "ws-dir-empty");
    mkdirSync(join(ws, "bin"), { recursive: true });
    expect(() => requireGodotBin(ws, "bin")).toThrow(join(ws, REL));
  });

  it("环境变量也算显式来源", () => {
    const ws = join(TMP, "ws-env");
    mkdirSync(ws, { recursive: true });
    process.env.GODOT_BIN = "/opt/godot/engine";
    try {
      const r = resolveGodotBin(ws);
      expect(r.bin).toBe("/opt/godot/engine");
      expect(r.source).toContain("GODOT_BIN");
    } finally {
      delete process.env.GODOT_BIN;
    }
  });

  it("显式指向不存在的文件时抛，且抛的是那个路径本身", () => {
    expect(() => requireGodotBin("/proj", "/opt/nope/godot")).toThrow("/opt/nope/godot");
  });
});
