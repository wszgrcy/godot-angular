/**
 * 结构变化（`@if` / `@else` / `@for` / `@switch`）与 CSS 的联动。
 *
 * 判据与其余 CSS 用例一致：只看节点上的主题覆盖。这里额外要钉的是**时机**——
 * 节点是运行期才出现或消失的，选择器要跟着重查，而且引擎结构里混着「不是作者写的元素」：
 * 锚点（`@if` / `@for` 的定位占位，`createComment` 出来的裸 `Node`）。
 *
 * DOM 里锚点是注释节点，`nextElementSibling` 会跳过，因此 `A + B` 不会被它隔开；
 * Godot 侧它同样占一个兄弟位，不跳过就会出现「`@if` 一开，相邻兄弟选择器静默失配」。
 * 插值 `{{ … }}` 不在考虑范围内：文字一律按 `<Label text="…" />` 写。
 */
import { Component, provideZonelessChangeDetection, signal, type Type } from "@angular/core";
import { ComponentFixture, ComponentFixtureAutoDetect, TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { initGodotTestEnvironment, awaitFrames, resetWarnOnce } from "godot-angular/testing";
import { STYLE_RUNTIME, type StyleRuntime } from "godot-angular/core";
import type { Control } from "godot";

beforeEach(() => {
  initGodotTestEnvironment();
  resetWarnOnce();
});

async function render<T>(component: Type<T>): Promise<ComponentFixture<T>> {
  await TestBed.configureTestingModule({
    imports: [component],
    providers: [{ provide: ComponentFixtureAutoDetect, useValue: true }, provideZonelessChangeDetection()],
  }).compileComponents();
  const fixture = TestBed.createComponent(component);
  await fixture.whenStable();
  await awaitFrames(2);
  return fixture;
}

/** 渲染后的稳定推进：变更检测 + 级联的帧末结算 + 布局 */
async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  await fixture.whenStable();
  await awaitFrames(2);
}

function findByName(node: Control, name: string): Control | null {
  for (let i = 0; i < node.get_child_count(); i++) {
    const child = node.get_child(i) as Control;
    if (child.get_name() === name) return child;
    const deeper = findByName(child, name);
    if (deeper) return deeper;
  }
  return null;
}

/**
 * `@for` 项就是 `name="list"` 容器的直接 Label 子级：锚点是裸 `Node`，
 * 插值生成的文本 Label 在项内部，两者都不会混进来。
 */
function itemLabels(root: Control): Control[] {
  const list = findByName(root, "list") as Control;
  const out: Control[] = [];
  for (let i = 0; i < list.get_child_count(); i++) {
    const child = list.get_child(i) as Control;
    if (child.get_class() === "Label") out.push(child);
  }
  return out;
}

