const godot = require("godot");

/** Godot Array / PackedStringArray → JS string[]（两种容器行为不同，见 README 的“实测踩到的坑”一节） */
function strArr(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(String);
  if (typeof v.size === "function" && typeof v.get === "function") {
    const out = [];
    for (let i = 0, n = Number(v.size()); i < n; i++) out.push(String(v.get(i)));
    return out;
  }
  if (typeof v[Symbol.iterator] === "function") return Array.from(v, String);
  return [];
}

/** GodotJS 的 Engine 单例未编入 `get_version_string`（实测），逐个候选尝试，得不到则返回 unknown */
function engineVersion() {
  try {
    const Engine = godot.Engine;
    if (Engine && typeof Engine.get_version_string === "function") return String(Engine.get_version_string());
    if (Engine && typeof Engine.get_version_info === "function") {
      const info = Engine.get_version_info();
      const string = info && info.string;
      if (string) return String(string);
    }
  } catch (e) {
    /* 版本信息只是元数据，获取不到不影响词汇表 */
  }
  return "unknown";
}

class VocabularyProbe extends godot.Node {
  _ready() {
    const { ThemeDB, ClassDB } = godot;
    const theme = ThemeDB.get_default_theme();
    if (!theme) {
      console.error("CUJ_VOCABULARY_ERROR: ThemeDB.get_default_theme() 返回空值");
      this.get_tree().quit(1);
      return;
    }

    // 类名来源共两处，缺一不可：
    // ① ClassDB 的 Control 继承者——覆盖“可作为元素选择器的类”；
    // ② 默认主题的 type list——覆盖不位于 Control 之下的类（PopupMenu 位于 Popup / Window 之下，
    //    FileDialog、AcceptDialog、PopupDialog 同理），仅按 ① 提取会整类遗漏。
    // type list 中尚存在并非类的主题类型名（FlatButton、TooltipLabel 等），其不对应任何
    // 节点，若混入将使元素选择器的拼写校验放过书写错误的类名，因此需经 class_exists 筛选。
    const fromInheritors = ["Control", ...strArr(ClassDB.get_inheriters_from_class("Control"))];
    const fromTheme = strArr(theme.get_type_list()).filter((name) => ClassDB.class_exists(name));
    const unique = Array.from(new Set([...fromInheritors, ...fromTheme]));

    const out = {};
    const parents = {};
    for (const cls of unique) {
      parents[cls] = String(ClassDB.get_parent_class(cls) ?? "");
      let styleboxes = [];
      let colors = [];
      let constants = [];
      let fontSizes = [];
      try {
        styleboxes = strArr(theme.get_stylebox_list(cls));
        colors = strArr(theme.get_color_list(cls));
        constants = strArr(theme.get_constant_list(cls));
        fontSizes = strArr(theme.get_font_size_list(cls));
      } catch (e) {
        continue;
      }
      if (!styleboxes.length && !colors.length && !constants.length && !fontSizes.length) continue;
      out[cls] = { styleboxes, colors, constants, fontSizes };
    }

    const payload = {
      engine: engineVersion(),
      fallbackFontSize: Number(ThemeDB.get_fallback_font_size ? ThemeDB.get_fallback_font_size() : 16),
      classes: out,
      // 继承链：Godot 的 theme 查找会沿父链回落，词汇表需要跟随，否则
      // “这个类是否有这个 item”会出现假阴性（Button 的许多项实际定义在父类上）。
      parents,
    };

    console.log("<<<CUJ_VOCABULARY>>>");
    console.log(JSON.stringify(payload));
    console.log("<<<END_CUJ_VOCABULARY>>>");
    this.get_tree().quit(0);
  }
}

exports.default = VocabularyProbe;
