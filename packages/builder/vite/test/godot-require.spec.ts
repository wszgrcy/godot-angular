import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { godotRequirePlugin } from "../build-core";

/** 构造一个“两个入口共用一个模块”的工程，迫使 rollup 切出共享 chunk */
function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "cuj-req-"));
  writeFileSync(join(root, "shared.ts"), `export const SHARED = "shared";\n`);
  writeFileSync(join(root, "a.ts"), `import { SHARED } from "./shared";\nexport const A = "A" + SHARED;\n`);
  writeFileSync(join(root, "b.ts"), `import { SHARED } from "./shared";\nexport const B = "B" + SHARED;\n`);
  return root;
}

/** 执行一次真实构建，返回 { 产物路径 -> 该文件中所有 require(...) 的字面量 } */
async function requiresOf(withPlugin: boolean): Promise<Record<string, string[]>> {
  const root = makeFixture();
  try {
    await build({
      root,
      logLevel: "silent",
      build: {
        outDir: "out",
        emptyOutDir: true,
        minify: false,
        rollupOptions: {
          input: { a: join(root, "a.ts"), b: join(root, "b.ts") },
          preserveEntrySignatures: "strict",
          output: { format: "cjs", entryFileNames: "[name].js", chunkFileNames: "chunks/[name].js" },
        },
      },
      plugins: withPlugin ? [godotRequirePlugin("res://dist")] : [],
    });
    const out: Record<string, string[]> = {};
    for (const f of ["a.js", "b.js", "chunks/shared.js"]) {
      const code = readFileSync(join(root, "out", f), "utf8");
      out[f] = [...code.matchAll(/require\((['"])(.*?)\1\)/g)].map((m) => m[2]);
    }
    return out;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("godotRequirePlugin", () => {
  it("真实构建对照：相对 require 被换成 res:// 绝对路径", async () => {
    const off = await requiresOf(false);
    const on = await requiresOf(true);

    // 这就是演示输出：运行测试时可以直接看到两边差异
    console.log("\n  ── 不开插件（rollup CJS 原样输出）");
    for (const [f, reqs] of Object.entries(off)) {
      if (reqs.length) console.log(`     ${f.padEnd(16)} ${reqs.map((r) => `require("${r}")`).join(" ")}`);
    }
    console.log("  ── 开了插件（resRoot = res://dist）");
    for (const [f, reqs] of Object.entries(on)) {
      if (reqs.length) console.log(`     ${f.padEnd(16)} ${reqs.map((r) => `require("${r}")`).join(" ")}`);
    }

    // 入口指向共享 chunk：相对 → res://
    expect(off["a.js"]).toContain("./chunks/shared.js");
    expect(on["a.js"]).toContain("res://dist/chunks/shared.js");
    expect(on["b.js"]).toContain("res://dist/chunks/shared.js");
    // 产物中不应再残留任何相对 require
    for (const reqs of Object.values(on)) {
      expect(reqs.filter((r) => r.startsWith("."))).toEqual([]);
    }
  });

  it("路径算术：require 相对的是 chunk 自己的产物位置", () => {
    // 直接传入合成 chunk，精确验证 dirname 那一步（renderChunk 无法获取这个信息）
    const plugin = godotRequirePlugin("res://dist") as unknown as {
      generateBundle: (info: unknown, bundle: Record<string, { type: string; code: string }>) => void;
    };
    const chunk = (code: string) => ({ type: "chunk", code });
    const bundleIn = {
      // 入口在根目录：./x → res://dist/x
      "top.js": chunk(`const r = require("./sibling.js");`),
      // chunk 在子目录：./x 相对的是 chunks/，因此是 res://dist/chunks/x
      "chunks/deep.js": chunk(`const r = require("./sibling.js");`),
      // ../ 需要确实向上退一层
      "chunks/nested/deep.js": chunk(`const r = require("../up.js");`),
      // 非字面量 / 非相对路径不应被修改
      "keep.js": chunk(`const r = require("pkg"); const s = require(x);`),
    };
    plugin.generateBundle({}, bundleIn);

    expect(bundleIn["top.js"].code).toContain(`require("res://dist/sibling.js")`);
    expect(bundleIn["chunks/deep.js"].code).toContain(`require("res://dist/chunks/sibling.js")`);
    expect(bundleIn["chunks/nested/deep.js"].code).toContain(`require("res://dist/chunks/up.js")`);
    expect(bundleIn["keep.js"].code).toContain(`require("pkg")`);
    expect(bundleIn["keep.js"].code).toContain(`require(x)`);
  });
});
