import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { isAbsoluteish } from "./path";

/** 平台键（process.platform + process.arch）→ GodotJS release 资产目录 / 可执行文件名 */
const BIN_TABLE: Record<string, { dir: string; exe: string }> = {
  "linux-x64": { dir: "linux-editor-4.6.1-v8", exe: "godot.linuxbsd.editor.x86_64" },
  "win32-x64": { dir: "windows-editor-4.6.1-v8", exe: "godot.windows.editor.x86_64.exe" },
};

export interface BinResolution {
  bin: string | null;
  /** 命中来源，报错时需要说明是从何处找到的 */
  source?: string;
  /** 未找到时，报错中给出的预期位置 */
  expected?: string;
  /** 未找到时，实际查找过的全部路径（仅工作区根一处，不做搜索） */
  searched?: string[];
  key: string;
}

export function resolveGodotBin(workspaceRoot: string, explicit?: string): BinResolution {
  const key = `${process.platform}-${process.arch}`;
  const hit = BIN_TABLE[key];
  const fromEnv = explicit || process.env.GODOT_BIN;
  if (fromEnv) {
    // 相对路径按工程根解析，不按进程 CWD：否则从子目录执行 ng 就会指向错误位置。
    const given = isAbsoluteish(fromEnv) ? fromEnv : resolve(workspaceRoot, fromEnv);
    return { bin: expandBinDir(given, hit), source: "选项 godotBin / 环境变量 GODOT_BIN", key };
  }
  if (!hit) return { bin: null, key };

  // 仅在工作区根内查找 bin/，绝不向上层遍历：向上遍历等于让任意父目录中的同名文件被当作引擎
  // 执行。需要其他位置时使用 godotBin / GODOT_BIN 显式指定（指向目录也可以，见 expandBinDir）。
  const candidate = join(workspaceRoot, "bin", hit.dir, hit.exe);
  if (existsSync(candidate)) return { bin: candidate, source: `bin/ (${key})`, key };
  return { bin: null, expected: candidate, searched: [candidate], key };
}

/**
 * 显式给出的路径若为目录，按 BIN_TABLE 补上平台子目录与文件名；指向文件则原样返回。
 * 目的是使同一份配置在 Linux 与 Windows 上都成立：`engine.godotBin: "../bin"` 即可。
 * 这是声明而不是搜索，路径由配置写定。
 */
function expandBinDir(
  p: string,
  hit: { dir: string; exe: string } | undefined,
): string {
  if (!hit) return p;
  let isDir = false;
  try {
    isDir = statSync(p).isDirectory();
  } catch {
    return p; // 不存在 / 不可读：交由 requireGodotBin 报“路径不存在”
  }
  return isDir ? join(p, hit.dir, hit.exe) : p;
}

/** 找不到则抛异常（builder 内不能调用 process.exit，那会把 CLI 的收尾逻辑一并终止） */
export function requireGodotBin(workspaceRoot: string, explicit?: string): string {
  const found = resolveGodotBin(workspaceRoot, explicit);
  const fail = (msg: string): never => {
    throw new Error(msg);
  };
  if (!found.bin) {
    if (found.expected) {
      const list = (found.searched ?? [found.expected]).map((p) => `  ${p}`).join("\n");
      return fail(
        `未找到 GodotJS 引擎二进制（官方 Godot 无法执行 .js，必须使用 GodotJS 构建版本）。\n` +
          `工作区根：${workspaceRoot}\n已检索位置（仅检索工作区根目录，不向上级目录搜索）：\n${list}\n\n` +
          `请从 https://github.com/godotjs/GodotJS/releases 下载 ${found.key} 的编辑器构建并放置到上述路径，` +
          `或通过选项 godotBin / 环境变量 GODOT_BIN 指定任意位置（可指向可执行文件，` +
          `或指向按 bin/<平台目录>/ 布局的目录）。`,
      );
    }
    const known = Object.entries(BIN_TABLE)
      .map(([k, v]) => `  ${k}  ->  bin/${v.dir}/${v.exe}`)
      .join("\n");
    return fail(
      `当前平台 ${found.key} 未预置引擎二进制。已知映射：\n${known}\n\n` +
        `请通过选项 godotBin 或环境变量 GODOT_BIN 指定引擎路径。`,
    );
  }
  if (!existsSync(found.bin)) return fail(`选项 godotBin 指向的文件不存在：${found.bin}`);
  return found.bin;
}

/** 仅记录入口脚本的戳（bundle 由 require 读取，不走资源缓存） */
function entryHash(projectDir: string): string {
  const hash = createHash("sha256");
  for (const ext of [".js", ".tscn"]) {
    for (const file of readdirSync(projectDir).filter((f) => f.endsWith(ext)).sort()) {
      hash.update(file).update("\0").update(readFileSync(join(projectDir, file))).update("\0");
    }
  }
  return hash.digest("hex");
}

/**
 * 入口脚本发生变化时先执行一次 `--import`。
 *
 * GodotJS 将 .js 作为 Script 资源缓存：修改入口但未执行 --import 时，引擎静默使用旧副本
 *（一行也不输出 + 等待超时，且不报错）。以入口文件哈希作为戳，变化时才补一次 import。
 */
export function ensureImported(projectDir: string, bin: string): void {
  const stampDir = join(projectDir, ".godot");
  if (!existsSync(stampDir)) mkdirSync(stampDir, { recursive: true });
  const stampFile = join(stampDir, "cuj-entry-hash");
  const current = entryHash(projectDir);
  if (existsSync(stampFile) && readFileSync(stampFile, "utf8") === current) return;

  const res = spawnSync(bin, ["--headless", "--path", projectDir, "--import"], {
    stdio: "ignore",
  });
  if (res.status !== 0) {
    throw new Error("执行 --import 刷新资源缓存失败，引擎可能仍在使用旧的脚本副本");
  }
  writeFileSync(stampFile, current);
}
