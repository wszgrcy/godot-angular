import { describe, expect, it } from "vitest";
import { resolveEntries, mergeEntryPatterns } from "../build-core";
import {
  isExternalDependency,
  isGodotBuiltinModule,
  normalizeAssets,
  normalizeEntries,
  splitStaticInput,
} from "../options";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
// 入口解析靠的是目录形状，所以给一份专用夹具（src/main.ts + src/app.ts + src/pages/*.ts +
// src/tests/legacy.ts），不依赖仓库里任何工程目录 —— 工程改名或删掉都不会把测试带坑。
const root = join(here, "fixtures", "entries");

const names = (...args: Parameters<typeof resolveEntries>) =>
  resolveEntries(...args).map((e) => e.name).sort();

describe("resolveEntries（名字 = 源码相对工程根的路径）", () => {
  it("字符串简写也带完整相对路径：引擎靠它反推 .ts 源码", () => {
    const entries = resolveEntries(root, ["src/main.ts"]);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("src/main");
    expect(entries[0].file).toBe(join(root, "src", "main.ts"));
  });

  it("input 只决定匹配起点，产物名始终带完整相对路径", () => {
    expect(names(root, ["src/pages/**/*.ts"])).toEqual(["src/pages/counter", "src/pages/hello"]);
    expect(names(root, [{ glob: "**/*.ts", input: "src/pages" }])).toEqual([
      "src/pages/counter",
      "src/pages/hello",
    ]);
  });

  it("output 已移除：写了就报错，不静默产出引擎反推不到的名字", () => {
    expect(() => names(root, [{ glob: "*.ts", input: "src/pages", output: "pages" }])).toThrow(
      /output 字段已移除/,
    );
  });

  it("不写 input 时不再反推公共目录：名字带 src/", () => {
    // input 缺省 = 静态前缀 = ""，命中的唯一文件保留完整路径 src/main
    expect(names(root, [{ glob: "**/main.ts" }])).toEqual(["src/main"]);
  });

  it("新增文件不会把已有入口改名（名字只看自己那个文件）", () => {
    expect(names(root, [{ glob: "counter.ts", input: "src/pages" }])).toEqual(["src/pages/counter"]);
    expect(names(root, [{ glob: "*.ts", input: "src/pages" }])).toEqual([
      "src/pages/counter",
      "src/pages/hello",
    ]);
  });

  it("ignore 排除掉不想当入口的文件（spec 就在同一个树里）", () => {
    expect(
      names(root, [
        { glob: "**/*.ts", input: "src", ignore: ["**/pages/**", "**/tests/**"] },
      ]),
    ).toEqual(["src/app", "src/main"]);
  });

  it("glob 匹配不到就抛，不静默产出空构建；报错带上 input", () => {
    expect(() => resolveEntries(root, ["src/nope/**/*.ts"])).toThrow(/未匹配到任何文件/);
    expect(() => resolveEntries(root, [{ glob: "*.ts", input: "src/nope" }])).toThrow(
      /src\/nope/,
    );
  });

  it("不同目录的同名文件各得其所，不再抢同一个产物名", () => {
    // 旧命名（名字相对 input）下两个 main.ts 会撞名；现在名字带完整相对路径，天然不撞
    const clash = mkdtempSync(join(tmpdir(), "entries-clash-"));
    try {
      for (const dir of ["a", "b"]) {
        mkdirSync(join(clash, dir), { recursive: true });
        writeFileSync(join(clash, dir, "main.ts"), "");
      }
      expect(names(clash, ["**/main.ts"])).toEqual(["a/main", "b/main"]);
    } finally {
      rmSync(clash, { recursive: true, force: true });
    }
  });

  it("多条模式命中同一个文件只算一个入口（glob 与显式路径重叠）", () => {
    // src/*.ts 已经包含 src/app.ts，再单写一遍不报错也不重复；废弃的 scriptClassEntries
    // 并进同一张表之后，靠的就是这条去重
    expect(names(root, [{ glob: "*.ts", input: "src" }, "src/app.ts"])).toEqual([
      "src/app",
      "src/main",
    ]);
    expect(names(root, ["src/app.ts", "src/app.ts"])).toEqual(["src/app"]);
    expect(names(root, ["src/pages/**/*.ts", "src/pages/counter.ts"])).toEqual([
      "src/pages/counter",
      "src/pages/hello",
    ]);
  });

  it("空模式表不报错（引擎测试走 inputOverride，entries 可以为空）", () => {
    expect(resolveEntries(root, [])).toEqual([]);
  });
});

