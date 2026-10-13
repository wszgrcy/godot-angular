/// <reference types="vitest" />
import { Component, NO_ERRORS_SCHEMA, provideZonelessChangeDetection, signal } from "@angular/core";
import { ComponentFixtureAutoDetect, TestBed } from "@angular/core/testing";
import { FormsModule } from "@angular/forms";
import { Color, Control, ItemList, Range } from "godot";
import {
  GodotColorPickerValueAccessor,
  GodotItemListValueAccessor,
  GodotOptionButtonValueAccessor,
  GodotScrollBarValueAccessor,
  GodotSliderValueAccessor,
  GodotSpinBoxValueAccessor,
  GodotTextEditValueAccessor,
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

describe("节点 → 模型：host 里绑的信号对不对", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("TextEdit 走 text_changed", async () => {
    @Component({
      selector: "t-fa-textedit",
      imports: [FormsModule, GodotTextEditValueAccessor],
      template: `<TextEdit [ngModel]="v()" (ngModelChange)="v.set($event)" [ngModelOptions]="{ standalone: true }"></TextEdit>`,
    })
    class C {
      v = signal("");
    }
    const fixture = await render(C);
    const node = findAllNodes(fixture.nativeElement, "TextEdit")[0];
    node.text = "多行\n内容";
    node.emit_signal("text_changed", "多行\n内容");
    await fixture.whenStable();
    expect(fixture.componentInstance.v()).toBe("多行\n内容");
  });

  it("HSlider 走 value_changed（不能再挂 slider_ended，否则同值推两遍）", async () => {
    @Component({
      selector: "t-fa-slider",
      imports: [FormsModule, GodotSliderValueAccessor],
      template: `<HSlider [ngModel]="v()" (ngModelChange)="v.set($event)" [ngModelOptions]="{ standalone: true }"></HSlider>`,
    })
    class C {
      v = signal(0);
    }
    const fixture = await render(C);
    const node = findAllNodes(fixture.nativeElement, "HSlider")[0];
    node.value = 42;
    node.emit_signal("value_changed", 42);
    await fixture.whenStable();
    expect(fixture.componentInstance.v()).toBe(42);
  });

  it("SpinBox 走 value_changed", async () => {
    @Component({
      selector: "t-fa-spinbox",
      imports: [FormsModule, GodotSpinBoxValueAccessor],
      template: `<SpinBox [ngModel]="v()" (ngModelChange)="v.set($event)" [ngModelOptions]="{ standalone: true }"></SpinBox>`,
    })
    class C {
      v = signal(0);
    }
    const fixture = await render(C);
    const node = findAllNodes(fixture.nativeElement, "SpinBox")[0];
    // 使用整数：SpinBox 的 step 缺省 1.0，Godot 的 Range::set_value 会将值对齐到
    // step 上（写 7.5 实际存储的是 8）。accessor 重读属性而不是采信 $event，
    // 因此模型拿到的是对齐后的值——本条验证的就是这个真实行为。
    node.value = 7;
    node.emit_signal("value_changed", 7);
    await fixture.whenStable();
    expect(fixture.componentInstance.v()).toBe(7);
  });

  it("HScrollBar 走 value_changed（不是 scrolled）", async () => {
    @Component({
      selector: "t-fa-scrollbar",
      imports: [FormsModule, GodotScrollBarValueAccessor],
      template: `<HScrollBar [ngModel]="v()" (ngModelChange)="v.set($event)" [ngModelOptions]="{ standalone: true }"></HScrollBar>`,
    })
    class C {
      v = signal(0);
    }
    const fixture = await render(C);
    const node = findAllNodes(fixture.nativeElement, "HScrollBar")[0];
    node.value = 30;
    node.emit_signal("value_changed", 30);
    await fixture.whenStable();
    expect(fixture.componentInstance.v()).toBe(30);
  });

  it("OptionButton 走 item_selected，值是下标", async () => {
    @Component({
      selector: "t-fa-option",
      imports: [FormsModule, GodotOptionButtonValueAccessor],
      template: `<OptionButton [ngModel]="v()" (ngModelChange)="v.set($event)" [ngModelOptions]="{ standalone: true }"></OptionButton>`,
    })
    class C {
      v = signal(-1);
    }
    const fixture = await render(C);
    const node = findAllNodes(fixture.nativeElement, "OptionButton")[0];
    node.add_item("甲");
    node.add_item("乙");
    node.add_item("丙");
    // 故意发送 item_selected。发送 toggled 也会命中继承自 Button 的那个信号，
    // 但那时读取不到下标。
    node.selected = 2;
    node.emit_signal("item_selected", 2);
    await fixture.whenStable();
    expect(fixture.componentInstance.v()).toBe(2);
  });

  it("ColorPicker 走 color_changed", async () => {
    @Component({
      selector: "t-fa-color",
      imports: [FormsModule, GodotColorPickerValueAccessor],
      template: `<ColorPicker [ngModel]="v()" (ngModelChange)="v.set($event)" [ngModelOptions]="{ standalone: true }"></ColorPicker>`,
    })
    class C {
      v = signal<unknown>(null);
    }
    const fixture = await render(C);
    const node = findAllNodes(fixture.nativeElement, "ColorPicker")[0];
    const red = new Color(1, 0, 0, 1);
    node.color = red;
    node.emit_signal("color_changed", red);
    await fixture.whenStable();
    const got = fixture.componentInstance.v() as { r: number; g: number; b: number };
    expect([got.r, got.g, got.b]).toEqual([1, 0, 0]);
  });
});

