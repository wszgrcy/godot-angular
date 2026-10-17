/**
 * 来源：NativeScript/packages/core/ui/styling/length-shared.ts :: Length / FixedLength / PercentLength
 * 等级：部分修改（主体一致）
 * 改动：上游的 unit 可为 px / dip / %，本侧只保留 px 与 %；上游将百分比预先归一到
 * -1..1，本侧保留原始数字并带单位标记，换算推到落点。
 */
export interface CssLength {
  value: number;
  unit: "px" | "%";
}

/** 已识别单位之外的长度单位（用于“本条不支持”的告警文案） */
const UNSUPPORTED_UNITS = /^(em|rem|ex|ch|cap|ic|lh|rlh|vw|vh|vmin|vmax|cm|mm|in|pt|pc|q|fr)$/;

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i;

/** 整串必须就是一个数字。NUMBER 仅保证开头为数字，`50%`、`12px` 同样能通过它 */
const NUMBER_ONLY = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * 来源：NativeScript/packages/core/ui/styling/length-shared.ts :: FixedLength.parse / PercentLength.parse
 *      以及 NativeScript/packages/core/css/parser.ts :: parsePercentageOrLength
 * 等级：部分修改（主体一致）
 * 相同：识别“裸数字 / px / %”三种形态，其余判为非法。
 * 改动：上游非法时抛 Error，本侧返回 null；上游的裸数字是 dip（设备无关单位），
 * 本侧是 px（Godot 的 theme item 本就是像素）；上游还接受 auto 与 %, 顺序以外的写法。
 *
 * 解析 `<length>` / `<percentage>`；不支持或不合法时返回 null
 */
export function parseLength(text: string): CssLength | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const m = NUMBER.exec(trimmed);
  if (!m || m.index !== 0) return null;
  const value = Number.parseFloat(m[0]);
  if (!Number.isFinite(value)) return null;
  const rest = trimmed.slice(m[0].length).trim();
  if (rest === "") return { value, unit: "px" };
  if (rest === "px") return { value, unit: "px" };
  if (rest === "%") return { value, unit: "%" };
  return null;
}

/**
 * 来源：NativeScript/packages/core/ui/styling/length-shared.ts :: Length.toDevicePixels 的 px 分支
 * 等级：仅思路一致
 * 差异：上游要兼顾 dip → 设备像素的缩放与 round，本侧已是像素，只判单位。
 *
 * 只要像素值（px 或无单位）；其余返回 null
 */
export function parsePx(text: string): number | null {
  const length = parseLength(text);
  return length && length.unit === "px" ? length.value : null;
}

/**
 * 来源：无
 *
 * 本值是否属于“仅单位不认识”（用于给出一条更具体的告警，而不是笼统的“解析失败”）
 */
export function isUnsupportedUnit(text: string): boolean {
  const trimmed = text.trim();
  const m = NUMBER.exec(trimmed);
  if (!m) return false;
  return UNSUPPORTED_UNITS.test(trimmed.slice(m[0].length).trim());
}

/**
 * 来源：无
 *
 * 本值是否为百分比。百分比在 Godot 侧无落点，需要单独给出原因，
 * 而非混入“解析失败”中
 */
export function isPercentage(text: string): boolean {
  const length = parseLength(text);
  return length !== null && length.unit === "%";
}

/**
 * 来源：无
 *
 * 0 的多种写法（`0`、`0px`、`0%`）均计为 0
 */
export function isZero(text: string): boolean {
  const length = parseLength(text);
  return length !== null && length.value === 0;
}

/**
 * 来源：无
 *
 * 解析一个无单位数字（opacity / flex-grow / stretch ratio 这类）。
 * 整串必须均为数字：带单位的值经 parseFloat 亦能读出前导数字，
 * 若混入并经区间截断，所得结果与使用者实际书写的内容毫无关系
 */
export function parseNumber(text: string, min = -Infinity, max = Infinity): number | null {
  const trimmed = text.trim();
  if (!NUMBER_ONLY.test(trimmed)) return null;
  const value = Number.parseFloat(trimmed);
  if (!Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, value));
}
