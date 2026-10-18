import { build } from "vite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 生产构建必须将告警文案整段摇除。
 *
 * 运行期判断（`if (!devMode) return`）无法达成该目的：字符串是调用点的实参，只要该语句仍
 * 存在，文案便仍留在产物中，既不节省体积也不节省开销。正确口径为**编译期常量**：
 * `ngDevMode` 被 define 为 false 后，`if (ngDevMode)` 分支连同其中的模板字符串一并消除。
 *
 * 本测试直接将构建得出的库产物（`dist/fesm2022/godot-angular-css.mjs`）交由 vite 再处理一次，
 * 分别模拟开发构建（define 为 true）与脚本优化开启的生产构建（define 为 false），
 * 随后在产物中检索一个必然出现在告警文案中的词。能否检索到，即为该机制是否成立的直接证据。
 *
 * 两侧均显式赋值：构建器现于两个方向均固定定义（见 build-core.ts 的 define），产物中不应
 * 残留自由标识符。
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..", "..");

/** 构建产物里的 css 入口（ng-packagr 产物，未压缩，`ngDevMode` 尚未被替换） */
function cssBundle(): string {
  const dir = resolve(repoRoot, "dist", "fesm2022");
  expect(existsSync(dir), `未找到 ${dir}，请先执行 pnpm build`).toBe(true);
  const file = readdirSync(dir).find((name) => name === "godot-angular-css.mjs");
  expect(file).toBeTruthy();
  return resolve(dir, file as string);
}

/** 将库产物作为入口再次交由打包器处理，返回产出的 JS 文本 */
async function bundle(define: Record<string, string>): Promise<string> {
  const entry = cssBundle();
  const result = await build({
    configFile: false,
    logLevel: "silent",
    define,
    // 库产物本身无入口引用，此处以虚拟入口将其挂载，避免整包被判定为未使用而被摇除
    plugins: [{
      name: "hold-entry",
      resolveId: (id: string) => (id === "\0hold" ? "\0hold" : null),
      load: (id: string) =>
        id === "\0hold" ? `export { applyCssProperty } from ${JSON.stringify(entry)};\n` : null,
    }],
    build: {
      write: false,
      minify: true,
      target: "es2022",
      rollupOptions: { input: "\0hold" },
    },
  });
  const output = (result as { output: Array<{ code?: string }> }).output.filter((c) => c.code);
  return output.map((chunk) => chunk.code).join("\n");
}

describe("生产构建摇除告警文案", () => {
  it("开发构建：告警文案保留在产物中（开发阶段可见，才可能在开发阶段被修正）", async () => {
    const code = await bundle({ ngDevMode: "true" });
    expect(code).toContain("没有对应实现");
  });

  it("脚本优化开启：告警文案整段消失（并非运行时不打印，而是根本不纳入产物）", async () => {
    const code = await bundle({ ngDevMode: "false" });
    expect(code).not.toContain("没有对应实现");
    expect(code).not.toContain("已忽略");
    // 功能本身不能被摇除：写入位置所用的 item 名仍需存在
    expect(code).toContain("font_color");
    expect(code).toContain("size_flags_stretch_ratio");
  });
});
