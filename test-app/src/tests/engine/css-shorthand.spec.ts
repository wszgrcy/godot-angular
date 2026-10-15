import { describe, expect, it } from "vitest";
import { expandShorthand } from "godot-angular/css";

function props(property: string, value: string): string[] {
  return (expandShorthand(property, value)?.longhands ?? []).map(([name]) => name);
}

function warningsOf(property: string, value: string): string {
  return (expandShorthand(property, value)?.warnings ?? []).join("\n");
}

describe("四值简写", () => {
  it("margin: 1px 2px → 四条 longhand", () => {
    expect(expandShorthand("margin", "1px 2px")?.longhands).toEqual([
      ["margin-top", "1px"],
      ["margin-right", "2px"],
      ["margin-bottom", "1px"],
      ["margin-left", "2px"],
    ]);
  });

  it("padding 三值写法（top / 左右 / bottom）", () => {
    expect(expandShorthand("padding", "1px 2px 3px")?.longhands).toEqual([
      ["padding-top", "1px"],
      ["padding-right", "2px"],
      ["padding-bottom", "3px"],
      ["padding-left", "2px"],
    ]);
  });

  it("超过四个值 → 不猜，告警且不产出 longhand", () => {
    const result = expandShorthand("margin", "1px 2px 3px 4px 5px");
    expect(result?.longhands).toEqual([]);
    expect(result?.warnings.join("\n")).toContain("期望 1–4 个值");
  });
});

describe("border", () => {
  it("border → 四条宽度 + 一条颜色（Godot 的边框四边同色）", () => {
    expect(props("border", "1px solid red")).toEqual([
      "border-top-width",
      "border-right-width",
      "border-bottom-width",
      "border-left-width",
      "border-color",
    ]);
  });

  it("border-style 无落点：告警但不影响宽度/颜色", () => {
    expect(warningsOf("border", "1px dashed red")).toContain("dashed");
    expect(props("border", "1px dashed red")).toHaveLength(5);
  });

  it("border: none 把四边宽度归零", () => {
    expect(expandShorthand("border", "none")?.longhands).toEqual([
      ["border-top-width", "0px"],
      ["border-right-width", "0px"],
      ["border-bottom-width", "0px"],
      ["border-left-width", "0px"],
    ]);
  });

  it("单边的 border-top：宽度只出那一条，颜色只能整圈同色（要出声）", () => {
    expect(expandShorthand("border-top", "2px solid blue")?.longhands).toEqual([
      ["border-top-width", "2px"],
      ["border-color", "blue"],
    ]);
    expect(warningsOf("border-top", "2px solid blue")).toContain("四边同色");
  });

  it("border-width 展开四边；border-color 不拆（Godot 只有一个 border_color）", () => {
    expect(props("border-width", "2px")).toEqual([
      "border-top-width",
      "border-right-width",
      "border-bottom-width",
      "border-left-width",
    ]);
    // 透传：拆成 border-*-color 只会产生四条无落点的 longhand
    expect(expandShorthand("border-color", "red blue")).toBeNull();
  });

  it("border 只给宽度或只给颜色：缺的那半不编造", () => {
    expect(expandShorthand("border", "2px")?.longhands).toEqual([
      ["border-top-width", "2px"],
      ["border-right-width", "2px"],
      ["border-bottom-width", "2px"],
      ["border-left-width", "2px"],
    ]);
    expect(expandShorthand("border", "solid red")?.longhands).toEqual([["border-color", "red"]]);
  });

  it("thin/medium/thick 关键字换算成像素并告警", () => {
    expect(expandShorthand("border", "thick solid red")?.longhands[0]).toEqual(["border-top-width", "3px"]);
    expect(warningsOf("border", "thin solid red")).toContain("1px");
  });
});

describe("border-radius", () => {
  it("四角按 top-left → top-right → bottom-right → bottom-left 顺序", () => {
    expect(expandShorthand("border-radius", "10px")?.longhands).toEqual([
      ["border-top-left-radius", "10px"],
      ["border-top-right-radius", "10px"],
      ["border-bottom-right-radius", "10px"],
      ["border-bottom-left-radius", "10px"],
    ]);
  });

  it("椭圆写法（x / y）只取横向并告警", () => {
    expect(props("border-radius", "4px / 8px")).toHaveLength(4);
    expect(warningsOf("border-radius", "4px / 8px")).toContain("横向");
    expect(warningsOf("border-radius", "4px / 4px")).toBe("");
  });
});

describe("background / flex / 明确不做的东西", () => {
  it("background 只认颜色，渐变与图片告警忽略", () => {
    expect(expandShorthand("background", "red")?.longhands).toEqual([["background-color", "red"]]);
    // CSS 中 background: none = 无背景，Godot 侧就是全透明
    expect(expandShorthand("background", "none")?.longhands).toEqual([["background-color", "transparent"]]);
    expect(props("background", "linear-gradient(red, blue)")).toEqual([]);
    expect(warningsOf("background", "url(a.png)")).toContain("渐变");
  });

  it("flex: n → grow（+ shrink），flex-basis 无落点", () => {
    expect(expandShorthand("flex", "1")?.longhands).toEqual([["flex-grow", "1"]]);
    expect(expandShorthand("flex", "1 2")?.longhands).toEqual([
      ["flex-grow", "1"],
      ["flex-shrink", "2"],
    ]);
    expect(warningsOf("flex", "1 1 200px")).toContain("flex-basis");
    expect(expandShorthand("flex", "auto")?.longhands).toEqual([
      ["flex-grow", "1"],
      ["flex-shrink", "1"],
    ]);
    expect(expandShorthand("flex", "none")?.longhands).toEqual([
      ["flex-grow", "0"],
      ["flex-shrink", "0"],
    ]);
  });

  it("background 的位置 / 平铺片段：认得但无落点", () => {
    expect(props("background", "url(a.png) no-repeat center")).toEqual([]);
    const w = warningsOf("background", "red no-repeat center");
    expect(w).toContain("no-repeat");
    expect(w).toContain("center");
  });

  it("position/inset / outline / text-shadow 一律告警忽略", () => {
    expect(warningsOf("inset", "0")).toContain("anchors");
    expect(warningsOf("outline", "1px solid red")).toContain("outline");
    expect(warningsOf("text-shadow", "1px 1px red")).toContain("text-shadow");
  });

  it("本身就是 longhand 的属性返回 null（透传）", () => {
    expect(expandShorthand("color", "red")).toBeNull();
    expect(expandShorthand("font-size", "12px")).toBeNull();
    expect(expandShorthand("box-shadow", "0 0 4px black")).toBeNull();
    expect(expandShorthand("mystery-property", "x")).toBeNull();
  });
});

describe("font（只取字号）", () => {
  it("font: 14px/1.5 sans-serif → font-size: 14px，其余部分输出告警", () => {
    expect(expandShorthand("font", "14px/1.5 sans-serif")?.longhands).toEqual([["font-size", "14px"]]);
    expect(warningsOf("font", "14px/1.5 sans-serif")).toContain("字体族");
  });

  it("字重不会被误当作字号（无单位的 700 不是长度）", () => {
    expect(expandShorthand("font", "bold 700 18px/1.2 Arial")?.longhands).toEqual([["font-size", "18px"]]);
  });

  it("缺少带单位的字号时不做猜测，输出告警", () => {
    const r = expandShorthand("font", "bold sans-serif");
    expect(r?.longhands).toEqual([]);
    expect(r?.warnings.join("\n")).toContain("没找到带单位的字号");
  });
});
