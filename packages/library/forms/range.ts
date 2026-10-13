import { Directive, forwardRef } from "@angular/core";
import { NG_VALUE_ACCESSOR } from "@angular/forms";
import type { ScrollBar, Slider, SpinBox } from "godot";
import { GodotMouseDisabledBase, GodotValueAccessorBase } from "./base";

/** `<HSlider>` / `<VSlider>` —— 连续数值。两个选择器共用 `Slider` 这个基类 */
@Directive({
  selector: `HSlider[ngModel],VSlider[ngModel],HSlider[formControl],VSlider[formControl],HSlider[formControlName],VSlider[formControlName]`,
  // 只接 value_changed。drag_ended 表示“松手”，拖拽过程中 value_changed 本就在连续触发，
  // 再挂一个只会使同一个值推送两遍。
  host: { "(value_changed)": "valueAndTouchedChange($any($event))" },
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => GodotSliderValueAccessor), multi: true },
  ],
})
export class GodotSliderValueAccessor extends GodotValueAccessorBase<number, Slider> {
  override writeValue(value: number | null): void {
    super.writeValue(value);
    this.node.value = value ?? 0;
  }

  override setDisabledState(isDisabled: boolean): void {
    super.setDisabledState(isDisabled);
    this.node.editable = !isDisabled;
  }
}

/** `<SpinBox>` —— 步进数值（没有 HSpinBox / VSpinBox，它们不是本引擎的类名） */
@Directive({
  selector: `SpinBox[ngModel],SpinBox[formControl],SpinBox[formControlName]`,
  host: { "(value_changed)": "valueAndTouchedChange($any($event))" },
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => GodotSpinBoxValueAccessor), multi: true },
  ],
})
export class GodotSpinBoxValueAccessor extends GodotValueAccessorBase<number, SpinBox> {
  override writeValue(value: number | null): void {
    super.writeValue(value);
    // Range::set_value 会将值对齐到 step（写入 7.5、step=1 → 存储 8），而 value_changed
    // 发出的也是对齐后的值，因此模型得到的就是对齐后的值。这是引擎的行为，适配器不干预。
    this.node.value = value ?? 0;
  }

  override setDisabledState(isDisabled: boolean): void {
    super.setDisabledState(isDisabled);
    this.node.editable = !isDisabled;
  }
}

/**
 * `<HScrollBar>` / `<VScrollBar>` —— 滚动条**本体**（Range 系列），不是滚动容器。
 * 值是滚动偏移（min_value ~ max_value - page），容器是 ScrollContainer，
 * 它的滚动条通过 get_h_scroll_bar() / get_v_scroll_bar() 获取。
 */
@Directive({
  selector: `HScrollBar[ngModel],VScrollBar[ngModel],HScrollBar[formControl],VScrollBar[formControl],HScrollBar[formControlName],VScrollBar[formControlName]`,
  // ScrollBar 只有 scrolling()（不带参数）和继承自 Range 的 value_changed，后者才提供值。
  host: { "(value_changed)": "valueAndTouchedChange($any($event))" },
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => GodotScrollBarValueAccessor), multi: true },
  ],
})
export class GodotScrollBarValueAccessor extends GodotMouseDisabledBase<number, ScrollBar> {
  override writeValue(value: number | null): void {
    super.writeValue(value);
    this.node.value = value ?? 0;
  }

  override setDisabledState(isDisabled: boolean): void {
    super.setDisabledState(isDisabled);
    // ScrollBar 既没有 editable 也没有 disabled，只能使其不接收鼠标输入
    this.setNodeInteractive(!isDisabled);
  }
}
