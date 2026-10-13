import { Command } from "commander";
import { resolve } from "node:path";
import { parseOptions } from "../shared/parse-options";
import { findWorkspaceRoot, generateGodotTypings } from "./generator";
import { typingsOptionsSchema } from "./options";

const OUT_DIRS_HINT =
  "输出目录，可重复（-o a -o b 或 -o a b）。相对路径按当前工作目录解析。默认 ./typings";

const BIN_HINT =
  "引擎二进制（文件或按 bin/<平台目录>/ 布局的目录）。默认按 GODOT_BIN → <工作区根>/bin/<平台>/ 预置表查找";

function buildProgram(): Command {
  const program = new Command();
  program
    .name("godot-typings")
    .description(
      "使用 GodotJS 引擎生成 godot 的 .d.ts。\n\n" +
        '生成后在 tsconfig 中按如下方式接入（作用等同于为 godot 提供 @types）：\n' +
        '  "typeRoots": ["./typings"],\n' +
        '  "types": ["godot"]\n' +
        "此后源文件无需书写 /// <reference>，可直接 import type { Control } from \"godot\"。",
    )
    // 选项名与 options.ts 中的形状对齐（那边叫 outDirs / godotBin），避免多一套词汇
    .option("-o, --out <dir...>", OUT_DIRS_HINT)
    .option("--bin <path>", BIN_HINT)
    .addHelpText(
      "after",
      "\n示例\n" +
        "  godot-typings\n" +
        "  godot-typings -o typings -o ../packages/library/typings\n" +
        "  godot-typings --out ./typings --bin ../bin\n",
    );
  return program;
}

function main(): void {
  // .parse() 必须在 .opts() 之前：未 parse 就 opts，拿到的是空默认值，--help 也不会被处理。
  // commander 自身处理 --help 与未知参数（打印用法并以 1 退出），此处无需重复实现
  const raw = buildProgram().parse().opts<{ out?: string[]; bin?: string }>();
  // --out 按 cwd 解析（命令行直觉：相对于你所在的目录），bin/ 按工作区根查找（从 cwd 向上查找
  // angular.json / project.godot）。两个锚点不同是有意设计，不是遗漏统一。
  const cwd = process.cwd();
  const options = parseOptions(
    typingsOptionsSchema,
    { outDirs: raw.out, godotBin: raw.bin },
    "typings",
  );
  const result = generateGodotTypings({
    workspaceRoot: findWorkspaceRoot(cwd),
    godotBin: options.godotBin,
    outDirs: options.outDirs.map((d) => resolve(cwd, d)),
  });
  console.log(
    `[typings] 引擎 ${result.engine}：${result.fileCount} 个文件 → ${result.outDirs.join("、")}`,
  );
}

try {
  main();
} catch (error) {
  // 生成侧的失败（找不到引擎 / 输出目录不安全）对用户应当是“一句话”，而不是调用栈。
  // 需要栈时使用 CUJ_TYPINGS_STACK=1 重跑。
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  if (process.env.CUJ_TYPINGS_STACK && error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
}
