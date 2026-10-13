/// <reference types="vitest" />
import {
  Component,
  ElementRef,
  EventEmitter,
  Input,
  NO_ERRORS_SCHEMA,
  Output,
  Type,
  provideZonelessChangeDetection,
  signal,
  viewChild,
  viewChildren,
} from "@angular/core";
import { ComponentFixture, ComponentFixtureAutoDetect, TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { Color, Label } from "godot";
import {
  awaitFrames,
  findAllNodes,
  initGodotTestEnvironment,
  nodeTexts,
} from "godot-angular/testing";
import { bootstrapGodotApp } from "godot-angular/core";

/**
 * Angular 组件在真实引擎中运行，写法就是标准 TestBed。区别仅在于 `nativeElement` 是引擎的
 * `Control`，因此能验证 Node 中无法验证的内容：viewChild 获取的是否为真实节点、销毁时信号是否
 * 真的解绑、真实 CD 路径。
 *
 * 两条约束：状态一律使用 signal（普通字段的自动刷新不在保证范围内）；断言前 Act / Wait /
 * Assert，zoneless 将 CD 排在宏任务上，同步块内等不到那一轮。
 */

/** 标准形状：configureTestingModule(+autoDetect/zoneless) → createComponent → whenStable */
async function render<T>(component: Type<T>): Promise<ComponentFixture<T>> {
  await TestBed.configureTestingModule({
    imports: [component],
    providers: [
      { provide: ComponentFixtureAutoDetect, useValue: true },
      provideZonelessChangeDetection(),
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(component);
  await fixture.whenStable();
  return fixture;
}

describe("viewChild 信号查询映射到真节点", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("viewChild.required() 拿到的是引擎真实 Control，能直接读属性", async () => {
    @Component({
      selector: "t-vc",
      schemas: [NO_ERRORS_SCHEMA],
      template: `<Label #lbl text="vc-text"></Label>`,
    })
    class VcComp {
      lbl = viewChild.required<ElementRef>("lbl");
    }

    const fixture = await render(VcComp);
    const node = fixture.componentInstance.lbl().nativeElement;
    expect(node.get_class()).toBe("Label");
    expect(node.text).toBe("vc-text");
    // 必须是引擎真实节点，而不是替身：queue_free 后引擎会标记待删
    expect(node.is_queued_for_deletion()).toBe(false);
  });

  it("viewChild() 非必需版在节点不存在时给 undefined", async () => {
    @Component({
      selector: "t-vc-opt",
      schemas: [NO_ERRORS_SCHEMA],
      template: `@if (show()) { <Label #lbl text="here"></Label> }`,
    })
    class OptComp {
      show = signal(true);
      lbl = viewChild<ElementRef>("lbl");
    }

    const fixture = await render(OptComp);
    expect(fixture.componentInstance.lbl()).toBeTruthy();
    fixture.componentInstance.show.set(false);
    await fixture.whenStable();
    expect(fixture.componentInstance.lbl()).toBeUndefined();
  });

  it("viewChildren() 拿到多个真节点，顺序与模板一致", async () => {
    @Component({
      selector: "t-vc-list",
      schemas: [NO_ERRORS_SCHEMA],
      template: `<VBoxContainer>
        <Label #row text="r1"></Label>
        <Label #row text="r2"></Label>
        <Label #row text="r3"></Label>
      </VBoxContainer>`,
    })
    class ListComp {
      rows = viewChildren<ElementRef>("row");
    }

    const fixture = await render(ListComp);
    const nodes = fixture.componentInstance.rows().map((r) => r.nativeElement);
    expect(nodes.length).toBe(3);
    expect(nodes.map((n: any) => n.text)).toEqual(["r1", "r2", "r3"]);
  });
});

describe("真实变更检测路径", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("Godot 信号 → signal 写入 → 稳定后节点文本更新", async () => {
    @Component({
      selector: "t-cd",
      schemas: [NO_ERRORS_SCHEMA],
      template: `<VBoxContainer>
        <Button text="b" (click)="count.update(n => n + 1)"></Button>
        <Label text="count={{ count() }}"></Label>
      </VBoxContainer>`,
    })
    class CdComp {
      readonly count = signal(0);
    }

    const fixture = await render(CdComp);
    const button = findAllNodes(fixture.nativeElement, "Button")[0];
    const label = findAllNodes(fixture.nativeElement, "Label")[0];

    expect(label.text).toBe("count=0");

    // Act：引擎信号 → 事件处理器写 signal
    button.emit_signal("pressed");
    // zoneless 不会同步刷新，此处读到的一定仍是旧值
    expect(label.text).toBe("count=0");
    // Wait：让框架将已排队的更新执行完（走 zoneless 自身的那一轮，不强制 CD）
    await fixture.whenStable();
    expect(label.text).toBe("count=1");

    // 连续点击两次：一次稳定内必须全部刷新出来，不能只反映一次
    button.emit_signal("pressed");
    button.emit_signal("pressed");
    await fixture.whenStable();
    expect(label.text).toBe("count=3");
  });

  it("signal 变化不会同步反映，等一轮稳定才落到节点", async () => {
    @Component({
      selector: "t-sig",
      schemas: [NO_ERRORS_SCHEMA],
      template: `<Label text="{{ v() }}"></Label>`,
    })
    class SigComp {
      v = signal("a");
    }

    const fixture = await render(SigComp);
    expect(nodeTexts(fixture.nativeElement)).toContain("a");
    fixture.componentInstance.v.set("b");
    await fixture.whenStable();
    expect(nodeTexts(fixture.nativeElement)).toContain("b");
  });

  it("引擎真帧不跑变更检测：静止时零成本，改动靠 zoneless 自己那轮刷", async () => {
    let checks = 0;
    @Component({
      selector: "t-idle",
      schemas: [NO_ERRORS_SCHEMA],
      template: `<Label text="{{ v() }}"></Label>`,
    })
    class IdleComp {
      v = signal("idle");
      ngDoCheck(): void {
        checks++;
      }
    }

    const fixture = await render(IdleComp);
    await fixture.whenStable();
    const baseline = checks;
    expect(baseline).toBeGreaterThan(0);

    // 不做任何修改，让引擎真实运行 10 帧（每帧都在泵 rAF）：一次 CD 都不应执行。
    // 帧由引擎自身驱动，不是测试驱动的。
    await awaitFrames(10);
    expect(checks).toBe(baseline);

    // 确实修改就必须刷新出来——依赖的是 zoneless 排的那一轮，而不是帧泵
    fixture.componentInstance.v.set("changed");
    await fixture.whenStable();
    expect(nodeTexts(fixture.nativeElement)).toContain("changed");
  });

  it("什么都不驱动，只让出一个宏任务，zoneless 自己也能把 CD 跑起来", async () => {
    @Component({
      selector: "t-micro",
      schemas: [NO_ERRORS_SCHEMA],
      template: `<Label text="{{ v() }}"></Label>`,
    })
    class MicroComp {
      v = signal("a");
    }

    const fixture = await render(MicroComp);
    expect(nodeTexts(fixture.nativeElement)).toContain("a");

    // 关键：一次都不驱动，只将事件循环让出。Angular 的调度器就挂在那里。
    fixture.componentInstance.v.set("b");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(nodeTexts(fixture.nativeElement)).toContain("b");
  });

  /**
   * 记录行为，不是契约：Angular 为模板事件监听包裹了 markViewDirty，因此普通字段经模板
   * 回调也能刷新。不应如此编写——置脏依赖于“改动来自模板监听”这个前提，引擎回调 / 定时器 /
   * WS 消息那些路径 Angular 完全不可见，普通字段就会静默不刷新。
   */
  it("普通字段 + 模板回调也会置脏（能刷，但别这么写）", async () => {
    @Component({
      selector: "t-plain",
      schemas: [NO_ERRORS_SCHEMA],
      template: `<VBoxContainer>
        <Button text="p" (click)="hits = hits + 1"></Button>
        <Label text="hits={{ hits }}"></Label>
      </VBoxContainer>`,
    })
    class PlainComp {
      hits = 0;
    }

    const fixture = await render(PlainComp);
    const label = findAllNodes(fixture.nativeElement, "Label")[0];
    expect(label.text).toBe("hits=0");

    // 全程不驱动，只让出一个宏任务：能刷新 → 证明置脏发生在监听包装内，不依赖外部驱动
    findAllNodes(fixture.nativeElement, "Button")[0].emit_signal("pressed");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(label.text).toBe("hits=1");
  });

  /**
   * 上一例的反面：引擎回调 / 定时器 / WS 消息中修改普通字段，Angular 完全不知情，
   * 没有任何机制替它置脏——等待多久都不刷新且不报错，静默失效。
   */
  it("普通字段从外部改：不置脏就永远不刷（静默失效）", async () => {
    @Component({
      selector: "t-outside",
      schemas: [NO_ERRORS_SCHEMA],
      template: `<Label text="{{ v }}"></Label>`,
    })
    class OutsideComp {
      v = "a";
      /** 模拟引擎回调内赋值：Angular 不可见这一步 */
      bump(): void {
        this.v = "b";
      }
    }

    const fixture = await render(OutsideComp);
    const label = findAllNodes(fixture.nativeElement, "Label")[0];
    expect(label.text).toBe("a");

    fixture.componentInstance.bump();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(label.text).toBe("a");
    // Angular 自己那一轮也走完仍未刷新：未置脏 → dirtyFlags 门控直接跳过 CD
    await fixture.whenStable();
    expect(label.text).toBe("a");
  });
});

describe("销毁与信号解绑", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("@if 移除子组件后再加回来，不报错且功能正常", async () => {
    @Component({
      selector: "t-kid",
      schemas: [NO_ERRORS_SCHEMA],
      template: `<Button text="k" (click)="hits.update(n => n + 1)"></Button>`,
    })
    class Kid {
      readonly hits = signal(0);
    }

    @Component({
      selector: "t-host",
      imports: [Kid],
      schemas: [NO_ERRORS_SCHEMA],
      template: `@if (show()) { <t-kid></t-kid> }`,
    })
    class Host {
      show = signal(true);
    }

    const fixture = await render(Host);
    expect(findAllNodes(fixture.nativeElement, "Button").length).toBe(1);

    fixture.componentInstance.show.set(false);
    await fixture.whenStable();
    expect(findAllNodes(fixture.nativeElement, "Button").length).toBe(0);

    // 重新挂载：若销毁时未解绑干净，此处会残留旧 Callable 或直接报错
    fixture.componentInstance.show.set(true);
    await fixture.whenStable();
    const btn = findAllNodes(fixture.nativeElement, "Button")[0];
    expect(btn).toBeTruthy();
    btn.emit_signal("pressed");
    await fixture.whenStable();
    expect(findAllNodes(fixture.nativeElement, "Button").length).toBe(1);
  });

  it("投影（ng-content select）只投影匹配的节点", async () => {
    @Component({
      selector: "t-card",
      schemas: [NO_ERRORS_SCHEMA],
      template: `<PanelContainer><VBoxContainer>
        <Label text="head"></Label>
        <ng-content select=".body"></ng-content>
      </VBoxContainer></PanelContainer>`,
    })
    class Card {}

    @Component({
      selector: "t-card-host",
      imports: [Card],
      schemas: [NO_ERRORS_SCHEMA],
      template: `<t-card>
        <Label class="body" text="projected-body"></Label>
        <Label text="not-projected"></Label>
      </t-card>`,
    })
    class Host {}

    const fixture = await render(Host);
    const texts = nodeTexts(fixture.nativeElement);
    expect(texts).toContain("head");
    expect(texts).toContain("projected-body");
    expect(texts).not.toContain("not-projected");
  });

  it("@for 重排（track by id）后节点顺序跟着变", async () => {
    @Component({
      selector: "t-for",
      schemas: [NO_ERRORS_SCHEMA],
      template: `@for (row of rows(); track row.id) { <Label text="{{ row.name }}"></Label> }`,
    })
    class ForComp {
      rows = signal([
        { id: 1, name: "one" },
        { id: 2, name: "two" },
        { id: 3, name: "three" },
      ]);
    }

    const fixture = await render(ForComp);
    expect(nodeTexts(fixture.nativeElement)).toEqual(["one", "two", "three"]);

    fixture.componentInstance.rows.set([
      { id: 3, name: "three" },
      { id: 1, name: "one" },
      { id: 2, name: "two" },
    ]);
    await fixture.whenStable();
    expect(nodeTexts(fixture.nativeElement)).toEqual(["three", "one", "two"]);
  });

  it("@for 相邻两项对调：往后挪的那次移动也要落在正确位置", async () => {
    @Component({
      selector: "t-for-swap",
      schemas: [NO_ERRORS_SCHEMA],
      template: `@for (row of rows(); track row.id) { <Label text="{{ row.name }}"></Label> }`,
    })
    class ForSwapComp {
      rows = signal([
        { id: 1, name: "one" },
        { id: 2, name: "two" },
        { id: 3, name: "three" },
      ]);
    }

    const fixture = await render(ForSwapComp);
    fixture.componentInstance.rows.set([
      { id: 2, name: "two" },
      { id: 1, name: "one" },
      { id: 3, name: "three" },
    ]);
    await fixture.whenStable();
    expect(nodeTexts(fixture.nativeElement)).toEqual(["two", "one", "three"]);

    fixture.componentInstance.rows.set([
      { id: 1, name: "one" },
      { id: 3, name: "three" },
      { id: 2, name: "two" },
    ]);
    await fixture.whenStable();
    expect(nodeTexts(fixture.nativeElement)).toEqual(["one", "three", "two"]);
  });
});

describe("输入输出", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("@Output 经 EventEmitter 冒到父模板（真引擎信号链）", async () => {
    @Component({
      selector: "t-emit",
      schemas: [NO_ERRORS_SCHEMA],
      template: `<Button text="b" (click)="fired.emit('go')"></Button>`,
    })
    class Kid {
      @Output() fired = new EventEmitter<string>();
    }

    @Component({
      selector: "t-emit-host",
      imports: [Kid],
      schemas: [NO_ERRORS_SCHEMA],
      template: `<t-emit (fired)="last = $any($event)"></t-emit>`,
    })
    class Host {
      last = "";
    }

    const fixture = await render(Host);
    findAllNodes(fixture.nativeElement, "Button")[0].emit_signal("pressed");
    await fixture.whenStable();
    expect(fixture.componentInstance.last).toBe("go");
  });

  it("@Input 把值传到子组件并写进真节点", async () => {
    @Component({
      selector: "t-child",
      schemas: [NO_ERRORS_SCHEMA],
      template: `<Label text="{{ title }}"></Label>`,
    })
    class Kid {
      @Input() title = "";
    }

    @Component({
      selector: "t-child-host",
      imports: [Kid],
      schemas: [NO_ERRORS_SCHEMA],
      template: `<t-child [title]="t()"></t-child>`,
    })
    class Host {
      t = signal("first");
    }

    const fixture = await render(Host);
    expect(nodeTexts(fixture.nativeElement)).toContain("first");
    fixture.componentInstance.t.set("second");
    await fixture.whenStable();
    expect(nodeTexts(fixture.nativeElement)).toContain("second");
  });
});

