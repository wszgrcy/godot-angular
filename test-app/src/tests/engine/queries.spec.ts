/// <reference types="vitest" />
import {
  Component,
  Directive,
  ElementRef,
  NO_ERRORS_SCHEMA,
  Type,
  contentChild,
  contentChildren,
  inject,
  provideZonelessChangeDetection,
  signal,
  viewChild,
  viewChildren,
} from "@angular/core";
import { ComponentFixture, ComponentFixtureAutoDetect, TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import {
  awaitFrames,
  childNodes,
  findAllNodes,
  initGodotTestEnvironment,
  nodeTexts,
} from "godot-angular/testing";

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

const texts = (fixture: ComponentFixture<unknown>): string[] => nodeTexts(fixture.nativeElement);

describe("viewChild：从模板取回真实 Control", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("对话框：viewChild.required 拿到的确认按钮就是引擎节点，点它父组件状态跟着变", async () => {
    @Component({
      selector: "t-q-dialog",
      schemas: [NO_ERRORS_SCHEMA],
      template: `<VBoxContainer>
        <Label text="title"></Label>
        <Button #ok text="确认" (click)="confirmed.update(n => n + 1)"></Button>
      </VBoxContainer>`,
    })
    class Dialog {
      readonly confirmed = signal(0);
      readonly ok = viewChild.required<ElementRef>("ok");
    }

    const fixture = await render(Dialog);
    const btn = fixture.componentInstance.ok().nativeElement;

    expect(btn.get_class()).toBe("Button");
    expect(btn.text).toBe("确认");
    // 同一个对象，而不是复制品：引擎侧只有这一个节点
    expect(btn).toBe(findAllNodes(fixture.nativeElement, "Button")[0]);

    btn.emit_signal("pressed");
    await fixture.whenStable();
    expect(fixture.componentInstance.confirmed()).toBe(1);
  });

  it("表单：viewChild 指向子组件时给组件实例，调用它的方法能操作内部真节点", async () => {
    @Component({
      selector: "t-q-edit",
      schemas: [NO_ERRORS_SCHEMA],
      template: `<LineEdit #edit [text]="value()"></LineEdit>`,
    })
    class EditField {
      readonly value = signal("typed text");
      readonly edit = viewChild.required<ElementRef>("edit");
      /** 对外只暴露动作，不暴露节点 */
      clear(): void {
        this.edit().nativeElement.text = "";
      }
    }

    @Component({
      selector: "t-q-edit-host",
      imports: [EditField],
      schemas: [NO_ERRORS_SCHEMA],
      template: `<t-q-edit #field></t-q-edit>`,
    })
    class Host {
      readonly field = viewChild.required<EditField>("field");
    }

    const fixture = await render(Host);
    const edit = findAllNodes(fixture.nativeElement, "LineEdit")[0];
    expect(edit.text).toBe("typed text");

    // 父组件获取的是子组件实例（而不是节点），清空调用的是子组件自身的方法
    fixture.componentInstance.field().clear();
    await fixture.whenStable();
    expect(edit.text).toBe("");
  });

  it("@if 关掉后 viewChild() 变 undefined，required() 读它则抛而不是静默", async () => {
    @Component({
      selector: "t-q-opt",
      schemas: [NO_ERRORS_SCHEMA],
      template: `@if (show()) { <Label #lbl text="row"></Label> }`,
    })
    class OptComp {
      readonly show = signal(true);
      readonly lbl = viewChild<ElementRef>("lbl");
      readonly must = viewChild.required<ElementRef>("lbl");
    }

    const fixture = await render(OptComp);
    expect(fixture.componentInstance.lbl()).toBeTruthy();

    fixture.componentInstance.show.set(false);
    await fixture.whenStable();
    expect(fixture.componentInstance.lbl()).toBeUndefined();
    expect(() => fixture.componentInstance.must()).toThrow();
  });

  it("列表：viewChildren 跟着 @for 增删同步，顺序与模板一致", async () => {
    @Component({
      selector: "t-q-list",
      schemas: [NO_ERRORS_SCHEMA],
      template: `<VBoxContainer>
        @for (row of rows(); track row.id) {
          <Label #row text="{{ row.name }}"></Label>
        }
      </VBoxContainer>`,
    })
    class ListComp {
      readonly rows = signal([
        { id: 1, name: "one" },
        { id: 2, name: "two" },
      ]);
      readonly rowNodes = viewChildren<ElementRef>("row");
    }

    const fixture = await render(ListComp);
    const read = () => fixture.componentInstance.rowNodes().map((r) => r.nativeElement.text);
    expect(read()).toEqual(["one", "two"]);

    fixture.componentInstance.rows.update((rows) => [...rows, { id: 3, name: "three" }]);
    await fixture.whenStable();
    expect(read()).toEqual(["one", "two", "three"]);

    fixture.componentInstance.rows.set([{ id: 2, name: "two" }]);
    await fixture.whenStable();
    expect(read()).toEqual(["two"]);
    // 查询中的节点必须是树上仍然存在的那些
    expect(findAllNodes(fixture.nativeElement, "Label").length).toBe(1);
  });

  it("销毁：@if 移除后查询变 undefined，先前拿到的节点被引擎真删掉", async () => {
    @Component({
      selector: "t-q-destroy",
      schemas: [NO_ERRORS_SCHEMA],
      template: `@if (show()) { <Label #lbl text="alive"></Label> }`,
    })
    class DestroyComp {
      readonly show = signal(true);
      readonly lbl = viewChild<ElementRef>("lbl");
    }

    const fixture = await render(DestroyComp);
    const node = fixture.componentInstance.lbl()!.nativeElement;
    expect(node.is_queued_for_deletion()).toBe(false);

    fixture.componentInstance.show.set(false);
    await fixture.whenStable();
    expect(fixture.componentInstance.lbl()).toBeUndefined();
    // 只有真实引擎才能提供的证据：等引擎运行过帧，queue_free 确实将节点释放（再次读取就是已释放报错），
    // 而不是“从树上摘下一个引用保留”
    await awaitFrames(3);
    expect(() => node.get_class()).toThrow();
  });
});

