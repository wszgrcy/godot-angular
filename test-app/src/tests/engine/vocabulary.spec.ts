import { describe, expect, it } from "vitest";
import { ClassDB, ThemeDB } from "godot";
import { getVocabulary, knownClasses, vocabularyMeta } from "godot-angular/css";

/** Godot Array / PackedStringArray → JS string[]（两种容器行为不同） */
function strArr(value: any): string[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value.size === "function" && typeof value.get === "function") {
    const out: string[] = [];
    for (let i = 0, n = Number(value.size()); i < n; i++) out.push(String(value.get(i)));
    return out;
  }
  if (typeof value[Symbol.iterator] === "function") return Array.from(value, String);
  return [];
}

const sorted = (list: readonly string[]): string[] => [...list].sort();

describe("主题词汇表 == 引擎现算的默认主题", () => {
  const vocabulary = getVocabulary();
  const theme: any = ThemeDB.get_default_theme();

  it("默认主题拿得到，且 dump 不是空表", () => {
    expect(theme).toBeTruthy();
    expect(knownClasses().length).toBeGreaterThan(10);
    expect(vocabularyMeta().classCount).toBe(Object.keys(vocabulary.classes).length);
  });

  it("dump 里每个类的四类 item 清单都与默认主题逐条相等", () => {
    const mismatches: string[] = [];
    for (const className of knownClasses()) {
      const dump = vocabulary.classes[className];
      let live;
      try {
        live = {
          styleboxes: strArr(theme.get_stylebox_list(className)),
          colors: strArr(theme.get_color_list(className)),
          constants: strArr(theme.get_constant_list(className)),
          fontSizes: strArr(theme.get_font_size_list(className)),
        };
      } catch (error) {
        mismatches.push(`${className}: 引擎查不到（${String(error)}）`);
        continue;
      }
      for (const kind of ["styleboxes", "colors", "constants", "fontSizes"] as const) {
        const got = sorted(live[kind]).join(",");
        const want = sorted(dump[kind]).join(",");
        if (got !== want) mismatches.push(`${className}.${kind}\n    dump: ${want}\n    引擎: ${got}`);
      }
    }
    expect(mismatches, `词汇表与引擎不一致：\n  ${mismatches.join("\n  ")}`).toEqual([]);
  });

  it("引擎里存在但 dump 里没有的类 = 0（dump 不能漏类）", () => {
    // 只检查 dump 覆盖过的那批类的**父链**：词汇表本来就是从 Control 的全部继承者扫描得出，
    // 缺少一个类就意味着某次 dump 中途失败或被截断。
    const missing = knownClasses().filter((name) => !vocabulary.parents[name]);
    expect(missing).toEqual([]);
  });

  it("不位于 Control 之下的类也在词汇表中", () => {
    // 仅遍历 ClassDB 的 Control 继承者会整类遗漏它们：PopupMenu 位于 Popup 之下、
    // AcceptDialog 位于 Window 之下，均不继承 Control，但默认主题确实为它们定义了 item。
    // 这一批只能从主题的 type list 获取，因此两个来源缺一不可。
    for (const name of ["PopupMenu", "PopupPanel", "AcceptDialog", "FileDialog", "Window"]) {
      expect(knownClasses(), name).toContain(name);
    }
    expect(getVocabulary().classes["PopupMenu"].colors).toContain("font_color");
    expect(getVocabulary().classes["Window"].fontSizes).toContain("title_font_size");
  });

  it("词汇表中每个类均为真实存在的类", () => {
    // 主题的 type list 中尚含并非类的类型名（FlatButton、TooltipLabel 等），
    // 若混入将使元素选择器的拼写校验放过书写错误的类名，dump 必须将其过滤。
    expect(knownClasses().filter((name) => !ClassDB.class_exists(name))).toEqual([]);
  });

  it("几个承重落点在引擎里真实存在（词汇表说存在 ≠ 引擎认，这里反向确认）", () => {
    expect(strArr(theme.get_stylebox_list("Button"))).toContain("normal");
    expect(strArr(theme.get_stylebox_list("PanelContainer"))).toContain("panel");
    expect(strArr(theme.get_color_list("Label"))).toContain("font_color");
    expect(strArr(theme.get_font_size_list("Label"))).toContain("font_size");
    expect(strArr(theme.get_constant_list("BoxContainer"))).toContain("separation");
  });
});