// —— 这批组件必须定义在下面那个 describe **之前**：
// describe 的回调在收集阶段就地执行，其中又要引用这些类型；写在后面就是 TDZ。
// AOT 也要求 template 是静态字符串，因此每个控件一个显式组件，不抽取工厂。


@Component({
  selector: "t-fa-w-slider",
  schemas: [NO_ERRORS_SCHEMA],
  imports: [FormsModule, GodotSliderValueAccessor],
  template: `<HSlider [ngModel]="v()" (ngModelChange)="v.set($event)" [ngModelOptions]="{ standalone: true }"></HSlider>`,
})
class SliderWidget {
  v = signal(0);
}

@Component({
  selector: "t-fa-w-spinbox",
  schemas: [NO_ERRORS_SCHEMA],
  imports: [FormsModule, GodotSpinBoxValueAccessor],
  template: `<SpinBox [ngModel]="v()" (ngModelChange)="v.set($event)" [ngModelOptions]="{ standalone: true }"></SpinBox>`,
})
class SpinBoxWidget {
  v = signal(0);
}

@Component({
  selector: "t-fa-w-scrollbar",
  schemas: [NO_ERRORS_SCHEMA],
  imports: [FormsModule, GodotScrollBarValueAccessor],
  template: `<HScrollBar [ngModel]="v()" (ngModelChange)="v.set($event)" [ngModelOptions]="{ standalone: true }"></HScrollBar>`,
})
class ScrollBarWidget {
  v = signal(0);
}

@Component({
  selector: "t-fa-w-textedit",
  schemas: [NO_ERRORS_SCHEMA],
  imports: [FormsModule, GodotTextEditValueAccessor],
  template: `<TextEdit [ngModel]="v()" (ngModelChange)="v.set($event)" [ngModelOptions]="{ standalone: true }"></TextEdit>`,
})
class WTextEdit {
  v = signal("");
}

@Component({
  selector: "t-fa-w-option",
  schemas: [NO_ERRORS_SCHEMA],
  imports: [FormsModule, GodotOptionButtonValueAccessor],
  template: `<OptionButton [ngModel]="v()" (ngModelChange)="v.set($event)" [ngModelOptions]="{ standalone: true }"></OptionButton>`,
})
class WOption {
  v = signal(-1);
}

describe("模型 → 节点：writeValue 写的属性对不对", () => {
  beforeEach(() => initGodotTestEnvironment());

  /**
   * 一个用例一个控件：TestBed 的根 Control 就是组件宿主，
   * `fixture.destroy()` 会将其 queue_free，同一个用例里再建第二个组件就建在已
   * 释放的节点上（引擎报 `get_class. Bad this`）。拆成多个用例后每个都有自己的根。
   */
  const writeChecks: [string, any, number][] = [
    ["HSlider", SliderWidget, 20],
    ["SpinBox", SpinBoxWidget, 3],
    ["HScrollBar", ScrollBarWidget, 10],
  ];
  for (const [tag, Comp, want] of writeChecks) {
    it(`${tag} 写 value`, async () => {
      const fixture = await render(Comp);
      // 三个候选（HSlider / SpinBox / HScrollBar）都继承 Range，value 就在那里
      const node = findAllNodes(fixture.nativeElement, tag)[0] as Range;
      fixture.componentInstance.v.set(want);
      await fixture.whenStable();
      expect([tag, node.value]).toEqual([tag, want]);
    });
  }

  it("TextEdit 写 text", async () => {
    const fixture = await render(WTextEdit);
    fixture.componentInstance.v.set("hi");
    const edit = findAllNodes(fixture.nativeElement, "TextEdit")[0];
    await fixture.whenStable();
    expect(edit.text).toBe("hi");
  });

  it("OptionButton 写 selected", async () => {
    const fixture = await render(WOption);
    const ob = findAllNodes(fixture.nativeElement, "OptionButton")[0];
    // 无候选项时写 selected 会被 Godot 静默忽略（selected 仍为 -1），因此先添加两项再修改模型。
    ob.add_item("甲");
    ob.add_item("乙");
    fixture.componentInstance.v.set(1);
    await fixture.whenStable();
    expect(ob.selected).toBe(1);
  });
});


