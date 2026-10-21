/// <reference types="vitest" />
/**
 * 刷新调度的契约（真引擎 + 真节点）。
 *
 * `Cascade` 只把节点标记为需要重算，重算时机由使用方传入的 `StyleScheduler` 决定。本文件
 * 逐条验证这条边界上的保证。断言一律读真实 `Label` 上的 theme override：CSS 这条链路的终点
 * 是节点属性，用假 backend 记录写入流水证明不了属性真的写进去了（见 development.md 第 7 节）。
 *
 * 覆盖：
 *   1. 一批内多次标记，执行一次回调即写入整批结果；
 *   2. 调度器未执行传入的回调时不残留「已调度」状态：下一次标记仍会调用 `request()`，
 *      显式 `flush()` 也能补写。旧实现会因此永久停止刷新，现象是某个应用首帧全无样式且
 *      永不恢复；
 *   3. `flush()` 执行期间被标记的节点（`var()` 变化会标记整棵子树）由下一次 `flush()` 处理；
 *   4. effect 调度的两种 injector：应用传入的，以及测试自己建的独立 injector
 *      （`createStyleSchedulerInjector()` + `flushStyleEffects()`，不等微任务也不等帧）；
 *   5. `scheduler` 与 `injector` 都未传入时不安排自动刷新。
 */
