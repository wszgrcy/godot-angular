/** 插桩代码写入计数所用的全局名：`globalThis[CUJ_COVERAGE_KEY]`。 */
export const CUJ_COVERAGE_KEY = "__CUJ_COVERAGE__";

/**
 * builder 与宿主侧 coverage provider 之间的配置通道。
 *
 * provider 由 vitest 的 module runner 加载，与 builder 不属于同一个模块实例，闭包无法共享；
 * 环境变量是同进程内最直接的传递方式（不写文件，也不产生临时文件）。
 */
export const COVERAGE_ENV = {
  /** remap 的写入根路径：发布物 source map 中回指 `packages/**` 的根路径。 */
  sourceRoot: "CUJ_COVERAGE_SOURCE_ROOT",
  /** include / exclude 的相对基准，与 vitest 一致，为工作区根目录（angular.json 所在目录）。 */
  workspaceRoot: "CUJ_COVERAGE_WORKSPACE_ROOT",
  include: "CUJ_COVERAGE_INCLUDE",
  exclude: "CUJ_COVERAGE_EXCLUDE",
} as const;

/**
 * 插桩发布物（`node_modules/godot-angular/fesm2022/`）的开关，默认关闭，仅接受取值 `1`。
 *
 * 该开关服务于本库自身的开发场景：test-app 只使用发布物，报告口径应当是
 * “用户实际运行的那一份代码”。外部用户安装发布物后手上并没有库源码，插桩它
 * 只能得到一份关于 `.mjs` 的报告，同时使产物变大（实测引擎入口目录 3.14MB → 4.39MB）。
 * 因此缺省只插桩 `coverage.instrument` 中显式列出的文件（用户自己的代码），
 * 库开发时再显式打开本变量。
 *
 * 仅供内部使用，因此不做 “1/true/on 均视为开启” 的宽容解析：写法不符即视为未开启。
 */
export const COVERAGE_PACKAGE_ENV = "CUJ_COVERAGE_PACKAGE";

/** 上述开关的启用值，仅接受这一种写法。 */
export const COVERAGE_PACKAGE_ON = "1";
