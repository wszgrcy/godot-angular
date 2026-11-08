/**
 * GodotJS 把"编译产物放在哪"写死在引擎里（不是 ProjectSettings，改不了）：
 * 引擎要 `new` 一个脚本类时，拿这个前缀把产物的路径（本仓库产出的都是 `.mjs`）反推成 `.ts`
 * 源码路径去加载。路径不以它开头时，editor / debug 构建直接 CRASH
 * （断言 jsb_checkf 在 debug 下展开成 CRASH_COND_MSG，只有 release 才是空操作）。
 *
 * 触发反推的是"注册了导出属性的脚本类"所在的模块：引擎要构造一个类默认对象去读导出属性的
 * 默认值（bridge/jsb_environment.cpp `evaluate_default_values` →
 * bridge/jsb_class_info.cpp `ScriptClassInfo::instantiate`）。实测两种挂法都会走这条路：
 * 代码里 `new` 出来的，以及 `.tscn` 里 `script = ExtResource(...)` 直接挂的。只要那个类带
 * 导出属性、产物又在约定目录外，就是硬崩（不是 JS 异常，JS 侧的容错拦不住）。
 *
 * 所以本构建器把**全部**引擎侧产物都落在 `res://.godot/GodotJS/` 下，不再区分
 * "脚本类产物"与"普通产物"——分包时脚本类可能被卷进共享 chunk，区分对待迟早漏。
 *
 * 引擎那两个容易踩的细节：扩展名长度含点，所以 `.cjs` / `.mjs` 切 4 个字符而 `.js` 切 3 个；
 * 前缀判断用 String::begins_with 纯前缀比较，`GodotJSx` 这种近似目录名也算命中。
 *
 * 出处：internal/jsb_settings.cpp `get_jsb_out_res_path()`、internal/jsb_path_util.cpp
 * `convert_javascript_path()`、bridge/jsb_class_info.cpp `ScriptClassInfo::instantiate()`。
 */

/** 引擎硬编码的产物目录（相对 workspaceRoot，也就是 Godot 工程根）。 */
export const GODOTJS_OUT_DIR = ".godot/GodotJS";

/**
 * 校验 `outputPath` 落在引擎约定目录内（等于它，或它的子目录），返回归一化后的相对路径
 * （统一成 /、去掉尾部斜杠）。
 *
 * 放在这里而不是 schema 里，是为了能写清"为什么"：schema 报错只有一行，而这条约束的原因
 * 在引擎源码里，不写出来下一个人只会想把它删掉。
 */
export function assertEngineOutDir(outputPath: string): string {
  const rel = outputPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (rel !== GODOTJS_OUT_DIR && !rel.startsWith(`${GODOTJS_OUT_DIR}/`)) {
    throw new Error(
      `outputPath 必须是 ${GODOTJS_OUT_DIR} 或它的子目录，收到 “${outputPath}”：` +
        "引擎只认这个前缀，产物写到外面时，带导出属性的脚本类一被实例化就让引擎直接崩溃。",
    );
  }
  return rel;
}

/**
 * 脚本类入口的产物名：源码相对 workspaceRoot 的路径去掉扩展名。
 * 不让配置参与是因为引擎按"产物路径去掉约定目录前缀"反推源码，名字必须等于源码相对路径。
 */
export function scriptClassEntryName(relFromWorkspace: string): string {
  return relFromWorkspace.replace(/\\/g, "/").replace(/\.(ts|cts|mts)$/, "");
}
