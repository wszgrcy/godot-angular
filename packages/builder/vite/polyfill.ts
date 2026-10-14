import MagicString from "magic-string";
import type { Plugin } from "vite";
import { exactRegex } from "@rolldown/pluginutils";

export const POLYFILL_ENTRY_NAME = "cuj-polyfill";
/** 虚拟入口的说明符（rollup input 的键值） */
export const POLYFILL_ENTRY_SPECIFIER = "virtual:godot-angular/polyfill-entry";
/**
 * 必带补丁模块的说明符。
 *
 * 走包名子路径而不是绝对路径：`./builder/*` 已在 `package.json` 的 exports 里导出，而绝对
 * 路径会被 vite 识别成“落在 godot-angular 包内”，转而拿它去查 exports（`./polyfills` 未导出，
 * 直接报错）。
 *
 * 不用 `import`：本模块是 Node 侧的构建器代码，把补丁引进来会在构建进程里就改掉
 * `globalThis`，那是不该有的副作用。
 */
export const MANDATORY_POLYFILL_SPECIFIER = "godot-angular/builder/vite/polyfills.mjs";

/**
 * polyfill 的**一个**插件，管两头：
 *   输入侧 resolveId + load → 产出虚拟入口，首行固定引入构建器的补丁模块；
 *   输出侧 generateBundle → 把 require 写回每个入口顶部。
 *
 * enforce 只能给一个值，取 "pre"：resolveId 必须抢在 vite 核心解析之前。id 不加 `\0`
 * 前缀（裸说明符就够：只被 rollupOptions.input 引用，没人 import 它）。
 * 输出侧提前跑无影响：godotRequirePlugin 在 renderChunk 阶段（早于所有 generateBundle），
 * budgets 插件排在其后，量到的是注入后的尺寸。
 */
export function polyfillPlugin(options: { resRoot: string; extras: string[] }): Plugin {
  return {
    name: "godot-angular-polyfill",
    enforce: "pre",
    resolveId: {
      filter: { id: exactRegex(POLYFILL_ENTRY_SPECIFIER) },
      handler() {
        return POLYFILL_ENTRY_SPECIFIER;
      },
    },
    load: {
      filter: { id: exactRegex(POLYFILL_ENTRY_SPECIFIER) },
      handler() {
        // 只能是纯 JS（虚拟模块没有 transform 兜底），而且一行 import 就够
        return [MANDATORY_POLYFILL_SPECIFIER, ...options.extras]
          .map((spec) => `import ${JSON.stringify(spec)};`)
          .join("\n");
      },
    },
    generateBundle(_info, bundle) {
      // hash 已定稿，这里拿到的就是最终路径
      const hit = Object.entries(bundle).find(
        ([, item]) => item.type === "chunk" && item.name === POLYFILL_ENTRY_NAME,
      );
      if (!hit) {
        this.error(
          `补丁入口 ${POLYFILL_ENTRY_NAME} 未出现在构建产物中：input 或 output 配置可能被外部覆盖`,
        );
        return;
      }
      const line = `require(${JSON.stringify(`${options.resRoot}/${hit[0]}`)});\n`;

      for (const item of Object.values(bundle)) {
        if (item.type !== "chunk" || !item.isEntry) continue;
        if (item.name === POLYFILL_ENTRY_NAME) continue; // 补丁自己不用注入
        const s = new MagicString(item.code);
        s.prepend(line);
        item.code = s.toString();
        if (item.map) {
          // 整行平移：mappings 里一个 `;` 对应生成文件的一行，前面补 1 个就把所有
          // segment 整体下移一行。注入行本身没有 source，留空正是对的。
          item.map.mappings = ";" + item.map.mappings;
        }
      }
    },
  };
}
