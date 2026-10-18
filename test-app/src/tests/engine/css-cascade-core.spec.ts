import { beforeEach, describe, expect, it } from "vitest";
import {
  Cascade,
  SelectorTier,
  applyCssProperty,
  readStashedState,
  stashState,
  type CssNode,
  type CssWarnEntry,
  type FontSource,
  type StyleBackend,
  type StyleBoxHandle,
} from "godot-angular/css";

/** 记录所有写入的假 backend，每条写入都携带是哪个节点 */
class Recorder implements StyleBackend {
  /** 形如 `b|color:font_color` 的写入流水 */
  readonly writes: string[] = [];
  /** 形如 `b|color` 的撤销流水 */
  readonly clears: string[] = [];
  readonly warnings: string[] = [];

  private id(node: CssNode): string {
    return String((node as { name?: string }).name ?? "?");
  }
  private write(node: CssNode, what: string): void {
    this.writes.push(`${this.id(node)}|${what}`);
  }

  writesFor(name: string): string[] {
    const prefix = `${name}|`;
    return this.writes.filter((w) => w.startsWith(prefix)).map((w) => w.slice(prefix.length));
  }
  clearsFor(name: string): string[] {
    const prefix = `${name}|`;
    return this.clears.filter((w) => w.startsWith(prefix)).map((w) => w.slice(prefix.length));
  }
  reset(): void {
    this.writes.length = 0;
    this.clears.length = 0;
  }

  classOf(node: CssNode): string {
    return String(node.cssType ?? "Control");
  }
  bulk<T>(_node: CssNode, apply: () => T): T {
    this.writes.push("bulk:begin");
    try {
      return apply();
    } finally {
      this.writes.push("bulk:end");
    }
  }
  mutateStyleBox(node: CssNode, item: string, apply: (box: StyleBoxHandle) => void): void {
    apply({
      setBackground: (c) => this.write(node, `bg:${c ? `${c.r},${c.g},${c.b}` : "null"}`),
      setTexture: (path) => this.write(node, `texture:${path}`),
      setCornerRadii: (r) => this.write(node, `radius:${JSON.stringify(r)}`),
      setBorderWidths: (w) => this.write(node, `border:${JSON.stringify(w)}`),
      setBorderColor: (c) => this.write(node, `borderColor:${c ? `${c.r},${c.g},${c.b}` : "null"}`),
      setShadow: (s) => this.write(node, `shadow:${s.size}`),
      setContentMargin: (m) => this.write(node, `contentMargin:${JSON.stringify(m)}`),
    } as StyleBoxHandle);
  }
  setColorOverride(node: CssNode, item: string, color: { r: number }): void {
    this.write(node, `color:${item}:${color.r}`);
  }
  setFontSizeOverride(node: CssNode, item: string, size: number): void {
    this.write(node, `font_size:${item}:${size}`);
  }
  setConstantOverride(node: CssNode, item: string, value: number): void {
    this.write(node, `constant:${item}:${value}`);
  }
  setFontOverride(node: CssNode, item: string, source: FontSource): boolean {
    const what = "path" in source ? source.path : `sys:${source.systemFontNames.join("|")}`;
    this.write(node, `font:${item}:${what}`);
    return true;
  }
  setMinimumSize(node: CssNode, width: number | null, height: number | null): void {
    this.write(node, `min:${width ?? "-"}x${height ?? "-"}`);
  }
  setOpacity(node: CssNode, alpha: number): void {
    this.write(node, `opacity:${alpha}`);
  }
  setNodeNumber(node: CssNode, prop: string, value: number): void {
    this.write(node, `node:${prop}:${value}`);
  }
  getNodeNumber(): number {
    return 0;
  }
  setNodeBoolean(node: CssNode, prop: string, value: boolean): void {
    this.write(node, `node:${prop}:${value}`);
  }
  hasNodeProperty(node: CssNode, prop: string): boolean {
    // 级联用例只用到 Control 那几个通用属性 + BoxContainer 的 alignment
    const allowed = [
      "visible",
      "size_flags_horizontal",
      "size_flags_vertical",
      "size_flags_stretch_ratio",
      "alignment",
      "horizontal_alignment",
    ];
    return allowed.includes(prop);
  }
  parentOf(node: CssNode): CssNode | null {
    return (node.parent as CssNode) ?? null;
  }
  childrenOf(node: CssNode): CssNode[] {
    return ((node as { children?: CssNode[] }).children as CssNode[]) ?? [];
  }
  clearProperty(node: CssNode, cssName: string): void {
    this.clears.push(`${this.id(node)}|${cssName}`);
  }
  applyProperty(
    node: CssNode,
    cssName: string,
    raw: string,
    warnings: CssWarnEntry[],
    states: ReadonlySet<string>,
  ): boolean {
    // 使用真实的属性映射：假 backend 只替换“写入节点”那一步，CSS 名 → theme item 的映射必须为真
    return applyCssProperty(
      node,
      cssName,
      raw,
      { backend: this, warn: (key, message) => this.warnings.push(`${key}::${message}`), states },
      warnings,
    );
  }
}

