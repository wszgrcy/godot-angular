import { describe, expect, it } from "vitest";
import {
  colorToCss,
  fourSidesFromParts,
  hasCalc,
  isGlobalKeyword,
  isUnsupportedUnit,
  isVariableReference,
  isZero,
  parseBoxShadow,
  parseColor,
  parseHexColor,
  parseLength,
  parseNumber,
  parsePx,
  splitOnSlash,
  splitValueTokens,
} from "godot-angular/css";

/** 0..255 的期望值 → 0..1 浮点，容差覆盖四舍五入 */
const near = (v: number, byte: number) => Math.abs(v - byte / 255) < 0.005;

function expectColor(color: unknown, r: number, g: number, b: number, a = 255): void {
  expect(color, "解析不出颜色").toBeTruthy();
  const c = color as { r: number; g: number; b: number; a: number };
  expect(near(c.r, r), `r=${c.r}`).toBe(true);
  expect(near(c.g, g), `g=${c.g}`).toBe(true);
  expect(near(c.b, b), `b=${c.b}`).toBe(true);
  expect(Math.abs(c.a - a / 255)).toBeLessThan(0.005);
}

describe("颜色", () => {
  it("hex：3 / 4 / 6 / 8 位", () => {
    expectColor(parseColor("#369"), 0x33, 0x66, 0x99);
    expectColor(parseColor("#456789"), 0x45, 0x67, 0x89);
    expectColor(parseColor("#45678985"), 0x45, 0x67, 0x89, 0x85);
    expectColor(parseColor("  #f0f8ff  "), 0xf0, 0xf8, 0xff);
    expect(parseHexColor("#12345")).toBeNull();
  });

  it("命名色（含 Godot 的 Color.html_is_valid 不认的 rebeccapurple）", () => {
    expectColor(parseColor("red"), 255, 0, 0);
    expectColor(parseColor("rebeccapurple"), 0x66, 0x33, 0x99);
    expectColor(parseColor("LIGHTBLUE"), 0xad, 0xd8, 0xe6);
    expectColor(parseColor("transparent"), 0, 0, 0, 0);
  });

  it("rgb / rgba：逗号与空格两种语法", () => {
    expectColor(parseColor("rgb(255, 8, 128)"), 255, 8, 128);
    expectColor(parseColor("rgb(255 8 128)"), 255, 8, 128);
    expectColor(parseColor("rgb(255 8 128 / .5)"), 255, 8, 128, 128);
    expectColor(parseColor("rgba(255, 8, 128, 0.5)"), 255, 8, 128, 128);
    expectColor(parseColor("rgb(10%, 20%, 30%)"), 25.5, 51, 76.5);
  });

  it("hsl / hsla", () => {
    expectColor(parseColor("hsl(330.9, 100%, 51.6%)"), 255, 8, 128);
    expectColor(parseColor("hsla(330.9, 100%, 51.6%, 0.5)"), 255, 8, 128, 128);
    expectColor(parseColor("hsl(0 0% 100%)"), 255, 255, 255);
    expectColor(parseColor("hsl(240, 100%, 50%)"), 0, 0, 255);
  });

  it("hwb", () => {
    expectColor(parseColor("hwb(240 20% 30%)"), 51, 51, 179);
    expectColor(parseColor("hwb(0 0% 0%)"), 255, 0, 0);
  });

  it("非法值返回 null 而不是抛（调用方决定兜底）", () => {
    for (const bad of ["", "notacolor", "rgb(abc)", "rgb(1,2)", "#12345", "hsl(1)", "()", "currentcolor"]) {
      expect(parseColor(bad), bad).toBeNull();
    }
  });

  it("colorToCss 是 parseColor 的逆（round-trip）", () => {
    for (const css of ["#ff0000", "#336699", "#00000080"]) {
      expect(colorToCss(parseColor(css)!)).toBe(css);
    }
  });
});

