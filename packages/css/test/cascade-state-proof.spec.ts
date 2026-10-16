/**
 * 状态伪类落点（选择器要求的状态 / 属性驱动伪类）的行为与性能取证。
 *
 * 跑在 **node** 环境（vitest.node.config.mts）：`packages/css` 不 import `godot`，
 * `Cascade` 只依赖 `StyleBackend` 接口，因此可以用假 backend 精确计数
 * 「一次重算到底做了多少次工作」——这是引擎内 spec 做不到的（那边只能看最终 item）。
 *
 * 观察口径：
 *   - 写入的 theme item 名 ← setColorOverride（等价引擎侧 has_theme_color_override）
 *   - applyNode 是否跑了   ← hasNodeProperty 调用次数（syncPropertyPseudoClasses
 *                             每个「被样式表用到的状态属性」恰好探测一次）
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

/** 登记节点但不落地，便于在首次 flush 之前摆好状态 */
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
 * 一、scopedFlags 按 Declaration 对象记标记 —— 能否触发错误结果？
 *
 * 结论：**证伪，当前不产生错误结果**。一条规则的多个选择器共享同一批 Declaration
 * 对象（SheetRegistry.add 里 declarations.set(selector, ruleSet.declarations)），
 * 但 scopedFlags 的写入顺序与 put() 的覆盖顺序是同一个循环、同样后写覆盖，
 * 于是「最终标记」必然落在「级联胜出者」那条选择器上。
 *
 * 下面四条断言钉住这个巧合。它防的是将来：只要有人对 normal 去重、二次排序，
 * 或把 important 的写入提前，这组用例立刻挂。
 * ================================================================== */

describe("选择器要求的状态跟着「选择器-声明」对走，不跟着 Declaration 走", () => {
  /** 首次落地前就把伪类摆好，避免「基 item 先写一次」干扰观察 */
  function mountHovered(classes: string[]): FakeNode {
    const btn = register("Button", classes);
    btn.cssPseudoClasses = new Set(["hover"]);
    cascade.flush();
    return btn;
  }

  it("一条规则的两个选择器各自按自己的要求落点：状态 item 与基 item 各写一份", () => {
    cascade.addCss(`.btn:hover, .btn.is-off { color: rgb(255, 0, 0); }`);
    const btn = mountHovered(["btn", "is-off"]);
    // 两个选择器共享同一个 Declaration，但要求的状态不同 → 两个落点，不存在“后者覆盖前者”
    expect(btn.colors.get("font_hover_color")).toBe("#ff0000");
    expect(btn.colors.get("font_color")).toBe("#ff0000");
  });

  it("源码顺序反过来结果不变：落点不依赖“哪个选择器在后”", () => {
    cascade.addCss(`.btn.is-off, .btn:hover { color: rgb(255, 0, 0); }`);
    const btn = mountHovered(["btn", "is-off"]);
    expect(btn.colors.get("font_hover_color")).toBe("#ff0000");
    expect(btn.colors.get("font_color")).toBe("#ff0000");
  });

  it("每个落点各自选胜者：特异度更高的基规则只抢走 font_color，不抢 font_hover_color", () => {
    cascade.addCss(`.btn:hover, .btn.is-off { color: rgb(255, 0, 0); }`);
    cascade.addCss(`.btn.is-off.x { color: rgb(0, 0, 255); }`);
    const btn = mountHovered(["btn", "is-off", "x"]);
    // 旧模型（一条属性一个胜者）会整体变成蓝，:hover 的颜色直接消失
    expect(btn.colors.get("font_hover_color")).toBe("#ff0000");
    expect(btn.colors.get("font_color")).toBe("#0000ff");
  });

  it("!important 分支同样按落点各自算", () => {
    cascade.addCss(`.btn:hover, .btn.is-off { color: rgb(255, 0, 0) !important; }`);
    cascade.addCss(`.btn { color: rgb(0, 0, 255); }`);
    const btn = mountHovered(["btn", "is-off"]);
    expect(btn.colors.get("font_hover_color")).toBe("#ff0000");
    // important 的基规则仍胜过普通的基规则
    expect(btn.colors.get("font_color")).toBe("#ff0000");
  });
});

/* ================================================================== *
 * 二、问题 2 的取证：层叠仍是「替换」，变的是「值送到哪个 item」
 *
 * 用 applyCssProperty 直接做 A/B：同一个节点、同一条声明，变的只是选择器要求的状态：
 *   states = ∅        → 基规则 / 内联 → 写基 item
 *   states = {hover}  → 选择器写了 :hover → 写引擎在该状态读的 item
 * ================================================================== */

