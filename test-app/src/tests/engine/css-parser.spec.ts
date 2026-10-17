import { describe, expect, it } from "vitest";
import { collectFontFaces, flattenRules, parseCss, splitSelectors } from "godot-angular/css";

describe("css 解析器", () => {
  it("一条基本规则", () => {
    const sheet = parseCss("a{color:red}");
    const rules = flattenRules(sheet);
    expect(rules).toHaveLength(1);
    expect(rules[0].selectors).toEqual(["a"]);
    expect(rules[0].declarations).toEqual([
      { type: "declaration", property: "color", value: "red", important: false, position: rules[0].declarations[0].position },
    ]);
    expect(sheet.warnings).toEqual([]);
  });

  it("逗号分隔的多选择器", () => {
    const rules = flattenRules(parseCss("a, .b , Button  { color: red; font-size: 12px }"));
    expect(rules).toHaveLength(1);
    expect(rules[0].selectors).toEqual(["a", ".b", "Button"]);
    expect(rules[0].declarations.map((d) => d.property)).toEqual(["color", "font-size"]);
  });

  it("选择器里的逗号不算分隔符（:is(a, b) / [title=\"a,b\"]）", () => {
    expect(splitSelectors("a:is(b, c), d")).toEqual(["a:is(b, c)", "d"]);
    expect(splitSelectors('[title="a,b"], c')).toEqual(['[title="a,b"]', "c"]);
  });

  it("@media 里的规则带上媒体条件", () => {
    const sheet = parseCss(`
      Label { color: red; }
      @media (min-width: 500px) {
        Label { color: blue; }
        Button { opacity: 0.5; }
      }
      Label { color: green; }
    `);
    const rules = flattenRules(sheet);
    expect(rules.map((r) => r.declarations[0]?.value)).toEqual(["red", "blue", "0.5", "green"]);
    expect(rules.map((r) => r.mediaQueryString)).toEqual([undefined, "(min-width: 500px)", "(min-width: 500px)", undefined]);
    expect(sheet.warnings).toEqual([]);
  });

  it("注释被剥掉且不影响行号", () => {
    const sheet = parseCss("/* 头注释 */\nLabel {\n  /* 中间 */ color: red;\n}\n");
    const rules = flattenRules(sheet);
    expect(rules).toHaveLength(1);
    expect(rules[0].declarations[0].property).toBe("color");
    expect(rules[0].position.line).toBe(2);
    expect(sheet.warnings).toEqual([]);
  });

  it("未闭合括号不崩，只告警", () => {
    const sheet = parseCss("Label { color: red;");
    expect(sheet.rules).toHaveLength(0);
    expect(sheet.warnings.join("\n")).toContain("未闭合");
  });

  it("缺分号 / 缺冒号这类畸形声明只丢这一条", () => {
    const sheet = parseCss("Label { color: red; nonsense; font-size: 20px }");
    const rules = flattenRules(sheet);
    expect(rules[0].declarations.map((d) => d.property)).toEqual(["color", "font-size"]);
    expect(sheet.warnings.join("\n")).toContain("无法解析为声明");
  });

  it("!important 被识别并剥掉（Godot 侧没有 !important 的对应物，值本身照用）", () => {
    const rules = flattenRules(parseCss("Label { color: red !important; }"));
    expect(rules[0].declarations[0]).toMatchObject({ property: "color", value: "red", important: true });
  });

  it("@keyframes 被识别并丢弃 + 告警（第七节：不做动画）", () => {
    const sheet = parseCss(`
      @keyframes spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }
      Label { color: red; }
    `);
    expect(sheet.rules.some((n) => n.type === "keyframes")).toBe(true);
    expect(flattenRules(sheet)).toHaveLength(1);
    expect(sheet.warnings.join("\n")).toContain("动画");
  });

  it("无法识别的 at-rule 一律输出告警，而非静默丢弃", () => {
    const sheet = parseCss(`
      @import url("other.css");
      @supports (display: grid) { Label { color: red } }
      @layer base;
    `);
    const text = sheet.warnings.join("\n");
    expect(text).toContain("@import");
    expect(text).toContain("@supports");
    expect(text).toContain("@layer");
    expect(flattenRules(sheet)).toHaveLength(0);
  });

  it("@font-face 已不属于「无法识别」：它走字体登记通道，不产生规则也不报不支持", () => {
    const sheet = parseCss(`@font-face { font-family: X; src: url("res://a.ttf"); }`);
    expect(sheet.warnings.join("\n")).not.toContain("不支持");
    expect(collectFontFaces(sheet)).toHaveLength(1);
    expect(flattenRules(sheet)).toHaveLength(0);
  });

  it("@media 嵌套 @media 不做条件求交，明确告警忽略内层", () => {
    const sheet = parseCss(`
      @media (min-width: 100px) {
        @media (max-width: 200px) { Label { color: red } }
      }
    `);
    expect(flattenRules(sheet)).toHaveLength(0);
    expect(sheet.warnings.join("\n")).toContain("嵌套");
  });

  it("值里的分号/括号不被当分隔符（url / rgb 带空格语法）", () => {
    const rules = flattenRules(parseCss("Label { color: rgb(1 2 3 / 50%); background: url(a;b.png) }"));
    expect(rules[0].declarations.map((d) => d.value)).toEqual(["rgb(1 2 3 / 50%)", "url(a;b.png)"]);
  });

  it("空样式表 / 纯注释 / 乱码都不抛", () => {
    for (const css of ["", "   ", "/* only */", "}}}", "{{{", "@@@"]) {
      expect(() => parseCss(css)).not.toThrow();
    }
  });

  it("属性名大小写归一，自定义属性保留原样", () => {
    const rules = flattenRules(parseCss("Label { COLOR: red; --MyVar: 3px }"));
    expect(rules[0].declarations.map((d) => d.property)).toEqual(["color", "--MyVar"]);
  });
});

describe("引号与转义：字符串里的东西不能当结构看", () => {
  it("值里的转义引号不提前结束字符串，里面的分号也不切声明", () => {
    const rules = flattenRules(parseCss('Label { content: "a\\"b;c"; color: red }'));
    expect(rules[0].declarations.map((d) => d.value)).toEqual(['"a\\"b;c"', "red"]);
  });

  it("注释定界符出现在引号里不当注释", () => {
    const sheet = parseCss('Label { content: "/* 不是注释 */"; color: red }');
    expect(flattenRules(sheet)[0].declarations.map((d) => d.property)).toEqual(["content", "color"]);
    expect(sheet.warnings).toEqual([]);
  });

  it("选择器列表里的转义引号：逗号在字符串里就不算分隔符", () => {
    expect(splitSelectors('[title="a,\\"b"], c')).toEqual(['[title="a,\\"b"]', "c"]);
  });

  it("声明块里冒 @规则：明确告警并丢掉那一条", () => {
    const sheet = parseCss("Label { color: red; @media (min-width: 1px) { color: blue } }");
    expect(flattenRules(sheet)[0].declarations.map((d) => d.property)).toEqual(["color"]);
    expect(sheet.warnings.join("")).toContain("声明块内的 @media");
  });

  it("at-rule 的块没闭合：把剩下的都当块内容吃掉，并告警", () => {
    const sheet = parseCss("@media (min-width: 1px) { Label { color: red;");
    expect(sheet.warnings.join("")).toContain("at-rule 的块未闭合");
  });

  it("属性名位置为空（只有冒号）不产声明", () => {
    const sheet = parseCss("Label { : red; color: blue }");
    expect(flattenRules(sheet)[0].declarations.map((d) => d.property)).toEqual(["color"]);
  });
});
