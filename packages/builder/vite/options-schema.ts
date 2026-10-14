import * as v from "valibot";
import { DEFAULT_ENGINE_PORT } from "../shared/engine-port";

/* ------------------------------------------------------------------ *
 * 子形状
 * ------------------------------------------------------------------ */

/** 官方 `fileReplacements` 的一项 */
export const fileReplacementSchema = v.object({
  replace: v.pipe(v.string(), v.description("被替换的文件（相对 workspaceRoot）。")),
  with: v.pipe(v.string(), v.description("用于替换的目标文件。")),
});

/** 官方 `assetPattern`：字符串等价于 `{ glob }` */
export const assetPatternSchema = v.union([
  v.string(),
  v.looseObject({
    glob: v.pipe(v.string(), v.description("匹配模式。")),
    input: v.optional(
      v.pipe(v.string(), v.description("搜索根目录，相对 workspaceRoot。")),
    ),
    output: v.optional(
      v.pipe(v.string(), v.description("输出子目录，相对 outputPath。")),
    ),
    ignore: v.optional(v.pipe(v.array(v.string()), v.description("排除的 glob。"))),
  }),
]);

/**
 * 官方 `styles` 的一项：字符串等价于 `{ input }`。上游的 `bundleName` / `inject` 故意
 * 不接受（`v.object` 严格，多余键直接报错）——那两个字段描述的是样式进入哪个 HTML 入口，
 * 而 Godot 没有 HTML。
 */
export const styleEntrySchema = v.union([
  v.pipe(v.string(), v.description("全局样式表文件（相对 workspaceRoot）。")),
  v.object({
    input: v.pipe(v.string(), v.description("全局样式表文件（相对 workspaceRoot）。")),
  }),
]);

/**
 * `entries` 的一项。形状故意与 assetPatternSchema 同一套，只是 input 缺省取 glob 自身的
 * 静态前缀而不是 workspaceRoot，因此不复用同一个 schema（否则会把两边的 description 和默认值混在一起）。
 */
export const entryPatternSchema = v.union([
  v.string(),
  v.looseObject({
    glob: v.pipe(v.string(), v.description("入口匹配模式，相对 input（未提供 input 时见下）。")),
    input: v.optional(
      v.pipe(
        v.string(),
        v.description(
          "搜索根目录，相对 workspaceRoot。默认取 glob 中第一个含通配符的段之前的部分，"
            + "因此 \"src/pages/**/*.ts\" 等价于 input=src/pages + glob=**/*.ts。",
        ),
      ),
    ),
    output: v.optional(
      v.pipe(
        v.string(),
        v.description(
          "产物子目录，相对 outputPath。默认直接输出到 outputPath 根目录。"
            + "产物名 = output + 文件相对 input 的路径（去除 .ts），完全由配置决定，不再从匹配结果反推。",
        ),
      ),
    ),
    ignore: v.optional(v.pipe(v.array(v.string()), v.description("排除的 glob。"))),
  }),
]);

/** 体积预算的一项，阈值写法与 type 取值全部对齐 @angular/build */
export const budgetSchema = v.looseObject({
  type: v.pipe(
    v.picklist(["any", "all", "initial", "anyScript", "anyComponentStyle", "bundle"]),
    v.description("预算作用范围。"),
  ),
  name: v.optional(v.pipe(v.string(), v.description("type=bundle 时指定 chunk 名。"))),
  minimumWarning: v.optional(v.string()),
  minimumError: v.optional(v.string()),
  maximumWarning: v.optional(v.string()),
  maximumError: v.optional(v.string()),
});

/** 覆盖率阈值。字段名沿用 vitest 的 coverage.thresholds（数字都是百分比）。 */
export const coverageThresholdsSchema = v.object({
  lines: v.optional(v.pipe(v.number(), v.description("行覆盖率下限（0-100）。"))),
  branches: v.optional(v.pipe(v.number(), v.description("分支覆盖率下限（0-100）。"))),
  functions: v.optional(v.pipe(v.number(), v.description("函数覆盖率下限（0-100）。"))),
  statements: v.optional(v.pipe(v.number(), v.description("语句覆盖率下限（0-100）。"))),
  perFile: v.optional(v.pipe(v.boolean(), v.description("true 表示每个文件都必须达标，而非仅统计总体。"))),
});

