/**
 * 平台装配：把 Angular 的 browser 平台换成 Godot 平台。
 *
 * 变更检测走 zoneless（provideZonelessChangeDetection），不引 zone.js：
 * 裸 V8 里没有可打的补丁点（无 rAF / queueMicrotask / Event / performance），
 * 而且帧驱动本来就是游戏引擎的自然节奏。
 */
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
  provideZonelessChangeDetection,
  ɵINTERNAL_APPLICATION_ERROR_HANDLER,
  ɵINJECTOR_SCOPE,
  ɵPROVIDED_NG_ZONE,
  ɵinternalCreateApplication,
} from "@angular/core";
import { GodotRendererFactory } from "./renderer";
import { GODOT_ROOT } from "./tokens";
import { getDocumentStub, installGodotPolyfills, runFrameCallbacks } from "./polyfills";

export function provideGodotPlatform(): Provider[] {
  return [
    { provide: PLATFORM_ID, useValue: "godot" },
    { provide: DOCUMENT, useValue: getDocumentStub() },
  ];
}

/** 把 Angular 错误打到 Godot 控制台（引擎里没 window.onerror，不打就彻底静默） */
export class GodotErrorHandler extends ErrorHandler {
  override handleError(error: unknown): void {
    console.error("[control-ui-js] Angular error:", error);
  }
}

export function provideGodotApp(root: any): (Provider | EnvironmentProviders)[] {
  return [
    provideZonelessChangeDetection(),
    // 根因修复：Environment Injector 必须标成 root scope，否则所有 providedIn:'root'
    // 的服务（PendingTasksInternal 等）全部 NG0201。浏览器平台由 BrowserModule 提供这一条。
    { provide: ɵINJECTOR_SCOPE, useValue: "root" },
    { provide: RendererFactory2, useClass: GodotRendererFactory },
    { provide: GODOT_ROOT, useValue: root },
    // 用 ɵinternalCreateApplication 不会带 ApplicationModule 的 provider，
    // 而 errorHandlerEnvironmentInitializer 强制要求树里有 ErrorHandler，缺了就 NG0402。
    { provide: ErrorHandler, useClass: GodotErrorHandler },
    // APP_ID 的 token factory 不带 providedIn:'root'，得显式给（要求字母数字/-/_）
    { provide: APP_ID, useValue: "godot" },
    // ApplicationRef 构造时 inject(INTERNAL_APPLICATION_ERROR_HANDLER) 不带默认值，
    // 而这个 token 没有 providedIn:'root'——常规浏览器平台由 BrowserModule 链补上，
    // 我们不走那条路，就得自己给。语义照 Angular 自带 factory：转交给 ErrorHandler。
    {
      provide: ɵINTERNAL_APPLICATION_ERROR_HANDLER,
      useFactory: () => (err: unknown) => console.error("[control-ui-js] unhandled Angular error:", err),
    },
    // dev mode 兼容：bootstrap() 里的“同时提供了 zone / zoneless”检查写的是
    // `get(PROVIDED_ZONELESS) && get(PROVIDED_NG_ZONE)`——第二个 get() 不带默认值，
    // 纯 zoneless 下直接 NG0201。给个假值让它短路，prod 构建里该分支根本不会被编译进来。
    { provide: ɵPROVIDED_NG_ZONE, useValue: undefined },
  ];
}

/**
 * 已启动的应用句柄。Godot 侧持有它来驱动帧与退出。
 */
export class GodotAngularApp {
  constructor(readonly appRef: ApplicationRef) {}

  /** 每帧调用：先跑 rAF 回调，再跑一次变更检测 */
  tick(deltaMs: number): void {
    runFrameCallbacks(deltaMs);
    this.appRef.tick();
  }

  get rootComponent(): unknown {
    return this.appRef.components[0]?.instance;
  }

  destroy(): void {
    this.appRef.destroy();
  }
}
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
  installGodotPolyfills();
  const appRef = await ɵinternalCreateApplication({
    rootComponent,
    appProviders: [...provideGodotApp(root), ...extraProviders],
    platformProviders: provideGodotPlatform(),
  });
  return new GodotAngularApp(appRef);
}
