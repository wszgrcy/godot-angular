/// <reference types="vitest" />
import {
  Component,
  NO_ERRORS_SCHEMA,
  forwardRef,
  provideZonelessChangeDetection,
  signal,
  viewChild,
} from "@angular/core";
import { ComponentFixtureAutoDetect, TestBed } from "@angular/core/testing";
import { FormControl, FormsModule, NG_VALUE_ACCESSOR, NgModel, ReactiveFormsModule } from "@angular/forms";
import { Color, Control } from "godot";
import {
  GodotColorPickerValueAccessor,
  GodotControlBase,
  GodotLineEditValueAccessor,
  GodotOptionButtonValueAccessor,
  GodotScrollBarValueAccessor,
  GodotSliderValueAccessor,
  GodotToggleValueAccessor,
} from "godot-angular/forms";
import { beforeEach, describe, expect, it } from "vitest";
import { findAllNodes, initGodotTestEnvironment } from "godot-angular/testing";

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

// —— 组件全部声明在 describe 之前：describe 的回调在收集阶段就地执行，写在后面就是 TDZ。

/**
 * 复合控件：整个组件对外只暴露一个数字。
 * 继续继承 GodotControlBase 后，CVA 那套接线（onChange / onTouched / disabled）全部在基类中，
 * 组件只负责“点击按钮 → 值变化”，值本身由 value$ 作为唯一来源（没有对应的 Godot 属性）。
 */
@Component({
  selector: "t-fb-stepper",
  schemas: [NO_ERRORS_SCHEMA],
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => StepperControl), multi: true },
  ],
  template: `<HBoxContainer>
    <Button text="-" (pressed)="step(-1)"></Button>
    <Label text="v={{ value$() }}"></Label>
    <Button text="+" (pressed)="step(1)"></Button>
  </HBoxContainer>`,
})
class StepperControl extends GodotControlBase<number> {
  step(delta: number): void {
    this.valueAndTouchedChange(this.value$() + delta);
  }

  /** 只推给 Forms、不修改 value$——用于固定 valueChange(v, false) 的语义 */
  peekOnly(value: number): void {
    this.valueChange(value, false);
  }
}

@Component({
  selector: "t-fb-stepper-host",
  imports: [FormsModule, StepperControl],
  template: `<t-fb-stepper [ngModel]="n()" (ngModelChange)="n.set($event)" [ngModelOptions]="{ standalone: true }"></t-fb-stepper>`,
})
class StepperHost {
  n = signal(3);
  stepper = viewChild.required(StepperControl);
  model = viewChild.required(NgModel);
}

/** 初值 null：Forms 初始化一定会 writeValue(null)，这是每个 accessor 都无法避开的前提 */
@Component({
  selector: "t-fb-line",
  imports: [FormsModule, GodotLineEditValueAccessor],
  template: `<LineEdit [ngModel]="v()" (ngModelChange)="v.set($event)" [disabled]="off()" [ngModelOptions]="{ standalone: true }"></LineEdit>`,
})
class LineEditHost {
  v = signal<string | null>(null);
  off = signal(false);
  accessor = viewChild.required(GodotLineEditValueAccessor);
  model = viewChild.required(NgModel);
}

/** Range 的空值是 0；适配器不洗类型，模型传入什么就写什么 */
@Component({
  selector: "t-fb-range",
  imports: [FormsModule, GodotSliderValueAccessor],
  template: `<HSlider [ngModel]="v()" (ngModelChange)="v.set($event)" [disabled]="off()" [ngModelOptions]="{ standalone: true }"></HSlider>`,
})
class RangeHost {
  v = signal<number | null>(null);
  off = signal(false);
  accessor = viewChild.required(GodotSliderValueAccessor);
}

@Component({
  selector: "t-fb-check",
  imports: [FormsModule, GodotToggleValueAccessor],
  template: `<CheckBox [ngModel]="on()" (ngModelChange)="on.set($event)" [disabled]="off()" [ngModelOptions]="{ standalone: true }"></CheckBox>`,
})
class ToggleHost {
  on = signal(false);
  off = signal(false);
}

