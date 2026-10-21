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
 * 为一个运行时取全局样式：交接变量非空时取走其内容并存入缓存；之后的运行时（同进程的第二个
 * 应用、或同一场景销毁重建后的新实例）取到同一份副本，各自注册。
 *
 * 与 `takeGlobalCss()` 的差别只有缓存。运行时按应用独立创建后，每个级联都必须注册一遍
 * 全局样式，否则第二个应用取到空数组，整屏没有全局样式，且现象随应用创建顺序变化。
 *
 * 每次调用都检查交接变量，而不是整个模块生命周期只取一次：后者会永久屏蔽第一批之后才写入的
 * 样式，而写入时机并不由本库控制（取决于 polyfill 入口与 Angular 的求值顺序）。交接变量为空
 * 时返回缓存；多应用场景走的是这条路径。
 */
export function readGlobalCss(): string[] {
  const drained = takeGlobalCss();
  if (drained.length > 0) globalCssCache = drained;
  return globalCssCache ?? [];
}

/**
 * 清空 `readGlobalCss()` 的缓存，仅供测试使用（与 `resetWarnOnce()` 同类）。
 *
 * 缓存是进程级的，测试用例需要各自决定全局样式的来源，否则前一个用例读过的内容
 * 会静默地成为后一个用例的输入。运行期不应调用。
 */
export function resetGlobalCssCache(): void {
  globalCssCache = null;
}