/** 按类名收集（深度优先，文档顺序）：`@for` 生成的同构项用它数最方便 */
function findAll<K extends string>(root: Control, className: K): Control[] {
  const out: Control[] = [];
  const walk = (node: Control): void => {
    for (let i = 0; i < node.get_child_count(); i++) {
      const child = node.get_child(i) as Control;
      if (child.get_class() === className) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

function color(node: Control, item = "font_color"): string {
  const c = node.get_theme_color(item);
  const hex = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
}

function boxColor(node: Control, item = "panel"): string {
  const box = (node as unknown as { get_theme_stylebox: (i: string) => { bg_color: { r: number; g: number; b: number } } })
    .get_theme_stylebox(item);
  const c = box.bg_color;
  const hex = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
}

function runtime(): StyleRuntime {
  return TestBed.inject(STYLE_RUNTIME);
}

/* ------------------------------------------------------------------ *
 * @if
 * ------------------------------------------------------------------ */

describe("@if 增删节点", () => {
  it("新增的节点立刻拿到 class 样式", async () => {
    @Component({
      selector: "sc-if-a",
      styles: [`.kid { color: rgb(20, 20, 20); font-size: 22px; }`],
      template: `<VBoxContainer>@if (show()) { <Label name="dyn" class="kid">d</Label> }</VBoxContainer>`,
    })
    class Comp {
      show = signal(false);
    }

    const fixture = await render(Comp);
    expect(findByName(fixture.nativeElement, "dyn")).toBeNull();

    fixture.componentInstance.show.set(true);
    await settle(fixture);
    const dyn = findByName(fixture.nativeElement, "dyn");
    expect(dyn).toBeTruthy();
    expect(color(dyn!)).toBe("#141414");
    expect(dyn!.get_theme_font_size("font_size")).toBe(22);
  });

  it("移除节点不影响留下的兄弟，再开回来样式照样生效", async () => {
    @Component({
      selector: "sc-if-b",
      styles: [`.keep { color: rgb(30, 30, 30); } .gone { color: rgb(40, 40, 40); }`],
      template: `<VBoxContainer>
        <Label name="keep" class="keep">k</Label>
        @if (show()) { <Label name="gone" class="gone">g</Label> }
      </VBoxContainer>`,
    })
    class Comp {
      show = signal(true);
    }

    const fixture = await render(Comp);
    const keep = findByName(fixture.nativeElement, "keep")!;
    expect(color(keep)).toBe("#1e1e1e");

    fixture.componentInstance.show.set(false);
    await settle(fixture);
    expect(findByName(fixture.nativeElement, "gone")).toBeNull();
    expect(color(keep)).toBe("#1e1e1e");

    fixture.componentInstance.show.set(true);
    await settle(fixture);
    expect(color(findByName(fixture.nativeElement, "gone")!)).toBe("#282828");
  });

  it("祖先 class 变化后，@if 新增的后代按新祖先取样式", async () => {
    @Component({
      selector: "sc-if-c",
      styles: [`.on .kid { color: rgb(50, 50, 50); } .kid { color: rgb(60, 60, 60); }`],
      template: `<VBoxContainer [class.on]="on()">@if (show()) { <Label name="kid" class="kid">k</Label> }</VBoxContainer>`,
    })
    class Comp {
      on = signal(true);
      show = signal(false);
    }

    const fixture = await render(Comp);
    fixture.componentInstance.show.set(true);
    await settle(fixture);
    // `.on .kid`（0,2,0）压过后写的 `.kid`（0,1,0）
    expect(color(findByName(fixture.nativeElement, "kid")!)).toBe("#323232");

    fixture.componentInstance.on.set(false);
    await settle(fixture);
    expect(color(findByName(fixture.nativeElement, "kid")!)).toBe("#3c3c3c");
  });

  it("@if 移除正在悬停的节点：祖先不留在悬停态", async () => {
    @Component({
      selector: "sc-if-d",
      styles: [
        `.row { background-color: rgb(255, 255, 255); }`,
        `.row:hover { background-color: rgb(1, 2, 3); }`,
      ],
      template: `<PanelContainer name="row" class="row">@if (show()) { <CheckBox name="cb">x</CheckBox> }</PanelContainer>`,
    })
    class Comp {
      show = signal(true);
    }

    const fixture = await render(Comp);
    const row = findByName(fixture.nativeElement, "row")!;
    const cb = findByName(fixture.nativeElement, "cb")!;
    cb.emit_signal("mouse_entered");
    await awaitFrames(1);
    expect(boxColor(row)).toBe("#010203");

    // 引擎在节点被摘走时不补发 mouse_exited，靠的是 tree_exited 兜底
    fixture.componentInstance.show.set(false);
    await settle(fixture);
    expect(boxColor(row)).toBe("#ffffff");
  });

  it("@if 新增的节点带 :hover 规则时，信号已连上，悬停立刻生效", async () => {
    @Component({
      selector: "sc-if-e",
      styles: [`.btn:hover { color: rgb(70, 70, 70); }`],
      template: `<VBoxContainer>@if (show()) { <Button name="b" class="btn">b</Button> }</VBoxContainer>`,
    })
    class Comp {
      show = signal(false);
    }

    const fixture = await render(Comp);
    fixture.componentInstance.show.set(true);
    await settle(fixture);
    const btn = findByName(fixture.nativeElement, "b")!;
    expect(btn.has_connections("mouse_entered")).toBe(true);

    btn.emit_signal("mouse_entered");
    await awaitFrames(1);
    expect(color(btn, "font_hover_color")).toBe("#464646");
  });

  it("祖先悬停中 @if 加入后代：新节点直接拿到悬停态样式", async () => {
    @Component({
      selector: "sc-if-f",
      styles: [`.card:hover .title { color: rgb(80, 80, 80); }`],
      template: `<PanelContainer name="card" class="card">@if (show()) { <Label name="t" class="title">t</Label> }</PanelContainer>`,
    })
    class Comp {
      show = signal(false);
    }

    const fixture = await render(Comp);
    const card = findByName(fixture.nativeElement, "card")!;
    card.emit_signal("mouse_entered");
    await awaitFrames(1);

    fixture.componentInstance.show.set(true);
    await settle(fixture);
    expect(color(findByName(fixture.nativeElement, "t")!)).toBe("#505050");
  });
});

/* ------------------------------------------------------------------ *
 * 结构变化与兄弟组合器
 * ------------------------------------------------------------------ */

describe("结构变化与兄弟组合器", () => {
  it("@if 的锚点不隔断 A + B", async () => {
    @Component({
      selector: "sc-sib-a",
      styles: [`Label + Button { color: rgb(90, 90, 90); }`],
      template: `<VBoxContainer name="box">
        @if (show()) { <Label name="l">l</Label> }
        <Button name="b">b</Button>
      </VBoxContainer>`,
    })
    class Comp {
      show = signal(false);
    }

    const fixture = await render(Comp);
    const box = findByName(fixture.nativeElement, "box")!;
    const btn = findByName(fixture.nativeElement, "b")!;
    // 关闭时：锚点占位在 Button 前面，前面没有 Label → 不命中
    expect(box.get_child_count()).toBe(2);
    expect(btn.has_theme_color_override("font_color")).toBe(false);

    fixture.componentInstance.show.set(true);
    await settle(fixture);
    // 打开后引擎的子级顺序是 Label、锚点、Button：锚点必须被兄弟遍历跳过
    expect(color(btn)).toBe("#5a5a5a");
  });

  it("@if 关掉后相邻兄弟关系随之撤销", async () => {
    @Component({
      selector: "sc-sib-b",
      styles: [`Label + Button { color: rgb(91, 91, 91); }`],
      template: `<VBoxContainer name="box">
        @if (show()) { <Label name="l">l</Label> }
        <Button name="b">b</Button>
      </VBoxContainer>`,
    })
    class Comp {
      show = signal(true);
    }

    const fixture = await render(Comp);
    const btn = findByName(fixture.nativeElement, "b")!;
    expect(color(btn)).toBe("#5b5b5b");

    fixture.componentInstance.show.set(false);
    await settle(fixture);
    expect(btn.has_theme_color_override("font_color")).toBe(false);
  });

  it("父节点暴露的三个兄弟访问器只跳过锚点", async () => {
    @Component({
      selector: "sc-sib-g",
      template: `<VBoxContainer name="box">
        @if (show()) { <Label name="dyn">d</Label> }
        <Button name="b">b</Button><Label name="l">l</Label>
      </VBoxContainer>`,
    })
    class Comp {
      show = signal(false);
    }

    const fixture = await render(Comp);
    const box = findByName(fixture.nativeElement, "box") as unknown as {
      getChildIndex: (node: unknown) => number;
      getChildAt: (index: number) => unknown;
      getChildrenCount: () => number;
    };
    const btn = findByName(fixture.nativeElement, "b");
    const label = findByName(fixture.nativeElement, "l");
    const anchor = findByName(fixture.nativeElement, "anchor");

    // 引擎侧挂着 3 个子级（锚点 + Button + Label），元素只有 2 个
    expect((findByName(fixture.nativeElement, "box") as Control).get_child_count()).toBe(3);
    expect(box.getChildrenCount()).toBe(2);
    expect(box.getChildIndex(btn)).toBe(0);
    expect(box.getChildIndex(label)).toBe(1);
    expect(box.getChildAt(1)).toBe(label);
    // 锚点本身不参与兄弟匹配：取不到索引，也不占位
    expect(box.getChildIndex(anchor)).toBe(-1);
  });

  it("@for 项之间的锚点不隔断 .item + .item", async () => {
    @Component({
      selector: "sc-sib-d",
      styles: [`.item + .item { color: rgb(93, 93, 93); }`],
      template: `<VBoxContainer name="list">@for (it of items(); track it) { <Label class="item">{{ it }}</Label> }</VBoxContainer>`,
    })
    class Comp {
      items = signal(["a", "b", "c"]);
    }

    const fixture = await render(Comp);
    const labels = itemLabels(fixture.nativeElement);
    expect(labels.length).toBe(3);
    // 第一项前面没有兄弟 → 不命中；后两项命中
    expect(labels[0].has_theme_color_override("font_color")).toBe(false);
    expect(color(labels[1])).toBe("#5d5d5d");
    expect(color(labels[2])).toBe("#5d5d5d");
  });

  it("@for 删除中间项后，相邻关系重算", async () => {
    @Component({
      selector: "sc-sib-e",
      styles: [`.item + .item { color: rgb(94, 94, 94); }`],
      template: `<VBoxContainer name="list">@for (it of items(); track it) { <Label class="item">{{ it }}</Label> }</VBoxContainer>`,
    })
    class Comp {
      items = signal(["a", "b", "c"]);
    }

    const fixture = await render(Comp);
    const labelsAt = () => itemLabels(fixture.nativeElement);
    expect(labelsAt()[2]).toBeTruthy();

    // 删掉中间项：原来的第三项现在紧跟第一项，仍应命中 `.item + .item`
    fixture.componentInstance.items.set(["a", "c"]);
    await settle(fixture);
    const after = labelsAt();
    expect(after.length).toBe(2);
    expect(after[0].has_theme_color_override("font_color")).toBe(false);
    expect(color(after[1])).toBe("#5e5e5e");
  });

  it("@for 追加项：新项拿到样式，兄弟关系同步更新", async () => {
    @Component({
      selector: "sc-sib-f",
      styles: [`.item { color: rgb(95, 95, 95); }`],
      template: `<VBoxContainer name="list">@for (it of items(); track it) { <Label class="item">{{ it }}</Label> }</VBoxContainer>`,
    })
    class Comp {
      items = signal(["a"]);
    }

    const fixture = await render(Comp);
    fixture.componentInstance.items.set(["a", "b", "c"]);
    await settle(fixture);
    const labels = itemLabels(fixture.nativeElement);
    expect(labels.length).toBe(3);
    for (const label of labels) expect(color(label)).toBe("#5f5f5f");
  });
});

/* ------------------------------------------------------------------ *
 * @else / @switch
 * ------------------------------------------------------------------ */

describe("@else 与 @switch 分支切换", () => {
  it("@else 分支的样式在切换后生效", async () => {
    @Component({
      selector: "sc-else-a",
      styles: [`.on { color: rgb(100, 100, 100); } .off { color: rgb(101, 101, 101); }`],
      template: `@if (on()) { <Label name="x" class="on">on</Label> } @else { <Label name="x" class="off">off</Label> }`,
    })
    class Comp {
      on = signal(false);
    }

    const fixture = await render(Comp);
    expect(color(findByName(fixture.nativeElement, "x")!)).toBe("#656565");

    fixture.componentInstance.on.set(true);
    await settle(fixture);
    expect(color(findByName(fixture.nativeElement, "x")!)).toBe("#646464");
  });

  it("@switch 换分支时旧分支的 override 不会残留", async () => {
    @Component({
      selector: "sc-switch-a",
      styles: [`.a { color: rgb(110, 110, 110); font-size: 20px; } .b { color: rgb(111, 111, 111); }`],
      template: `@switch (which()) { @case ('a') { <Label name="x" class="a">a</Label> } @default { <Label name="x" class="b">b</Label> } }`,
    })
    class Comp {
      which = signal("a");
    }

    const fixture = await render(Comp);
    const first = findByName(fixture.nativeElement, "x")!;
    expect(color(first)).toBe("#6e6e6e");
    expect(first.get_theme_font_size("font_size")).toBe(20);

    fixture.componentInstance.which.set("b");
    await settle(fixture);
    const second = findByName(fixture.nativeElement, "x")!;
    expect(color(second)).toBe("#6f6f6f");
    // 新节点是全新创建的：旧分支的 font-size 不该跟过来
    expect(second.get_theme_font_size("font_size")).toBe(16);
  });
});

/* ------------------------------------------------------------------ *
 * id：Godot 节点没有 id，不引入第二套身份标识
 * ------------------------------------------------------------------ */

describe("#id 选择器", () => {
  /**
   * `#id` 在选择器引擎里存在（`IdSelector` 读 `node.id`），但 Godot 节点没有 `id` 属性，
   * `name` 可重名不能当 id，渲染器因此按「不是真实属性」丢弃 `id` 赋值。单点选中一律走
   * class：与其维护一条只有测试能走通的旁路，不如把口径收在「class 够用」上。
   */
  it("id 属性不会让 #id 命中", async () => {
    @Component({
      selector: "sc-id-a",
      styles: [`#target { color: rgb(120, 120, 120); }`],
      template: `<Label name="a" id="target">a</Label>`,
    })
    class Comp {}

    const fixture = await render(Comp);
    expect(findByName(fixture.nativeElement, "a")!.has_theme_color_override("font_color")).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 级联登记的生命周期
 * ------------------------------------------------------------------ */

describe("结构变化后的级联登记", () => {
  it("@if 反复切换不让登记表增长", async () => {
    @Component({
      selector: "sc-life-a",
      template: `<VBoxContainer>@if (show()) { <Label name="x">x</Label> }</VBoxContainer>`,
    })
    class Comp {
      show = signal(false);
    }

    const fixture = await render(Comp);
    const size = () => [...runtime().cascade.attachedNodes()].length;
    const before = size();

    for (let i = 0; i < 3; i++) {
      fixture.componentInstance.show.set(true);
      await settle(fixture);
      expect(size()).toBeGreaterThan(before);
      fixture.componentInstance.show.set(false);
      await settle(fixture);
    }
    expect(size()).toBe(before);
  });

  it("被 @if 摘走的节点不再参与重算", async () => {
    @Component({
      selector: "sc-life-b",
      styles: [`.kid { color: rgb(160, 160, 160); }`],
      template: `<VBoxContainer>@if (show()) { <Label name="x" class="kid">x</Label> }</VBoxContainer>`,
    })
    class Comp {
      show = signal(true);
    }

    const fixture = await render(Comp);
    const x = findByName(fixture.nativeElement, "x")!;
    expect(color(x)).toBe("#a0a0a0");
    expect(runtime().cascade.stateOf(x as never)?.attached).toBe(true);

    fixture.componentInstance.show.set(false);
    await settle(fixture);
    expect(runtime().cascade.stateOf(x as never)?.attached).toBe(false);
    expect(runtime().cascade.isDirty(x as never)).toBe(false);
  });
});
