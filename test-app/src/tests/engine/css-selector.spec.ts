import { describe, expect, it } from "vitest";
import type { CssNode } from "godot-angular/css";
import {
  CssCode,
  InvalidSelector,
  SelectorsMatch,
  SelectorTier,
  SimpleSelector,
  Specificity,
  StyleSheetIndex,
  buildRuleSets,
  collectPseudoClasses,
  compareSelectors,
  createSelector,
} from "godot-angular/css";

/** 构造一个满足 CssNode 的假节点（无 DOM、无引擎） */
function fakeNode(
  init: {
    type?: string;
    id?: string;
    classes?: string[];
    pseudo?: string[];
    attrs?: Record<string, string>;
    parent?: CssNode | null;
  } = {},
): CssNode {
  const node: CssNode = { parent: init.parent ?? null };
  if (init.type) node.cssType = init.type;
  if (init.id) node.id = init.id;
  if (init.classes) node.cssClasses = new Set(init.classes);
  if (init.pseudo) node.cssPseudoClasses = new Set(init.pseudo);
  if (init.attrs) Object.assign(node, init.attrs);
  return node;
}

const NO_ENV = { width: 800, height: 600, "prefers-color-scheme": "light" };

describe("选择器解析与特异度", () => {
  const table: Array<[string, number]> = [
    [".a", Specificity.Class],
    ["#a", Specificity.Id],
    ["a", Specificity.Type],
    ["a.b", Specificity.Type + Specificity.Class],
    ["a:hover", Specificity.Type + Specificity.PseudoClass],
    ["*", Specificity.Universal],
    ["Button.big:hover", Specificity.Type + Specificity.Class + Specificity.PseudoClass],
    ["Card > Label", Specificity.Type + Specificity.Type],
    ["[a]", Specificity.Attribute],
    ["#a.b.c", Specificity.Id + 2 * Specificity.Class],
  ];
  for (const [selector, expected] of table) {
    it(`特异度 ${selector} = ${expected}`, () => {
      expect(createSelector(selector).specificity).toBe(expected);
    });
  }

  it("内联样式的特异度是 1000，压过一切选择器", () => {
    // 内联不是解析得出的，而是级联层直接给出的常量（口径：override = 内联 style）
    expect(Specificity.Inline).toBe(1000);
    expect(Specificity.Inline).toBeGreaterThan(Specificity.Id);
  });

  it(":is / :not 取参数里最高的特异度，:where 恒为 0", () => {
    expect(createSelector(":is(.a, #b)").specificity).toBe(Specificity.Id);
    expect(createSelector(":not(.a)").specificity).toBe(Specificity.Class);
    expect(createSelector(":where(#b)").specificity).toBe(Specificity.Universal);
  });
});

