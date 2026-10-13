import type { ColorLike } from "../types";

/**
 * 来源：NativeScript/packages/core/color/known-colors.ts :: registerColor 注册的全部色名
 * 等级：部分修改（主体一致）
 * 相同：色名集合与取值一致（包拮 grey / gray 两套拼写）。
 * 改动：上游以 0xAARRGGBB 整数注册（registerColor），本侧存 6 位 hex 文本；上游额外
 * 收录几个非标准别名（如 lightgrey 类），本侧只保留 CSS Color Level 4 命名色。
 *
 * CSS Color Level 4 的完整命名色表（值使用 6 位 hex，避免再引入一份数字表）
 */
const NAMED: Readonly<Record<string, string>> = {
  aliceblue: "#f0f8ff",
  antiquewhite: "#faebd7",
  aqua: "#00ffff",
  aquamarine: "#7fffd4",
  azure: "#f0ffff",
  beige: "#f5f5dc",
  bisque: "#ffe4c4",
  black: "#000000",
  blanchedalmond: "#ffebcd",
  blue: "#0000ff",
  blueviolet: "#8a2be2",
  brown: "#a52a2a",
  burlywood: "#deb887",
  cadetblue: "#5f9ea0",
  chartreuse: "#7fff00",
  chocolate: "#d2691e",
  coral: "#ff7f50",
  cornflowerblue: "#6495ed",
  cornsilk: "#fff8dc",
  crimson: "#dc143c",
  cyan: "#00ffff",
  darkblue: "#00008b",
  darkcyan: "#008b8b",
  darkgoldenrod: "#b8860b",
  darkgray: "#a9a9a9",
  darkgreen: "#006400",
  darkgrey: "#a9a9a9",
  darkkhaki: "#bdb76b",
  darkmagenta: "#8b008b",
  darkolivegreen: "#556b2f",
  darkorange: "#ff8c00",
  darkorchid: "#9932cc",
  darkred: "#8b0000",
  darksalmon: "#e9967a",
  darkseagreen: "#8fbc8f",
  darkslateblue: "#483d8b",
  darkslategray: "#2f4f4f",
  darkslategrey: "#2f4f4f",
  darkturquoise: "#00ced1",
  darkviolet: "#9400d3",
  deeppink: "#ff1493",
  deepskyblue: "#00bfff",
  dimgray: "#696969",
  dimgrey: "#696969",
  dodgerblue: "#1e90ff",
  firebrick: "#b22222",
  floralwhite: "#fffaf0",
  forestgreen: "#228b22",
  fuchsia: "#ff00ff",
  gainsboro: "#dcdcdc",
  ghostwhite: "#f8f8ff",
  gold: "#ffd700",
  goldenrod: "#daa520",
  gray: "#808080",
  green: "#008000",
  greenyellow: "#adff2f",
  grey: "#808080",
  honeydew: "#f0fff0",
  hotpink: "#ff69b4",
  indianred: "#cd5c5c",
  indigo: "#4b0082",
  ivory: "#fffff0",
  khaki: "#f0e68c",
  lavender: "#e6e6fa",
  lavenderblush: "#fff0f5",
  lawngreen: "#7cfc00",
  lemonchiffon: "#fffacd",
  lightblue: "#add8e6",
  lightcoral: "#f08080",
  lightcyan: "#e0ffff",
  lightgoldenrodyellow: "#fafad2",
  lightgray: "#d3d3d3",
  lightgreen: "#90ee90",
  lightgrey: "#d3d3d3",
  lightpink: "#ffb6c1",
  lightsalmon: "#ffa07a",
  lightseagreen: "#20b2aa",
  lightskyblue: "#87cefa",
  lightslategray: "#778899",
  lightslategrey: "#778899",
  lightsteelblue: "#b0c4de",
  lightyellow: "#ffffe0",
  lime: "#00ff00",
  limegreen: "#32cd32",
  linen: "#faf0e6",
  magenta: "#ff00ff",
  maroon: "#800000",
  mediumaquamarine: "#66cdaa",
  mediumblue: "#0000cd",
  mediumorchid: "#ba55d3",
  mediumpurple: "#9370db",
  mediumseagreen: "#3cb371",
  mediumslateblue: "#7b68ee",
  mediumspringgreen: "#00fa9a",
  mediumturquoise: "#48d1cc",
  mediumvioletred: "#c71585",
  midnightblue: "#191970",
  mintcream: "#f5fffa",
  mistyrose: "#ffe4e1",
  moccasin: "#ffe4b5",
  navajowhite: "#ffdead",
  navy: "#000080",
  oldlace: "#fdf5e6",
  olive: "#808000",
  olivedrab: "#6b8e23",
  orange: "#ffa500",
  orangered: "#ff4500",
  orchid: "#da70d6",
  palegoldenrod: "#eee8aa",
  palegreen: "#98fb98",
  paleturquoise: "#afeeee",
  palevioletred: "#db7093",
  papayawhip: "#ffefd5",
  peachpuff: "#ffdab9",
  peru: "#cd853f",
  pink: "#ffc0cb",
  plum: "#dda0dd",
  powderblue: "#b0e0e6",
  purple: "#800080",
  rebeccapurple: "#663399",
  red: "#ff0000",
  rosybrown: "#bc8f8f",
  royalblue: "#4169e1",
  saddlebrown: "#8b4513",
  salmon: "#fa8072",
  sandybrown: "#f4a460",
  seagreen: "#2e8b57",
  seashell: "#fff5ee",
  sienna: "#a0522d",
  silver: "#c0c0c0",
  skyblue: "#87ceeb",
  slateblue: "#6a5acd",
  slategray: "#708090",
  slategrey: "#708090",
  snow: "#fffafa",
  springgreen: "#00ff7f",
  steelblue: "#4682b4",
  tan: "#d2b48c",
  teal: "#008080",
  thistle: "#d8bfd8",
  tomato: "#ff6347",
  turquoise: "#40e0d0",
  violet: "#ee82ee",
  wheat: "#f5deb3",
  white: "#ffffff",
  whitesmoke: "#f5f5f5",
  yellow: "#ffff00",
  yellowgreen: "#9acd32",
};

