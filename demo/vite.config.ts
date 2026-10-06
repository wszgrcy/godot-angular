import { defineConfig } from "vite";
import angular from "@analogjs/vite-plugin-angular";

/**
 * 构建目标：GodotJS 运行时（CommonJS、无 DOM、不支持 ESM import）。
 * 产物必须是**单文件 CJS**：
 *   - lib.formats: ['cjs']
 *   - inlineDynamicImports: 禁止代码分割（约定上不使用懒加载）
 *
 * ⚠️ 不要再往 rollupOptions.output 里写 format / exports：
 *    与 build.lib 同时指定会覆盖入口，产出空文件（实测踩过）。
 *
 * 不需要 external：`godot` 模块由入口脚本注入给 core，Angular 侧不 import 它。
 */
export default defineConfig({
  plugins: [angular({ tsconfig: "./tsconfig.json" })],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2020",
    minify: false,
    sourcemap: false,
    lib: {
      entry: "src/main.ts",
      formats: ["cjs"],
      fileName: () => "app.bundle.js",
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
