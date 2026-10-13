import { describe, expect, it } from "vitest";
import { resolveEntries } from "../build-core";
import {
  isExternalDependency,
  normalizeAssets,
  normalizeEntries,
  splitStaticInput,
} from "../options";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// 入口解析靠的是目录形状，所以给一份专用夹具（src/main.ts + src/app.ts + src/pages/*.ts +
// src/tests/legacy.ts），不依赖仓库里任何工程目录 —— 工程改名或删掉都不会把测试带坑。
const root = join(here, "fixtures", "entries");

const names = (...args: Parameters<typeof resolveEntries>) =>
  resolveEntries(...args).map((e) => e.name).sort();

describe("resolveEntries（口径同 assets）", () => {
  it("字符串简写：input = glob 的静态前缀，单入口名就是 basename", () => {
    const entries = resolveEntries(root, ["src/main.ts"]);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("main");
    expect(entries[0].file).toBe(join(root, "src", "main.ts"));
  });

  it("glob 的静态前缀当 input：src/pages/**/*.ts 出的名字不带 src/pages/", () => {
    expect(names(root, ["src/pages/**/*.ts"])).toEqual(["counter", "hello"]);
  });

  it("显式 input 与静态前缀等价", () => {
    expect(names(root, [{ glob: "**/*.ts", input: "src/pages" }])).toEqual(["counter", "hello"]);
  });

  it("output 把产物摆进子目录（名字带前缀，rollup 的 [name] 连目录一起出）", () => {
    expect(names(root, [{ glob: "*.ts", input: "src/pages", output: "pages" }])).toEqual([
      "pages/counter",
      "pages/hello",
    ]);
  });

  it("不写 input 时不再反推公共目录：名字带 src/", () => {
    // input 缺省 = 静态前缀 = ""，命中的唯一文件保留完整路径 src/main
    expect(names(root, [{ glob: "**/main.ts" }])).toEqual(["src/main"]);
  });

  it("新增文件不会把已有入口改名（旧公共目录算法的坑）", () => {
    // 只匹配 counter 时名字是 counter；多一个 hello 进来，counter 仍叫 counter
    expect(names(root, [{ glob: "counter.ts", input: "src/pages" }])).toEqual(["counter"]);
    expect(names(root, [{ glob: "*.ts", input: "src/pages" }])).toEqual(["counter", "hello"]);
  });

  it("ignore 排除掉不想当入口的文件（spec 就在同一个树里）", () => {
    expect(
      names(root, [
        { glob: "**/*.ts", input: "src", ignore: ["**/pages/**", "**/tests/**"] },
      ]),
    ).toEqual(["app", "main"]);
  });

  it("glob 匹配不到就抛，不静默产出空构建；报错带上 input", () => {
    expect(() => resolveEntries(root, ["src/nope/**/*.ts"])).toThrow(/未匹配到任何文件/);
    expect(() => resolveEntries(root, [{ glob: "*.ts", input: "src/nope" }])).toThrow(
      /src\/nope/,
    );
  });

  it("两个模式算出同一个名字 → 抛，不静默覆盖", () => {
    expect(() =>
      resolveEntries(root, ["src/pages/*.ts", { glob: "*.ts", input: "src/pages" }]),
    ).toThrow(/入口名重复/);
  });

  it("entries 空数组也抛（不是“没入口也算成功”）", () => {
    expect(() => resolveEntries(root, [])).toThrow(/未配置任何入口/);
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
