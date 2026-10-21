import { beforeEach, describe, expect, it } from "vitest";
import { HBoxContainer, Label, VBoxContainer, Vector2 } from "godot";
import { StyleRuntime } from "godot-angular/core";
import { SelectorTier } from "godot-angular/css";
import { awaitFrames, newStyleRuntime, makeRenderer } from "godot-angular/testing";

/** 节点上的 class 集合（typings 中没有这个字段，它是 attach 时挂载的 JS 属性） */
function classes(node: any): Set<string> {
  const set = node.cssClasses;
  if (!(set instanceof Set)) throw new Error("节点没 attach 到级联上，cssClasses 不存在");
  return set as Set<string>;
}

let runtime: StyleRuntime;
let root: any;

beforeEach(() => {
  runtime = newStyleRuntime();
  root = makeRenderer().root;
});

describe("C14：WeakMap 状态与包装对象身份", () => {
  it("500 节点塞 WeakMap，分配压力 + 真帧推进后身份与状态仍在", async () => {
    const store = new WeakMap<object, number>();
    const box = new VBoxContainer();
    root.add_child(box);
    const made: any[] = [];
    for (let i = 0; i < 500; i++) {
      const label = new Label();
      box.add_child(label);
      store.set(label, i);
      made.push(label);
    }

    // 制造分配压力。没有强制 GC，只能尽量诱发——需说明这是压力测试而不是 GC 测试
    for (let round = 0; round < 20000; round++) {
      const junk: unknown[] = [round, "x".repeat(32), { round }];
      if (junk.length < 0) throw new Error("unreachable");
    }
    await awaitFrames(2);

    let sameIdentity = 0;
    let lostState = 0;
    for (let i = 0; i < 500; i++) {
      const again = box.get_child(i);
      if (again === made[i]) sameIdentity++;
      if (store.get(again) !== i) lostState++;
    }
    expect(sameIdentity).toBe(500);
    expect(lostState).toBe(0);
  });

  it("级联状态也存在 WeakMap 里：节点重新取回后 applied 还在", () => {
    runtime.addCss(".keep { color: rgb(255,0,0); }");
    const box = new VBoxContainer();
    root.add_child(box);
    const label = new Label();
    box.add_child(label);
    runtime.attach(label);
    classes(label).add("keep");
    runtime.flush();

    expect(runtime.cascade.stateOf(box.get_child(0) as any)?.applied.get("color")).toBe("rgb(255,0,0)");
  });
});