@Component({
  selector: "t-fb-scroll",
  imports: [FormsModule, GodotScrollBarValueAccessor],
  template: `<HScrollBar [ngModel]="v()" (ngModelChange)="v.set($event)" [disabled]="off()" [ngModelOptions]="{ standalone: true }"></HScrollBar>`,
})
class ScrollHost {
  v = signal(0);
  off = signal(false);
}

@Component({
  selector: "t-fb-color",
  imports: [FormsModule, GodotColorPickerValueAccessor],
  template: `<ColorPicker [ngModel]="c()" (ngModelChange)="c.set($event)" [disabled]="off()" [ngModelOptions]="{ standalone: true }"></ColorPicker>`,
})
class ColorHost {
  c = signal<unknown>(null);
  off = signal(false);
}

/** 模型传入 null 时 OptionButton 的落点是 -1（未选中任何项），而不是 0 */
@Component({
  selector: "t-fb-option",
  imports: [FormsModule, GodotOptionButtonValueAccessor],
  template: `<OptionButton [ngModel]="v()" (ngModelChange)="v.set($event)" [ngModelOptions]="{ standalone: true }"></OptionButton>`,
})
class OptionHost {
  v = signal<number | null>(null);
  accessor = viewChild.required(GodotOptionButtonValueAccessor);
}

describe("GodotControlBase：复合控件（组件继承，不碰指令）", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("点按钮 → 值进模型，Label 跟着 value$ 走", async () => {
    const fixture = await render(StepperHost);
    const labels = findAllNodes(fixture.nativeElement, "Label");
    expect(labels[0].text).toBe("v=3");

    const buttons = findAllNodes(fixture.nativeElement, "Button");
    buttons[1].emit_signal("pressed");
    await fixture.whenStable();
    expect(fixture.componentInstance.n()).toBe(4);
    expect(labels[0].text).toBe("v=4");
  });

  it("用户改动会标 touched（touchedChange 接到了 Forms 的 onTouched）", async () => {
    const fixture = await render(StepperHost);
    expect(fixture.componentInstance.model().control.touched).toBe(false);
    findAllNodes(fixture.nativeElement, "Button")[0].emit_signal("pressed");
    await fixture.whenStable();
    expect(fixture.componentInstance.model().control.touched).toBe(true);
  });

  it("valueChange(v, false) 只推模型，不动 value$", async () => {
    const fixture = await render(StepperHost);
    const label = findAllNodes(fixture.nativeElement, "Label")[0];
    fixture.componentInstance.stepper().peekOnly(99);
    await fixture.whenStable();
    expect(fixture.componentInstance.n()).toBe(99);
    // 模型收到 99，但视图（读取 value$）未跟随变化——这就是 setValue=false 的作用
    expect(label.text).toBe("v=3");
  });
});

describe("writeValue(null)：Forms 初始化必来，节点侧必须自己兜住", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("LineEdit 空值写 \"\" 而不是 null，且后续真值仍能写入", async () => {
    const fixture = await render(LineEditHost);
    const edit = findAllNodes(fixture.nativeElement, "LineEdit")[0];
    await fixture.whenStable();
    expect(edit.text).toBe("");
    expect(fixture.componentInstance.accessor().value$()).toBeUndefined();

    fixture.componentInstance.v.set("hello");
    await fixture.whenStable();
    expect(edit.text).toBe("hello");
  });

  it("ColorPicker 没有空色可写，null 就保持原样", async () => {
    const fixture = await render(ColorHost);
    const picker = findAllNodes(fixture.nativeElement, "ColorPicker")[0];
    fixture.componentInstance.c.set(new Color(0, 1, 0, 1));
    await fixture.whenStable();
    expect((picker.color as any).g).toBe(1);

    fixture.componentInstance.c.set(null);
    await fixture.whenStable();
    // 没有“空颜色”可写：写入 null 只会使引擎报错，因此颜色必须仍是那个绿色
    expect((picker.color as any).g).toBe(1);
  });

  it("OptionButton 空值落 -1，不是 0", async () => {
    const fixture = await render(OptionHost);
    const option = findAllNodes(fixture.nativeElement, "OptionButton")[0];
    await fixture.whenStable();
    expect(option.selected).toBe(-1);
    expect(fixture.componentInstance.accessor().value$()).toBe(-1);
  });
});

