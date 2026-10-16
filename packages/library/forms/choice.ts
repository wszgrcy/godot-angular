import { Directive, forwardRef } from "@angular/core";
import { NG_VALUE_ACCESSOR } from "@angular/forms";
import type { ItemList, OptionButton } from "godot";
import { GodotMouseDisabledBase, GodotValueAccessorBase } from "./base";

/**
 * `<OptionButton [(ngModel)]="index">` —— 值是**选中项下标**（number），不是文本。
 *
 * Godot 中没有 `<select>` / `<option>` 那种父子结构：候选项是通过 `add_item()` 参加内部
 * PopupMenu 的数据，不是子节点，因此能双向绑定的只有下标。需要文本或自定义 id 时不应使用
 * ngModel——直接 `(item_selected)="onPick($event)"` 自行接入，再用 `get_item_text(i)` /
 * `get_item_id(i)` 取得；或者编写自己的 accessor 覆盖本指令（Angular 会优先使用它）。
 */
@Directive({
  selector: `OptionButton[ngModel],OptionButton[formControl],OptionButton[formControlName]`,
  // 必须使用 item_selected，不能写 pressed / toggled：OptionButton 继承 Button，
  // 那两个信号它同样拥有，接错则永远读不到下标。
  host: { "(item_selected)": "valueAndTouchedChange($any($event))" },
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => GodotOptionButtonValueAccessor), multi: true },
  ],
})
export class GodotOptionButtonValueAccessor extends GodotValueAccessorBase<number, OptionButton> {
  /** 未选中任何项 */
  protected override emptyValue(): number {
    return -1;
  }

  override writeValue(value: number | null): void {
    super.writeValue(value);
    // 只把“未选中”这个空值表达出来。越界下标 Godot 是静默忽略（selected 保持原值），
    // 因此候选项发生变化时，需要调用方自行重设模型——校验不是适配层的职责。
    this.setNodeProperty("selected", value ?? this.emptyValue());
  }

  override setDisabledState(isDisabled: boolean): void {
    super.setDisabledState(isDisabled);
    this.setNodeProperty("disabled", isDisabled);
  }
}

/**
 * `<ItemList [(ngModel)]="selected">` —— ngModel 绑定的是**选中项的下标集合**（number[]）。
 *
 * 三件事不要混淆，只有中间那件走 ngModel：
 *
 *   候选项（列表内容）  add_item("甲") / add_item("乙")   节点自己的数据
 *   选中项（= 值）      [0, 2]                          ngModel 绑定的就是这个
 *   选中项的文本        get_item_text(0) → "甲"         需要文本时不要使用 ngModel
 *
 * 为什么只能是数组：`select_mode` 决定能选几个——SELECT_SINGLE 下它退化成 [] / [i]，
 * SELECT_MULTI / SELECT_TOGGLE 下才是多个。只需单选时请直接使用 OptionButton（值是单个
 * number），或者自行编写一个将数组拆成单值的 accessor 覆盖本指令。
 *
 * 形状上它与 OptionButton 最大的差别：ItemList 没有 `selected` 属性，选中集只能
 * `select()` / `deselect_all()` 写入、`get_selected_items()` 读取，因此读写的是数组而不是某个属性。
 * 单选模式发 `item_selected(index)`，多选 / 切换模式发 `multi_selected(index, selected)`，
 * 两个都接，但值一律重读选中集：信号只说明“刚变动的那一项”，不说明整个选中集。
 */
@Directive({
  selector: `ItemList[ngModel],ItemList[formControl],ItemList[formControlName]`,
  host: {
    "(item_selected)": "pushSelection()",
    "(multi_selected)": "pushSelection()",
  },
  providers: [
    { provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => GodotItemListValueAccessor), multi: true },
  ],
})
export class GodotItemListValueAccessor extends GodotMouseDisabledBase<number[], ItemList> {
  /** 一个也未选中 */
  protected override emptyValue(): number[] {
    return [];
  }

  override writeValue(value: number[] | null): void {
    super.writeValue(value);
    // select() 不会反向触发信号，重新铺设不会循环。single=false 是为了使多选模式下
    // 后面的下标不会挤掉前面的（单选模式下 Godot 自身只保留一个）。
    // 下标越界、重复、类型不符均不处理：那是模型的职责，适配层不代为兼容。
    this.node.deselect_all();
    for (const index of value ?? this.emptyValue()) this.node.select(index, false);
  }

  /** 视图中的选中集 → 模型（数组，不是单值） */
  pushSelection(): void {
    // PackedInt32Array 不可迭代：只有 size() / get(i)，Array.from 会静默返回空数组
    const packed = this.node.get_selected_items();
    const indexes: number[] = [];
    for (let i = 0, n = Number(packed.size()); i < n; i++) indexes.push(Number(packed.get(i)));
    this.valueAndTouchedChange(indexes);
  }

  override setDisabledState(isDisabled: boolean): void {
    super.setDisabledState(isDisabled);
    // ItemList 既没有 editable 也没有 disabled，只能使其不接收鼠标输入
    this.setNodeInteractive(!isDisabled);
  }
}
