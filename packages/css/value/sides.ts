import type { FourSides } from "../types";

/**
 * 来源：NativeScript/packages/core/ui/styling/style-properties.ts :: positioningFromParts
 * 等级：部分修改（主体一致）
 * 改动：1/2/3/4 个值的映射规则逐字相同；上游抛异常，本侧返回 null；上游返回
 * { top, right, bottom, left }，本侧返回按上右下左排序的数组。
 *
 * 将 1..4 个部分展开为四边；parts 长度非法时返回 null（由调用方告警，不抛错）
 */
export function fourSidesFromParts<T>(parts: T[]): [T, T, T, T] | null {
  if (parts.length === 1) return [parts[0], parts[0], parts[0], parts[0]];
  if (parts.length === 2) return [parts[0], parts[1], parts[0], parts[1]];
  if (parts.length === 3) return [parts[0], parts[1], parts[2], parts[1]];
  if (parts.length === 4) return [parts[0], parts[1], parts[2], parts[3]];
  return null;
}

/**
 * 来源：无
 *
 * 按 top/right/bottom/left 顺序构造 FourSides
 */
export function toFourSides(top: number, right: number, bottom: number, left: number): FourSides {
  return { top, right, bottom, left };
}

/**
 * 来源：无
 *
 * 按 top/right/bottom/left 顺序取值
 */
export function sidesAsArray(sides: FourSides): [number, number, number, number] {
  return [sides.top, sides.right, sides.bottom, sides.left];
}