/**
 * 来源：无
 */
export const TRANSPARENT: ColorLike = { r: 0, g: 0, b: 0, a: 0 };

/**
 * 来源：NativeScript/packages/core/color/color-utils.ts :: argbFromRgbOrRgba 的 & 0xff 钳位
 * 等级：仅思路一致
 * 差异：上游将通道钳位到 0..255 整数（ARGB 存储），本侧钳到 0..1 浮点（Godot Color）。
 */
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 来源：NativeScript/packages/core/color/color-utils.ts :: parseColorWithAlpha 中对单个
 * 通道的处理（百分号分支）
 * 等级：部分修改（主体一致）
 * 改动：上游用正则判定百分号后统一换算到 0..255 整数，本侧保留浮点；上游非法值最
 * 终落到 NaN，本侧返回 null 交由调用方告警。
 */
function channelByte(v: string): number | null {
  const trimmed = v.trim();
  if (trimmed.endsWith("%")) {
    const pct = Number.parseFloat(trimmed);
    return Number.isFinite(pct) ? clamp01(pct / 100) * 255 : null;
  }
  const n = Number.parseFloat(trimmed);
  return Number.isFinite(n) ? Math.min(255, Math.max(0, n)) : null;
}

/**
 * 来源：NativeScript/packages/core/color/color-utils.ts :: parseColorWithAlpha 的 alpha 分支
 * （alpha 分支）
 * 等级：部分修改（主体一致）
 * 改动：上游将 alpha 归一到 0..255 整数并参与 ARGB 拼位，本侧直接返回 0..1；两者同样
 * 容忍百分号与无单位小数。
 */
function alphaValue(v: string | undefined): number {
  if (v === undefined) return 1;
  const trimmed = v.trim();
  if (trimmed.endsWith("%")) return clamp01(Number.parseFloat(trimmed) / 100);
  const n = Number.parseFloat(trimmed);
  return Number.isFinite(n) ? clamp01(n) : 1;
}

/**
 * 来源：NativeScript/packages/core/color/color-common.ts :: ColorBase 构造函数
 * 等级：仅思路一致
 * 差异：上游组装的是 32 位 ARGB 整数，本侧组装四通道浮点，不做任何位运算。
 */
function rgbFromBytes(r: number, g: number, b: number, a: number): ColorLike {
  return { r: r / 255, g: g / 255, b: b / 255, a };
}

/**
 * 来源：NativeScript/packages/core/color/color-utils.ts :: argbFromString
 * 等级：部分修改（主体一致）
 * 相同：3 / 4 位缩写展开为 6 / 8 位、6 位补不透明 alpha、8 位取末尾作 alpha，四条分支
 * 逐一对应。
 * 改动：上游用 parseInt(hex,16) + 位拼接得到 ARGB 整数，本侧逐段取出三个字节；上游
 * 对 5/7 位等非法长度不校验（会静默算错），本侧返回 null。
 *
 * `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`
 */
