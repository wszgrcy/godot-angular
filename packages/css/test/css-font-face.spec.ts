/**
 * `@font-face` 的写法校验。
 *
 * 运行于 node 环境：此处断言的内容均为「该段文本能否成为一条字体登记」，属于纯解析，
 * 无需引擎。登记之后能否确实加载到资源、覆盖是否已写入节点，
 * 在 test-app/src/tests/engine/css-font.spec.ts 中约束。
 */
import { describe, expect, it } from "vitest";
import { buildRuleSets, CssCode, type CssWarnEntry } from "godot-angular/css";

/** 仅关注 @font-face 的解析结果：返回 [家族名, 路径] 或 null */
function face(css: string): { family: string; path: string } | null {
  const built = buildRuleSets(`@font-face { ${css} }`);
  const first = built.fontFaces[0];
  return first ? { family: first.family, path: first.path } : null;
}

function warningsOf(css: string): CssWarnEntry[] {
  return buildRuleSets(`@font-face { ${css} }`).warnings;
}

/** 告警码：文案会改，码不会 */
function codesOf(css: string): CssCode[] {
  return warningsOf(css).map((w) => w.code);
}

describe("合法写法", () => {
  it("font-family + 单个 url() 通过，路径原样保留", () => {
    expect(face(`font-family: "My Font"; src: url("res://assets/fonts/a.ttf");`)).toEqual({
      family: "My Font",
      path: "res://assets/fonts/a.ttf",
    });
  });

  it("font-family 不带引号、url 不带引号均可", () => {
    expect(face(`font-family: MyFont; src: url(res://a/b.otf);`)).toEqual({
      family: "MyFont",
      path: "res://a/b.otf",
    });
  });

  it("文件名中含分号与冒号时不会被错误切分", () => {
    expect(face(`font-family: X; src: url("res://a/b;c:d.ttf");`)?.path).toBe("res://a/b;c:d.ttf");
  });

  it("接受 Godot 资源后缀（FontVariation 这类派生字体即为 .tres）", () => {
    expect(face(`font-family: X; src: url("res://f/v.tres");`)?.path).toBe("res://f/v.tres");
  });
});

describe("被拒绝的写法", () => {
  it("缺 font-family", () => {
    expect(face(`src: url("res://a.ttf");`)).toBeNull();
    expect(codesOf(`src: url("res://a.ttf");`)).toContain(CssCode.FontFaceInvalid);
  });

  it("缺 src", () => {
    expect(face(`font-family: X;`)).toBeNull();
    expect(codesOf(`font-family: X;`)).toContain(CssCode.FontFaceInvalid);
  });

  it("多个 url()：Godot 不做候选源回退", () => {
    const css = `font-family: X; src: url("res://a.ttf") format("truetype"), url("res://b.woff2");`;
    expect(face(css)).toBeNull();
    expect(codesOf(css)).toContain(CssCode.ResourceUrlInvalid);
  });

  it("local() 没有对应实现", () => {
    expect(face(`font-family: X; src: local("Arial");`)).toBeNull();
    expect(codesOf(`font-family: X; src: local("Arial");`)).toContain(CssCode.LocalSourceUnsupported);
  });

  it("src 中不含 url()", () => {
    expect(face(`font-family: X; src: something;`)).toBeNull();
  });

  it("相对路径直接拒绝：CSS 编译后已内联至 JS，相对路径无参照物", () => {
    const css = `font-family: X; src: url("./fonts/a.ttf");`;
    expect(face(css)).toBeNull();
    const text = warningsOf(css).join("\n");
    expect(text).toContain("不是 res:// 路径");
    expect(text).toContain("res://assets/fonts/x.ttf");
  });

  it("后缀不支持时列出可用格式", () => {
    const css = `font-family: X; src: url("res://a.png");`;
    expect(face(css)).toBeNull();
    const text = warningsOf(css).join("\n");
    expect(text).toContain(".png");
    expect(text).toContain("ttf");
  });
});

describe("没有对应实现的描述符", () => {
  for (const descriptor of ["font-weight", "font-style", "font-stretch", "font-display", "unicode-range"]) {
    it(`${descriptor} 被忽略并输出告警`, () => {
      const css = `font-family: X; src: url("res://a.ttf"); ${descriptor}: 700;`;
      // 登记本身仍然有效：忽略描述符不等于整条作废
      expect(face(css)).not.toBeNull();
      expect(warningsOf(css).join("\n")).toContain(`${descriptor} 没有对应实现`);
    });
  }
});

describe("登记与规则互不干扰", () => {
  it("@font-face 不会变成一条规则", () => {
    const built = buildRuleSets(`
      @font-face { font-family: X; src: url("res://a.ttf"); }
      .t { color: red; }
    `);
    expect(built.fontFaces).toHaveLength(1);
    expect(built.ruleSets).toHaveLength(1);
    expect(built.ruleSets[0].declarations.map((d) => d.property)).toEqual(["color"]);
  });

  it("@media 内的 @font-face 同样登记", () => {
    const built = buildRuleSets(`@media (min-width: 1px) { @font-face { font-family: X; src: url("res://a.ttf"); } }`);
    expect(built.fontFaces).toHaveLength(1);
  });

  it("全部不合法时仅输出告警，不影响同表其它规则", () => {
    const built = buildRuleSets(`
      @font-face { src: url("res://a.ttf"); }
      .t { color: red; }
    `);
    expect(built.fontFaces).toHaveLength(0);
    expect(built.ruleSets).toHaveLength(1);
  });
});
