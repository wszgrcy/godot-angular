import type { Plugin } from "vite";

/** 仅用于统计数量供日志使用，字面量与字符串中的均计入，因此大于实际展开数属于正常现象 */
const COUNT = /\\[pP]\{[^}]*\}/g;

const count = (code: string): number => (code.match(COUNT) ?? []).length;

/**
 * 快速闸门：filter 中的字符串就是“包含”语义（子串搜索走原生实现；单字符类交替的正则
 * 需要启动整套 irregexp，反而慢几倍）。
 * 换成正则时不要带 /g：filter 内部同样依赖 `.test()`，而它带有状态（lastIndex），
 * 跨模块复用同一个对象会随机漏检。
 */
const PROPERTY_ESCAPE_GATE = ["\\p{", "\\P{"];

/** 仅在确实命中时才会执行到此处，因此 babel 采用动态加载（构建期零成本） */
async function loadBabel(): Promise<{
  transformAsync: typeof import("@babel/core").transformAsync;
  plugin: import("@babel/core").PluginItem;
}> {
  try {
    const [babel, unicodeRegex] = await Promise.all([
      import("@babel/core"),
      import("@babel/plugin-transform-unicode-regex"),
    ]);
    const plugin = (unicodeRegex.default ?? unicodeRegex) as import("@babel/core").PluginItem;
    return { transformAsync: babel.transformAsync, plugin };
  } catch (err) {
    throw new Error(
      `构建产物中包含 \\p{...}，需要由 babel 展开，但加载 @babel/core / ` +
        `@babel/plugin-transform-unicode-regex 失败：${(err as Error).message}`,
    );
  }
}

export function icuDowngradePlugin(log: (msg: string) => void): Plugin {
  return {
    name: "godot-angular-icu",
    enforce: "post",

    // 按模块逐个展开：拿到的就是当前模块，量级为几 KB
    transform: {
      filter: { code: PROPERTY_ESCAPE_GATE },
      async handler(code, id) {
        const hits = count(code); // 仅用于日志；字面量与字符串中的均计入，因此称为“检测到”而非“已展开”

        const { transformAsync, plugin } = await loadBabel();
        const result = await transformAsync(code, {
          configFile: false,
          babelrc: false,
          plugins: [plugin],
          // 产物是 cjs，但也可能混入 import.meta；unambiguous 由 babel 自行判断
          sourceType: "unambiguous",
          // 只发“本模块输入 → 输出”这一层，剩下的链由打包器自己接
          sourceMaps: true,
          inputSourceMap: false,
          retainLines: true,
          compact: "auto",
        });
        log(`ICU 降级：${id.split("/").slice(-2).join("/")} 检测到 ${hits} 处 \\p{...}，已交由 babel 展开`);

        const out = result?.code ?? code;
        // babel 的 map 带 readonly 数组，打包器只收 string | ExistingRawSourceMap
        const map = result?.map;
        return { code: out, map: map ? JSON.stringify(map) : null };
      },
    },
  };
}
