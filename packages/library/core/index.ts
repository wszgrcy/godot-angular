/// <reference path="../../../typings/ng-dev-mode.d.ts" />
// `ngDevMode` 为全局声明：本地 tsc 依据 tsconfig 的 include 获取它，ng-packagr 为入口点
// 自建编译程序时不读 include，仅跟随三重斜线引用（口径同 css 入口）。

export { godotClass } from "./godot-host";
// stop / resumeFrameCallbacks、GODOT_APP_PROVIDERS、warnOnce 属于内部接线，不从这里导出。
export { bootstrapGodotApp, GodotAngularApp, GodotErrorHandler } from "./bootstrap";
// shim 三件套 / CSS_VAR_NAMESPACE / provideCssVarNamespacing 与 renderer 一起导出：
// 它们在 renderer.ts 中本就是同一文件的顶层声明，保持同文件便于与上游 diff。
export {
  COMPONENT_VARIABLE,
  CONTENT_ATTR,
  CSS_VAR_NAMESPACE,
  GodotRenderer,
  GodotRendererFactory,
  HOST_ATTR,
  provideCssVarNamespacing,
  shimContentAttribute,
  shimHostAttribute,
  shimStylesContent,
} from "./renderer";
// style-target：CSS 声明写入 Godot theme 的唯一出口。属于内部实现，不在 README 公开清单里：
// 保留导出只因为两个内部消费者——库自身的命令式刷样式路径，以及引擎侧 spec 直接验证
// duplicate / ledger 语义。使用方不应依赖，签名与行为不遵循语义化版本。
export { applyStyle, clearStyle, styleLedger } from "./style-target";
// 运行时：把纯包的 Cascade 接到节点树上，并接上刷新调度。使用方自行 `new Cascade()` 没有意义：
// 它拿不到 Godot 节点树，也无法确定该用哪个调度器，这两项装配只有库内部能完成。
// StyleRuntime 是类而不是接口：`new StyleRuntime()` 建实例，类名本身继续当类型用。
export { StyleRuntime, defaultStyleRuntime, type StyleRuntimeOptions } from "./css-runtime";
// effect 版刷新调度器。`StyleRuntime` 传入 injector 时内部已接好，这里导出供自己组装时使用。
export { effectStyleScheduler } from "./style-scheduler";
// 全局样式交接：`takeGlobalCss` 是一次性 drain（取完置空），`readGlobalCss` 带缓存，
// 供同进程的每个应用各自往自己的 cascade 里注册一遍。`resetGlobalCssCache` 只给测试用。
export { readGlobalCss, resetGlobalCssCache, takeGlobalCss } from "./global-css";
// 伪类信号接线：级联内部在用（attach 时连信号、登记样式表时提示无法推导的伪类）。
export { bindPseudoClasses, hasPseudoBinder, warnUnboundPseudoClasses } from "./css-pseudo";
// 媒体查询环境：bootstrap 已自动把窗口尺寸 / 系统主题接到级联上，使用方无需自己接线；
// readEnvironment 单独留出，供不用 bootstrap 时手动读一次环境。
export { bindWindowEnvironment, readEnvironment } from "./css-env";
export { GODOT_PLATFORM_PROVIDERS } from "./bootstrap";
// 路由 / Location 在 Godot 侧的地基：PlatformLocation（内存历史栈）与空 ViewportScroller。
// GODOT_APP_PROVIDERS 与 GodotTestingModule 都已带上，使用方一般不需要自己接；
// 单独给 TestBed 换起始 URL 时才直接引这一组。
// 实现与接线分两个文件：历史栈是纯逻辑（Node 侧直接断言），provider 数组才依赖 DI。
export {
  GODOT_INITIAL_URL,
  GodotPlatformLocation,
} from "./location";
export { GODOT_LOCATION_PROVIDERS } from "./location-providers";
// GODOT_ROOT 需要导出：它是“取得自身所在的 Godot 父节点”的唯一口径，
// 组件里 `inject(GODOT_ROOT)` 是实际用法（bootstrapGodotApp 已把它 provide 进去）。
export { GODOT_HEADLESS, GODOT_ROOT, STYLE_RUNTIME } from "./tokens";
// 仅面对测试：warnOnce 是全局去重的，不清表则“确实告警了”这类断言会依赖用例顺序。
// 产品代码不应调用该函数（其存在的唯一理由是隔离）。setWarnEnabled 同理：仅用于在
// 未开启优化的构建中验证「关闭运行期告警后确实静默」，无需为此再执行一次优化构建。
export { resetWarnOnce, setWarnEnabled, warnEnabled } from "./warn";
// 手动接信号只有一个入口：接不到返回 null，是否抛错由调用方决定（不保留会抛错的兼容包装）。
export { tryConnectGodotSignal } from "./godot-events";
// RxJS 桥：需要在组件代码里用操作符组合引擎事件时走这里（模板事件不需要）。
export { godotSignal$ } from "./rx";
// forms 走独立入口 godot-angular/forms：在这里 re-export 会把
// @angular/forms（约 380 kB）装进每个 app 产物，即使项目根本没用到表单。
export {
  HTML_TAG_ALIASES,
  isControlClass,
  isNodeClass,
  resolveTag,
  resolveSignalName,
  nodeHasProperty,
  hasJsAccessor,
  coerceToProperty,
  propertyVariantType,
  GODOT_TYPE,
} from "./registry";
