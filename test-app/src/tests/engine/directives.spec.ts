/// <reference types="vitest" />
import {
  Component,
  Directive,
  ElementRef,
  NO_ERRORS_SCHEMA,
  Renderer2,
  TemplateRef,
  Type,
  ViewContainerRef,
  effect,
  inject,
  input,
  provideZonelessChangeDetection,
  signal,
} from "@angular/core";
import { ComponentFixture, ComponentFixtureAutoDetect, TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { Color } from "godot";
import { findAllNodes, initGodotTestEnvironment, nodeTexts } from "godot-angular/testing";

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

describe("属性指令：往 Godot 节点上贴行为", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("指令用 Renderer2.setProperty 改真节点属性", async () => {
    /** 危险操作按钮统一染色：结构体由指令自己构造，渲染器只负责原样写入 */
    @Directive({ selector: "[uiDanger]" })
    class UiDanger {
      private readonly el = inject(ElementRef);
      private readonly renderer = inject(Renderer2);
      ngAfterViewInit(): void {
        this.renderer.setProperty(this.el.nativeElement, "modulate", new Color("#ff0000"));
      }
    }

    @Component({
      selector: "t-d-danger",
      imports: [UiDanger],
      schemas: [NO_ERRORS_SCHEMA],
      template: `<Button uiDanger text="删除"></Button>`,
    })
    class Danger {}

    const fixture = await render(Danger);
    const btn = findAllNodes(fixture.nativeElement, "Button")[0];
    expect(btn.modulate.r).toBeCloseTo(1);
    expect(btn.modulate.g).toBeCloseTo(0);
  });

  it("指令的 host 元数据（静态 class + (click)）落在宿主节点上", async () => {
    @Directive({
      selector: "[uiCounter]",
      exportAs: "uiCounter",
      host: { class: "counter", "(click)": "inc()" },
    })
    class UiCounter {
      readonly count = signal(0);
      inc(): void {
        this.count.update((n) => n + 1);
      }
    }

    @Component({
      selector: "t-d-counter",
      imports: [UiCounter],
      schemas: [NO_ERRORS_SCHEMA],
      template: `<VBoxContainer>
        <Button uiCounter #c="uiCounter" text="+1"></Button>
        <Label text="count={{ c.count() }}"></Label>
      </VBoxContainer>`,
    })
    class Counter {}

    const fixture = await render(Counter);
    const btn = findAllNodes(fixture.nativeElement, "Button")[0];
    const label = findAllNodes(fixture.nativeElement, "Label")[0];
    expect(label.text).toBe("count=0");
    // host 的静态 class 经 renderer.setAttribute("class") → 进入级联的 class 集合
    const classes = (btn as any).cssClasses as Set<string> | undefined;
    expect(classes?.has("counter")).toBe(true);

    // host 中的 (click) 解析到 Button.pressed：引擎发出信号 → 指令自身的计数
    btn.emit_signal("pressed");
    await fixture.whenStable();
    expect(label.text).toBe("count=1");
  });

  it("结构指令 *uiPermission 创建/销毁嵌入视图，节点插在正确位置", async () => {
    @Directive({ selector: "[uiPermission]" })
    class UiPermission {
      private readonly vcr = inject(ViewContainerRef);
      private readonly tpl = inject(TemplateRef);
      readonly uiPermission = input(false);
      constructor() {
        effect(() => {
          if (this.uiPermission()) {
            if (this.vcr.length === 0) this.vcr.createEmbeddedView(this.tpl);
          } else {
            this.vcr.clear();
          }
        });
      }
    }

    @Component({
      selector: "t-d-perm",
      imports: [UiPermission],
      schemas: [NO_ERRORS_SCHEMA],
      template: `<VBoxContainer>
        <Label text="head"></Label>
        <Label *uiPermission="allowed()" text="secret"></Label>
        <Label text="foot"></Label>
      </VBoxContainer>`,
    })
    class Perm {
      readonly allowed = signal(false);
    }

    const fixture = await render(Perm);
    expect(nodeTexts(fixture.nativeElement)).toEqual(["head", "foot"]);

    fixture.componentInstance.allowed.set(true);
    await fixture.whenStable();
    // 不只是“出现了”，位置也必须停在 head 与 foot 之间（锚点插入）
    expect(nodeTexts(fixture.nativeElement)).toEqual(["head", "secret", "foot"]);

    fixture.componentInstance.allowed.set(false);
    await fixture.whenStable();
    expect(nodeTexts(fixture.nativeElement)).toEqual(["head", "foot"]);
  });

  it("子指令注入祖先指令的配置（主题从容器传到子节点）", async () => {
    @Directive({ selector: "[uiTheme]" })
    class UiTheme {
      readonly uiTheme = input("#00ff00");
    }

    @Directive({ selector: "[uiAccent]" })
    class UiAccent {
      private readonly el = inject(ElementRef);
      private readonly renderer = inject(Renderer2);
      private readonly theme = inject(UiTheme, { optional: true });
      ngAfterViewInit(): void {
        const color = this.theme?.uiTheme();
        if (color) this.renderer.setProperty(this.el.nativeElement, "modulate", new Color(color));
      }
    }

    @Component({
      selector: "t-d-theme",
      imports: [UiTheme, UiAccent],
      schemas: [NO_ERRORS_SCHEMA],
      template: `<VBoxContainer uiTheme="#0000ff">
        <Label uiAccent text="accented"></Label>
        <Label text="plain"></Label>
      </VBoxContainer>`,
    })
    class Themed {}

    const fixture = await render(Themed);
    const [accented, plain] = findAllNodes(fixture.nativeElement, "Label");
    expect(accented.modulate.b).toBeCloseTo(1);
    expect(plain.modulate.b).toBeCloseTo(1); // 默认 modulate 是白色，未被污染
    expect(plain.modulate.r).toBeCloseTo(1);
  });
});