/** 假节点：只需 CssNode 那几个字段 + children（backend.childrenOf 读取它） */
function mk(name: string, cssType = "Label", classes: string[] = []): CssNode {
  return { name, cssType, cssClasses: new Set(classes), children: [] as CssNode[] };
}

/**
 * 测试侧的 attach：将 `mk` 预填的 class 在 attach 之后补回去。
 *
 * `Cascade.attach` 不为调用方搬运 class（生产路径上节点都是先创建后 attach，无需搬运），
 * 而“先构造好带 class 的节点”是测试自身的写法，这一步属于测试。
 */
function attach(cascade: Cascade, ...nodes: CssNode[]): void {
  for (const node of nodes) {
    const keep = [...(node.cssClasses ?? [])];
    cascade.attach(node);
    for (const cls of keep) (node.cssClasses as Set<string>).add(cls);
  }
}

function add(parent: CssNode, child: CssNode): CssNode {
  (parent.children as CssNode[]).push(child);
  child.parent = parent;
  return child;
}

let backend: Recorder;
beforeEach(() => {
  backend = new Recorder();
});

function makeCascade(): Cascade {
  return new Cascade({ backend, warn: (w) => backend.warnings.push(`${w.code}::${w.message}`) });
}

describe("合并顺序 = 级联顺序（specificity | tier | pos）", () => {
  it("后者赢，且赢的那条会挪到级联顺序的末尾", () => {
    const cascade = makeCascade();
    cascade.addCss(`Label { color: rgb(1,1,1); font-size: 8px; } .a { color: rgb(2,2,2); }`);
    const node = mk("n", "Label", ["a"]);
    // 不重排的话 color 会停在 font-size 前面：Map.set 对已存在的键不会移动位置
    expect(cascade.matched(node).map((d) => `${d.property}:${d.value}`)).toEqual([
      "font-size:8px",
      "color:rgb(2,2,2)",
    ]);
  });

  it("特异度压过源码顺序", () => {
    const cascade = makeCascade();
    cascade.addCss(`.a { color: rgb(255,0,0); } #only { color: rgb(0,0,255); }`);
    const node = mk("n", "Label", ["a"]);
    node.id = "only";
    expect(cascade.matched(node).find((d) => d.property === "color")?.value).toBe("rgb(0,0,255)");
  });

  it("特异度相同时组件样式压过全局样式（tier），与源码顺序无关", () => {
    const cascade = makeCascade();
    // 故意先登记组件样式：如果按登记顺序判定胜负，这条会失败
    cascade.addCss(".b { color: rgb(0,0,255); }", { tier: SelectorTier.Local });
    cascade.addCss(".a { color: rgb(255,0,0); }", { tier: SelectorTier.Application });
    const node = mk("n", "Label", ["a", "b"]);
    expect(cascade.matched(node).find((d) => d.property === "color")?.value).toBe("rgb(0,0,255)");
  });

  it("同特异度同 tier 时源码顺序决定胜负", () => {
    const cascade = makeCascade();
    cascade.addCss(`.a { color: rgb(255,0,0); } .b { color: rgb(0,0,255); }`);
    expect(
      cascade.matched(mk("n", "Label", ["a", "b"])).find((d) => d.property === "color")?.value,
    ).toBe("rgb(0,0,255)");
  });

  it("!important 压过特异度，也压过内联", () => {
    const cascade = makeCascade();
    cascade.addCss(`#hi { color: rgb(0,0,255); } .lo { color: rgb(255,0,0) !important; }`);
    const node = mk("n", "Label", ["lo"]);
    node.id = "hi";
    attach(cascade, node);
    cascade.setInline(node, "color", "rgb(0,255,0)");
    cascade.flush();
    expect(backend.writesFor("n")).toContain("color:font_color:1");
    // 解析期已将 `!important` 剔除（它不是值的一部分，而是声明的标志），
    // 因此此处比对的是纯值；important 本身由 ruleset 传递下来
    expect(cascade.matched(node).find((d) => d.property === "color")?.value).toBe("rgb(255,0,0)");
  });

  it("内联压过样式表的普通声明", () => {
    const cascade = makeCascade();
    cascade.addCss(".a { color: rgb(255,0,0); }");
    const node = mk("n", "Label", ["a"]);
    attach(cascade, node);
    cascade.setInline(node, "color", "rgb(0,0,255)");
    cascade.flush();
    expect(backend.writesFor("n")).toContain("color:font_color:0");
  });

  it("@media 不满足时规则不参与合并", () => {
    const cascade = new Cascade({ backend, env: { width: 400 } });
    cascade.addCss(`@media (min-width: 600px) { .a { color: rgb(255,0,0); } } .a { font-size: 9px; }`);
    const node = mk("n", "Label", ["a"]);
    expect(cascade.matched(node).map((d) => d.property)).toEqual(["font-size"]);
    cascade.setEnv({ width: 800 });
    expect(cascade.matched(node).map((d) => d.property)).toContain("color");
  });
});

