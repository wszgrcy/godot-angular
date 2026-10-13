/// <reference types="vitest" />
import { provideZonelessChangeDetection } from "@angular/core";
import { ComponentFixtureAutoDetect, TestBed } from "@angular/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Control, Label } from "godot";
import { App } from "../../app";
import {
  awaitFrames,
  findAllNodes,
  initGodotTestEnvironment,
  walkNodes,
} from "godot-angular/testing";

/** 按 text 查找 Label 或 Button（demo 中的按钮均依靠 text 定位）。 */
function byText(root: any, text: string): any {
  return (
    walkNodes(root).find((n) => /^(Label|Button)$/.test(n.get_class()) && (n as { text?: string }).text === text) ??
    null
  );
}

function itemLabels(root: any): Label[] {
  return findAllNodes(root, "Label").filter((l) => /^item-\d$/.test(l.text));
}

/** 标准形状：configureTestingModule(+autoDetect/zoneless) → createComponent → whenStable */
async function renderApp(): Promise<any> {
  await TestBed.configureTestingModule({
    imports: [App],
    providers: [
      { provide: ComponentFixtureAutoDetect, useValue: true },
      provideZonelessChangeDetection(),
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(App);
  await fixture.whenStable();
  return fixture;
}

describe("demo app 端到端（真引擎 + 真布局）", () => {
  let fixture: any = null;

  beforeEach(() => {
    // 视口尺寸影响布局，但返回的根节点不参与断言（布局一律从 fixture.nativeElement 取）
    initGodotTestEnvironment({ width: 1024, height: 768 });
  });

  afterEach(() => {
    fixture?.destroy();
    fixture = null;
  });

  it("初始渲染：结构、@if、@for、@switch、ng-content 全到位", async () => {
    fixture = await renderApp();
    const r = fixture.nativeElement;

    expect(findAllNodes(r, "VBoxContainer").length).toBeGreaterThan(0);
    expect(byText(r, "godot-angular — Angular in Godot")).not.toBeNull();
    expect(byText(r, "count = 0")).not.toBeNull();
    expect(byText(r, "@if 为真时存在")).not.toBeNull();
    expect(itemLabels(r)).toHaveLength(3);
    expect(byText(r, "模式 A")).not.toBeNull();
    expect(byText(r, "这行是被投影进来的内容")).not.toBeNull();
  });

  it("Button.pressed → (click) → signal → 重渲染", async () => {
    fixture = await renderApp();
    const r = fixture.nativeElement;

    const plus = byText(r, "+1");
    expect(plus).not.toBeNull();

    plus.emit_signal("pressed");
    await fixture.whenStable();
    expect(byText(r, "count = 1")).not.toBeNull();

    plus.emit_signal("pressed");
    plus.emit_signal("pressed");
    await fixture.whenStable();
    expect(byText(r, "count = 3")).not.toBeNull();
  });

  it("@if 切换会真的增删节点", async () => {
    fixture = await renderApp();
    const r = fixture.nativeElement;

    byText(r, "toggle @if").emit_signal("pressed");
    await fixture.whenStable();
    expect(byText(r, "@if 为假")).not.toBeNull();
    expect(byText(r, "@if 为真时存在")).toBeNull();

    byText(r, "toggle @if").emit_signal("pressed");
    await fixture.whenStable();
    expect(byText(r, "@if 为真时存在")).not.toBeNull();
  });

  it("@for 增删改都能反映到节点树", async () => {
    fixture = await renderApp();
    const r = fixture.nativeElement;

    byText(r, "add").emit_signal("pressed");
    await fixture.whenStable();
    expect(itemLabels(r)).toHaveLength(4);

    byText(r, "remove").emit_signal("pressed");
    await fixture.whenStable();
    expect(itemLabels(r)).toHaveLength(3);
    expect(itemLabels(r)[0].text).toBe("item-2");
  });

  it("@switch 换分支", async () => {
    fixture = await renderApp();
    const r = fixture.nativeElement;

    byText(r, "cycle @switch").emit_signal("pressed");
    await fixture.whenStable();
    expect(byText(r, "模式 B")).not.toBeNull();
    expect(byText(r, "模式 A")).toBeNull();
  });

  it("LineEdit.text_changed → (input) 回写", async () => {
    fixture = await renderApp();
    const r = fixture.nativeElement;

    const edit = findAllNodes(r, "LineEdit")[0];
    expect(edit).toBeTruthy();
    edit.text = "typed text";
    edit.emit_signal("text_changed", "typed text");
    await fixture.whenStable();
    expect(byText(r, "input: typed text")).not.toBeNull();
  });

  it("容器布局真的跑了（只有真引擎能证明）", async () => {
    fixture = await renderApp();
    await awaitFrames(3);
    const r = fixture.nativeElement;

    const demo = findAllNodes(r, "VBoxContainer")[0];
    expect(demo.size.x).toBeGreaterThan(0);
    expect(demo.size.y).toBeGreaterThan(0);

    const kids = (demo.get_children()
      ? Array.from({ length: demo.get_child_count() }, (_, i) => demo.get_child(i)).filter(
          (c) => c.get_class() !== "Node",
        )
      : []) as Control[];
    expect(kids.length).toBeGreaterThan(1);
    expect(kids[1].position.y).toBeGreaterThan(kids[0].position.y);
    expect(kids[0].size.x).toBe(demo.size.x);
  });

  it("属性写入与 theme 覆盖落到真节点", async () => {
    fixture = await renderApp();
    await awaitFrames(3);
    const r = fixture.nativeElement;

    const styled = byText(r, "styled label");
    expect(styled).not.toBeNull();
    // custom_minimum_size 绑的是 new Vector2(0, 40)：最小高度要真实落地
    expect(Math.round(styled.size.y)).toBeGreaterThanOrEqual(40);
    expect(styled.has_theme_color_override("font_color")).toBe(true);
    expect(styled.has_theme_font_size_override("font_size")).toBe(true);
  });
});
