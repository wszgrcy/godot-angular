# CSS → Godot Theme 落地方案（执行计划 v3）

把 CSS 子集编译进 Godot 的 `Theme` / `StyleBoxFlat` / 节点属性，让 Angular 组件的
`styles`、`class`、`[style.*]` 在 GodotJS 里真实生效。

**本文只有执行计划。** 每条前提都标了来源，每个阶段都以一个**可执行的测试**收尾 ——
"这个测试绿了"就等于"这个阶段完成了"，没有模糊空间。

---

## 一、资料查询口径（先读，遇到不懂就查，别凭记忆）

### 1. Godot 相关的一切 → 本地查询

属性名、方法签名、信号、theme item、枚举值、继承关系 —— **一律本地查询，不许凭训练记忆编 API**。
（工具、用法、一次查全的命令已写在系统提示词「Godot 本地文档查询规则」里，此处不重复。）

本方案只补两条查询时容易踩的项目事实：

- **文档站是 4.7，引擎是 4.6.1**（GodotJS 二进制：`godot-angular/bin/linux-editor-4.6.1-v8/`，跑法见附录 A）。
  本方案涉及的 API 两边无差异，但**新用的 API 必须引擎实测确认存在** —— 别拿文档当引擎能力。
- **已核对过的页与结论**（省得重复查）：

| 页 | 已核对出的结论 |
| --- | --- |
| `classes/class_control.html` | theme override 全家桶；**没有** `remove_theme_all_overrides`；**没有** `theme_type` 属性 |
| `classes/class_theme.html` | `set_type_variation` / `get_stylebox_list` / `merge_with` |
| `classes/class_styleboxflat.html` | bg / border / corner_radius / shadow |
| `tutorials/ui/gui_skinning.html` | "To sum it up…" 那段就是 theme 查询顺序（已摘进第二节） |

### 2. 无头环境对本项目的三条具体影响

无头环境的通用事实清单见系统提示词，这里只写落到本方案上的后果：

- **布局要等帧**：`add_child` 后立刻读 `size` 是 0 → 测试统一用 `awaitFrames(2)`
- **媒体查询只能注入假视口**：真实屏幕尺寸拿不到 → Phase 6 的测试形如"注入 `{width:600}` → 命中/不命中"，**真实视口与暗色模式属待实机**
- **可断言 / 不可断言的边界**：可断言 = theme item 读写、override 有无、StyleBoxFlat 内容、节点属性、**布局尺寸**（`148x100` 这种能 assert）；不可断言 = 任何像素表现，必须开有头引擎人工确认，**汇报时不许混为一谈**

### 3. CSS 语义与实现参考 → 看 `NativeScript/` 源码

CSS 该有什么行为、边界怎么处理、值怎么解析 —— **以 `NativeScript/packages/core/` 为准**，
它是一套已在生产验证过的"CSS → 原生样式"完整实现，不要自己发明语义。

```
NativeScript/packages/core/
├── css/parser.ts                    16KB 纯 JS 解析器（裁剪参考，别引 css-tree）
├── css/css-tree-parser.ts           AST 归一成 rework 形状
├── css/parser.spec.ts               ★ 解析器测试用例可直接搬
├── css-value/reworkcss-value.ts     值分词器（number+unit / ident / string / comma）
├── css-mediaquery/index.ts          4.8KB，parseQuery + matchQuery(query, values)，几乎可直接用
├── css-mediaquery/index.spec.ts     ★ 媒体查询用例可直接搬
├── media-query-list/index.ts        怎么把屏幕尺寸喂进 matchQuery（:30 从 Screen.mainScreen）
├── ui/styling/css-selector.ts       ★★ 选择器对象 + 四桶倒排索引 + 级联排序（39KB）
├── ui/styling/css-selector.spec.ts  ★ 选择器匹配用例（21KB，直接搬）
├── ui/styling/style-scope.ts        ★★ CssState：重查/合并/diff/unset/批量
├── ui/styling/style-scope.spec.ts   ★ 级联与作用域用例
├── ui/styling/style-properties.ts   ★ CSS 属性 → 原生 setter 的注册表范式
├── ui/styling/style-properties.spec.ts
├── ui/core/properties/index.ts      ★ CssProperty / ValueSource / 双访问器 / 批量挂起
├── ui/styling/css-shadow.spec.ts    box-shadow 解析用例
└── ui/styling/css-color-mix.spec.ts 颜色用例
```

**两边都没有的东西 = 不做**（见第七节），不要发明第三套语义。

### 4. 本项目自己的测试基建

| 层 | 位置 | 命令 | 说明 |
| --- | --- | --- | --- |
| 纯 Node | `packages/*/test/*.spec.ts` | `pnpm test:node` | 不起引擎，秒级；**css 包的所有逻辑必须落在这层** |
| 引擎真机 | `test-app/src/tests/engine/*.spec.ts` | `pnpm test` | 真 Godot 进程里跑 vitest；`TestBed` + `fixture.whenStable()` |
| 探针基线 | `/workspace/godot-test/tools/css-probes/` | 见附录 | 53 项，回归用 |

`godot-angular/testing` 现成可用：`makeRenderer` / `newNode` / `childNodes` / `findAllNodes` /
`awaitFrames` / `pumpEngineFrames` / `captureWarn` / `expectWarned` /
`initGodotTestEnvironment`。变更检测的等待用官方的 `fixture.whenStable()`，这里不再提供。

⚠️ 两个会静默坑人的点：spec 文件**编译不过就不会被收集**（只留一行 warning），
跑完必须核对输出里的文件列表；`specInclude` 由 `angular.json` 的 test target 控制，新文件要落在 glob 里。

### 5. 构建期（vite）插件的既有范式 —— 加 CSS 通道照这个抄，别自己摸索

本项目已有三个自研 vite 插件，`build-core.ts:376-389` 是它们的挂载点与**顺序注释**。加 CSS 插件直接复用 `icu-downgrade.ts` 的实测结论（它注释里全写着）：

| 事实 | 出处 |
| --- | --- | --- |
| `enforce: "post"` 才拿得到 **analog 编译完的 JS**；放 `pre` 会看到带装饰器的原始 TS，babel 解析不了 | `icu-downgrade.ts:29` |
| 用 `transform` 而不是 `renderChunk`：transform 收**单模块**（实测某组件 7,766 B），renderChunk 收**整 chunk**（857,553 B），**差 110 倍**；早先放 renderChunk 实测 +385ms，挪到 transform 只 +~100ms | `icu-downgrade.ts:21-27` |
| 热路径用 `String.includes` 做闸门，别上正则（实测 includes 25.5 GB/s vs regex.test 4.85 GB/s，**正则反而慢 5 倍**） | `icu-downgrade.ts:36-42` |
| 带 `/g` 的正则对象**不能跨模块复用** `.test()`（lastIndex 有状态，会随机漏检） | `icu-downgrade.ts:43-45` |
| 重活（babel 级）动态 `import()`，没命中时零成本 | `icu-downgrade.ts:52-68` |
| 虚拟模块现成写法（`resolveId` + `load`，`enforce: "pre"`，id 不加 `\0`） | `polyfill.ts:39-63` |

**analog 自己那个组件样式封装插件为什么帮不上**：`encapsulateComponentStylesPlugin` 是 `apply: 'serve'`，且只在 `options.liveReload` 开启时才挂（`@analogjs/vite-plugin-angular/src/lib/angular-vite-plugin.js:685`、`encapsulate-component-styles-plugin.js:14`）。本 builder 没开 liveReload，**build 模式下没有任何人做样式封装** —— 这正是 `%COMP%` 活到产物里的原因（C13），也正是我们要补的洞。它内部调的是 `@angular/compiler` 的 `encapsulateStyle(style, componentId)`，我们要么复用这个函数，要么自己走 Phase 1 的解析器。

**styleUrls 在 build 下到底走哪条路（已逐行追清，别再重新推）**：

