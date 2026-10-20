/**
 * 全局样式表（angular.json 的 `styles` 选项）的交接处。
 *
 * 单独成模块的原因：`css-runtime.ts` 会连带 `style-target.ts` 在运行期 import 真 `godot`
 * 包，纯 node 环境（库的 vitest 套件）加载不了；这段逻辑本身与引擎无关，需要能单独测试。
 *
 * 交接使用全局变量而不是 import：polyfill 入口必须在 Angular 之前求值，而它不能 import 本库。
 */

const GLOBAL_CSS_KEY = "__CUJ_GLOBAL_CSS__";

/**
 * 取走构建期写入的全局样式，取完即置空，后续调用取到空数组。
 *
 * 这是一次性交接。同一进程内的每个应用都持有独立的 `StyleRuntime`，都需要向自己的级联
 * 注册全局样式，那种场合使用下面的 `readGlobalCss()`。
 */
export function takeGlobalCss(): string[] {
  const bag = globalThis as Record<string, unknown>;
  const raw = bag[GLOBAL_CSS_KEY];
  if (!Array.isArray(raw)) return [];
  bag[GLOBAL_CSS_KEY] = [];
  return raw.filter((css): css is string => typeof css === "string" && css.trim().length > 0);
}

/** 首次取到的全局样式，供之后创建的运行时重复注册 */
let globalCssCache: string[] | null = null;

/**
 * 为一个运行时取全局样式：第一个运行时从全局变量取走并缓存，之后的运行时（同进程的第二个
 * 应用、或同一场景销毁重建后的新实例）取到同一份副本，各自注册。
 *
 * 与 `takeGlobalCss()` 的差别只有缓存。运行时按应用独立创建后，每个级联都必须注册一遍
 * 全局样式，否则第二个应用取到空数组，整屏没有全局样式，且现象随应用创建顺序变化。
 */
export function readGlobalCss(): string[] {
  if (globalCssCache === null) globalCssCache = takeGlobalCss();
  return globalCssCache;
}
