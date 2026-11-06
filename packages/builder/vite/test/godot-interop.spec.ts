import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { godotInteropPlugin } from "../godot-interop";
import { handlerOf } from "./hook";

// ───────────────────────── 1. 纯改写：各种写法 ─────────────────────────

type Transform = (this: unknown, code: string, id: string) => Promise<{ code: string } | null>;
const transform = (code: string): Promise<{ code: string } | null> =>
  handlerOf<Transform>(godotInteropPlugin(() => {}).transform).call({}, code, "/virtual/mod.mjs");

describe("godotInteropPlugin：源码改写", () => {
  it("default 导入 → 整体取模块", async () => {
    const out = await transform(`import godot from "godot";\nexport const c = godot.ClassDB;\n`);
    expect(out?.code).toContain(`import __gd$0 from "godot";`);
    expect(out?.code).toContain(`const godot = __gd$0;`);
  });

  it("default + 具名混写 → 具名改成点属性", async () => {
    const out = await transform(
      `import godot, { ClassDB, Label } from "godot";\nexport const c = [godot, ClassDB, Label];\n`,
    );
    expect(out?.code).toContain(`import __gd$0 from "godot";`);
    expect(out?.code).toContain(`const godot = __gd$0;`);
    expect(out?.code).toContain(`const ClassDB = __gd$0.ClassDB;`);
    expect(out?.code).toContain(`const Label = __gd$0.Label;`);
    // 具名 import 必须彻底消失：引擎的 godot 列不出自有属性，留着会在链接期失败
    expect(out?.code).not.toMatch(/import\s*\{/);
  });

  it("namespace 导入 → 同样等于模块本身（命名空间对象上只有 default）", async () => {
    const out = await transform(`import * as godot from "godot";\nexport const c = godot.Vector2;`);
    expect(out?.code).toContain(`const godot = __gd$0;`);
  });

  it("纯具名导入也要改写（CJS 时代那条路是对的，ESM 下不是）", async () => {
    const out = await transform(`import { ClassDB } from "godot";\nexport const c = ClassDB;`);
    expect(out?.code).toContain(`const ClassDB = __gd$0.ClassDB;`);
  });

  it("跨行写法会被归一成单行（整句重写的已知代价）", async () => {
    const out = await transform(
      `import godot, {\n  ClassDB,\n  Color,\n} from "godot";\nexport const c = [godot, ClassDB, Color];\n`,
    );
    expect(out?.code).toContain(`const ClassDB = __gd$0.ClassDB;`);
    expect(out?.code).toContain(`const Color = __gd$0.Color;`);
  });

  it("别名保留，且重写后仍是合法模块", async () => {
    const out = await transform(
      `import godot, {\n  ClassDB as DB,\n} from "godot";\nexport const c = [godot, DB];\n`,
    );
    expect(out?.code).toContain(`const DB = __gd$0.ClassDB;`);
    expect(out?.code).not.toMatch(/import\s+godot\s*,/);
    const { parseSync } = await import("@babel/core");
    expect(() => parseSync(out!.code, { configFile: false, babelrc: false, sourceType: "module" })).not.toThrow();
  });

  it("字符串导入名走方括号取值", async () => {
    const out = await transform(`import { "not-an-identifier" as odd } from "godot";\nexport const c = odd;`);
    expect(out?.code).toContain(`const odd = __gd$0["not-an-identifier"];`);
  });

  it("同一模块分两句导入时，只引入一次绑定", async () => {
    const out = await transform(
      `import godot from "godot";\nimport { ClassDB } from "godot";\nexport const c = [godot, ClassDB];\n`,
    );
    expect(out?.code.match(/import __gd\$\d+ from "godot";/g)).toHaveLength(1);
    expect(out?.code).toContain(`const ClassDB = __gd$0.ClassDB;`);
  });

  it("两条不同说明符各用各的绑定", async () => {
    const out = await transform(`import a from "godot";\nimport b from "godot/extra";\nexport const c = [a, b];`);
    expect(out?.code).toContain(`import __gd$0 from "godot";`);
    expect(out?.code).toContain(`import __gd$1 from "godot/extra";`);
  });

  it("纯副作用 import 原样保留（无需改写）", async () => {
    expect(await transform(`import "godot";\nexport const c = 1;`)).toBeNull();
  });

  it("不碰别的模块", async () => {
    expect(await transform(`import fs from "node:fs";\nexport const c = fs;`)).toBeNull();
  });
});

// ───────────────── 2. 真构建：产物里不该有 godot 的具名 import ─────────────────

/**
 * 构造一个“default 与具名共处一个 chunk”的工程——这正是问题发生的前提。
 * lib.mjs 使用 default，main.ts 使用具名，单入口因此两者必然合入同一个产物。
 */
function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "godot-interop-"));
  writeFileSync(
    join(root, "lib.mjs"),
    `import godot from "godot";\n` + `export function cls(name) { return godot[name]; }\n`,
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
        // 与 build-core 的产物契约一致：ESM + godot 外部
        external: (id: string) => id === "godot" || id.startsWith("godot/"),
        output: { format: "es", entryFileNames: "[name].mjs" },
      },
    },
    plugins: withPlugin ? [godotInteropPlugin(() => {})] : [],
  });
  return readFileSync(join(root, "out", `${entry}.mjs`), "utf8");
}