| 环节 | 位置 | 行为 |
| --- | --- | --- |
| vite 侧 `StyleUrlsResolver` | `angular-vite-plugin.js:550-557` | **build 下不跑**。`resolveResourceUrls = code.includes("@Component") && (watchMode \|\| jit)`；`watchMode = command === 'serve'`（`:190`）、`jit = pluginOptions.jit ?? isTest`（`:105`）。注释原文："skip resolution entirely in prod AOT builds" —— **设计如此，不是 bug** |
| 我们开 `experimental.useAngularCompilationAPI: true` | `:931-934` | `performCompilation` 提前 `return` 走 `performAngularCompilation`（`:733`）；经典 ngtsc 路径里的 `augmentHostWithResources`（`:1059`）**根本不执行** —— 两条路只走一条 |
| 真正内联 | `:776-803` 的 `transformStylesheet` | **文件读取由 Angular 的 Compilation API 自己做**，analog 只把拿到的 CSS 过 `getStyleTransform()`（vite `preprocessCSS`，所以 scss 能直接用） |
| 静默① 文件不存在 | 诊断链 | 没变成 error 递出来。analog 只从 `angularCompilation.diagnoseFiles(...)` 取诊断（`:827`），默认 `disableTypeChecking: true`（`:63`）→ 只取 `All & ~Semantic` |
| 静默② 预处理器报错 | `:795-801` | `try { …getStyleTransform()… } catch (e) { console.error(\`${e}\`); } return stylesheetResult?.code || '';` —— 实测打印 `[sass] Error: expected &quot;{&quot;` 但 **rc=0** |

---

## 二、前提与硬约束（已实测，计划里直接引用编号）

Godot 的 theme 查询顺序（`gui_skinning` "To sum it up…" 原文）：
**local override → 按「变体→类名→父类名」从自己往上走父链查设了 `theme` 的控件 → 项目主题 → 默认主题 → 类型默认值**。
对照 CSS：override = 内联 style，变体 ≈ class（有缺口，见 C5），父链 theme = 作用域继承，项目主题 = 全局样式表，默认主题 = UA 样式表。

| # | 约束 | 影响 |
| --- | --- | --- |
| **C1** | 节点可挂自定义 JS 属性，实例级、不泄漏原型、`get_child()` 取回不丢、两次取回 `===` 恒等 | `_ngcontent-*` 直接挂属性，`WeakMap<node,state>` 可用 |
| **C2** | `get_theme_stylebox()` 返回**共享实例**，直接改污染整个 Theme（实测 `shared=true polluted=true`） | 写前必须 `duplicate()` |
| **C3** | **没有 `remove_theme_all_overrides`**（文档 Control 页只有 6 个 `remove_theme_<kind>_override`） | 必须自己记账逐个撤；`begin/end_bulk_theme_override` 可摊平批量开销 |
| **C4** | 局部 override **永久屏蔽** `theme_type_variation`：写过 override 的 item，再切变体取回恒为 override 值 | 静态换肤路与运行时级联**按 item 互斥** |
| **C5** | `theme_type_variation` 是**单值 string**；`set_type_variation(v, base)` 只有一个 base，重复调用静默覆盖 | 多 class / `.a.b` 无直接对应 |
| **C6** | 未注册的变体名**静默回落基类，零提示** | 构建期必须校验变体名 |
| **C7** | `Theme.get_stylebox_list(cls)` 只列该 theme 显式 set 过的项 | 词汇表必须来自 `ThemeDB.get_default_theme()` |
| **C8** | `Color` 只吃 hex + 命名色；`new Color("rgb(255,136,0)")` 报 `Invalid color name`；`html_is_valid("rebeccapurple")=false` 但 `new Color("rebeccapurple")` 可用 | 颜色必须自己解析 |
| **C9** | 兄弟节点可同名 | `#id` 不能靠 `node.name` |
| **C10** | Godot **没有可写的 `theme_type` 属性**（只有 `theme` / `theme_type_variation`） | 元素选择器落点 = 节点类名，不可覆写 |
| **C11** | `custom_minimum_size` 是**下界**，不是等值 | `width/height` 归 L3 |
| **C12** | `BoxContainer.alignment` 只有 BEGIN/CENTER/END | `justify-content: space-*` 无落点 |
| **C13** | 组件 `styles` 确实到得了运行时且 `%COMP%` **未被替换**（实测产物 `dist/main.js:20475`），`@angular/core` 里 grep `%COMP%` 零命中 | 必须我们自己替换，与 NativeScript 一致 |
| **C14** | **未验证**：JS 包装对象被 GC 后身份是否仍稳定 | Phase 3 第一天必须测掉 |
| **C15** | `styleUrls` **本身是工作的**（文件存在时正常内联并封装）。但有两处**静默**：① 文件不存在 → 零输出零告警、构建绿，`styleUrls` 原样留在产物里；② 预处理器报错（scss 语法错）→ 只 `console.error` 后返回空串，**退出码仍为 0**（均实测） | Phase 1.5 要补的是**把这两处变成硬失败**，不是自己重做内联 |
| **C16** | `%COMP%` 无人替换的根因：analog 的封装插件是 `apply:'serve'` + 仅 `liveReload` 时挂载 | “有人得填”这条责任跑不掉；最终落在**运行时** `shimComponentCss`（与浏览器端同层，见下方架构修正） |
| **C17** | analog 的 vite 侧 `StyleUrlsResolver` 在 build 下**被显式跳过**（`angular-vite-plugin.js:550-557`，注释原文："skip resolution entirely in prod AOT builds"）；真正干活的是 Compilation API 的 `transformStylesheet`（`:776-803`），**文件读取由 Angular 自己做** | 别去改那个 resolver，找错地方 |

---

## 三、五条口径（Phase 0 定死，之后不许临时绕）

**口径 A · item 归属**
每个 `(theme_type, theme_item)` 只能有一个主人：**路线 S**（构建期编 `.theme` + 变体，运行时只切 `theme_type_variation`）或 **路线 R**（`add_theme_*_override`）。
混用 → R 永久屏蔽 S（C4）。**默认全走 R**；只有构建期可证明"该组件无动态 class、无伪类"才允许 S，且产物里要标出来。

**口径 B · duplicate**
凡从 `get_theme_stylebox()` / `Theme.get_stylebox()` 拿到的 StyleBox，**写前三步：`duplicate()` → 改 → `add_theme_stylebox_override()`**。漏一处 = 一个节点改背景改掉全工程同类控件。

**口径 C · override 记账**
每节点维护 ledger，两层：`Map<CSS 属性名, Map<"{kind}:{item_name}", 撤销动作>>`。外层是撤销的查询条件（`clearStyle(node, "color")` 只取 color 那一格），内层是去重依据，并容纳“一条 CSS 属性写多个 item”（`gap` → h_separation + v_separation、`color` 遇 hover → font_hover_color）。级联 diff 只撤 ledger 里的项，逐个 `remove_theme_<kind>_override`，外面包 `begin/end_bulk_theme_override`。漏记 = 永久残留。

**口径 D · 多 class**
恰好命中一个 class 且有对应变体 → 可走 `theme_type_variation`。命中多个 class 或出现 `.a.b` → **一律走运行时 override**，不生成组合变体（组合爆炸不划算）。

**口径 E · L3 不承诺等价**
布局类属性只做提示式翻译，落不到就 `warnOnce` 忽略，**绝不自动改节点树**（Angular 持有节点引用）。

---

## 四、分层与承诺边界

| 层 | 内容 | 承诺 |
| --- | --- | --- |
| **L1 外观** | color / background-color / border / border-radius / box-shadow / font-size / opacity | ✅ 完整支持，全有落点 |
| **L2 状态** | `:hover` `:active` `:focus` `:checked` | ✅ 信号驱动；Godot 原生就有 hover/pressed stylebox |
| **L3 布局** | display / flex / grid / position / margin / **width/height** | ⚠️ 只做翻译提示，**不承诺等价** |

