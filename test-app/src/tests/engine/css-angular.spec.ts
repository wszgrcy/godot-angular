import { Component, ViewEncapsulation, provideZonelessChangeDetection, signal, type Type } from "@angular/core";
import { ComponentFixture, ComponentFixtureAutoDetect, TestBed } from "@angular/core/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { initGodotTestEnvironment, awaitFrames, resetWarnOnce } from "godot-angular/testing";
import {
  CSS_VAR_NAMESPACE,
  shimContentAttribute,
  shimHostAttribute,
  shimStylesContent,
  STYLE_RUNTIME,
} from "godot-angular/core";

/**
 * 测试本地镜像：原版在 NoneEncapsulationDomRenderer 构造器内只有两行（先 %COMP%，再 %NS%），
 * 渲染器在同位置内联了这两行，因此这里也按那两行写，不依赖导出的辅助函数。
 */
const shimOne = (css: string, compId = "t-1", ns = ""): string =>
  shimStylesContent(compId, [css]).map((s) => s.replace(/%NS%/g, ns))[0];

async function render<T>(
  component: Type<T>,
  extraProviders: any[] = [],
): Promise<ComponentFixture<T>> {
  await TestBed.configureTestingModule({
    imports: [component],
    providers: [
      { provide: ComponentFixtureAutoDetect, useValue: true },
      provideZonelessChangeDetection(),
      ...extraProviders,
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(component);
  await fixture.whenStable();
  await awaitFrames(2);
  return fixture;
}

/** 按名称查找子节点（深度优先，避免每个用例手算 get_child 下标） */
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

describe("组件 styles 端到端", () => {
  it("styles 里 .probe{color:red} → 渲染后子元素 font_color 是红", async () => {
    @Component({
      selector: "t-probe",
      styles: [`.probe { color: rgb(255, 0, 0); }`],
      template: `<Label name="probe" class="probe">hi</Label>`,
    })
    class ProbeComp {}

    const fixture = await render(ProbeComp);
    const label = findByName(fixture.nativeElement, "probe");
    expect(label).toBeTruthy();
    expect(label.has_theme_color_override("font_color")).toBe(true);
    expect(label.get_theme_color("font_color").r).toBeCloseTo(1, 3);
  });

  it("兄弟组合符走真模板：容器是渲染器创建的，适配方法也得挂上", async () => {
    @Component({
      selector: "t-sib",
      styles: [`Label + Button { color: rgb(0, 255, 0); }`],
      template: `<VBoxContainer>
        <Label name="a">a</Label>
        <Button name="b">b</Button>
        <Button name="c">c</Button>
      </VBoxContainer>`,
    })
    class SibComp {}

    const fixture = await render(SibComp);
    const host = fixture.nativeElement;
    // Label 的下一个是 b → 命中；b 的前一个不是 Label → c 也命中不了
    expect(findByName(host, "b").has_theme_color_override("font_color")).toBe(true);
    expect(findByName(host, "a").has_theme_color_override("font_color")).toBe(false);
    expect(findByName(host, "c").has_theme_color_override("font_color")).toBe(false);
  });

  /**
   * 占位符故意保留在 `ɵcmp.styles` 里，由运行时 `shimComponentCss` 填充
   * （与浏览器端 DomRenderer 同层）。本用例验证的是“填充正确”：节点上的属性名必须
   * 与运行时 shim 出的 scope 一致，否则就是静默失配。
   */
  it("styles 里带 %COMP%，运行时填完仍与节点上的作用域属性对得上", async () => {
    @Component({
      selector: "t-scope",
      styles: [`.probe { color: rgb(0, 0, 255); }`],
      template: `<Label name="probe" class="probe">hi</Label>`,
    })
    class ScopeComp {}

    const fixture = await render(ScopeComp);
    const label = findByName(fixture.nativeElement, "probe");
    const styles: string[] = (ScopeComp as any).ɵcmp.styles;
    // 构建期不得提前填充（提前填充就会存在两份事实，且运行时去重失效）
    expect(styles[0], "占位符应当原样到运行时").toContain("%COMP%");

    // 节点上实际写入的作用域属性：`appId + '-' + def.id`（core 在 defineComponent 中计算）
    const scopeKeys = Object.keys(label).filter((key) => key.startsWith("_ngcontent-"));
    expect(scopeKeys.length).toBe(1);
    const scope = scopeKeys[0].slice("_ngcontent-".length);
    const defId = (ScopeComp as any).ɵcmp.id;
    expect(scope, `compId 应当是 appId + '-' + def.id，实测 ${scope}`).toBe(`godot-test-${defId}`);

    // shim 后的文本使用的就是同一个 scope（两边同源，不是各自计算一遍）
    const shimmed = shimOne(styles[0], scope);
    expect(shimmed).not.toContain("%COMP%");
    expect(shimmed).toContain(`[_ngcontent-${scope}]`);
    expect(label.get_theme_color("font_color").b).toBeCloseTo(1, 3);
  });

  /**
   * compId = `appId + '-' + def.id`，而 `getComponentId` 故意**不含样式内容**
   * （服务端样式没有 sourcemap 会使 id 浮动）。因此同一段样式写在
   * 两个组件里就是两个不同的 scope —— 与浏览器行为一致，不是去重遗漏。
   */
  it("两个组件写同一段样式：scope 不同，但各自都生效", async () => {
    const shared = `.dup { color: rgb(0, 255, 0); }`;

    @Component({ selector: "t-dup-a", styles: [shared], template: `<Label name="a" class="dup">a</Label>` })
    class DupA {}

    @Component({ selector: "t-dup-b", styles: [shared], template: `<Label name="b" class="dup">b</Label>` })
    class DupB {}

    @Component({
      selector: "t-dup-host",
      imports: [DupA, DupB],
      template: `<t-dup-a></t-dup-a><t-dup-b></t-dup-b>`,
    })
    class DupHost {}

    const fixture = await render(DupHost);
    const a = findByName(fixture.nativeElement, "a");
    const b = findByName(fixture.nativeElement, "b");
    const scopeOf = (node: any): string =>
      Object.keys(node).filter((key) => key.startsWith("_ngcontent-")).join(",");

    expect(scopeOf(a)).not.toBe(scopeOf(b));
    expect(a.get_theme_color("font_color").g).toBeCloseTo(1, 3);
    expect(b.get_theme_color("font_color").g).toBeCloseTo(1, 3);
  });

  /**
   * `%NS%`：编译器对所有组件样式无条件执行 namespaceCssVariables，
   * `--brand` → `--%NS%brand`。不还原时同组件内两边都带 `%NS%`、**巧合可用**，
   * 但跨边界（全局样式表定义、组件使用）永远无法对应——典型的“看似可用实则漏失”。
   */
  it("组件定义 + 组件使用：CSS 变量能解析（%NS% 已还原）", async () => {
    @Component({
      selector: "t-var",
      styles: [`.v { --brand: rgb(0, 255, 0); color: var(--brand); }`],
      template: `<Label name="v" class="v">hi</Label>`,
    })
    class VarComp {}

    const fixture = await render(VarComp);
    const label = findByName(fixture.nativeElement, "v");
    expect(label.get_theme_color("font_color").g).toBeCloseTo(1, 3);
  });

  it("全局定义 + 组件使用：CSS 变量跳得过边界（%NS% 没还原就会静默失效）", async () => {
    @Component({
      selector: "t-varx",
      styles: [`.v { color: var(--from-global); }`],
      template: `<Label name="v" class="v">hi</Label>`,
    })
    class VarCrossComp {}

    // 全局样式表不经组件编译器，变量名是干净的——组件内那个也必须被还原才能对应。
    // 注意顺序：TestBed 实例化之前不能 inject，因此先渲染再向全局层写入 CSS
    //（addCss 会全量标脏，下一帧重算就会解析出组件的 var(--from-global)）。
    const fixture = await render(VarCrossComp);
    TestBed.inject(STYLE_RUNTIME).addCss(`Label { --from-global: rgb(255, 0, 0); }`);
    await awaitFrames(2);

    const label = findByName(fixture.nativeElement, "v");
    expect(label.get_theme_color("font_color").r).toBeCloseTo(1, 3);
  });

  /** 对应原版内联的那句 `s.replace(/%NS%/g, cssVarNamespace)`：裸形态整体替换 */
  it("shimOne 把裸 %NS% 换成命名空间（空串就是去掉）", () => {
    expect(shimOne(`a { --%NS%b: 1px }`)).toBe("a { --b: 1px }");
    expect(shimOne(`a { --%NS%b: 1px }`, "t-1", "x_")).toBe("a { --x_b: 1px }");
  });

  /**
   * `CSS_VAR_NAMESPACE` 经 DI 提供。本用例具有**判别性**：如果工厂未读取 token（写死空串），
   * 组件里的 `var(--from-global)` 会被还原为干净名称、与全局层对应，下面的断言就会失败。
   *
   * 命名空间生效的代价（与浏览器行为一致）：全局样式表不执行命名空间，因此跨层引用无法对应。
   */
  it("provide CSS_VAR_NAMESPACE 后，组件的变量名真的带上了前缀", async () => {
    @Component({
      selector: "t-ns",
      styles: [`.v { color: var(--from-global); }`],
      template: `<Label name="v" class="v">hi</Label>`,
    })
    class NamespacedComp {}

    const fixture = await render(NamespacedComp, [{ provide: CSS_VAR_NAMESPACE, useValue: "x_" }]);
    TestBed.inject(STYLE_RUNTIME).addCss(`Label { --from-global: rgb(255, 0, 0); }`);
    await awaitFrames(2);

    const label = findByName(fixture.nativeElement, "v");
    // 解不出来 → 整条声明被忽略（而不是写入空串），因此不会变红。
    // 注意使用 g 通道判定：未命中时 Label 默认字色是白（r 也为 1），用 r 判定“没变红”不成立。
    const color = label.get_theme_color("font_color");
    expect(color.g, `命名空间没生效？实测 rgb(${color.r}, ${color.g}, ${color.b})`).toBeGreaterThan(
      0.5,
    );
  });

  /** 同组件内两边一起加前缀，因此自包含的 var 仍可用（命名空间不破坏自身一致性） */
  it("开了命名空间，组件自有的 CSS 变量仍解析", async () => {
    @Component({
      selector: "t-ns2",
      styles: [`.v { --brand: rgb(0, 255, 0); color: var(--brand); }`],
      template: `<Label name="v" class="v">hi</Label>`,
    })
    class NamespacedSelfComp {}

    const fixture = await render(NamespacedSelfComp, [{ provide: CSS_VAR_NAMESPACE, useValue: "x_" }]);
    const label = findByName(fixture.nativeElement, "v");
    expect(label.get_theme_color("font_color").g).toBeCloseTo(1, 3);
  });

  /** 作用域属性名的两个出口（对应 Angular 的 shimContentAttribute / shimHostAttribute） */
  it("作用域属性名是 dash 形态，content / host 各一个", () => {
    expect(shimContentAttribute("c1")).toBe("_ngcontent-c1");
    expect(shimHostAttribute("c1")).toBe("_nghost-c1");
  });


  it(":host 落在宿主节点上", async () => {
    @Component({
      selector: "t-inner",
      // 宿主是未知标签 → VBoxContainer，它的 theme 词汇表中只有 constant `separation`，
      // 没有 font_size（字体尺寸属于 Label 那一层的 item）——写错不会静默落空，
      // requireItem 会告警，但断言需要使用确实能落地的属性。
      styles: [`:host { gap: 8px; }`],
      template: `<Label name="inner-child">x</Label>`,
    })
    class InnerComp {}

    @Component({ selector: "t-outer", imports: [InnerComp], template: `<t-inner name="inner"></t-inner>` })
    class OuterComp {}

    const fixture = await render(OuterComp);
    const host = findByName(fixture.nativeElement, "inner");
    expect(host).toBeTruthy();
    expect(host.has_theme_constant_override("separation")).toBe(true);
    expect(host.get_theme_constant("separation")).toBe(8);
  });

  it("A 组件的 .box 不影响 B 组件的同名 class", async () => {
    @Component({
      selector: "t-a",
      styles: [`.box { color: rgb(255, 0, 0); }`],
      template: `<Label name="a-box" class="box">a</Label>`,
    })
    class AComp {}

    @Component({
      selector: "t-b",
      // B 中同样的 class，但未写样式：它不应被 A 的规则命中
      template: `<Label name="b-box" class="box">b</Label>`,
    })
    class BComp {}

    @Component({
      selector: "t-both",
      imports: [AComp, BComp],
      template: `<t-a name="a"></t-a><t-b name="b"></t-b>`,
    })
    class BothComp {}

    const fixture = await render(BothComp);
    const aBox = findByName(fixture.nativeElement, "a-box");
    const bBox = findByName(fixture.nativeElement, "b-box");
    expect(aBox.get_theme_color("font_color").r).toBeCloseTo(1, 3);
    expect(bBox.has_theme_color_override("font_color")).toBe(false);
  });

  it("encapsulation: None 的组件样式对兄弟组件也生效", async () => {
    @Component({
      selector: "t-global",
      encapsulation: ViewEncapsulation.None,
      styles: [`.shared { color: rgb(0, 255, 0); }`],
      template: `<Label name="g1" class="shared">g</Label>`,
    })
    class GlobalComp {}

    @Component({
      selector: "t-plain",
      template: `<Label name="g2" class="shared">p</Label>`,
    })
    class PlainComp {}

    @Component({
      selector: "t-mix",
      imports: [GlobalComp, PlainComp],
      template: `<t-global name="gg"></t-global><t-plain name="pp"></t-plain>`,
    })
    class MixComp {}

    const fixture = await render(MixComp);
    expect(findByName(fixture.nativeElement, "g1").get_theme_color("font_color").g).toBeCloseTo(1, 3);
    // 无作用域标记 = 全局规则，其他组件中的同名 class 也会命中
    expect(findByName(fixture.nativeElement, "g2").get_theme_color("font_color").g).toBeCloseTo(1, 3);
  });
});

describe("class 绑定驱动级联", () => {
  it("[class] 换值 → 新样式生效，旧 override 被撤干净", async () => {
    @Component({
      selector: "t-cls",
      styles: [`.x { color: rgb(255, 0, 0); }`],
      template: `<Label name="c" [class]="cls()">t</Label>`,
    })
    class ClsComp {
      cls = signal("x");
    }

    const fixture = await render(ClsComp);
    const label = findByName(fixture.nativeElement, "c");
    expect(label.get_theme_color("font_color").r).toBeCloseTo(1, 3);

    fixture.componentInstance.cls.set("");
    await fixture.whenStable();
    await awaitFrames(2);
    // class 已移除，已写入的 override 必须清除干净
    expect(label.has_theme_color_override("font_color")).toBe(false);
  });

  it("两个 class 冲突时按级联顺序，切换 class 只重写变化的那条", async () => {
    @Component({
      selector: "t-two",
      styles: [`.a { color: rgb(255, 0, 0); font-size: 10px; } .b { color: rgb(0, 0, 255); }`],
      template: `<Label name="c" [class]="'a ' + cls()">t</Label>`,
    })
    class TwoComp {
      cls = signal("b");
    }

    const fixture = await render(TwoComp);
    const label = findByName(fixture.nativeElement, "c");
    // .b 在后，同特异度时它生效
    expect(label.get_theme_color("font_color").b).toBeCloseTo(1, 3);
    expect(label.get_theme_font_size("font_size")).toBe(10);

    fixture.componentInstance.cls.set("z");
    await fixture.whenStable();
    await awaitFrames(2);
    // .b 已移除 → color 回到 .a 的红；font-size 不受影响
    expect(label.get_theme_color("font_color").r).toBeCloseTo(1, 3);
    expect(label.get_theme_font_size("font_size")).toBe(10);
  });

  it("[style.x] 内联压过组件样式表", async () => {
    @Component({
      selector: "t-inline",
      styles: [`.probe { color: rgb(255, 0, 0); }`],
      template: `<Label name="p" class="probe" [style.color]="'rgb(0, 0, 255)'">x</Label>`,
    })
    class InlineComp {}

    const fixture = await render(InlineComp);
    const label = findByName(fixture.nativeElement, "p");
    expect(label.get_theme_color("font_color").b).toBeCloseTo(1, 3);
  });

  /**
   * 根组件的宿主就是入口给定的 Control（Angular 经 `selectRootElement` 获取），不经过
   * `createElement`，因此从未被 `enroll` 过——宿主上的 class 绑定是它纳入级联的唯一机会。
   * 缺少那一步，`host: { class }` / `@HostBinding("class.x")` 会直接报错于 cssClasses。
   */
  it("宿主上的 class 绑定：宿主没经 createElement，也得进级联", async () => {
    @Component({
      selector: "t-host",
      // opacity 落到 modulate，任何 Control 都能落地（宿主在测试中是裸 Control，没有 separation）
      styles: [`:host { opacity: 1; } :host.on { opacity: 0.5; }`],
      host: { class: "on" },
      template: `<Label name="kid">x</Label>`,
    })
    class HostComp {}

    const fixture = await render(HostComp);
    const host = fixture.nativeElement;
    expect([...(host.cssClasses as Set<string>)]).toContain("on");
    expect(host.modulate.a).toBeCloseTo(0.5, 3);
  });

  /**
   * 宿主没有 class 绑定时也需要在级联中——否则 `:host` 静默不生效（上面那条能通过，很大程度
   * 是 class 那次 attach 顺带补上的）。登记时机在 `selectRootElement`，不依附于 class 路径。
   */
  it("根宿主没有 class 绑定时，:host 样式照样落地", async () => {
    @Component({
      selector: "t-nocls",
      styles: [`:host { opacity: 0.5; }`],
      template: `<Label name="kid">x</Label>`,
    })
    class NoClsComp {}

    const fixture = await render(NoClsComp);
    expect(fixture.nativeElement.modulate.a).toBeCloseTo(0.5, 3);
  });
});

/**
 * 元素选择器拼写 Godot 类名的告警：组件 CSS 中写错类名，使用者需要在 Godot 控制台
 * 看到提示，而不是静默零命中。告警由 `buildRuleSets` 报出，本处验证的是**运行时那一段接线**；
 * 纯逻辑（行号、大小写、只查开头元素名）由 packages/css/test/cascade.spec.ts 验证。
 */
describe("元素选择器拼错的告警能到使用者眼前", () => {
  beforeEach(() => resetWarnOnce());

  it("组件 styles 里写 Buton → 告警里出现这个词", async () => {
    @Component({
      selector: "t-typo",
      styles: [`Buton { color: red; }`],
      template: `<Button name="b">x</Button>`,
    })
    class TypoComp {}

    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.map((a) => String(a)).join(" "));
    try {
      await render(TypoComp);
    } finally {
      console.warn = original;
    }
    expect(warnings.join("\n")).toContain("Buton");
  });

  it("写对了就不该有告警（别把告警当背景噪声）", async () => {
    @Component({
      selector: "t-ok",
      styles: [`Button { color: red; }`],
      template: `<Button name="b">x</Button>`,
    })
    class OkComp {}

    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.map((a) => String(a)).join(" "));
    try {
      await render(OkComp);
    } finally {
      console.warn = original;
    }
    expect(warnings.join("\n")).not.toContain("不是已知的 Godot 类名");
  });
});

describe("组件销毁：级联登记必须断掉", () => {
  /**
   * 销毁路径上渲染器只收到一次 `destroyNode`（实测：宿主一次，内部元素一个也没有），
   * 因此内部节点的登记是靠 `predelete` 断开的。`queue_free` 到帧末才真正释放，
   * 断言前必须推进几帧，否则信号尚未发出。
   */
  it("fixture.destroy() 之后节点不再参与重算", async () => {
    @Component({
      selector: "t-gone",
      styles: [`.gone { color: rgb(255, 0, 0); }`],
      template: `<Label name="victim" class="gone">x</Label>`,
    })
    class GoneComp {}

    const fixture = await render(GoneComp);
    // TestBed 实例化之前不能 inject（先 inject 会报“already instantiated”），因此 runtime 在渲染后获取
    const runtime = TestBed.inject(STYLE_RUNTIME);
    const victim = findByName(fixture.nativeElement, "victim");
    expect(victim.has_theme_color_override("font_color")).toBe(true);
    expect(runtime.cascade.stateOf(victim)?.attached).toBe(true);

    const attachedBefore = [...runtime.cascade.attachedNodes()].length;
    fixture.destroy();
    await awaitFrames(2);

    expect(runtime.cascade.stateOf(victim)?.attached).toBe(false);
    expect(runtime.cascade.isDirty(victim)).toBe(false);
    expect([...runtime.cascade.attachedNodes()].includes(victim)).toBe(false);
    expect([...runtime.cascade.attachedNodes()].length).toBeLessThan(attachedBefore);
  });

  it("反复创建并销毁组件，登记表不增长", async () => {
    @Component({
      selector: "t-churn",
      template: `<Label name="c">x</Label>`,
    })
    class ChurnComp {}

    await TestBed.configureTestingModule({
      imports: [ChurnComp],
      providers: [provideZonelessChangeDetection()],
    }).compileComponents();
    const runtime = TestBed.inject(STYLE_RUNTIME);
    const attached = () => [...runtime.cascade.attachedNodes()].length;
    const before = attached();

    // 先全部创建完再全部销毁：`destroyNode` 收到的是共享的 TestBedRoot，queue_free 后
    // 就不能再 createComponent（会报“Bad this”）。
    const fixtures: ComponentFixture<unknown>[] = [];
    for (let i = 0; i < 3; i++) {
      const fixture = TestBed.createComponent(ChurnComp);
      fixtures.push(fixture);
      await fixture.whenStable();
      await awaitFrames(1);
      expect(attached(), `第 ${i + 1} 次创建后节点该在登记表里`).toBeGreaterThan(before);
    }

    for (const fixture of fixtures) fixture.destroy();
    await awaitFrames(2);
    expect(attached()).toBe(before);
  });
});