/**
 * 引擎测试的覆盖率（vitest builder 专有）。
 *
 * 插桩发生在**构建期**且对象是发布物（`node_modules/godot-angular/fesm2022/*.mjs`），
 * 报告再经产物自带的 source map remap 回源码。因此：`enabled` 开启时不要 `skipBuild`；
 * 而 include/exclude 匹配的是 remap 后的**源码路径**，相对 sourceRoot。
 */
export const coverageOptionsSchema = v.object({
  enabled: v.optional(
    v.pipe(v.boolean(), v.description("启用覆盖率统计。插桩发生在构建期，因此与 skipBuild 互斥。")),
    false,
  ),
  sourceRoot: v.optional(
    v.pipe(
      v.string(),
      v.description(
        "remap 落点，相对 workspaceRoot。发布物中的 source map 记录的是“相对打包时的 dist”，装入 "
          + "node_modules 后无法对应，provider 会在 sourceRoot 下按相同尾部路径查找真实文件。默认 `..`：monorepo 中 "
          + "test-app 的上一级即仓库根，packages/** 位于该处。无源码的外部用户保持默认即可，"
          + "报告会自动改为按发布物生成（而非输出一份空报告）。该选项只影响 remap，不影响 include 的基准。",
      ),
    ),
    "..",
  ),
  include: v.optional(
    v.pipe(
      v.array(v.string()),
      v.description(
        "计入报告的源文件。glob 相对 workspaceRoot（与 vitest 的 coverage.include 同口径），"
          + "匹配工作区外的文件需使用 `../` 前缀，例如 monorepo 中的 `../packages/library/**/*.ts`。"
          + "未配置时仅统计实际执行到的文件；配置后报告只保留范围内实际执行到的文件 —— 一条语句都"
          + "未执行到的文件（未进入 bundle）不会出现在报告中。",
      ),
    ),
  ),
  exclude: v.optional(
    v.pipe(
      v.array(v.string()),
      v.description("从报告中排除的源文件 glob，基准与 include 相同。node_modules 无条件排除，无需书写。"),
    ),
  ),
  instrument: v.optional(
    v.pipe(
      v.array(v.string()),
      v.description(
        "插桩范围的文件 glob（相对 workspaceRoot），如 [\"src/**/*.ts\"]。默认不插桩任何文件。" +
          "只有被插桩的文件才可能出现在 include 结果中 —— 两者需配套配置。",
      ),
    ),
  ),
  reportsDirectory: v.optional(
    v.pipe(v.string(), v.description("报告输出目录，相对 workspaceRoot（沿用 vitest 的 coverage.reportsDirectory）。")),
    "coverage",
  ),
  reporter: v.optional(
    v.pipe(
      v.array(v.string()),
      v.description(
        "istanbul reporter，取值同 vitest 的 coverage.reporter（text / html / text-summary / " +
          "json / json-summary / lcov / clover …）。默认 text + html + text-summary + json-summary。",
      ),
    ),
  ),
  thresholds: v.optional(
    v.pipe(coverageThresholdsSchema, v.description("覆盖率下限，语义与 vitest 相同：报告照常生成，但未达标会使整个 run 的退出码为 1。")),
  ),
  reportOnFailure: v.optional(
    v.pipe(v.boolean(), v.description("用例失败时仍生成报告（沿用 vitest 的 coverage.reportOnFailure）。")),
    false,
  ),
});

