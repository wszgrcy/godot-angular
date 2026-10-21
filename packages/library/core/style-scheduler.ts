import { Injector, effect, signal, untracked } from "@angular/core";
import type { StyleScheduler } from "godot-angular/css";

/**
 * 用 Angular 的 `effect` 驱动级联刷新，也是样式刷新唯一的调度实现。
 *
 * 实现方式：`requested` 这个 signal 只用于触发 effect，其中的数值没有含义。effect 首次
 * 执行时读取 `requested`，从而建立依赖；此后每次 `request()` 递增该 signal，Angular 会在
 * 当前这次变更检测中重新执行 effect，effect 调用 `flush()`，由 `flush()` 把需要重算的
 * 节点写入引擎。
 *
 * 相比此前直接排 requestAnimationFrame 的写法，这样得到三点：
 *
 *  1. 不需要自行计算刷新时机。执行时间点、以及一次变更检测内执行几次都由 Angular 决定，
 *     `Cascade` 只负责把节点标记为需要重算。
 *  2. 生命周期与 injector 一致。应用 destroy 时 injector 被销毁，effect 不会再执行，因此不会
 *     出现「应用已销毁而回调仍向已释放节点写样式」。此前由帧钟 stop() 清空队列来避免这种
 *     情况，但队列被清空后旧实现中的调度标记不会复位，后续应用因此永远得不到刷新，需要
 *     额外的补救代码。
 *  3. `await appRef.whenStable()` 返回时样式已经写入。effect 的执行点位于这一轮刷新流程
 *     内部，不需要等到下一帧。
 *
 * `flush()` 执行期间还会产生新的待重算节点（`var()` 变化会把整棵子树标记为需要重算）。
 * 此时 `request()` 是在 effect 自身执行期间写入它所读取的 signal，Angular 会把同一个
 * effect 再执行一次，因此这部分节点不会遗漏；每次执行都会清空当前队列，重复次数有限。
 *
 * @param injector 决定该 effect 何时销毁。生产路径传入应用的 EnvironmentInjector。
 */
export function effectStyleScheduler(injector: Injector): StyleScheduler {
  /** 数值没有含义，只表示被请求过；effect 读取一次即建立依赖。 */
  const requested = signal(0);
  /** `Cascade` 传入的刷新回调，始终是同一个函数。 */
  let flush: (() => void) | null = null;

  effect(
    () => {
      requested();
      flush?.();
    },
    { injector },
  );

  return {
    request(fn: () => void): void {
      flush = fn;
      // untracked 是必需的。`request()` 经常在模板执行期间被调用（渲染器的 addClass、
      // setStyle 都发生在这一轮渲染内），而 Angular 禁止在渲染模板期间写入 signal，
      // 违反时抛 NG0600。这里写入的 signal 不被任何模板读取，只用于触发 effect 重新执行，
      // 因此跳过该检查不会引入「模板读取之后值又变化」那一类问题。
      untracked(() => requested.update((n) => n + 1));
    },
  };
}