落点速查（词汇表来源 = `ThemeDB.get_default_theme()`，C7）：

| CSS | Godot | 备注 |
| --- | --- | --- |
| `Button{}` | 节点类名 | 不可覆写（C10） |
| `.class` | `theme_type_variation` | 单 class 才等价（C5） |
| `style=""` | `add_theme_*_override` | 最高优先级（C4） |
| 祖先作用域 | `Control.theme` 父链 | 就近赢 |
| bg / border / radius / shadow | `StyleBoxFlat` | Button→`normal`、PanelContainer→`panel`、LineEdit→`normal`、Label→`normal`（已实测四个名字都在默认主题里） |
| `margin` | `MarginContainer` 的 `margin_*` | 非 MarginContainer 告警忽略 |
| `gap` | `BoxContainer.separation` | — |
| `justify-content` | `BoxContainer.alignment` | 仅三档（C12） |
| `flex: n` | `size_flags` + `size_flags_stretch_ratio` | 无 flex-basis |
| `width/height` | `custom_minimum_size` | **下界**（C11） |
| `opacity` | `CanvasItem.modulate.a` | 连子树一起调制 |
| `:hover/:focus/:active/:checked` | `mouse_entered/exited`、`focus_entered/exited`、`button_down/up`、`BaseButton.toggled` | 全可连可断（已实测） |

---

## 五、执行计划

> 每个阶段末尾的 **收尾测试** 是唯一的完成判据。测试没写或没绿 = 阶段没完成，不许推进下一阶段。

### Phase 0 · 决策与骨架（1 天）

- 新包 `packages/css/`：**纯 JS，绝不 import `godot`** —— 全部逻辑要能在 `pnpm test:node` 里跑
- **打包链路**（漏一项就会在 Phase 2 才发现）：
  - `vitest.node.config.mts` 的 `include` 目前写死 `packages/library/**/test/**` 与 `packages/builder/**/test/**` → 加 `packages/css/**`
  - `pnpm-workspace.yaml` 只含 `test-app`（`packages/library` 只是 ng-packagr 清单模板，不是被安装的包）→ 决定 css 是并入 library 产物还是独立 entry
  - `tools/vite-build.ts` + ng-packagr + `dist/` 布局 + `dist/package.json` exports + `pnpm build` 往返
- **改写 README 三处旧口径**：第 68 行 `CSS 级联 ❌ 有意不做`、第 742 行 `## 样式：不做 CSS`、第 755 行 `class 一律告警忽略`
- 定死口径 A–E；`#id` 用 Angular 的 `id` 绑定，不用 `node.name`（C9）

**收尾测试** — `packages/css/test/scaffold.spec.ts`（纯 Node）

| 断言 | 为什么 |
| --- | --- |
| `pnpm test:node` 输出里出现 `scaffold.spec.ts` 且被收集 | 防"文件被静默忽略" |
| 遍历 `packages/css/**/*.ts` 源码文本，断言不含 `from "godot"` / `require("godot")` | 纯 JS 约束是"能在 Node 跑"的前提 |
| `pnpm build` 后 `dist/` 里存在 css 产物，且 `node -e "require('godot-angular/css')"` 不抛 | 发布物往返，日常开发就验证"用户只拿到发布物"那条路 |
| 读 `README.md`，断言不含 `CSS 级联 | ❌ 有意不做` 与 `不做 CSS，做 Godot 的对应物` | 文档与行为不许分叉 |
| 读 `vitest.node.config.mts`，断言 include 含 `packages/css` | 打包清单不烂尾 |

跑法：`pnpm test:node && pnpm build`

---

### Phase 1 · 解析器 + 选择器引擎（1.5 天）

`packages/css/` 下：

- `parser.ts` — 自己写够用的 CSS 解析（**不引 css-tree**，体积与 CJS 打包都麻烦；参考 `NativeScript/packages/core/css/parser.ts` 16KB 裁剪）。输出统一成 rework 形状：`stylesheet / rule / declaration / media / keyframes`
- `selector.ts` — 移植 `css-selector.ts` 的 `SelectorCore` / `SimpleSelectorSequence` / `ComplexSelector` / `SelectorScope` / `matchSelectorCandidates`，**去掉 `css-what` 自己分词**。specificity / rarity / tier / pos 四元组照抄（`Inline=1000 / Id=100 / Class|PseudoClass=10 / Type=1`；排序 `specificity || tier || pos`）
- **匹配只依赖极小接口**（照抄 `css-selector.ts:14-26`，含 `nodeName` / `_modalParent` 之外的 `cssType` / `cssClasses` / `cssPseudoClasses` / `parent`），无 DOM 无布局 —— 这是能在 Node 里测的根本原因
- `value/` — color（**自己解析 `rgb()/rgba()/hsl()/hwb()`**，C8）、length、四值简写（照抄 `style-properties.ts:positioningFromParts`）、shadow、radius；`unset/initial/inherit/revert` 统一识别
- `shorthand.ts` — 声明在**解析期**就展开成 longhand（NativeScript 注释原文："The cascade is defined on longhands"）
- `mediaquery.ts` — 搬 `css-mediaquery/index.ts`，`matchQuery(query, values)` 的 values **由调用方注入**，本模块不许读 `DisplayServer`
- `vocabulary.ts` — 构建期从 `ThemeDB.get_default_theme()` dump 出「类 → theme item 词汇表」JSON（C7），并校验生成的变体名已注册（C6）

**收尾测试** — `packages/css/test/{parser,selector,value,shorthand,mediaquery}.spec.ts`（纯 Node）

| 断言 | 用例来源 |
| --- | --- |
| `a{color:red}` / 逗号多选择器 / `@media` 嵌套 / 注释 / 未闭合括号不崩 | 搬 `css/parser.spec.ts` |
| `@keyframes` 被识别并**丢弃 + 告警**（第七节不做动画） | 自写 |
| specificity 表驱动：`.a`=10、`#a`=100、`a`=1、`a.b`=11、`a:b`=20、内联=1000 | 搬 `css-selector.spec.ts` |
| **四桶索引结果 == 全表暴力扫描结果**（随机造 200 条规则 × 50 个假节点，两种路径逐一比对） | 自写，最省事的正确性证明 |
| `compareSelectors` 排序：同特异度按 tier、再按源码顺序；组件样式压全局样式 | 搬 `css-selector.spec.ts` |
| 颜色：`#hex/#rgb/#rgba`、命名色、`rgb()/rgba()/hsl()/hwb()` 与 CSS 参考值逐一相等；非法值返回兜底不抛 | 搬 `css-color-mix.spec.ts` |
| `margin: 1px 2px` → 四条 longhand；`border` → 各 longhand | 搬 `style-properties.spec.ts` |
| `matchQuery("(min-width: 500px)", {width: 600})` 表驱动，含 `and` / `not` / `or` / `orientation` / `prefers-color-scheme` | 搬 `css-mediaquery/index.spec.ts` |
| `mediaquery.ts` 源码不含 `godot` / `DisplayServer` | 保证可在 Node 跑 |

跑法：`pnpm test:node`

> **为什么解析器必须是纯 JS**：不只是"能在 Node 里测"，更因为它**要在 vite 构建进程里跑**（Phase 1.5）。`packages/css` 里一旦出现 `import "godot"`，构建期插件当场炸，而且是在 CI 的构建步骤炸而不是在测试里炸。

---

### Phase 1.5 · 构建期 CSS 通道（vite 插件）（1.5 天）

**这是 CSS 源码进入本项目的唯一入口。** 运行时只能看到已经被 analog 塞进 `styles: [...]` 的字符串；能在**源码层面**读到 `styles` / `styleUrls` / 全局样式并解析处理的，只有 vite 插件。