describe("diff：只写真变了的", () => {
  it("值没变时一次都不写", () => {
    const cascade = makeCascade();
    cascade.addCss(".a { color: rgb(255,0,0); }");
    const node = mk("n", "Label", ["a"]);
    attach(cascade, node);
    cascade.flush();
    expect(backend.writesFor("n")).toContain("color:font_color:1");

    backend.reset();
    cascade.invalidate(node);
    cascade.flush();
    expect(backend.writes).toEqual([]);
    expect(cascade.stats.skipped).toBeGreaterThan(0);
  });

  it("值变了才重写，且新值写入", () => {
    const cascade = makeCascade();
    cascade.addCss(".a { color: rgb(255,0,0); }");
    const node = mk("n", "Label", ["a"]);
    attach(cascade, node);
    cascade.flush();
    backend.reset();
    cascade.setInline(node, "color", "rgb(0,0,255)");
    cascade.flush();
    expect(backend.writesFor("n")).toEqual(["color:font_color:0"]);
  });

  it("写入包在 bulk 里（一次 apply 一对 begin/end）", () => {
    const cascade = makeCascade();
    cascade.addCss(".a { color: rgb(255,0,0); font-size: 12px; opacity: 0.5; }");
    const node = mk("n", "Label", ["a"]);
    attach(cascade, node);
    cascade.flush();
    expect(backend.writes[0]).toBe("bulk:begin");
    expect(backend.writes[backend.writes.length - 1]).toBe("bulk:end");
    expect(backend.writes.filter((w) => w === "bulk:begin")).toHaveLength(1);
  });
});