describe("模型 → 节点：适配器只搬运，不清洗不校验", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("Range 的空值是 0，数字原样写进去", async () => {
    const fixture = await render(RangeHost);
    const slider = findAllNodes(fixture.nativeElement, "HSlider")[0];
    await fixture.whenStable();
    expect(slider.value).toBe(0);

    fixture.componentInstance.v.set(30);
    await fixture.whenStable();
    expect(slider.value).toBe(30);
  });

  it("越界不由适配器管：Godot 对越界下标是静默忽略，模型里存原值", async () => {
    const fixture = await render(OptionHost);
    const option = findAllNodes(fixture.nativeElement, "OptionButton")[0];
    option.add_item("甲");
    option.add_item("乙");
    option.add_item("丙");

    fixture.componentInstance.v.set(1);
    await fixture.whenStable();
    expect(option.selected).toBe(1);

    // 99 越界：适配器不做夹取也不报错，Godot 的 OptionButton::select 对越界下标不做任何处理
    // （节点保持 1），而模型中存储的就是 99——因此校验只能在模型一侧完成
    fixture.componentInstance.v.set(99);
    await fixture.whenStable();
    expect(fixture.componentInstance.accessor().value$()).toBe(99);
    expect(option.selected).toBe(1);
    expect(fixture.componentInstance.accessor().value$()).toBe(99);
  });
});

describe("节点 → 模型：value$ 与 touched", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("用户改完：模型、value$、touched 三处一起到位", async () => {
    const fixture = await render(LineEditHost);
    const edit = findAllNodes(fixture.nativeElement, "LineEdit")[0];
    expect(fixture.componentInstance.model().control.touched).toBe(false);

    edit.text = "typed";
    edit.emit_signal("text_changed", "typed");
    await fixture.whenStable();
    expect(fixture.componentInstance.v()).toBe("typed");
    expect(fixture.componentInstance.accessor().value$()).toBe("typed");
    expect(fixture.componentInstance.model().control.touched).toBe(true);
  });
});