- 新文件 `packages/builder/vite/css-plugin.ts`，形状照 `icu-downgrade.ts`：`enforce: "post"` + `transform(code, id)`，热路径用 `includes("%COMP%")` / `includes("styles:")` 做闸门
- 挂在 `build-core.ts:376-389` 的 plugins 数组里，**紧跟 `icuDowngradePlugin` 之后、`godotInteropPlugin` 之前**（同为源码级 transform；`godotRequirePlugin` 改的是产物 require，不在一个阶段 —— 顺序注释里写明）
- **职责（MVP，策略 B）**：
  1. 把 `styles` 里的 `%COMP%` 换成 `componentId`（`type.id.replace(/-/g,'_')`），与 NativeScript 的运行时替换等价但**提前到构建期** → Phase 4 不再需要运行时替换
  2. `styleUrls`：**内联本身已经能用**（文件存在时 Angular 的 Compilation API 会读取并经 `transformStylesheet` 预处理，`.scss` 直接可用，项目里 `sass@1.104.1` 已装）。本插件要做的是**把两处静默改成硬失败**（C15）：文件不存在 → `this.error()` 并带上组件文件与相对路径；预处理器报错 → 不能只 `console.error` 后返回空串（analog 现在就是这个行为，`angular-vite-plugin.js:795-801`）
  3. 解析期顺带跑 Phase 1 的校验：变体名注册（C6）、不支持的 at-rule 告警
- **升级（策略 A，Phase 3 之后）**：构建期就把 CSS 解析成规则集，产物里只留紧凑 JSON（或虚拟模块 `virtual:godot-angular/css`，写法见 `polyfill.ts:39-63`），运行时**零解析、CSS 原文不进产物**。先 B 后 A 的理由：A 要定序列化格式 + 处理 watch 增量，B 半天就能端到端跑通
- **全局 `styles` 选项**：`options-schema.ts` 加字段 → 加进 `tools/gen-schema.ts` 的 `UPSTREAM_FIELDS` 白名单 → `pnpm gen:schema` → 插件把全局样式解析后写进虚拟模块，运行时 bootstrap 时注册成 application tier（NativeScript `Application.addCss` 的对应物）。**不加这个选项，全局 CSS 就没有入口**
- **watch**：`runGodotViteWatch` 已有 `extraPlugins` observer 注入口（`build-core.ts:178-180/247`），CSS 文件改动要能触发重解析；analog 的 serve 模式 HMR 逻辑（`angular-vite-plugin.js:340-371`）在 build/watch 路径下不生效，别指望它

**收尾测试** — `packages/builder/vite/test/css-plugin.spec.ts`（纯 Node，直接调 `plugin.transform` 喂假产物）+ 构建级断言

| 断言 | 钉住 |
| --- | --- |
| 喂含 `styles: [".a[_ngcontent-%COMP%]{color:red}"]` 的模拟 analog 产物 → 输出里 `%COMP%` 已替换成传入的 componentId | C13/C16 |
| 喂不含 `%COMP%`、不含 `styles` 的模块 → 返回 `null`（不改写、不弄抖 sourcemap） | 热路径零副作用 |
| `styleUrls` 指向真实存在的 `.css` / `.scss` → 产物里出现该 CSS 内容（**现状已可用，钉住防回归**） | 基线 |
| `styleUrls` 指向不存在的文件 → 构建**失败**且文案含组件文件与路径 | **C15①，现状：静默通过** |
| `styleUrls` 指向语法错误的 `.scss` → 构建**失败**（不是只打一行 `[sass] Error` 后 rc=0） | **C15②，现状：rc=0** |
| 不支持的 at-rule（`@keyframes`）→ 构建日志出现一次告警 | 口径透明 |
| 构建级：消费方工程加 `styles` 后 `grep -c "%COMP%" <outputPath>/main.js` == 0 | 端到端 |
| 构建级：消费方工程加 `styleUrls`（文件存在）后 `grep "<那条 CSS 的选择器>" <outputPath>/main.js` 命中 | 端到端 |
| 全局 `styles`：`angular.json` 配了 → 产物含该内容；配非法值 → schema 校验报错 | 白名单口径 |
| 策略 A 落地后追加：产物里**不含 CSS 原文**，且规则集 JSON 能被 `packages/css` 反序列化回等价规则 | 升级不丢语义 |

跑法：`pnpm test:node`（插件单测）+ `pnpm build`（构建级断言，可写成 `tools/` 下的小脚本 grep 产物）

---

### Phase 2 · 属性注册表 + Godot 落点（2 天）

- `packages/css/properties.ts` — `CssProperty` 精简版 `{ cssName, parse, apply(node, v, prev) }`（Godot 侧没包袱，不需要 NativeScript 那套 `Object.defineProperty` 双访问器）
- **重构 `packages/library/core/renderer.ts:setStyle`，不建平行实现** —— 它已实现 width/height→`custom_minimum_size`、opacity→`modulate.a`、color→`font_color`、fontSize→`font_size` 四条，新引擎必须接管这条已有路径，否则两处口径分叉
- `packages/library/core/style-target.ts` — **Godot 版的 `setNative`**：
  - 「控件类 → theme item 名」映射表，词汇来自 Phase 1 的 vocabulary dump（C7）
  - StyleBoxFlat 走 **duplicate → 改 → override** 三步（口径 B / C2）
  - ledger（口径 C / C3）
  - 布局类落点 + `warnOnce`（口径 E）：`flex:n`→`size_flags`+`stretch_ratio`、`gap`→父 `separation`、`justify-content`→`alignment`（`space-*` 告警，C12）、`width/height`→`custom_minimum_size`（文档写明是下界，C11）、`margin` 落在非 MarginContainer 上告警忽略

**收尾测试** — `test-app/src/tests/engine/style-target.spec.ts`（引擎真机）+ `packages/css/test/properties.spec.ts`（纯 Node 值解析）

| 断言 | 钉住的是 |
| --- | --- |
| 给 Button 写 background 后 `get_theme_stylebox("normal").bg_color` 变了，**且原 Theme 资源里那一项没变** | C2 污染 |
| 改 A 节点后，兄弟 B 的 `get_theme_stylebox("normal")` 与改前一致 | 口径 B duplicate 隔离 |
| apply 后 ledger 条数 == 写入项数；clear 后 `has_theme_stylebox_override("normal") === false`、`has_theme_color_override("font_color") === false` | 口径 C 记账 |
| 一个 StyleBoxFlat 同时带 bg + corner_radius + border，三者互不覆盖 | 盒模型同箱 |
| `gap:10` → 父 `BoxContainer.theme_get_constant("separation", ...)` 或 override 为 10 | 布局落点 |
| `justify-content: space-between` → `captureWarn` + `expectWarned`，且节点未被改 | C12 + 口径 E |
| `margin: 8px` 落在 Label 上 → 告警且无 override 残留 | 口径 E |
| **既有 `renderer.spec.ts` 全绿**（width/opacity/color/fontSize 四条不许改坏） | 重构不回归 |
| vocabulary dump 与引擎现算 `ThemeDB.get_default_theme()` 结果一致 | C7 防 dump 过期 |

跑法：`pnpm test`（含 refresh）；纯 Node 部分 `pnpm test:node`

---

### Phase 3 · 级联引擎（1.5 天）

`packages/css/cascade.ts` — Godot 版 `CssState`（参考 `style-scope.ts:676-1030`）：

- **第一天先测 C14**（GC 后 JS 包装身份稳定性），不过关就改状态存放策略，别急着写级联
- `WeakMap<node, NodeStyleState>` + 节点属性双写兜底（C1）
- 流程：重查候选 → 按级联顺序合并 declarations → 与 `_appliedPropertyValues` diff → 只写真变了的 → 旧值未被认领的按 ledger 逐个撤 → 包在 `begin/end_bulk_theme_override` 里
- 失效点：`class`/`id` 变化、`appendChild`/`insertBefore`/`removeChild` 标脏子树、`theme_changed`
- **定向失效**：照抄 `SelectorsMatch.changeMap` 思路，只订阅真正依赖的节点/属性
- **帧末批量**：一轮里连续 addClass/removeClass 多次，攒到帧末统一 apply —— 复用现成的 `frameClock()`（`core/frame.ts:28`），这是 NativeScript `_batchUpdate` 的对应物
- 性能护栏：四桶倒排索引（Phase 1 已建）+ `_appliedSelectorsVersion` / `_localValueVersion` 双版本号

