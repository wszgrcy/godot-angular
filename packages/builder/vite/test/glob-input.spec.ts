import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { globInputFiles, globInputPaths } from "../glob-input";

let root = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "glob-input-"));
  mkdirSync(join(root, "src/nested"), { recursive: true });
  writeFileSync(join(root, "src/b.ts"), "");
  writeFileSync(join(root, "src/a.ts"), "");
  writeFileSync(join(root, "src/skip.ts"), "");
  writeFileSync(join(root, "src/nested/c.ts"), "");
  // 空目录：onlyFiles 为真时不该被当成匹配项展开出来
  mkdirSync(join(root, "src/empty"), { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("globInputFiles", () => {
  it("结果已排序且一律用 /", () => {
    expect(globInputFiles(root, { glob: "**/*.ts", input: "src" })).toEqual([
      "a.ts",
      "b.ts",
      "nested/c.ts",
      "skip.ts",
    ]);
  });

  it("ignore 生效", () => {
    expect(globInputFiles(root, { glob: "**/*.ts", input: "src", ignore: ["**/skip.ts"] })).toEqual([
      "a.ts",
      "b.ts",
      "nested/c.ts",
    ]);
  });

  it("input 省略时以 workspaceRoot 为根", () => {
    expect(globInputFiles(root, { glob: "src/*.ts" })).toEqual(["src/a.ts", "src/b.ts", "src/skip.ts"]);
  });

  it("空目录不会被展开成匹配项", () => {
    expect(globInputFiles(root, { glob: "**", input: "src/empty" })).toEqual([]);
  });

  it("globInputPaths 顺带给出绝对路径", () => {
    const found = globInputPaths(root, { glob: "*.ts", input: "src" });
    expect(found.map((f) => f.rel)).toEqual(["a.ts", "b.ts", "skip.ts"]);
    expect(found[0]!.abs).toBe(join(root, "src/a.ts"));
  });
});
