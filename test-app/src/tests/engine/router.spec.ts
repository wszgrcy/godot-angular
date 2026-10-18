/// <reference types="vitest" />
import {
  Component,
  DestroyRef,
  EnvironmentProviders,
  NO_ERRORS_SCHEMA,
  Provider,
  Type,
  computed,
  inject,
  provideZonelessChangeDetection,
  signal,
} from "@angular/core";
import { ComponentFixture, ComponentFixtureAutoDetect, TestBed } from "@angular/core/testing";
import { Location, PlatformLocation } from "@angular/common";
import {
  ActivatedRoute,
  NavigationEnd,
  Router,
  RouterOutlet,
  TitleStrategy,
  withHashLocation,
} from "@angular/router";
import { beforeEach, describe, expect, it } from "vitest";
import {
  GODOT_HEADLESS,
  GODOT_INITIAL_URL,
  GodotPlatformLocation,
  GodotTitleStrategy,
  provideGodotRouter,
} from "godot-angular/router";
import { bootstrapGodotApp, GODOT_ROOT } from "godot-angular/core";
import { findAllNodes, initGodotTestEnvironment, nodeTexts } from "godot-angular/testing";

/**
 * `@angular/router` 在 GodotJS 里跑通的验证。
 *
 * 路由本体一行没改：它对所有平台的依赖收敛在 PlatformLocation / DOCUMENT /
 * ViewportScroller / TitleStrategy 三个 token 上，`provideGodotRouter` 换掉这三个。
 * 因此这里断言的全是“真路由行为”——URL、历史、参数、outlet 渲染、模板里的跳转，
 * 而不是某个替身的方法被调用过。
 *
 * 与浏览器唯一的差别：TestBed 不走 `bootstrap`，`APP_BOOTSTRAP_LISTENER` 不执行，
 * 初始导航要显式 `router.initialNavigation()`。真实入口那条路单独有一例（文件末），
 * 走的是 `bootstrapGodotApp`。
 *
 * 跑本文件时引擎会刷 `unhandled promise rejection: NoMatch`——那不是错误，见
 * docs/development.md 的 GodotJS 行为第 16 条：路由靠异常控制流试匹配候选路由，
 * 失败的那个 rejection 下一句就被 catch，但引擎在 reject 那一刻就打了 ERROR。
 * 导航结果本身由下面的断言逐条验过。
 */

