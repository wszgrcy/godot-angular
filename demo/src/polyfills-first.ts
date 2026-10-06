/**
 * 必须作为 main.ts 的**第一个 import**。
 *
 * 原因：Angular 在模块求值阶段就会调用 performance.mark（ɵɵdefineComponent →
 * noSideEffects → performanceMarkFeature），而 ESM 的 import 会被提升到所有语句之前，
 * 所以写在 main.ts 函数里的 polyfill 调用来不及。放在独立模块里、排在 ./app 之前，
 * 求值顺序才是：core → 本模块（装 polyfill）→ app（组件定义）。
 */
import { installGodotPolyfills } from "@control-ui-js/core";

installGodotPolyfills();
