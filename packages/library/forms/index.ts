export {
  GodotControlBase,
  GodotMouseDisabledBase,
  GodotValueAccessorBase,
  type GodotNodeShape,
} from "./base";
export { GodotLineEditValueAccessor, GodotTextEditValueAccessor } from "./text";
export {
  GodotSliderValueAccessor,
  GodotSpinBoxValueAccessor,
  GodotScrollBarValueAccessor,
} from "./range";
export { GodotToggleValueAccessor } from "./toggle";
export { GodotItemListValueAccessor, GodotOptionButtonValueAccessor } from "./choice";
export { GodotColorPickerValueAccessor } from "./color";

import { GodotColorPickerValueAccessor } from "./color";
import { GodotItemListValueAccessor, GodotOptionButtonValueAccessor } from "./choice";
import { GodotLineEditValueAccessor, GodotTextEditValueAccessor } from "./text";
import { GodotScrollBarValueAccessor, GodotSliderValueAccessor, GodotSpinBoxValueAccessor } from "./range";
import { GodotToggleValueAccessor } from "./toggle";

/** 全部表单指令的集合；建议按需 import 单个指令 */
export const GODOT_FORM_DIRECTIVES = [
  GodotLineEditValueAccessor,
  GodotTextEditValueAccessor,
  GodotSliderValueAccessor,
  GodotSpinBoxValueAccessor,
  GodotScrollBarValueAccessor,
  GodotToggleValueAccessor,
  GodotOptionButtonValueAccessor,
  GodotItemListValueAccessor,
  GodotColorPickerValueAccessor,
];
