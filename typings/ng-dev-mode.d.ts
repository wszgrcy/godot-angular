/**
 * 开发模式标记（仓库内唯一声明处）。
 *
 * 该标识符**不由运行期提供，而由构建器于编译期固定**：`packages/builder/vite/build-core.ts`
 * 的 `define` 中，脚本优化开启时替换为 `false`，否则替换为 `true`。因此运行期仅有
 * `true` / `false` 两种取值，无需 `typeof` 探测——写为 `if (ngDevMode)` 即可，
 * 生产构建中 esbuild 直接将其折叠为 `false`，整条分支连同告警文案一并摇除。
 *
 * 各环境由谁保证其存在：
 * - 应用产物（含引擎测试 bundle）：上述 `define`，始终有值。
 * - Node 侧（builder 在构建期 lint 样式）：不依赖运行期全局。`tools/vite-build.ts` 将
 *   `godot-angular/css` 内联至 builder 产物（该依赖通常为 external 的发布物，ng-packagr
 *   不做 define，其中会残留自由标识符），并对这份副本 `define: { ngDevMode: "true" }`。
 *   builder 本身即处于开发态，告警照常收集。
 * - `pnpm test:node`：`vitest.node.config.mts` 的 `define`。
 *
 * 推论：本仓库之外的消费方若直接在 Node 中 `import "godot-angular/css"`，需自行补齐
 * 该全局（css 产物存在模块顶层求值，import 时即需读取它）。浏览器 / 应用侧无需处理。
 *
 * 名称沿用上游 Angular：其同名全局由 CLI 注入，语义（仅开发态输出诊断）亦一致。
 */
declare const ngDevMode: boolean;
