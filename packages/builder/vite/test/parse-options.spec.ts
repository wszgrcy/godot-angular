import { describe, expect, it } from "vitest";
import { parseOptions } from "../../shared/parse-options";
import { applicationOptionsSchema } from "../options-schema";
import { filterMatches, filterOf, handlerOf } from "./hook";
import {
  MANDATORY_POLYFILL,
  POLYFILL_ENTRY_SPECIFIER,
  polyfillExtras,
  polyfillPlugin,
} from "../polyfill";

const minimal = {
  entries: ["src/main.ts"],
  tsConfig: "tsconfig.json",
  outputPath: "dist",
  resRoot: "res://dist",
};

describe("parseOptions", () => {
  it("补齐 schema 里声明的默认值", () => {
    const o = parseOptions(applicationOptionsSchema, minimal, "application");
    expect(o.polyfills).toEqual([]);   // 必带项不在选项里，写死在虚拟入口
    expect(o.outputHashing).toBe("none");
    expect(o.deleteOutputPath).toBe(true);
    expect(o.optimization).toBe(false);
    expect(o.externalDependencies).toEqual([]);
  });

  it("显式给的值得赢过默认值（含显式空数组）", () => {
    const o = parseOptions(applicationOptionsSchema, { ...minimal, polyfills: [] }, "application");
    expect(o.polyfills).toEqual([]);
  });

  it("polyfills 只能追加：必带项不会被替换掉，重复项被收掉", () => {
    expect(polyfillExtras(["a", "b"])).toEqual(["a", "b"]);
    // 用户把必带项写进来也不重复（它由虚拟入口自己第一行保证）
    expect(polyfillExtras([MANDATORY_POLYFILL, "a", "a"])).toEqual(["a"]);
    expect(polyfillExtras([])).toEqual([]);
  });

  it("虚拟 polyfill 入口：必带项永远第一行，追加项接在后", () => {
    const plugin = polyfillPlugin({ resRoot: "res://dist", extras: polyfillExtras(["a", "b"]) });
    const resolveId = handlerOf<(id: string) => string | null>(plugin.resolveId);
    const load = handlerOf<(id: string) => string>(plugin.load);
    const id = resolveId(POLYFILL_ENTRY_SPECIFIER);
    expect(id).toBeTruthy();
    const code = load(id as string) as string;
    const lines = code.split("\n");
    expect(lines[0]).toBe(`import ${JSON.stringify(MANDATORY_POLYFILL)};`);
    expect(lines[1]).toBe('import "a";');
    expect(lines[2]).toBe('import "b";');
    // 必须是纯 JS：虚拟模块没有 transform 兜底，带类型标注会直接报错
    expect(code).not.toMatch(/:/);

    // handler 不判断 id，“只认这一个说明符”的判定全在 filter 上
    expect(filterMatches(filterOf(plugin.resolveId), { id: POLYFILL_ENTRY_SPECIFIER })).toBe(true);
    expect(filterMatches(filterOf(plugin.resolveId), { id: "virtual:other" })).toBe(false);
    expect(filterMatches(filterOf(plugin.load), { id: POLYFILL_ENTRY_SPECIFIER })).toBe(true);
    expect(filterMatches(filterOf(plugin.load), { id: "node_modules/x/y.js" })).toBe(false);
  });

  it("未声明的键被洗掉 —— 所以 parse 必须在附加内部字段之前", () => {
    const o = parseOptions(applicationOptionsSchema, { ...minimal, extraPlugins: [1] }, "application") as Record<
      string,
      unknown
    >;
    expect(o.extraPlugins).toBeUndefined();
  });

  it("必填缺失时报错带字段名，不是 [object Object]", () => {
    const bad = { ...minimal };
    delete (bad as Record<string, unknown>).resRoot;
    let msg = "";
    try {
      parseOptions(applicationOptionsSchema, bad, "application");
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain("application 选项校验失败");
    expect(msg).toContain("at resRoot");
    expect(msg).not.toContain("[object Object]");
  });

  it("嵌套数组里的错能定位到下标", () => {
    let msg = "";
    try {
      parseOptions(
        applicationOptionsSchema,
        { ...minimal, fileReplacements: [{ replace: "a.ts" }] },
        "application",
      );
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    // v.summarize 的点号路径：数组下标也是 `.0.`，不是 `[0]`。
    expect(msg).toContain("at fileReplacements.0.with");
  });

  it("枚举值非法时报错列出期望与实收", () => {
    let msg = "";
    try {
      parseOptions(applicationOptionsSchema, { ...minimal, outputHashing: "all" }, "application");
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain("at outputHashing");
    expect(msg).toContain('Expected ("none" | "bundles")');
    expect(msg).toContain('received "all"');
  });
});