**收尾测试** — `packages/css/test/cascade.spec.ts`（纯 Node，用假 Node 接口）+ `test-app/src/tests/engine/css-cascade.spec.ts`（引擎）

纯 Node 层：

| 断言 |
| --- |
| 给定规则集 + 假节点树，合并后的属性数组顺序 == `specificity \|\| tier \|\| pos` 排序结果 |
| diff 只产出真正变化的项；无变化时 apply 调用次数为 0 |
| 移除 class 后，被撤项集合 == ledger 里未被新结果认领的集合（**精确撤除，不多不少**） |
| `changeMap` 只包含真实依赖：改无关节点不产生该节点的失效记录 |

引擎层：

| 断言 | 钉住的是 |
| --- | --- |
| **GC 身份压测**：500 节点塞 WeakMap → 强制 GC → 再取回，身份与状态仍在 | **C14，不过关就停下** |
| `.a` 与 `.b` 冲突时后者赢；内联 `[style.color]` 压过样式表 | 级联 + 值来源优先级 |
| `el.cssClasses.add("x")` 后 `awaitFrames(2)` 取到新值 | 帧末批量 |
| 移除 class 后 `has_theme_color_override("font_color") === false` | **ledger 硬验收（C3）** |
| 一轮内连续 `addClass` 三次 → apply 计数 == 1 | 帧末批量真的合了 |
| 改 A 节点 class → B 节点 apply 计数 == 0 | 定向失效 |
| 1000 节点 × 200 规则，一次全量 match + apply 的耗时 < 基线（首跑定数，之后当回归线） | 性能护栏 |
| 布局尺寸断言：`flex:1` / `flex:2` 两个子节点等宽后 `size.x` 比例 1:2（等帧） | 布局在 headless 下真算 |

跑法：`pnpm test:node && pnpm test`

---

### Phase 4 · Angular 接线（1 天）

- `renderer.ts:createRenderer(_hostElement, _type)` 现在**忽略 `_type` 返回单例** → 改成按 `type.id` 缓存 per-component renderer（模板：`nativescript-renderer.ts:132-165`）
- 组件 CSS 到运行时的形态**已实测**（C13）：产物里是
  `styles: [".probe-css[_ngcontent-%COMP%] { color: rgb(1, 2, 3); } [_nghost-%COMP%] { font-size: 20px; }"]`
  全 bundle 仅 2 处 `%COMP%`，`@angular/core` 里 grep 零命中 → **必须我们自己替换**。
  **Phase 1.5 落地后这件事挪到构建期**，本阶段只负责读已替换好的串；但保留一条兜底：万一某条路径绕过了插件（如 `viteConfig` 逃生口把插件顶掉），运行时检测到 `%COMP%` 要 `warnOnce` 而不是静默失配
- `encapsulation === None` → 全局注册不建作用域；否则 `componentId = type.id.replace(/-/g,'_')`，`%COMP%`→id，注册成 scoped 规则集（tier=Local），`createElement` 时挂 `_ngcontent_<id>` 属性（C1 允许直接挂 JS 属性）
- `addClass`（现 `warnOnce`）/ `removeClass`（现静默空实现）→ 维护 `cssClasses: Set<string>` 并标脏
- 全局 `styles`：builder 的 `application/schema.json` 是 22 项白名单（`tools/gen-schema.ts` 的 `UPSTREAM_FIELDS`），**没有 `styles`** → 二选一：加进 `options-schema.ts` + 白名单 + 重新 gen，或在 README 明确"只支持组件 styles"

**收尾测试** — `test-app/src/tests/engine/css-angular.spec.ts`（引擎）

| 断言 | 钉住的是 |
| --- | --- |
| 组件 `styles` 里 `.probe{color:red}` → 渲染后子元素 `get_theme_color("font_color")` 为红 | 端到端通 |
| 节点上挂的属性名是 `_ngcontent_<id>`，**不含 `%COMP%` 字面量** | C13 替换生效 |
| A 组件的 `.box{...}` 不影响 B 组件同名 class | scopedTag 作用域不外泄 |
| `:host{...}` 落在宿主节点上 | 宿主样式 |
| `encapsulation: None` 的组件样式对兄弟组件也生效 | 全局注册分支 |
| `fixture.componentInstance.cls.set("x")` + `awaitFrames(2)` → 样式变；改回 `"y"` → 旧 override 被撤 | addClass/removeClass 驱动级联 |
| 全局 `styles` 若决定不支持：`ng build` 传 `styles` 时报清晰的 schema 校验错 | 白名单口径 |

#### Phase 4 实测修正（实现时踩到的，计划里没写到）

1. **`createRenderer` 第二个参数是 `ComponentDef`，不是 `RendererType2`**（Angular 22 实测，
   `core.mjs` 三处调用点都是 `createRenderer(host, def)`）。缓存 key 用 def 对象本身，
   不用 `type.id`——`def.id` 是 `getComponentId()` 懒生成的，拿不准时机。
2. **作用域 id 改成“样式文本的哈希”，不是组件级 id**（Phase 1.5 的设计在此推翻）。
   编译器会把**内容相同的 styles 字符串提升成模块级常量**：
   `var _c0 = ".probe[_ngcontent-%COMP%]{…}"` + 两处 `styles: [_c0]`。按组件换根本无从算起
   （一份常量被 N 个组件共用），且只扫 `styles: [...]` 区间会**静默漏掉**同文件第一个组件
   与任何撞样式的组件。按文本哈希则天然正确：共享同一段文本 = 同一个 scope，而它们规则
   完全相同，互相命中与命中自己结果一致。运行时从 CSS 文本里把 scope 读回来，
   `__cujScope` 整个删掉（两份事实一定会对不上）。
3. **只替换 `[_ngcontent-%COMP%]` / `[_nghost-%COMP%]` 两种形态**。改成“扫所有含 `%COMP%`
   的字面量”之后，库自己源码里的告警文案与测试断言被一起改了（静默腐坏源码，日志里
   看不出来）。
4. **`_nghost` 是 `_n`+`ghost`，不是 `_ng`+`ghost`**。正则写 `_ng(?:content|ghost)` 时
   `:host` 规则一条也没换过、也没报错，只是样式静默不落地。
5. **`AttributeSelector` / `PseudoClassSelector` 的 `mayMatch()` 必须严格求值**（上游
   NativeScript 返回 `true`：“现在没”不代表“以后没”，靠 trackChanges 记依赖等变化）。我们的
   `_ngcontent-*` 是渲染器直接赋的普通 JS 属性，**没有任何变更通知**，“先当候选”=“永远当候选”，
   实测后果是 `.box[_ngcontent-A]` 命中所有组件的 `.box`，组件样式隔离直接没了。
   我们的失效模型是“改动方显式 invalidate”（TrackingClassSet / invalidateTree），不靠 mayMatch 兼听。
6. **`:host` 的断言必须拿宿主类真有的 theme item 写**。宿主是未知标签 → VBoxContainer，
   它的词汇表里只有 constant `separation`，没有 `font_size`（那是 Label 那一层的 item）。
   `requireItem` 告警而不是静默落空，这条才被抓出来。
7. **`setStyle` 保持同步生效**：走级联的 inline 层（才能稳定压过样式表），但立刻
   `applyNow(node)`，不拖到帧末——既有 `renderer.spec` 四条断言都是设完立即读。
