/// <reference types="vitest" />
import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  NO_ERRORS_SCHEMA,
  OnDestroy,
  Output,
  forwardRef,
  provideZonelessChangeDetection,
  signal,
  viewChild,
} from "@angular/core";
import { ComponentFixtureAutoDetect, TestBed } from "@angular/core/testing";
import { ControlValueAccessor, FormsModule, NG_VALUE_ACCESSOR } from "@angular/forms";
import { tryConnectGodotSignal } from "godot-angular/core";
import {
  GodotLineEditValueAccessor,
  GodotToggleValueAccessor,
} from "godot-angular/forms";
import { beforeEach, describe, expect, it } from "vitest";
import { findAllNodes, initGodotTestEnvironment } from "godot-angular/testing";

/**
 * 两种双向绑定，两套机制，都不依赖事件名猜测：
 *  A. `[(xxx)]` 依赖 Angular 组件声明的 `@Output() xxxChange`（Angular 自身的协议）；
 *     Godot 节点没有 output，因此 `[(text)]` 写在 LineEdit 上仅单向。
 *  B. `ngModel` 经 ControlValueAccessor，必须有内容注册进 NG_VALUE_ACCESSOR。
 * B 未注册时的症状是“能显示、改不回去、不报错”，因此必须在真实引擎上验证回写方向。
 */

