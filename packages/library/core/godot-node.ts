import type { Control, Node } from "godot";
import type { CssNode } from "godot-angular/css";

/**
 * 引擎节点在级联侧的形状。`Cascade` 属于纯包，只认 `CssNode`（不依赖引擎类型），
 * 而引擎侧递来的永远是真节点，因此两个世界的换算只需要这两个交叉类型。
 */
export type GodotNode = Node & CssNode;

/** 同上，但确定是 Control：theme / stylebox 那一组 API 挂在 Control 而不是 Node 上。 */
export type GodotControl = Control & CssNode;

/**
 * 换算成“既是引擎节点、又带级联侧键名”的形状。两个方向都要用它：
 * 交出去时（`Node` → 级联）与收回来时（级联回调里的 `CssNode`，运行时就是当初交出去的那个节点）。
 * `CssNode` 带索引签名，与 `Node` 互不重叠，因此只能显式换算，不靠隐式赋值。
 */
export function asGodotNode(node: Node | CssNode): GodotNode {
  return node as unknown as GodotNode;
}

/** 同上，落点在 theme / stylebox 时使用（写入方法全部来自 Control 分支）。 */
export function asGodotControl(node: Node | CssNode): GodotControl {
  return node as unknown as GodotControl;
}

/**
 * 是否 Godot 节点。`Renderer2.listen` 的 target 允许 `'window'` / `'document'` / `'body'`
 * 这类字符串（Angular 的既有约定），只能在这一处判定，此后一路都按真节点处理。
 */
export function isGodotNode(value: unknown): value is Node {
  return typeof (value as { get_class?: unknown } | null)?.get_class === "function";
}
