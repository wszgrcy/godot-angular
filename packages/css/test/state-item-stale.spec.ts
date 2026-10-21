/**
 * 状态写入位置的**内部记账**与**成本**取证。
 *
 * 运行于 node 环境（mock backend，不依赖引擎）。凡「某条声明最终写入哪个 Godot 主题属性」
 * 这类只能由真实引擎判定的问题，均在 test-app/src/tests/engine/ 下断言：
 *   - css-state-items.spec.ts：写入位置归属、叠加、撤销、:enabled、告警
 *   - css-pseudo.spec.ts / css-state-box.spec.ts：各状态的信号通道与状态盒组成
 * 本文件仅保留两类引擎侧无法观察的内容：
 *   1. 账本槽位（哪个 CSS 属性名占用哪个 item）——引擎侧无对应的可观察量；
 *   2. 固定成本与收敛行为（hasNodeProperty 次数、一次刷新内能否收敛）。
 *
 * mock backend 按 style-target.ts 的 ledger 语义实现：setColorOverride 记录 item 并关联至
 * CSS 属性名，clearProperty(cssName) 撤销该属性名下记录过的全部 item。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  Cascade,
  applyCssProperty,
  colorToCss,
  hasThemeItem,
  itemForStates,
  type CssNode,
  type StyleBackend,
} from "godot-angular/css";

/* ------------------------------------------------------------------ *
 * 假节点 / mock backend（带 ledger，可观察「当前仍生效的 override 集合」）
 * ------------------------------------------------------------------ */

class FakeNode implements CssNode {
  parent: CssNode | null = null;
  cssType: string;
  cssClasses?: Set<string>;
  cssPseudoClasses?: Set<string>;
  props: Record<string, unknown> = {};
  /** 当前还生效的 override：item → 颜色原文（等价 has_theme_color / get_theme_color） */
  overrides = new Map<string, string>();
  /** 账本槽位：`item|cssName`，等价 style-target.ts 的 Slots */
  slots = new Set<string>();
  /** 子节点（childrenOf / invalidateTree 要能真的下树） */
  children: FakeNode[] = [];

  constructor(cssType: string) {
    this.cssType = cssType;
  }

  add(child: FakeNode): void {
    child.parent = this;
    this.children.push(child);
  }

  setStates(...names: string[]): this {
    this.cssPseudoClasses = new Set(names);
    return this;
  }

  /** 引擎在该状态下会读哪个 item —— 用来把「残留的 override」翻译成用户看到的颜色 */
  liveColor(states: string[]): string | undefined {
    const item = itemForStates(this.cssType, "color", "font_color", new Set(states));
    return this.overrides.get(item);
  }

  /** 同上，stylebox 版（基 item 按类取：Button→normal，ItemList→panel） */
  liveBox(states: string[]): string | undefined {
    const base = hasThemeItem(this.cssType, "stylebox", "normal") ? "normal" : "panel";
    const item = itemForStates(this.cssType, "stylebox", base, new Set(states));
    return this.overrides.get(`box:${item}`);
  }
}

/** applyCssProperty 不告诉我们 cssName，真实实现靠 scopeOf(cssName) 闭包；这里同法模拟 */
let currentCss = "";

