/// <reference types="vitest" />
/**
 * 标签身份：同一个标签可能是 HTML 别名（div）、Godot 类名（Label），也可能是自定义组件的
 * 选择器（ui-card / UiCard）。渲染器要认出第三种，否则会把正常写法报成错误。
 *
 * 全部走真实 TestBed：判断依据是编译进组件定义的依赖表，只有真编译产物才有。
 */
import { Component, Directive, NO_ERRORS_SCHEMA, Type, ViewContainerRef, inject, provideZonelessChangeDetection } from "@angular/core";
import { NgIf } from "@angular/common";
import { TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { CssCode } from "godot-angular/css";
import { captureWarn, initGodotTestEnvironment, type WarnCapture } from "godot-angular/testing";

/** 编译好组件但不创建：创建过程才触发 createElement，告警要包在创建外面抓 */
async function compile<T>(component: Type<T>): Promise<void> {
  await TestBed.configureTestingModule({
    imports: [component],
    providers: [provideZonelessChangeDetection()],
  }).compileComponents();
}

/** 创建组件并抓住创建期间的全部告警（含 *ngIf 这类要等一轮变更检测才建出来的节点） */
function createAndCapture<T>(component: Type<T>) {
  return captureWarn(() => {
    const fixture = TestBed.createComponent(component);
    fixture.detectChanges();
    return fixture;
  });
}

/** 某个诊断码有没有出现过 */
function hasCode(warn: WarnCapture, code: CssCode): boolean {
  return warn.codes.includes(code);
}

describe("自定义组件的标签", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("小写选择器的组件宿主是 VBoxContainer，且不告警", async () => {
    @Component({ selector: "ui-card", template: `<Label text="card"></Label>` })
    class CardComp {}

    @Component({
      selector: "t-host",
      imports: [CardComp],
      template: `<ui-card></ui-card>`,
    })
    class HostComp {}

    await compile(HostComp);
    const { result: fixture, warn } = createAndCapture(HostComp);
    expect(fixture.nativeElement.get_child(0).get_class()).toBe("VBoxContainer");
    expect(hasCode(warn, CssCode.NodeClassFallback)).toBe(false);
  });

  it("大写开头的组件选择器不再被误报成「不是可用的 Godot 节点类」", async () => {
    @Component({ selector: "UiCard", template: `<Label text="card"></Label>` })
    class UiCardComp {}

    @Component({
      selector: "t-host",
      imports: [UiCardComp],
      template: `<UiCard></UiCard>`,
    })
    class HostComp {}

    await compile(HostComp);
    const { result: fixture, warn } = createAndCapture(HostComp);
    // 宿主仍然是降级出来的容器（组件宿主本来就不是引擎类）
    expect(fixture.nativeElement.get_child(0).get_class()).toBe("VBoxContainer");
    expect(hasCode(warn, CssCode.NodeClassFallback)).toBe(false);
  });

  it("指令的元素选择器同样算自定义标签", async () => {
    @Directive({ selector: "MyThing", standalone: true })
    class MyThingDir {}

    @Component({
      selector: "t-host",
      imports: [MyThingDir],
      template: `<MyThing></MyThing>`,
    })
    class HostComp {}

    await compile(HostComp);
    const { warn } = createAndCapture(HostComp);
    expect(hasCode(warn, CssCode.NodeClassFallback)).toBe(false);
  });

  it("带属性条件的选择器不算标签：*ngIf 包着的错别字照样报出来", async () => {
    @Component({
      selector: "t-host",
      imports: [NgIf],
      template: `<TotallyBogus *ngIf="true"></TotallyBogus>`,
    })
    class HostComp {}

    await compile(HostComp);
    const { warn } = createAndCapture(HostComp);
    expect(hasCode(warn, CssCode.NodeClassFallback)).toBe(true);
  });

  it("模板里没见过的 PascalCase 标签仍然告警（拼错的类名不能被闭嘴）", async () => {
    @Component({
      selector: "t-host",
      imports: [NgIf],
      template: `<VBoxContiner></VBoxContiner>`,
    })
    class HostComp {}

    await compile(HostComp);
    const { warn } = createAndCapture(HostComp);
    expect(hasCode(warn, CssCode.NodeClassFallback)).toBe(true);
  });

  it("标签先按 Godot 类名解析：与引擎类撞名的组件宿主仍是那个引擎类", async () => {
    @Component({ selector: "Panel", template: `<Label text="p"></Label>` })
    class PanelComp {}

    @Component({
      selector: "t-host",
      imports: [PanelComp],
      template: `<Panel></Panel>`,
    })
    class HostComp {}

    await compile(HostComp);
    const { result: fixture, warn } = createAndCapture(HostComp);
    expect(fixture.nativeElement.get_child(0).get_class()).toBe("Panel");
    expect(hasCode(warn, CssCode.NodeClassFallback)).toBe(false);
  });

  it("动态创建的组件拿不到视图：不报错也不误报", async () => {
    @Component({ selector: "DynComp", template: `<Label text="d"></Label>` })
    class DynComp {}

    @Component({ selector: "t-host", template: `` })
    class HostComp {
      vcr = inject(ViewContainerRef);
    }

    await compile(HostComp);
    const { result: fixture } = createAndCapture(HostComp);

    // 宿主由 Angular 的 renderComponent 直接建，此刻没有正在执行的视图
    const { result: ref, warn } = captureWarn(() => fixture.componentInstance.vcr.createComponent(DynComp));
    expect(ref.location.nativeElement.get_class()).toBe("VBoxContainer");
    expect(hasCode(warn, CssCode.NodeClassFallback)).toBe(false);
  });
});
