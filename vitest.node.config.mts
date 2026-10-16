import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      // 顺序重要：更长的说明符必须排在前面，否则 `godot-angular/core` 会被
      // 下面那条前缀匹配为 `core/index.ts/core`。
      {
        find: "godot-angular/css",
        replacement: path.resolve("packages/css/index.ts"),
      },
      {
        find: "godot-angular/core",
        replacement: path.resolve("packages/library/core/index.ts"),
      },
      {
        find: "godot-angular/router",
        replacement: path.resolve("packages/library/router/index.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    include: [
      "packages/css/**/test/**/*.spec.ts",
      "packages/library/**/test/**/*.spec.ts",
      "packages/builder/**/test/**/*.spec.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "test-app/**"],
  },
});