export function parseHexColor(text: string): ColorLike | null {
  const m = /^#([0-9a-fA-F]{3,8})$/.exec(text.trim());
  if (!m) return null;
  const hex = m[1];
  let r: number;
  let g: number;
  let b: number;
  let a = 255;
  if (hex.length === 3 || hex.length === 4) {
    r = parseInt(hex[0] + hex[0], 16);
    g = parseInt(hex[1] + hex[1], 16);
    b = parseInt(hex[2] + hex[2], 16);
    if (hex.length === 4) a = parseInt(hex[3] + hex[3], 16);
  } else if (hex.length === 6 || hex.length === 8) {
    r = parseInt(hex.slice(0, 2), 16);
    g = parseInt(hex.slice(2, 4), 16);
    b = parseInt(hex.slice(4, 6), 16);
    if (hex.length === 8) a = parseInt(hex.slice(6, 8), 16);
  } else {
    return null;
  }
  return rgbFromBytes(r, g, b, a / 255);
}

/**
 * 来源：NativeScript/packages/core/color/color-utils.ts :: hue2rgb
 * 等级：完全来自（一字未改）
 */
function hueToRgb(p: number, q: number, tIn: number): number {
  let t = tIn;
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

/**
 * 来源：NativeScript/packages/core/color/color-utils.ts :: hslToRgb
 * 等级：部分修改（主体一致）
 * 相同：achromatic 早退、q / p 计算、三次 hueToRgb 调用与 *255 取整逐字对应。
 * 改动：上游入参 s / l 以 0..100 计，本侧以 0..1 计（与 channelByte / numberArg 统一）；
 * 上游 hue 仅取模，本侧额外归一负角度（hsl(-120 50% 50%) 不再算错）。
 *
 * hsl / hsla：hue 为角度，sat / light 为百分比
 */
function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const hue = (((h % 360) + 360) % 360) / 360;
  const sat = clamp01(s);
  const light = clamp01(l);
  if (sat === 0) {
    const v = Math.round(light * 255);
    return { r: v, g: v, b: v };
  }
  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;
  return {
    r: Math.round(hueToRgb(p, q, hue + 1 / 3) * 255),
    g: Math.round(hueToRgb(p, q, hue) * 255),
    b: Math.round(hueToRgb(p, q, hue - 1 / 3) * 255),
  };
}

/**
 * 来源：无
 *
 * hwb：hue 为角度，white / black 为百分比（两者之和 > 1 时按比例压缩）
 */
function hwbToRgb(h: number, w: number, bl: number): { r: number; g: number; b: number } {
  let white = clamp01(w);
  let black = clamp01(bl);
  if (white + black > 1) {
    const sum = white + black;
    white /= sum;
    black /= sum;
  }
  const base = hslToRgb(h, 1, 0.5);
  const mix = (v: number) => Math.round((v / 255) * (1 - white - black) * 255 + white * 255);
  return { r: mix(base.r), g: mix(base.g), b: mix(base.b) };
}

/**
 * 来源：NativeScript/packages/core/color/color-utils.ts :: parseColorWithAlpha 的参数正则
 * 等级：部分修改（主体一致）
 * 改动：上游两条正则分别判百分号与 0..255，本侧一条正则先收字符形态，数值范围留给
 * channelByte / alphaValue；本侧额外允许科学计数法。
 */
const NUMBER_OR_PERCENT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%?$/i;

/**
 * 来源：NativeScript/packages/core/color/color-utils.ts :: parseColorWithAlpha
 * 等级：部分修改（主体一致）
 * 相同：都是先拆函数名与参数，再单独取出 alpha。
 * 改动：上游只支持逗号语法并用固定字段名 f/s/t/a 返回，本侧额外支持 CSS Color 4 的
 * 空格语法与 ` / alpha`；上游非法输入抛异常，本侧返回 null。
 *
 * 拆解 `f(a, b, c)` / `f(a b c / d)` 两种语法
 */
