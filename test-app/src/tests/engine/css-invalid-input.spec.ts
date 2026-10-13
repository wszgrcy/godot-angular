import { describe, expect, it } from "vitest";
import {
  colorToCss,
  expandShorthand,
  fourSidesFromParts,
  isCustomPropertyDeclaration,
  isGlobalKeyword,
  isMultiValue,
  isUnsupportedUnit,
  isZero,
  matchQuery,
  mediaQueryDependencies,
  parseBoxShadow,
  parseColor,
  parseHexColor,
  parseLength,
  parseNumber,
  parsePx,
  parseQuery,
  sidesAsArray,
  splitOnSlash,
  splitValueTokens,
  toFourSides,
} from "godot-angular/css";

describe("长度：认得的单位之外一律 null，而不是 0", () => {
  it("空串 / 非数字 / 溢出都返回 null", () => {
    expect(parseLength("")).toBeNull();
    expect(parseLength("   ")).toBeNull();
    expect(parseLength("abc")).toBeNull();
    expect(parseLength("1e999")).toBeNull();
    expect(parsePx("50%")).toBeNull();
  });

  it("无单位、px、% 三种都认；其余单位是“只是单位不认识”", () => {
    expect(parseLength(" 12 ")).toEqual({ value: 12, unit: "px" });
    expect(parseLength("12px")).toEqual({ value: 12, unit: "px" });
    expect(parseLength("50%")).toEqual({ value: 50, unit: "%" });
    expect(isUnsupportedUnit("3em")).toBe(true);
    expect(isUnsupportedUnit("3vw")).toBe(true);
    // 数字都读取不出来的输入，不应给出“单位不支持”这种误导性文案
    expect(isUnsupportedUnit("abc")).toBe(false);
  });

  it("0 的几种写法都算 0（border: 0 要能落）", () => {
    expect(isZero("0")).toBe(true);
    expect(isZero("0px")).toBe(true);
    expect(isZero("0%")).toBe(true);
    expect(isZero("1px")).toBe(false);
  });

  it("parseNumber 带区间夹取，非数字与溢出返回 null", () => {
    expect(parseNumber("0.5", 0, 1)).toBe(0.5);
    expect(parseNumber("5", 0, 1)).toBe(1);
    expect(parseNumber("-5", 0, 1)).toBe(0);
    expect(parseNumber("abc")).toBeNull();
    expect(parseNumber("1e999")).toBeNull();
  });
});

describe("颜色：解析失败返回 null，交调用方告警", () => {
  it("#rgba 短写与非法长度", () => {
    expect(parseHexColor("#abcd")).toMatchObject({ r: 0xaa / 255, b: 0xcc / 255, a: 0xdd / 255 });
    expect(parseHexColor("#fff")).toMatchObject({ r: 1, g: 1, b: 1 });
    expect(parseHexColor("#ab")).toBeNull();
    // 5/7 位十六进制不是任何 CSS 颜色写法
    expect(parseHexColor("#abccd")).toBeNull();
  });

  it("currentcolor / transparent / 空串", () => {
    expect(parseColor("")).toBeNull();
    expect(parseColor("currentcolor")).toBeNull();
    expect(parseColor("transparent")).toMatchObject({ r: 0, g: 0, b: 0, a: 0 });
  });

  it("rgb 的逗号与空格两种语法、百分数通道、斜杠 alpha", () => {
    expect(parseColor("rgb(255, 128, 0)")).toMatchObject({ r: 1, g: 128 / 255, b: 0, a: 1 });
    expect(parseColor("rgb(255 128 0)")).toMatchObject({ r: 1, g: 128 / 255 });
    expect(parseColor("rgb(50% 0% 0%)")).toMatchObject({ r: 0.5, g: 0 });
    expect(parseColor("rgb(1 2 3 / 50%)")).toMatchObject({ a: 0.5 });
    expect(parseColor("rgb(1 2 3 / bogus")).toBeNull();
  });

  it("参数不够 / 通道不是数字 → null（不是 0）", () => {
    expect(parseColor("rgb(255, 0)")).toBeNull();
    expect(parseColor("rgb(255, abc, 0)")).toBeNull();
    expect(parseColor("hsl()")).toBeNull();
    expect(parseColor("hwb(1 2)")).toBeNull();
    expect(parseColor("notacolor(1 2 3)")).toBeNull();
  });

  it("hwb 的 white+black 超过 1 时按比例压缩，而不是算出负数", () => {
    const over = parseColor("hwb(0 80% 80%)");
    const clamped = parseColor("hwb(0 50% 50%)");
    expect(over).not.toBeNull();
    expect(clamped).not.toBeNull();
    // 压缩后与“和为 1”的那次结果一致
    expect(over).toEqual(clamped);
  });

  it("colorToCss：不透明给 6 位，带 alpha 给 8 位（告警文案用）", () => {
    expect(colorToCss({ r: 1, g: 0, b: 0, a: 1 })).toBe("#ff0000");
    expect(colorToCss({ r: 1, g: 0, b: 0, a: 0.5 })).toBe("#ff000080");
  });
});

