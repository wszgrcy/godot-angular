import { frameClock } from "./frame";
import {
  ApplicationRef,
  PLATFORM_ID,
  Provider,
  StaticProvider,
  RendererFactory2,
  Type,
  APP_ID,
  EnvironmentProviders,
  ErrorHandler,
  inject,
  provideAppInitializer,
  provideZonelessChangeDetection,
  ɵINJECTOR_SCOPE,
  ɵinternalCreateApplication,
} from "@angular/core";
import { GodotRendererFactory } from "./renderer";
import { GODOT_ROOT, STYLE_RUNTIME } from "./tokens";
import { bindWindowEnvironment } from "./css-env";
import { defaultStyleRuntime } from "./css-runtime";
import type { Node } from "godot";

/** 平台级 provider：替换 PLATFORM_ID。 */
// 使用 StaticProvider[] 而不是 Provider[]：platformCore() 只接受静态 provider，
// 平台层也不应出现 useFactory / inject 这类运行期构造。
export const GODOT_PLATFORM_PROVIDERS: StaticProvider[] = [
  { provide: PLATFORM_ID, useValue: "godot" },
  // 不 provide DOCUMENT：core 中那个 DOCUMENT 是没有默认 factory 的裸 token，而
  // inject(DOCUMENT) 全部出现在 hydration / i18n 路径里，两条路径都不使用，
  // 因此不会被注入。确实需要时（接入 hydration 或引入 platform-browser 服务）再在此提供。
];

/** 将 Angular 错误输出到 Godot 控制台（引擎中没有 window.onerror，不输出则完全静默）。 */
export class GodotErrorHandler extends ErrorHandler {
  override handleError(error: unknown): void {
    console.error("[godot-angular] Angular error:", error);
  }
}

/**
 * 帧驱动句柄：Godot 的 _process 每帧调用一次 tick()。
 *
 * 由 DI 构造（见 GODOT_APP_PROVIDERS），不应手动 new：依赖一律通过 inject() 获取，
 * 组件里 `inject(GodotAngularApp)` 得到的就是 bootstrapGodotApp() 返回的那一个实例。
 */
export class GodotAngularApp {
  private readonly appRef = inject(ApplicationRef);
  private readonly root = inject(GODOT_ROOT);
  private readonly styleRuntime = inject(STYLE_RUNTIME, { optional: true }) ?? defaultStyleRuntime();
  private unbindEnv: (() => void) | null = null;
  private destroyed = false;

  /**
   * 由 provideAppInitializer 在根组件 bootstrap 之前调用：恢复帧驱动、接上媒体查询环境。
   * 挂载点本身已由 `root: Node` 保证（入口递的是引擎节点），无需重复校验节点类型。
   */
  start(): void {
    // 上一个应用 destroy 时停止了帧驱动（见 stopFrameCallbacks），新建的应用负责恢复。
    frameClock().resume();
    // 媒体查询环境：窗口尺寸 / 暗色模式。无头模式下读到的是 0 或假值（见 css-env.ts 注释），
    // 但接线必须在此完成——不应要求使用方自行记得接入，遗漏后的表现是“媒体查询静默失效”。
    this.unbindEnv = bindWindowEnvironment(this.styleRuntime, this.root);
  }

  /**
   * 每帧调用：把引擎的一帧交给 rAF 队列。变更检测不在此处运行，但 zoneless 调度的变更检测
   * 有一半挂在 rAF 上，不泵送则界面永不刷新。
   *
   * 两条约定：状态一律使用 signal（zoneless 只识别显式来源，从 Angular 无法触及的位置修改
   * 普通字段不会触发置脏）；不保证“emit 完成后同帧读到新值”，需要立即读取时请 await 一帧。
   */
  tick(deltaMs: number): void {
    if (this.destroyed) return;
    frameClock().run(deltaMs);
  }

  get rootComponent(): unknown {
    return this.appRef.components[0]?.instance;
  }

  /** 承载组件树的 Godot 节点。 */
  get rootControl(): Node {
    return this.root;
  }

  destroy(): void {
    // 先停止帧驱动再销毁：否则“销毁前注册的 rAF”会在销毁后的那一帧被放行，
    // 回调中访问已销毁的 signal / 已移除的节点，报错位置与真实原因相去甚远。
    this.destroyed = true;
    frameClock().stop();
    // 环境信号的生命周期比应用长（Window / DisplayServer 是引擎单例），不解绑会造成泄漏，
    // 且回调会持续向已销毁的应用写入数据
    this.unbindEnv?.();
    this.unbindEnv = null;
    this.appRef.destroy();
  }
}

/** 应用级 provider：不包含仅运行期可得的 GODOT_ROOT，该项由 bootstrapGodotApp 补充 */
export const GODOT_APP_PROVIDERS: (Provider | EnvironmentProviders)[] = [
  provideZonelessChangeDetection(),
  // Environment Injector 必须标记为 root scope，否则所有 providedIn:'root'
  // 的服务（PendingTasksInternal 等）均报 NG0201。浏览器平台由 BrowserModule 提供这一项。
  { provide: ɵINJECTOR_SCOPE, useValue: "root" },
  { provide: RendererFactory2, useClass: GodotRendererFactory },
  // ɵinternalCreateApplication 不携带 ApplicationModule 的 provider，而环境初始化器强制
  // 要求树中存在 ErrorHandler（缺失则 NG0402），因此只补充这一项。其余 token 自带
  // providedIn:'root' 的 factory，无需再次补充。
  { provide: ErrorHandler, useClass: GodotErrorHandler },
  // APP_ID 使用有意义的名称，便于在 devtools 中识别（默认值 "ng" 无法区分应用；要求字母数字 / - / _）
  { provide: APP_ID, useValue: "godot" },
  // core 由 tsc 编译（不经由 Angular compiler），类上没有 ɵprov，
  // 因此显式使用 useClass；构造参数为空，依赖在类内部通过 inject() 获取。
  { provide: GodotAngularApp, useClass: GodotAngularApp },
  // CSS 级联运行时。渲染器从 DI 获取它，因此测试可以注入隔离实例；
  // 未提供时渲染器会回退到进程级默认实例（见 GodotRendererFactory）。
  { provide: STYLE_RUNTIME, useFactory: () => defaultStyleRuntime() },
  // 初始化交由 Angular 负责：必须在 bootstrap() resolve 之前执行完毕，
  // 因此 Godot 侧取得句柄时挂载点已校验完成，可以直接开始 tick。
  provideAppInitializer(() => {
    inject(GodotAngularApp).start();
  }),
];

/**
 * 在给定 Godot 节点上启动 Angular 应用。
 *
 * @param rootComponent 根组件类型
 * @param root          用于挂载的 Godot 节点（通常是场景中的根控件）
 */
export async function bootstrapGodotApp(
  rootComponent: Type<unknown>,
  root: Node,
  extraProviders: (Provider | EnvironmentProviders)[] = [],
): Promise<GodotAngularApp> {
  const appRef = await ɵinternalCreateApplication({
    rootComponent,
    appProviders: [...GODOT_APP_PROVIDERS, { provide: GODOT_ROOT, useValue: root }, ...extraProviders],
    platformProviders: GODOT_PLATFORM_PROVIDERS,
  });
  return appRef.injector.get(GodotAngularApp);
}