/** 标准形状：configureTestingModule(+autoDetect/zoneless) → createComponent → whenStable */
async function renderHost<T>(
  host: Type<T>,
  routerProviders: Provider | EnvironmentProviders | (Provider | EnvironmentProviders)[],
  extraProviders: Provider[] = [],
): Promise<ComponentFixture<T>> {
  await TestBed.configureTestingModule({
    imports: [host],
    providers: [
      { provide: ComponentFixtureAutoDetect, useValue: true },
      provideZonelessChangeDetection(),
      ...[routerProviders].flat(),
      ...extraProviders,
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(host);
  await fixture.whenStable();
  return fixture;
}

/** TestBed 里初始导航不会自动发生（无 APP_BOOTSTRAP_LISTENER），显式补上那一步。 */
async function bootstrapRouter<T>(
  host: Type<T>,
  routerProviders: Provider | EnvironmentProviders | (Provider | EnvironmentProviders)[],
  extraProviders: Provider[] = [],
): Promise<ComponentFixture<T>> {
  const fixture = await renderHost(host, routerProviders, extraProviders);
  await TestBed.inject(Router).initialNavigation();
  await fixture.whenStable();
  return fixture;
}

function findButton(root: any, text: string): any {
  return findAllNodes(root, "Button").find((b) => b.text === text) ?? null;
}

/**
 * 让出一个宏任务。popstate 触发的导航被路由自己延后了一拍：
 * `HistoryStateManager.registerNonRouterCurrentEntryChangeListener` 里包了一层
 * `setTimeout`，而 `whenStable()` 等的是 PendingTasks，不会替这个定时器买单。
 */
async function flushMacrotask(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// —— 组件全部声明在 describe 之前：describe 的回调在收集阶段就地执行，写在后面就是 TDZ。

@Component({ selector: "t-rt-home", template: `<Label name="home" text="home"></Label>` })
class HomeComp {}

@Component({ selector: "t-rt-about", template: `<Label name="about" text="about"></Label>` })
class AboutComp {}

@Component({
  selector: "t-rt-detail",
  template: `<Label name="detail" text="{{ label() }}"></Label>`,
})
class DetailComp {
  /**
   * 参数走 Observable 而不是 snapshot：只改 :id 时同一个组件实例被复用，Angular 不会为
   * “读 snapshot 的普通 getter”重跑变更检测（浏览器下也一样）。订阅 paramMap 才是
   * 参数变化的正确读法，顺带验出路由真的把新值推了出来。
   */
  private readonly id = signal("?");
  private readonly q = signal("");

  readonly label = computed(() =>
    this.q() ? `detail:${this.id()}:q=${this.q()}` : `detail:${this.id()}`,
  );

  constructor() {
    const route = inject(ActivatedRoute);
    const subs = [
      route.paramMap.subscribe((p) => this.id.set(p.get("id") ?? "?")),
      route.queryParamMap.subscribe((p) => this.q.set(p.get("q") ?? "")),
    ];
    inject(DestroyRef).onDestroy(() => subs.forEach((s) => s.unsubscribe()));
  }
}

@Component({
  selector: "t-rt-shell",
  imports: [RouterOutlet],
  schemas: [NO_ERRORS_SCHEMA],
  template: `<VBoxContainer name="shell">
    <Label text="shell"></Label>
    <router-outlet></router-outlet>
  </VBoxContainer>`,
})
class ShellComp {}

@Component({
  selector: "t-rt-missing",
  template: `<Label name="missing" text="not-found"></Label>`,
})
class MissingComp {}

@Component({
  selector: "t-rt-host",
  imports: [RouterOutlet],
  schemas: [NO_ERRORS_SCHEMA],
  template: `<VBoxContainer name="host">
    <Button name="go-home" text="go-home" (click)="go('/')"></Button>
    <Button name="go-about" text="go-about" (click)="go('/about')"></Button>
    <router-outlet></router-outlet>
  </VBoxContainer>`,
})
class HostComp {
  private readonly router = inject(Router);
  go(path: string): void {
    void this.router.navigate([path]);
  }
}

const TWO_ROUTES = [
  { path: "", component: HomeComp },
  { path: "about", component: AboutComp },
];

describe("路由：PlatformLocation 是内存历史栈", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("provideGodotRouter 把 PlatformLocation 换成 Godot 实现", async () => {
    const fixture = await bootstrapRouter(HostComp, provideGodotRouter(TWO_ROUTES));
    expect(TestBed.inject(PlatformLocation)).toBeInstanceOf(GodotPlatformLocation);
    // 同一个 token 两次注入必须同一个实例（单例服务）。只比同一个 token：TestBed 有模块
    // 注入器与 root 注入器两层，跳 token 比（PlatformLocation vs GodotPlatformLocation）
    // 会踩到不同层，结果取决于用例顺序，不是可靠断言。
    expect(TestBed.inject(PlatformLocation)).toBe(TestBed.inject(PlatformLocation));
    expect(fixture).toBeTruthy();
  });

  /**
   * `URL` / `URLSearchParams` 由 `core/location.ts` 紧贴它的 import 装上（原因见那个文件）。
   * 与 `document` 那种空壳不同，它是跑完整规范的真实现，路由直接依赖它。
   */
  it("URL / URLSearchParams 已被装到全局（GodotJS 原生没有）", () => {
    const g = globalThis as any;
    expect(typeof g.URL).toBe("function");
    const u = new g.URL("/a/../b?x=1#f", "godot://localhost/");
    expect(u.pathname).toBe("/b");
    expect(u.search).toBe("?x=1");
    expect(u.hash).toBe("#f");
    expect(new g.URLSearchParams("a=1&b=x y").get("b")).toBe("x y");
  });

  it("导航后 URL 三段被真实写入历史栈", async () => {
    await bootstrapRouter(HostComp, provideGodotRouter([...TWO_ROUTES, { path: "detail/:id", component: DetailComp }]));
    const router = TestBed.inject(Router);
    const platform = TestBed.inject(PlatformLocation) as GodotPlatformLocation;

    await router.navigate(["/detail", 7], { queryParams: { q: "x" } });
    expect(platform.pathname).toBe("/detail/7");
    expect(platform.search).toBe("?q=x");
    expect(platform.href).toBe("godot://localhost/detail/7?q=x");
  });

  it("query 里须编码的字符：编码一次，不会被二次编码", async () => {
    const fixture = await bootstrapRouter(HostComp, provideGodotRouter([
      { path: "", component: HomeComp },
      { path: "detail/:id", component: DetailComp },
    ]));
    const router = TestBed.inject(Router);
    const platform = TestBed.inject(PlatformLocation) as GodotPlatformLocation;

    await router.navigate(["/detail", 7], { queryParams: { q: "a b" } });
    await fixture.whenStable();
    // 空格被编成 %20；`%` 自身不在编码集里，所以不会被二次编码成 %2520
    expect(platform.search).toBe("?q=a%20b");
    expect(nodeTexts(fixture.nativeElement)).toContain("detail:7:q=a b");

    await router.navigate(["/detail", 8], { queryParams: { q: "100%" } });
    await fixture.whenStable();
    expect(platform.search).toBe("?q=100%25");
    expect(nodeTexts(fixture.nativeElement)).toContain("detail:8:q=100%");
  });

  it("query 与 fragment 同时存在时切分正确", async () => {
    await bootstrapRouter(HostComp, provideGodotRouter([...TWO_ROUTES, { path: "detail/:id", component: DetailComp }]));
    const router = TestBed.inject(Router);
    const platform = TestBed.inject(PlatformLocation) as GodotPlatformLocation;

    await router.navigate(["/detail", 7], { queryParams: { q: "x" }, fragment: "top" });
    expect(platform.pathname).toBe("/detail/7");
    expect(platform.search).toBe("?q=x");
    expect(platform.hash).toBe("#top");

    // 只改锚点：path 与 query 都得留住
    platform.pushState(null, "", "#bottom");
    expect(platform.pathname).toBe("/detail/7");
    expect(platform.search).toBe("?q=x");
    expect(platform.hash).toBe("#bottom");

    // 只改 query：按规范锚点会被丢掉
    platform.pushState(null, "", "?q=y");
    expect(platform.pathname).toBe("/detail/7");
    expect(platform.search).toBe("?q=y");
    expect(platform.hash).toBe("");
  });

  it("GODOT_INITIAL_URL 决定起始页（深链启动）", async () => {
    const fixture = await bootstrapRouter(HostComp, provideGodotRouter(TWO_ROUTES), [
      { provide: GODOT_INITIAL_URL, useValue: "/about" },
    ]);
    expect(nodeTexts(fixture.nativeElement)).toContain("about");
    expect(TestBed.inject(Location).path()).toBe("/about");
  });

  /**
   * 起始 URL 不只是“少写一次 navigate”的糖：路由表里没有空路径时，它是唯一的入口。
   * 不给的话初始导航匹配不上，outlet 保持空。
   */
  it("路由表没有空路径且不给起始 URL：outlet 保持空", async () => {
    const plain = await bootstrapRouter(HostComp, provideGodotRouter([{ path: "battle", component: AboutComp }]));
    expect(nodeTexts(plain.nativeElement)).not.toContain("about");
  });

  it("同一个路由表，只多一个起始 URL，页面就出来了", async () => {
    const deep = await bootstrapRouter(
      HostComp,
      provideGodotRouter([{ path: "battle", component: AboutComp }]),
      [{ provide: GODOT_INITIAL_URL, useValue: "/battle" }],
    );
    expect(nodeTexts(deep.nativeElement)).toContain("about");
    expect(TestBed.inject(Location).path()).toBe("/battle");
  });
});

describe("路由：初始导航与跳转", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("初始导航渲染默认路由", async () => {
    const fixture = await bootstrapRouter(HostComp, provideGodotRouter(TWO_ROUTES));
    expect(nodeTexts(fixture.nativeElement)).toContain("home");
    // 根路径的 Location.path() 是空串：normalize 会剔掉尾斜杠，浏览器下也一样
    expect(TestBed.inject(Location).path()).toBe("");
  });

  it("navigate 替换 outlet 内容，旧页节点被摘掉", async () => {
    const fixture = await bootstrapRouter(HostComp, provideGodotRouter(TWO_ROUTES));
    const router = TestBed.inject(Router);

    await router.navigate(["/about"]);
    await fixture.whenStable();

    const texts = nodeTexts(fixture.nativeElement);
    expect(texts).toContain("about");
    expect(texts).not.toContain("home");
    expect(TestBed.inject(Location).path()).toBe("/about");
  });

  it("路由参数与查询参数都能读到", async () => {
    const fixture = await bootstrapRouter(
      HostComp,
      provideGodotRouter([{ path: "", component: HomeComp }, { path: "detail/:id", component: DetailComp }]),
    );
    const router = TestBed.inject(Router);

    await router.navigate(["/detail", 42], { queryParams: { q: "abc" } });
    await fixture.whenStable();
    expect(nodeTexts(fixture.nativeElement)).toContain("detail:42:q=abc");

    await router.navigate(["/detail", 7]);
    await fixture.whenStable();
    expect(nodeTexts(fixture.nativeElement)).toContain("detail:7");
  });

  it("navigateByUrl 接受带查询串的整条 URL", async () => {
    const fixture = await bootstrapRouter(
      HostComp,
      provideGodotRouter([{ path: "", component: HomeComp }, { path: "detail/:id", component: DetailComp }]),
    );
    await TestBed.inject(Router).navigateByUrl("/detail/3?q=zz");
    await fixture.whenStable();
    expect(nodeTexts(fixture.nativeElement)).toContain("detail:3:q=zz");
  });

  it("catch-all 兜住未知路由", async () => {
    const fixture = await bootstrapRouter(
      HostComp,
      provideGodotRouter([{ path: "", component: HomeComp }, { path: "**", component: MissingComp }]),
    );
    await TestBed.inject(Router).navigate(["/nope"]);
    await fixture.whenStable();
    expect(nodeTexts(fixture.nativeElement)).toContain("not-found");
  });

  it("canActivate 返回 false 时停在原页", async () => {
    const fixture = await bootstrapRouter(
      HostComp,
      provideGodotRouter([
        { path: "", component: HomeComp },
        { path: "about", component: AboutComp, canActivate: [() => false] },
      ]),
    );
    await TestBed.inject(Router).navigate(["/about"]);
    await fixture.whenStable();
    expect(nodeTexts(fixture.nativeElement)).toContain("home");
    expect(TestBed.inject(Location).path()).toBe("");
  });

  it("NavigationEnd 每次成功导航各发一次", async () => {
    await bootstrapRouter(HostComp, provideGodotRouter(TWO_ROUTES));
    const router = TestBed.inject(Router);
    let ends = 0;
    router.events.subscribe((e) => {
      if (e instanceof NavigationEnd) ends++;
    });

    await router.navigate(["/about"]);
    await router.navigate(["/"]);
    expect(ends).toBe(2);
  });
});

describe("路由：历史与 popstate", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("Location.back() 回到上一页并重新渲染", async () => {
    const fixture = await bootstrapRouter(HostComp, provideGodotRouter(TWO_ROUTES));
    const router = TestBed.inject(Router);
    const location = TestBed.inject(Location);

    await router.navigate(["/about"]);
    await fixture.whenStable();
    expect(nodeTexts(fixture.nativeElement)).toContain("about");

    location.back();
    await flushMacrotask();
    await fixture.whenStable();
    expect(location.path()).toBe("");
    expect(nodeTexts(fixture.nativeElement)).toContain("home");
  });

  it("back 后再 forward，两条方向都走 popstate", async () => {
    const fixture = await bootstrapRouter(HostComp, provideGodotRouter(TWO_ROUTES));
    const router = TestBed.inject(Router);
    const location = TestBed.inject(Location);

    await router.navigate(["/about"]);
    location.back();
    await flushMacrotask();
    await fixture.whenStable();
    expect(nodeTexts(fixture.nativeElement)).toContain("home");

    location.forward();
    await flushMacrotask();
    await fixture.whenStable();

    expect(location.path()).toBe("/about");
    expect(nodeTexts(fixture.nativeElement)).toContain("about");
  });

  it("导航到同一 URL 不追加历史条目", async () => {
    await bootstrapRouter(HostComp, provideGodotRouter(TWO_ROUTES));
    const router = TestBed.inject(Router);
    const platform = TestBed.inject(PlatformLocation) as GodotPlatformLocation;

    const before = platform.length;
    await router.navigate(["/about"]);
    await router.navigate(["/about"]);
    expect(platform.length).toBe(before + 1);
  });

  it("新导航丢弃 forward 分支（与浏览器一致）", async () => {
    await bootstrapRouter(HostComp, provideGodotRouter(TWO_ROUTES));
    const router = TestBed.inject(Router);
    const location = TestBed.inject(Location);
    const platform = TestBed.inject(PlatformLocation) as GodotPlatformLocation;

    await router.navigate(["/about"]);
    location.back();
    expect(platform.length).toBe(2);
    expect(platform.position).toBe(0);

    await router.navigate(["/about"]);
    expect(platform.length).toBe(2);
  });
});

describe("路由：模板里的跳转", () => {
  beforeEach(() => initGodotTestEnvironment());

  /**
   * `routerLink` 指令**不支持**，跳转写 `(click)` + `router.navigate()`。
   *
   * RouterLink 的 host listener 是 `click: onClick($event.button, $event.ctrlKey, …)`，
   * 而 `Button.pressed()` 零参数，`$event` 为 undefined，读成员当场 TypeError。
   * 继承覆写 onClick 也救不了：host listener 是合并而非覆盖，报错在 Angular 生成的
   * 包装函数里，根本进不到 onClick。详见 docs/development.md 第 18 条。
   */
  it("(click) + router.navigate 完成跳转（支持的写法）", async () => {
    @Component({
      selector: "t-rl-nav",
      imports: [RouterOutlet],
      schemas: [NO_ERRORS_SCHEMA],
      template: `<VBoxContainer name="nav">
        <Button name="go-about" text="go-about" (click)="go('/about')"></Button>
        <router-outlet></router-outlet>
      </VBoxContainer>`,
    })
    class NavComp {
      private readonly router = inject(Router);
      go(path: string): void {
        void this.router.navigate([path]);
      }
    }

    const fixture = await bootstrapRouter(NavComp, provideGodotRouter(TWO_ROUTES));

    findButton(fixture.nativeElement, "go-about").emit_signal("pressed");
    await fixture.whenStable();

    expect(nodeTexts(fixture.nativeElement)).toContain("about");
    expect(TestBed.inject(Location).path()).toBe("/about");
  });
});

describe("路由：嵌套与策略", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("子路由渲染进父组件自己的 outlet", async () => {
    const fixture = await bootstrapRouter(
      HostComp,
      provideGodotRouter([
        { path: "", pathMatch: "full", redirectTo: "shell" },
        {
          path: "shell",
          component: ShellComp,
          children: [
            { path: "", component: HomeComp },
            { path: "about", component: AboutComp },
          ],
        },
      ]),
    );
    const router = TestBed.inject(Router);

    await router.navigate(["/shell"]);
    await fixture.whenStable();
    let texts = nodeTexts(fixture.nativeElement);
    expect(texts).toContain("shell");
    expect(texts).toContain("home");

    await router.navigate(["/shell", "about"]);
    await fixture.whenStable();
    texts = nodeTexts(fixture.nativeElement);
    expect(texts).toContain("shell");
    expect(texts).toContain("about");
    expect(texts).not.toContain("home");
  });

  it("withHashLocation：URL 写在 hash 上，path 保持根路径", async () => {
    const fixture = await bootstrapRouter(HostComp, provideGodotRouter(TWO_ROUTES, withHashLocation()));
    const router = TestBed.inject(Router);
    const platform = TestBed.inject(PlatformLocation) as GodotPlatformLocation;

    await router.navigate(["/about"]);
    await fixture.whenStable();

    expect(nodeTexts(fixture.nativeElement)).toContain("about");
    expect(platform.pathname).toBe("/");
    expect(platform.hash).toBe("#/about");
  });
});