describe("级联写入真节点", () => {
  it("构建期塞进来的全局样式（styles 选项）能被运行时取走并生效，且只取一次", () => {
    const bag = globalThis as Record<string, unknown>;
    bag.__CUJ_GLOBAL_CSS__ = [`.g1 { color: rgb(255,0,0); }`, "", `  `, `.g2 { font-size: 30px; }`];

    const other = newStyleRuntime();
    other.takeGlobalCss();
    // 取完置空：第二个应用不应重复获取同一批（重复注册会将同特异度的规则往后排）
    expect(bag.__CUJ_GLOBAL_CSS__).toEqual([]);

    const label = new Label();
    root.add_child(label);
    other.attach(label);
    classes(label).add("g1");
    classes(label).add("g2");
    other.flush();
    expect(label.get_theme_color("font_color").r).toBeCloseTo(1, 3);
    expect(label.get_theme_font_size("font_size")).toBe(30);
  });

  it("同特异度后者赢；内联压过样式表", () => {
    runtime.addCss(`.a { color: rgb(255,0,0); } .b { color: rgb(0,0,255); }`);
    const label = new Label();
    root.add_child(label);
    runtime.attach(label);
    classes(label).add("a");
    classes(label).add("b");
    runtime.flush();
    expect(label.get_theme_color("font_color").b).toBeCloseTo(1, 3);

    runtime.setInline(label, "color", "rgb(0,255,0)");
    runtime.flush();
    expect(label.get_theme_color("font_color").g).toBeCloseTo(1, 3);

    runtime.removeInline(label, "color");
    runtime.flush();
    expect(label.get_theme_color("font_color").b).toBeCloseTo(1, 3);
  });

  it("组件样式（Local）压过全局样式（Application），与登记顺序无关", () => {
    runtime.addCss(".x { color: rgb(0,0,255); }", { tier: SelectorTier.Local });
    runtime.addCss(".y { color: rgb(255,0,0); }");
    const label = new Label();
    root.add_child(label);
    runtime.attach(label);
    classes(label).add("x");
    classes(label).add("y");
    runtime.flush();
    expect(label.get_theme_color("font_color").b).toBeCloseTo(1, 3);
  });

  it("cssClasses.add 之后等两帧就取到新值（帧末批量）", async () => {
    runtime.addCss(".late { color: rgb(255,0,0); }");
    const label = new Label();
    root.add_child(label);
    runtime.attach(label);
    expect(label.has_theme_color_override("font_color")).toBe(false);

    classes(label).add("late");
    await awaitFrames(2);
    expect(label.has_theme_color_override("font_color")).toBe(true);
  });

  it("移除 class 后 override 被撤干净", async () => {
    runtime.addCss(".gone { color: rgb(255,0,0); font-size: 20px; }");
    const label = new Label();
    root.add_child(label);
    runtime.attach(label);
    classes(label).add("gone");
    await awaitFrames(2);
    expect(label.has_theme_color_override("font_color")).toBe(true);
    expect(label.has_theme_font_size_override("font_size")).toBe(true);

    classes(label).delete("gone");
    await awaitFrames(2);
    expect(label.has_theme_color_override("font_color")).toBe(false);
    expect(label.has_theme_font_size_override("font_size")).toBe(false);
  });

  it("一轮里 addClass 三次只 flush 一次", async () => {
    runtime.addCss(`.x1 { color: rgb(255,0,0); } .x2 { font-size: 12px; } .x3 { opacity: 0.5; }`);
    const label = new Label();
    root.add_child(label);
    runtime.attach(label);
    const before = { ...runtime.cascade.stats };

    classes(label).add("x1");
    classes(label).add("x2");
    classes(label).add("x3");
    await awaitFrames(2);

    expect(runtime.cascade.stats.flushes - before.flushes).toBe(1);
    expect(runtime.cascade.stats.applied - before.applied).toBe(3);
  });

  it("改 A 的 class 不牵连 B（定向失效）", async () => {
    runtime.addCss(".only { color: rgb(255,0,0); }");
    const a = new Label();
    const b = new Label();
    root.add_child(a);
    root.add_child(b);
    runtime.attach(a);
    runtime.attach(b);
    classes(a).add("only");
    classes(b).add("only");
    await awaitFrames(2);
    const before = { ...runtime.cascade.stats };

    classes(a).add("noise");
    await awaitFrames(2);

    expect(runtime.cascade.stats.applied - before.applied).toBe(0);
    expect(runtime.cascade.isDirty(b as any)).toBe(false);
  });

  it("后代选择器：祖先 class 变了，后代才重算", async () => {
    runtime.addCss(`.card.sel .title { color: rgb(255,0,0); }`);
    const card = new VBoxContainer();
    const title = new Label();
    root.add_child(card);
    card.add_child(title);
    runtime.attach(card);
    runtime.attach(title);
    classes(card).add("card");
    classes(title).add("title");
    await awaitFrames(2);
    expect(title.has_theme_color_override("font_color")).toBe(false);

    classes(card).add("sel");
    await awaitFrames(2);
    expect(title.get_theme_color("font_color").r).toBeCloseTo(1, 3);
  });
});

describe("布局在 headless 下真算", () => {
  it("flex:1 与 flex:2 的两个子节点按 1:2 分宽", async () => {
    runtime.addCss(`.one { flex: 1; } .two { flex: 2; }`);
    const box = new HBoxContainer();
    root.add_child(box);
    // 默认 separation 是 4px，会占用 2px 余量导致 98/198 这种带余数的结果。
    // 本条验证的是 flex 的分配比例，间距不是主题，直接归零（不是 CSS 写的，是测试环境）
    box.add_theme_constant_override("separation", 0);
    box.size = new Vector2(300, 100);
    const a = new Label();
    const b = new Label();
    box.add_child(a);
    box.add_child(b);
    runtime.attach(a);
    runtime.attach(b);
    classes(a).add("one");
    classes(b).add("two");
    await awaitFrames(3);

    expect(a.size.x).toBeGreaterThan(0);
    expect(b.size.x).toBe(a.size.x * 2);
    expect(Math.round(a.size.x + b.size.x)).toBe(300);
  });

  it("gap 写入 separation 后子节点间距真的变大", async () => {
    runtime.addCss(`.wide { gap: 20px; }`);
    const box = new VBoxContainer();
    root.add_child(box);
    box.size = new Vector2(100, 200);
    const a = new Label();
    const b = new Label();
    box.add_child(a);
    box.add_child(b);
    runtime.attach(box);
    classes(box).add("wide");
    await awaitFrames(3);
    expect(box.get_theme_constant("separation")).toBe(20);
    expect(Math.round(b.position.y)).toBeGreaterThanOrEqual(20);
  });
});

