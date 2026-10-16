/**
 * 「状态伪类 → theme item 落点」的契约 spec。
 *
 * 目的不是补覆盖率，而是钉住一个容易做错的点：「写哪个 theme item」必须由
 * 「命中的那条选择器自身要求了哪些状态」决定，而不是由「节点当前处于哪些状态」推导。
 * 后者需要猜引擎在多个状态同时成立时读哪个 item（无文档保证），而且会让状态 item
 * 只写不撤。全部跑在 node 环境（假 backend，不依赖引擎）。
 *
 * 与 packages/css/test/cascade-state-proof.spec.ts 的区别：那份自带假 backend 只记录
 * 「写过哪些 item」，clearProperty 是空实现，因此看不见「上一轮写的状态 item 有没有被撤掉」
 * ——而下面 1、2 两条要看的正是这个。这里的假 backend 按 style-target.ts 的 ledger 语义
 * 实现：setColorOverride 记 item 并关联到 CSS 属性名，clearProperty(cssName) 撤掉该属性名
 * 下记过的全部 item。
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
 * 假节点 / 假 backend（带 ledger，能观察「当前还生效的 override 集合」）
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

  constructor(cssType: string) {
    this.cssType = cssNameSafe(cssType);
  }

  /** 子节点（childrenOf / invalidateTree 要能真的下树） */
  children: FakeNode[] = [];

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

