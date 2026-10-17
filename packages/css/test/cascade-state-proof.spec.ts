/**
 * 状态伪类的**内部成本**取证：一次重算实际执行了多少次操作。
 *
 * 运行于 **node** 环境（vitest.node.config.mts）：`packages/css` 不 import `godot`，
 * `Cascade` 仅依赖 `StyleBackend` 接口，因此可借助 mock backend 精确统计
 * 「一次重算实际执行了多少次操作」——此为引擎内 spec 无法做到的（该侧仅能观察最终 item）。
 *
 * 本文件仅保留**结构与性能**探针。凡「某条声明落到哪个 Godot 主题属性」这类
 * 只能由真实引擎判定的问题，一律在 test-app/src/tests/engine/css-state-items.spec.ts
 * 与 css-pseudo.spec.ts 中断言，两侧不重复。
 *
 * 观察口径：
 *   - applyNode 是否执行   ← hasNodeProperty 调用次数（syncPropertyPseudoClasses
 *                             对每个「被样式表用到的状态属性」恰好探测一次）
 *   - 标脏范围             ← isDirty 逐个断言 + childrenOf 次数
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Cascade,
  ComplexSelector,
  SimpleSelectorSequence,
  applyCssProperty,
  colorToCss,
  type CssNode,
  type StyleBackend,
} from "godot-angular/css";

/* ------------------------------------------------------------------ *
 * 假节点与假 backend
 * ------------------------------------------------------------------ */

class FakeNode implements CssNode {
  parent: CssNode | null = null;
  cssType: string;
  cssClasses?: Set<string>;
  cssPseudoClasses?: Set<string>;
  /** 模拟引擎属性表：hasNodeProperty / getNodeNumber 读这里 */
  props: Record<string, unknown> = {};
  children: FakeNode[] = [];
  /** item → 颜色原文，写入的唯一可观察出口 */
  colors = new Map<string, string>();

  constructor(cssType: string) {
    this.cssType = cssType;
  }

  /** 开关控件：拥有 button_pressed / disabled / editable（toggle_mode 默认 false，同 Button） */
  asButton(): this {
    this.props.button_pressed = false;
    this.props.disabled = false;
    this.props.editable = true;
    this.props.toggle_mode = false;
    return this;
  }

  add(child: FakeNode): FakeNode {
    child.parent = this;
    this.children.push(child);
    return child;
  }
}

const counters = {
  hasNodeProperty: 0,
  getNodeNumber: 0,
  setColorOverride: 0,
  childrenOf: 0,
};

function resetCounters(): void {
  for (const key of Object.keys(counters)) counters[key as keyof typeof counters] = 0;
}

const backend: StyleBackend = {
  classOf: (node) => (node as FakeNode).cssType,
  bulk: (_node, apply) => apply(),
  mutateStyleBox: () => {},
  setColorOverride: (node, item, color) => {
    counters.setColorOverride++;
    (node as FakeNode).colors.set(item, colorToCss(color));
  },
  setFontSizeOverride: () => {},
  setConstantOverride: () => {},
  setFontOverride: () => true,
  setMinimumSize: () => {},
  setOpacity: () => {},
  setNodeNumber: () => {},
  getNodeNumber: (node, prop) => {
    counters.getNodeNumber++;
    return Number((node as FakeNode).props[prop] ?? 0);
  },
  setNodeBoolean: () => {},
  hasNodeProperty: (node, prop) => {
    counters.hasNodeProperty++;
    return prop in (node as FakeNode).props;
  },
  parentOf: (node) => (node as FakeNode).parent ?? null,
  childrenOf: (node) => {
    counters.childrenOf++;
    return (node as FakeNode).children;
  },
  clearProperty: () => {},
  applyProperty: (node, cssName, raw, warnings, states) =>
    applyCssProperty(node, cssName, raw, { backend, warn: () => {}, states }, warnings),
};

let cascade: Cascade;

beforeEach(() => {
  cascade = new Cascade({ backend });
  resetCounters();
});

/** 登记节点但不落地，便于在首次 flush 之前预先设置状态 */
function register(cssType: string, classes: string[], button = true): FakeNode {
  const node = new FakeNode(cssType);
  if (button) node.asButton();
  cascade.attach(node);
  // class 必须在 attach 之后写入（见 Cascade.attach 注释）
  for (const name of classes) node.cssClasses!.add(name);
  return node;
}

function mount(cssType: string, classes: string[], button = true): FakeNode {
  const node = register(cssType, classes, button);
  cascade.flush();
  resetCounters();
  return node;
}

function dirtyCount(nodes: CssNode[]): number {
  return nodes.filter((n) => cascade.isDirty(n)).length;
}

/* ================================================================== *
 * 一、状态跃迁的重算次数
 *
 * syncPropertyPseudoClasses 在 applyNode 内部改伪类 → TrackingClassSet 回调
 * invalidate(node)；而 flush() 已经 takeDirty() 取空队列并置 state.dirty=false，
 * 于是该节点被重新入脏，下一帧再走一遍 sync + merge + diff，最后被 diff 短路。
 * 落点本身（写入哪个 item）由引擎侧用例负责，此处仅约束「不应重复执行第二次」。
 * ================================================================== */