/**
 * null 与撤销。渲染器是内部件，不该按公开 API 那样直接调：null 从哪来由 Angular 决定，
 * 因此全部从模板进来。只有三条路：
 *   [x]="null"       → setProperty(name, null)
 *   [attr.x]="null"  → removeAttribute(name)
 *   text="{{ x }}"   → Angular 将 null 串成空串，渲染器收不到 null
 *
 * 落地的值一律是“该类新建时的默认值”：Godot 属性强类型，写 null 会被引擎当场拒掉
 * （set_text / set_modulate 直接报错），引用型属性（theme）的默认恰好就是 null。
 * undefined 与 null 在 GodotJS 里结果相同（值类型一样翻脸），因此拦的是 value == null。
 */
describe("null 与撤销：Angular 真正递下来的那几种", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("[text]=\"null\"：属性绑定递来 null，节点回到默认而不是被引擎拒掉", async () => {
    @Component({
      selector: "t-null-text",
      template: `<Label [text]="t()"></Label>`,
    })
    class NullTextComp {
      t = signal<string | null>("hello");
    }

    const fixture = await render(NullTextComp);
    const label = findAllNodes(fixture.nativeElement, "Label")[0];
    expect(label.text).toBe("hello");

    fixture.componentInstance.t.set(null);
    await fixture.whenStable();
    expect(label.text).toBe("");
  });

  it("[text]=undefined：与 null 同一条路（GodotJS 对 undefined 一样翻脸）", async () => {
    @Component({
      selector: "t-undef-text",
      template: `<Label [text]="t()"></Label>`,
    })
    class UndefTextComp {
      t = signal<string | undefined>("hello");
    }

    const fixture = await render(UndefTextComp);
    const label = findAllNodes(fixture.nativeElement, "Label")[0];
    expect(label.text).toBe("hello");

    fixture.componentInstance.t.set(undefined);
    await fixture.whenStable();
    expect(label.text).toBe("");
  });

  it("[attr.text] 从有值到 null：走 removeAttribute，同样回到默认", async () => {
    @Component({
      selector: "t-null-attr",
      template: `<Label [attr.text]="t()"></Label>`,
    })
    class NullAttrComp {
      t = signal<string | null>("hello");
    }

    const fixture = await render(NullAttrComp);
    const label = findAllNodes(fixture.nativeElement, "Label")[0];
    expect(label.text).toBe("hello");

    fixture.componentInstance.t.set(null);
    await fixture.whenStable();
    expect(label.text).toBe("");
  });

  it("[modulate]=\"null\"：颜色回到白色（写 null 会被折成黑色，那条路被避开）", async () => {
    @Component({
      selector: "t-null-color",
      template: `<Label [modulate]="c()" text="tinted"></Label>`,
    })
    class NullColorComp {
      c = signal<Color | null>(new Color(1, 0, 0, 1));
    }

    const fixture = await render(NullColorComp);
    const label = findAllNodes(fixture.nativeElement, "Label")[0];
    expect(label.modulate.r).toBeCloseTo(1);

    fixture.componentInstance.c.set(null);
    await fixture.whenStable();
    expect(label.modulate.r).toBeCloseTo(1);
    expect(label.modulate.g).toBeCloseTo(1);
  });

  it("[size_flags]=\"null\"：横竖两个一起回到新建时的默认", async () => {
    @Component({
      selector: "t-null-flags",
      template: `<Label [size_flags]="f()"></Label>`,
    })
    class NullFlagsComp {
      f = signal<number | null>(3);
    }

    const fixture = await render(NullFlagsComp);
    const label = findAllNodes(fixture.nativeElement, "Label")[0];
    expect(label.size_flags_horizontal).toBe(3);
    expect(label.size_flags_vertical).toBe(3);

    fixture.componentInstance.f.set(null);
    await fixture.whenStable();
    const fresh = new Label();
    expect(label.size_flags_horizontal).toBe(fresh.size_flags_horizontal);
    expect(label.size_flags_vertical).toBe(fresh.size_flags_vertical);
    fresh.free();
  });

  it("size_flags=\"3\" 静态写法（字符串）也落到横竖两个", async () => {
    @Component({ selector: "t-static-flags", template: `<Label size_flags="3"></Label>` })
    class StaticFlagsComp {}

    const fixture = await render(StaticFlagsComp);
    const label = findAllNodes(fixture.nativeElement, "Label")[0];
    expect(label.size_flags_horizontal).toBe(3);
    expect(label.size_flags_vertical).toBe(3);
  });

  it("[anchors_preset] 递来 null：回到默认 preset（它没有 setter）", async () => {
    // 不能用 <Control>：根组件的宿主就是测试根（selectRootElement 递回入口 root），
    // findAllNodes 含自身，会先拿到那个 Control。
    @Component({
      selector: "t-null-preset",
      template: `<PanelContainer [anchors_preset]="p()"></PanelContainer>`,
    })
    class NullPresetComp {
      p = signal<number | null>(8); // 8 = PRESET_CENTER
    }

    const fixture = await render(NullPresetComp);
    const box = findAllNodes(fixture.nativeElement, "PanelContainer")[0];
    expect(box.anchor_left).toBeCloseTo(0.5);

    fixture.componentInstance.p.set(null);
    await fixture.whenStable();
    expect(box.anchor_left).toBeCloseTo(0);
    expect(box.anchor_top).toBeCloseTo(0);
  });

  it("[attr.class]=\"null\"：class 有自己的通道，递来 null 就是清空", async () => {
    @Component({
      selector: "t-null-class",
      template: `<Label [attr.class]="c()" text="x"></Label>`,
    })
    class NullClassComp {
      c = signal<string | null>("a b");
    }

    const fixture = await render(NullClassComp);
    const label = findAllNodes(fixture.nativeElement, "Label")[0] as unknown as {
      cssClasses: Set<string>;
    };
    expect(label.cssClasses.size).toBe(2);

    fixture.componentInstance.c.set(null);
    await fixture.whenStable();
    expect(label.cssClasses.size).toBe(0);
  });

  it("[attr.不存在的名字]=\"null\"：静默忽略，不拖坏同一轮里的其它绑定", async () => {
    @Component({
      selector: "t-null-unknown",
      template: `<Label [attr.text]="t()" [attr.nonexistent_xyz]="null"></Label>`,
    })
    class NullUnknownComp {
      t = signal<string | null>("hello");
    }

    const fixture = await render(NullUnknownComp);
    const label = findAllNodes(fixture.nativeElement, "Label")[0];
    expect(label.text).toBe("hello");

    fixture.componentInstance.t.set(null);
    await fixture.whenStable();
    expect(label.text).toBe("");
  });

  it("插值里的 null 由 Angular 串成空串，渲染器收不到 null", async () => {
    @Component({
      selector: "t-null-interp",
      template: `<Label text="{{ t() }}"></Label>`,
    })
    class NullInterpComp {
      t = signal<string | null>(null);
    }

    const fixture = await render(NullInterpComp);
    expect(findAllNodes(fixture.nativeElement, "Label")[0].text).toBe("");
  });
});