describe("选择器匹配", () => {
  it("元素选择器大小写不敏感（button 与 Button 都指 Godot 的 Button）", () => {
    const node = fakeNode({ type: "Button" });
    expect(createSelector("button").match(node)).toBe(true);
    expect(createSelector("Button").match(node)).toBe(true);
    expect(createSelector("Label").match(node)).toBe(false);
  });

  it("class / id / 伪类", () => {
    const node = fakeNode({ classes: ["a", "b"], pseudo: ["hover"], id: "x" });
    expect(createSelector(".a").match(node)).toBe(true);
    expect(createSelector(".a.b").match(node)).toBe(true);
    expect(createSelector(".c").match(node)).toBe(false);
    expect(createSelector("#x").match(node)).toBe(true);
    expect(createSelector(":hover").match(node)).toBe(true);
    expect(createSelector(":active").match(node)).toBe(false);
  });

  it("属性选择器：存在 / 相等 / 前缀 / 词", () => {
    const node = fakeNode({ attrs: { _ngcontent_c1: "", title: "hello world", lang: "en-US" } });
    expect(createSelector("[_ngcontent_c1]").match(node)).toBe(true);
    expect(createSelector("[_ngcontent_c2]").match(node)).toBe(false);
    expect(createSelector('[title="hello world"]').match(node)).toBe(true);
    expect(createSelector('[title^="hell"]').match(node)).toBe(true);
    expect(createSelector('[title~="world"]').match(node)).toBe(true);
    expect(createSelector('[lang|="en"]').match(node)).toBe(true);
  });

  it("组合器：后代 / 子 / 相邻 / 兄弟", () => {
    const root = fakeNode({ type: "VBoxContainer" });
    const card = fakeNode({ type: "PanelContainer", parent: root, classes: ["card"] });
    const label = fakeNode({ type: "Label", parent: card, classes: ["title"] });
    const other = fakeNode({ type: "Label", parent: card, classes: ["body"] });
    // 兄弟组合器须由父节点暴露 getChildIndex/getChildAt/getChildrenCount
    const children = [label, other];
    Object.assign(card, {
      getChildIndex: (n: CssNode) => children.indexOf(n),
      getChildAt: (i: number) => children[i],
      getChildrenCount: () => children.length,
    });

    expect(createSelector("VBoxContainer Label").match(label)).toBe(true);
    expect(createSelector("PanelContainer > Label").match(label)).toBe(true);
    expect(createSelector("VBoxContainer > Label").match(label)).toBe(false);
    expect(createSelector(".card .title").match(label)).toBe(true);
    expect(createSelector(".title + .body").match(other)).toBe(true);
    expect(createSelector(".body + .title").match(label)).toBe(false);
    expect(createSelector(".title ~ .body").match(other)).toBe(true);
  });

  it("无法获取兄弟节点信息时，兄弟组合器判定为不匹配而非抛出异常", () => {
    const parent = fakeNode({ type: "HBoxContainer" });
    const node = fakeNode({ type: "Label", parent, classes: ["b"] });
    expect(() => createSelector(".a + .b").match(node)).not.toThrow();
    expect(createSelector(".a + .b").match(node)).toBe(false);
  });

  it(":not / :is / :where", () => {
    const a = fakeNode({ type: "Label", classes: ["x"] });
    const b = fakeNode({ type: "Label" });
    expect(createSelector("Label:not(.x)").match(a)).toBe(false);
    expect(createSelector("Label:not(.x)").match(b)).toBe(true);
    expect(createSelector(":is(.x, .y)").match(a)).toBe(true);
    expect(createSelector(":where(.x)").match(a)).toBe(true);
  });

  it("不支持的伪类 / 伪元素 / :nth-child → InvalidSelector，且说明原因", () => {
    const warnings: string[] = [];
    const warn = (_code: CssCode, message: string) => warnings.push(message);
    expect(createSelector("Label:has(.x)", warn)).toBeInstanceOf(InvalidSelector);
    expect(createSelector("Label:nth-child(2)", warn)).toBeInstanceOf(InvalidSelector);
    expect(createSelector("Label::before", warn)).toBeInstanceOf(InvalidSelector);
    // 白名单外的伪类走 warn；语法级错误（伪元素）直接携带在 InvalidSelector.error 上，
    // 由 buildRuleSets 统一报出——两条路径都必须能让人看到原因
    expect(warnings.length).toBe(2);
    expect((createSelector("Label::before") as InvalidSelector).error?.message).toContain("::before");
    expect((createSelector("Label:nth-child(2)") as InvalidSelector).error?.message).toContain("nth-child");
    // 伪元素名称长度不固定，告警中必须出现完整名称，不得仅截取一部分
    expect((createSelector("Button::selection") as InvalidSelector).error?.message).toContain(
      "::selection",
    );
    expect((createSelector("Button::file-selector-button") as InvalidSelector).error?.message).toContain(
      "::file-selector-button",
    );
    // `::` 之后完全没有名称时，需说明是名称缺失，而非报出一个空名称
    expect((createSelector("Button::") as InvalidSelector).error?.message).toContain("伪元素缺少名称");
  });

  it("语法错误不抛异常", () => {
    for (const text of ["", ">", "##a", "a..b", "[a", ":is(", "a b >", "\u{1F44D}"]) {
      expect(() => createSelector(text)).not.toThrow();
    }
  });
});