/** 标准形状：configureTestingModule(+autoDetect/zoneless) → createComponent → whenStable */
async function render<T>(component: any): Promise<any> {
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

describe("A. [(xxx)] 语法糖：由组件声明的 @Output() xxxChange 驱动", () => {
  beforeEach(() => initGodotTestEnvironment());

  /** 双向绑定的标准形态：组件声明 prop 输入与 xxxChange 输出这一对名字 */
  @Component({
    selector: "t-tw-counter",
    template: `<Button text="+1" (pressed)="bump()"></Button>
      <Label [text]="'v=' + value"></Label>`,
  })
  class Counter {
    @Input() value = 0;
    @Output() valueChange = new EventEmitter<number>();
    bump(): void {
      this.valueChange.emit(this.value + 1);
    }
  }

  @Component({
    selector: "t-tw-counter-host",
    imports: [Counter],
    template: `<t-tw-counter [(value)]="n"></t-tw-counter>`,
  })
  class CounterHost {
    n = 5;
  }

  @Component({
    selector: "t-tw-counter-sig-host",
    imports: [Counter],
    // signal 不能作为双向绑定目标（`[(value)]="n()"` 不被模板解析器接受），需拆成属性绑定与事件绑定
    template: `<t-tw-counter [value]="n()" (valueChange)="n.set($event)"></t-tw-counter>`,
  })
  class CounterHostSignal {
    n = signal(5);
  }

  it("组件声明 @Output() valueChange 时 [(value)] 双向生效", async () => {
    const fixture = await render(CounterHost);
    await fixture.whenStable();
    expect(findAllNodes(fixture.nativeElement, "Label")[0].text).toBe("v=5");

    // 子组件内部：Godot pressed 信号 → bump → valueChange → 宿主 n
    findAllNodes(fixture.nativeElement, "Button")[0].emit_signal("pressed");
    await fixture.whenStable();
    expect(fixture.componentInstance.n).toBe(6);
    // 回写值再经 @Input 下发；bump 不修改 value，Label 显示的始终是宿主模型
    expect(findAllNodes(fixture.nativeElement, "Label")[0].text).toBe("v=6");
  });

  it("宿主为 signal 时以 [value] + (valueChange) 拆分形式双向生效", async () => {
    const fixture = await render(CounterHostSignal);
    await fixture.whenStable();
    expect(findAllNodes(fixture.nativeElement, "Label")[0].text).toBe("v=5");

    findAllNodes(fixture.nativeElement, "Button")[0].emit_signal("pressed");
    await fixture.whenStable();
    expect(fixture.componentInstance.n()).toBe(6);

    // 模型 → 视图：signal 置脏，子组件 @Input 拿到新值
    fixture.componentInstance.n.set(10);
    await fixture.whenStable();
    expect(findAllNodes(fixture.nativeElement, "Label")[0].text).toBe("v=10");
  });

  it("Godot 节点上的 [(text)] 仅单向生效：不回写、不告警", async () => {
    @Component({
      selector: "t-tw-raw",
      schemas: [NO_ERRORS_SCHEMA],
      template: `<LineEdit #edit [(text)]="name"></LineEdit>`,
    })
    class Comp {
      name = "initial";
    }

    const fixture = await render(Comp);
    const edit = findAllNodes(fixture.nativeElement, "LineEdit")[0];
    // 属性绑定一侧生效
    expect(edit.text).toBe("initial");

    // 事件绑定一侧不生效：LineEdit 没有 textChange 输出，事件名解析也不会映射为 text_changed；
    // 静默忽略，与浏览器 addEventListener 对未知事件名的行为一致。
    edit.text = "typed";
    edit.emit_signal("text_changed", "typed");
    await fixture.whenStable();
    expect(fixture.componentInstance.name).toBe("initial");
  });
});

describe("B. ngModel（ControlValueAccessor + provider 注册）", () => {
  beforeEach(() => initGodotTestEnvironment());

  @Component({
    selector: "t-ng-line",
    imports: [FormsModule, GodotLineEditValueAccessor],
    schemas: [NO_ERRORS_SCHEMA],
    template: `<VBoxContainer>
      <LineEdit #edit [(ngModel)]="name" [ngModelOptions]="{standalone: true}"></LineEdit>
      <Label text="now={{ name }}"></Label>
    </VBoxContainer>`,
  })
  class NgLine {
    name = "initial";
  }

  @Component({
    selector: "t-ng-line-sig",
    imports: [FormsModule, GodotLineEditValueAccessor],
    schemas: [NO_ERRORS_SCHEMA],
    template: `<LineEdit #edit [ngModel]="name()" (ngModelChange)="name.set($event)" [ngModelOptions]="{standalone: true}"></LineEdit>`,
  })
  class NgLineSignal {
    name = signal("initial");
  }

  /**
   * 自定义表单控件的正规写法：组件自身实现 ControlValueAccessor，
   * 并在**自己的 providers** 中将 NG_VALUE_ACCESSOR 指向自己。
   * 适用于“一个复合控件对外暴露一个值”的场景（内部可以是一整棵 Godot 节点树）。
   */
  @Component({
    selector: "app-boolean",
    schemas: [NO_ERRORS_SCHEMA],
    providers: [
      {
        provide: NG_VALUE_ACCESSOR,
        useExisting: forwardRef(() => AppBoolean),
        multi: true,
      },
    ],
    template: `<CheckBox #box></CheckBox>`,
  })
  class AppBoolean implements ControlValueAccessor, AfterViewInit, OnDestroy {
    private box = viewChild<ElementRef>("box");
    private onChange: ((value: unknown) => void) | null = null;
    private off: (() => void) | null = null;
    private pending: unknown = null;

    ngAfterViewInit(): void {
      const node = this.box()?.nativeElement;
      if (!node) return;
      // writeValue 可能早于 view 就绪，先暂存，此处补写一次
      if (this.pending !== null) node.button_pressed = Boolean(this.pending);
      // 必须在 view 就绪后连接，且 ngOnDestroy 中必须解绑。
      // 连接失败返回 null（此处就是写错了的信号名），由调用方自行决定如何处理。
      this.off = tryConnectGodotSignal(node, "toggled", (v) => this.onChange?.(Boolean(v)));
    }

    ngOnDestroy(): void {
      this.off?.();
      this.off = null;
    }

    writeValue(value: unknown): void {
      this.pending = value;
      const node = this.box()?.nativeElement;
      if (node) node.button_pressed = Boolean(value);
    }

    registerOnChange(fn: (value: unknown) => void): void {
      this.onChange = fn;
    }

    registerOnTouched(_fn: () => void): void {}
  }

  @Component({
    selector: "t-custom-bool-host",
    imports: [FormsModule, AppBoolean],
    template: `<app-boolean [(ngModel)]="flag" [ngModelOptions]="{standalone: true}"></app-boolean>`,
  })
  class CustomBoolean {
    flag = true;
  }

  @Component({
    selector: "t-ng-check",
    imports: [FormsModule, GodotToggleValueAccessor],
    schemas: [NO_ERRORS_SCHEMA],
    template: `<CheckBox [(ngModel)]="on" [ngModelOptions]="{standalone: true}"></CheckBox>`,
  })
  class NgCheck {
    on = false;
  }

  @Component({
    selector: "t-ng-host",
    imports: [FormsModule, GodotLineEditValueAccessor],
    schemas: [NO_ERRORS_SCHEMA],
    template: `@if (show()) { <LineEdit [(ngModel)]="name" [ngModelOptions]="{standalone: true}"></LineEdit> }`,
  })
  class NgHost {
    name = "a";
    show = signal(true);
  }

  it("ngModel 回写：控件发信号 → 组件属性更新", async () => {
    const fixture = await render(NgLine);
    const edit = findAllNodes(fixture.nativeElement, "LineEdit")[0];

    edit.text = "typed-back";
    edit.emit_signal("text_changed", "typed-back");
    await fixture.whenStable();
    expect(fixture.componentInstance.name).toBe("typed-back");
  });

  it("ngModel 显示：模型变化 → 写进节点（模板状态用 signal）", async () => {
    // zoneless 的契约：模板中读取的状态必须是 signal，普通字段修改后没有任何机制置脏，永远不刷新。
    // 使用 signal 作为模型，才是真实项目中应有的写法。
    const fixture = await render(NgLineSignal);
    const edit = findAllNodes(fixture.nativeElement, "LineEdit")[0];
    await fixture.whenStable();
    expect(edit.text).toBe("initial");

    fixture.componentInstance.name.set("from-model");
    await fixture.whenStable();
    expect(edit.text).toBe("from-model");
  });

  it("自定义组件实现 ControlValueAccessor（自带 providers 注册）", async () => {
    const fixture = await render(CustomBoolean);
    const box = findAllNodes(fixture.nativeElement, "CheckBox")[0];
    await fixture.whenStable();
    expect(box.button_pressed).toBe(true);

    // 视图 → 模型：Godot 信号经 tryConnectGodotSignal 回到 onChange
    box.button_pressed = false;
    box.emit_signal("toggled", false);
    await fixture.whenStable();
    expect(fixture.componentInstance.flag).toBe(false);
  });

  it("CheckBox 走 GodotToggleValueAccessor（button_pressed / toggled）", async () => {
    const fixture = await render(NgCheck);
    const box = findAllNodes(fixture.nativeElement, "CheckBox")[0];
    expect(box.button_pressed).toBe(false);

    box.button_pressed = true;
    box.emit_signal("toggled", true);
    await fixture.whenStable();
    expect(fixture.componentInstance.on).toBe(true);
  });

  it("组件销毁后 accessor 已解绑，模型不再被旧回调影响", async () => {
    const fixture = await render(NgHost);
    expect(findAllNodes(fixture.nativeElement, "LineEdit").length).toBe(1);

    fixture.componentInstance.show.set(false);
    await fixture.whenStable();
    expect(findAllNodes(fixture.nativeElement, "LineEdit").length).toBe(0);
    // 若 accessor 未在 ngOnDestroy 中 disconnect，此处会回调到已销毁的 accessor
    fixture.componentInstance.name = "b";
    await fixture.whenStable();
    expect(fixture.componentInstance.name).toBe("b");
  });
});