8. **TestBed 每个测试模块一套全新的 `STYLE_RUNTIME`**（`STYLE_RUNTIME` token）。共用进程
   默认那套时，前一个用例注册的组件 CSS 会留在索引里，同名 class 隔用例互相影响，
   而“作用域不外泄”恰恰是要验的东西。
9. `class="a b"` 这种静态属性现在也落地（`setAttribute` → 整串替换 class 集合）；
   结构变化只标**被动的子树**（标整个父会在大模板创建期变成 O(n²)）。

跑法：`pnpm test`

---

### Phase 5 · 伪类（1 天）

`:hover`←`mouse_entered/exited`、`:focus`←`focus_entered/exited`、`:active`←`button_down/up`、
`:checked`←`toggled`（实测 CheckBox / OptionButton 都走 `BaseButton.toggled`，一个信号通吃）。

- **懒订阅**：只有样式表真用了某伪类才连对应信号（changeMap 思路）
- **打架口径**：Button 的 hover/pressed stylebox 引擎自己会画，**只有 CSS 显式写了 `:hover` 才接管**，否则"引擎画一半、CSS 画一半"

**收尾测试** — `test-app/src/tests/engine/css-pseudo.spec.ts`（引擎）

| 断言 |
| --- |
| `btn.emit_signal("mouse_entered")` + `awaitFrames(1)` → 取到 hover 值；`mouse_exited` 后恢复 |
| `focus_entered/exited`、`button_down/up` 同上各一条 |
| `CheckBox.toggled` → `:checked` 生效（OptionButton 一条） |
| 样式表**不含** `:hover` 时，emit `mouse_entered` → apply 计数 == 0 且 `has_theme_stylebox_override("hover") === false` |
| 样式表含 `:hover` 时，`has_theme_stylebox_override("hover") === true`（接管了） |
| 信号在 teardown 里被 disconnect：节点释放后 emit 不报错、无残留连接 |

#### Phase 5 实测修正

1. **伪类必须写“状态变体 item”，写基 item 不会显示**。引擎 hover 时读的是
   `font_hover_color` / 画的是 `hover` 盒，所以 `Button:hover { color }` 写 `font_color`
   根本看不到。`vocabulary.itemForStates()` 按节点当前状态挑 item，顺序
   `active > pressed > hover > focus > disabled`；两个状态同时成立时引擎读的是
   **合成 item**（`font_hover_pressed_color` / `hover_pressed` 盒），漏了它会出现
   “按着一个已 hover 的按钮，颜色还是 hover 色”。没这个变体就退回基 item（不告警，
   引擎本来就没这个状态）。拼错一个下划线（`font_hovercolor`）也是静默不显示，
   所以 node 侧钉了一组字符串断言。
2. **diff 不能只比 value**：`.btn{background:blue}` + `.btn:hover{background:blue}` 时
   hover 前后值相同，要写的 item 却换了，只比值就会跳过写入。`NodeStyleState.appliedStates`
   存伪类签名，变了就全量重写。
3. **`property_list_changed` 在运行时不会响**（探针实测：信号存在，改 `btn.disabled`
   一次也不触发）—— 它是编辑器刷新属性清单时的通知。所以 `:disabled` / `:enabled` /
   `:read-only` / `:indeterminate` **没有推送通道，不做自动驱动**（“看起来能用其实会漏”
   比不支持更坑）。自动驱动的就五个：hover / focus / active / pressed / checked；
   其余在 addCss 时 warnOnce，并给出可选方案（class 通道 / `runtime.setPseudoClass`）。
4. **懒订阅靠 `cascade.usedPseudoClasses()`**（从已解析的选择器里 `collectPseudoClasses` 收），
   配一个只在集合真变化时进的版本号：后登记的组件样式表引入新伪类时，存量节点要补连
   （否则先创建的元素吃不到 `:hover`），而逐次 addCss 全量重绑是 O(n²)。
5. **盒按字段来源合成，不是“没写 `:hover` 就一个字节不碰”**：状态盒 = 引擎该状态的默认盒
   ⊕ 基规则**声明过**的字段 ⊕ 该状态声明的字段。口径是「没声明的字段一个字节都不碰；
   声明过的字段必须贯穿所有状态」。两个极端都不行：整个复制基盒会把基盒的引擎默认底色
   搬进 hover（引擎自己的悬停加深被抹掉）；只同步几何会让基规则声明的底色在悬停时跳回
   引擎默认。v0.3.1 就是因为落点改成“只看选择器要求的状态”后，基规则不再参与状态盒，
   padding / 圆角 / 边框在悬停那一刻全丢，容器整条重排。

跑法：`pnpm test`

---

### Phase 6 · 媒体查询 / CSS 变量（1 天，可选）

- 媒体查询：`Window.size_changed` / `DisplayServer.is_dark_mode()` 驱动，环境值**由注入提供**（无头下 `screen_get_size()` 恒 `(0,0)`）
- `var()` / `calc()`：解析期展开，不进 Theme；展开失败 → `warnOnce` 并忽略该声明
- ⚠️ **真实屏幕尺寸、真实暗色模式属 [待实机]**，本环境只能断言"注入值 → 命中/不命中"

**收尾测试** — `packages/css/test/mediaquery-runtime.spec.ts`（纯 Node）+ `test-app/src/tests/engine/css-media.spec.ts`（引擎）

| 断言 |
| --- |
| 注入 `{width:400}` → `@media(min-width:500px)` 不命中；注入 `{width:600}` → 命中，样式切换 |
| `Window.size_changed` 触发后重算并广播（计数断言只重算一次） |
| `is_dark_mode` 注入 true/false → `prefers-color-scheme: dark` 切换 |
| `--c: red; color: var(--c)` → 解析期展开成 red；未定义变量 → 用 fallback 或告警忽略 |
| `calc()` 不支持的形态 → 告警忽略，不抛 |
| **文档/README 里写明"真实视口与暗色模式需实机确认"** |

#### Phase 6 实测修正

1. **`CssNode.parent` 在引擎里从来没人填过** —— 而选择器的 `>` / 空格 / `+` 回溯读的就是
   这个 JS 字段（Godot 节点只有 `get_parent()`）。后果：**`.card .title` 这类后代选择器
   在引擎里一条也不命中，且不报错**（node 侧用例是自填 parent 的，所以盖住了）。修在
   `markDirty` 这个唯一入口：每次标脏重读一次 `parentOf`，重新挂父（`reparent` /
   `move_child`）后父链才不会是旧的。变量继承走的也是这条链。
2. **变量在应用期展开，不在构建期**：构建期只能处理“定义与用法同位置”的静态情况，
   而变量的价值就是运行时换值（主题）。`applyNode` 把合并结果里的 `--*` 拆成本节点
   变量表，普通声明再 `resolveVars` 展开（沿父链查，自己的赢）。变量变了就
   `invalidateTree`（Godot 属性赋值没通知，只能主动广播）。
3. **取不到变量且没 fallback = 忽略这条声明，不是写成空串**：写成空会把节点原有的值
   刷掉，那是“样式丢了”而不是“这条没写”。
4. **`setEnv` 同值直接返**：拖窗口时 `size_changed` 能刷出一屏次数，而 `invalidateAll`
   是全量标脏。测试就拿这条断言“只重算一次”。
6. **`%NS%`（CSS 变量命名空间）也是没人填的坑**（读 angular/ 源码 + 实测产物发现）：
   编译器对**所有**组件样式无条件跑 `namespaceCssVariables`（`compiler.ts:276`），
   `--brand` → `--%NS%brand`；`[style.--x]` 的绑定名同样（`binding_parser.ts:602`）。
   浏览器端由 DomRenderer 换成 `CSS_VAR_NAMESPACE`（默认空串），我们没有那一层 ——
   实测产物里就是字面量 `--%NS%brand`。
   **最阴的地方**：同组件内定义与用法两边都带 `%NS%`，名字巧合对得上，**看起来完全能用**；
   但全局样式表（不经组件编译器，名字干净）里的 `--brand` 与组件的 `var(--%NS%brand)`
   永远对不上，跨边界变量继承静默失效。修法：构建期把紧形态 `--%NS%` 还原成 `--`
   （与 `%COMP%` 同一原则：只认精确形态，裸 `%NS%` 不动），renderer 的 `toCssName` 再兜一道。
