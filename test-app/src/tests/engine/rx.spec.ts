/// <reference types="vitest" />
// godotSignal$：把 Godot 信号包成 RxJS 流。
// 覆盖：真实信号、退订断开、多订阅、参数透传、事件名别名、解析失败报错、节点已释放时退订。
import { beforeEach, describe, expect, it } from "vitest";
import { Button, Node, Timer } from "godot";
import { first, take } from "rxjs";
import { godotSignal$ } from "godot-angular/core";
import { initGodotTestEnvironment, awaitFrames, getEngineSceneRoot } from "godot-angular/testing";

/**
 * 无头引擎一帧可能远快于 1/60 秒，所以"等固定帧数"不足以跨过定时器的等待时间。
 * 这里按条件轮询：条件成立就返回，最多等 maxFrames 帧。
 */
async function waitUntil(predicate: () => boolean, maxFrames = 120): Promise<boolean> {
  for (let i = 0; i < maxFrames; i++) {
    if (predicate()) return true;
    await awaitFrames(1);
  }
  return predicate();
}

/** 建一个周期很短的 Timer 并挂到 parent 下 */
function fastTimer(parent: Node, oneShot: boolean): Timer {
  const timer = new Timer();
  timer.wait_time = 0.01;
  timer.one_shot = oneShot;
  parent.add_child(timer);
  return timer;
}

describe("godotSignal$", () => {
  let root: Node;

  beforeEach(() => {
    initGodotTestEnvironment();
    root = new Node();
    root.set_name("RxRoot");
    getEngineSceneRoot()!.add_child(root);
  });

  it("Timer.timeout 触发时流出一个空参数数组", async () => {
    const timer = fastTimer(root, true);
    const seen: unknown[][] = [];
    godotSignal$(timer, "timeout").subscribe((args) => seen.push(args));
    timer.start();

    expect(await waitUntil(() => seen.length > 0)).toBe(true);
    expect(seen[0]).toEqual([]);
  });

  it("退订之后不再收到事件", async () => {
    const timer = fastTimer(root, false);
    let count = 0;
    const sub = godotSignal$(timer, "timeout").subscribe(() => count++);
    timer.start();

    expect(await waitUntil(() => count > 0)).toBe(true);
    sub.unsubscribe();
    const before = count;
    await awaitFrames(20);

    expect(count).toBe(before);
  });

  it("同一条流可以有多个订阅者，各自独立退订", async () => {
    const timer = fastTimer(root, false);
    let a = 0;
    let b = 0;
    const stream = godotSignal$(timer, "timeout");
    const subA = stream.subscribe(() => a++);
    const subB = stream.subscribe(() => b++);
    timer.start();

    expect(await waitUntil(() => a > 0)).toBe(true);
    subA.unsubscribe();
    const aFrozen = a;
    expect(await waitUntil(() => b > aFrozen)).toBe(true);
    expect(a).toBe(aFrozen);
    subB.unsubscribe();
  });

  it("信号参数按数组透传（node_added 带一个 Node）", async () => {
    const tree = root.get_tree()!;
    const seen: unknown[][] = [];
    const sub = godotSignal$<[Node]>(tree, "node_added").subscribe((args) => seen.push(args));

    const child = new Node();
    child.set_name("RxChildArgs");
    root.add_child(child);

    expect(seen.some((args) => args.length === 1 && args[0] === child)).toBe(true);
    sub.unsubscribe();
  });

  it("事件名可以写 DOM 风格：Button 的 click 解析为 pressed", async () => {
    const button = new Button();
    button.set_name("RxButton");
    root.add_child(button);

    const pending = godotSignal$(button, "click").pipe(first()).toPromise();
    // 必须先订阅再触发：first() 在事件之前拿到值才有意义
    button.emit_signal("pressed");

    expect(await pending).toEqual([]);
  });

  it("解析不到信号名时以 error 结束，不静默变空流", () => {
    let message = "";
    godotSignal$(root, "no_such_signal_here").subscribe({
      next: () => {},
      error: (err: Error) => {
        message = err.message;
      },
    });

    expect(message).toContain("no_such_signal_here");
    expect(message).toContain("Node");
  });

  it("节点已被 free 时退订不抛异常", () => {
    const timer = fastTimer(root, false);
    const sub = godotSignal$(timer, "timeout").subscribe(() => {});
    timer.free();

    expect(() => sub.unsubscribe()).not.toThrow();
  });

  it("操作符可直接串联（take 收满即完成并自动断开）", async () => {
    const timer = fastTimer(root, false);
    const seen: unknown[][] = [];
    godotSignal$(timer, "timeout")
      .pipe(take(2))
      .subscribe({ next: (v) => seen.push(v), complete: () => seen.push(["done"]) });
    timer.start();

    expect(await waitUntil(() => seen.length >= 3)).toBe(true);
    expect(seen.length).toBe(3);
    expect(seen[2]).toEqual(["done"]);
  });
});
