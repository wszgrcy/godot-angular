import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { godotInteropPlugin } from "../godot-interop";
import { handlerOf } from "./hook";

const nodeRequire = createRequire(import.meta.url);

// ───────────────────────── 1. 纯改写：六种写法 ─────────────────────────

type Transform = (this: unknown, code: string, id: string) => Promise<{ code: string } | null>;
const transform = (code: string): Promise<{ code: string } | null> =>
  handlerOf<Transform>(godotInteropPlugin(() => {}).transform).call({}, code, "/virtual/mod.mjs");

describe("godotInteropPlugin：源码改写", () => {
  it("default 导入 → 裸 require", async () => {
    const out = await transform(`import godot from "godot";\nexport const c = godot.ClassDB;\n`);
    expect(out?.code).toContain(`const godot = require("godot");`);
    expect(out?.code).not.toContain("import");
  });

  it("default + 具名混写 → 具名留给打包器，default 换 require", async () => {
    const out = await transform(
      `import godot, { ClassDB, Label } from "godot";\nexport const c = [godot, ClassDB, Label];\n`,
    );
    // 花括号必须成对保留（只覆盖说明符区间会将 { 吃掉而留下 }）
    expect(out?.code).toContain(`import { ClassDB, Label } from "godot";`);
    expect(out?.code).toContain(`const godot = require("godot");`);
    expect(out?.code).not.toMatch(/import\s+\w+,/);
  });

  it("namespace 导入 → 裸 require", async () => {
    const out = await transform(`import * as godot from "godot";\nexport const c = godot.Vector2;\n`);
    expect(out?.code).toContain(`const godot = require("godot");`);
  });

  it("跨行写法会被归一成单行（整句重写的已知代价）", async () => {
    const out = await transform(
      `import godot, {\n  ClassDB,\n  Color,\n} from "godot";\nexport const c = [godot, ClassDB, Color];\n`,
    );
    expect(out?.code).toContain(`import { ClassDB, Color } from "godot";`);
    expect(out?.code).toContain(`const godot = require("godot");`);
  });

  it("纯具名导入不动（那条路本来就是对的）", async () => {
    expect(await transform(`import { ClassDB } from "godot";\nexport const c = ClassDB;\n`)).toBeNull();
  });

  it("混写：别名保留，不残留 default 说明符或孤逗号", async () => {
    const out = await transform(
      `import godot, {\n  ClassDB as DB,\n} from "godot";\nexport const c = [godot, DB];\n`,
    );
    // 说明符是按原文切片取回的，`a as b` 这种别名不会丢失
    expect(out?.code).toContain("ClassDB as DB");
    expect(out?.code).toContain(`const godot = require("godot");`);
    // 已清理完全：不应再残留 default 说明符或孤逗号
    expect(out?.code).not.toMatch(/import\s+godot\s*,/);
    expect(out?.code).not.toMatch(/import\s+,/);
    // 已知代价：整句重写会将花括号内的注释与换行归一。需要固定这一点；
    //   只固定“重写后语法合法且语义不变”——那才是本插件真正要保证的。
    const { parseSync } = await import("@babel/core");
    expect(() => parseSync(out!.code, { configFile: false, babelrc: false, sourceType: "module" })).not.toThrow();
  });

  it("default 与具名分成两句时，具名那句完全不受影响", async () => {
    const out = await transform(
      `import godot from "godot";\nimport { ClassDB } from "godot";\nexport const c = [godot, ClassDB];\n`,
    );
    expect(out?.code).toContain(`import { ClassDB } from "godot";`);
    expect(out?.code).toContain(`const godot = require("godot");`);
  });

  it("default + namespace 同时出现 → 两个 const，整句消失", async () => {
    const out = await transform(`import godot, * as ns from "godot";\nexport const c = [godot, ns];\n`);
    expect(out?.code).toContain(`const godot = require("godot");`);
    expect(out?.code).toContain(`const ns = require("godot");`);
    expect(out?.code).not.toContain("import");
  });

  it("不碰别的模块", async () => {
    expect(await transform(`import fs from "node:fs";\nexport const c = fs;\n`)).toBeNull();
  });
});

// ───────────────── 2. 真构建：产物里不该有 godot 的 interop ─────────────────

/**
 * 构造一个“default 与具名共处一个 chunk”的工程——这正是问题发生的前提。
 * lib.mjs 使用 default，main.ts 使用具名，单入口因此两者必然合入同一个产物。
 */
function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "godot-interop-"));
  writeFileSync(
    join(root, "lib.mjs"),
    `import godot from "godot";\n` +
      `export function cls(name) { return godot[name]; }\n`,
  );
  writeFileSync(
    join(root, "main.ts"),
    `import { Label } from "godot";\n` +
      `import { cls } from "./lib.mjs";\n` +
      `export const named = Label;\n` +
      `export const viaDefault = cls("Label");\n`,
  );
  return root;
}