5. 环境接线挂在 `GodotAngularApp.start()`（使用方不该自己记得接），`destroy()` 里解绑
   —— Window / DisplayServer 是引擎单例，比应用活得长。无头下接得到信号但值恒
   (0,0)/false，所以**真实尺寸与真实暗色模式属 [待实机]**（README 已写）。

跑法：`pnpm test:node && pnpm test`

---

### Phase 7 · 文档与回归基线（0.5 天）

- README：新增「样式：CSS 子集」章节替换旧的「不做 CSS」；写清 L1/L2/L3 承诺边界、`width` 是下界、`justify-content` 只有三档、多 class 走 override、路线 S/R 互斥
- 探针基线修正：`tools/css-probes/README.md` 的 28/14/10 → **26/14/9（合计 49）**；`probe_theme.js` 里 `new Color("rgb(r,g,b)") 函数式可用？` 这条**打的是 PASS 但断言的是"失败"**，改名 `rgb() 不被支持（负向断言）`；把 C4/C5/C6/C7 四条补进基线
- 把本文件与探针 README 交叉引用起来

**收尾测试** — `packages/css/test/docs.spec.ts`（纯 Node）

| 断言 |
| --- |
| README 含「CSS 子集」章节，且不含旧的"有意不做"表述 |
| README 含"需实机确认"字样（防止把逻辑断言说成画面已验证） |
| `tools/css-probes/README.md` 里的计数与实际 `check()` 调用数一致（脚本数一遍） |
| 跑一遍三个探针，退出码为 0 且 FAIL 数 == 2（基线钉死，多出来的 FAIL 就是回归） |

跑法：`pnpm test:node` + 附录 A 的探针命令

#### 架构修正（Phase 7 后）：`cssComponentPlugin` 整个删掉

占位符替换搬到运行时之后，`cssComponentPlugin` 退化成了“纯校验器”。实测后连校验器
也不该存在。它剩的两件事各自被证伪：

- **styleUrls 残留保险丝** —— 内联是 Angular / analog 的职责，它没做对就是**上游 bug**，
  该去提 issue。我试图构造“源码守卫放行但 Angular 未内联”的分歧用例：
  `styleUrls: ["../outside.css"]`（文件在 sourceRoot 外）—— Angular 照样内联了，
  零残留。唯一能复现的触发场景（文件不存在）源码守卫在更早位置已拦下、文案更好。
  → 不值得养一套字面量扫描器。
- **样式内容 lint** —— 检查本体（元素选择器必须是已知 Godot 类名，C10）搬进
  `buildRuleSets`（纯包），然后**构建期与运行时各调一次**。同一份实现两个调用点，
  不会漂 —— 而“`packages/css` 必须纯 JS”当初就是为了能在 vite 进程里跑（见本文
  开头那条约束），现在才算真用上。运行时那份不是冗余：它兜使用方自己
  `runtime.addCss(...)` 登记的动态表，那个构建期看不见。

结果：三个插件 → **两个**，且 `css-plugin.ts` 不再改任何代码。

#### 为什么 lint 能在源码层做（一度以成不能）

我先前断言“构建期 lint 就得养一套字面量扫描器”，错了 —— 那是**产物层** lint 的
麻烦（要去生成 JS 里认出哪段是 CSS，还有 `styles: [_c0]` 提升）。lint 不需要改代码，
只需要 CSS 文本，而 `enforce: pre` 拿到的是**用户自己写的 TS**：`styles: [".a{…}"]`
就是现成字面量，连 `%COMP%` 都没有（那是编译器产物）；styleUrls 文件内容本来就要
读（跑预处理器）。`collectStyleUrls` 换个 key 就是 `collectInlineStyles`。

两条实测事实（都是先猜后验，猜错的那半记下来）：

- **“analog 处理 CSS 时会交给 vite 插件”—— 不成立**。挂日志插件实测，vite 的
  transform 全程只见过 `main.ts` / `app.ts` / `rolldown/runtime.js` / 我们自己的虚
  拟模块，**从没见过 `.css` / `.scss`**。analog 是 `fs.readFileSync` + `preprocessCSS`
  绕开了模块图；而 `preprocessCSS` 内部只跑预处理器与 postcss，不跑插件钩子。
- **analog 自己有 OXC 抽取器**（`style-ast.js` 的 `extractStyleUrls` /
  `extractInlineStyles`），但包 `exports` 只暴露 `.` / `./esbuild` / `./setup-vitest`，
  深 import 实测 `ERR_PACKAGE_PATH_NOT_EXPORTED` → 用不上，自己的扫描器留着。

一个去重键的坑：键用 `sourceId`（文件路径 / `"inline"`）而不是展示文案。两段内联
撞同一份样式报一次就够；但两个不同 styleUrls 文件出同一告警必须各报一次 ——
告警里只有行号，合并就会把第二个文件静默吞掉。

scss 的 lint 输入是**预处理后**的 CSS（用例钉住：原文干净、预处理结果有问题 → 要报）。

---

#### 架构修正（Phase 7 后）：占位符替换从构建期搬到运行时

**做什么**：`%COMP%` / `--%NS%` 的填充不再在 vite 插件里做，改在
`css-runtime.shimComponentCss`，与浏览器端 `DomRenderer.shimStylesContent` 同层。
`cssComponentPlugin` 退化成**纯校验器**（styleUrls 残留硬失败 + 样式内容告警，
一律返回 null）—— 下一节会把它整个删掉。

**为什么**：构建期只能对**生成出的 JS 源码**做文本手术。回头看，踩过的坑全部
源于这个层错位：自写字符串字面量扫描器（CSS 里就有 `[](){}`，正则配对必被
选择器吃掉）、转义解码、模板串与双引号转义规则不同、防误改库自己告警文案里的
`%COMP%`、为不丢 sourcemap 上 MagicString。运行时拿到的 `def.styles` 就是已解码的
字符串数组，语义明确、零误伤可能 —— 上面那张表整体消失。

**核过的 Angular 事实**（`angular/` 本地副本）：
  - `dom_renderer.ts:221` 按 `type.id` 缓存 renderer → 每个**组件类**一份，不是每实例
  - `shared_styles_host.ts:165` 去重只认字符串全等；shim 后文本带 compId 必不同
    → **浏览器也是 N 份 shimmed 样式**。这不是缺陷，每类一份 scope 正是防跨组件
    污染的机制本身；去重才是 bug
  - `definition.ts:700` 注释：`def.id` **故意不含样式内容**。所以不用它算 scope：
    拿不到“同文本同 scope”，共用样式串会注册 N 份；而且它哈希 `type.prototype`
    属性名，压缩会改，跨构建不稳定

**与浏览器的有意偏离**：我们按**样式文本**哈希，同文本 → 同 scope → 只注册一份。
渲染结果等价（同一段文本 shim 成哪个 scope，应用的声明都一样），代价是丢诊断
归属：`matchedSelectors` 分不出“这条是哪个组件的”。

**产物层校验方向翻转**：`check-css-build` 现在断言产物**必须带** `%COMP%` / `--%NS%`，
且不得出现已填好的 scope id（否则就是两份事实）。“填得对不对”改由引擎侧 spec 验
（`css-angular.spec.ts`：`ɵcmp.styles` 带占位符 + 节点作域属性对得上 +
跨边界 CSS 变量能解析）。

---

#### Phase 7 实测修正

1. **探针基线从 49 → 53**：补了 C4/C5/C6/C7 四条（计划自己要求的），`probe_theme.js`
   从 26 → 30。README 标题里的数字现在由 `docs.spec.ts` 数 `check()` 调用数对账，
   抄错就会响（以前写的 28 就是这么漂的）。