describe("指令与输入输出", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("指令的 signal input 变化会重跑绑定，把值写进宿主节点", async () => {
    @Directive({ selector: "[uiBadge]", exportAs: "uiBadge", host: { "(click)": "bump()" } })
    class UiBadge {
      private readonly el = inject(ElementRef);
      private readonly renderer = inject(Renderer2);
      readonly uiBadge = input("");
      readonly hits = signal(0);
      ngOnChanges(): void {
        this.renderer.setProperty(this.el.nativeElement, "text", `badge:${this.uiBadge()}`);
      }
      bump(): void {
        this.hits.update((n) => n + 1);
      }
    }

    @Component({
      selector: "t-d-badge-host",
      imports: [UiBadge],
      schemas: [NO_ERRORS_SCHEMA],
      template: `<VBoxContainer>
        <Button [uiBadge]="label()" #b="uiBadge"></Button>
        <Label text="hits={{ b.hits() }}"></Label>
      </VBoxContainer>`,
    })
    class BadgeHost {
      readonly label = signal("a");
    }

    const fixture = await render(BadgeHost);
    const btn = findAllNodes(fixture.nativeElement, "Button")[0];
    const label = findAllNodes(fixture.nativeElement, "Label")[0];
    expect(btn.text).toBe("badge:a");
    expect(label.text).toBe("hits=0");

    fixture.componentInstance.label.set("b");
    await fixture.whenStable();
    expect(btn.text).toBe("badge:b");

    // host 中的 (click) 也确实连接到了引擎信号
    btn.emit_signal("pressed");
    await fixture.whenStable();
    expect(label.text).toBe("hits=1");
  });

  it("指令装在组件宿主上：指令与组件共存，各自读写同一个节点", async () => {
    @Directive({ selector: "t-d-panel", host: { name: "themedPanel" } })
    class UiPanelHost {
      private readonly el = inject(ElementRef);
      panelName(): string {
        return this.el.nativeElement.get_name();
      }
    }

    @Component({
      selector: "t-d-panel",
      schemas: [NO_ERRORS_SCHEMA],
      template: `<Label text="inside"></Label>`,
    })
    class Panel {}

    @Component({
      selector: "t-d-panel-host",
      // 指令需要匹配 `<t-d-panel>`，就需要被“编写该标签的那个组件”导入，而不是被 Panel 自身
      imports: [Panel, UiPanelHost],
      template: `<t-d-panel></t-d-panel>`,
    })
    class PanelHost {}

    const fixture = await render(PanelHost);
    // host 元数据中的 name 已写入组件宿主（VBoxContainer）
    const panel = findAllNodes(fixture.nativeElement, "VBoxContainer")[0];
    expect(panel.get_name()).toBe("themedPanel");
    expect(nodeTexts(fixture.nativeElement)).toEqual(["inside"]);
  });
});
