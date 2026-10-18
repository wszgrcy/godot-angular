import {
  APP_ID,
  ErrorHandler,
  NgModule,
  RendererFactory2,
  platformCore,
  provideZonelessChangeDetection,
  ɵINJECTOR_SCOPE,
} from "@angular/core";
import { TestBed, TestComponentRenderer } from "@angular/core/testing";
import { Control, Vector2 } from "godot";
import {
  GODOT_HEADLESS,
  GODOT_LOCATION_PROVIDERS,
  GODOT_PLATFORM_PROVIDERS,
  GODOT_ROOT,
  STYLE_RUNTIME,
  GodotErrorHandler,
  GodotRendererFactory,
  StyleRuntime,
} from "godot-angular/core";
import { getEngineSceneRoot } from "./render";

/** 当前用例的根 Control。由 `initGodotTestEnvironment()` 在每个用例更换一个 */
let currentRoot: Control | null = null;

/** 只为使 `instanceof Node` 不报错，并且必须不匹配任何真实节点 */
function installNodeGlobal(): void {
  const g = globalThis as { Node?: unknown };
  if (g.Node === undefined) g.Node = class Node {};
}

/** 组件宿主由渲染器决定，这里不需要向任何位置插入根元素 */
class GodotTestComponentRenderer extends TestComponentRenderer {
  override insertRootElement(_rootElId: string, _tagName?: string): void {}
  override removeAllRootElements(): void {}
}

/**
 * 测试用模块，对标 `BrowserTestingModule`。与生产 `GODOT_APP_PROVIDERS` 只差一处：不带
 * `GodotAngularApp` 与 `provideAppInitializer`——TestBed 不 bootstrap 应用，帧驱动由
 * 引擎测试运行时统一驱动。
 */
@NgModule({
  providers: [
    provideZonelessChangeDetection(),
    { provide: ɵINJECTOR_SCOPE, useValue: "root" },
    // 路由 / Location 的地基。用例里 `provideRouter(routes)` 就能直接跑，不需要每个 spec
    // 自己补 PlatformLocation；起始 URL 想换的用例再单独 provide GODOT_INITIAL_URL。
    ...GODOT_LOCATION_PROVIDERS,
    // 使用 useFactory 而不是 useClass：core 由 tsc 编译产出，类上没有 ɵfac，
    // useClass 会使 DI 找不到工厂而报 NG2003。
    { provide: RendererFactory2, useFactory: () => new GodotRendererFactory(), deps: [] },
    // 每个测试模块一套全新的 CSS 级联。共用进程默认那套时，前一个用例注册的
    // 组件 CSS 会一直留在索引里，同名 class（如 `.box`）会跨用例互相影响；
    // 而“作用域不外泄”正是这一层要验证的内容，状态不干净就无法验证。
    { provide: STYLE_RUNTIME, useFactory: () => new StyleRuntime(), deps: [] },
    { provide: GODOT_ROOT, useFactory: () => currentRoot, deps: [] },
    // 引擎测试进程真的跑在 `--headless` 下，所以这里主动声明，而不是让库去探测
    // DisplayServer.get_name()：无头下没有可命名的窗口，写标题只会多一行引擎错误。
    { provide: GODOT_HEADLESS, useValue: true },
    { provide: TestComponentRenderer, useClass: GodotTestComponentRenderer },
    { provide: ErrorHandler, useClass: GodotErrorHandler },
    { provide: APP_ID, useValue: "godot-test" },
  ],
})
export class GodotTestingModule {}

/**
 * 每个用例开始前调用一次（放在 `beforeEach`）：换一个全新的根 Control 并重建 TestBed 环境。
 * `GODOT_PLATFORM_PROVIDERS` 是常量数组，而 platformCore() 按引用缓存，因此不会每个用例
 * 创建一个平台。未知标签 / 属性检查关闭：Godot 的属性代理不保证 `in` 能命中。
 * @returns 本用例的根 Control（`fixture.nativeElement` 就是它）
 */
export function initGodotTestEnvironment(options: { width?: number; height?: number } = {}): Control {
  installNodeGlobal();

  const root = new Control();
  root.set_name("TestBedRoot");
  const sceneRoot = getEngineSceneRoot();
  if (sceneRoot) sceneRoot.add_child(root);
  // 无头模式下 Control 默认 0x0，容器布局断言会失去意义，因此显式给定尺寸
  root.size = new Vector2(options.width ?? 600, options.height ?? 400);
  currentRoot = root;

  TestBed.resetTestEnvironment();
  TestBed.initTestEnvironment(GodotTestingModule, platformCore(GODOT_PLATFORM_PROVIDERS), {
    errorOnUnknownElements: false,
    errorOnUnknownProperties: false,
  });
  return root;
}
