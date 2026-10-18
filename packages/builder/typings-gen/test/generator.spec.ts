import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GDIGNORE,
  describeOutput,
  findWorkspaceRoot,
  generateGodotTypings,
  resolveUnder,
  writeTypingsBundle,
  type GodotTypingsBundle,
} from "../generator";

const BUNDLE: GodotTypingsBundle = {
  engine: "test",
  files: [
    { path: "godot0.gen.d.ts", content: "declare module 'godot' {}\n" },
    { path: "godot/index.d.ts", content: "/// <reference path=\"../godot0.gen.d.ts\" />\n" },
  ],
};

let scratch = "";

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "typings-spec-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("writeTypingsBundle", () => {
  it("目录不存在时直接创建", () => {
    const out = join(scratch, "typings");
    writeTypingsBundle(out, BUNDLE);
    expect(readdirSync(out).sort()).toEqual([".gdignore", "godot", "godot0.gen.d.ts"]);
  });

  it("重写会清掉上一版残留的 .d.ts", () => {
    const out = join(scratch, "typings");
    writeTypingsBundle(out, BUNDLE);
    writeFileSync(join(out, "godot9.gen.d.ts"), "// 上一版残留\n");

    writeTypingsBundle(out, BUNDLE);
    expect(existsSync(join(out, "godot9.gen.d.ts"))).toBe(false);
  });

  it("拒绝重写不是生成目录的目录，并且不动它的内容", () => {
    const sourceDir = join(scratch, "packages", "library");
    mkdirSync(sourceDir, { recursive: true });
    writeFileSync(join(sourceDir, "index.ts"), "export const keep = 1;\n");

    expect(() => writeTypingsBundle(sourceDir, BUNDLE)).toThrow(/不是 typings 生成目录/);
    // 关键断言：抛错发生在删除之前，源码必须还在
    expect(existsSync(join(sourceDir, "index.ts"))).toBe(true);
  });

  it("有 .gdignore 但没有 *.gen.d.ts 也算不上生成目录", () => {
    const odd = join(scratch, "odd");
    mkdirSync(odd, { recursive: true });
    writeFileSync(join(odd, ".gdignore"), "");

    expect(() => writeTypingsBundle(odd, BUNDLE)).toThrow(/不是 typings 生成目录/);
  });

  it("指向根目录的输出直接拒，不看内容", () => {
    // looksLikeTypingsDir 对不存在的目录是放行的，所以“拒写根目录”必须单独挡一道
    expect(() => writeTypingsBundle("/", BUNDLE)).toThrow(/指向根目录/);
    expect(() => writeTypingsBundle(".", BUNDLE)).toThrow(/指向根目录/);
    expect(() => writeTypingsBundle("", BUNDLE)).toThrow(/指向根目录/);
  });

  it(".gdignore 确实写入磁盘（Godot 靠它排除资源导入）", () => {
    const out = join(scratch, "typings");
    writeTypingsBundle(out, BUNDLE);
    expect(existsSync(join(out, GDIGNORE))).toBe(true);
  });
});

describe("generateGodotTypings", () => {
  it("outDirs 为空时立刻报错，不去跑引擎", () => {
    expect(() =>
      generateGodotTypings({ workspaceRoot: scratch, outDirs: [] }),
    ).toThrow(/outDirs 为空/);
  });

  it("输出目录不安全时，在跑引擎之前就报错", () => {
    // scratch 里没有引擎二进制：要是先跑了引擎，报的就是“找不到二进制”。
    // 报的是目录判据，就证明预检确实排在引擎前面。
    mkdirSync(join(scratch, "src"), { recursive: true });
    expect(() =>
      generateGodotTypings({ workspaceRoot: scratch, outDirs: ["src"] }),
    ).toThrow(/不是 typings 生成目录/);
  });
});

describe("resolveUnder", () => {
  it("相对路径按给定根解，绝对路径原样返回", () => {
    expect(resolveUnder("/w", "my-app/typings")).toBe(join("/w", "my-app/typings"));
    expect(resolveUnder("/w", "/abs/typings")).toBe("/abs/typings");
  });
});

describe("findWorkspaceRoot", () => {
  it("从子目录往上找 angular.json / project.godot", () => {
    const ws = join(scratch, "ws");
    mkdirSync(join(ws, "src", "deep"), { recursive: true });
    writeFileSync(join(ws, "angular.json"), "{}");
    expect(findWorkspaceRoot(join(ws, "src", "deep"))).toBe(ws);
  });

  it("找不到时回写入出发目录", () => {
    expect(findWorkspaceRoot(scratch)).toBe(scratch);
  });
});

describe("describeOutput", () => {
  it("带上文件数与引擎版本", () => {
    expect(describeOutput("/x/typings", BUNDLE)).toBe("  /x/typings  2 个文件（引擎 test）");
  });
});
