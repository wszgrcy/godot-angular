import { describe, expect, it } from "vitest";
import {
  classChain,
  getVocabulary,
  hasThemeItem,
  itemForStates,
  knownClasses,
  pickBackgroundStylebox,
  setVocabulary,
  styleboxForState,
  themeItems,
  vocabularyMeta,
} from "godot-angular/css";

describe("主题词汇表", () => {
  it("dump 带着引擎版本与类数量（过期了看得出来）", () => {
    const meta = vocabularyMeta();
    expect(meta.engine).toMatch(/^v?\d+\.\d+/);
    expect(meta.classCount).toBeGreaterThan(10);
    expect(meta.fallbackFontSize).toBeGreaterThan(0);
  });

  it("四个落点类都在表里", () => {
    expect(hasThemeItem("Button", "stylebox", "normal")).toBe(true);
    expect(hasThemeItem("PanelContainer", "stylebox", "panel")).toBe(true);
    expect(hasThemeItem("LineEdit", "stylebox", "normal")).toBe(true);
    expect(hasThemeItem("Label", "stylebox", "normal")).toBe(true);
  });

  it("Button 的状态 stylebox 齐全（伪类落点靠它们）", () => {
    for (const item of ["normal", "hover", "pressed", "disabled", "focus"]) {
      expect(hasThemeItem("Button", "stylebox", item), item).toBe(true);
    }
  });

  it("font_color / font_size 这类 item 沿父链回落", () => {
    // CheckBox 自身的词汇表中有 font_color；LinkButton 也有。真正考验回落的是
    // 定义在父类上的 constant：BoxContainer.separation → VBoxContainer 可查到
    expect(classChain("VBoxContainer").length).toBeGreaterThan(1);
    expect(hasThemeItem("VBoxContainer", "constant", "separation")).toBe(true);
    expect(hasThemeItem("GridContainer", "constant", "h_separation")).toBe(true);
  });

  it("查不存在的类 / item 返回 false，不抛", () => {
    expect(hasThemeItem("NoSuchWidget", "stylebox", "normal")).toBe(false);
    expect(hasThemeItem("Label", "stylebox", "definitely-not-an-item")).toBe(false);
    expect(classChain("NoSuchWidget")).toEqual(["NoSuchWidget"]);
  });

  it("底色 stylebox 的候选顺序：PanelContainer 用 panel，Button 用 normal，容器没有", () => {
    expect(pickBackgroundStylebox("PanelContainer")).toBe("panel");
    expect(pickBackgroundStylebox("Button")).toBe("normal");
    expect(pickBackgroundStylebox("Label")).toBe("normal");
    expect(pickBackgroundStylebox("VBoxContainer")).toBeNull();
  });

  it("伪类 → stylebox 名（active / checked 都落 pressed）", () => {
    expect(styleboxForState("hover")).toBe("hover");
    expect(styleboxForState("active")).toBe("pressed");
    expect(styleboxForState("focus")).toBe("focus");
    // 开关控件的“已勾选”在引擎里就是 pressed 那一支
    expect(styleboxForState("checked")).toBe("pressed");
    expect(styleboxForState("selected")).toBe("selected");
    expect(styleboxForState("read-only")).toBe("read_only");
    // 名单外的状态没有落点
    expect(styleboxForState("valid")).toBeNull();
    expect(styleboxForState("indeterminate")).toBeNull();
  });

  /**
   * 状态变体 item。引擎在 hover 时读取的就是 font_hover_color / 绘制 hover 盒，
   * 写基 item 不会显示；而拼错一个下划线（font_hovercolor）同样静默不显示，
   * 因此这几条必须严格固定。
   */
  it("itemForStates：按当前状态挑真正要写的 item", () => {
    expect(itemForStates("Button", "stylebox", "normal", new Set(["hover"]))).toBe("hover");
    expect(itemForStates("Button", "color", "font_color", new Set(["hover"]))).toBe("font_hover_color");
    expect(itemForStates("Button", "color", "font_color", new Set(["focus"]))).toBe("font_focus_color");
    expect(itemForStates("Button", "color", "font_color", new Set(["active"]))).toBe("font_pressed_color");
    // 两个状态同时成立 → 引擎读取的是合成 item
    expect(itemForStates("Button", "color", "font_color", new Set(["hover", "active"]))).toBe(
      "font_hover_pressed_color",
    );
    // 没有这个变体则退回基 item，不构造一个不存在的名字
    expect(itemForStates("PanelContainer", "stylebox", "panel", new Set(["hover"]))).toBe("panel");
    expect(itemForStates("Button", "color", "font_color", new Set())).toBe("font_color");
    // 非颜色/非 stylebox 一律原样（constant 没有状态变体）
    expect(itemForStates("Button", "constant", "separation", new Set(["hover"]))).toBe("separation");
    // checked → pressed 家族：CheckBox 勾选时引擎读的就是 font_pressed_color / pressed 盒
    expect(itemForStates("CheckBox", "color", "font_color", new Set(["checked"]))).toBe("font_pressed_color");
    expect(itemForStates("CheckBox", "stylebox", "normal", new Set(["checked"]))).toBe("pressed");
    // 勾选 + hover → 合成盒 hover_pressed（CheckBox 有，普通 Button 没有 → 回到 pressed）
    expect(itemForStates("CheckBox", "stylebox", "normal", new Set(["hover", "checked"]))).toBe("hover_pressed");
    expect(itemForStates("Button", "stylebox", "normal", new Set(["hover", "checked"]))).toBe("pressed");
    // 勾选态赢过 hover：引擎在 toggle 打开时不走 hover 那一支（LinkButton 没有合成色，能看出优先级）
    expect(itemForStates("LinkButton", "color", "font_color", new Set(["hover", "checked"]))).toBe(
      "font_pressed_color",
    );
    // selected：ItemList / Tree 有，其他类退回基 item
    expect(itemForStates("ItemList", "color", "font_color", new Set(["selected"]))).toBe("font_selected_color");
    expect(itemForStates("ItemList", "stylebox", "panel", new Set(["selected"]))).toBe("selected");
    expect(itemForStates("Button", "color", "font_color", new Set(["selected"]))).toBe("font_color");
    // read-only：盒统一叫 read_only，文字色两个类叫法不同，按候选取该类真有的
    expect(itemForStates("TextEdit", "stylebox", "normal", new Set(["read-only"]))).toBe("read_only");
    expect(itemForStates("TextEdit", "color", "font_color", new Set(["read-only"]))).toBe("font_readonly_color");
    expect(itemForStates("LineEdit", "color", "font_color", new Set(["read-only"]))).toBe("font_uneditable_color");
  });

  it("themeItems 汇总父链上的全集", () => {
    const items = themeItems("VBoxContainer", "constant");
    expect(items).toContain("separation");
  });

  it("knownClasses 与 classes 表一致", () => {
    expect(knownClasses().length).toBe(vocabularyMeta().classCount);
  });
});