async function buildFixture(root: string, withPlugin: boolean, entry = "main"): Promise<string> {
  await build({
    root,
    logLevel: "silent",
    build: {
      outDir: "out",
      emptyOutDir: true,
      minify: false,
      rollupOptions: {
        input: { [entry]: join(root, `${entry}.ts`) },
        preserveEntrySignatures: "strict",
        // 与 build-core 的产物契约一致：CJS + godot 外部
        external: (id: string) => id === "godot" || id.startsWith("godot/"),
        output: { format: "cjs", exports: "named", entryFileNames: "[name].js" },
      },
    },
    plugins: withPlugin ? [godotInteropPlugin(() => {})] : [],
  });
  return readFileSync(join(root, "out", `${entry}.js`), "utf8");
}

describe("godotInteropPlugin：产物形态", () => {
  it("不开插件时确实会冒出 __toESM 包装（前提成立）", async () => {
    const root = makeFixture();
    try {
      const code = await buildFixture(root, false);
      expect(code).toMatch(/__toESM\(/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("开插件后产物里不再有 godot 的 interop 包装", async () => {
    const root = makeFixture();
    try {
      const code = await buildFixture(root, true);
      expect(code).not.toMatch(/__toESM\(\s*godot/);
      expect(code).toContain(`require("godot")`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it(".ts 导入方（无 package.json type）也不漏：那是“加载即抛”的变体", async () => {
    // isNodeMode 仅在导入方是无歧义 ESM（.mjs / type:module）时才传 1。
    // .ts 且无 type 时不传，__toESM 会去读取 `mod.__esModule`——引擎的 godot
    // 是“获取不到的类名直接抛异常”的 Proxy，模块**加载即失败**。
    // 本 fixture 的 default 导入在 .mjs 中，此处单独构造一个 .ts 版本。
    const root = mkdtempSync(join(tmpdir(), "godot-interop-ts-"));
    writeFileSync(join(root, "lib.ts"), `import godot from "godot";\nexport const cls = (n: string) => (godot as any)[n];\n`);
    writeFileSync(join(root, "main.ts"), `import { Label } from "godot";\nimport { cls } from "./lib";\nexport const named = Label;\nexport const viaDefault = cls("Label");\n`);
    try {
      const code = await buildFixture(root, true, "main");
      expect(code).not.toMatch(/__toESM\(\s*godot/);
      expect(code).toContain(`require("godot")`);
      // 对照组：未启用插件时，此处会出现**不带 `, 1`** 的包装（真实引擎中就是加载即抛）
      const off = await buildFixture(root, false, "main");
      expect(off).toMatch(/__toESM\(godot\)/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ───────────── 3. 真跑产物：用 Proxy 冒充引擎的 godot 模块 ─────────────

/**
 * 引擎的 `godot` 模块形状：类名依靠 get 陷阱动态提供，**不可枚举**。
 * ownKeys 返回空 = `Object.getOwnPropertyNames` 无法获取内容，这正是 `__toESM`
 * 将其拷空的原因，也是本测试能够复现该缺陷的关键。
 */
const GODOT_STUB = `
module.exports = new Proxy({}, {
  get(_t, key) {
    if (typeof key !== "string") return undefined;
    return function GodotClass() { return { name: key }; };
  },
  ownKeys() { return []; },
  getOwnPropertyDescriptor() { return undefined; },
  has() { return true; },
});
`;

async function runBuilt(withPlugin: boolean): Promise<{ named: unknown; viaDefault: unknown }> {
  const root = makeFixture();
  try {
    mkdirSync(join(root, "node_modules", "godot"), { recursive: true });
    writeFileSync(join(root, "node_modules", "godot", "index.js"), GODOT_STUB);
    await buildFixture(root, withPlugin);
    // 产物是 CJS，直接 require 引入并真实执行一遍
    return nodeRequire(join(root, "out", "main.js")) as { named: unknown; viaDefault: unknown };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("godotInteropPlugin：产物在 Proxy 形态的 godot 上真能跑", () => {
  it("不开插件：具名用法被 interop 拷空（复现线上故障）", async () => {
    const out = await runBuilt(false);
    // 受影响的正是**具名**：共享绑定被替换为包装，而包装上未拷到类。
    // 而 default 用法（godot.default[k]）反而无碍——__toESM 将原始 Proxy
    // 原样挂在 .default 上。因此“default 本身可用”为真，“将同 chunk
    // 的具名用法带入错误”也为真，两句并不矛盾。
    expect(out.named).toBeUndefined();
    expect(typeof out.viaDefault).toBe("function");
  });

  it("开插件：default 与具名都拿得到类", async () => {
    const out = await runBuilt(true);
    expect(typeof out.named).toBe("function");
    expect(typeof out.viaDefault).toBe("function");
  });
});
