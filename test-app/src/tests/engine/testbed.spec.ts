/// <reference types="vitest" />
import { Component, ElementRef, Type, provideZonelessChangeDetection, signal, viewChild } from "@angular/core";
import { ComponentFixture, ComponentFixtureAutoDetect, TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { initGodotTestEnvironment } from "godot-angular/testing";

describe("TestBed 环境（引擎 + AOT）", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("组件是 AOT 编译的：template 已经是函数", () => {
    @Component({ selector: "t-aot", template: `<Label text="aot"></Label>` })
    class AotComp {}

    // JIT 下这两项是 undefined：模板 / viewQuery 需要运行时编译才会生成
    expect(typeof (AotComp as any).ɵcmp.template).toBe("function");
  });

  it("TestBed 渲染出的是引擎真实节点", async () => {
    @Component({
      selector: "t-hello",
      template: `<Label text="hello"></Label>`,
    })
    class HelloComp {}

    await TestBed.configureTestingModule({
      imports: [HelloComp],
      providers: [
        { provide: ComponentFixtureAutoDetect, useValue: true },
        provideZonelessChangeDetection(),
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(HelloComp);
    await fixture.whenStable();

    const label = fixture.nativeElement.get_child(0);
    expect(label.get_class()).toBe("Label");
    expect(label.text).toBe("hello");
  });

  it("signal 改完 whenStable 就落到真节点", async () => {
    @Component({
      selector: "t-sig",
      template: `<Label text="{{ count() }}"></Label>`,
    })
    class SigComp {
      count = signal(0);
    }

    const fixture = await render(SigComp);
    const label = fixture.nativeElement.get_child(0);
    expect(label.text).toBe("0");

    fixture.componentInstance.count.set(7);
    await fixture.whenStable();
    expect(label.text).toBe("7");
  });

  it("viewChild.required 拿到的是真 Control", async () => {
    @Component({
      selector: "t-vc",
      template: `<Label #lbl text="queried"></Label>`,
    })
    class QueryComp {
      lbl = viewChild.required<ElementRef>("lbl");
    }

    const fixture = await render(QueryComp);
    const node = fixture.componentInstance.lbl().nativeElement;
    expect(node.get_class()).toBe("Label");
    expect(node.text).toBe("queried");
    expect(node).toBe(fixture.nativeElement.get_child(0));
  });
});

/** 标准形状：configureTestingModule(+autoDetect/zoneless) → createComponent → whenStable */
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