describe("基规则与状态规则：叠加还是替换？", () => {
  function writeColor(node: FakeNode, raw: string, states: ReadonlySet<string>): string[] {
    node.colors.clear();
    applyCssProperty(node, "color", raw, { backend, warn: () => {}, states }, []);
    return [...node.colors.keys()];
  }

  it("基规则写基 item，:hover 规则写状态 item", () => {
    const btn = register("Button", ["btn"]);
    btn.cssPseudoClasses = new Set(["hover"]);

    expect(writeColor(btn, "rgb(0, 0, 255)", new Set())).toEqual(["font_color"]);
    expect(writeColor(btn, "rgb(0, 0, 255)", new Set(["hover"]))).toEqual(["font_hover_color"]);
    // 落点与节点当前处于哪些状态无关：没处于 hover 也一样
    btn.cssPseudoClasses = new Set();
    expect(writeColor(btn, "rgb(0, 0, 255)", new Set(["hover"]))).toEqual(["font_hover_color"]);
  });

  it("作者写了 :hover 规则时，两个 item 同时存在（叠加，不是替换）", () => {
    cascade.addCss(`.btn { color: rgb(0, 0, 255); }`);
    cascade.addCss(`.btn:hover { color: rgb(255, 0, 0); }`);
    const btn = mount("Button", ["btn"]);
    expect([...btn.colors.keys()]).toEqual(["font_color"]);

    btn.cssPseudoClasses = new Set(["hover"]);
    cascade.invalidate(btn);
    cascade.flush();
    // 基 item 的 override 仍在（引擎在 normal 态读它），hover item 另写一份
    expect(btn.colors.get("font_color")).toBe("#0000ff");
    expect(btn.colors.get("font_hover_color")).toBe("#ff0000");
  });

  it("作者只写基规则时，进入 hover 后状态 item 一个都没有 → 该状态交回主题", () => {
    cascade.addCss(`.btn { color: rgb(0, 0, 255); }`);
    const btn = mount("Button", ["btn"]);

    btn.cssPseudoClasses = new Set(["hover"]);
    cascade.invalidate(btn);
    cascade.flush();
    // 只剩基 item：引擎悬停时读 font_hover_color，本库没写 → 主题默认色
    expect([...btn.colors.keys()]).toEqual(["font_color"]);
  });
});

/* ================================================================== *
 * 三、性能取证 B：状态跃迁会让同一节点被完整重算两次
 *
 * syncPropertyPseudoClasses 在 applyNode 内部改伪类 → TrackingClassSet 回调
 * invalidate(node)；而 flush() 已经 takeDirty() 取空队列并置 state.dirty=false，
 * 于是该节点被重新入脏，下一帧再走一遍 sync + merge + diff，最后被 diff 短路。
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
    // 状态跃迁这一轮不再重探（修复前：这里会是 1，每轮都要 hasNodeProperty 一遗）
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
 * 四、性能取证 A：一次状态属性写入 = 整棵子树重算
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
 * 五、性能取证 C：选择器要求的状态集每轮都重新遍历 AST
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
 * 七、问题 2 可证的那一半：路由来源与命中来源不是同一件事
 *
 * 落点必须取自「选择器自身主体段要求了哪些状态」。如果改取「选择器文本里出现过 :xxx」
 * 或「目标节点当前处于哪些伪类」，两者不同源，同一条规则、同一个命中事实，落点会跟着
 * 与规则无关的状态漂。:not(:hover) 同理被误判为“要求了状态”。
 * ================================================================== */

describe("落点只看选择器自身的主体段", () => {
  it("`.card:hover .btn` 的落点不应随按钮自身是否被悬停而漂", () => {
    cascade.addCss(`.card:hover .btn { color: rgb(255, 0, 0); }`);
    const card = register("PanelContainer", ["card"]);
    const btn = register("Button", ["btn"]);
    card.add(btn);

    // A：鼠标在卡片上、没压在按钮上
    card.cssPseudoClasses = new Set(["hover"]);
    cascade.flush();
    const a = [...btn.colors.keys()];

    // B：鼠标压在按钮上（卡片与按钮同时 hover）—— 规则命中的理由完全没变
    btn.cssPseudoClasses = new Set(["hover"]);
    cascade.invalidate(btn);
    cascade.flush();
    const b = [...btn.colors.keys()];

    // 规则说的是“卡片被悬停”，与按钮自身的 hover 无关 → 不应多出 font_hover_color
    expect(b).toEqual(a);
  });

  it("`:not(:hover)` 不要求任何状态，不应被当成状态声明", () => {
    cascade.addCss(`.btn:not(:hover) { color: rgb(0, 0, 255); }`);
    const btn = register("Button", ["btn"]);
    // 命中（没悬停），但节点处于 focus：文本里那个 “:hover” 会把声明误标为状态声明
    btn.cssPseudoClasses = new Set(["focus"]);
    cascade.flush();

    expect([...btn.colors.keys()]).toEqual(["font_color"]);
  });
});

