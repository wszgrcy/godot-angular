import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(toolsDir, "..");

const BIN_TABLE: Record<string, { dir: string; exe: string }> = {
  "linux-x64": { dir: "linux-editor-4.6.1-v8", exe: "godot.linuxbsd.editor.x86_64" },
  "win32-x64": { dir: "windows-editor-4.6.1-v8", exe: "godot.windows.editor.x86_64.exe" },
};

function resolveBin(): string {
  const fromEnv = process.env.GODOT_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const hit = BIN_TABLE[`${process.platform}-${process.arch}`];
  if (!hit)
    throw new Error(`未预置 ${process.platform}-${process.arch} 的二进制表项，请通过 GODOT_BIN 指定`);
  const candidate = join(repoRoot, "bin", hit.dir, hit.exe);
  if (!existsSync(candidate))
    throw new Error(`未找到引擎二进制：${candidate}（或通过 GODOT_BIN 指定）`);
  return candidate;
}

const PROBE_JS = "cuj_vocabulary_probe.js";
const PROBE_TSCN = "cuj_vocabulary_probe.tscn";

function run(bin: string, args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync(bin, ["--headless", "--path", "demo", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: result.status, stdout: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function extractJson(stdout: string): unknown {
  const lines = stdout.split("\n");
  const start = lines.findIndex((line) => line.includes("<<<CUJ_VOCABULARY>>>"));
  const end = lines.findIndex((line) => line.includes("<<<END_CUJ_VOCABULARY>>>"));
  if (start === -1 || end === -1 || end <= start + 1) {
    throw new Error(`探针未输出词汇表。原始输出：\n${stdout.slice(-2000)}`);
  }
  // 引擎的 console.log 每行都带 `[JS] ` 前缀，提取后需要剔除
  const payload = lines[start + 1].replace(/^\s*\[JS\]\s*/, "").trim();
  return JSON.parse(payload);
}

function main(): void {
  const bin = resolveBin();
  const demoDir = join(repoRoot, "demo");

  copyFileSync(join(toolsDir, "vocabulary-probe.js"), join(demoDir, PROBE_JS));
  copyFileSync(join(toolsDir, "vocabulary-probe.tscn"), join(demoDir, PROBE_TSCN));

  try {
    run(bin, ["--import"]);
    const { stdout } = run(bin, [`res://${PROBE_TSCN}`, "--quit-after", "200"]);
    const payload = extractJson(stdout) as {
      engine: string;
      fallbackFontSize: number;
      classes: Record<string, { styleboxes: string[]; colors: string[]; constants: string[]; fontSizes: string[] }>;
      parents: Record<string, string>;
    };
    // GodotJS 的 Engine 单例未编入 get_version_string，引擎自身输出的 banner 才是事实来源
    if (!payload.engine || payload.engine === "unknown") {
      const banner = /Godot Engine (\S+)/.exec(stdout);
      payload.engine = banner ? banner[1] : "unknown";
    }

    const classCount = Object.keys(payload.classes).length;
    const out = join(repoRoot, "packages/css/vocabulary.data.ts");
    writeFileSync(
      out,
      `/**
 * 由 \`pnpm dump:vocabulary\` 生成，**不要手改**。
 *
 * 来源：\`${payload.engine}\` 的 ThemeDB.get_default_theme()。
 * 词汇表必须来自默认主题 —— 从自定义 Theme 取会拿到空表（前提 C7）。
 * 引擎侧有一条断言现算一遍跟这份对账（test-app 的 vocabulary.spec.ts）。
 */
export const VOCABULARY_DATA = ${JSON.stringify(payload, null, 0)} as const;

export const VOCABULARY_META = {
  engine: ${JSON.stringify(payload.engine)},
  fallbackFontSize: ${payload.fallbackFontSize},
  classCount: ${classCount},
} as const;
`,
      "utf8",
    );
    console.log(`词汇表已写入 packages/css/vocabulary.data.ts（${classCount} 个类，引擎 ${payload.engine}）`);
  } finally {
    for (const file of [PROBE_JS, PROBE_TSCN, `${PROBE_JS}.uid`, `${PROBE_TSCN}.uid`]) {
      rmSync(join(demoDir, file), { force: true });
    }
  }
}

main();
