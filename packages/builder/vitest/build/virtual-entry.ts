import { globSync } from "tinyglobby";
import type { Plugin } from "vite";

/** 入口说明符（rollup input 的键值） */
export const VITEST_ENTRY_SPECIFIER = "virtual:godot-angular/vitest-entry";
/** 产物名（同时也是 angular.json 里 input 的键） */
export const VITEST_ENTRY_NAME = "vitest-entry";

/** glob 的唯一来源；宿主侧的 vitest include 和引擎侧的清单必须走同一个函数 */
export function collectSpecFiles(
  workspaceRoot: string,
  patterns: string[],
  ignore?: string[],
): string[] {
  return globSync(patterns, { cwd: workspaceRoot, onlyFiles: true, ignore }).sort();
}

export function vitestEntryPlugin(options: {
  workspaceRoot: string;
  patterns: string[];
  ignore?: string[];
  defaultPort: number;
}): Plugin {
  return {
    name: "godot-angular-vitest-entry",
    enforce: "pre",
    resolveId(id) {
      return id === VITEST_ENTRY_SPECIFIER ? VITEST_ENTRY_SPECIFIER : null;
    },
    load(id) {
      if (id !== VITEST_ENTRY_SPECIFIER) return null;
      const files = collectSpecFiles(options.workspaceRoot, options.patterns, options.ignore);
      if (files.length === 0) {
        this.error(`specInclude 未匹配到任何文件：${options.patterns.join(", ")}`);
      }
      // 虚拟模块没有“所在目录”，相对路径无从谈起，直接给绝对路径
      const entries = files.map(
        (rel) =>
          `  ${JSON.stringify(rel)}: () => import(${JSON.stringify(
            `${options.workspaceRoot}/${rel}`.replace(/\.ts$/, ""),
          )}),`,
      );
      // 只能是纯 JS：这段由 builtin:vite-dynamic-import-vars 直接解析，带类型标注会报错。
      // ⚠ 这里绝对不能出现 `from "godot"`：虚拟模块没有 package.json，rolldown 会给它
      // 编出不带 isNodeMode 的 `__toESM`，于是去读 `godot.__esModule` 被 Proxy 抛错。
      return (
        `import { createGodotVitestScene } from "godot-angular/vitest/runtime";\n` +
        `\nconst __CUJ_SPEC_MODULES__ = {\n${entries.join("\n")}\n};\n` +
        `\nexport default createGodotVitestScene({\n` +
        `  modules: __CUJ_SPEC_MODULES__,\n` +
        `  defaultPort: ${options.defaultPort},\n` +
        `});\n`
      );
    },
  };
}
