import { Callable } from "godot";
import type { Object as GodotObject, Signal } from "godot";
import { Observable } from "rxjs";
import { resolveSignalName } from "./registry";
import { NOOP } from "./godot-events";

/**
 * 把 Godot 信号包成 RxJS 流，这样操作符（debounceTime / switchMap / withLatestFrom ...）
 * 都能直接用在引擎事件上。模板里的 `(pressed)="..."` 由 Angular 自己接线，
 * 需要在组件代码里组合事件时才用这个。
 *
 * 三个约定：
 *
 * 1. **事件名可以写 DOM 风格**。`"click"` 会自动解析成该节点真正拥有的信号
 *    （Button 上是 `pressed`），规则与模板事件完全一致，见 registry.ts 的 EVENT_ALIASES。
 * 2. **回调参数按数组发出**。Godot 信号可以带 0 到多个参数，RxJS 的 next 只能传一个值，
 *    所以统一成数组：无参信号收到 `[]`，`body_entered(body)` 收到 `[body]`。
 *    泛型参数写参数元组类型：`godotSignal$<[Area2D]>(area, "body_entered")`。
 * 3. **退订即断开**。每个订阅各自连接一个 Callable，取消订阅时各自断开。
 *    节点已经被 free 的情况在断开时会抛，这里吞掉——此时连接本来也随节点一起没了。
 *
 * 信号名解析不到（写错名字、或该节点确实没有这个信号）时，流在订阅时以 error 结束，
 * 不静默返回空流：静默的空流会让"事件永远不来"这种 bug 很难查。
 *
 * 生命周期结束不会让流自动完成：Godot 4 已经没有 `Object.predelete` 信号（实测
 * `ClassDB.class_has_signal("Object","predelete")` 为 false），没有可靠的"即将释放"通知。
 * 需要随节点销毁而结束时，自己加 `takeUntil(godotSignal$(node, "tree_exiting"))`。
 *
 * 入参类型是 `Object` 而不是 `Node`：信号不只控件有，`SceneTree`（继承 MainLoop）、
 * `Resource` 上也有，按 `Node` 收会把 `node_added` 这类合法用法挡在类型外。
 */
export function godotSignal$<A extends unknown[] = unknown[]>(
  node: GodotObject,
  eventName: string,
): Observable<A> {
  return new Observable<A>((subscriber) => {
    // 解析与连接都放到订阅时做：节点可能已经释放，那时 get_class() 会抛。
    // 放进流里统一走 error 回调，比在调用处同步抛异常好处理。
    let signalName: string | null;
    try {
      signalName = resolveSignalName(node, eventName);
    } catch (err) {
      subscriber.error(err instanceof Error ? err : new Error(String(err)));
      return NOOP;
    }
    if (!signalName) {
      subscriber.error(
        new Error(`节点 ${node.get_class()} 上没有信号 "${eventName}"，无法建立 RxJS 流`),
      );
      return NOOP;
    }

    // 信号是运行期字符串，类型上取不到，只有这一处按名字取。
    const signal = (node as unknown as Record<string, Signal>)[signalName];
    const callable = Callable.create(node, (...args: unknown[]) => subscriber.next(args as A));
    signal.connect(callable);

    return () => {
      try {
        signal.disconnect(callable);
      } catch {
        /* 节点已释放，连接随节点一起消失 */
      }
    };
  });
}
