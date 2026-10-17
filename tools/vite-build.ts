import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, type InlineConfig } from "vite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "packages/builder");
const OUT = path.join(ROOT, "dist/builder");

/** 每个 .ts 都是一个入口（preserveModules 下产物与源码一比一） */
function collectEntries(): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
        const rel = path.relative(SRC, p).replace(/\\/g, "/").replace(/\.ts$/, "");
        // spec 不进入发布物：它们属于仓库自身的测试，不是 builder 的组成部分
        if (!rel.includes("/test/")) entries[rel] = p;
      }
    }
  };
  walk(SRC);
  if (!Object.keys(entries).length) throw new Error("未找到任何入口");
  return entries;
}

/**
 * 依赖保持外部的两条规则：裸标识符一律 external（builder 是 Node 侧代码）；指向 `.mjs`
 * 的相对路径也保持外部——vitest builder 使用非字面量 specifier 运行时加载宿主插件，
 * 那条路径必须在产物中真实存在。
 *
 * 例外仅为 `godot-angular/css`：它被上述规则排除在外，运行时由使用方的
 * node_modules 解析至 ng-packagr 产物，而那份产物中 `ngDevMode` 为自由标识符（ng-packagr
 * 不做 define），在 Node 中 import 当场抛 ReferenceError。现改为内联至 builder 产物，由下方
 * `define` 固定——Node 侧的问题在 Node 的构建配置中解决，不向源码中写入运行期全局赋值。
 */
const BUNDLED_INTO_BUILDER = new Set(["godot-angular/css"]);

/** 上述说明符解析后的实体。external 钩子拿到的可能是绝对路径，也可能是相对形式，
 * 因此按后缀判定，两种形态一并排除（否则它会被改写为 `../dist/…` 并继续作为外部依赖）。 */
const LIBRARY_CSS_SUFFIX = "dist/fesm2022/godot-angular-css.mjs";
const LIBRARY_CSS = path.join(ROOT, "dist", "fesm2022", "godot-angular-css.mjs");

function isExternal(id: string): boolean {
  if (id.startsWith("\0") || id.startsWith("virtual:")) return false;
  if (BUNDLED_INTO_BUILDER.has(id)) return false;
  if (id.replace(/\\/g, "/").endsWith(LIBRARY_CSS_SUFFIX)) return false;
  if (id.startsWith(".") || path.isAbsolute(id)) return id.endsWith(".mjs");
  return true;
}

/** 发布物 bin 指向那个入口（package.json 的 bin 字段），preserveModules 下它的 chunk 名 */
const BIN_CHUNK = "typings-gen/cli";

/**
 * rollup 的 PreRenderedChunk 中使用到的两个字段。
 *
 * 只声明形状而不 import rollup 类型：rollup 是 vite 的传递依赖，未被提升，
 * 直接 `from "rollup"` 等于依赖一个未声明的包。
 */
interface ChunkIdentity {
  name: string;
  isEntry: boolean;
}

const config: InlineConfig = {
  root: ROOT,
  configFile: false,
  publicDir: false,
  logLevel: "warn",
  esbuild: { target: "es2022" },
  // builder 自身处于开发态：样式 lint 的告警必须能被收集，因此固定为 true。
  // 固定定义而非「不定义」：内联进来的 css 代码中不得残留自由标识符，否则在 Node 中一经读取即抛异常。
  define: { ngDevMode: "true" },
  plugins: [
    {
      // 将 `godot-angular/css` 指向发布物本体并内联进来。必须经由插件的 resolveId：
      // builder 的 tsconfig 将该说明符指向 dist/types/*.d.ts（供类型检查使用），
      // 其优先级高于 resolve.alias，实测 alias 无法生效。
      name: "bundle-library-css",
      resolveId: (id: string) => {
        if (id !== "godot-angular/css") return null;
        if (!existsSync(LIBRARY_CSS))
          throw new Error(`未找到 ${path.relative(ROOT, LIBRARY_CSS)}，请先执行 pnpm build:lib`);
        return LIBRARY_CSS;
      },
    },
  ],
  build: {
    outDir: OUT,
    // 产物目录由下方 rmSync 统一清理，此处不重复
    emptyOutDir: false,
    target: "node20",
    minify: false,
    sourcemap: false,
    reportCompressedSize: false,
    lib: {
      entry: collectEntries(),
      formats: ["es"],
      fileName: (_f: string, name: string) => `${name}.mjs`,
    },
    rollupOptions: {
      external: (id: string) => isExternal(id),
      output: {
        preserveModules: true,
        preserveModulesRoot: SRC,
        entryFileNames: "[name].mjs",
        chunkFileNames: "[name].mjs",
        // bin 入口需要 shebang（npm 将 bin 直接交给 shell 执行，源码中的 #! 会被 vite 丢弃）。
        // 不能直接给字符串：preserveModules 下有几十个 chunk，那会给每个产物都写入一份。
        // banner 支持函数形式，按 chunk 名精确命中那一个。
        banner: (chunk: ChunkIdentity) =>
          chunk.isEntry && chunk.name === BIN_CHUNK ? "#!/usr/bin/env node" : "",
      },
    },
  },
};

function run(cmd: string, args: string[], label: string): void {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error(`${label} 失败（退出码 ${r.status}）`);
}

export async function viteBuildAll(): Promise<void> {
  const started = Date.now();
  const tsc = path.join(ROOT, "node_modules", ".bin", "tsc");
  if (!existsSync(tsc)) throw new Error("未找到 node_modules/.bin/tsc，请先执行 pnpm install");

  rmSync(OUT, { recursive: true, force: true });
  const t0 = Date.now();
  await build(config);
  console.log(`vite builder -> ${path.relative(ROOT, OUT)} (${Date.now() - t0}ms)`);

  // 类型 + 声明（vite 只转译不检查，类型不通过必须在此处失败）
  run(tsc, ["-p", "packages/builder/tsconfig.json"], "tsc");

  // builders.json 必须落在 dist/builder/，因为 package.json 的 builders 字段指的就是那里。
  copyFileSync(path.join(SRC, "builders.json"), path.join(OUT, "builders.json"));

  console.log(`builder 构建完成：${Date.now() - started}ms`);
}

const self = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (fileURLToPath(import.meta.url) === self) {
  viteBuildAll().catch((e: unknown) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exitCode = 1;
  });
}
