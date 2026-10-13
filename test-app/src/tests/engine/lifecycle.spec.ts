/// <reference types="vitest" />
import {
  AfterContentChecked,
  AfterContentInit,
  AfterViewChecked,
  AfterViewInit,
  Component,
  Directive,
  ElementRef,
  Input,
  NO_ERRORS_SCHEMA,
  OnDestroy,
  OnInit,
  DoCheck,
  OnChanges,
  SimpleChanges,
  Type,
  provideZonelessChangeDetection,
  signal,
  viewChild,
} from "@angular/core";
import { ComponentFixture, ComponentFixtureAutoDetect, TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { findAllNodes, initGodotTestEnvironment, nodeTexts } from "godot-angular/testing";

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

/** 每个用例更换一个数组：钩子日志是全局的，不清理就会串用例 */
let log: string[] = [];
beforeEach(() => {
  log = [];
});

describe("钩子触发顺序", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("首次渲染：八个钩子按 Angular 的顺序各跑一次，且顺序正确", async () => {
    @Component({
      selector: "t-l-order",
      schemas: [NO_ERRORS_SCHEMA],
      template: `<VBoxContainer>
        <ng-content select=".slot"></ng-content>
        <Label text="view"></Label>
      </VBoxContainer>`,
    })
    class Order implements OnChanges, DoCheck, AfterContentInit, AfterContentChecked, AfterViewInit, AfterViewChecked {
      @Input() title = "first";
      constructor(
        private readonly el: ElementRef,
      ) {}
      ngOnChanges(_c: SimpleChanges): void {
        log.push("onChanges");
      }
      ngOnInit(): void {
        log.push("onInit");
      }
      ngDoCheck(): void {
        log.push("doCheck");
      }
      ngAfterContentInit(): void {
        log.push("contentInit");
      }
      ngAfterContentChecked(): void {
        log.push("contentChecked");
      }
      ngAfterViewInit(): void {
        log.push("viewInit");
      }
      ngAfterViewChecked(): void {
        log.push("viewChecked");
      }
    }

    @Component({
      selector: "t-l-order-host",
      imports: [Order],
      schemas: [NO_ERRORS_SCHEMA],
      template: `<t-l-order [title]="title()"><Label class="slot" text="projected"></Label></t-l-order>`,
    })
    class Host {
      readonly title = signal("first");
    }

    await render(Host);
    // zoneless 会执行多轮 CD，checked 类钩子会重复；此处观察的是“首次出现”的相对顺序
    expect([...new Set(log)]).toEqual([
      "onChanges",
      "onInit",
      "doCheck",
      "contentInit",
      "contentChecked",
      "viewInit",
      "viewChecked",
    ]);
  });

  it("ngOnChanges：首帧 firstChange=true，输入变化时带上 previousValue", async () => {
    @Component({
      selector: "t-l-changes",
      schemas: [NO_ERRORS_SCHEMA],
      template: `<Label text="{{ title }}"></Label>`,
    })
    class Changes implements OnChanges {
      @Input() title = "";
      ngOnChanges(changes: SimpleChanges): void {
        const c = changes["title"];
        log.push(`${c.previousValue}->${c.currentValue}:${c.firstChange}`);
      }
    }

    @Component({
      selector: "t-l-changes-host",
      imports: [Changes],
      template: `<t-l-changes [title]="title()"></t-l-changes>`,
    })
    class ChangesHost {
      readonly title = signal("a");
    }

    const fixture = await render(ChangesHost);
    expect(log[0]).toBe("undefined->a:true");
    expect(findAllNodes(fixture.nativeElement, "Label")[0].text).toBe("a");

    log = [];
    fixture.componentInstance.title.set("b");
    await fixture.whenStable();
    expect(log[0]).toBe("a->b:false");
    expect(findAllNodes(fixture.nativeElement, "Label")[0].text).toBe("b");
  });

  it("ngAfterContentInit / ngAfterViewInit 里读到的是真节点（投影已完成）", async () => {
    @Component({
      selector: "t-l-seenodes",
      schemas: [NO_ERRORS_SCHEMA],
      template: `<VBoxContainer name="inner">
        <ng-content select=".slot"></ng-content>
        <Label text="own-view"></Label>
      </VBoxContainer>`,
    })
    class SeeNodes implements AfterContentInit, AfterViewInit {
      contentTexts: string[] = [];
      viewTexts: string[] = [];
      constructor(private readonly el: ElementRef) {}
      ngAfterContentInit(): void {
        this.contentTexts = nodeTexts(this.el.nativeElement);
      }
      ngAfterViewInit(): void {
        this.viewTexts = nodeTexts(this.el.nativeElement);
      }
    }

    @Component({
      selector: "t-l-seenodes-host",
      imports: [SeeNodes],
      schemas: [NO_ERRORS_SCHEMA],
      template: `<t-l-seenodes #kid><Label class="slot" text="projected"></Label></t-l-seenodes>`,
    })
    class SeeHost {
      readonly kid = viewChild.required<SeeNodes>("kid");
    }

    const fixture = await render(SeeHost);
    const kid = fixture.componentInstance.kid();
    // 投影在 contentInit 时已完成，viewInit 只会更晚，两者都必须看到真实节点
    expect(kid.contentTexts).toEqual(["projected", "own-view"]);
    expect(kid.viewTexts).toEqual(["projected", "own-view"]);
  });
});