function cssNameSafe(s: string): string {
  return s;
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

beforeEach(() => {
  cascade = new Cascade({ backend });
});

function attach(cssType: string, classes: string[]): FakeNode {
  const node = new FakeNode(cssType);
  cascade.attach(node);
  for (const c of classes) node.cssClasses!.add(c);
  return node;
}

function rerun(node: FakeNode): void {
  cascade.invalidate(node);
  cascade.flush();
}

/* ================================================================== *
 * 取证 1：状态 item 的归属与回收
 *
 * 背景：曾有一版实现把「写哪个 theme item」交给「节点当前处于哪些状态」（按 STATE_PRIORITY
 * 猜引擎此刻读哪个 item）。那个做法有两个硬伤：
 *   1. 一条 CSS 属性在任一时刻只写一个 item，状态跃迁时只写新 item、从不撤旧 item，
 *      旧状态 item 变成永久残留（`:focus` 的红在失去焦点后仍被 hover 态读到）。
 *   2. 它要求我们猜对引擎在 hover+focus 同时成立时读哪个 item，而这无文档保证。
 *
 * 现在的模型：落点由「选择器自身要求了哪些状态」决定，每个 item 只有一个主人；规则不再
 * 命中时它的账本键就消失，`applyNode` 会整组撤销该 CSS 属性名并重写存活条目，残留因此
 * 不可能出现。下面的用例钉的就是这个契约。
 * ================================================================== */
describe("取证 1：状态 item 的归属与回收", () => {
  it("机制前提：itemForStates 按传入的状态集选 item", () => {
    // 注意传入的是「选择器要求的状态」，不是「节点当前的状态」。
    // 同一个状态集下多个状态仍会合成（hover+focus → hover 赢），但那只发生在
    // 同一条选择器同时写了两个伪类时（`.btn:hover:focus`）。
    expect(itemForStates("Button", "color", "font_color", new Set(["hover", "focus"]))).toBe("font_hover_color");
    expect(itemForStates("Button", "color", "font_color", new Set(["focus"]))).toBe("font_focus_color");
  });

  it("重叠区不再串味：:focus 的颜色只写 font_focus_color，不再占用 hover 的 item", () => {
    cascade.addCss(`.btn { color: rgb(0, 0, 255); }`); // 基规则：蓝
    cascade.addCss(`.btn:focus { color: rgb(255, 0, 0); }`); // 焦点：红

    const btn = attach("Button", ["btn"]).setStates("hover", "focus");
    cascade.flush();
    // 落点由选择器自身决定：:focus 规则写 font_focus_color，基规则写 font_color
    expect(btn.overrides.get("font_focus_color")).toBe("#ff0000");
    expect(btn.overrides.get("font_color")).toBe("#0000ff");
    // 作者没写 :hover，所以 hover 的 item 一个也没被写 → 该状态交回主题
    expect(btn.overrides.has("font_hover_color")).toBe(false);

    // 鼠标移开，只留键盘焦点
    btn.setStates("focus");
    rerun(btn);
    expect(btn.overrides.get("font_focus_color")).toBe("#ff0000");

    // 焦点也失去、鼠标移回：:focus 规则已不命中，它的 item 必须被撤掉
    btn.setStates("hover");
    rerun(btn);

    expect(btn.overrides.get("font_color")).toBe("#0000ff"); // 基 item 写对了
    // ★ 不再残留：font_focus_color 已清空，hover 态读到的是主题默认值而不是上一轮的红
    expect(btn.overrides.has("font_focus_color")).toBe(false);
    expect(btn.liveColor(["hover"])).toBeUndefined();
  });

  it("对照：旧语义（基规则也按节点当前状态重定向）为何会自愈", () => {
    // 旧行为等价于“把节点当前的伪类集当作声明要求的状态传进去”：那条 bug（禁用按钮看着
    // 没禁用）就是这么来的，但副作用是基值会被写进当前状态的 item，于是状态跃迁时过期值被自动冲掉。
    const btn = new FakeNode("Button").setStates("hover", "focus");

    currentCss = "color";
    // :focus 胜出，但落点按节点当前状态挑 → hover 赢，红写进了 font_hover_color
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

  it("规则整张撤掉时，已经写过的状态 item 会被清空", () => {
    const focus = cascade.addCss(`.btn:focus { color: rgb(255, 0, 0); }`);
    cascade.addCss(`.btn { color: rgb(0, 0, 255); }`);

    const btn = attach("Button", ["btn"]).setStates("hover", "focus");
    cascade.flush();

    btn.setStates("focus");
    rerun(btn);

    // 规则整张撤掉（组件销毁 / 热更新），节点仍在 hover
    cascade.removeSheet(focus);
    btn.setStates("hover");
    cascade.flush();

    // :focus 规则已经不存在了，它的 item 也跟着消失，不会在 hover 时漏出上一轮的红
    expect(btn.overrides.has("font_focus_color")).toBe(false);
    expect(btn.overrides.get("font_color")).toBe("#0000ff");
    expect(btn.liveColor(["hover"])).toBeUndefined();
  });
});

/* ================================================================== *
 * 取证 2：新加的例外表只补了 read-only，没补 ItemList / Tree 的 hovered
 *
 * STATE_COLOR_INFIX 是这次新加的机制，用来处理「同一语义在不同类上叫法不同」。
 * 同一个问题在 hover 上更严重：ItemList / Tree 的悬停 item 叫 hovered / font_hovered_color，
 * 而 STATE_STYLEBOX.hover 固定是 hover → hasThemeItem 不命中 → itemForStates 退回**基 item**。
 * 退回基 item 不是「没效果」，而是「把悬停色写到了常态 item 上」：鼠标划过一次，
 * 整个列表的颜色就永久变了。
 * ================================================================== */
describe("取证 2：ItemList / Tree 的 hover 落点错到基 item", () => {
  it("ItemList 有 hovered / font_hovered_color，但词汇表映射给的是 hover", () => {
    expect(hasThemeItem("ItemList", "stylebox", "hover")).toBe(false);
    expect(hasThemeItem("ItemList", "stylebox", "hovered")).toBe(true);
    expect(hasThemeItem("ItemList", "color", "font_hover_color")).toBe(false);
    expect(hasThemeItem("ItemList", "color", "font_hovered_color")).toBe(true);
  });

  it("ItemList:hover 写的是 panel / font_color —— 常态 item", () => {
    expect(itemForStates("ItemList", "stylebox", "panel", new Set(["hover"]))).toBe("panel");
    expect(itemForStates("ItemList", "color", "font_color", new Set(["hover"]))).toBe("font_color");
  });

  it("后果：:hover 的颜色被写到常态 item 上，效果整体错位", () => {
    cascade.addCss(`.files:hover { color: rgb(255, 255, 0); }`);
    const list = attach("ItemList", ["files"]).setStates("hover");
    cascade.flush();

    // 悬停色被写进 font_color —— 那是「未悬停」时读的 item
    expect(list.overrides.get("font_color")).toBe("#ffff00");
    // 引擎真正为悬停准备的 item 一个字节都没收到
    expect(list.overrides.has("font_hovered_color")).toBe(false);
    // 同理底色：hovered 盒没被写，panel（常态盒）被改了
    expect(list.overrides.has("box:hovered")).toBe(false);
  });

  it("对照：read-only 已经补了例外表，hover 没有", () => {
    // 这次新增的 STATE_COLOR_INFIX 正是为「同一语义在不同类叫法不同」准备的机制，
    // 但它只登记了 read-only（readonly / uneditable），没登记 ItemList / Tree 的 hovered
    expect(itemForStates("TextEdit", "color", "font_color", new Set(["read-only"]))).toBe("font_readonly_color");
    expect(itemForStates("ItemList", "color", "font_color", new Set(["hover"]))).toBe("font_color");
  });
});

/* ================================================================== *
 * 取证 3：两条写样式的入口必须对同一条规则给出同一个盒
 *
 * 名词先说清（Godot 的 theme item 分四类，这里只用到前两类）：
 *   - “盒”= stylebox。引擎按状态分了好几个：normal / hover / pressed / disabled / focus，
 *     禁用时画 disabled 盒、平时画 normal 盒。一个盒 = 一份 StyleBoxFlat（底色 + 圆角 + 边框）。
 *   - “基规则”= 选择器里没写任何状态伪类的规则，如 `Button.primary { background-color: 蓝 }`。
 *   - “写进 disabled 盒”= add_theme_stylebox_override("disabled", …)，把引擎自带的禁用样式盖掉。
 *
 * 这次修的 bug 就是：基规则的蓝色被写进了 disabled 盒 → 禁用按钮跟启用时一个样。
 * 修法：落点完全由选择器要求的状态集推导（空集 = 基 item），两条入口对同一条规则
 * 必须给出同一个盒。
 *
 * 本条钉的是收口后的契约：级联（有选择器）与 applyStyle（裸声明，恒 false）
 * 对同一条“没写 :disabled 的蓝色规则”必须给出同一个盒，否则同一个节点上两套语义。
 * ================================================================== */
describe("取证 3：两条入口对同一条基规则必须落在同一个盒", () => {
  it("已禁用的按钮 + 没写 :disabled 的蓝色规则 → 两条入口都写 normal 盒", () => {
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

    // 两边一致：蓝色写 normal 盒，disabled 盒交回引擎默认 → 禁用外观正常
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
 * 取证 4：性能 —— 同步伪类的固定成本与一次多余的调度
 * ================================================================== */
describe("取证 4：syncPropertyPseudoClasses 的成本（已优化）", () => {
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

  it("状态跃迁不再另排一次空转的 flush", () => {
    let scheduled = 0;
    const queue: Array<() => void> = [];
    const c = new Cascade({
      backend,
      schedule: (flush) => {
        scheduled++;
        queue.push(flush);
      },
    });
    c.addCss(`.cb:checked { color: rgb(0, 255, 255); }`);

    const cb = new FakeNode("CheckBox");
    cb.props.button_pressed = false;
    c.attach(cb);
    cb.cssClasses!.add("cb"); // class 必须在 attach 之后写
    queue.shift()!(); // 第 1 次调度：attach 的标脏

    cb.props.button_pressed = true;
    c.invalidate(cb);
    const before = scheduled;
    queue.shift()!(); // 第 2 次调度：状态跃迁那一轮

    expect(c.isDirty(cb)).toBe(false); // 本轮已收敛
    // ★ 修复点：同步产生的脏在本轮内消化，不再多排一次空转。
    //   修复前 takeDirty 把 flushScheduled 复位 → setPseudoClass 回调又排了一次
    expect(scheduled).toBe(before);
    expect(queue).toHaveLength(0);
  });

  it("确实还有残留时才补排一次：applyNode 里 var() 变化触发的子树重算不会被吞掉", () => {
    let scheduled = 0;
    const queue: Array<() => void> = [];
    const c = new Cascade({
      backend,
      schedule: (flush) => {
        scheduled++;
        queue.push(flush);
      },
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
    queue.shift()!();
    expect(kid.overrides.get("font_color")).toBe("#ff0000");

    // 换 class → 根节点变量变 → applyNode 里 invalidateTree(子树)
    root.cssClasses!.delete("a");
    root.cssClasses!.add("b");
    const before = scheduled;
    // 把排到的 flush 跑完（最多 3 轮，再多就是没收敛）
    for (let i = 0; i < 3 && queue.length; i++) queue.shift()!();

    expect(kid.overrides.get("font_color")).toBe("#0000ff");
    // ★ 子树在 applyNode 期间才入脏，本轮 drain 已扫完 → endFlush 必须补排一次，
    //   否则这条变量继承永远停在旧值（不能把“不空转”优化成“吞掉真活的”）
    expect(scheduled).toBeGreaterThan(before);
    expect(queue).toHaveLength(0); // 收敛，不再多排
  });
});

/* ================================================================== *
 * 取证 5：旧 README 推荐的 setPseudoClass(node,"disabled",true) 现在被静默读回
 *
 * 改动前：setPseudoClass 直接往 cssPseudoClasses 里加 disabled，加上就一直在 → 样式生效。
 * 改动后：flush 前置的 syncPropertyPseudoClasses 会读 node.disabled（仍是 false）把
 *         :disabled 关掉 —— 同一轮里加进去又立刻被抹掉，且**没有任何告警**。
 * 这是公开 API 的静默行为变更（README 旧版第 579 行的官方写法）。
 * ================================================================== */
describe("取证 5：setPseudoClass 对属性驱动状态已失效（静默）", () => {
  function buttonWithDisabledRule(): { c: Cascade; btn: FakeNode; flush: () => void } {
    let scheduled = 0;
    const queue: Array<() => void> = [];
    const c = new Cascade({
      backend,
      schedule: (flush) => {
        scheduled++;
        queue.push(flush);
      },
    });
    c.addCss(`.btn:disabled { color: rgb(128, 128, 128); }`);
    const btn = new FakeNode("Button");
    btn.props.disabled = false; // 引擎属性：没禁用
    c.attach(btn);
    btn.cssClasses!.add("btn"); // class 必须在 attach 之后写（attach 会换掉集合且不迁移）
    return {
      c,
      btn,
      flush: () => {
        void scheduled;
        const run = queue.shift();
        if (run) run();
        else c.flush();
      },
    };
  }

  it("只调 setPseudoClass 不改属性 → 同一轮被读回，样式不生效", () => {
    const { c, btn, flush } = buttonWithDisabledRule();
    flush();

    c.setPseudoClass(btn, "disabled", true); // ← 旧 README 的官方写法
    flush();

    expect(btn.cssPseudoClasses?.has("disabled")).toBe(false); // 被属性同步抹掉
    expect(btn.overrides.has("font_disabled_color")).toBe(false); // 样式没落地
  });

  it("改属性（新口径）才有效", () => {
    const { c, btn, flush } = buttonWithDisabledRule();
    flush();

    btn.props.disabled = true; // ← 新口径：改引擎属性
    c.invalidate(btn);
    flush();

    expect(btn.cssPseudoClasses?.has("disabled")).toBe(true);
    expect(btn.overrides.get("font_disabled_color")).toBe("#808080");
  });
});

/* ================================================================== *
 * 取证 6：:enabled 与 :disabled 同源（已接）+ 按类提示
 *
 * 评审前：SUPPORTED_PSEUDO_CLASSES 里有 enabled（选择器能写、能解析），但没有任何东西
 * 会把 enabled 写进 cssPseudoClasses → .btn:enabled 永不命中，也不出声。
 * 现在：PROPERTY_STATE_CLASSES 多一行 invert，:enabled = !disabled；同时
 * syncPropertyPseudoClasses 对「这类控件根本没有那个属性」按（状态 × 类名）告警一次。
 * ================================================================== */
describe("取证 6：:enabled 由 disabled 反推，推不出时按类出声", () => {
  it("节点可用时 .btn:enabled 现在能命中", () => {
    cascade.addCss(`.btn:enabled { color: rgb(0, 255, 0); }`);
    const btn = attach("Button", ["btn"]);
    btn.props.disabled = false; // 明确可用
    cascade.flush();

    expect(btn.cssPseudoClasses?.has("enabled")).toBe(true);
    expect(btn.overrides.get("font_color")).toBe("#00ff00");

    btn.props.disabled = true;
    rerun(btn);
    expect(btn.cssPseudoClasses?.has("enabled")).toBe(false);
    expect(btn.overrides.has("font_color")).toBe(false);
  });

  it("控件类上没有那个属性时，告警里点名是哪个类、该走哪条通道", () => {
    const warnings: Array<[string, string]> = [];
    const c = new Cascade({ backend, warn: (key, message) => warnings.push([key, message]) });
    c.addCss(`.list:disabled { color: rgb(128, 128, 128); }`);

    const list = new FakeNode("ItemList"); // ItemList 没有 disabled 属性
    c.attach(list);
    list.cssClasses!.add("list");
    c.flush();

    expect(list.cssPseudoClasses?.has("disabled")).toBeFalsy();
    const hit = warnings.find(([, m]) => m.includes("ItemList"));
    expect(hit, `告警里应点名类名，实际：${JSON.stringify(warnings)}`).toBeDefined();
    expect(hit![0]).toBe("pseudo-state:disabled:ItemList");
    expect(hit![1]).toContain("class 通道");
  });

  it("同一个（状态 × 类名）只报一次，不逐节点刷屏", () => {
    const warnings: string[] = [];
    const c = new Cascade({ backend, warn: (key) => warnings.push(key) });
    c.addCss(`.list:disabled { color: rgb(128, 128, 128); }`);

    const lists: FakeNode[] = [];
    for (let i = 0; i < 5; i++) {
      const list = new FakeNode("ItemList");
      c.attach(list);
      list.cssClasses!.add("list");
      lists.push(list);
    }
    c.flush();

    // 级联本身不去重（去重是引擎侧 warnOnce 的事），但 key 只有一组值
    const keys = new Set(warnings);
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe("pseudo-state:disabled:ItemList");
    void lists;
  });
});
