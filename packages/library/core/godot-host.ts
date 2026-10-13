import godot from "godot";
import { ClassDB } from "godot";
import type { Node } from "godot";
// default import 可用，是因为 builder 会将其改写为裸 require（见 vite/godot-interop.ts）。

/**
 * `godotClass` 取回的构造函数。返回值按 `() => Node` 看待：本库只用它实例化能挂进节点树的
 * 类（`renderer.createElement` 已把候选过滤成 Control 后代），值类型 / StyleBox 那一类不走这里。
 */
export type GodotNodeCtor = new (...args: never[]) => Node;

/** 静态侧 `import godot` 得到的是命名空间，没有索引签名；按类名取成员时只能把它当成一张表看。 */
const classTable = godot as unknown as Record<string, unknown>;

/**
 * 按类名取得构造函数，不存在时返回 undefined。这是全库唯一一处按运行时字符串取成员的位置：
 * 具名 import 无法表达动态键名，只能依靠裸模块对象（前提是 godot-interop 插件已将其换成裸 require）。
 *
 * 先问 ClassDB 不是多余的保险：godot 命名空间是 Proxy，按不存在的键取成员会直接抛
 * `godot class not found 'xxx'`，拿不到 undefined。调用方（未知标签降级、按名建节点）需要的是
 * “拿不到就返回 undefined”，因此把报错挡在这里。
 */
export function godotClass(className: string): GodotNodeCtor | undefined {
  if (!ClassDB.class_exists(className)) return undefined;
  const ctor = classTable[className];
  return typeof ctor === "function" ? (ctor as GodotNodeCtor) : undefined;
}