describe("性能护栏", () => {
  it("1000 节点 × 200 规则：一次全量 match + apply 在预算内", () => {
    // 200 条规则，每条命中部分节点
    let css = "";
    for (let i = 0; i < 200; i++) css += `.r${i} { color: rgb(${i % 256}, 10, 10); font-size: ${8 + (i % 12)}px; }\n`;
    runtime.addCss(css);

    const box = new VBoxContainer();
    root.add_child(box);
    const nodes: any[] = [];
    for (let i = 0; i < 1000; i++) {
      const label = new Label();
      box.add_child(label);
      runtime.attach(label);
      classes(label).add(`r${i % 200}`);
      classes(label).add(`r${(i * 7) % 200}`);
      classes(label).add(`r${(i * 31) % 200}`);
      nodes.push(label);
    }

    const started = Date.now();
    runtime.flush();
    const elapsed = Date.now() - started;
    // 回归线：1000 节点 × 200 规则，一次全量 match + apply 约 30ms。
    // 本条要防的是“数量级偏离”（例如索引退化为全表扫描），而不是 20% 的机器抖动；
    // 达到 300ms 才失败，说明已经出现问题，不是抖动。
    expect(elapsed).toBeLessThan(300);
    expect(nodes.length).toBe(1000);
    expect(runtime.cascade.stats.applied).toBeGreaterThan(1000);
  });
});

describe("父链（组合器的地基）", () => {
  /**
   * 选择器的 `>` / 空格 回溯读取的是 CssNode.parent 这个 JS 字段，而 Godot 节点只有
   * get_parent()。本条断言验证的是“引擎中父链确实被维护”——未维护时后代选择器
   * 一条也不会命中，而且不报错。
   */
  it("后代与子组合器在真节点树上命中", () => {
    runtime.addCss(`.card .title { color: rgb(0, 0, 255); }`);
    runtime.addCss(`.card > Label.kicker { color: rgb(0, 255, 0); }`);
    runtime.addCss(`.title { font-size: 30px; }`);

    const card = new VBoxContainer();
    root.add_child(card);
    runtime.attach(card);
    (card as unknown as { cssClasses: Set<string> }).cssClasses.add("card");

    const title = new Label();
    card.add_child(title);
    runtime.attach(title);
    (title as unknown as { cssClasses: Set<string> }).cssClasses.add("title");

    const kicker = new Label();
    card.add_child(kicker);
    runtime.attach(kicker);
    (kicker as unknown as { cssClasses: Set<string> }).cssClasses.add("kicker");

    runtime.flush();
    expect(title.get_theme_color("font_color").b).toBeCloseTo(1, 3);
    expect(kicker.get_theme_color("font_color").g).toBeCloseTo(1, 3);
    expect(title.get_theme_font_size("font_size")).toBe(30);
  });

  it("换个父节点后，后代选择器跟着变（父链不能是旧的）", async () => {
    runtime.addCss(`.yes .leaf { color: rgb(255, 0, 0); }`);
    const yes = new VBoxContainer();
    const no = new VBoxContainer();
    root.add_child(yes);
    root.add_child(no);
    runtime.attach(yes);
    runtime.attach(no);
    (yes as unknown as { cssClasses: Set<string> }).cssClasses.add("yes");
    (no as unknown as { cssClasses: Set<string> }).cssClasses.add("no");

    const leaf = new Label();
    yes.add_child(leaf);
    runtime.attach(leaf);
    (leaf as unknown as { cssClasses: Set<string> }).cssClasses.add("leaf");
    runtime.flush();
    expect(leaf.has_theme_color_override("font_color")).toBe(true);

    leaf.reparent(no);
    runtime.invalidateTree(leaf);
    await awaitFrames(1);
    expect(leaf.has_theme_color_override("font_color")).toBe(false);
  });
});