describe("精确撤除：只动 ledger 记过的", () => {
  it("移除 class 后，只撤不再被认领的那条", () => {
    const cascade = makeCascade();
    cascade.addCss(`.a { color: rgb(255,0,0); } .b { background-color: rgb(0,0,255); }`);
    const node = mk("n", "Label", ["a", "b"]);
    attach(cascade, node);
    cascade.flush();
    expect(cascade.stateOf(node)?.applied.size).toBe(2);

    backend.reset();
    (node.cssClasses as Set<string>).delete("b");
    cascade.flush();

    expect(backend.clearsFor("n")).toEqual(["background-color"]);
    expect(cascade.stateOf(node)?.applied.has("color")).toBe(true);
    expect(cascade.stateOf(node)?.applied.has("background-color")).toBe(false);
  });

  it("被更高特异度接管时是重写而不是先撤再写", () => {
    const cascade = makeCascade();
    cascade.addCss(`.a { color: rgb(255,0,0); } .a.hi { color: rgb(0,0,255); }`);
    const node = mk("n", "Label", ["a"]);
    attach(cascade, node);
    cascade.flush();
    backend.reset();
    (node.cssClasses as Set<string>).add("hi");
    cascade.flush();
    expect(backend.clearsFor("n")).toEqual([]);
    expect(backend.writesFor("n")).toEqual(["color:font_color:0"]);
  });

  it("撤掉整张样式表后，它写过的全部被撤", () => {
    const cascade = makeCascade();
    const handle = cascade.addCss(".a { color: rgb(255,0,0); font-size: 12px; }");
    const node = mk("n", "Label", ["a"]);
    attach(cascade, node);
    cascade.flush();
    backend.reset();
    cascade.removeSheet(handle);
    cascade.flush();
    expect(backend.clearsFor("n").sort()).toEqual(["color", "font-size"]);
    expect(cascade.stateOf(node)?.applied.size).toBe(0);
  });

  it("retire（出树）保留账本：重新入树后能把不再命中的那条撤掉", () => {
    const cascade = makeCascade();
    cascade.addCss(".yes .leaf { color: rgb(255,0,0); }");
    const yes = mk("yes", "VBoxContainer", ["yes"]);
    const no = mk("no", "VBoxContainer", ["no"]);
    const leaf = add(yes, mk("leaf", "Label", ["leaf"]));
    attach(cascade, yes, no, leaf);
    cascade.flush();
    expect(backend.writesFor("leaf").length).toBeGreaterThan(0);
    backend.reset();

    // 出树 → 换父 → 重新入树（reparent / ngFor 移动就是这个序列）
    cascade.retire(leaf);
    (yes.children as CssNode[]).splice(0, 1);
    add(no, leaf);
    attach(cascade, leaf);
    cascade.flush();

    // 账本被清除的话，此处一条也不会撤销（引擎中就是“颜色残留不去”）
    expect(backend.clearsFor("leaf")).toEqual(["color"]);
  });

  it("removeSheet 收到无效序号时不触发全量重算", () => {
    const cascade = makeCascade();
    cascade.addCss(".a { color: rgb(255,0,0); }");
    const node = mk("n", "Label", ["a"]);
    attach(cascade, node);
    cascade.flush();
    const flushes = cascade.stats.flushes;
    cascade.removeSheet(99);
    expect(cascade.isDirty(node)).toBe(false);
    expect(cascade.flush()).toBe(0);
    expect(cascade.stats.flushes).toBe(flushes);
  });

  it("detach 之后节点不再参与重算", () => {
    const cascade = makeCascade();
    cascade.addCss(".a { color: rgb(255,0,0); }");
    const node = mk("n", "Label", ["a"]);
    attach(cascade, node);
    cascade.flush();
    cascade.detach(node);
    backend.reset();
    (node.cssClasses as Set<string>).add("zzz");
    cascade.flush();
    expect(backend.writes).toEqual([]);
  });
});

describe("定向失效（changeMap + 子树/兄弟门控）", () => {
  it("class 变化只牵连子树，无关节点不产生失效记录", () => {
    const cascade = makeCascade();
    cascade.addCss(`.card .title { color: rgb(255,0,0); }`);
    const root = mk("root", "VBoxContainer");
    const card = add(root, mk("card", "PanelContainer", ["card"]));
    const title = add(card, mk("title", "Label", ["title"]));
    const other = add(root, mk("other", "Label", ["title"]));
    for (const n of [root, card, title, other]) attach(cascade, n);
    cascade.flush();
    backend.reset();

    (card.cssClasses as Set<string>).add("selected");
    expect(cascade.isDirty(title)).toBe(true);
    expect(cascade.isDirty(other)).toBe(false);
  });

  it("样式表没用组合器时，class 变化不牵连兄弟", () => {
    const cascade = makeCascade();
    cascade.addCss(`.a { color: rgb(255,0,0); }`);
    const root = mk("root", "VBoxContainer");
    const a = add(root, mk("a", "Label", ["a"]));
    const b = add(root, mk("b", "Label"));
    attach(cascade, a, b);
    cascade.flush();
    (a.cssClasses as Set<string>).add("more");
    expect(cascade.isDirty(b)).toBe(false);
  });

  it("用了 + 组合器时兄弟才被牵连", () => {
    const cascade = makeCascade();
    cascade.addCss(`.a + Label { color: rgb(255,0,0); }`);
    const root = mk("root", "VBoxContainer");
    const a = add(root, mk("a", "Label", ["a"]));
    const b = add(root, mk("b", "Label"));
    attach(cascade, a, b);
    cascade.flush();
    (a.cssClasses as Set<string>).add("more");
    expect(cascade.isDirty(b)).toBe(true);
  });

  it("伪类依赖被记进 changeMap（hover 打开才重算后代）", () => {
    const cascade = makeCascade();
    cascade.addCss(`.card:hover .title { color: rgb(255,0,0); }`);
    const card = mk("card", "PanelContainer", ["card"]);
    const title = add(card, mk("title", "Label", ["title"]));
    attach(cascade, card, title);
    cascade.flush();
    expect(backend.writesFor("title")).toEqual([]);

    cascade.setPseudoClass(card, "hover", true);
    cascade.flush();
    expect(backend.writesFor("title")).toContain("color:font_color:1");
    expect(cascade.dependentsOf(card)).toContain(title);

    cascade.setPseudoClass(card, "hover", false);
    cascade.flush();
    expect(backend.clearsFor("title")).toEqual(["color"]);
  });

  it("帧末批量：一轮里改三次只 apply 一次", () => {
    let scheduled = 0;
    let pending: (() => void) | null = null;
    const cascade = new Cascade({
      backend,
      schedule: (flush) => {
        scheduled++;
        pending = flush;
      },
    });
    cascade.addCss(`.a { color: rgb(255,0,0); } .b { font-size: 12px; }`);
    const node = mk("n", "Label");
    cascade.attach(node);
    const classes = node.cssClasses as Set<string>;
    classes.add("a");
    classes.add("b");
    classes.delete("a");
    expect(scheduled).toBe(1);
    expect(backend.writes).toEqual([]); // 还没 flush
    (pending as unknown as () => void)();
    expect(backend.writesFor("n")).toEqual(["font_size:font_size:12"]);
  });
});