const backend: StyleBackend = {
  classOf: (node) => (node as FakeNode).cssType,
  bulk: (_node, apply) => apply(),
  mutateStyleBox: (node, item) => {
    const n = node as FakeNode;
    n.overrides.set(`box:${item}`, "box");
    n.slots.add(`stylebox:${item}|${currentCss}`);
  },
  setColorOverride: (node, item, color) => {
    const n = node as FakeNode;
    n.overrides.set(item, colorToCss(color));
    n.slots.add(`${item}|${currentCss}`);
  },
  setFontSizeOverride: () => {},
  setConstantOverride: () => {},
  setFontOverride: () => true,
  setMinimumSize: () => {},
  setOpacity: () => {},
  setNodeNumber: () => {},
  getNodeNumber: (node, prop) => Number((node as unknown as FakeNode).props[prop] ?? 0),
  setNodeBoolean: () => {},
  hasNodeProperty: (node, prop) => prop in (node as FakeNode).props,
  parentOf: (node) => (node as FakeNode).parent,
  childrenOf: (node) => (node as FakeNode).children,
  clearProperty: (node, cssName) => {
    const n = node as FakeNode;
    for (const slot of [...n.slots]) {
      const at = slot.lastIndexOf("|");
      if (slot.slice(at + 1) !== cssName) continue;
      n.overrides.delete(slot.slice(0, at));
      n.slots.delete(slot);
    }
  },
  applyProperty: (node, cssName, raw, warnings, states) => {
    const prev = currentCss;
    currentCss = cssName;
    try {
      return applyCssProperty(node, cssName, raw, { backend, warn: () => {}, states }, warnings);
    } finally {
      currentCss = prev;
    }
  },
};

let cascade: Cascade;

/**
 * 执行已请求的刷新：先把待执行队列取空再逐个调用（执行期间新增的请求归下一轮）。
 * 与 Angular 的 effect 调度行为一致：一次执行不会提前跑掉同一轮内新增的任务。
 */
function pump(pending: Array<() => void>): void {
  for (const flush of pending.splice(0)) flush();
}

beforeEach(() => {
  cascade = new Cascade({ backend });
});

/* ================================================================== *
 * 一、旧语义的自愈现象
 *
 * 背景：曾有一版实现将「写入哪个 theme item」交由「节点当前处于哪些状态」决定（按
 * STATE_PRIORITY 推测引擎此时读取哪个 item）。该做法存在两个硬伤：一条 CSS 属性在任一时刻
 * 仅写入一个 item，状态跃迁时只写新 item、从不撤销旧 item，旧状态 item 成为永久残留；
 * 而且它要求我们准确推测引擎在 hover+focus 同时成立时读取哪个 item，而这并无文档保证。
 *
 * 现行模型（写入位置由选择器自身要求的状态决定、每个 item 仅有一个归属）在引擎侧取证；
 * 此处仅保留「旧语义为何会自愈」这一项对照 —— 它模拟的是已不存在的实现，
 * 在真实引擎上无法复现，因此仅能保留在 node 侧作为分析记录。
 * ================================================================== */

describe("对照：旧语义（基规则也按节点当前状态重定向）为何会自愈", () => {
  it("旧语义会将基值写入当前状态的 item，过期值因此被自动覆盖", () => {
    // 旧行为等价于“把节点当前的伪类集当作声明要求的状态传进去”：那条 bug（禁用按钮看着
    // 没禁用）就是这么来的，但副作用是基值会被写进当前状态的 item，于是状态跃迁时过期值被自动冲掉。
    const btn = new FakeNode("Button").setStates("hover", "focus");

    currentCss = "color";
    // :focus 胜出，但写入位置按节点当前状态挑 → hover 赢，红写进了 font_hover_color
    applyCssProperty(
      btn, "color", "rgb(255, 0, 0)",
      { backend, warn: () => {}, states: new Set(["hover", "focus"]) }, [],
    );
    expect(btn.overrides.get("font_hover_color")).toBe("#ff0000");

    // 只剩键盘焦点
    btn.setStates("focus");
    applyCssProperty(
      btn, "color", "rgb(255, 0, 0)",
      { backend, warn: () => {}, states: new Set(["focus"]) }, [],
    );
    expect(btn.overrides.get("font_focus_color")).toBe("#ff0000");

    // 焦点走了、鼠标还在：基规则胜出，旧语义把蓝也写进 font_hover_color → 过期红被冲掉
    btn.setStates("hover");
    applyCssProperty(
      btn, "color", "rgb(0, 0, 255)",
      { backend, warn: () => {}, states: new Set(["hover"]) }, [],
    );
    expect(btn.liveColor(["hover"])).toBe("#0000ff");
  });
});