/** 引擎与传输配置（vitest builder 专有） */
export const engineOptionsSchema = v.object({
  projectPath: v.pipe(
    v.string(),
    v.description("Godot 工程目录（含 project.godot），相对 workspaceRoot。"),
  ),
  scene: v.pipe(
    v.string(),
    v.description("引擎中要执行的场景，如 res://engine_vitest.tscn。"),
  ),
  port: v.optional(
    v.pipe(
      v.number(),
      v.description(
        "宿主 WebSocket 端口的起始值（默认 18781）。监听先于构建开起来，该端口被占用则 +1 继续试，"
          + "真正绑定的那个同时写进产物、用于宿主监听、并在启动引擎时经 CUJ_WS_PORT 传入，三方始终一致。"
          + "启用 skipBuild 时产物不会重建，端口钉在配置值上不自增。",
      ),
    ),
    DEFAULT_ENGINE_PORT,
  ),
  connectTimeout: v.optional(
    v.pipe(v.number(), v.description("等待引擎连接的时间上限（毫秒）。")),
    30_000,
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
  noLaunch: v.optional(
    v.pipe(v.boolean(), v.description("不自动启动引擎，仅等待其主动连接。")),
    false,
  ),
});

/* ------------------------------------------------------------------ *
 * 两条链路共用的选项
 * ------------------------------------------------------------------ */

/**
 * application 与 vitest 两条链路同名同义的字段。写于一处，两个 schema 展开同一份，
 * 不会出现“application 已加而 vitest 漏加”。
 */
export const sharedOptionFields = {
  // —— 自有 ——
  entries: v.pipe(
    v.array(entryPatternSchema),
    v.description(
      "入口 .ts，可配置多个，形状沿用 assets 的 { glob, input, output, ignore }。"
        + "产物名 = output + 文件相对 input 的路径（去除 .ts）：\"src/main.ts\" 生成 main.js，"
        + "{ glob: \"**/*.ts\", input: \"src/pages\" } 生成该目录下的同名文件，"
        + "再加 output: \"pages\" 即 dist/pages/同名.js。"
        + "名称不再从“匹配文件的公共目录”反推（该结果会随匹配情况变化）；未提供 input / output 时以根目录为准。",
    ),
  ),
  resRoot: v.pipe(
    v.string(),
    v.description(
      "outputPath 对应的 res:// 前缀，例如工程根下 outputPath=dist 时填 res://dist。" +
        'chunk 之间的 require 会据此改写为绝对路径（GodotJS 的 require("./x") 不可用）。',
    ),
  ),
  viteConfig: v.optional(
    v.pipe(
      v.string(),
      v.description(
        "vite 配置文件路径（相对 workspaceRoot），叠加在本 builder 之上。plugins 为追加而非" +
          "替换，因此 polyfill / res:// require / ICU 等关键插件不会被覆盖。未在此暴露的 vite 能力可通过该配置接入。",
      ),
    ),
  ),

  // —— 名称与语义对齐 @angular/build:application ——
  tsConfig: v.pipe(v.string(), v.description("应用 tsconfig（相对 workspaceRoot）。")),
  outputPath: v.pipe(
    v.string(),
    v.description(
      "产物目录（相对 workspaceRoot）。必须位于 Godot 工程内，res:// 以工程根为基准。",
    ),
  ),
  polyfills: v.optional(
    v.pipe(
      v.array(v.string()),
      v.description(
        '额外追加的 polyfill 说明符（只能追加，不能替换）。builder 始终先生成一个虚拟入口，'
          + '其首行固定引入构建器自带的补丁模块（本包唯一带副作用的模块，Angular 在模块'
          + '求值期即要求环境就绪），本选项的每一项都追加在其后。'
          + '不提供关闭必带项的开关：该项属于结构要求，而非可选项。',
      ),
    ),
    [],
  ),
  optimization: v.optional(
    v.pipe(v.boolean(), v.description("生产优化（压缩 + Angular 生产模式）。")),
    false,
  ),
  sourceMap: v.optional(
    v.pipe(v.boolean(), v.description("输出 sourcemap。")),
    false,
  ),
  define: v.optional(
    v.pipe(
      v.record(v.string(), v.string()),
      v.description("编译期常量替换，语义同 vite 的 define。裸 global 已固定换成 globalThis。"),
    ),
  ),
  externalDependencies: v.optional(
    v.pipe(
      v.array(v.string()),
      v.description(
        "不打包进产物、运行时由外部提供的包。口径与官方一致：`@foo/bar` 会将包内所有路径视为外部，" +
          "包括 `@foo/bar/baz`。`godot` 已固定为外部。",
      ),
    ),
    [],
  ),
  fileReplacements: v.optional(
    v.pipe(
      v.array(fileReplacementSchema),
      v.description("按文件替换（对应 environment.prod.ts 的用法），语义与官方一致。"),
    ),
  ),
  assets: v.optional(
    v.pipe(
      v.array(assetPatternSchema),
      v.description(
        "原样复制到产物目录的静态文件（主题 .tres / 字体 / 图标），不做 hash，也不修改内容。",
      ),
    ),
  ),
  deleteOutputPath: v.optional(
    v.pipe(v.boolean(), v.description("构建前清空 outputPath。")),
    true,
  ),
  outputHashing: v.optional(
    v.pipe(
      v.picklist(["none", "bundles"]),
      v.description(
        "官方枚举的 Godot 子集。入口名必须稳定（.tscn 按名称引用脚本），因此仅共享 " +
          "chunk 可被 hash；all / media 在此无对应能力，不接受。",
      ),
    ),
    "none",
  ),
  preserveSymlinks: v.optional(
    v.pipe(v.boolean(), v.description("模块解析不还原软链接，语义同官方。")),
  ),
  conditions: v.optional(
    v.pipe(v.array(v.string()), v.description("exports 条件解析，透传 vite resolve.conditions。")),
  ),
  loader: v.optional(
    v.pipe(
      v.record(v.pipe(v.string(), v.regex(/^\.\S+$/)), v.picklist(["text", "base64"])),
      v.description(
        "扩展名 → 内联方式。官方六种中的 Godot 子集：text（原样字符串）与 base64；" +
          "file / dataurl / binary 依赖 URL 或 CSS url()，此处无对应能力。",
      ),
    ),
  ),
  budgets: v.optional(
    v.pipe(
      v.array(budgetSchema),
      v.description("体积预算。阈值写法与 all / any / initial / bundle 口径全部复用 @angular/build。"),
    ),
  ),
  statsJson: v.optional(
    v.pipe(v.boolean(), v.description("生成 stats.json（各产物文件的体积清单）。")),
    false,
  ),
  watch: v.optional(
    v.pipe(
      v.boolean(),
      v.description(
        "监听并重新构建。注意其仅保证产物为最新：Godot 将 .js 作为 Script 资源缓存，引擎不重启或"
          + "不执行 --import 时无法看到新内容。",
      ),
    ),
    false,
  ),
  poll: v.optional(
    v.pipe(
      v.number(),
      v.description("轮询间隔（毫秒），用于 watch 在网络盘/容器中不触发的场景。"),
    ),
  ),
  verbose: v.optional(
    v.pipe(v.boolean(), v.description("更详细的构建日志。")),
    false,
  ),
};

/* ------------------------------------------------------------------ *
 * 两个 builder 的完整选项
 * ------------------------------------------------------------------ */

/**
 * `godot-angular:application`。`styles` 故意不在 sharedOptionFields 里：vitest builder
 * 不走那条 CSS 链路，接一个会被静默忽略的选项比不接更糟，因此在 schema 层就拒绝。
 */
export const applicationOptionsSchema = v.object({
  ...sharedOptionFields,
  styles: v.optional(
    v.pipe(
      v.array(styleEntrySchema),
      v.description(
        "全局样式表（名称与语义沿用上游）。内容在构建期解析并编入产物，运行时作为 " +
          "application 层的样式表参与级联（等价于 NativeScript 的 Application.addCss）。" +
          "缺少该选项时全局 CSS 没有入口：组件的 styles 只能在作用域内生效。" +
          "上游 items 中的 bundleName / inject 面向 HTML，此处不接受。",
      ),
    ),
    [],
  ),
});

/** vitest builder 专有项 */
export const vitestOnlyOptionFields = {
  // 入口由 builder 合成（虚拟模块），使用方无法也无需配置；保留为可选只是为了
  // 使旧配置不报错（配置后会被忽略）。
  entries: v.optional(
    v.pipe(
      v.array(entryPatternSchema),
      v.description("已忽略：引擎测试的入口由 builder 合成。"),
    ),
    [],
  ),
  specInclude: v.pipe(
    v.array(v.string()),
    v.description("spec 文件的 glob（相对 workspaceRoot）。为 glob 的唯一来源，直接来自参数而非磁盘扫描。"),
  ),
  exclude: v.optional(
    v.pipe(
      v.array(v.string()),
      v.description(
        "排除的 spec glob（相对 workspaceRoot），语义与 @angular/build:unit-test 的 exclude 相同。"
          +"引擎中的产物是封闭 bundle，因此该选项同时作用于“编入 bundle 的文件清单”和 vitest 的 exclude，"
          +"两者必须一并过滤，否则宿主会指定一个未编入的文件。",
      ),
    ),
  ),
  // 此处**没有** setupFiles，并非遗漏：引擎运行的是一个编译完成的 bundle，vitest 在运行时
  // 无法再 import 一个未被编进去的文件，把官方那个选项搬过来只会“配置了不生效”。
  // 等价做法：将全局环境写进 spec 自身的 beforeEach（见 testing 的 initGodotTestEnvironment）。
  engine: v.pipe(engineOptionsSchema, v.description("引擎与传输配置：测试在真实 Godot 中运行，此处指定引擎位置与要执行的场景。")),
  skipRun: v.optional(
    v.pipe(v.boolean(), v.description("仅构建不执行。适用于引擎运行在另一台机器的场景。")),
    false,
  ),
  skipBuild: v.optional(
    v.pipe(v.boolean(), v.description("仅执行不构建，适用于单文件迭代调试。")),
    false,
  ),
  reporters: v.optional(
    v.pipe(v.array(v.string()), v.description("透传 vitest reporter。")),
  ),
  filter: v.optional(
    v.pipe(v.string(), v.description("按用例名过滤（透传 vitest testNamePattern）。")),
  ),
  fileFilters: v.optional(
    v.pipe(v.array(v.string()), v.description("按文件过滤（透传 vitest 位置参数）。")),
  ),
  coverage: v.optional(
    v.pipe(
      v.union([v.boolean(), coverageOptionsSchema]),
      v.description(
        "覆盖率统计（istanbul provider；因运行于引擎内，插桩发生在构建期）。传 true 等价于 { enabled: true }；"
          + "命令行仅支持布尔值（Angular CLI 不接受对象类型的 builder 选项，engine 同理），"
          + "细粒度配置需写在 angular.json 中。",
      ),
    ),
  ),
};

/**
 * `godot-angular:vitest`。
 *
 * `watch` 在此处**覆盖** shared 的定义：这边“监听”的主语是 vitest（重跑用例），
 * 而不是 vite（重编），语义不同必须说明清楚。
 */
export const vitestOptionsSchema = v.object({
  ...sharedOptionFields,
  ...vitestOnlyOptionFields,
  watch: v.optional(
    v.pipe(
      v.boolean(),
      v.description("vitest 监听模式：修改 spec 或库产物后重新执行。"),
    ),
    false,
  ),
});

/* ------------------------------------------------------------------ *
 * 由形状派生的 TS 类型（此处**是唯一的出口**，其他位置不得重新 `v.Infer*` 一份）
 *
 * 两个口径不要混淆：
 *  - `InferOutput`（无 Raw 前缀）= parse **之后**的形状，`v.optional(x, 默认)` 的字段在这里是必填；
 *    builder 内部一律使用它，因此下游不需要 `?? 默认值`。
 *  - `InferInput`（Raw 前缀）= angular.json 中写出的原始形状，那些字段仍是可选；
 *    仅用于 `createBuilder<T>` 的泛型。
 * ------------------------------------------------------------------ */

export type FileReplacement = v.InferOutput<typeof fileReplacementSchema>;
export type AssetPattern = v.InferOutput<typeof assetPatternSchema>;
export type StyleEntry = v.InferOutput<typeof styleEntrySchema>;
export type EntryPattern = v.InferOutput<typeof entryPatternSchema>;
export type BudgetEntry = v.InferOutput<typeof budgetSchema>;
export type EngineOptions = v.InferOutput<typeof engineOptionsSchema>;
export type CoverageOptions = v.InferOutput<typeof coverageOptionsSchema>;
export type CoverageThresholds = v.InferOutput<typeof coverageThresholdsSchema>;
/** `coverage` 字段的原样形状：布尔是开关速记，对象是完整配置 */
export type CoverageOptionInput = v.InferOutput<typeof vitestOptionsSchema>["coverage"];
export type ApplicationOptions = v.InferOutput<typeof applicationOptionsSchema>;
export type VitestOptions = v.InferOutput<typeof vitestOptionsSchema>;

export type RawApplicationOptions = v.InferInput<typeof applicationOptionsSchema>;
export type RawVitestOptions = v.InferInput<typeof vitestOptionsSchema>;