describe("attach 与内联", () => {
  it("attach 装上会通知的 class 集合：改它不需要再手动 invalidate", () => {
    const cascade = makeCascade();
    const node = mk("n", "Label");
    cascade.attach(node);
    // 将普通 Set 替换为会通知的版本：修改它无需再手动 invalidate
    cascade.addCss(".later { color: rgb(255,0,0); }");
    (node.cssClasses as Set<string>).add("later");
    cascade.flush();
    expect(backend.writesFor("n")).toContain("color:font_color:1");
  });

  it("attach 不搬调用方预填的 class：class 必须 attach 之后写", () => {
    const cascade = makeCascade();
    const node = mk("n", "Label", ["pre"]);
    cascade.attach(node);
    expect([...(node.cssClasses as Set<string>)]).toEqual([]);
  });

  it("removeInline 之后样式表的值重新生效", () => {
    const cascade = makeCascade();
    cascade.addCss(".a { color: rgb(255,0,0); }");
    const node = mk("n", "Label", ["a"]);
    attach(cascade, node);
    cascade.setInline(node, "color", "rgb(0,0,255)");
    cascade.flush();
    backend.reset();
    cascade.removeInline(node, "color");
    cascade.flush();
    expect(backend.writesFor("n")).toEqual(["color:font_color:1"]);
  });

  it("未知属性告警一次，不写节点", () => {
    const cascade = makeCascade();
    cascade.addCss(".a { not-a-real-property: 3px; }");
    const node = mk("n", "Label", ["a"]);
    attach(cascade, node);
    cascade.flush();
    expect(backend.writesFor("n")).toEqual([]);
    expect(backend.warnings.join("\n")).toContain("not-a-real-property");
  });

  it("自定义属性 --x 不参与应用", () => {
    const cascade = makeCascade();
    cascade.addCss(`:root { --brand: rgb(1,2,3); } .a { color: rgb(255,0,0); }`);
    const node = mk("n", "Label", ["a"]);
    attach(cascade, node);
    cascade.flush();
    expect(cascade.matched(node).map((d) => d.property)).toEqual(["color"]);
  });
});

/**
 * 变量写在 shorthand 里：`padding: var(--p)` 在解析期就展开为 4 条 longhand，
 * 各自持有同一个 var()；变量要到写入前才展开，因此“变量变了”必须能同时把这 4 条重新取回。
 */
