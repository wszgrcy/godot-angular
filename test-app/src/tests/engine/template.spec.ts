/// <reference types="vitest" />
import {
  Component,
  ComponentRef,
  NO_ERRORS_SCHEMA,
  TemplateRef,
  Type,
  ViewContainerRef,
  provideZonelessChangeDetection,
  signal,
  viewChild,
} from "@angular/core";
import { NgTemplateOutlet } from "@angular/common";
import { ComponentFixture, ComponentFixtureAutoDetect, TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import {
  awaitFrames,
  findAllNodes,
  initGodotTestEnvironment,
  nodeTexts,
} from "godot-angular/testing";

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

describe("ng-template：手动实例化嵌入视图", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("表格：宿主给行模板，ViewContainerRef 按数据实例化，clear 后节点真的出树", async () => {
    @Component({
      selector: "t-t-table",
      schemas: [NO_ERRORS_SCHEMA],
      template: `<VBoxContainer name="tableBody">
        <Label text="header"></Label>
        <ng-container #rows></ng-container>
      </VBoxContainer>`,
    })
    class Table {
      readonly rows = viewChild.required("rows", { read: ViewContainerRef });
    }

    @Component({
      selector: "t-t-table-host",
      imports: [Table],
      schemas: [NO_ERRORS_SCHEMA],
      template: `<t-t-table #table></t-t-table>
        <ng-template #rowTpl let-row>
          <Label text="{{ row.name }}"></Label>
        </ng-template>`,
    })
    class TableHost {
      readonly table = viewChild.required<Table>("table");
      readonly rowTpl = viewChild.required<TemplateRef<{ $implicit: { name: string } }>>("rowTpl");
      readonly data = signal([
        { name: "alpha" },
        { name: "beta" },
      ]);

      /** 渲染一行 = 实例化一次模板，context 就是 let-row 收到的那个值 */
      render(): void {
        const vcr = this.table().rows();
        vcr.clear();
        for (const row of this.data()) vcr.createEmbeddedView(this.rowTpl(), { $implicit: row });
      }
    }

    const fixture = await render(TableHost);
    expect(nodeTexts(fixture.nativeElement)).toEqual(["header"]);

    fixture.componentInstance.render();
    await fixture.whenStable();
    expect(nodeTexts(fixture.nativeElement)).toEqual(["header", "alpha", "beta"]);

    // 换数据再渲染：旧行必须真的从树上摘掉，不是留着叠上去
    fixture.componentInstance.data.set([{ name: "gamma" }]);
    fixture.componentInstance.render();
    await fixture.whenStable();
    expect(nodeTexts(fixture.nativeElement)).toEqual(["header", "gamma"]);
  });

  it("嵌入视图插在声明位置：锚点两侧的顺序不能乱", async () => {
    @Component({
      selector: "t-t-anchor",
      schemas: [NO_ERRORS_SCHEMA],
      template: `<VBoxContainer>
        <Label text="head"></Label>
        <ng-container #slot></ng-container>
        <Label text="foot"></Label>
      </VBoxContainer>`,
    })
    class Anchor {
      readonly slot = viewChild.required("slot", { read: ViewContainerRef });
    }

    @Component({
      selector: "t-t-anchor-host",
      imports: [Anchor],
      schemas: [NO_ERRORS_SCHEMA],
      template: `<t-t-anchor #a></t-t-anchor>
        <ng-template #mid><Label text="mid"></Label></ng-template>`,
    })
    class AnchorHost {
      readonly a = viewChild.required<Anchor>("a");
      readonly mid = viewChild.required<TemplateRef<void>>("mid");
      mount(): void {
        this.a().slot().createEmbeddedView(this.mid());
      }
      destroy(): void {
        this.a().slot().clear();
      }
    }

    const fixture = await render(AnchorHost);
    fixture.componentInstance.mount();
    await fixture.whenStable();
    expect(nodeTexts(fixture.nativeElement)).toEqual(["head", "mid", "foot"]);

    const mid = findAllNodes(fixture.nativeElement, "Label").find((n) => n.text === "mid")!;
    fixture.componentInstance.destroy();
    await fixture.whenStable();
    expect(nodeTexts(fixture.nativeElement)).toEqual(["head", "foot"]);
    // destroyNode 走的是 queue_free：等一帧后引擎真的释放了它
    await awaitFrames(3);
    expect(() => mid.get_class()).toThrow();
  });

  it("模板上下文带 index 与自定义变量", async () => {
    @Component({
      selector: "t-t-ctx",
      schemas: [NO_ERRORS_SCHEMA],
      template: `<VBoxContainer>
        <ng-container *ngTemplateOutlet="listTpl; context: ctx()"></ng-container>
      </VBoxContainer>
      <ng-template #listTpl let-item let-i="index">
        <Label text="{{ i }}:{{ item }}"></Label>
      </ng-template>`,
      imports: [NgTemplateOutlet],
    })
    class CtxComp {
      readonly ctx = signal({ $implicit: "hello", index: 7 });
    }

    const fixture = await render(CtxComp);
    expect(nodeTexts(fixture.nativeElement)).toEqual(["7:hello"]);
  });
});