2. **新探针不能复用共享节点**：C4/C5 最初直接改上面那个 `btn` 的变体，把后面的
   “局部覆盖优先”带坑了（remove 后回落不到 PrimaryButton）。改成都自己 new 按钮。
3. **“退出码 0”不成立**（已写进附录 A）：负向断言故意让引擎打 ERROR，Godot 把
   ERROR 计入退出码。基线改成钉 `{1,1,0}` 退出码 + `{1,1,0}` FAIL。
4. **真引擎探针默认 skip**：`CUJ_RUN_PROBES=1` 才跑（要拷文件进临时工程 + 起三次引擎）；
   默认 `test:node` 只跑文档对账那 7 条。跳过是显式的，不假装通过。

---

## 六、MVP（4–5 天）

范围：`Tag` / `.class`（**单 class**，口径 D）/ `#id` 三种选择器 +
`color` / `font-size` / `background-color` / `border-radius` / `border` / `opacity` 六个 L1 属性 +
`width|height`（**对外措辞：最小尺寸提示**，C11）+
`:hover` / `:active` / `:focus` 三个伪类 + Angular 组件 styles 作用域 +
**构建期通道（Phase 1.5 策略 B：`%COMP%` 替换 + 把 `styleUrls` 的两处静默改成硬失败）**。

MVP 之后立刻排 Phase 1.5 策略 A（构建期解析成规则集）与 Phase 6；全局 `styles` 选项随策略 A 一起做。

**MVP 总验收**（全部可自动断言）：

```
示例 App 里 <ui-card class="card">：
  0. 构建产物里 grep 不到 %COMP%，且 grep 得到 .card 的规则内容   ← 构建期通道通
  1. get_theme_color("font_color")            == 红
  2. get_theme_stylebox("panel").corner_radius == 12
  3. 兄弟节点的同名 stylebox 未被污染          == 改前值
  4. emit mouse_entered 后取到 hover 值，exit 后恢复
  5. class 从 "card" 改成 "other" 后，
     has_theme_color_override("font_color")   == false   ← ledger 精确撤除
  6. 一轮内多次改 class，apply 只发生一次
  7. A 组件的 .card 不影响 B 组件的 .card
```

**需实机确认（不能声称已验证）**：颜色/圆角/阴影/hover 过渡画出来对不对，必须开有头引擎人工看。

---

## 七、明确不做（做了就是骗人）

`display: grid/flex` 完整语义 · `position: absolute/fixed`（anchors 只能近似且和父容器打架）·
`overflow: auto`（要换 ScrollContainer，是换节点不是设属性）·
`transition` / `@keyframes`（Godot 是 Tween / AnimationPlayer 另一套模型）·
`em/rem/vw/vh` 完整语义 · `:has()` / `:nth-child()`（Godot 侧无 DOM 索引，要遍历兄弟）·
`justify-content: space-*`（C12）· 多 class 组合变体生成（C5）· 静态换肤与运行时级联混用（C4）

---

## 八、风险清单（按会咬人的程度排序）

1. **override 与 theme 换肤互斥（C4）** —— 口径 A 不定死，换肤会静默失效且极难查
2. **StyleBoxFlat 共享污染（C2）** —— duplicate 是唯一防线，审查盯死
3. **没有 `remove_theme_all_overrides`（C3）** —— 记账漏一条永久残留
4. **JS 包装对象 GC 后身份（C14，未验证）** —— Phase 3 第一天必须测掉
5. **变体单值 + 未注册静默回落（C5/C6）** —— 多 class 缺口 + 打错字零提示
6. **每帧级联开销** —— 没倒排索引 + 版本号 + 帧末批量，大列表必卡
7. **和引擎原生状态绘制打架** —— Phase 5 口径
8. **`%COMP%` 只在 Emulated 封装下存在**，`None` / `ShadowDom` 要分开处理
9. **词汇表来源搞错（C7）** —— 从自定义 Theme 取会拿到空表
10. **重构 `setStyle` 改坏既有行为** —— Phase 2 把"既有 renderer.spec.ts 全绿"列为收尾断言
11. **渲染表现无法验证** —— 逻辑断言 ≠ 画面对了，必须开有头引擎人工看
12. **`styleUrls` 的两处静默（C15）** —— 文件不存在静默通过、scss 报错 rc=0；用户写了不生效比报错难查得多。Phase 1.5 必须把两者变硬失败（注意：内联本身是好的，别重做）
13. ~~**构建期插件被用户 `viteConfig` 顶掉**~~ —— 占位符搬到运行时后这条风险自动消失：
    插件负责的是“输入能不能读”，顶掉了最多是少一道前置校验，`%COMP%` 仍会被运行时填对
14. **文档 4.7 / 引擎 4.6.1 版本差** —— 新用 API 必须实测确认存在

---

## 附录 A · 探针基线（53 项 / 2 FAIL）

| 文件 | `check()` 数 | FAIL | 退出码 |
| --- | --- | --- | --- |
| `probe_theme.js` | 30（含新补的 C4–C7） | 1（变体断言写错，probe2 已修正） | 1 |
| `probe_theme2.js` | 14 | 1（`html_is_valid` 只吃 hex，引擎边界） | 1 |
| `probe_runtime.js` | 9 | 0 | 0 |

> **退出码不是 0，也不应该是 0**（计划早期写的“退出码 0”不成立）：`rgb()` 那条负向
> 断言就是故意喂引擎一个它不认的颜色串，Godot 把“本次跑记录过 ERROR”计入退出码。
> 基线钉的是 `{1,1,0}` 这组退出码 + `{1,1,0}` 的 FAIL 数，**变了才是回归**。
> 对账脚本：`packages/css/test/docs.spec.ts`（`CUJ_RUN_PROBES=1 npm run test:node` 才跑真引擎）。

探针 README：`/workspace/godot-test/tools/css-probes/README.md`（本文件的 C1–C14 全部出自它）。

```bash
# 探针只需要一个能跑的 Godot 工程：用临时空工程，不往仓库目录里拷文件
BIN=./bin/linux-editor-4.6.1-v8/godot.linuxbsd.editor.x86_64
probe_dir=$(mktemp -d)
cp /workspace/godot-test/tools/css-probes/probe_*.{js,tscn} "$probe_dir/"
printf '[application]\n\nconfig/name="cuj_probe"\n' > "$probe_dir/project.godot"
"$BIN" --headless --path "$probe_dir" --import >/dev/null
for p in theme theme2 runtime; do
  "$BIN" --headless --path "$probe_dir" res://probe_$p.tscn --quit-after 200
done
rm -rf "$probe_dir"
```

## 附录 B · 已核对的源码坐标

**NativeScript**（语义参考）：`style-scope.ts:25-38/517/676-1030/1097/1263/1388`、
`css-selector.ts:14-26/43-48/915/959/1047/1169-1233/1247/1369/1377/1411`、
`properties/index.ts:30-34/727/864/964-965`、`style-properties.ts:253`、
`css/parser.ts`(16213B)、`css-mediaquery/index.ts`(4816B)、`media-query-list/index.ts:30`

**native-script-angular**：`nativescript-renderer.ts:132-165/467-530`

**godot-angular**（接入点）：`core/renderer.ts:261/268/298`、`core/frame.ts:28`、
`testing/index.ts`、`vitest.node.config.mts`、`pnpm-workspace.yaml`、`tools/gen-schema.ts`、
`dist/builder/application/schema.json`、`README.md:68/742/755`

**Godot 文档**：`class_control.html`（override 全家桶；无 `remove_theme_all_overrides`；无 `theme_type`）、
`class_theme.html`、`class_styleboxflat.html`、`tutorials/gui_skinning.html`

**Angular**：`@angular/compiler/fesm2022/compiler.mjs:26385/26499/26721`；`@angular/core` 无 `%COMP%`
