import * as v from "valibot";

/**
 * `typings` 的选项。命令行与仓库脚本共用这一份形状：
 * 默认值的唯一来源就是此处的 v.optional(…, 默认值)，下游无需再写 `?? 默认值`。
 */
export const typingsOptionsSchema = v.object({
  outDirs: v.optional(
    v.pipe(
      v.array(v.string()),
      v.description(
        "输出目录，相对工作区根；每个目录都会生成完整一套（含 godot/index.d.ts 入口）。" +
          "默认 ./typings —— 即 tsconfig 中 typeRoots 所指向的位置。",
      ),
    ),
    ["typings"],
  ),
  godotBin: v.optional(
    v.pipe(
      v.string(),
      v.description(
        "指定引擎二进制；默认按 GODOT_BIN → <workspaceRoot>/bin/<平台>/ 预置表查找（仅检索工作区根目录，不向上级目录搜索）。" +
          "此处也可以指向一个**目录**：按 bin/<平台目录>/<可执行文件> 布局时，平台子目录与文件名由内置表补齐，" +
          "因此同一份配置在 Linux 与 Windows 上均可使用。",
      ),
    ),
  ),
});

export type RawTypingsOptions = v.InferInput<typeof typingsOptionsSchema>;
export type TypingsOptions = v.InferOutput<typeof typingsOptionsSchema>;
