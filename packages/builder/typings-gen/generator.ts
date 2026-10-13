import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { requireGodotBin } from "../shared/godot-bin";

/** 一个待写入的文件：path 相对输出目录 */
export interface TypingsFile {
  path: string;
  content: string;
}

export interface GodotTypingsBundle {
  /** 引擎 banner 中的版本号，写入产物头部作为来源戳 */
  engine: string;
  files: TypingsFile[];
}

export interface CollectOptions {
  /** 定位引擎二进制用的工作区根 */
  workspaceRoot: string;
  /** 显式二进制路径（文件或按 bin/<平台目录>/ 布局的目录）；未传入则按 GODOT_BIN / 工作区 bin/ 查找 */
  godotBin?: string;
  log?: (msg: string) => void;
}

export interface GenerateOptions extends CollectOptions {
  /** 输出目录（相对路径按 workspaceRoot 解析）。每个目录都会得完整一套 */
  outDirs: string[];
}

export interface GenerateResult {
  engine: string;
  outDirs: string[];
  fileCount: number;
}

/**
 * 生成类型的缺口补丁（手写，与生成物放在一起，因为输出目录每次整体重写）。
 * 生成的 `Node` 类未声明运行时真实存在的 `name`，不补充则所有 `node.name = "x"` 报 TS2339。
 * 若引擎声明已包含 `name`，这里会变成重复声明报错。
 */
const GAP_PATCH = `/** 由 godot-angular 的 typings 生成器写入（手写内容，不是引擎生成的）。勿直接改生成目录。 */
declare module "godot" {
  interface Node<Map extends NodePathMap = any> {
    name: string;
  }
}
`;

/** @types 风格入口所在的子目录名，也是 tsconfig types: [...] 中那个名字 */
export const ENTRY_DIR = "godot";

/** Godot 依靠这个空文件将目录排除在资源导入之外；同时作为「这是生成目录」的标记 */
export const GDIGNORE = ".gdignore";

/**
 * @types 风格入口。库侧 tsconfig 使用 `typeRoots` + `types: ["godot"]` 命中
 * `<输出目录>/godot/index.d.ts`，其余文件靠三重斜杠串联——因此源文件中不必再写
 * `/// <reference path=...>`，`import type { X } from "godot"` 开箱即用。
 */
function entryFile(files: readonly string[], engine: string): TypingsFile {
  const lines = [
    "/**",
    ` * 由 godot-angular 的 typings 生成器生成，勿手改。（引擎 ${engine}）`,
    " *",
    " * 三重斜杠把全套串起来：谁命中本文件，谁就拿到整套引擎声明。",
    " */",
    ...files.map((f) => `/// <reference path="../${f}" />`),
    `/// <reference path="../godot.gap-patch.d.ts" />`,
    "",
  ];
  return { path: `${ENTRY_DIR}/index.d.ts`, content: lines.join("\n") };
}

/** 从引擎 banner 中提取版本（GodotJS 的 Engine 单例未编入 get_version_string） */
function engineVersion(stdout: string): string {
  const banner = /Godot Engine (\S+)/.exec(stdout);
  return banner ? banner[1] : "unknown";
}

/**
 * 运行一次引擎，将全套 .d.ts 读回，**不落盘**。
 *
 * 分为两步是为了使“生成”与“重写目录”各自可测：写盘需要整目录删除，使用真实引擎产物
 * 测试它得先运行一次引擎，而 collect 阶段纯读临时目录，成本低且无副作用。
 */