/** 这一组不走 TestBed，直接 `bootstrapGodotApp`：`GodotAngularApp` 是生产 API，验证的是
 * 帧泵跟随应用生命周期。必须放在文件最后且结尾保留一个存活的 app——`destroy()` 会停止帧泵，
 * 影响后面的文件。 */
describe("GodotAngularApp 生命周期（生产 API）", () => {
  it("destroy 后 tick 不抛错、rAF 被拒；新应用把帧泵开回来", async () => {
    @Component({ selector: "t-life", template: `<Label text="x"></Label>` })
    class LifeComp {}

    const root1 = initGodotTestEnvironment();
    const app = await bootstrapGodotApp(LifeComp, root1);
    app.tick(16);
    app.destroy();
    expect(() => app.tick(16)).not.toThrow();
    // 销毁后注册直接被拒（-1），不会携带到下一个应用头上集体复活
    expect(globalThis.requestAnimationFrame(() => {})).toBe(-1);

    // 新应用 bootstrap 时 start() 会重新启动帧泵；此处不保留 destroy，见文件尾注
    const root2 = initGodotTestEnvironment();
    const app2 = await bootstrapGodotApp(LifeComp, root2);
    let ran = false;
    expect(globalThis.requestAnimationFrame(() => (ran = true))).toBeGreaterThan(0);
    // 句柄 > 0 只说明“收下了”，跳一帧确认回调真被放行，否则“帧泵开回来”这句话没被验证
    app2.tick(16);
    expect(ran, "帧泵没恢复：rAF 注册成功但回调没被放行").toBe(true);
  });
});
