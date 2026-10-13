import { Directive, forwardRef } from "@angular/core";
import { NG_VALUE_ACCESSOR } from "@angular/forms";
import type { BaseButton } from "godot";
import { GodotValueAccessorBase } from "./base";

/**
 * `<CheckBox>` / `<CheckButton>` —— 布尔值。
 *
 * 值属性是 `button_pressed` 而不是 `pressed`（后者是信号名），
 * 变更信号是 `toggled(on: bool)`，不存在 `button_pressed_changed`。
 */
@Directive({
  selector: `CheckBox[ngModel],CheckButton[ngModel],CheckBox[formControl],CheckButton[formControl],CheckBox[formControlName],CheckButton[formControlName]`,
  host: { "(toggled)": "valueAndTouchedChange($any($event))" },
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => GodotToggleValueAccessor), multi: true },
  ],
})
export class GodotToggleValueAccessor extends GodotValueAccessorBase<boolean, BaseButton> {
  override writeValue(value: boolean | null): void {
    super.writeValue(value);
    this.node.button_pressed = Boolean(value);
  }

  override setDisabledState(isDisabled: boolean): void {
    super.setDisabledState(isDisabled);
    this.node.disabled = isDisabled;
  }
}