import { Component, EnvironmentInjector, createEnvironmentInjector, provideZonelessChangeDetection } from "@angular/core";
import { ComponentFixture, ComponentFixtureAutoDetect, TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { Label, VBoxContainer } from "godot";
import { StyleRuntime, effectStyleScheduler } from "godot-angular/core";
import type { StyleScheduler } from "godot-angular/css";
import {
  createStyleSchedulerInjector,
  flushStyleEffects,
  initGodotTestEnvironment,
  makeRenderer,
} from "godot-angular/testing";

/** 节点上的 class 集合（attach 时挂上去的 JS 属性，typings 中没有） */
function classes(node: any): Set<string> {
  const set = node.cssClasses;
  if (!(set instanceof Set)) throw new Error("节点没 attach 到级联上，cssClasses 不存在");
  return set as Set<string>;
}

/**
 * 保存回调、由用例决定何时执行的调度器。
 *
 * 这里必须自带调度器：本文件要验的前提就是「回调没有被执行」，真实的 effect 调度器总会执行
 * 它，模拟不出该场景。被测对象仍是真的 `Cascade` 与真的节点写入。
 */
function heldScheduler(): { scheduler: StyleScheduler; pending(): boolean; run(): void; drop(): void } {
  let flush: (() => void) | null = null;
  return {
    scheduler: {
      request(fn: () => void): void {
        flush = fn;
      },
    },
    pending: () => flush !== null,
    run(): void {
      const fn = flush;
      flush = null;
      fn?.();
    },
    /** 丢弃当前保存的回调，模拟调度器未执行它 */
    drop(): void {
      flush = null;
    },
  };
}

let root: any;

beforeEach(() => {
  initGodotTestEnvironment();
  root = makeRenderer().root;
});

/** 建一个真 Label，挂进场景树并登记到级联 */
function makeLabel(runtime: StyleRuntime, name: string, parent?: any): any {
  const node = new Label();
  node.set_name(name);
  (parent ?? root).add_child(node);
  runtime.attach(node);
  return node;
}

/** 建一个真 VBoxContainer 作为父节点（var() 继承需要真实的父子关系） */
function makeBox(runtime: StyleRuntime, name: string): any {
  const node = new VBoxContainer();
  node.set_name(name);
  root.add_child(node);
  runtime.attach(node);
  return node;
}

describe("调度契约（真节点）", () => {
  it("一批内标记多个节点，执行一次回调写入整批结果", () => {
    const held = heldScheduler();
    const runtime = new StyleRuntime({ scheduler: held.scheduler });
    runtime.addCss(`Label { color: rgb(255, 0, 0); }`);
    const labels = [makeLabel(runtime, "a"), makeLabel(runtime, "b"), makeLabel(runtime, "c")];

    for (const node of labels) classes(node).add("x");
    runtime.cascade.setInline(labels[0], "font-size", "30px");
    runtime.cascade.invalidateAll();

    // 回调未执行前，节点上没有任何覆盖
    expect(labels[0].has_theme_color_override("font_color")).toBe(false);
    expect(labels[2].has_theme_color_override("font_color")).toBe(false);

    held.run();

    for (const node of labels) expect(node.get_theme_color("font_color").r).toBeCloseTo(1, 3);
    expect(labels[0].get_theme_font_size("font_size")).toBe(30);
    expect(held.pending()).toBe(false);
  });

  it("回调未被执行不会残留已调度状态：下一次标记仍会调用 request()", () => {
    const held = heldScheduler();
    const runtime = new StyleRuntime({ scheduler: held.scheduler });
    runtime.addCss(`Label { color: rgb(0, 255, 0); }`);
    const node = makeLabel(runtime, "n");

    held.drop(); // attach 请求的那次回调未被执行
    runtime.cascade.invalidateAll();
    expect(node.has_theme_color_override("font_color")).toBe(false);
    expect(runtime.cascade.isDirty(node)).toBe(true);

    // 关键：被丢弃的回调没有留下"已调度"状态，本次标记又拿到了可执行的回调
    expect(held.pending()).toBe(true);

    held.run();
    expect(node.get_theme_color("font_color").g).toBeCloseTo(1, 3);
    expect(runtime.cascade.isDirty(node)).toBe(false);
  });

  it("回调未被执行时，显式 flush() 仍能完成写入", () => {
    const held = heldScheduler();
    const runtime = new StyleRuntime({ scheduler: held.scheduler });
    runtime.addCss(`Label { color: rgb(0, 255, 0); }`);
    const node = makeLabel(runtime, "n");

    held.drop();
    runtime.flush();
    expect(node.get_theme_color("font_color").g).toBeCloseTo(1, 3);
    expect(runtime.cascade.isDirty(node)).toBe(false);
  });

  it("flush 执行期间被标记的子节点由下一次 flush 处理", () => {
    // --brand 定义在父节点上，子节点用 var() 引用它：父节点更换变量值时，子节点是在
    // applyNode 内才被标记的，而本次 flush() 已将队列取空 → 必须重新调用 request()
    const held = heldScheduler();
    const runtime = new StyleRuntime({ scheduler: held.scheduler });
    runtime.addCss(`.brand-a { --brand: rgb(255, 0, 0); } .brand-b { --brand: rgb(0, 0, 255); }`);
    runtime.addCss(`.child { color: var(--brand); }`);
    const parent = makeBox(runtime, "p");
    const child = makeLabel(runtime, "c", parent);
    // class 必须在 attach 之后写（attach 会换上会通知的 class 集合，旧内容不迁移）
    classes(parent).add("brand-a");
    classes(child).add("child");
    held.run();
    expect(child.get_theme_color("font_color").r).toBeCloseTo(1, 3);

    classes(parent).delete("brand-a");
    classes(parent).add("brand-b");
    // 连续执行直到没有待执行回调（最多 5 轮，仍有则说明未收敛）
    let rounds = 0;
    while (held.pending() && rounds < 5) {
      rounds++;
      held.run();
    }
    expect(child.get_theme_color("font_color").b).toBeCloseTo(1, 3);
    expect(rounds).toBeLessThan(5);
  });

  it("调度器不执行回调时不会自动写入，只能显式 flush()", () => {
    const runtime = new StyleRuntime({ scheduler: { request: () => {} } });
    runtime.addCss(`Label { color: rgb(255, 0, 0); }`);
    const node = makeLabel(runtime, "n");

    expect(node.has_theme_color_override("font_color")).toBe(false);

    runtime.flush();
    expect(node.has_theme_color_override("font_color")).toBe(true);
  });

  it("request 内立即执行回调的调度器不会导致重复进入 flush", () => {
    // 同步执行的调度器会让 flush() 在执行期间被再次调用，`flushing` 保护必须挡住它，
    // 否则这里会栈溢出；同时 var() 继承的结果仍要正确
    const runtime = new StyleRuntime({ scheduler: { request: (flush) => flush() } });
    runtime.addCss(`.brand-a { --brand: rgb(255, 0, 0); } .brand-b { --brand: rgb(0, 0, 255); }`);
    runtime.addCss(`.child { color: var(--brand); }`);
    const parent = makeBox(runtime, "p");
    const child = makeLabel(runtime, "c", parent);
    classes(parent).add("brand-a");
    classes(child).add("child");
    expect(child.get_theme_color("font_color").r).toBeCloseTo(1, 3);

    classes(parent).delete("brand-a");
    classes(parent).add("brand-b");
    expect(child.get_theme_color("font_color").b).toBeCloseTo(1, 3);
  });
});

describe("独立 injector 调度（Angular 之外）", () => {
  it("一批内多次 request 只执行一次 flush", () => {
    const injector = createStyleSchedulerInjector();
    const scheduler = effectStyleScheduler(injector);
    let runs = 0;
    const flush = () => {
      runs++;
    };

    scheduler.request(flush);
    scheduler.request(flush);
    scheduler.request(flush);
    expect(runs).toBe(0); // 同步代码内不执行

    flushStyleEffects(injector);
    expect(runs).toBe(1);
  });

  it("flush 执行期间再次 request 会在同一次 flush 内继续执行", () => {
    const injector = createStyleSchedulerInjector();
    const scheduler = effectStyleScheduler(injector);
    const order: string[] = [];
    let depth = 0;
    const flush = () => {
      order.push(`run${depth}`);
      if (depth++ < 2) scheduler.request(flush);
    };

    scheduler.request(flush);
    flushStyleEffects(injector);
    expect(order).toEqual(["run0", "run1", "run2"]);
  });

  it("传入独立 injector 的 StyleRuntime：flushStyleEffects 后写入真节点", () => {
    const injector = createStyleSchedulerInjector();
    const runtime = new StyleRuntime({ injector });
    runtime.addCss(`Label { color: rgb(255, 0, 0); }`);
    const node = makeLabel(runtime, "n");
    classes(node).add("x");

    expect(node.has_theme_color_override("font_color")).toBe(false);

    flushStyleEffects(injector);
    expect(node.get_theme_color("font_color").r).toBeCloseTo(1, 3);
  });

  it("scheduler 与 injector 都未传入时不自动刷新，只能显式 flush()", () => {
    // `new StyleRuntime()` 与 `defaultStyleRuntime()` 就是这种配置：节点仍会被标记，
    // 但没有谁去执行刷新，用例必须自己调 flush()
    const runtime = new StyleRuntime();
    runtime.addCss(`Label { color: rgb(255, 0, 0); }`);
    const node = makeLabel(runtime, "n");
    classes(node).add("x");

    expect(node.has_theme_color_override("font_color")).toBe(false);

    runtime.flush();
    expect(node.get_theme_color("font_color").r).toBeCloseTo(1, 3);
  });
});

describe("effect 调度（真 injector）", () => {
  @Component({
    selector: "t-probe",
    template: `<Label name="probe">hi</Label>`,
  })
  class ProbeComp {}

  async function renderProbe(): Promise<ComponentFixture<ProbeComp>> {
    await TestBed.configureTestingModule({
      imports: [ProbeComp],
      providers: [{ provide: ComponentFixtureAutoDetect, useValue: true }, provideZonelessChangeDetection()],
    }).compileComponents();
    const fixture = TestBed.createComponent(ProbeComp);
    await fixture.whenStable();
    return fixture;
  }

  it("一批内多次 request 只执行一次 flush", async () => {
    const fixture = await renderProbe();
    const injector = createEnvironmentInjector([], TestBed.inject(EnvironmentInjector));
    const scheduler = effectStyleScheduler(injector);
    let runs = 0;
    const flush = () => {
      runs++;
    };

    scheduler.request(flush);
    scheduler.request(flush);
    scheduler.request(flush);
    expect(runs).toBe(0); // 同步代码内不执行

    await fixture.whenStable();
    expect(runs).toBe(1);
    injector.destroy();
  });

  it("injector 销毁后 flush 不再执行：不会有回调写入已销毁的应用", async () => {
    const fixture = await renderProbe();
    const injector = createEnvironmentInjector([], TestBed.inject(EnvironmentInjector));
    const scheduler = effectStyleScheduler(injector);
    let runs = 0;
    const flush = () => {
      runs++;
    };

    scheduler.request(flush);
    await fixture.whenStable();
    const before = runs;
    expect(before).toBeGreaterThan(0);

    injector.destroy();
    scheduler.request(flush);
    await fixture.whenStable();
    await fixture.whenStable();
    expect(runs).toBe(before);
  });
});
