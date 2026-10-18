import { describe, expect, it } from "vitest";
import { matchQuery, mediaQueryDependencies, parseQuery, CssCode, CssError } from "godot-angular/css";

describe("parseQuery", () => {
  it("无特性的查询", () => {
    expect(parseQuery("screen")).toEqual([{ inverse: false, type: "screen", features: [] }]);
    expect(parseQuery("not screen")).toEqual([{ inverse: true, type: "screen", features: [] }]);
    expect(parseQuery("all")[0].type).toBe("all");
  });

  it("非法查询抛 CssError（matchQuery 会把它兜成 false）", () => {
    for (const bad of ["some crap", "48em", "screen and crap", "screen and (48em)", "screen and (foo:)", "()", "(foo) (bar)", "(foo:) and (bar)"]) {
      expect(() => parseQuery(bad), bad).toThrow(CssError);
    }
    try {
      parseQuery("some crap");
      expect.unreachable("应当抛错");
    } catch (e) {
      expect((e as CssError).code).toBe(CssCode.MediaQuerySyntax);
    }
  });

  it("min/max 修饰符被拆出来", () => {
    expect(parseQuery("(min-width: 100px)")[0].features).toEqual([{ modifier: "min", property: "width", value: "100px" }]);
    expect(parseQuery("(max-height: 50%)")[0].features).toEqual([{ modifier: "max", property: "height", value: "50%" }]);
  });
});

describe("matchQuery", () => {
  const table: Array<[string, Record<string, string | number>, boolean]> = [
    // 数值比较
    ["(min-width: 500px)", { width: 600 }, true],
    ["(min-width: 500px)", { width: 400 }, false],
    ["(min-width: 500px)", { width: 500 }, true],
    ["(max-width: 500px)", { width: 400 }, true],
    ["(width: 800px)", { width: 800 }, true],
    ["(width: 800px)", { width: 900 }, false],
    ["(min-height: 48em)", { height: 1000 }, true],
    ["(min-height: 48em)", { height: 500 }, false],
    // em/rem 在媒体查询里有确定定义（相对根字号），可以换算
    ["(min-width: 30rem)", { width: 600 }, true],
    // 字符串特性
    ["(orientation: portrait)", { orientation: "portrait" }, true],
    ["(orientation: landscape)", { orientation: "portrait" }, false],
    ["(prefers-color-scheme: dark)", { "prefers-color-scheme": "dark" }, true],
    ["(prefers-color-scheme: dark)", { "prefers-color-scheme": "light" }, false],
    ["(prefers-color-scheme: DARK)", { "prefers-color-scheme": "dark" }, true],
    // 类型
    ["screen", { type: "screen" }, true],
    ["screen", { type: "print" }, false],
    ["screen and (orientation: portrait)", { type: "print", orientation: "portrait" }, false],
    ["(min-width: 500px)", { type: "screen" }, false],
    ["(min-width: 500px)", { width: 700 }, true],
    // not / 逗号（or）
    ["not screen and (orientation: portrait)", { type: "screen", orientation: "landscape" }, false],
    ["not screen and (color), screen and (min-height: 48em)", { type: "screen", height: 1000 }, true],
    ["not all and (min-width: 48em)", { type: "all", width: 1000 }, false],
    ["not screen and (min-width: 48px)", { width: 24 }, true],
    ["screen, print", { type: "print" }, true],
    // and 要求全部满足
    ["(min-width: 100px) and (max-width: 200px)", { width: 150 }, true],
    ["(min-width: 100px) and (max-width: 200px)", { width: 300 }, false],
  ];

  for (const [query, env, expected] of table) {
    it(`${query} @ ${JSON.stringify(env)} = ${expected}`, () => {
      expect(matchQuery(query, env)).toBe(expected);
    });
  }

  it("写坏的查询判 false，不抛（一条坏查询不该把整棵树的样式带崩）", () => {
    expect(matchQuery("some crap", { width: 100 })).toBe(false);
    expect(matchQuery("(min-width: 50vw)", { width: 100 })).toBe(false);
  });

  it("缺环境值判不命中，而不是当 0", () => {
    expect(matchQuery("(min-width: 0px)", {})).toBe(false);
    expect(matchQuery("(min-width: 0px)", { width: 0 })).toBe(true);
  });

  it("依赖清单：只订阅真正用到的环境键", () => {
    expect(mediaQueryDependencies("(min-width: 100px)")).toEqual(["width"]);
    expect(mediaQueryDependencies("screen and (min-width: 100px)").sort()).toEqual(["type", "width"]);
    expect(mediaQueryDependencies("(prefers-color-scheme: dark)")).toEqual(["prefers-color-scheme"]);
    expect(mediaQueryDependencies("some crap")).toEqual([]);
  });
});