describe("长度与数字", () => {
  it("px / 无单位 / 百分比", () => {
    expect(parseLength("10px")).toEqual({ value: 10, unit: "px" });
    expect(parseLength(" 0.5px ")).toEqual({ value: 0.5, unit: "px" });
    expect(parseLength("0")).toEqual({ value: 0, unit: "px" });
    expect(parseLength("50%")).toEqual({ value: 50, unit: "%" });
    expect(parsePx("12px")).toBe(12);
    expect(parsePx("50%")).toBeNull();
  });

  it("em/rem/vw/vh 一律不解析（第七节明确不做），但能给出具体告警", () => {
    expect(parseLength("1.5em")).toBeNull();
    expect(isUnsupportedUnit("1.5em")).toBe(true);
    expect(isUnsupportedUnit("1.5px")).toBe(false);
    for (const unit of ["rem", "vw", "vh", "vmin", "pt", "cm"]) {
      expect(parseLength(`3${unit}`), unit).toBeNull();
    }
  });

  it("isZero 认 0 / 0px / 0%", () => {
    expect(isZero("0")).toBe(true);
    expect(isZero("0px")).toBe(true);
    expect(isZero("0%")).toBe(true);
    expect(isZero("1px")).toBe(false);
  });

  it("parseNumber 带上下界钳制（opacity 用）", () => {
    expect(parseNumber("0.5", 0, 1)).toBe(0.5);
    expect(parseNumber("3", 0, 1)).toBe(1);
    expect(parseNumber("-1", 0, 1)).toBe(0);
    expect(parseNumber("abc")).toBeNull();
  });
});

describe("box-shadow", () => {
  it("两个偏移量是最小集合", () => {
    const { shadow, warnings } = parseBoxShadow("10px 20px");
    expect(shadow).toMatchObject({ offsetX: 10, offsetY: 20, blur: 0, spread: 0, inset: false });
    expect(warnings).toEqual([]);
  });

  it("第三/第四个是模糊与扩散；颜色位置任意", () => {
    const withSpread = parseBoxShadow("2px 3px 4px 5px red");
    expect(withSpread.shadow).toMatchObject({ blur: 4, spread: 5 });
    expect(withSpread.warnings.join("\n")).toContain("spread");

    const colorFirst = parseBoxShadow("red 2px 3px");
    expect(colorFirst.shadow).toMatchObject({ offsetX: 2, offsetY: 3 });
    expectColor(colorFirst.shadow?.color, 255, 0, 0);
  });

  it("函数式颜色不被空格拆散", () => {
    const { shadow } = parseBoxShadow("0 0 4px rgba(0 0 0 / 50%)");
    expect(shadow?.blur).toBe(4);
    expectColor(shadow?.color, 0, 0, 0, 128);
  });

  it("inset 无落点要告警；none 视为撤销；多层仅取第一层", () => {
    expect(parseBoxShadow("inset 0 0 4px black").warnings.join("\n")).toContain("inset");
    expect(parseBoxShadow("none").shadow).toBeNull();
    const multi = parseBoxShadow("0 0 2px red, 4px 4px 0 blue");
    expect(multi.warnings.join("\n")).toContain("仅取第一层");
    expectColor(multi.shadow?.color, 255, 0, 0);
  });

  it("少一个偏移量 → 不猜，返回 null + 告警", () => {
    const { shadow, warnings } = parseBoxShadow("10px");
    expect(shadow).toBeNull();
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("四值简写", () => {
  it("1/2/3/4 个部分的展开规则（top right bottom left）", () => {
    expect(fourSidesFromParts(["a"])).toEqual(["a", "a", "a", "a"]);
    expect(fourSidesFromParts(["a", "b"])).toEqual(["a", "b", "a", "b"]);
    expect(fourSidesFromParts(["a", "b", "c"])).toEqual(["a", "b", "c", "b"]);
    expect(fourSidesFromParts(["a", "b", "c", "d"])).toEqual(["a", "b", "c", "d"]);
    expect(fourSidesFromParts(["a", "b", "c", "d", "e"])).toBeNull();
  });
});

describe("值分词", () => {
  it("括号内的空白不切", () => {
    expect(splitValueTokens("1px solid rgb(0 0 0 / 50%)")).toEqual(["1px", "solid", "rgb(0 0 0 / 50%)"]);
    expect(splitOnSlash("4px / 8px")).toEqual(["4px", "8px"]);
    expect(splitOnSlash("rgb(1 / 2)")).toEqual(["rgb(1 / 2)"]);
  });
});

describe("关键字", () => {
  it("全局关键字 / var() / calc() 都能被识别出来交给上层兜底", () => {
    for (const keyword of ["unset", "initial", "inherit", "revert", "revert-layer"]) {
      expect(isGlobalKeyword(keyword)).toBe(true);
    }
    expect(isGlobalKeyword("red")).toBe(false);
    expect(isVariableReference("var(--x)")).toBe(true);
    expect(isVariableReference("red")).toBe(false);
    expect(hasCalc("calc(100% - 8px)")).toBe(true);
  });
});
