import { Callable } from "godot";
import type { Node, Signal } from "godot";
import { resolveSignalName } from "./registry";

/** 解析不到信号时的空卸载函数（共用一份，避免每次新建闭包）。 */
export const NOOP = (): void => {};

/** 信号名是运行期字符串，而 `Node` 上没有“任意信号名”索引，只有这一处按名字取。 */
function signalOf(node: Node, signalName: string): Signal {
  return (node as unknown as Record<string, Signal>)[signalName];
}

/**
 * 解析事件名并连接信号；解析不到时返回 null，不告警也不抛，
 * 处理策略交由调用方决定。必须在 view 初始化完成后调用，并且必须在 ngOnDestroy 里
 * 调用返回的卸载函数——Godot 侧的 Callable 不会自动解绑。
 *（模板中的 `(xxx)` 由 Angular 自行退订，没有这个负担。）
 */
export function tryConnectGodotSignal(
  node: Node,
  eventName: string,
  handler: (...args: unknown[]) => void,
): (() => void) | null {
  const signalName = resolveSignalName(node, eventName);
  if (!signalName) return null;
  const callable = Callable.create(node, (...args: unknown[]) => handler(...args));
  const signal = signalOf(node, signalName);
  signal.connect(callable);
  return () => {
    try {
      signal.disconnect(callable);
    } catch {
      /* 节点已释放 */
    }
  };
}