describe("box-shadow：认不出的片段必须报出来", () => {
  it("多余片段 / 长度认不出 / 第二个颜色", () => {
    expect(parseBoxShadow("2px 3px 4px red bogus").warnings.join("")).toContain("无法识别的片段");
    // 开头是数字但单位无法识别 → 比“无法识别的片段”更准确的文案
    expect(parseBoxShadow("2px 3px 4em red").warnings.join("")).toContain("无法识别的长度");
    expect(parseBoxShadow("2px 3px red blue").warnings.join("")).toContain("第二个颜色");
  });

  it("none / 空值不是错误，多层与 inset 明确告警", () => {
    expect(parseBoxShadow("none").shadow).toBeNull();
    expect(parseBoxShadow("none").warnings).toEqual([]);
    expect(parseBoxShadow("1px 2px red, 3px 4px blue").warnings.join("")).toContain("第一层");
    expect(parseBoxShadow("inset 1px 2px red").warnings.join("")).toContain("inset");
    expect(parseBoxShadow("1px 2px 0 5px red").warnings.join("")).toContain("spread");
  });

  it("只给一个偏移量：不算阴影，给明确原因", () => {
    const { shadow, warnings } = parseBoxShadow("2px");
    expect(shadow).toBeNull();
    expect(warnings.join("")).toContain("偏移量");
  });
});

describe("简写展开：值数不对 / 无落点都要说清", () => {
  it("padding / border-width 期望 1–4 个值", () => {
    expect(expandShorthand("padding", "1px 2px 3px 4px 5px")).toMatchObject({
      longhands: [],
      warnings: [expect.stringContaining("期望 1–4 个值")],
    });
    expect(expandShorthand("border-width", "1px 2px 3px 4px 5px")?.warnings.join("")).toContain("border-width");
    expect(fourSidesFromParts([1, 2, 3, 4, 5])).toBeNull();
  });

  it("border-style 整个无落点（StyleBoxFlat 没有虚线）", () => {
    expect(expandShorthand("border-style", "dashed")).toMatchObject({ longhands: [] });
    expect(expandShorthand("border-style", "dashed")?.warnings.join("")).toContain("无落点");
    // border 简写中的 style 段单独告警，其余部分照常落地
    const border = expandShorthand("border", "1px dashed red");
    expect(border?.warnings.join("")).toContain("border-style");
    expect(border?.longhands.length).toBeGreaterThan(0);
  });

  it("border 里认不出的片段被点名", () => {
    expect(expandShorthand("border", "1px solid red bogus")?.warnings.join("")).toContain("bogus");
  });

  it("border-radius 期望 1–4 个值", () => {
    expect(expandShorthand("border-radius", "1px 2px 3px 4px 5px")?.warnings.join("")).toContain("border-radius");
  });

  it("非简写返回 null（调用方按 longhand 原样收下）", () => {
    expect(expandShorthand("color", "red")).toBeNull();
    // isMultiValue 判断的是逗号（`transition: a, b` 那种多值），而不是空格
    expect(isMultiValue("1px, 2px")).toBe(true);
    expect(isMultiValue("1px")).toBe(false);
  });

  it("四边工具：1/2/3/4 个部分的展开规则", () => {
    expect(fourSidesFromParts(["a"])).toEqual(["a", "a", "a", "a"]);
    expect(fourSidesFromParts(["a", "b"])).toEqual(["a", "b", "a", "b"]);
    expect(fourSidesFromParts(["a", "b", "c"])).toEqual(["a", "b", "c", "b"]);
    expect(fourSidesFromParts(["a", "b", "c", "d"])).toEqual(["a", "b", "c", "d"]);
    expect(sidesAsArray(toFourSides(1, 2, 3, 4))).toEqual([1, 2, 3, 4]);
  });
});