/**
 * 词汇表是生成数据（vocabulary.data.ts 从引擎 dump 出来），运行时只读。
 * setVocabulary 是测试注入口：灌一份小表，就能在不依赖引擎 dump 的前提下
 * 验"父链回落 / 状态合成 item"这些规则本身。
 */
describe("注入词汇表", () => {
  const FAKE = {
    engine: "v0.0-fake",
    fallbackFontSize: 11,
    classes: {
      Fake: {
        styleboxes: ["normal", "hover", "pressed", "hover_pressed"],
        colors: ["font_color", "font_hover_color", "font_hover_pressed_color"],
        constants: [] as string[],
        fontSizes: [] as string[],
      },
      // 只有 normal，没有 panel：验候选顺序真的按 STYLEBOX_CANDIDATES 走
      FakeBare: {
        styleboxes: ["normal"],
        colors: [] as string[],
        constants: [] as string[],
        fontSizes: [] as string[],
      },
      FakeBase: {
        styleboxes: ["panel"],
        colors: ["font_color"],
        constants: ["separation"],
        fontSizes: ["normal_size"],
      },
    },
    parents: { Fake: "FakeBase", FakeBase: "Control", FakeBare: "Control" },
  };

  it("换上去就生效，换回来也不留痕", () => {
    const real = getVocabulary();
    try {
      setVocabulary(FAKE);
      expect(getVocabulary()).toBe(FAKE);
      expect(vocabularyMeta().classCount).not.toBe(knownClasses().length);
      expect(knownClasses()).toEqual(["Fake", "FakeBare", "FakeBase"]);
      expect(classChain("Fake")).toEqual(["Fake", "FakeBase", "Control"]);
      // 回落：Fake 自己没有 panel / separation
      expect(hasThemeItem("Fake", "stylebox", "panel")).toBe(true);
      expect(hasThemeItem("Fake", "constant", "separation")).toBe(true);
      expect(hasThemeItem("FakeBase", "constant", "separation")).toBe(true);
      expect(themeItems("Fake", "font_size")).toEqual(["normal_size"]);
      // 底色落点按候选顺序（panel > normal > ...）挑，父链上的也算
      expect(pickBackgroundStylebox("Fake")).toBe("panel");
      expect(pickBackgroundStylebox("FakeBare")).toBe("normal");
      expect(pickBackgroundStylebox("Control")).toBeNull();
    } finally {
      setVocabulary(real);
      expect(getVocabulary()).toBe(real);
      expect(knownClasses().length).toBe(vocabularyMeta().classCount);
    }
  });

  it("状态 item：单状态取中缀，hover+按下取合成 item", () => {
    const real = getVocabulary();
    try {
      setVocabulary(FAKE);
      const states = (...names: string[]) => new Set(names);
      expect(itemForStates("Fake", "stylebox", "normal", states("hover"))).toBe("hover");
      expect(itemForStates("Fake", "stylebox", "normal", states("pressed"))).toBe("pressed");
      expect(itemForStates("Fake", "stylebox", "normal", states("hover", "pressed"))).toBe(
        "hover_pressed",
      );
      expect(itemForStates("Fake", "color", "font_color", states("hover"))).toBe("font_hover_color");
      expect(itemForStates("Fake", "color", "font_color", states("hover", "active"))).toBe(
        "font_hover_pressed_color",
      );
      // 词汇表里没有这个变体 → 退回基 item，不猜
      expect(itemForStates("FakeBase", "stylebox", "panel", states("hover"))).toBe("panel");
      // 非 stylebox / color 的 item 没有状态形态，原样返回
      expect(itemForStates("Fake", "constant", "separation", states("hover", "pressed"))).toBe(
        "separation",
      );
    } finally {
      setVocabulary(real);
    }
  });
});