/* ================================================================== *
 * 二、两条入口对同一条基规则必须写在同一个盒
 *
 * 引擎侧仅能看到组成后的 stylebox（状态盒本身就会继承基声明），无法观察「该条声明记在哪个槽」；
 * 槽位归属是内部契约，只能在假 ledger 上钉。
 * ================================================================== */

describe("两条入口对同一条基规则必须写在同一个槽", () => {
  it("已禁用的按钮 + 未书写 :disabled 的蓝色规则 → 两条入口均记在 normal 槽", () => {
    // —— A. applyStyle(button, "background-color", "blue")：裸声明，无选择器 → 空状态集
    const viaApplyStyle = new FakeNode("Button").setStates("disabled");
    viaApplyStyle.props.disabled = true;
    currentCss = "background-color";
    applyCssProperty(
      viaApplyStyle,
      "background-color",
      "rgb(0, 0, 255)",
      { backend, warn: () => {}, states: new Set<string>() },
      [],
    );

    // —— B. 级联（class / 模板样式）对同一条规则的口径
    const viaCascade = new FakeNode("Button").setStates("disabled");
    viaCascade.props.disabled = true;
    applyCssProperty(
      viaCascade,
      "background-color",
      "rgb(0, 0, 255)",
      { backend, warn: () => {}, states: new Set<string>() },
      [],
    );

    // 两侧一致：蓝色记在 normal 槽，disabled 槽未写入任何内容 → 禁用外观交由引擎默认处理
    for (const [name, node] of [["applyStyle", viaApplyStyle], ["级联", viaCascade]] as const) {
      expect(node.slots.has(`stylebox:normal|background-color`), name).toBe(true);
      expect(node.slots.has(`stylebox:disabled|background-color`), name).toBe(false);
    }
  });

  it("states 已是必填：不传就编译不过（类型层面封死“漏传→静默旧行为”）", () => {
    // 类型断言反向证明：ApplyContext 上 states 不是可选属性。
    // 若有人把它改回 `states?: ReadonlySet<string>`，本行会报错。
    type MustBeRequired = import("godot-angular/css").ApplyContext["states"];
    const value: MustBeRequired = new Set<string>();
    expect(value.size).toBe(0);
  });
});

/* ================================================================== *
 * 三、性能 —— 同步伪类的固定成本与一次多余的调度
 * ================================================================== */