/* ================================================================== *
 * 八、问题 3（已推翻）：:checked 是否需要额外读 toggle_mode
 *
 * 假设：引擎的 is_pressed() = toggle_mode && button_pressed，只看 button_pressed 会给
 * 一个引擎根本不画的 pressed 盒上色。
 *
 * 实测（test-app/src/tests/engine/css-pseudo.spec.ts）：toggle_mode=false 时写
 * button_pressed = true，读回来就是 false —— setter 自己做了门控。因此只读
 * button_pressed 已经等价于 is_pressed()，无需再加一层 requires 探测。
 * 下面的护栏只钉住「button_pressed 读回 false 时 :checked 必须关」这个契约。
 * ================================================================== */

describe(":checked 只看 button_pressed 读回值", () => {
  it("button_pressed 为 false 时 :checked 不开（引擎在 setter 里已做 toggle_mode 门控）", () => {
    cascade.addCss(`.tab:checked { color: rgb(0, 255, 255); }`);
    const tab = register("Button", ["tab"]);
    tab.props.toggle_mode = false;
    tab.props.button_pressed = false; // ← 引擎在 toggle_mode=false 时只能存住 false
    cascade.invalidate(tab);
    cascade.flush();

    expect(tab.cssPseudoClasses?.has("checked")).toBeFalsy();
    expect(tab.colors.size).toBe(0);
  });

  it("button_pressed 为 true 时照常生效", () => {
    cascade.addCss(`.tab:checked { color: rgb(0, 255, 255); }`);
    const tab = register("CheckBox", ["tab"]);
    tab.props.toggle_mode = true;
    tab.props.button_pressed = true;
    cascade.invalidate(tab);
    cascade.flush();

    expect(tab.colors.has("font_pressed_color")).toBe(true);
  });
});

/* ================================================================== *
 * 九、性能修法的目标状态（修复前失败）
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

  it("伪类变化连带依赖者也在同一轮处理完", () => {
    // 用后代而不是兄弟：兄弟组合器需要 getChildIndex / getChildAt 这些访问器，
    // 那是 StyleRuntime.attach 挂的，假 backend 没有
    cascade.addCss(`.btn:disabled .title { color: rgb(0, 255, 255); }`);
    const btn = new FakeNode("Button").asButton();
    cascade.attach(btn);
    btn.cssClasses!.add("btn");
    const title = new FakeNode("Label");
    btn.add(title);
    cascade.attach(title);
    title.cssClasses!.add("title");
    cascade.flush();

    expect(title.colors.has("font_color")).toBe(false);

    btn.props.disabled = true;
    cascade.invalidate(btn);
    cascade.flush();

    expect(title.colors.has("font_color")).toBe(true);
    expect(cascade.isDirty(btn)).toBe(false);
    expect(cascade.isDirty(title)).toBe(false);
  });
});

/* ================================================================== *
 * 十、内部通道一致性
 *
 * 内部只有两个写入方：toggled 信号（引擎先存 button_pressed 再发信号）与属性同步，
 * 二者必然一致 → 内部路径无竞态。被覆盖的只有「外部直接 setPseudoClass」那条路。
 * ================================================================== */

describe("属性驱动伪类的通道", () => {
  it("信号与属性同时到达（引擎真实顺序）→ 结果稳定、无返工", () => {
    cascade.addCss(`.cb:checked { color: rgb(0, 255, 255); }`);
    const cb = mount("CheckBox", ["cb"]);

    // 引擎顺序：button_pressed 先落，再 emit toggled(true) → binder 调 setPseudoClass
    cb.props.toggle_mode = true;
    cb.props.button_pressed = true;
    cascade.setPseudoClass(cb, "checked", true);
    cascade.invalidate(cb);
    cascade.flush();

    expect(cb.colors.has("font_pressed_color")).toBe(true);
    expect(cascade.isDirty(cb)).toBe(false); // 两条通道不打架
  });

  it("只调 setPseudoClass 不写属性 → 被属性同步清掉（记录在案的内部契约）", () => {
    cascade.addCss(`.cb:checked { color: rgb(0, 255, 255); }`);
    const cb = mount("CheckBox", ["cb"]);
    cb.props.toggle_mode = true; // 让“被清掉”只能归因于 button_pressed=false

    cascade.setPseudoClass(cb, "checked", true);
    cascade.invalidate(cb);
    cascade.flush();

    expect(cb.cssPseudoClasses?.has("checked")).toBe(false);
    expect(cb.colors.size).toBe(0);
  });
});