describe("setDisabledState：三档落点各自验", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("LineEdit 走 editable", async () => {
    const fixture = await render(LineEditHost);
    const edit = findAllNodes(fixture.nativeElement, "LineEdit")[0];
    fixture.componentInstance.off.set(true);
    await fixture.whenStable();
    expect(edit.editable).toBe(false);
    expect(fixture.componentInstance.accessor().disabled$()).toBe(true);

    fixture.componentInstance.off.set(false);
    await fixture.whenStable();
    expect(edit.editable).toBe(true);
  });

  it("CheckBox 走 disabled", async () => {
    const fixture = await render(ToggleHost);
    const box = findAllNodes(fixture.nativeElement, "CheckBox")[0];
    fixture.componentInstance.off.set(true);
    await fixture.whenStable();
    expect(box.disabled).toBe(true);
  });

  it("HScrollBar 没有 editable / disabled，只能让鼠标穿透，解禁后还原", async () => {
    const fixture = await render(ScrollHost);
    const bar = findAllNodes(fixture.nativeElement, "HScrollBar")[0];
    const { MOUSE_FILTER_STOP, MOUSE_FILTER_IGNORE } = Control.MouseFilter;
    expect(bar.mouse_filter).toBe(MOUSE_FILTER_STOP);

    fixture.componentInstance.off.set(true);
    await fixture.whenStable();
    expect(bar.mouse_filter).toBe(MOUSE_FILTER_IGNORE);

    fixture.componentInstance.off.set(false);
    await fixture.whenStable();
    expect(bar.mouse_filter).toBe(MOUSE_FILTER_STOP);
  });

  it("ColorPicker 的默认值是 PASS，解禁后还原的是它自己的原值而不是 STOP", async () => {
    const fixture = await render(ColorHost);
    const picker = findAllNodes(fixture.nativeElement, "ColorPicker")[0];
    const { MOUSE_FILTER_PASS, MOUSE_FILTER_IGNORE } = Control.MouseFilter;
    // 各控件的默认值并不一致（ScrollBar / ItemList 是 STOP，ColorPicker 是 PASS），
    // 因此“解禁就写回 0”会把 ColorPicker 从 PASS 改成 STOP，改变事件传播行为
    expect(picker.mouse_filter).toBe(MOUSE_FILTER_PASS);

    fixture.componentInstance.off.set(true);
    await fixture.whenStable();
    expect(picker.mouse_filter).toBe(MOUSE_FILTER_IGNORE);

    fixture.componentInstance.off.set(false);
    await fixture.whenStable();
    expect(picker.mouse_filter).toBe(MOUSE_FILTER_PASS);
  });

  it("禁用期间 mouse_filter 被外部改写：解禁时尊重最后写入者，不拿快照盖上去", async () => {
    const fixture = await render(ScrollHost);
    const bar = findAllNodes(fixture.nativeElement, "HScrollBar")[0];
    const { MOUSE_FILTER_PASS, MOUSE_FILTER_IGNORE } = Control.MouseFilter;

    fixture.componentInstance.off.set(true);
    await fixture.whenStable();
    expect(bar.mouse_filter).toBe(MOUSE_FILTER_IGNORE);
    bar.mouse_filter = MOUSE_FILTER_PASS; // 模拟模板 / 场景在禁用期间接管了这个属性

    fixture.componentInstance.off.set(false);
    await fixture.whenStable();
    expect(bar.mouse_filter).toBe(MOUSE_FILTER_PASS);

    // 再走一轮：旧快照不能污染后续循环（此时存的原值已是 PASS）
    fixture.componentInstance.off.set(true);
    await fixture.whenStable();
    expect(bar.mouse_filter).toBe(MOUSE_FILTER_IGNORE);
    fixture.componentInstance.off.set(false);
    await fixture.whenStable();
    expect(bar.mouse_filter).toBe(MOUSE_FILTER_PASS);
  });
});

/** selector 中的 [formControl] 分支：响应式表单使用同一个 accessor，但禁用由 control.disable() 驱动 */
@Component({
  selector: "t-fb-reactive",
  imports: [ReactiveFormsModule, GodotLineEditValueAccessor],
  template: `<LineEdit [formControl]="ctrl"></LineEdit>`,
})
class ReactiveHost {
  ctrl = new FormControl<string>("init");
}

describe("响应式表单（selector 的 [formControl] 分支）", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("初值写进节点，用户改动回写 control 并标 touched / dirty", async () => {
    const fixture = await render(ReactiveHost);
    const edit = findAllNodes(fixture.nativeElement, "LineEdit")[0];
    await fixture.whenStable();
    expect(edit.text).toBe("init");
    const ctrl = fixture.componentInstance.ctrl;
    expect(ctrl.value).toBe("init");
    expect(ctrl.touched).toBe(false);

    edit.text = "typed";
    edit.emit_signal("text_changed", "typed");
    await fixture.whenStable();
    expect(ctrl.value).toBe("typed");
    expect(ctrl.touched).toBe(true);
    expect(ctrl.dirty).toBe(true);
  });

  it("control.disable() / enable() 驱动 setDisabledState", async () => {
    const fixture = await render(ReactiveHost);
    const edit = findAllNodes(fixture.nativeElement, "LineEdit")[0];
    const ctrl = fixture.componentInstance.ctrl;

    ctrl.disable();
    await fixture.whenStable();
    expect(edit.editable).toBe(false);

    ctrl.enable();
    await fixture.whenStable();
    expect(edit.editable).toBe(true);

    ctrl.setValue("after");
    await fixture.whenStable();
    expect(edit.text).toBe("after");
  });
});
