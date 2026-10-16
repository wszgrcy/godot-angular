import { Directive, forwardRef } from "@angular/core";
import { NG_VALUE_ACCESSOR } from "@angular/forms";
import type { Color, ColorPicker } from "godot";
import { GodotMouseDisabledBase } from "./base";

/**
 * `<ColorPicker [(ngModel)]="c">` —— 值是 Godot `Color` 对象，空值是 null。
 *
 * 指令只整体读写 `color` 属性，不访问它的分量：Color 是不可透明拆解的值，
 * 写入 `{ r,g,b,a }` 这种结构类型反而会放入一个普通对象，而 GodotJS 只接受 Color 实例。
 *
 * 按钮形态（点击后弹出色板）是 `ColorPickerButton`：它的值属性同名，变更信号也是
 * `color_changed`，将标签加入 selector 即可一并接入——但它的禁用走 `disabled` 而不是
 * mouse_filter，两个节点形状不同，因此未合并。
 */
@Directive({
  selector: `ColorPicker[ngModel],ColorPicker[formControl],ColorPicker[formControlName]`,
  host: { "(color_changed)": "valueAndTouchedChange($any($event))" },
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => GodotColorPickerValueAccessor), multi: true },
  ],
})
export class GodotColorPickerValueAccessor extends GodotMouseDisabledBase<Color | null, ColorPicker> {
  /** 没有“空颜色”可写，null 保持节点当前颜色 */
  protected override emptyValue(): Color | null {
    return null;
  }

  override writeValue(value: Color | null): void {
    super.writeValue(value);
    if (value) this.setNodeProperty("color", value);
  }

  override setDisabledState(isDisabled: boolean): void {
    super.setDisabledState(isDisabled);
    // ColorPicker 没有 editable / disabled，只能使其不接收鼠标输入
    this.setNodeInteractive(!isDisabled);
  }
}
