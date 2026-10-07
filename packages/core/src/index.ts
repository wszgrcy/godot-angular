export { setGodotHost, getGodotHost, godotClass, type GodotHost } from "./godot-host";
// 不要动这一行的位置：import 本包 = 装 polyfill，polyfills 必须排在 bootstrap 之前被求值。
export { runFrameCallbacks, getDocumentStub } from "./polyfills";
export {
  bootstrapGodotApp,
  GODOT_APP_PROVIDERS,
  GODOT_PLATFORM_PROVIDERS,
  GodotAngularApp,
  GodotErrorHandler,
} from "./bootstrap";
export { GodotRenderer, GodotRendererFactory } from "./renderer";
export { GODOT_ROOT } from "./tokens";
export {
  HTML_TAG_ALIASES,
  isControlClass,
  resolveTag,
  resolveSignalName,
  nodeHasProperty,
  usableControlClasses,
  toSnakeCase,
} from "./registry";