describe("ngTemplateOutlet 与 @if else", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("ngTemplateOutlet 换模板：节点跟着换，不是原地改文本", async () => {
    @Component({
      selector: "t-t-outlet",
      imports: [NgTemplateOutlet],
      schemas: [NO_ERRORS_SCHEMA],
      template: `<VBoxContainer>
        <ng-container *ngTemplateOutlet="active() ? okTpl : warnTpl"></ng-container>
      </VBoxContainer>
      <ng-template #okTpl><Label text="ok"></Label></ng-template>
      <ng-template #warnTpl><Label text="warn"></Label><Label text="detail"></Label></ng-template>`,
    })
    class Outlet {
      readonly active = signal(true);
    }

    const fixture = await render(Outlet);
    expect(nodeTexts(fixture.nativeElement)).toEqual(["ok"]);

    fixture.componentInstance.active.set(false);
    await fixture.whenStable();
    expect(nodeTexts(fixture.nativeElement)).toEqual(["warn", "detail"]);
  });

  it("@if 的 else 分支里插 ng-template", async () => {
    @Component({
      selector: "t-t-else",
      imports: [NgTemplateOutlet],
      schemas: [NO_ERRORS_SCHEMA],
      template: `<VBoxContainer>
        @if (loaded()) {
          <Label text="content"></Label>
        } @else {
          <ng-container *ngTemplateOutlet="busyTpl"></ng-container>
        }
      </VBoxContainer>
      <ng-template #busyTpl><Label text="busy"></Label></ng-template>`,
    })
    class ElseComp {
      readonly loaded = signal(false);
    }

    const fixture = await render(ElseComp);
    expect(nodeTexts(fixture.nativeElement)).toEqual(["busy"]);

    fixture.componentInstance.loaded.set(true);
    await fixture.whenStable();
    expect(nodeTexts(fixture.nativeElement)).toEqual(["content"]);
  });
});

describe("动态创建组件", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("ViewContainerRef.createComponent：动态挂 toast，销毁后节点消失", async () => {
    @Component({
      selector: "t-t-toast",
      schemas: [NO_ERRORS_SCHEMA],
      template: `<PanelContainer><Label text="{{ message() }}"></Label></PanelContainer>`,
    })
    class Toast {
      readonly message = signal("默认");
    }

    @Component({
      selector: "t-t-toast-host",
      imports: [Toast],
      schemas: [NO_ERRORS_SCHEMA],
      template: `<VBoxContainer name="toastHost"><ng-container #host></ng-container></VBoxContainer>`,
    })
    class ToastHost {
      readonly host = viewChild.required("host", { read: ViewContainerRef });
      readonly shown = signal<ComponentRef<Toast>[]>([]);
      push(text: string): void {
        const ref = this.host().createComponent(Toast);
        // ComponentRef 使用 instance，没有 componentInstance
        ref.instance.message.set(text);
        ref.changeDetectorRef.detectChanges();
        this.shown.update((list) => [...list, ref]);
      }
      clearAll(): void {
        this.host().clear();
        this.shown.set([]);
      }
    }

    const fixture = await render(ToastHost);
    expect(nodeTexts(fixture.nativeElement)).toEqual([]);

    fixture.componentInstance.push("已保存");
    await fixture.whenStable();
    expect(nodeTexts(fixture.nativeElement)).toEqual(["已保存"]);
    expect(findAllNodes(fixture.nativeElement, "PanelContainer").length).toBe(1);

    fixture.componentInstance.push("已同步");
    await fixture.whenStable();
    expect(nodeTexts(fixture.nativeElement)).toEqual(["已保存", "已同步"]);

    fixture.componentInstance.clearAll();
    await fixture.whenStable();
    expect(nodeTexts(fixture.nativeElement)).toEqual([]);
    expect(findAllNodes(fixture.nativeElement, "PanelContainer").length).toBe(0);
  });
});

describe("ViewContainerRef.move（移动 = 先 detach 再 insert）", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("首尾互换后节点顺序真的变了", async () => {
    @Component({
      selector: "t-t-item",
      schemas: [NO_ERRORS_SCHEMA],
      template: `<Label text="{{ t }}"></Label>`,
    })
    class Item {
      t = "";
    }

    @Component({
      selector: "t-t-move",
      imports: [Item],
      schemas: [NO_ERRORS_SCHEMA],
      template: `<VBoxContainer name="box"><ng-container #slot></ng-container></VBoxContainer>`,
    })
    class MoveHost {
      readonly slot = viewChild.required("slot", { read: ViewContainerRef });
      make(): void {
        for (const t of ["a", "b", "c"]) {
          const ref = this.slot().createComponent(Item);
          ref.instance.t = t;
          ref.changeDetectorRef.detectChanges();
        }
      }
      /** 得用 vcr.get(i) 拿回的 ViewRef：createComponent 的返回值直接递给 move 会崩在 Angular 内部 */
      move(from: number, to: number): void {
        const vc = this.slot();
        vc.move(vc.get(from)!, to);
      }
    }

    const fixture = await render(MoveHost);
    fixture.componentInstance.make();
    await fixture.whenStable();
    expect(nodeTexts(fixture.nativeElement)).toEqual(["a", "b", "c"]);

    fixture.componentInstance.move(2, 0); // c 挪到最前
    await fixture.whenStable();
    expect(nodeTexts(fixture.nativeElement)).toEqual(["c", "a", "b"]);

    fixture.componentInstance.move(0, 2); // 再挪回末尾
    await fixture.whenStable();
    expect(nodeTexts(fixture.nativeElement)).toEqual(["a", "b", "c"]);
  });
});