function splitFunction(text: string): { name: string; args: string[]; alpha?: string } | null {
  const m = /^([a-zA-Z]+)\s*\(([^)]*)\)$/.exec(text.trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  const body = m[2].trim();
  if (!body) return { name, args: [] };
  // 空格语法中的 `/ alpha`
  const slash = body.indexOf("/");
  let alpha: string | undefined;
  let main = body;
  if (slash !== -1) {
    alpha = body.slice(slash + 1).trim();
    main = body.slice(0, slash).trim();
  }
  const args = main.split(",").map((part) => part.trim());
  // 逗号缺失时按空格再拆分一次（`rgb(255 8 128)`）
  const flat: string[] = [];
  for (const arg of args) {
    if (arg.includes(" ")) flat.push(...arg.split(/\s+/).filter(Boolean));
    else flat.push(arg);
  }
  return { name, args: flat.filter((a) => a.length > 0), alpha };
}

/**
 * 来源：NativeScript/packages/core/color/color-utils.ts :: parseColorWithAlpha 的逐参数转换
 * 等级：仅思路一致
 * 差异：上游在同一个函数里就地完成百分号换算与位运算，本侧只把单个 token 归一为数字，
 * 通道语义（byte / 角度 / 百分比）由调用方决定。
 */
function numberArg(value: string | undefined): number | null {
  if (value === undefined || !NUMBER_OR_PERCENT.test(value.trim())) return null;
  const trimmed = value.trim();
  if (trimmed.endsWith("%")) return Number.parseFloat(trimmed) / 100;
  return Number.parseFloat(trimmed);
}

/**
 * 来源：NativeScript/packages/core/css/parser.ts :: parseColor
 *      + NativeScript/packages/core/color/color-common.ts :: ColorBase 构造函数（字符串分支）
 * 等级：部分修改（主体一致）
 * 相同：入口同样只接受 hex / 命名色 / rgb() / hsl()，命名色表先小写归一。
 * 改动：上游返回 ARGB 整数且非法时抛错（由 css/parser.ts 的调用方捕获），本侧返回
 * ColorLike 且非法时返回 null；本侧额外支持 hwb()、transparent、currentcolor 与空格语法，
 * 上游额外支持 hsv() 与 color-mix()（本侧无落点，未搬）。
 *
 * 解析任意 CSS 颜色。**解析失败返回 null**（由调用方决定告警还是兜底），永不抛错。
 */
export function parseColor(text: string): ColorLike | null {
  if (!text) return null;
  const value = text.trim().toLowerCase();
  if (!value || value === "currentcolor") return null;
  if (value === "transparent") return { ...TRANSPARENT };

  if (value.startsWith("#")) return parseHexColor(value);

  const named = NAMED[value];
  if (named) return parseHexColor(named);

  const fn = splitFunction(value);
  if (!fn) return null;
  const { name, args, alpha } = fn;

  if (name === "rgb" || name === "rgba") {
    if (args.length < 3) return null;
    const r = channelByte(args[0]);
    const g = channelByte(args[1]);
    const b = channelByte(args[2]);
    if (r === null || g === null || b === null) return null;
    const a = alpha !== undefined ? alphaValue(alpha) : args.length >= 4 ? alphaValue(args[3]) : 1;
    return rgbFromBytes(r, g, b, a);
  }

  if (name === "hsl" || name === "hsla") {
    if (args.length < 3) return null;
    const h = numberArg(args[0]);
    const s = numberArg(args[1]);
    const l = numberArg(args[2]);
    if (h === null || s === null || l === null) return null;
    const a = alpha !== undefined ? alphaValue(alpha) : args.length >= 4 ? alphaValue(args[3]) : 1;
    const rgb = hslToRgb(h, s, l);
    return rgbFromBytes(rgb.r, rgb.g, rgb.b, a);
  }

  if (name === "hwb") {
    if (args.length < 3) return null;
    const h = numberArg(args[0]);
    const w = numberArg(args[1]);
    const bl = numberArg(args[2]);
    if (h === null || w === null || bl === null) return null;
    const a = alpha !== undefined ? alphaValue(alpha) : 1;
    const rgb = hwbToRgb(h, w, bl);
    return rgbFromBytes(rgb.r, rgb.g, rgb.b, a);
  }

  return null;
}

/**
 * 来源：NativeScript/packages/core/color/color-common.ts :: ColorBase.toString / hex
 * 等级：仅思路一致
 * 差异：上游输出 #AARRGGBB（或 rgba(...) 字符串），通道为 0..255；本侧输出 rgba(...)，
 * 通道为 0..1，仅用于告警文案，不参与回写 CSS。
 *
 * 供告警 / 日志使用的紧凑写法
 */
export function colorToCss(color: ColorLike): string {
  const hex = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  const base = `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`;
  return color.a === 1 ? base : `${base}${hex(color.a)}`;
}