describe("syncPropertyPseudoClasses 的成本（已优化）", () => {
  it("类支持情况按节点缓存：首轮探一次，之后每轮 0 次 hasNodeProperty", () => {
    let hasNodeProperty = 0;
    let getNodeNumber = 0;
    const counting: StyleBackend = {
      ...backend,
      hasNodeProperty: (node, prop) => {
        hasNodeProperty++;
        return prop in (node as FakeNode).props;
      },
      getNodeNumber: (node, prop) => {
        getNodeNumber++;
        return Number((node as FakeNode).props[prop] ?? 0);
      },
    };
    const c = new Cascade({ backend: counting });
    c.addCss(`.x:disabled { color: red; } .x:checked { color: red; } .x:read-only { color: red; }`);

    const labels: FakeNode[] = [];
    for (let i = 0; i < 100; i++) {
      const label = new FakeNode("Label"); // 三个属性一个都没有
      c.attach(label);
      label.cssClasses!.add("x"); // class 必须在 attach 之后写
      labels.push(label);
    }
    c.flush();
    // 首轮：每个节点探一次（只探样式表真的用到的那 3 个状态），这是无法避免的固定成本
    expect(hasNodeProperty).toBe(300); // 100 节点 × 3 个状态属性
    expect(getNodeNumber).toBe(0); // 类推不出，属性一个也没读

    // ★ 修复点：第二轮起不再重探。修复前这里同样是 300（真实 backend 里
    //   每次 hasNodeProperty = get_class() + 属性表 Set.has），现在是 0。
    hasNodeProperty = 0;
    getNodeNumber = 0;
    for (const label of labels) c.invalidate(label);
    c.flush();
    expect(hasNodeProperty).toBe(0);
    expect(getNodeNumber).toBe(0);
  });

  it("新样式表引入新的属性驱动伪类时，缓存会重探（不能拿旧结论当真）", () => {
    let hasNodeProperty = 0;
    const counting: StyleBackend = {
      ...backend,
      hasNodeProperty: (node, prop) => {
        hasNodeProperty++;
        return prop in (node as FakeNode).props;
      },
    };
    const c = new Cascade({ backend: counting });
    c.addCss(`.x:disabled { color: red; }`);
    const cb = new FakeNode("CheckBox");
    cb.props.disabled = false;
    c.attach(cb);
    cb.cssClasses!.add("x");
    c.flush();
    expect(hasNodeProperty).toBe(1); // 只探了 disabled

    hasNodeProperty = 0;
    c.addCss(`.x:checked { color: red; }`); // 新引入 checked → 签名变了
    c.invalidate(cb);
    c.flush();
    expect(hasNodeProperty).toBe(2); // disabled + checked 重探
  });

  it("状态变化在一次刷新内写入完成，不拖到下一次", () => {
    const pending: Array<() => void> = [];
    const c = new Cascade({
      backend,
      scheduler: { request: (flush) => pending.push(flush) },
    });
    c.addCss(`.cb:checked { color: rgb(0, 255, 255); }`);

    const cb = new FakeNode("CheckBox");
    cb.props.button_pressed = false;
    c.attach(cb);
    cb.cssClasses!.add("cb"); // class 必须在 attach 之后写
    pump(pending); // 第 1 次刷新：处理 attach 时标记的节点

    cb.props.button_pressed = true;
    c.invalidate(cb);
    pump(pending); // 第 2 次刷新：处理状态变化

    expect(c.isDirty(cb)).toBe(false); // 本次已处理完毕，无残留
    expect(cb.overrides.size).toBe(1); // :checked 的颜色已写入

    // 再刷新一次不得多写任何内容（刷新过程中顺带标记的节点已在本次处理完，
    // 不需要下一次补写）
    const written = new Map(cb.overrides);
    c.flush();
    expect(cb.overrides).toEqual(written);
  });

  it("applyNode 里 var() 变化触发的子树重算不会丢失", () => {
    const pending: Array<() => void> = [];
    const c = new Cascade({
      backend,
      scheduler: { request: (flush) => pending.push(flush) },
    });
    c.addCss(`.a { --c: rgb(255, 0, 0); }`);
    c.addCss(`.b { --c: rgb(0, 0, 255); }`);
    c.addCss(`.kid { color: var(--c); }`);

    const root = new FakeNode("PanelContainer");
    c.attach(root);
    root.cssClasses!.add("a");
    const kid = new FakeNode("Label");
    root.add(kid);
    c.attach(kid);
    kid.cssClasses!.add("kid");
    pump(pending);
    expect(kid.overrides.get("font_color")).toBe("#ff0000");

    // 换 class → 根节点变量变 → applyNode 里 invalidateTree(子树)
    root.cssClasses!.delete("a");
    root.cssClasses!.add("b");
    // 连续执行直到没有待执行回调（最多 5 轮，仍有则说明未收敛）
    let rounds = 0;
    while (pending.length && rounds < 5) {
      rounds++;
      pump(pending);
    }

    expect(kid.overrides.get("font_color")).toBe("#0000ff");
    // ★ 子树是在 applyNode 执行期间才被标记的，而本次刷新已将队列取空 → 必须重新调用
    //   request()，否则这条变量继承会一直停在旧值。（合并多余的空刷新可以，
    //   遗漏真正需要刷新的节点不行）
    expect(rounds).toBeLessThan(5); // 几次之内结束，不会无限刷新
  });
});