export function collectGodotTypings(options: CollectOptions): GodotTypingsBundle {
  const log = options.log ?? ((m: string) => console.log(m));
  const bin = requireGodotBin(options.workspaceRoot, options.godotBin);

  // 临时工程：--generate-types 是“给这个项目生成”，因此必须有个可指向的 project.godot。
  const scratch = mkdtempSync(join(tmpdir(), "godot-typings-"));
  try {
    writeFileSync(
      join(scratch, "project.godot"),
      'config_version=5\n\n[application]\nconfig/name="typings-gen"\n',
    );

    log(`[typings] ${bin} --headless --editor --generate-types`);
    const run = spawnSync(bin, ["--headless", "--editor", "--path", scratch, "--generate-types"], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    if (run.status !== 0) {
      throw new Error(
        `--generate-types 失败（退出码 ${run.status}）\n${run.stdout ?? ""}\n${run.stderr ?? ""}`,
      );
    }

    const src = join(scratch, "typings");
    const files = readdirSync(src)
      .filter((f) => f.endsWith(".d.ts"))
      .sort();
    if (files.length === 0)
      throw new Error(`引擎未报错，但 ${src} 中不存在 .d.ts 文件`);

    const engine = engineVersion(`${run.stdout ?? ""}\n${run.stderr ?? ""}`);
    return {
      engine,
      files: [
        ...files.map((f) => ({ path: f, content: readFileSync(join(src, f), "utf8") })),
        { path: "godot.gap-patch.d.ts", content: GAP_PATCH },
        entryFile(files, engine),
      ],
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** 一行产物摘要 */
export function describeOutput(root: string, bundle: GodotTypingsBundle): string {
  return `  ${root}  ${bundle.files.length} 个文件（引擎 ${bundle.engine}）`;
}

/**
 * 判断该目录是否为本生成器自身的输出。
 *
 * 重写会整目录删除，因此必须能证明「要删除的确实是生成目录」。判据使用 .gdignore
 * （生成器自身写入）+ 至少一个 *.gen.d.ts（引擎产物）：两者同时命中才放行。
 * 缺少这一道判断，输出路径写错就会将源码目录一并删除。
 */
function looksLikeTypingsDir(outDir: string): boolean {
  if (!existsSync(outDir)) return true; // 尚不存在，无需删除
  if (!existsSync(join(outDir, GDIGNORE))) return false;
  try {
    return readdirSync(outDir).some((f) => f.endsWith(".gen.d.ts"));
  } catch {
    return false;
  }
}

/**
 * 输出目录的安全判据，共两道，缺一不可：
 *
 * 1. 不能是根目录——删除它等于删除整个工程。这一道必须先走：
 *    looksLikeTypingsDir 对「没有 .gdignore」的目录给出的是通用理由，对 `/` 会给出
 *    一个不精确的提示。
 * 2. 必须是本生成器自身的输出（见 looksLikeTypingsDir）。
 *
 * 重写是整目录删除，路径写错时这两道就是唯一阻止灾难的位置。
 */
function assertWritableTypingsDir(outDir: string): void {
  if (!outDir || outDir === "/" || outDir === ".") {
    throw new Error(
      `拒绝写入 "${outDir}"：该路径指向根目录，重写会波及整个工程。` +
        `输出路径应为 .../typings 这类专用目录。`,
    );
  }
  if (looksLikeTypingsDir(outDir)) return;
  throw new Error(
    `拒绝写入 ${outDir}：该目录不是 typings 生成目录（缺少 ${GDIGNORE} 或 *.gen.d.ts），` +
      `而重写会删除整个目录。输出路径应为 .../typings 这类专用目录。`,
  );
}

/**
 * 整体重写一个输出目录：清目录 → 写全套 → 补 .gdignore。
 *
 * 先清理，避免旧残留的 .d.ts 继续参与编译。守卫见 assertWritableTypingsDir，
 * 必须发生在删除之前。
 */
export function writeTypingsBundle(outDir: string, bundle: GodotTypingsBundle): void {
  assertWritableTypingsDir(outDir);
  rmSync(outDir, { recursive: true, force: true });
  for (const file of bundle.files) {
    const dest = join(outDir, file.path);
    mkdirSync(dirname(dest), { recursive: true }); // godot/index.d.ts 在子目录里
    writeFileSync(dest, file.content);
  }
  // 既是 Godot 排除资源导入的开关，也是 looksLikeTypingsDir 的判据之一，遗漏就等于埋下隐患
  writeFileSync(join(outDir, GDIGNORE), "");
}

/** 生成 + 写入每个 outDir。outDirs 中的相对路径按 workspaceRoot 解析 */
export function generateGodotTypings(options: GenerateOptions): GenerateResult {
  if (options.outDirs.length === 0)
    throw new Error("outDirs 为空：至少需要指定一个输出目录");
  const outDirs = options.outDirs.map((dir) => resolveUnder(options.workspaceRoot, dir));
  // 先将输出目录全部验一遍再去运行引擎：路径写错时不应白花十几秒引擎时间才发现。
  // writeTypingsBundle 内还有同一道判据，因为它可以被单独调用。
  for (const dir of outDirs) assertWritableTypingsDir(dir);

  const bundle = collectGodotTypings(options);
  for (const dir of outDirs) {
    writeTypingsBundle(dir, bundle);
    options.log?.(describeOutput(dir, bundle));
  }
  return { engine: bundle.engine, outDirs, fileCount: bundle.files.length };
}

/** 相对路径按 workspaceRoot 解析，不按进程 CWD：否则从子目录执行 ng 就会指向错误位置 */
export function resolveUnder(root: string, p: string): string {
  return /^[A-Za-z]:[\\/]|^[\\/]/.test(p) ? p : join(root, p);
}

/**
 * 工作区根：ng / npx 都可能从子目录运行，因此从 cwd 向上查找 angular.json / project.godot。
 * 仅用于定位引擎二进制（bin/ 在工作区根），与输出路径如何解析无关。
 */
export function findWorkspaceRoot(from: string): string {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, "angular.json")) || existsSync(join(dir, "project.godot"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return from;
    dir = parent;
  }
}

/** 输出目录中是否已有一套可用的 typings（用于判断是否需要重跑引擎） */
export function hasTypings(outDir: string): boolean {
  return existsSync(join(outDir, ENTRY_DIR, "index.d.ts"));
}
