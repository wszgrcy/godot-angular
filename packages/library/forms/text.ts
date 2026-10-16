import { Directive, forwardRef } from "@angular/core";
import { NG_VALUE_ACCESSOR } from "@angular/forms";
import type { LineEdit, TextEdit } from "godot";
import { GodotValueAccessorBase } from "./base";

/** `<LineEdit [(ngModel)]="x">` —— 单行文本 */
@Directive({
  selector: `LineEdit[ngModel],LineEdit[formControl],LineEdit[formControlName]`,
  // text_changed(new_text: String)：$event 就是新值，无需回读属性。
  // text_submitted 的语义是“按下回车”，属于动作而不属于值变化，需要它时在模板里自行写 (text_submitted)="..."。
  // $any：编译器的 host 监听默认将 $event 视为 DOM Event，而 Godot 信号递来的就是值本身。
  host: { "(text_changed)": "valueAndTouchedChange($any($event))" },
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => GodotLineEditValueAccessor), multi: true },
  ],
})
export class GodotLineEditValueAccessor extends GodotValueAccessorBase<string, LineEdit> {
  override writeValue(value: string | null): void {
    super.writeValue(value);
    // Forms 初始化一定会调用 writeValue(null)，而将 null 写入 text 会中断 ngOnChanges，
    // 后续的真实值无法再写入。
    this.setNodeProperty("text", value ?? "");
  }

  override setDisabledState(isDisabled: boolean): void {
    super.setDisabledState(isDisabled);
    this.setNodeProperty("editable", !isDisabled);
  }
}

/** `<TextEdit [(ngModel)]="x">` —— 多行文本 */
@Directive({
  selector: `TextEdit[ngModel],TextEdit[formControl],TextEdit[formControlName]`,
  host: { "(text_changed)": "valueAndTouchedChange($any($event))" },
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => GodotTextEditValueAccessor), multi: true },
  ],
})
export class GodotTextEditValueAccessor extends GodotValueAccessorBase<string, TextEdit> {
  override writeValue(value: string | null): void {
    super.writeValue(value);
    this.setNodeProperty("text", value ?? "");
  }

  override setDisabledState(isDisabled: boolean): void {
    super.setDisabledState(isDisabled);
    this.setNodeProperty("editable", !isDisabled);
  }
}
