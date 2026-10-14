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
// style-target：CSS 声明到 Godot theme 落点的唯一出口。导出它有两个实际用途：
// 使用方可命令式刷样式（不走模板），以及引擎侧测试能直接验证 duplicate / ledger 语义。
export { applyStyle, clearStyle, styleLedger } from "./style-target";
// 运行时：把纯包的 Cascade 接到帧末与节点树上。使用方自行 `new Cascade()` 没意义：
// 它不知道 rAF、也不知道节点树，这两件事只有库内部接得对。
// StyleRuntime 是类而不是接口：`new StyleRuntime()` 建实例，类名本身继续当类型用。
export {
  StyleRuntime,
  defaultStyleRuntime,
  takeGlobalCss,
  type StyleRuntimeOptions,
} from "./css-runtime";
// 伪类信号接线：级联内部在用（attach 时连信号、登记样式表时提示无落点的伪类）。
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
// 产品代码不应调用它（它存在的唯一理由是隔离）。
export { resetWarnOnce } from "./warn";
// 手动接信号只有一个入口：接不到返回 null，是否抛错由调用方决定（不保留会抛错的兼容包装）。
export { tryConnectGodotSignal } from "./godot-events";
// forms 走独立入口 godot-angular/forms：在这里 re-export 会把
// @angular/forms（约 380 kB）装进每个 app 产物，即使项目根本没用到表单。
export {
  HTML_TAG_ALIASES,
  isControlClass,
  resolveTag,
  resolveSignalName,
  nodeHasProperty,
  coerceToProperty,
  propertyVariantType,
  GODOT_TYPE,
} from "./registry";
