import { Directive, ElementRef, inject, Renderer2, signal, WritableSignal } from "@angular/core";
import { ControlValueAccessor } from "@angular/forms";
import { Control } from "godot";
import type { Node } from "godot";

/**
 * 节点类型上界：就是引擎的 `Node`。
 * 子类直接使用具体控件类作为参数（`GodotValueAccessorBase<string, LineEdit>`）：
 * `typings/godot*.gen.d.ts` 中属性是 `get text(): string` / `set text(value: string)` 访问器，
 * 因此拼错属性名或写错类型都会在编译期报错。
 */
export type GodotNodeShape = Node;

/**
 * ControlValueAccessor 的底座：只负责 Angular 侧那四个回调的接线，一次节点属性也不访问。
 *
 * 两种用法：
 *  - 指令挂在现成控件上 → 继承 `GodotValueAccessorBase`（多一个 `node`）
 *  - 组件自身就是一整块复合控件 → 直接继承本类，自行决定读写哪个节点
 *
 * 没有 selector，也不应有：它不匹配任何元素，只作为抽象基类使用。
 */
export class GodotControlBase<T = unknown> implements ControlValueAccessor {
  /** 视图中的当前值。`writeValue` 与 `valueChange` 都会更新它 */
  readonly value$: WritableSignal<T> = signal<T>(this.emptyValue());

  /** `setDisabledState` 的镜像。控件是否真的支持禁用，由子类决定 */
  readonly disabled$: WritableSignal<boolean> = signal(false);

  protected emitValue?: (value: T) => void;
  #touched?: () => void;

  /**
   * 模型给出 null / undefined 时 `value$` 回退到的值（OptionButton 是 -1）。
   * 是方法而不是字段：子类字段初始化在基类之后执行，基类创建 signal 时还读不到子类的值。
   */
  protected emptyValue(): T {
    return undefined as T;
  }

  registerOnChange(fn: (value: T) => void): void {
    this.emitValue = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.#touched = fn;
  }

  /** 值发生变化：推给 Forms，并更新 `value$`。`setValue` 传 false 时只推送不记录 */
  valueChange(value: T, setValue = true): void {
    this.emitValue?.(value);
    if (setValue) this.value$.set(value);
  }

  /** 用户已交互过：touched 决定 ng-touched 与错误提示何时展示 */
  touchedChange(): void {
    this.#touched?.();
  }

  /** 用户完成修改：值与 touched 一并处理。控件的变更信号通常应使用本方法 */
  valueAndTouchedChange(value: T, setValue = true): void {
    this.valueChange(value, setValue);
    this.touchedChange();
  }

  /**
   * 子类覆写时需先调用 `super.writeValue(value)` 再写节点，否则 `value$` 会漏更新。
   * null 一定会到来（Forms 初始化时先创建空 FormControl），是否落到节点上由子类决定。
   */
  writeValue(value: T | null): void {
    this.value$.set(value ?? this.emptyValue());
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled$.set(isDisabled);
  }
}

/**
 * 指令底座：CVA 协议 + “指令所在的那个 Godot 节点”。
 *
 * N 通常就是引擎中的那个控件类（`Slider` / `OptionButton` / `ItemList` …）。一个例外是
 * 同一个指令选择器覆盖两个兄弟类时（`<HSlider>` / `<VSlider>` 都是 `Slider` 的子类，
 * 取共同基类 `Slider` 即可）。
 */
@Directive()
export abstract class GodotValueAccessorBase<
  T = unknown,
  N extends GodotNodeShape = GodotNodeShape,
> extends GodotControlBase<T> {
  protected readonly el = inject<ElementRef<N>>(ElementRef);

  /** 写节点属性的唯一通道，理由见 `setNodeProperty` */
  protected readonly renderer = inject(Renderer2);

  protected get node(): N {
    return this.el.nativeElement;
  }

  protected setNodeProperty<K extends keyof N & string>(prop: K, value: N[K]): void {
    this.renderer.setProperty(this.node, prop, value);
  }
}
const IGNORE = Control.MouseFilter.MOUSE_FILTER_IGNORE;

/**
 * 禁用兜底：`HScrollBar` / `VScrollBar` / `ItemList` / `ColorPicker` 既没有 `disabled`
 * 也没有 `editable`，只能用“鼠标穿透”表达禁用（`mouse_filter = IGNORE`）。
 *
 * 能拦住交互，但没有置灰外观，因此只在控件确实没有对应属性时才使用。
 *
 * 原值存在指令身上：`mouse_filter` 是一个槽位、多个写入者，写入 IGNORE 会覆盖模板 / 场景
 * 里的值，而读回来无法区分“原本就是 IGNORE”与“为禁用刚写入的 IGNORE”；各控件默认值并不
 * 一致（ScrollBar / ItemList 是 STOP，ColorPicker 是 PASS，Label 是 IGNORE），固定恢复成
 * STOP 会改错 ColorPicker。因此原值存在拥有该节点的指令实例上：每个控件一份，随指令一起
 * 创建与释放，不需要模块级表，也不依赖节点包装对象的身份。
 */
@Directive()
export abstract class GodotMouseDisabledBase<
  T = unknown,
  N extends Control = Control,
> extends GodotValueAccessorBase<T, N> {
  /** 被改为 IGNORE 之前的值；undefined 表示当前不是本类禁用的 */
  #savedMouseFilter?: number;

  /** 由子类的 `setDisabledState` 调用：禁用时穿透，解禁时交还原值 */
  protected setNodeInteractive(interactive: boolean): void {
    const node = this.node;

    if (!interactive) {
      // 只在第一次禁用时记原值，重复调用不会把 IGNORE 当成原值存下来
      this.#savedMouseFilter ??= node.mouse_filter;
      this.setNodeProperty("mouse_filter", IGNORE as N["mouse_filter"]);
      return;
    }

    const saved = this.#savedMouseFilter;
    this.#savedMouseFilter = undefined;
    // 仅当槽里仍是本类写入的 IGNORE 时才恢复。禁用期间若他人改过 mouse_filter，说明该
    // 属性已被接管，用快照覆盖会静默冲掉对方的写入，此处保留最后写入者
    if (saved !== undefined && node.mouse_filter === IGNORE) {
      this.setNodeProperty("mouse_filter", saved as N["mouse_filter"]);
    }
  }
}