describe("媒体查询：环境值缺失或类型不对就是不匹配", () => {
  const env = { width: 800, height: 600, "prefers-color-scheme": "light" as const };

  it("不合法的查询直接抛（写错名字比静默不匹配好查）", () => {
    expect(() => parseQuery("")).toThrow(SyntaxError);
    expect(() => parseQuery("()")).toThrow(SyntaxError);
  });

  it("数值特性拿不到可用数字 → 不匹配（而不是当 0）", () => {
    expect(matchQuery("(min-width: 500px)", env)).toBe(true);
    // 未写值的特性（`(min-width)`）无法计算比较对象
    expect(matchQuery("(min-width)", env)).toBe(false);
    expect(matchQuery("(min-width: 1e999)", { width: Number.NaN } as never)).toBe(false);
    // 字符串环境值对数值特性无效
    expect(matchQuery("(min-width: 500px)", { width: "800" } as never)).toBe(false);
    // 既不是数值特性也不是字符串特性 → 不匹配
    expect(matchQuery("(color: 1)", env)).toBe(false);
    // 字符串特性接收到非字符串
    expect(matchQuery("(prefers-color-scheme: dark)", { "prefers-color-scheme": 1 } as never)).toBe(false);
    expect(matchQuery("(prefers-color-scheme: light)", env)).toBe(true);
    expect(matchQuery("(prefers-color-scheme: dark)", env)).toBe(false);
  });

  it("依赖清单：环境变了要重算哪些查询", () => {
    expect(mediaQueryDependencies("(min-width: 100px) and (prefers-color-scheme: dark)")).toEqual(
      expect.arrayContaining(["width", "prefers-color-scheme"]),
    );
  });
});

describe("值切分与关键字", () => {
  it("引号内的空格不切、括号内的空格不切", () => {
    expect(splitValueTokens(`a "b c" d`)).toEqual(["a", '"b c"', "d"]);
    expect(splitValueTokens("rgb(1 2 3) x")).toEqual(["rgb(1 2 3)", "x"]);
    expect(splitValueTokens("font: 12px 'Segoe UI'")).toEqual(["font:", "12px", "'Segoe UI'"]);
    expect(splitOnSlash("4px / 8px")).toEqual(["4px", "8px"]);
    expect(splitOnSlash("rgb(1 2 / 3) / 4px")).toEqual(["rgb(1 2 / 3)", "4px"]);
  });

  it("全局关键字与自定义属性", () => {
    expect(isGlobalKeyword(" INHERIT ")).toBe(true);
    expect(isGlobalKeyword("red")).toBe(false);
    expect(isCustomPropertyDeclaration("--brand")).toBe(true);
    expect(isCustomPropertyDeclaration("color")).toBe(false);
  });
});
