/**
 * `name` 属性 → 引擎节点真实名字。
 *
 * `name` 在 ClassDB 里存在，但这个 JS 绑定没有为 `Node.name` 生成属性访问器（整条原型链
 * Label→Control→CanvasItem→Node→Object 都没有），因此通用赋值 `(node)[prop] = v` 只会写出
 * 一个 JS 自有属性：读回来还是那个值，引擎侧却一点没变，`find_child` / `get_node` 全部查不到。
 * 渲染器为此在 setProperty 里单开分支走 `set_name()`。
 *
 * 判据一律用引擎侧的 `get_name()` / `find_child` / `get_node`：JS 侧的 `.name` 已不再是事实来源。
 */
import { Component, provideZonelessChangeDetection, signal, type Type } from "@angular/core";
import { ComponentFixture, ComponentFixtureAutoDetect, TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { ClassDB, Label } from "godot";
import type { Control } from "godot";
import { hasJsAccessor } from "godot-angular/core";
import {
  initGodotTestEnvironment,
  awaitFrames,
  resetWarnOnce,
  makeRenderer,
} from "godot-angular/testing";

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

/** 深度找第一个该名字的节点；引擎侧名字，不看 JS 字段 */
function findByName(node: Control, name: string): Control | null {
  for (let i = 0; i < node.get_child_count(); i++) {
    const child = node.get_child(i) as Control;
    if (child.get_name() === name) return child;
    const deeper = findByName(child, name);
    if (deeper) return deeper;
  }
  return null;
}

describe("name → 引擎节点名字", () => {
  it("静态 name 写进引擎，find_child 查得到", async () => {
    @Component({
      selector: "nm-static",
      template: `<VBoxContainer name="box"><Label name="real">t</Label></VBoxContainer>`,
    })
    class Comp {}

    const fixture = await render(Comp);
    const box = findByName(fixture.nativeElement, "box") as Control;
    expect(box).toBeTruthy();
    expect(box.get_name()).toBe("box");
    // 引擎侧真的收下了：按名查找命中，而不是只有 JS 字段看着像成功
    expect(box.find_child("real", false, false)).not.toBeNull();
    expect((box.get_child(0) as Control).get_name()).toBe("real");
  });

  it("name 拼出的 NodePath 可被 get_node 解析", async () => {
    @Component({
      selector: "nm-path",
      template: `<VBoxContainer name="box"><Label name="real">t</Label></VBoxContainer>`,
    })
    class Comp {}

    const fixture = await render(Comp);
    const host = fixture.nativeElement as Control;
    expect(host.get_node_or_null("box/real")).not.toBeNull();
  });

  it("动态 [name] 改名：新名生效，旧名查不到", async () => {
    @Component({
      selector: "nm-dyn",
      template: `<VBoxContainer><Label [name]="dyn()">t</Label></VBoxContainer>`,
    })
    class Comp {
      dyn = signal("first");
    }

    const fixture = await render(Comp);
    const box = (fixture.nativeElement as Control).get_child(0) as Control;
    const label = box.get_child(0) as Control;
    expect(label.get_name()).toBe("first");

    fixture.componentInstance.dyn.set("second");
    await fixture.whenStable();
    await awaitFrames(2);
    expect(label.get_name()).toBe("second");
    expect(box.find_child("first", false, false)).toBeNull();
    expect(box.find_child("second", false, false)).not.toBeNull();
  });

  it("[attr.name] 置 null 是撤销，名字保持不动", async () => {
    @Component({
      selector: "nm-revert",
      template: `<VBoxContainer><Button [attr.name]="attrName()">a</Button></VBoxContainer>`,
    })
    class Comp {
      attrName = signal<string | null>("attrOld");
    }

    const fixture = await render(Comp);
    const box = (fixture.nativeElement as Control).get_child(0) as Control;
    const btn = box.get_child(0) as Control;
    expect(btn.get_name()).toBe("attrOld");

    // 引擎不接受空名，ClassDB 默认值又是 null，因此“撤名”没有对应操作，只能保持现值
    fixture.componentInstance.attrName.set(null);
    await fixture.whenStable();
    await awaitFrames(2);
    expect(btn.get_name()).toBe("attrOld");
  });

  it("撤名的落点不存在：引擎忽略空名，ClassDB 默认值是 null", () => {
    const { root } = makeRenderer();
    const node = new Label();
    root.add_child(node);

    // 已命名的节点无法取消名字：空串被引擎直接忽略
    node.set_name("real");
    node.set_name("");
    expect(node.get_name()).toBe("real");

    // 移出树也置不空：空名只存在于“从未命名过”的节点上
    root.remove_child(node);
    node.set_name("");
    expect(node.get_name()).toBe("real");
    expect(new Label().get_name()).toBe("");

    // 默认值是 null 而不是空串：谁拿它当“默认值写回”，就会把节点改成字面量 "null"
    expect(ClassDB.class_get_property_default_value("Label", "name")).toBe(null);
  });

  it("非法字符按文档替换成下划线", async () => {
    @Component({
      selector: "nm-sanitize",
      template: `<VBoxContainer><Label name="a.b:c@d">x</Label></VBoxContainer>`,
    })
    class Comp {}

    const fixture = await render(Comp);
    const box = (fixture.nativeElement as Control).get_child(0) as Control;
    // 文档：`. : @ / " %` 会被替换成下划线
    expect(box.get_child(0).get_name()).toBe("a_b_c_d");
  });

  it("同级重名由引擎自动改名，不静默留下两个同名节点", async () => {
    @Component({
      selector: "nm-dup",
      template: `<VBoxContainer><Button name="dup">d</Button><Button name="dup">d</Button></VBoxContainer>`,
    })
    class Comp {}

    const fixture = await render(Comp);
    const box = (fixture.nativeElement as Control).get_child(0) as Control;
    const first = box.get_child(0) as Control;
    const second = box.get_child(1) as Control;
    expect(first.get_name()).toBe("dup");
    // 文档：设成已存在的同级名字时节点会被自动改名。自动名形如 @Button@4，
    // 具体编号随创建顺序变化，因此只钉“不再等于请求的名字”
    expect(second.get_name()).not.toBe("dup");
    expect(second.get_name().startsWith("@")).toBe(true);
  });

  it("访问器缺口的实际范围：只有 name", () => {
    const node = new Label();
    expect(hasJsAccessor(node as never, "text")).toBe(true);
    expect(hasJsAccessor(node as never, "name")).toBe(false);

    // 把 Label 继承链上的 ClassDB 属性全扫一遍。属性表里混着编辑器分组项（如 “Layout”、
    // “BiDi”、“Theme”），它们的 type 是 NIL(0)，不是可写属性，先排除。
    const props = new Map<string, number>();
    const seen = new Set<string>();
    let cls: string | null = "Label";
    while (cls && cls !== "Object" && !seen.has(cls)) {
      seen.add(cls);
      for (const entry of ClassDB.class_get_property_list(cls, false)) {
        const type = Number(entry.get("type"));
        if (type !== 0) props.set(String(entry.get("name")), type);
      }
      cls = ClassDB.get_parent_class(cls) ?? null;
    }
    const missing = [...props.keys()].filter((p) => !hasJsAccessor(node as never, p));
    // 绑定目前只漏了 name（已由 setProperty 的专用分支走 set_name）。再出现新的缺口，
    // 开发期会命中 writeProperty 里的访问器告警，这里也会先红。
    expect(missing).toEqual(["name"]);
  });

  it("锚点拿到真实名字，且不影响兄弟组合器", async () => {
    @Component({
      selector: "nm-anchor",
      styles: [`Label + Button { color: rgb(92, 92, 92); }`],
      template: `<VBoxContainer name="box">
        @if (show()) { <Label name="dyn">d</Label> }
        <Label name="l">l</Label><Button name="b">b</Button>
      </VBoxContainer>`,
    })
    class Comp {
      show = signal(false);
    }

    const fixture = await render(Comp);
    const box = findByName(fixture.nativeElement, "box") as Control;
    // 锚点在引擎里叫 anchor（此前只存在于 JS 字段，引擎侧是 @Node@N）
    expect(box.get_child(0).get_name()).toBe("anchor");
    // 名字变真不影响 CSS：锚点仍不占兄弟位
    const btn = findByName(fixture.nativeElement, "b") as Control;
    expect(btn.get_theme_color("font_color").to_html(false)).toBe("5c5c5c");
  });
});
