/// <reference types="vitest" />
/**
 * 样式刷新的时机（真引擎 + 真 Angular 变更检测）。
 *
 * 此前 `Cascade` 自行排入 requestAnimationFrame：样式要等下一帧才写入，因此「首帧无样式」
 * 需要额外调用一次 flush，断言也普遍需要 `awaitFrames`。现在刷新由 Angular 的 effect 驱动，
 * 与变更检测在同一次内完成，因此下面几条是确定的行为，不是「通常也会生效」。
 *
 * 每条都刻意**不**调用 `awaitFrames`，也不调用 `runtime.flush()`——这两件事正是旧写法必须做的。
 *
 * 断言写法：一律先判断 `has_theme_*_override`（到底有没有写入过），再判断具体颜色分量。
 * Godot 的默认字体色是白色，若只断言某个通道等于 1，默认值同样满足该断言，等于未作校验。
 */
import { Component, Type, provideZonelessChangeDetection, signal } from "@angular/core";
import { ComponentFixture, ComponentFixtureAutoDetect, TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { Button } from "godot";
import { initGodotTestEnvironment } from "godot-angular/testing";

async function render<T>(component: Type<T>): Promise<ComponentFixture<T>> {
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

/** 按名称查找子节点（深度优先），与 css-angular.spec 同一口径 */
function findByName(node: any, name: string): any {
  const count = node.get_child_count();
  for (let i = 0; i < count; i++) {
    const child = node.get_child(i);
    if (child.get_name() === name) return child;
    const deeper = findByName(child, name);
    if (deeper) return deeper;
  }
  return null;
}

beforeEach(() => initGodotTestEnvironment());

describe("样式刷新与变更检测在同一次内完成", () => {
  it("首帧：whenStable() 之后组件样式已写入（没有等一帧）", async () => {
    @Component({
      selector: "t-first",
      styles: [`.probe { color: rgb(255, 0, 0); }`],
      template: `<Label name="probe" class="probe">hi</Label>`,
    })
    class FirstComp {}

    const fixture = await render(FirstComp);
    const label = findByName(fixture.nativeElement, "probe");
    expect(label.has_theme_color_override("font_color")).toBe(true);
    expect(label.get_theme_color("font_color").r).toBeCloseTo(1, 3);
    expect(label.get_theme_color("font_color").g).toBeCloseTo(0, 3);
  });

  it("detectChanges() 返回时，class 绑定造成的样式变化已写入", async () => {
    @Component({
      selector: "t-class",
      styles: [`.on { color: rgb(0, 0, 255); }`],
      template: `<Label name="lbl" [class.on]="on()">hi</Label>`,
    })
    class ClassComp {
      on = signal(false);
    }

    const fixture = await render(ClassComp);
    const label = findByName(fixture.nativeElement, "lbl");
    expect(label.has_theme_color_override("font_color")).toBe(false);

    fixture.componentInstance.on.set(true);
    fixture.detectChanges();
    // 关键断言：此处没有 awaitFrames、没有手动 flush，样式却已写入
    expect(label.has_theme_color_override("font_color")).toBe(true);
    expect(label.get_theme_color("font_color").b).toBeCloseTo(1, 3);
    expect(label.get_theme_color("font_color").r).toBeCloseTo(0, 3);

    fixture.componentInstance.on.set(false);
    fixture.detectChanges();
    expect(label.has_theme_color_override("font_color")).toBe(false);
  });

  it("detectChanges() 返回时，@if 新增节点的样式已写入", async () => {
    @Component({
      selector: "t-if",
      styles: [`.late { color: rgb(0, 0, 255); }`],
      template: `@if (show()) { <Label name="late" class="late">late</Label> }`,
    })
    class IfComp {
      show = signal(false);
    }

    const fixture = await render(IfComp);
    expect(findByName(fixture.nativeElement, "late")).toBeNull();

    fixture.componentInstance.show.set(true);
    fixture.detectChanges();
    const late = findByName(fixture.nativeElement, "late");
    expect(late, "@if 没渲染出节点").toBeTruthy();
    expect(late.has_theme_color_override("font_color")).toBe(true);
  });

  it("引擎信号驱动的伪类：whenStable() 之后已写入（Angular 不跟踪这个来源）", async () => {
    @Component({
      selector: "t-hover",
      styles: [`.btn:hover { color: rgb(0, 255, 0); }`],
      template: `<Button name="btn" class="btn">b</Button>`,
    })
    class HoverComp {}

    const fixture = await render(HoverComp);
    const btn = findByName(fixture.nativeElement, "btn") as Button;
    expect(btn.has_theme_color_override("font_hover_color")).toBe(false);

    // 悬停来自引擎信号，不经过任何 Angular 绑定：节点被标记之后，仍需有人执行刷新
    btn.emit_signal("mouse_entered");
    await fixture.whenStable();
    expect(btn.has_theme_color_override("font_hover_color")).toBe(true);
    expect(btn.get_theme_color("font_hover_color").g).toBeCloseTo(1, 3);

    btn.emit_signal("mouse_exited");
    await fixture.whenStable();
    expect(btn.has_theme_color_override("font_hover_color")).toBe(false);
  });

  it("内联样式绑定当场生效（渲染器调用 applyNow，不经过调度器）", async () => {
    @Component({
      selector: "t-style",
      template: `<Label name="lbl" [style.font-size]="size()">12</Label>`,
    })
    class StyleComp {
      size = signal("12px");
    }

    const fixture = await render(StyleComp);
    const label = findByName(fixture.nativeElement, "lbl");
    expect(label.get_theme_font_size("font_size")).toBe(12);

    fixture.componentInstance.size.set("30px");
    fixture.detectChanges();
    expect(label.get_theme_font_size("font_size")).toBe(30);
  });
});