describe("变量写在 shorthand 里", () => {
  // `padding: var(--p)` 在解析期就展开成 4 条 longhand，各自持着同一个 var()；
  // 变量要到写入前才展开，因此“变量变了”必须能同时将这 4 条重新取回。
  it("祖先改变量：展开出的 4 条 longhand 一起重写", () => {
    const cascade = makeCascade();
    const root = mk("root", "VBoxContainer", ["slow"]);
    const child = add(root, mk("child", "Label", ["box"]));
    cascade.addCss(`.slow { --p: 4px; } .fast { --p: 8px; }`);
    cascade.addCss(`.box { padding: var(--p); }`);
    attach(cascade, root, child);
    cascade.flush();

    const margins = () => backend.writesFor("child").filter((w) => w.startsWith("contentMargin"));
    expect(margins().length).toBe(4);
    expect(margins().join(" ")).toContain("4");

    backend.reset();
    (root.cssClasses as Set<string>).delete("slow");
    (root.cssClasses as Set<string>).add("fast");
    cascade.flush();
    expect(margins().length).toBe(4);
    expect(margins().join(" ")).toContain("8");
  });

  it("变量取不到又没写 fallback：4 条一起不写入，并逐条告警", () => {
    const cascade = makeCascade();
    const node = mk("n", "Label", ["box"]);
    cascade.addCss(`.box { padding: var(--nope); }`);
    attach(cascade, node);
    cascade.flush();

    expect(backend.writesFor("n").filter((w) => w.startsWith("contentMargin"))).toEqual([]);
    expect(backend.warnings.filter((w) => w.includes("--nope")).length).toBe(4);
  });

  it("变量没变：重新匹配一次不重写", () => {
    const cascade = makeCascade();
    const root = mk("root", "VBoxContainer", ["slow"]);
    const child = add(root, mk("child", "Label", ["box"]));
    cascade.addCss(`.slow { --p: 4px; } .box { padding: var(--p); }`);
    attach(cascade, root, child);
    cascade.flush();
    backend.reset();

    cascade.invalidateTree(root);
    cascade.flush();
    expect(backend.writesFor("child")).toEqual([]);
  });
});

/**
 * 元素选择器拼写 Godot 类名——静默零命中时唯一的提示渠道。
 *
 * 检查位于 buildRuleSets：那里选择器原文与告警通道都是现成的，而且一次覆盖组件 CSS
 * 与全局 CSS（构建期若各写一份，两份会漂移）。
 */
describe("元素选择器必须是已知 Godot 类名", () => {
  function warningsOf(css: string): string[] {
    const backend = new Recorder();
    new Cascade({ backend, warn: (w) => backend.warnings.push(`${w.code}::${w.message}`) }).addCss(css);
    return backend.warnings;
  }

  it("拼错的类名要报，且指名是哪个词", () => {
    expect(warningsOf("Buton { color: red }").join("\n")).toContain("Buton");
  });

  it("大小写不敏感（Godot 类名首字母大写，但写小写也算认识）", () => {
    expect(warningsOf("button { color: red }")).toEqual([]);
    expect(warningsOf("Button { color: red }")).toEqual([]);
  });

  it("只查开头的元素名，类/伪类/通配一律放过", () => {
    expect(warningsOf(".my-card > Label { color: red }")).toEqual([]);
    expect(warningsOf(".y, *:hover { color: red }")).toEqual([]);
  });

  it("#id 能解析但在 Godot 没有对应实现，要单独报一次", () => {
    const text = warningsOf("#x, .y { color: red }").join("\n");
    expect(text).toContain("#id");
    // 与元素名拼错无关，不串成另一条告警
    expect(text).not.toContain("不是已知的 Godot 类名");
    // 写在后面也要抓到；属性值里的 # 不算
    expect(warningsOf("Label.x#y { color: red }").join("\n")).toContain("#id");
    expect(warningsOf('Label[title="#x"] { color: red }')).toEqual([]);
  });

  it("组件作用域标记不影响判断（scope 是追加在元素名后面的）", () => {
    const warnings = warningsOf("Buton[_ngcontent-c1] { color: red }");
    expect(warnings.join("\n")).toContain("Buton");
    expect(warningsOf("Label[_ngcontent-c1] { color: red }")).toEqual([]);
  });

  it("一条表里多个错词各报一次，带行号", () => {
    const warnings = warningsOf("Buton { color: red }\nLable { color: blue }");
    expect(warnings.filter((w) => w.includes("Buton")).length).toBe(1);
    expect(warnings.filter((w) => w.includes("Lable")).length).toBe(1);
    expect(warnings.join("\n")).toMatch(/第 1 行/);
    expect(warnings.join("\n")).toMatch(/第 2 行/);
  });
});

