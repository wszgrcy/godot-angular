/**
 * 兄弟集合变化的失效范围取证（**node** 环境，vitest.node.config.mts）。
 *
 * `invalidateSiblings(parent)` 是结构变更方（渲染器的 appendChild / insertBefore /
 * removeChild）用来补通知的入口：`+` / `~` 匹配的是「邻居是谁」，而邻居换人引擎不发任何信号。
 *
 * 为什么放在 node 侧：这里要钉的是**标脏范围与是否产生开销**（纯逻辑，`Cascade` 只依赖
 * `StyleBackend` 接口），引擎里观察不到「谁被标脏」这一层；插入后兄弟的选择器是否真的重新
 * 命中，由 test-app 的 css-structure-change.spec.ts 在真节点上断言，两侧不重复。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { Cascade, colorToCss, type CssNode, type StyleBackend } from "godot-angular/css";

class FakeNode implements CssNode {
  parent: CssNode | null = null;
  cssType: string;
  cssClasses?: Set<string>;
  cssPseudoClasses?: Set<string>;
  children: FakeNode[] = [];

  constructor(cssType: string) {
    this.cssType = cssType;
  }

  add(child: FakeNode): FakeNode {
    child.parent = this;
    this.children.push(child);
    return child;
  }
}

const backend: StyleBackend = {
  classOf: (node) => (node as FakeNode).cssType,
  bulk: (_node, apply) => apply(),
  mutateStyleBox: () => {},
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
  parentOf: (node) => (node as FakeNode).parent ?? null,
  childrenOf: (node) => (node as FakeNode).children,
  clearProperty: () => {},
  applyProperty: () => false,
};

let cascade: Cascade;
let scheduled: number;

beforeEach(() => {
  scheduled = 0;
  cascade = new Cascade({ backend, schedule: () => scheduled++ });
});

function register(cssType: string, classes: string[] = []): FakeNode {
  const node = new FakeNode(cssType);
  cascade.attach(node);
  for (const name of classes) node.cssClasses!.add(name);
  return node;
}

function dirtyCount(nodes: CssNode[]): number {
  return nodes.filter((n) => cascade.isDirty(n)).length;
}

describe("invalidateSiblings 的标脏范围", () => {
  it("样式表没用到兄弟组合器：一个节点也不标脏，也不排 flush", () => {
    cascade.addCss(`.a { color: rgb(255, 0, 0); }`);
    const box = register("HBoxContainer", ["box"]);
    const a = box.add(register("Label", ["a"]));
    const b = box.add(register("Label"));
    cascade.flush();
    scheduled = 0;

    cascade.invalidateSiblings(box);
    expect(dirtyCount([box, a, b])).toBe(0);
    expect(scheduled).toBe(0);
  });

  it("用了 + ：标脏父的直接子级", () => {
    cascade.addCss(`.a + Label { color: rgb(255, 0, 0); }`);
    const box = register("HBoxContainer", ["box"]);
    const a = box.add(register("Label", ["a"]));
    const b = box.add(register("Label"));
    cascade.flush();
    scheduled = 0;

    cascade.invalidateSiblings(box);
    expect(cascade.isDirty(a)).toBe(true);
    expect(cascade.isDirty(b)).toBe(true);
    expect(scheduled).toBe(1);
  });

  it("用了 ~ ：同样只标直接子级，孙节点不受牵连", () => {
    cascade.addCss(`.a ~ Label { color: rgb(255, 0, 0); }`);
    const box = register("HBoxContainer", ["box"]);
    const a = box.add(register("Label", ["a"]));
    const b = box.add(register("Label"));
    const grandchild = b.add(register("Label"));
    cascade.flush();

    cascade.invalidateSiblings(box);
    expect(cascade.isDirty(a)).toBe(true);
    expect(cascade.isDirty(b)).toBe(true);
    expect(cascade.isDirty(grandchild)).toBe(false);
  });

  it("只用了后代组合器：兄弟集合变化不影响任何人", () => {
    cascade.addCss(`.box .a { color: rgb(255, 0, 0); }`);
    const box = register("HBoxContainer", ["box"]);
    const a = box.add(register("Label", ["a"]));
    cascade.flush();
    scheduled = 0;

    cascade.invalidateSiblings(box);
    expect(cascade.isDirty(a)).toBe(false);
    expect(scheduled).toBe(0);
  });

  it("与 invalidateTree 的分工：子树归子树，兄弟归兄弟", () => {
    cascade.addCss(`.a + Label { color: rgb(255, 0, 0); } .box .deep { color: rgb(0, 255, 0); }`);
    const box = register("HBoxContainer", ["box"]);
    const a = box.add(register("Label", ["a"]));
    const wrapped = box.add(register("PanelContainer"));
    const deep = wrapped.add(register("Label", ["deep"]));
    cascade.flush();

    cascade.invalidateTree(wrapped);
    expect(cascade.isDirty(deep)).toBe(true);
    // 子树标脏不会顺带标兄弟：两件事的触发时机不同（插入子树 vs 邻居换人）
    expect(cascade.isDirty(a)).toBe(false);

    cascade.invalidateSiblings(box);
    expect(cascade.isDirty(a)).toBe(true);
  });
});