describe("级联排序", () => {
  it("同特异度：组件样式（Local）压全局（Application）", () => {
    const global = createSelector(".a");
    const local = createSelector(".b");
    global.tier = SelectorTier.Application;
    local.tier = SelectorTier.Local;
    global.pos = 0;
    local.pos = 99;
    expect(compareSelectors(global, local)).toBeLessThan(0);
  });

  it("同特异度同层级：源码顺序在后的赢", () => {
    const first = createSelector(".a");
    const second = createSelector(".b");
    first.pos = 0;
    second.pos = 1;
    expect(compareSelectors(first, second)).toBeLessThan(0);
  });

  it("特异度永远优先于层级与顺序", () => {
    const id = createSelector("#x");
    const cls = createSelector(".y");
    id.tier = SelectorTier.Application;
    id.pos = 0;
    cls.tier = SelectorTier.Local;
    cls.pos = 100;
    expect(compareSelectors(id, cls)).toBeGreaterThan(0);
  });

  it("命中的选择器按 specificity || tier || pos 升序排（后者覆盖前者）", () => {
    const css = `
      Label { color: black; }
      .c { color: blue; }
      Label.c { color: green; }
      #i { color: red; }
    `;
    const { ruleSets } = buildRuleSets(css);
    const index = new StyleSheetIndex(ruleSets);
    const node = fakeNode({ type: "Label", classes: ["c"], id: "i" });
    const match = index.query(node, NO_ENV);
    const specificities = match.selectors.map((s) => s.specificity);
    expect(specificities).toEqual([...specificities].sort((a, b) => a - b));
    expect(specificities[specificities.length - 1]).toBe(Specificity.Id);
  });
});

describe("四桶索引 == 全表暴力扫描", () => {
  /** 确定性伪随机（不使用 Math.random，测试需要可复现） */
  function makeRandom(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  const TYPES = ["Button", "Label", "PanelContainer", "LineEdit", "VBoxContainer"];
  const CLASSES = ["a", "b", "c", "d", "e"];
  const IDS = ["x", "y", "z"];
  const PSEUDOS = ["hover", "focus", "active", "checked"];
  const ATTRS = ["_ngcontent_c1", "_ngcontent_c2", "disabled"];

  it("200 条规则 × 50 个节点，两条路径给出的命中集合完全一致", () => {
    const random = makeRandom(20240607);
    const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)];

    const ruleTexts: string[] = [];
    for (let i = 0; i < 200; i++) {
      const parts: string[] = [];
      const simpleCount = 1 + Math.floor(random() * 3);
      for (let j = 0; j < simpleCount; j++) {
        const roll = random();
        if (roll < 0.25) parts.push(pick(TYPES));
        else if (roll < 0.6) parts.push(`.${pick(CLASSES)}`);
        else if (roll < 0.7) parts.push(`#${pick(IDS)}`);
        else if (roll < 0.82) parts.push(`:${pick(PSEUDOS)}`);
        else if (roll < 0.92) parts.push(`[${pick(ATTRS)}]`);
        else parts.push("*");
      }
      let selector = parts.shift() as string;
      const extra = Math.floor(random() * 2);
      for (let k = 0; k < extra; k++) {
        const combinator = random() < 0.5 ? " " : " > ";
        const next = parts.length ? (parts.shift() as string) : `.${pick(CLASSES)}`;
        selector += `${combinator}${next}`;
      }
      ruleTexts.push(selector);
    }

    const { ruleSets } = buildRuleSets(ruleTexts.map((s) => `${s}{color:red}`).join("\n"));
    expect(ruleSets.length).toBeGreaterThan(100);
    const index = new StyleSheetIndex(ruleSets);
    const allSelectors = ruleSets.flatMap((ruleSet) => ruleSet.selectors);

    const keyOf = (list: typeof allSelectors) =>
      [...list].sort(compareSelectors).map((s) => String(s)).join("|");

    for (let n = 0; n < 50; n++) {
      const parent = fakeNode({
        type: pick(TYPES),
        classes: CLASSES.filter(() => random() < 0.4),
        attrs: Object.fromEntries(ATTRS.filter(() => random() < 0.3).map((a) => [a, ""])),
      });
      const node = fakeNode({
        type: pick(TYPES),
        id: random() < 0.3 ? pick(IDS) : undefined,
        classes: CLASSES.filter(() => random() < 0.4),
        pseudo: PSEUDOS.filter(() => random() < 0.3),
        attrs: Object.fromEntries(ATTRS.filter(() => random() < 0.3).map((a) => [a, ""])),
        parent,
      });

      const indexed = index.query(node, NO_ENV).selectors;
      // 全表也走 accumulateChanges：动态选择器（伪类/属性）在索引路径里返回的是
      // “可能匹配”，两边必须同一口径，否则对拍本身就是在比较两个不同的东西。
      const brute = allSelectors.filter((selector) => selector.accumulateChanges(node, new SelectorsMatch()));
      expect(keyOf(indexed), `节点 ${String(node.cssType)} [${[...(node.cssClasses ?? [])].join(",")}]`).toBe(keyOf(brute));
    }
  });
});

