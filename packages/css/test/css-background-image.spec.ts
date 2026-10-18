/**
 * `background-image` 的写法校验。
 *
 * 运行于 node 环境：此处仅判定「该段值能否转化为一个纹理写入位置、路径为何」，属于纯解析，
 * 直接调用 `applyCssProperty` 即可（属性值的解析发生在写入位置阶段，不在 `buildRuleSets` 中）。
 * stylebox 是否更换了类型、纹理是否已挂载、与底色的互斥何者胜出，
 * 在 test-app/src/tests/engine/css-background-image.spec.ts 中约束。
 */
import { describe, expect, it } from "vitest";
import { applyCssProperty, type CssNode, type StyleBackend } from "godot-angular/css";

/** 仅记录「写入哪个 item、stylebox 收到何种纹理」的 mock 后端 */
const calls: string[] = [];
const warnings: string[] = [];

const backend: StyleBackend = {
  classOf: () => "PanelContainer",
  bulk: (_node, apply) => apply(),
  mutateStyleBox: (_node, item, apply) => {
    const fields: string[] = [];
    apply({
      setBackground: () => fields.push("bg"),
      setTexture: (path) => fields.push(`texture:${path}`),
      setCornerRadii: () => {},
      setBorderWidths: () => {},
      setBorderColor: () => {},
      setShadow: () => {},
      setContentMargin: () => {},
    });
    calls.push(`${item}:${fields.join(",")}`);
  },
  setColorOverride: () => {},
  setFontSizeOverride: () => {},
  setConstantOverride: () => {},
  setFontOverride: () => true,
  setMinimumSize: () => {},
  setOpacity: () => {},
  setNodeNumber: () => {},
  getNodeNumber: () => 0,
  setNodeBoolean: () => {},
  hasNodeProperty: () => false,
  parentOf: () => null,
  childrenOf: () => [],
  clearProperty: () => {},
  applyProperty: () => true,
};

/** 写入一条声明，返回 [后端收到的调用, 告警] */
function apply(value: string): [string[], string[]] {
  calls.length = 0;
  warnings.length = 0;
  const node = { cssType: "PanelContainer" } as unknown as CssNode;
  applyCssProperty(node, "background-image", value, { backend, warn: (_k, m) => warnings.push(m), states: new Set() }, warnings);
  return [calls, warnings];
}

describe("合法写法", () => {
  it("单个 url() + res:// 图片路径通过，路径原样传递至 stylebox", () => {
    const [got, warns] = apply(`url("res://assets/ui/panel.png")`);
    expect(got).toEqual(["panel:texture:res://assets/ui/panel.png"]);
    expect(warns).toEqual([]);
  });

  it("不带引号亦可", () => {
    expect(apply("url(res://a/b.svg)")[0]).toEqual(["panel:texture:res://a/b.svg"]);
  });

  it("接受 Godot 资源后缀（内部为 Texture2D 派生类型即可）", () => {
    expect(apply(`url("res://f/t.tres")`)[0]).toEqual(["panel:texture:res://f/t.tres"]);
  });
});

describe("被拒绝的写法：不写入 stylebox 上，且说明原因", () => {
  it("多个 url()：不做候选源回退", () => {
    const [got, warns] = apply(`url("res://a.png"), url("res://b.png")`);
    expect(got).toEqual([]);
    expect(warns.join("\n")).toContain("只支持一个");
  });

  it("相对路径直接拒绝，并给出正确写法示例", () => {
    const [got, warns] = apply(`url("./ui/a.png")`);
    expect(got).toEqual([]);
    const text = warns.join("\n");
    expect(text).toContain("不是 res:// 路径");
    expect(text).toContain("res://assets/ui/panel.png");
  });

  it("后缀不支持时列出可用格式", () => {
    const [got, warns] = apply(`url("res://a.ttf")`);
    expect(got).toEqual([]);
    const text = warns.join("\n");
    expect(text).toContain(".ttf");
    expect(text).toContain("png");
  });

  it("gradient 单独输出告警：其不属于 url() 写法问题，而是根本无对应实现", () => {
    const [got, warns] = apply("linear-gradient(red, blue)");
    expect(got).toEqual([]);
    expect(warns.join("\n")).toContain("gradient 没有对应实现");
  });

  it("none 无意义（本库不会主动设置纹理）", () => {
    const [got, warns] = apply("none");
    expect(got).toEqual([]);
    expect(warns.join("\n")).toContain("没有对应实现");
  });
});
