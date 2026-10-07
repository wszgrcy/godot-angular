/**
 * 平台装配：把 Angular 的 browser 平台换成 Godot 平台。
 *
 * 变更检测走 zoneless（provideZonelessChangeDetection），不引 zone.js：
 * 裸 V8 里没有可打的补丁点（无 rAF / queueMicrotask / Event / performance），
 * 而且帧驱动本来就是游戏引擎的自然节奏。
 *
 * 约定：provider 一律是常量数组（GODOT_PLATFORM_PROVIDERS / GODOT_APP_PROVIDERS），
 * 只有运行期才存在的 GODOT_ROOT 由 bootstrapGodotApp 单独并进去。
 */
// 必须排在 @angular/core 之前：import polyfills 就是装 polyfill，而下面的
// GODOT_APP_PROVIDERS 在模块求值阶段就要用 performance。
import { getDocumentStub, runFrameCallbacks } from "./polyfills";
import {
  ApplicationRef,
  PLATFORM_ID,
  Provider,
  RendererFactory2,
  Type,
  APP_ID,
  DOCUMENT,
  EnvironmentProviders,
  ErrorHandler,
  inject,
  provideAppInitializer,
  provideZonelessChangeDetection,
  ɵINJECTOR_SCOPE,
  ɵinternalCreateApplication,
} from "@angular/core";
import { GodotRendererFactory } from "./renderer";
import { GODOT_ROOT } from "./tokens";

/** 平台级 provider：换掉 PLATFORM_ID 与 DOCUMENT */
export const GODOT_PLATFORM_PROVIDERS: Provider[] = [
  { provide: PLATFORM_ID, useValue: "godot" },
  // 用工厂而不是 useValue：常量数组在模块求值阶段就定型，工厂留到注入时再取，
  // 拿到的必然是 polyfill 装好的那个 stub（而不是另起炉灶的新对象）。
  { provide: DOCUMENT, useFactory: getDocumentStub },
];

/** 把 Angular 错误打到 Godot 控制台（引擎里没 window.onerror，不打就彻底静默） */
export class GodotErrorHandler extends ErrorHandler {
  override handleError(error: unknown): void {
    console.error("[control-ui-js] Angular error:", error);
  }
}

/**
 * 帧驱动句柄：Godot 的 _process 每帧调一次 tick()。
 *
 * 由 DI 构造（见 GODOT_APP_PROVIDERS），不要手动 new —— 依赖一律 inject() 拿，
 * 组件里 `inject(GodotAngularApp)` 拿到的就是 bootstrapGodotApp() 返回的那一个。
 */
export class GodotAngularApp {
  private readonly appRef = inject(ApplicationRef);
  private readonly root = inject(GODOT_ROOT);

  /**
   * 由 provideAppInitializer 在根组件 bootstrap 之前调用。
   *
   * 只做"挂点体检"：Godot 侧传错对象时让 bootstrap 的 Promise 直接 reject 出可读信息，
   * 而不是等第一帧渲染时在引擎里炸成一句 "add_child not found"。
   */
  start(): void {
    if (!this.root || typeof this.root.add_child !== "function") {
      throw new Error(
        "[control-ui-js] GODOT_ROOT 不是一个 Godot Node（没有 add_child），无法承载组件树；" +
          "检查 bootstrapGodotApp(App, root) 的第二个参数",
      );
    }
  }

  /** 每帧调用：先跑 rAF 回调，再跑一次变更检测 */
  tick(deltaMs: number): void {
    runFrameCallbacks(deltaMs);
    this.appRef.tick();
  }

  get rootComponent(): unknown {
    return this.appRef.components[0]?.instance;
  }

  /** 承载组件树的 Godot Control */
  get rootControl(): any {
    return this.root;
  }

  destroy(): void {
    this.appRef.destroy();
  }
}

/** 应用级 provider：不含运行期才有的 GODOT_ROOT，那条由 bootstrapGodotApp 补 */
export const GODOT_APP_PROVIDERS: (Provider | EnvironmentProviders)[] = [
  provideZonelessChangeDetection(),
  // 根因修复：Environment Injector 必须标成 root scope，否则所有 providedIn:'root'
  // 的服务（PendingTasksInternal 等）全部 NG0201。浏览器平台由 BrowserModule 提供这一条。
  { provide: ɵINJECTOR_SCOPE, useValue: "root" },
  { provide: RendererFactory2, useClass: GodotRendererFactory },
  // 用 ɵinternalCreateApplication 不会带 ApplicationModule 的 provider，
  // 而 errorHandlerEnvironmentInitializer 强制要求树里有 ErrorHandler，缺了就 NG0402。
  // 只给这一条就够了：INTERNAL_APPLICATION_ERROR_HANDLER 这个 token 自带 providedIn:'root'
  // 的 factory（转交 ErrorHandler.handleError），ApplicationRef 构造时 inject 得到的是它，
  // 不需要我们再补 provider。PROVIDED_NG_ZONE 同理，默认 factory 就是 false。
  { provide: ErrorHandler, useClass: GodotErrorHandler },
  // APP_ID 默认 factory 返回 "ng"；换成有意义的名字，devtools 里好认（要求字母数字/-/_）
  { provide: APP_ID, useValue: "godot" },
  // core 由 tsc 编译（没有 Angular compiler），类上没有 ɵprov，
  // 所以显式 useClass；构造参数为空，依赖在类里 inject()。
  { provide: GodotAngularApp, useClass: GodotAngularApp },
  // 初始化交给 Angular：bootstrap() resolve 之前必须跑完，
  // 于是 Godot 侧拿到句柄时挂点已经校验过，可以直接开始 tick。
  provideAppInitializer(() => {
    inject(GodotAngularApp).start();
  }),
];

/**
 * 在给定 Godot Control 上启动 Angular 应用。
 *
 * @param rootComponent 根组件类型
 * @param root          挂载用的 Godot Control（通常是场景里的根控件）
 */
export async function bootstrapGodotApp(
  rootComponent: Type<unknown>,
  root: any,
  extraProviders: (Provider | EnvironmentProviders)[] = [],
): Promise<GodotAngularApp> {
  const appRef = await ɵinternalCreateApplication({
    rootComponent,
    appProviders: [...GODOT_APP_PROVIDERS, { provide: GODOT_ROOT, useValue: root }, ...extraProviders],
    platformProviders: GODOT_PLATFORM_PROVIDERS,
  });
  return appRef.injector.get(GodotAngularApp);
}
