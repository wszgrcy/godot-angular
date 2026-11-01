import { Control, Node } from "godot";
import type * as GodotNamespace from "godot";
import { GodotRenderer, godotClass } from "godot-angular/core";

let sceneRoot: Node | null = null;

/** 由引擎侧 vitest 入口调用：用例创建的根 Control 会挂到这个场景节点下 */
export function setEngineSceneRoot(node: Node): void {
  sceneRoot = node;
}

/** 场景根（`test-env.ts` 为每个用例创建根 Control 时使用） */
export function getEngineSceneRoot(): Node | null {
  return sceneRoot;
}

/**
 * 引擎声明里所有“可实例化的 Node 子类”类名。直接从 `typings/godot*.gen.d.ts` 筛出来，
 * 因此不需要手工维护一张表，引擎升级后自动跟着变。
 */
export type GodotClassName = {
  [K in keyof typeof GodotNamespace]: (typeof GodotNamespace)[K] extends abstract new (...args: never[]) => Node
    ? K
    : never
}[keyof typeof GodotNamespace];

/** 类名对应的实例类型：`GodotInstance<"HSlider">` 就是 `HSlider`。 */
export type GodotInstance<K extends GodotClassName> = InstanceType<(typeof GodotNamespace)[K]>;

/**
 * 深度优先收集节点（包含自身），配合 findAll / texts 使用。
 *
 * 默认返回 `Node[]`：遍历结果里混着各种类，静态侧能确定的只有“它们都是节点”。
 * 确定整批都是某一类时写出来：`walkNodes<Label>(root)`。
 */
export function walkNodes<T extends Node = Node>(node: Node): T[] {
  const out: T[] = [node as T];
  const count = node.get_child_count();
  for (let i = 0; i < count; i++) out.push(...walkNodes<T>(node.get_child(i)));
  return out;
}

/** 类名写成字面量时直接得到该类的实例数组；类名来自变量时退化为 `Node[]`。 */
export function findAllNodes<K extends GodotClassName>(root: Node, className: K): GodotInstance<K>[];
export function findAllNodes(root: Node, className: string): Node[];
export function findAllNodes(root: Node, className: string): Node[] {
  return walkNodes(root).filter((n) => n.get_class() === className);
}

/**
 * 收集全部非空 text，按文档顺序。
 *
 * `text` 只存在于 Label / Button 那一支，`Node` 类型中没有，因此此处按“探测”的口径读取：
 * 不是该节点的属性就跳过，而不是假装整棵树都是 Label。
 */
export function nodeTexts(root: Node): string[] {
  return walkNodes(root)
    .map((n) => (n as { text?: unknown }).text)
    .filter((t): t is string => typeof t === "string" && t.length > 0);
}

/**
 * 直接对 renderer 做单元级真机测试用的挂点。
 *
 * 这些行为（未知属性静默接受、重复 add_child 只打错误、裸 Control 高度塌缩）
 * 在 mock 上只能“模拟”，只有引擎本体才是事实来源，因此刻意运行在真节点上。
 */
export function makeRenderer(options: { parent?: Node } = {}): {
  root: Control;
  renderer: GodotRenderer;
} {
  const root = new Control();
  root.name = "RendererSpecRoot";
  const parent = options.parent ?? sceneRoot;
  // 场景根可能还没建（纯 renderer 单测）：没有就只创建不挂载
  if (parent) parent.add_child(root);
  return { root, renderer: new GodotRenderer(root) };
}

/** 真节点没有 mock 的 .children 便捷属性，按顺序取子节点（类型参数同 walkNodes） */
export function childNodes<T extends Node = Node>(node: Node): T[] {
  const out: T[] = [];
  const n = node.get_child_count();
  for (let i = 0; i < n; i++) out.push(node.get_child(i) as T);
  return out;
}

/**
 * 按类名创建一个真实引擎节点（registry 这类纯函数测试需要按类型构造）。
 *
 * 类名写成字面量时推回具体类（`newNode("HSlider").value` 可用）；类名来自变量时得到 `Node`。
 */
export function newNode<K extends GodotClassName>(className: K): GodotInstance<K>;
export function newNode(className: string): Node;
export function newNode(className: string): Node {
  const Ctor = godotClass(className);
  if (!Ctor) throw new Error(`godot class not found '${className}'`);
  return new Ctor();
}

/* ------------------------ 等引擎真帧 ------------------------ */

let frameWaiters: Array<() => void> = [];

/** 由引擎侧 runtime 的 `tick()` 每帧调用一次：变更检测不会使引擎重算布局，而容器布局只在
 * 引擎自己的 `_process` 之后才成立。 */
export function pumpEngineFrames(): void {
  const waiters = frameWaiters;
  frameWaiters = [];
  for (const resolve of waiters) resolve();
}

/** 等待引擎真实运行过 n 帧（布局、尺寸、主题解析这类断言使用） */
export async function awaitFrames(n = 2): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) {
    p = p.then(() => new Promise<void>((resolve) => frameWaiters.push(resolve)));
  }
  return p;
}