describe("状态跃迁的重算次数", () => {
  it("跃迁只重算一次，不留脏到下一帧（修复前：下一帧再整轮白做）", () => {
    cascade.addCss(`.cb:checked { color: rgb(0, 255, 255); }`);
    const cb = mount("CheckBox", ["cb"]);

    // 等价于「渲染器写完 button_pressed 之后标脏」
    cb.props.toggle_mode = true;
    cb.props.button_pressed = true;
    cascade.invalidate(cb);

    resetCounters();
    const touched1 = cascade.flush();

    expect(touched1).toBe(1);
    expect(cb.colors.has("font_pressed_color")).toBe(true);
    // 探针：「这类控件支持哪些属性驱动伪类」在首次落地时已按节点缓存，
    // 状态跃迁的该轮不再重复探测（修复前：此处为 1，每轮均需执行一次 hasNodeProperty）
    expect(counters.hasNodeProperty).toBe(0);

    // ★ 修复点：同步已在 apply 前做完，不会把自己重新入脏
    expect(cascade.isDirty(cb)).toBe(false);

    resetCounters();
    expect(cascade.flush()).toBe(0);
    expect(counters.hasNodeProperty).toBe(0); // 没有第二次 applyNode
    expect(counters.setColorOverride).toBe(0);
  });

  it("对照：状态没变化时不会自标脏", () => {
    cascade.addCss(`.cb:checked { color: rgb(0, 255, 255); }`);
    const cb = mount("CheckBox", ["cb"]);
    cb.props.toggle_mode = true;
    cb.props.button_pressed = true;
    cascade.invalidate(cb);
    cascade.flush();

    cascade.invalidate(cb); // 属性没变，只是又收到一次写入
    cascade.flush();
    expect(cascade.isDirty(cb)).toBe(false);
  });
});

/* ================================================================== *
 * 二、一次状态属性写入 = 整棵子树重算
 *
 * 样式表里只要出现后代组合器（`.card .title`，极常见），Invalidator.invalidate 就
 * 展开子树。渲染器对 disabled / editable / button_pressed 的写入走的正是这条路。
 * ================================================================== */

describe("状态属性写入的标脏范围", () => {
  function buildCardTree(count: number): { card: FakeNode; titles: FakeNode[] } {
    const card = new FakeNode("PanelContainer");
    cascade.attach(card);
    card.cssClasses!.add("card");
    const titles: FakeNode[] = [];
    for (let i = 0; i < count; i++) {
      const label = new FakeNode("Label");
      card.add(label);
      cascade.attach(label);
      label.cssClasses!.add("title");
      titles.push(label);
    }
    cascade.flush();
    resetCounters();
    return { card, titles };
  }

  it("样式表含后代组合器：容器上一次 disabled 写入标脏 51 个节点，最终 0 写入", () => {
    cascade.addCss(`.card .title { color: rgb(255, 255, 255); }`);
    const { card, titles } = buildCardTree(50);

    card.props.disabled = true;
    cascade.invalidate(card); // ← 渲染器写 disabled 之后做的事，逐字等价

    expect(dirtyCount([card, ...titles])).toBe(51);

    const touched = cascade.flush();
    expect(touched).toBe(0); // 全部被 diff 短路
    expect(counters.childrenOf).toBeGreaterThanOrEqual(50); // 子树确实展开了
    // 代价：51 次匹配 + 排序，换来 0 字节写入
  });

  it("对照：样式表不含组合器时只标脏自己", () => {
    cascade.addCss(`.title { color: rgb(255, 255, 255); }`);
    const { card, titles } = buildCardTree(50);

    card.props.disabled = true;
    cascade.invalidate(card);
    expect(dirtyCount([card, ...titles])).toBe(1);
    expect(cascade.flush()).toBe(0);
  });
});

/* ================================================================== *
 * 三、选择器要求的状态集每轮都重新遍历 AST
 * ================================================================== */

describe("选择器要求的状态集按对象缓存", () => {
  it("状态集改为按选择器对象缓存，每轮 flush 不再重复遍历 AST", () => {
    cascade.addCss(`.card .title { color: rgb(255, 255, 255); }`);
    const card = new FakeNode("PanelContainer");
    cascade.attach(card);
    card.cssClasses!.add("card");
    const title = new FakeNode("Label");
    card.add(title);
    cascade.attach(title);
    title.cssClasses!.add("title");
    cascade.flush();

    const complex = vi.spyOn(ComplexSelector.prototype, "toString");
    const sequence = vi.spyOn(SimpleSelectorSequence.prototype, "toString");

    cascade.invalidate(title);
    cascade.flush();
    const firstRound = complex.mock.calls.length + sequence.mock.calls.length;

    cascade.invalidate(title);
    cascade.flush();
    const secondRound = complex.mock.calls.length + sequence.mock.calls.length;

    complex.mockRestore();
    sequence.mockRestore();

    // 修复前每轮都要为每条命中选择器拼一次文本（缓存键是文本）；现在按对象记忆
    expect(firstRound).toBe(0);
    expect(secondRound).toBe(0);
  });
});

/* ================================================================== *
 * 四、修复目标：伪类同步不应将节点重新标记为脏
 * ================================================================== */

describe("修复目标：伪类同步不应把节点重新入脏", () => {
  it("状态跃在同一轮 flush 内消解，不留到下一帧", () => {
    cascade.addCss(`.cb:checked { color: rgb(0, 255, 255); }`);
    const cb = register("CheckBox", ["cb"]);
    cb.props.toggle_mode = true;
    cascade.flush();

    cb.props.button_pressed = true;
    cascade.invalidate(cb);
    cascade.flush();

    expect(cb.colors.has("font_pressed_color")).toBe(true);
    expect(cascade.isDirty(cb)).toBe(false); // ← 修复前为 true
  });
});