/**
 * ItemList：ngModel 的值是“选中项的下标集合”（number[]），而不是候选项列表。
 * 候选项经 add_item 添加，不进入模型。单选模式发出 item_selected(index)，多选模式发出
 * multi_selected(index, selected)，两者均连接但值一律重读 get_selected_items()。
 */
@Component({
  selector: "t-fa-list",
  imports: [FormsModule, GodotItemListValueAccessor],
  template: `<ItemList [ngModel]="selected()" (ngModelChange)="selected.set($event)" [disabled]="off()" [ngModelOptions]="{ standalone: true }"></ItemList>`,
})
class ListWidget {
  /** 选中项的下标集合：[1] = 选择了第二项，[] = 一个也未选 */
  selected = signal<number[]>([]);
  off = signal(false);
}

/** 三项候选 + 可选多选模式（select_mode 是数据层的开关，模板中配置不如测试中直接设置） */
function makeList(fixture: any, multi = false): any {
  const list = findAllNodes(fixture.nativeElement, "ItemList")[0];
  list.add_item("甲");
  list.add_item("乙");
  list.add_item("丙");
  if (multi) list.select_mode = ItemList.SelectMode.SELECT_MULTI;
  return list;
}

describe("ItemList：节点 → 模型", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("单选模式走 item_selected，模型拿到 [下标]", async () => {
    const fixture = await render(ListWidget);
    const list = makeList(fixture);
    list.select(1);
    list.emit_signal("item_selected", 1);
    await fixture.whenStable();
    expect(fixture.componentInstance.selected()).toEqual([1]);
  });

  it("多选模式走 multi_selected，模型拿到整个选中集", async () => {
    const fixture = await render(ListWidget);
    const list = makeList(fixture, true);
    list.select(0, false);
    list.select(2, false);
    list.emit_signal("multi_selected", 2, true);
    await fixture.whenStable();
    expect(fixture.componentInstance.selected()).toEqual([0, 2]);
  });

  it("取消选择后是空数组，不是 [-1] 也不是 null", async () => {
    const fixture = await render(ListWidget);
    const list = makeList(fixture, true);
    list.select(1, false);
    list.emit_signal("multi_selected", 1, true);
    await fixture.whenStable();
    expect(fixture.componentInstance.selected()).toEqual([1]);
    list.deselect(1);
    list.emit_signal("multi_selected", 1, false);
    await fixture.whenStable();
    expect(fixture.componentInstance.selected()).toEqual([]);
  });
});

describe("ItemList：模型 → 节点", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("writeValue 重铺选中集，且不会反过来再触发信号", async () => {
    const fixture = await render(ListWidget);
    const list = makeList(fixture, true);
    fixture.componentInstance.selected.set([0, 2]);
    await fixture.whenStable();
    expect(list.is_selected(0)).toBe(true);
    expect(list.is_selected(1)).toBe(false);
    expect(list.is_selected(2)).toBe(true);
    // select() 不触发信号，因此重新赋值不会将模型冲掉
    expect(fixture.componentInstance.selected()).toEqual([0, 2]);
  });

  it("writeValue(null) 是清空选择", async () => {
    const fixture = await render(ListWidget);
    const list = makeList(fixture);
    list.select(1);
    fixture.componentInstance.selected.set(null);
    await fixture.whenStable();
    expect(list.is_anything_selected()).toBe(false);
  });

  it("ItemList 没有 editable / disabled，禁用走 mouse_filter", async () => {
    const fixture = await render(ListWidget);
    const list = makeList(fixture);
    fixture.componentInstance.off.set(true);
    await fixture.whenStable();
    expect(list.mouse_filter).toBe(Control.MouseFilter.MOUSE_FILTER_IGNORE);
  });
});