describe("标脏的边界：没变就不许标脏", () => {
  it("内联样式重复写同一个值不标脏（Angular 每轮变更检测都会重递）", () => {
    const cascade = makeCascade();
    cascade.addCss(`Label { color: rgb(0,0,0); }`);
    const node = mk("n", "Label");
    attach(cascade, node);
    cascade.applyNow(node);

    cascade.setInline(node, "color", "rgb(1,0,0)");
    expect(cascade.isDirty(node)).toBe(true);
    cascade.applyNow(node);
    expect(cascade.isDirty(node)).toBe(false);

    cascade.setInline(node, "color", "rgb(1,0,0)");
    expect(cascade.isDirty(node)).toBe(false);

    cascade.setInline(node, "color", "rgb(0,1,0)");
    expect(cascade.isDirty(node)).toBe(true);
  });

  it("撤一条没写过的内联 / 清空一个空的内联表：都不标脏", () => {
    const cascade = makeCascade();
    const node = mk("n", "Label");
    attach(cascade, node);
    cascade.applyNow(node);

    cascade.removeInline(node, "color");
    expect(cascade.isDirty(node)).toBe(false);
    cascade.clearInline(node);
    expect(cascade.isDirty(node)).toBe(false);

    cascade.setInline(node, "color", "rgb(1,0,0)");
    cascade.applyNow(node);
    cascade.clearInline(node);
    expect(cascade.isDirty(node)).toBe(true);
  });

  it("invalidateAll 把登记过的节点全标脏", () => {
    const cascade = makeCascade();
    cascade.addCss(`Label { color: rgb(0,0,0); }`);
    const a = mk("a", "Label");
    const b = mk("b", "Label");
    attach(cascade, a, b);
    cascade.applyNow(a);
    cascade.applyNow(b);
    expect(cascade.isDirty(a)).toBe(false);

    cascade.invalidateAll();
    expect(cascade.isDirty(a)).toBe(true);
    expect(cascade.isDirty(b)).toBe(true);
  });

  it("伪类开关：节点还没挂上时不炸；已有的普通 Set 会被换成会通知的并保留原值", () => {
    const cascade = makeCascade();
    expect(() => cascade.setPseudoClass(null as never, "hover", true)).not.toThrow();

    const node = mk("n", "Button");
    // 普通 Set（尚未被 attach 替换为 TrackingClassSet）
    node.cssPseudoClasses = new Set(["focus"]);
    cascade.setPseudoClass(node, "hover", true);
    expect([...(node.cssPseudoClasses ?? [])].sort()).toEqual(["focus", "hover"]);
    // 替换为会通知的集合后，重复设置同一状态不再标脏
    cascade.attach(node);
    cascade.applyNow(node);
    cascade.setPseudoClass(node, "hover", true);
    expect(cascade.isDirty(node)).toBe(false);
    cascade.setPseudoClass(node, "hover", false);
    expect(cascade.isDirty(node)).toBe(true);
  });

  it("状态兜底通道：包装对象身份不稳时能从节点本体拿回同一份", () => {
    const cascade = makeCascade();
    const node = mk("n", "Label");
    cascade.attach(node);
    const state = cascade.stateOf(node);
    expect(state).toBeDefined();
    stashState(node, state!);
    expect(readStashedState(node)).toBe(state);
  });
});

describe("matchedSelectors（「这条样式为什么没生效」的第一站）", () => {
  it("按级联顺序给出命中的选择器原文", () => {
    const cascade = makeCascade();
    cascade.addCss(`Label { color: rgb(1,1,1); } .a { color: rgb(2,2,2); } #n { color: rgb(3,3,3); }`);
    const node = mk("n", "Label", ["a"]);
    node.id = "n";
    // 元素选择器统一按小写还原（引擎类名比较时不区分大小写）
    expect(cascade.matchedSelectors(node)).toEqual(["label", ".a", "#n"]);
  });

  it("没命中就是空数组；媒体段没命中也不算命中", () => {
    const cascade = makeCascade();
    cascade.addCss(`@media (min-width: 600px) { .a { color: rgb(1,1,1); } } .zzz { color: red; }`);
    const node = mk("n", "Label", ["a"]);
    expect(cascade.matchedSelectors(node)).toEqual([]);
    cascade.setEnv({ width: 800 });
    expect(cascade.matchedSelectors(node)).toEqual([".a"]);
  });
});