describe("contentChild：ng-content 投影进来的节点", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("卡片：contentChild 按引用名取被投影的标题节点，父组件能直接读它的 text", async () => {
    @Component({
      selector: "t-q-card",
      schemas: [NO_ERRORS_SCHEMA],
      template: `<PanelContainer><VBoxContainer name="cardInner">
        <ng-content select=".title"></ng-content>
        <ng-content></ng-content>
      </VBoxContainer></PanelContainer>`,
    })
    class Card {
      readonly title = contentChild.required<ElementRef>("title");
    }

    @Component({
      selector: "t-q-card-host",
      imports: [Card],
      schemas: [NO_ERRORS_SCHEMA],
      // class 决定投影到哪个槽，#title 决定查询能否命中——两套机制各管一件事
      template: `<t-q-card #card>
        <Label #title class="title" text="projected-title"></Label>
        <Label text="body"></Label>
      </t-q-card>`,
    })
    class CardHost {
      readonly card = viewChild.required<Card>("card");
    }

    const fixture = await render(CardHost);
    const card = fixture.componentInstance.card();
    const titleNode = card.title().nativeElement;

    expect(titleNode.get_class()).toBe("Label");
    expect(titleNode.text).toBe("projected-title");
    // 投影是真实挂载过去的：标题的父节点是卡片内部的 VBoxContainer，而不是宿主
    expect(titleNode.get_parent().name).toBe("cardInner");
    expect(texts(fixture)).toEqual(["projected-title", "body"]);
  });

  it("工具栏：contentChildren 按指令收集投影进来的按钮，@if 关掉一个就少一个", async () => {
    /** 投影进来的节点依靠指令被识别，比引用名更具扩展性（多个同名槽位也可以一起收集） */
    @Directive({ selector: "[toolbarAction]" })
    class ToolbarAction {
      readonly el = inject(ElementRef);
      readonly label = signal("");
    }

    @Component({
      selector: "t-q-bar",
      schemas: [NO_ERRORS_SCHEMA],
      template: `<HBoxContainer name="barInner"><ng-content select=".action"></ng-content></HBoxContainer>`,
    })
    class Toolbar {
      readonly actions = contentChildren(ToolbarAction);
    }

    @Component({
      selector: "t-q-bar-host",
      imports: [Toolbar, ToolbarAction],
      schemas: [NO_ERRORS_SCHEMA],
      template: `<t-q-bar #bar>
        <Button class="action" toolbarAction text="save"></Button>
        @if (canDelete()) { <Button class="action" toolbarAction text="delete"></Button> }
        <Label text="not-an-action"></Label>
      </t-q-bar>`,
    })
    class BarHost {
      readonly canDelete = signal(true);
      readonly bar = viewChild.required<Toolbar>("bar");
    }

    const fixture = await render(BarHost);
    const bar = fixture.componentInstance.bar();
    expect(bar.actions().length).toBe(2);
    expect(bar.actions().map((a) => a.el.nativeElement.text)).toEqual(["save", "delete"]);
    // 指令注入的 ElementRef 也必须是引擎节点本体
    expect(bar.actions()[0].el.nativeElement.get_class()).toBe("Button");

    fixture.componentInstance.canDelete.set(false);
    await fixture.whenStable();
    expect(bar.actions().length).toBe(1);
    // 投影容器中也只剩一个按钮（不是查询缓存未清理）
    const inner = findAllNodes(fixture.nativeElement, "HBoxContainer").find((n) => n.name === "barInner")!;
    expect(findAllNodes(inner, "Button").length).toBe(1);
  });

  it("空槽位：宿主没给对应内容时 contentChild() 是 undefined，默认槽照常收正文", async () => {
    @Component({
      selector: "t-q-empty",
      schemas: [NO_ERRORS_SCHEMA],
      template: `<VBoxContainer name="emptyInner">
        <ng-content select=".title"></ng-content>
        <ng-content></ng-content>
      </VBoxContainer>`,
    })
    class EmptyCard {
      readonly title = contentChild<ElementRef>("title");
    }

    @Component({
      selector: "t-q-empty-host",
      imports: [EmptyCard],
      schemas: [NO_ERRORS_SCHEMA],
      template: `<t-q-empty #card><Label text="only-body"></Label></t-q-empty>`,
    })
    class EmptyHost {
      readonly card = viewChild.required<EmptyCard>("card");
    }

    const fixture = await render(EmptyHost);
    expect(fixture.componentInstance.card().title()).toBeUndefined();
    const inner = findAllNodes(fixture.nativeElement, "VBoxContainer").find((n) => n.name === "emptyInner")!;
    expect(childNodes(inner).map((n) => (n as { text?: string }).text)).toEqual(["only-body"]);
  });

  it("宿主内容变化：投影进来的节点被 @if 移除后，卡片内的容器同步变空", async () => {
    @Component({
      selector: "t-q-slot",
      schemas: [NO_ERRORS_SCHEMA],
      template: `<VBoxContainer name="cardInner"><ng-content select=".body"></ng-content></VBoxContainer>`,
    })
    class SlotCard {
      readonly body = contentChildren<ElementRef>("body");
    }

    @Component({
      selector: "t-q-slot-host",
      imports: [SlotCard],
      schemas: [NO_ERRORS_SCHEMA],
      template: `<t-q-slot #card>
        @if (showBody()) { <Label #body class="body" text="row-a"></Label> }
      </t-q-slot>`,
    })
    class SlotHost {
      readonly showBody = signal(true);
      readonly card = viewChild.required<SlotCard>("card");
    }

    const fixture = await render(SlotHost);
    const card = fixture.componentInstance.card();
    const inner = findAllNodes(fixture.nativeElement, "VBoxContainer").find((n) => n.name === "cardInner")!;
    expect(inner).toBeTruthy();
    expect(card.body().length).toBe(1);
    expect(findAllNodes(inner, "Label").length).toBe(1);

    fixture.componentInstance.showBody.set(false);
    await fixture.whenStable();
    expect(card.body().length).toBe(0);
    expect(findAllNodes(inner, "Label").length).toBe(0);
  });
});