describe("规则集构建", () => {
  it("一条规则里所有选择器都无效 → 整条被丢，不会命中一切", () => {
    const { ruleSets, warnings } = buildRuleSets("Label:has(.x) { color: red }");
    expect(ruleSets).toHaveLength(0);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("声明在解析期就展开成 longhand", () => {
    const { ruleSets } = buildRuleSets("Label { margin: 1px 2px }");
    expect(ruleSets[0].declarations.map((d) => d.property)).toEqual([
      "margin-top",
      "margin-right",
      "margin-bottom",
      "margin-left",
    ]);
  });

  it("空声明块不产生规则集", () => {
    expect(buildRuleSets("Label { }").ruleSets).toHaveLength(0);
  });

  it("RuleSet 带着所在 @media 的原文", () => {
    const { ruleSets } = buildRuleSets("@media (min-width: 100px) { Label { color: red } }");
    expect(ruleSets[0].mediaQueryString).toBe("(min-width: 100px)");
  });
});

describe("媒体查询下的索引", () => {
  it("命中的媒体查询段才贡献候选，且源码顺序跨段仍然成立", () => {
    const { ruleSets } = buildRuleSets(`
      Label { color: black; }
      @media (min-width: 500px) { Label { color: blue; } }
      Label { color: green; }
    `);
    const index = new StyleSheetIndex(ruleSets);
    const node = fakeNode({ type: "Label" });

    const wide = index.query(node, { width: 600 }).selectors.map((s) => s.pos);
    expect(wide).toEqual([...wide].sort((a, b) => a - b));
    expect(wide).toHaveLength(3);

    expect(index.query(node, { width: 400 }).selectors).toHaveLength(2);
  });
});

describe("失效依赖追踪（changeMap）", () => {
  /**
   * 用一条规则匹配一个节点，返回被记为依赖的节点清单。
   * 空声明块的规则会被 buildRuleSets 丢弃，因此此处统一补上声明体。
   */
  function depsOf(rule: string, subject: CssNode): CssNode[] {
    const css = rule.includes("{") ? rule : `${rule} { color: red; }`;
    const { ruleSets } = buildRuleSets(css);
    return [...new StyleSheetIndex(ruleSets).query(subject, NO_ENV).changeMap.keys()];
  }

  it("组合选择器把依赖记在**带伪类的那一段**命中的节点上", () => {
    const card = fakeNode({ type: "PanelContainer", classes: ["card"], pseudo: ["hover"] });
    const title = fakeNode({ type: "Label", classes: ["title"], parent: card });
    expect(depsOf(".card:hover .title", title)).toEqual([card]);

    // 反向：伪类位于最右段时依赖就是节点自身
    const plain = fakeNode({ type: "PanelContainer", classes: ["card"] });
    const hovered = fakeNode({ type: "Label", classes: ["title"], pseudo: ["hover"], parent: plain });
    expect(depsOf(".card .title:hover", hovered)).toEqual([hovered]);
  });

  it("子组合器同样按段记（> 不能比空格少记一段）", () => {
    const card = fakeNode({ type: "PanelContainer", classes: ["card"], pseudo: ["hover"] });
    const title = fakeNode({ type: "Label", classes: ["title"], parent: card });
    expect(depsOf(".card:hover > .title", title)).toEqual([card]);
  });

  it("纯静态选择器不记依赖（class 变化由级联的子树失效兜）", () => {
    const card = fakeNode({ classes: ["card"] });
    const title = fakeNode({ classes: ["title"], parent: card });
    expect(depsOf(".card .title", title)).toEqual([]);
  });

  it("属性选择器记的是属性名", () => {
    const node = fakeNode({ classes: ["a"], attrs: { state: "on" } });
    const { ruleSets } = buildRuleSets("[state] { color: red; }");
    const result = new StyleSheetIndex(ruleSets).query(node, NO_ENV);
    expect([...(result.changeMap.get(node)?.attributes ?? [])]).toEqual(["state"]);
  });
});

describe("伪类收集（懒订阅的依据）", () => {
  const names = (text: string) => [...collectPseudoClasses(createSelector(text))].sort();

  it("普通选择器一个也不收", () => {
    expect(names("Label.big")).toEqual([]);
    expect(names("Card > Label")).toEqual([]);
  });

  it("组合选择器里哪段带的都收得到", () => {
    expect(names("Card:hover .title")).toEqual(["hover"]);
    // 逗号列表不在 createSelector 这一层（它在 ruleset 层就被 splitTopLevel 拆开了），
    // 此处逐条收集——级联那边也是这样收集的（每条规则的选择器单独处理）
    expect([...new Set(["Button:hover", "Button:focus"].flatMap((t) => [...collectPseudoClasses(createSelector(t))]))].sort()).toEqual([
      "focus",
      "hover",
    ]);
  });

  it("函数式伪类自身不是状态，只递归进参数", () => {
    expect(names("Button:not(:hover)")).toEqual(["hover"]);
    expect(names("Button:is(:hover, :checked)")).toEqual(["checked", "hover"]);
    expect(names("Button:where(.x)")).toEqual([]);
  });
});

describe("属性选择器：操作符全集与写法错误", () => {
  const node = fakeNode({ attrs: { title: "Hello World", code: "abc-def" } });

  it("$= 后缀 / *= 包含 / i 大小写不敏感", () => {
    expect(createSelector('[title$="World"]').match(node)).toBe(true);
    expect(createSelector('[title$="world"]').match(node)).toBe(false);
    expect(createSelector('[title$="world" i]').match(node)).toBe(true);
    expect(createSelector('[title*="lo Wo"]').match(node)).toBe(true);
    expect(createSelector('[title*="nope"]').match(node)).toBe(false);
    expect(createSelector('[title="HELLO WORLD" i]').match(node)).toBe(true);
  });

  it("比较值为空串时除 exists 外一律不匹配（防止空值命中一切）", () => {
    const empty = fakeNode({ attrs: { title: "" } });
    expect(createSelector('[title=""]').match(empty)).toBe(false);
    expect(createSelector('[title]').match(empty)).toBe(true);
  });

  it("书写错误的属性选择器：说明原因，不抛出异常", () => {
    const bad = createSelector("[a b c]");
    expect(bad).toBeInstanceOf(InvalidSelector);
    expect((bad as InvalidSelector).error?.message).toContain("属性选择器");
    expect(createSelector("[a")).toBeInstanceOf(InvalidSelector);
  });
});

describe("非法选择器与调试输出", () => {
  it("InvalidSelector 也是能用的选择器：match 恒 false，toString 带上原因", () => {
    const bad = createSelector("Label::before") as InvalidSelector;
    expect(String(bad)).toContain("伪元素");
    // 它自身重写成零参的 match()，需要走多态签名才能将节点传入（恒 false 才是重点）
    expect((bad as SimpleSelector).match(fakeNode({ type: "Label" }))).toBe(false);
    expect(() => bad.lookupSort()).not.toThrow();
  });

  it("组合符出现在错误位置 / 空选择器 → InvalidSelector", () => {
    expect(createSelector("> Label")).toBeInstanceOf(InvalidSelector);
    expect(createSelector(">")).toBeInstanceOf(InvalidSelector);
    expect(createSelector("")).toBeInstanceOf(InvalidSelector);
    expect(createSelector("  ,  ")).toBeInstanceOf(InvalidSelector);
  });

  it("函数式伪类：toString 还原、mayMatch 与 match 同结论、trackChanges 递归进参数", () => {
    const sel = createSelector(":is([title], .y)");
    expect(String(sel)).toContain(":is(");
    expect(String(sel)).toContain(".y");
    const hit = fakeNode({ type: "Label", classes: ["x"], attrs: { title: "t" } });
    expect(sel.mayMatch(hit)).toBe(true);
    const map = new SelectorsMatch();
    sel.trackChanges(hit, map);
    // 参数中的属性选择器需要登记依赖，否则属性变化不会重算（class 自身由 TrackingClassSet 管理）
    expect([...map.changeMap.values()].some((c) => c.attributes?.has("title"))).toBe(true);
  });

  it("带组合符的选择器 mayMatch 一律 true 走全量匹配（省掉遍历祖先）", () => {
    const parent = fakeNode({ type: "VBoxContainer" });
    const node = fakeNode({ type: "Label", parent, classes: ["a"] });
    expect(createSelector("VBoxContainer .a").mayMatch(node)).toBe(false);
    expect(createSelector("VBoxContainer .a").match(node)).toBe(true);
  });
});

describe("后追加样式表（StyleSheetIndex.append）", () => {
  it("追加的规则排在已有规则之后，@media 段也一起认", () => {
    const index = new StyleSheetIndex(buildRuleSets("Label { color: black; }").ruleSets);
    const node = fakeNode({ type: "Label" });
    expect(index.query(node, NO_ENV).selectors.map(String)).toEqual(["label"]);

    // 全局样式表在组件样式之后注册：特异度相同，依靠 pos 区分先后
    index.append(buildRuleSets("Label { color: red; }").ruleSets);
    expect(index.query(node, NO_ENV).selectors.map(String)).toEqual(["label", "label"]);

    index.append(buildRuleSets("@media (max-width: 600px) { Label { color: blue; } }").ruleSets);
    expect(index.query(node, NO_ENV).selectors.length).toBe(2); // 800 宽，媒体段不命中
    expect(index.query(node, { ...NO_ENV, width: 500 }).selectors.length).toBe(3);
  });

  it("追加时遇到无效选择器：只丢那一条，已有规则照常命中", () => {
    const index = new StyleSheetIndex(buildRuleSets(".a { color: black; }").ruleSets);
    const node = fakeNode({ classes: ["a"] });
    const late = buildRuleSets(" > { color: red; } .a { font_size: 12px; }");
    expect(late.warnings.length).toBeGreaterThan(0);
    index.append(late.ruleSets);
    expect(index.query(node, NO_ENV).selectors.map(String)).toEqual([".a", ".a"]);
  });
});