/** 产物里是否残留对 godot 的具名 import——引擎会在链接阶段因此失败 */
const hasNamedGodotImport = (code: string): boolean =>
  /import[^;]*\{[^}]*\}\s*from\s*["']godot["']/.test(code);

describe("godotInteropPlugin：产物形态", () => {
  it("不开插件时产物里确实残留 godot 的具名 import（前提成立）", { timeout: 60_000 }, async () => {
    const root = makeFixture();
    try {
      expect(hasNamedGodotImport(await buildFixture(root, false))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("开插件后产物只剩整体取模块 + 点属性", { timeout: 60_000 }, async () => {
    const root = makeFixture();
    try {
      const code = await buildFixture(root, true);
      expect(hasNamedGodotImport(code)).toBe(false);
      expect(code).toMatch(/import\s+[\w$]+\s+from\s*["']godot["']/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it(".ts 导入方（无 package.json type）也不漏", { timeout: 60_000 }, async () => {
    // 引擎的 godot 是“取不到的类名直接抛异常”的 Proxy，具名 import 在链接期就失败，
    // 与导入方是 .ts 还是 .mjs 无关。此处单独构造一个 .ts 版本确认改写没有漏。
    const root = mkdtempSync(join(tmpdir(), "godot-interop-ts-"));
    writeFileSync(
      join(root, "lib.ts"),
      `import godot from "godot";\nexport const cls = (n: string) => (godot as any)[n];\n`,
    );
    writeFileSync(
      join(root, "main.ts"),
      `import { Label } from "godot";\nimport { cls } from "./lib";\nexport const named = Label;\nexport const viaDefault = cls("Label");\n`,
    );
    try {
      expect(hasNamedGodotImport(await buildFixture(root, true, "main"))).toBe(false);
      expect(hasNamedGodotImport(await buildFixture(root, false, "main"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ───────────── 3. 真跑产物：用 Proxy 冒充引擎的 godot 模块 ─────────────

/**
 * 引擎的 `godot` 模块形状：类名依靠 get 陷阱动态提供，**不可枚举**。
 * ownKeys 返回空 = 列不出自有属性，这正是具名 import 在链接期失败的原因，
 * 也是本测试能够复现该缺陷的关键（Node 对 CJS 具名导入同样依赖可枚举性）。
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

/**
 * 在子进程里加载产物。vitest 会拦截测试内的动态 `import()` 并用自己的模块流水线重跑一遍，
 * `godot` 这种外部说明符会被它卡住；开个子进程反而更接近引擎“单独一个 realm 加载模块”的真实情形。
 */
function loadInChild(root: string): { named?: string; viaDefault?: string; error?: string } {
  const runner = join(root, "run.mjs");
  writeFileSync(
    runner,
    `try {\n` +
      `  const m = await import(new URL("./out/main.mjs", import.meta.url).href);\n` +
      `  console.log(JSON.stringify({ named: typeof m.named, viaDefault: typeof m.viaDefault }));\n` +
      `} catch (e) {\n` +
      `  console.log(JSON.stringify({ error: e.constructor.name + ": " + e.message }));\n` +
      `}\n`,
  );
  const stdout = execFileSync(process.execPath, [runner], { cwd: root, encoding: "utf8" });
  return JSON.parse(stdout.trim()) as { named?: string; viaDefault?: string; error?: string };
}

async function runBuilt(withPlugin: boolean): Promise<{ named?: string; viaDefault?: string; error?: string }> {
  const root = makeFixture();
  try {
    mkdirSync(join(root, "node_modules", "godot"), { recursive: true });
    writeFileSync(join(root, "node_modules", "godot", "index.js"), GODOT_STUB);
    await buildFixture(root, withPlugin);
    return loadInChild(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("godotInteropPlugin：产物在 Proxy 形态的 godot 上真能跑", () => {
  it("不开插件：具名 import 在链接阶段就失败（复现线上故障）", { timeout: 60_000 }, async () => {
    const out = await runBuilt(false);
    expect(out.error).toMatch(/Named export .* not found|does not provide an export named|No matching export/);
  });

  it("开插件：default 与具名都拿得到类", { timeout: 60_000 }, async () => {
    const out = await runBuilt(true);
    expect(out.error).toBeUndefined();
    expect(out.named).toBe("function");
    expect(out.viaDefault).toBe("function");
  });
});