describe("路由：route.title 的写入位置", () => {
  beforeEach(() => initGodotTestEnvironment());

  it("title 记录在 GodotTitleStrategy 上，无头声明生效时不碰窗口", async () => {
    const fixture = await bootstrapRouter(
      HostComp,
      provideGodotRouter([
        { path: "", component: HomeComp, title: "首页" },
        { path: "about", component: AboutComp, title: "关于" },
      ]),
    );
    // 测试环境真的跑在 --headless 下，所以它必须主动声明（GodotTestingModule 里 provide）。
    // 库不再猜 DisplayServer.get_name()：猜错了只多一行日志，靠猜永远不会在 CI 上被发现。
    expect(TestBed.inject(GODOT_HEADLESS), "测试环境没声明无头").toBe(true);

    const strategy = TestBed.inject(TitleStrategy) as GodotTitleStrategy;
    expect(strategy).toBeInstanceOf(GodotTitleStrategy);
    expect(strategy.currentTitle).toBe("首页");

    await TestBed.inject(Router).navigate(["/about"]);
    await fixture.whenStable();
    expect(strategy.currentTitle).toBe("关于");
  });

  /**
   * TitleStrategy 必须是 DI 构造的单例服务，而不是 provider 里手动 new。
   * 两个 token 拿到同一个实例就是证据：手动 new 的话 TitleStrategy 那份会是新对象。
   */
  it("GodotTitleStrategy 是服务：同一 token 两次注入是同一个实例", async () => {
    await bootstrapRouter(
      HostComp,
      provideGodotRouter([{ path: "", component: HomeComp, title: "首页" }]),
    );
    expect(TestBed.inject(TitleStrategy)).toBe(TestBed.inject(TitleStrategy));
    expect(TestBed.inject(TitleStrategy)).toBeInstanceOf(GodotTitleStrategy);
  });

  /**
   * 标题必须写 `Window.title` 而不是 `DisplayServer.window_set_title()`：后者只改操作系统
   * 那侧的文字，不回写 Window.title，而 Godot 没有 DisplayServer.window_get_title()，
   * 于是“当前页面标题”从写入那一刻就读不回来了（日志与测试只能看到启动时那个）。
   */
  it("非无头：标题写进 Window.title，因此读得回来", async () => {
    await bootstrapRouter(
      HostComp,
      provideGodotRouter([
        { path: "", component: HomeComp, title: "首页" },
        { path: "about", component: AboutComp, title: "关于" },
      ]),
      [{ provide: GODOT_HEADLESS, useValue: false }],
    );

    const window = TestBed.inject(GODOT_ROOT).get_window();
    expect(window, "测试根节点未进树，取不到窗口").not.toBeNull();
    expect(window!.title).toBe("首页");

    await TestBed.inject(Router).navigate(["/about"]);
    expect(window!.title).toBe("关于");
  });
});

/**
 * 生产入口那条路：`bootstrapGodotApp` 会跑 APP_BOOTSTRAP_LISTENER，初始导航自动发生，
 * 不需要测试替它调用 initialNavigation()。
 *
 * 结尾不 destroy：`destroy()` 会停掉帧泵，后面的 spec 文件会被牵连（与 app.spec.ts 同一约定）。
 */
describe("路由：生产 bootstrap 路径", () => {
  it("bootstrapGodotApp + provideGodotRouter：初始导航自动完成", async () => {
    @Component({
      selector: "t-rt-boot",
      imports: [RouterOutlet],
      schemas: [NO_ERRORS_SCHEMA],
      template: `<VBoxContainer name="boot"><router-outlet></router-outlet></VBoxContainer>`,
    })
    class BootComp {}

    const root = initGodotTestEnvironment();
    const app = await bootstrapGodotApp(
      BootComp,
      root,
      [provideGodotRouter(TWO_ROUTES)],
    );
    // 初始导航是非阻塞的（EnabledNonBlocking），让出宏任务让它跑完
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(nodeTexts(root)).toContain("home");
    expect(app.rootComponent).toBeTruthy();
  });
});
