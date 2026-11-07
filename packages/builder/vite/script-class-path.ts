/**
 * GodotJS 把"编译产物放在哪"写死在引擎里（不是 ProjectSettings，改不了）：
 * `new` 一个脚本类时，引擎拿这个前缀把产物的路径（本仓库产出的都是 `.mjs`）反推成 `.ts`
 * 源码路径去加载。
 * 路径不以它开头时，editor / debug 构建直接 CRASH（断言 jsb_checkf 在 debug 下展开成
 * CRASH_COND_MSG，只有 release 才是空操作）。
 *
 * 所以要 `new` 的脚本类，产物必须落在 `res://.godot/GodotJS/` 下并保留源码相对路径。
 * 不受这条约束的是库代码、共享 chunk、以及 `.tscn` 直接引用的脚本入口——引擎只在脚本类
 * 实例化与继承解析时走反推。
 *
 * 引擎那两个容易踩的细节：扩展名长度含点，所以 `.cjs` / `.mjs` 切 4 个字符而 `.js` 切 3 个；
 * 前缀判断用 String::begins_with 纯前缀比较，`GodotJSx` 这种近似目录名也算命中。
 *
 * 出处：internal/jsb_settings.cpp `get_jsb_out_res_path()`、internal/jsb_path_util.cpp
 * `convert_javascript_path()`、bridge/jsb_class_info.cpp `ScriptClassInfo::instantiate()`。
 */

/** 引擎硬编码的产物目录（相对 workspaceRoot，也就是 Godot 工程根）。 */
export const GODOTJS_OUT_DIR = ".godot/GodotJS";

/** `GODOTJS_OUT_DIR` 对应的 res:// 前缀。 */
export const GODOTJS_OUT_RES_ROOT = "res://" + GODOTJS_OUT_DIR;

/**
 * 脚本类产物在 vite outDir（= outputPath）里的临时落地点：rollup 的 entryFileNames 不允许
 * `../`，产物写不到 outDir 外面，所以先落这里，构建完由 scriptClassMovePlugin 搬走。
 */
export const SC_STAGING_DIR = ".sc-staging";

/**
 * 脚本类入口的产物名：源码相对 workspaceRoot 的路径去掉扩展名。
 * 不让配置参与是因为引擎按"产物路径去掉约定目录前缀"反推源码，名字必须等于源码相对路径。
 */
export function scriptClassEntryName(relFromWorkspace: string): string {
  return relFromWorkspace.replace(/\\/g, "/").replace(/\.(ts|cts|mts)$/, "");
}