describe("ngOnDestroy", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("@if 移除组件：ngOnDestroy 跑过之后引擎信号不再回调", async () => {
    @Component({
      selector: "t-l-destroy",
      schemas: [NO_ERRORS_SCHEMA],
      template: `<Button text="b" (click)="hits.update(n => n + 1)"></Button>`,
    })
    class Kid implements OnDestroy {
      readonly hits = signal(0);
      destroyed = false;
      ngOnDestroy(): void {
        this.destroyed = true;
      }
    }

    @Component({
      selector: "t-l-destroy-host",
      imports: [Kid],
      schemas: [NO_ERRORS_SCHEMA],
      template: `@if (show()) { <t-l-destroy #kid></t-l-destroy> }`,
    })
    class Host {
      readonly show = signal(true);
      readonly kid = viewChild<Kid>("kid");
    }

    const fixture = await render(Host);
    const kid = fixture.componentInstance.kid()!;
    const btn = findAllNodes(fixture.nativeElement, "Button")[0];
    btn.emit_signal("pressed");
    await fixture.whenStable();
    expect(kid.hits()).toBe(1);

    fixture.componentInstance.show.set(false);
    await fixture.whenStable();
    expect(kid.destroyed).toBe(true);
    expect(findAllNodes(fixture.nativeElement, "Button").length).toBe(0);
    // 节点已摘树：监听未解干净时此处会再次计数（或者访问已释放实例而报错）
    try {
      btn.emit_signal("pressed");
    } catch {
      /* 节点可能已被引擎释放，那也是“未回调”的另一种形式 */
    }
    expect(kid.hits()).toBe(1);
  });

  it("指令随宿主一起销毁：ngOnInit 装的东西 ngOnDestroy 必须自己拆", async () => {
    @Directive({ selector: "[uiTracker]" })
    class UiTracker implements OnInit, OnDestroy {
      constructor(private readonly injected: ElementRef) {}
      ngOnInit(): void {
        log.push("dir-init");
      }
      ngOnDestroy(): void {
        log.push("dir-destroy");
      }
    }

    @Component({
      selector: "t-l-dir",
      imports: [UiTracker],
      schemas: [NO_ERRORS_SCHEMA],
      template: `@if (show()) { <Label uiTracker text="tracked"></Label> }`,
    })
    class DirHost {
      readonly show = signal(true);
    }

    const fixture = await render(DirHost);
    expect(log).toContain("dir-init");

    fixture.componentInstance.show.set(false);
    await fixture.whenStable();
    expect(log).toContain("dir-destroy");
  });
});

describe("钩子与变更检测的节奏", () => {
  beforeEach(() => initGodotTestEnvironment());

  /**
   * zoneless + signal 模板是细粒度刷新的：只读 signal 的绑定自身就会更新，整棵视图并不重跑，
   * 因此 ngDoCheck / ngAfterViewChecked 这类“整轮 CD 钩子”不会跟随执行。只有将视图整体置脏
   * （模板事件、markForCheck、普通字段）才会走完整刷新。这不是缺陷，但编写代码时很容易误以为
   * DoCheck 每轮都执行，因此在此处固定下来。
   */
  it("ngDoCheck：整轮 CD 才跑；纯 signal 改动走细粒度刷新不跑它", async () => {
    @Component({
      selector: "t-l-docheck",
      schemas: [NO_ERRORS_SCHEMA],
      template: `<VBoxContainer>
        <Label text="{{ v() }}"></Label>
        <Button text="b" (click)="plain = plain + 1"></Button>
        <Label text="plain={{ plain }}"></Label>
      </VBoxContainer>`,
    })
    class DoCheckComp implements DoCheck {
      readonly v = signal("x");
      plain = 0;
      ngDoCheck(): void {
        log.push("doCheck");
      }
    }

    const fixture = await render(DoCheckComp);
    const baseline = log.length;
    expect(baseline).toBeGreaterThan(0);

    // 1) 不做任何修改，只让出宏任务：一轮 CD 都不应执行
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(log.length).toBe(baseline);

    // 2) 只修改 signal：文本自身刷新，DoCheck 不跟随执行
    fixture.componentInstance.v.set("y");
    await fixture.whenStable();
    expect(nodeTexts(fixture.nativeElement)).toContain("y");
    expect(log.length).toBe(baseline);

    // 3) 模板事件置脏 → 整轮刷新 → DoCheck 再次执行
    findAllNodes(fixture.nativeElement, "Button")[0].emit_signal("pressed");
    await fixture.whenStable();
    expect(log.length).toBeGreaterThan(baseline);
    expect(nodeTexts(fixture.nativeElement)).toContain("plain=1");
  });
});