describe("mergeEntryPatterns（scriptClassEntries 已废弃）", () => {
  it("废弃选项的内容并进 entries，并标记要给出迁移警告", () => {
    const merged = mergeEntryPatterns(["src/main.ts"], ["src/app.ts"]);
    expect(merged.usedDeprecated).toBe(true);
    expect(names(root, merged.patterns)).toEqual(["src/app", "src/main"]);
  });

  it("没写废弃选项时不警告", () => {
    expect(mergeEntryPatterns(["src/main.ts"], []).usedDeprecated).toBe(false);
  });

  it("同一个文件在两边各列一次，合并后仍只有一个入口", () => {
    const merged = mergeEntryPatterns(["src/pages/*.ts"], ["src/pages/hello.ts"]);
    expect(names(root, merged.patterns)).toEqual(["src/pages/counter", "src/pages/hello"]);
  });
});

describe("normalizeEntries / splitStaticInput", () => {
  it("字符串等价于 { glob }，input 由静态前缀推", () => {
    expect(normalizeEntries(["src/main.ts"])).toEqual([
      { glob: "main.ts", input: "src", output: "", ignore: [] },
    ]);
  });

  it("显式 input（含空串）时 glob 整条相对它，不再拆", () => {
    expect(normalizeEntries([{ glob: "src/pages/**/*.ts", input: "" }])).toEqual([
      { glob: "src/pages/**/*.ts", input: "", output: "", ignore: [] },
    ]);
  });

  it("output / input 归一到正斜杠并去首尾斜杠", () => {
    const one = normalizeEntries([{ glob: "a.ts", input: "src/pages/", output: "\\p\\" }])[0];
    expect(one.input).toBe("src/pages");
    expect(one.output).toBe("p");
  });

  it("splitStaticInput 只认静态段，整条静态时最后一段当文件名", () => {
    expect(splitStaticInput("src/main.ts")).toEqual({ input: "src", glob: "main.ts" });
    expect(splitStaticInput("src/pages/**/*.ts")).toEqual({
      input: "src/pages",
      glob: "**/*.ts",
    });
    expect(splitStaticInput("src/**/main.ts")).toEqual({ input: "src", glob: "**/main.ts" });
    expect(splitStaticInput("**/*.ts")).toEqual({ input: "", glob: "**/*.ts" });
  });
});

describe("isGodotBuiltinModule（引擎自带模块必须外部化）", () => {
  it("godot 与带点号的内置模块都算：godot.annotations 不是 godot 的子目录", () => {
    for (const id of [
      "godot",
      "godot-jsb",
      "godot.annotations",
      "godot.lib.api",
      "godot.typeloader",
      "godot.worker",
      "jsb.core",
      "jsb.inject",
      "godot/extra",
    ]) {
      expect(isGodotBuiltinModule(id), id).toBe(true);
    }
  });

  it("本库与第三方包不算，否则会被当成引擎模块而不去打包", () => {
    for (const id of ["godot-angular", "godot-angular/core", "rxjs", "jsbi", "@foo/godot"]) {
      expect(isGodotBuiltinModule(id), id).toBe(false);
    }
  });
});

describe("isExternalDependencies（口径同 @angular/build）", () => {
  it("裸名精确匹配", () => {
    expect(isExternalDependency("tslib", ["tslib"])).toBe(true);
    expect(isExternalDependency("tslibx", ["tslib"])).toBe(false);
  });

  it("scoped 包把包内所有路径算外部，含子路径", () => {
    expect(isExternalDependency("@foo/bar", ["@foo/bar"])).toBe(true);
    expect(isExternalDependency("@foo/bar/baz", ["@foo/bar"])).toBe(true);
    expect(isExternalDependency("@foo/barry", ["@foo/bar"])).toBe(false);
  });
});

describe("normalizeAssets", () => {
  it("字符串等价于 { glob }", () => {
    expect(normalizeAssets(["*.tres"])).toEqual([{ glob: "*.tres", input: "", output: "", ignore: [] }]);
  });

  it("对象缺省补空", () => {
    expect(normalizeAssets([{ glob: "a/**" }])).toEqual([
      { glob: "a/**", input: "", output: "", ignore: [] },
    ]);
  });

  it("没配就是空表，不产生任何拷贝", () => {
    expect(normalizeAssets(undefined)).toEqual([]);
  });
});
