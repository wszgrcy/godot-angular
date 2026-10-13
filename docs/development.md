# 仓库开发说明

面向本仓库的维护者。面向使用者的文档见根目录 [README.md](../README.md)；
CSS 落地方案的执行计划见 [css-plan.md](./css-plan.md)；引擎二进制的放置规则见
[bin/README.md](../bin/README.md)。

本文记录的是**内部实现约束与实测证据**：为什么构建长成这样、测试为什么只有一层、
GodotJS 与构建链路上已被证实的行为。改构建、改测试、改打包之前先读这里。

## 目录

- [1. 仓库结构](#1-仓库结构)
- [2. 包设计：一个包，多个入口](#2-包设计一个包多个入口)
- [3. 为什么需要这层 builder](#3-为什么需要这层-builder)
- [4. 构建链路与顺序](#4-构建链路与顺序)
- [5. 工作区与发布物](#5-工作区与发布物)
- [6. 测试架构](#6-测试架构)
- [7. 覆盖率](#7-覆盖率)
- [8. GodotJS / V8 的已证实行为](#8-godotjs--v8-的已证实行为)
- [9. 构建与 Angular 侧的已证实行为](#9-构建与-angular-侧的已证实行为)
- [10. 跨平台](#10-跨平台)
- [11. 手动运行引擎](#11-手动运行引擎)
- [12. 内部工具脚本](#12-内部工具脚本)
- [内部约束清单](#内部约束清单约定不在代码里强制)

---

## 1. 仓库结构

```
packages/library/        ← **一个包，多个入口**（ng-packagr，发布清单在这）
  package.json             name: godot-angular；exports / builders 字段全部在这
  index.ts                 空壳主入口（ng-packagr 的 entryFile 必填）：裸导入拿不到任何东西
  ng-package.json          dest = ../../dist，primary = ./index.ts
  core/                    → godot-angular/core       运行时
    godot-host.ts          注入 godot 命名空间 + godotClass()（函数内裸 require("godot")）
    renderer.ts            Renderer2 → Godot 节点（含 ClassDB 属性存在性检查与静态属性转换）
    registry.ts            标签 / 信号 / 属性解析（ClassDB）
    godot-events.ts        tryConnectGodotSignal（接不到返回 null）
    frame.ts               帧钟句柄（从 globalThis.__CUJ_FRAME__ 拿）
    bootstrap.ts           平台 & 应用 provider、GodotAngularApp.tick()
    css-runtime.ts         StyleRuntime：把纯包的 Cascade 接到帧末与节点树
    style-target.ts        CSS 声明 → Godot theme 落点（实现 css 包的 StyleBackend）
  polyfills/             → godot-angular/polyfills   裸 V8 补齐 + rAF 帧驱动（唯一副作用入口）
    test/                  rAF / 帧驱动 polyfill 的纯 Node 单测
  forms/                 → godot-angular/forms        输入控件的 CVA **指令**
    base.ts                GodotControlBase / GodotValueAccessorBase / GodotMouseDisabledBase
  testing/               → godot-angular/testing      TestBed 环境（引擎）/ 节点查询 / spy

packages/css/            ← **纯 JS，不许 import "godot"**（详见 css/README.md）
  parser / selector / ruleset / shorthand / mediaquery / vocabulary
  value/                 值解析：color / sides / tokens / keyword / length / shadow
  runtime/               只有运行期用：cascade / properties / vars / state / invalidation

packages/builder/        ← 构建相关（不是包，没有 package.json）
  builders.json            application / vitest 两个 builder
  application/             ng run <app>:build
  vite/
    build-core.ts          构建核心：多入口 glob、CJS 输出、res:// require 改写
    polyfill.ts            补丁当额外入口 + 在产物层把 require 写回每个入口顶部
    icu-downgrade.ts       `\p{...}`：transform 逐模块懒加载 babel 展开（只管正则字面量）
    godot-interop.ts       把发布物里的 default/namespace 形式的 godot 导入改写成裸 require
    options-schema.ts      两个 builder 的选项形状（valibot，schema 由它生成）
  vitest/build/            ng test —— 构建引擎入口并在同进程跑 vitest
  vitest/node/           → godot-angular/vitest            宿主侧插件（ESM .mjs）
  vitest/runtime/        → godot-angular/vitest/runtime    引擎侧 worker + 测试专用垫片
    setup.ts               process / TextEncoder / AbortController（只 vitest 要，Angular 不要）
    console-forward.ts     引擎 console 回传宿主
    transport.ts           WebSocketPeer 通道（STATE_OPEN===1 等怪癖都在这）
  shared/godot-bin.ts      二进制定位（只探工作区根的 bin/）+ --import 缓存戳
  shared/coverage.ts       构建期插桩与覆盖率 remap provider
  shared/engine-port.ts    端口口径：配置值是起始值，被占则 +1（监听先于构建，端口得先定下来）

  ⚠ vitest/node 与 vitest/runtime 里的 regexp-codec.ts 是**一对**，
    两边没有依赖关系（一个跑宿主 vitest，一个跑引擎 V8），改一边必须改另一边。

dist/                    ← **发布物**（ng-packagr 的库 + vite 的 builder 都落在这）
  fesm2022/ types/         库入口
  builder/                 builders.json + 两个 builder（含生成的 schema.json）+ vitest 两侧产物
  package.json             由 packages/library/package.json 生成
  godot-angular-<ver>.tgz  `npm pack` 的产物（就在被打包的目录里，npm 会排除同名文件）

demo/                    ← **模板**：Godot 工程 + 独立 Angular 工作区，整个目录可复制走
test-app/                ← **核心测试**：只吃发布物，不接触源码
tools/                   构建脚本（见第 12 节）
bin/                     引擎二进制（gitignore，放置说明见 bin/README.md）
docs/                    本文 + css-plan.md
```

根 `angular.json` 只有 `library`；demo 与 test-app 的 target 在各自的 `angular.json`。
纯 Node 测试的配置是根目录 `vitest.node.config.mts`；引擎测试**没有** vitest 配置文件，
配置由 builder 从 `angular.json` 生成。

---

## 2. 包设计：一个包，多个入口

包名 `godot-angular`，**不带 scope**：scope 的意义是"一族包共用一个命名空间"，而这里
只发一个包，加 scope 只会让每条 import 多打七个字，还得多配一次 registry 权限。

历史上拆过六个（`@control-ui-js/{core,forms,testing,godot-builder,vitest-pool}`），看着干净，
实际付出的是：同一个仓库里混着 CJS 包和 ESM 包（vitest/flatted 是 ESM-only，builder
必须能被 CLI 加载），跨包依赖要 `workspace:*` 一路声明，而 `ng-packagr` 二级入口
不能相对路径够兄弟目录，于是同一个常量/工具得在两个包里各放一份。更要命的是
**发一次版要发六次**，版本还得互相对齐。

现在收进一个包，边界改由**入口**而不是**包**表达：

**主入口是空的**：API 全在二级入口里，`import { … } from "godot-angular"` 一个名字都拿
不到；用什么就具体导入什么。为什么不能干脆没有主入口：一、ng-packagr 的 `lib.entryFile`
必填；二、二级入口只能按**入口名**互相引用，把 core 当主入口（主入口名恒等于包名）时，
forms / testing 里 `from "godot-angular/core"` 会被当成引用一个不存在的入口，当场构建失败。
所以 `packages/library/index.ts` 是个 `export {}` 的空壳，只占住主入口的位置。

| 入口 | 内容 | 为什么单独一个入口 |
| --- | --- | --- |
| `godot-angular/core` | 运行时 | 不含表单。**纯导出**：导入它不会改任何全局。样式运行时（StyleRuntime / applyStyle）也在这里：bootstrap 与 renderer 直接依赖它们，拆出去只会多一个"该导入哪边"的问题，产物一字节不少 |
| `godot-angular/polyfills` | 裸 V8 环境补丁 + 帧钟 | 本包**唯一**带副作用的入口。它零依赖 core 入口，才能被钉在依赖图最底下——Angular 在求值期就读裸 `performance`，而 GodotJS 是 CJS、rollup 把 require 全提到顶部，书写顺序在产物里不算数 |
| `godot-angular/forms` | CVA 指令 | 合进 core 入口会把 `@angular/forms`（约 380 kB）塞进每个产物 |
| `godot-angular/css` | CSS 子集的纯逻辑层（解析 / 级联 / 词表） | 构建期（builder 的 css-plugin）与运行期共用同一份，独立入口才能两边按包名引 |
| `godot-angular/testing` | 引擎侧测试工具 | 不进 app 产物 |
| `godot-angular/vitest` | 宿主侧 vitest 插件 | 只有 builder 引 |
| `godot-angular/vitest/runtime` | 引擎侧 vitest worker | 只有测试入口引 |

入口是**多级**的（`vitest/runtime`），所以"再拆一个包"随时可以做：把一个入口目录提成
独立 package.json 即可，代价就是上面那笔"发六次版"的账。当前不做。

`packages/builder/` 没有 package.json —— 它不是包，只是同一发布物里的另一棵产物树。

**判据**：测试/构建管道一律住 `packages/builder/`，不做成库的公开入口。判据是"谁消费"——
如果只有 builder 用（哪怕用字符串 specifier 引），它就是管道，不是 API。

### 构建顺序是有顺序敏感的

（`pnpm build` 已经串好了）：

```bash
ng build library          # ng-packagr：deleteDestPath 会先洗 dist，所以必须第一个
tsx tools/vite-build.ts   # vite preserveModules → dist/builder（会 rm dist/builder）
tsx tools/gen-schema.ts   # schema 写进 dist/builder/，必须在 vite-build 之后
tsx tools/build-cli-schema.ts  # 往 dist/package.json 的 exports 追加 config/schema.json
tsx tools/gen-html-data.ts     # 编辑器补全用的 html data
cd dist && npm pack       # tgz 落在 dist 里（消费方就装它）
pnpm --filter demo build  # 此时 godot-angular:application 才能解析到
```

⚠ tgz 住在 `dist/` 里，而 `build:lib`（ng-packagr 的 `deleteDestPath`）会先洗 `dist`。
所以**单跑 `pnpm build:lib` 之后工作区处于"没有 tgz"的空窗**：这期间任何
`pnpm install` 都会在解析阶段失败（pnpm 跑脚本前的隐式 install 也算，症状是
`sh: 1: ng: not found` 这种 `.bin` 被削掉后的怪错）。补一句 `pnpm build` 就好；
`refresh` / `build` / `test` 都以 pack 收尾，按根脚本走不会撞上。

### CJS / ESM 的分界线：Godot 会不会直接加载它

整个仓库只有一条格式规则：

| 产物 | 谁加载 | 格式 |
| --- | --- | --- |
| `demo/dist*/**.js` | Godot 直接当 Script 跑 | **必 CJS** |
| `dist/builder/**.mjs` | Angular CLI（`require(path)`）/ Node | ESM |
| `dist/fesm2022/*.mjs` | vite / rollup 打包时读 | ESM |

为什么 builder 不必为了"被 CLI `require`"而出 CJS：Node 的 **`require(esm)`** 让
`require()` 能加载 ESM，而 `@angular/cli@22` 的 engines 是
`^22.22.3 || ^24.15.0 || >=26.0.0`——全部 ≥ 22.12，所以只要 CLI 能跑，这能力就在。
已实测：把 builder 整体改成 `.mjs` 后，`ng run` 能正常加载并跑完整 AOT 构建。

⚠ 两个约：① `require(esm)` 遇到依赖图里任何 **top-level await** 会直接
`ERR_REQUIRE_ASYNC_MODULE`，升级 vite / @angular/build 时要留意；
② `builders.json` 的 implementation **必须写全扩展名** `.mjs`——`require` 的
扩展名探测只试 `.js/.json/.node`，不试 `.mjs`。

### 谁按包名解析 `godot-angular`，以及仓库根为什么不挂软链

`angular.json` 里写的是 `"builder": "godot-angular:vitest"`，而 Angular CLI 解析 builder
走的是**纯 Node 包解析**（`node-modules-architect-host.ts` 里
`localRequire.resolve(packageName + '/package.json', { paths: [basePath] })`），**不读
tsconfig**。`basePath` 是**使用方**的工程目录，所以这条需求由 `demo/` 与 `test-app/` 各自
node_modules 里那份 tarball 满足，跟仓库根无关。产物侧同理：builder 里的
`import "godot-angular/css"` 在打包时故意保持 external，跑起来由使用方解析（包内自引用
命中自己），实测 `pnpm --filter demo build` 里 css-plugin 正常干活。

仓库内唯一还需要"按包名找到类型"的地方是 `packages/builder` 的 `tsc`，而且只有三个站点：
`vite/css-plugin.ts` 引 `godot-angular/css`，`vitest/runtime/index.ts` 引
`godot-angular/polyfills` 与 `godot-angular/testing`（`vitest/build/virtual-entry.ts` 里那个
`godot-angular/vitest/runtime` 是写给用户产物的字符串，不是本包的 import）。它过去靠根
devDependency `"godot-angular": "link:./dist"`，现在改成 `packages/builder/tsconfig.json`
的 `paths` 按这三个说明符指到 `dist/types/*.d.ts`——删掉任一条，`tsc` 就在对应那行报
`TS2307`（实测）。理由：

- `link:./dist` 是把**构建产物当依赖声明**。干净 clone 里 `dist` 不存在，pnpm 不报错而是
  留下一条悬空软链（实测），于是真正的失败拖到 typecheck 才以 `TS2307` 出现。
- `link:` **不会装目标包的 dependencies**，所以根 devDependencies 得把库的依赖清单抄一份。
- 指 `dist/types` 而不是指回源码，保住了软链时代唯一的实质好处：类型消费的是外部用户
  真正拿到的那份产物（含 `exports` 映射），exports 写错当场就炸。

`paths` 只列本包自己 import 的那三个就够：产物内部的互引（`testing.d.ts` → `core` → `css`）
发生在 `dist/` 里面，由 `dist/package.json` 的 `exports` 自引用解析掉（实测
`--traceResolution`：`Entering conditional exports`）。注意别拿它当"能编译就行"的依据：
`skipLibCheck: true` 会把 .d.ts 内部的解析失败盖掉，所以这里是用 `--listFiles` 确认四个
`.d.ts` 真的进了 program，而不是只看退出码。

两个消费方 `angular.json` 的 `$schema` 指向 `./node_modules/godot-angular/...`（它们自己装的那份）：
`demo/` 是给人整个目录复制走的模板，`../node_modules` 在复制出去之后就不存在了。

---

## 3. 为什么需要这层 builder

| 事实 | 证据 |
| --- | --- |
| GodotJS 只认 CJS | 每个 `.js` 被包成 `(function(exports,require,module,__filename,__dirname){...})`，`export` 直接 SyntaxError；`.mjs` 一样被包；动态 `import()` 明确返回 `Error: Not supported` |
| 官方 `@angular/build:application` 只出 ESM | `format: 'esm'` 写死在 `@angular/build/src/tools/esbuild/application-code-bundle.js`，schema 里**没有任何** `format`/`cjs`/`umd` 选项 |
| 官方 `polyfills` 选项会额外产一个 chunk | 与"一个入口对应一个 JS 文件"的契约冲突，且那个 chunk 的位置不可控 |
| CJS 单文件形态下多入口无法共享代码 | 每个入口都得自带一份 Angular 运行时。实测两个页面各 ~950 kB；换成 vite 分包后入口各 < 1 kB，共享部分只有一份 |

早期版本走的是"官方 `buildApplicationInternal` + 落盘前 esbuild 转 CJS"，上面前三条就是
那时量出来的。换掉它的直接动机是第四行：CJS 单文件把分包堵死了。

三个承重的实现约束（改构建前先看）：

1. **`preserveEntrySignatures: "strict"`**。不开则 rollup 会把入口的具名导出当无用代码摇掉——
   demo 的 `create` 和整个 `App` 组件凭空消失，产物从 308 kB 缩到 206 kB，**一个错都不报**。
2. **`require("./chunk")` 必须改写成 `res://` 绝对路径**。GodotJS 把相对 require 解析成
   `res:/chunk`（单斜杠）然后找不到。`godotRequirePlugin` 在 `renderChunk` 阶段替换，
   并**断言替换次数**——模式没命中就报错，不静默放行。
3. **`output.exports: "named"`，不用 `"auto"`**。`auto` 在只有一个 default 导出时发
   `module.exports = Main`，而 GodotJS 从 `exports.default` 取脚本类。

### schema 是生成的

`tools/gen-schema.ts` 直接读依赖里官方 CLI 的 schema 再追加自有选项（不入库、不缓存，
升 CLI 自动跟着走），把本包两个 builder 的选项 schema 内联进去，并给它们各加一条
`target.oneOf` 分支（同时从兜底分支的 `not.enum` 里排除，否则 `oneOf` 命中两条、校验直接
失败）。于是 IDE 里的补全与官方一致。构建时的 schema 校验只覆盖【必填项】与（带强制转换的）
【类型】，未知键不拦。
`pnpm check:schema` 负责它没过期（当前：application 23 项、vitest 31 项）。

⚠ 这份 schema 只给编辑器用，**构建时拦不住拼错的选项名**：生成的 schema 没有
`additionalProperties: false`，而 valibot 的 `v.object` 对未声明键是**丢弃而不是报错**
（均实测：`bogusOption`、`styles` 配在 vitest target 上都是静默无效）。缺必填项会报错
（`Schema validation failed … must have required property 'resRoot'`），所以只有“必填项缺失”
这一种配错能被当场拦住。

选项形状的唯一来源是 `packages/builder/vite/options-schema.ts`（valibot）。
两条链路共用的字段写在 `sharedOptionFields` 里展开两次，不会出现"application 已加而
vitest 漏加"。

### 构建期不跑类型检查

实测：`ng build` 对 `.ts` 里的类型错误、模板里的未知属性、`strictTemplates: true` 一律
**不报错**（analog 插件的 diagnostics 没有接到 builder 的错误通道）。因此：

- 类型检查靠 `pnpm typecheck`（根脚本，逐包 `tsc --noEmit`）与编辑器；
- 模板诊断不会以编译错误的形式出现，写错模板往往在运行时才暴露；
- 最典型的例子是自闭合标签：`<Label />` 会让该组件的 AOT 定义静默缺失，构建成功，
  运行时才报 "needs to be compiled using the JIT compiler"。

---

## 4. 构建链路与顺序

见第 2 节"构建顺序"。补充两条链路上的行为：

**polyfill 是虚拟入口。** builder 生成一个只含 `import "godot-angular/polyfills";`（加上
`polyfills` 选项追加的项）的虚拟模块，作为额外入口参与构建，再在产物层把
`require(那个 chunk)` 钉到每个业务入口的第一行。因此使用方不需要在自己的源码里写任何
polyfill import，也关不掉它。

**`fileReplacements` 不能用 vite `resolve.alias` 实现。** alias 比的是**未解析的说明符**
（`./env`），而 `fileReplacements` 给的是文件路径，正则永远不命中，且不报错——构建照样
成功，只是默默没换。必须走 `resolveId`（analog 插件已实现，builder 直接把选项透传给它）。

**每个 builder target 独占一个 `outputPath`。** 构建是 `emptyOutDir` 的，两个 target 共用
一个目录会互相抹掉（实测跑完 `pnpm test` 再跑 demo 就找不到 `main.js`）。

**未暴露的 vite 能力走 `viteConfig`。** 用户配置叠加在 builder 之上，plugins 是**追加**
不是替换——builder 自己的 polyfill / res:// require / ICU 那几个承重插件顶不掉。

---

## 5. 工作区与发布物

**分发状态：尚未发布到 npm**（`npm view godot-angular` 返回 404）。对外分发单位是
`dist/godot-angular-<ver>.tgz`，由 `pnpm build` 产出。README 面向使用者写的是
`npm install godot-angular`，发布后即为真实行为；在那之前，仓库内的 `demo/` 与 `test-app/`
用 `file:../dist/godot-angular-<ver>.tgz` 装本地产物，因此 `demo/` 直接复制出去时，
**需要把 `godot-angular` 那行依赖改成版本号**（或先 `pnpm build` 后指向 tgz 路径）。

`demo/` 与 `test-app/` 是**两个独立的 Angular 工作区 + 两个独立的 Godot 工程**，
各自一份 `angular.json`，都只通过 `file:../dist/godot-angular-*.tgz` 用库 ——
**它们碰不到源码**。为什么必须这样：

- 做 builder 的项目不能又当 builder 的使用方，否则"发布物自不自足"永远测不到
  （软链时代 `dist/` 里少一个文件也没人知道）。装 tarball 之后，"用户只拿到发布物"
  那条路是日常在跑的，不是 publish 之后才发现。
- `demo/` 是给人复制走的模板（clone → install → F5），里面不该有测试基础设施；
  核心测试全在 `test-app/`。

根脚本一律 `pnpm --filter demo|test-app <task>` 进去执行。

### 为什么第一步是 `pnpm bootstrap` 而不是 `pnpm install`

`demo/` 与 `test-app/` 依赖的是发布物 `file:../dist/godot-angular-<ver>.tgz`，而它跟
`dist/` 里其余东西一样是构建产物、不进版本库。干净 clone 里那个 tgz 不存在，
`pnpm install` 会在解析阶段失败；而 tgz 又得靠 node_modules 里的 ng-packagr 才建得出来
—— 没依赖无法构建、没构建无法安装。`bootstrap` 从中间剪断：

```bash
pnpm install --filter .   # 只装根工程：不解析那两个消费方，tgz 缺席也无所谓
pnpm run gen:typings      # 引擎 .d.ts（被 gitignore）
pnpm run build         # dist/ 与 dist/godot-angular-<ver>.tgz
pnpm install              # 此时 tgz 已在，全工作区一次装齐
```

装过一次之后就恢复正常手感：日常 `pnpm install` / `pnpm refresh`，`bootstrap` 只在
**首次**或换了引擎版本时跑。（`pnpm install --filter .` 不会改写 lockfile，实测过。）

⚠ 本机 pnpm store 里若已有同内容的包，缺 tgz 的 `pnpm install` 也可能"看起来成功"
（实测：从缓存解出目录，构建照跑）。判断干净环境行为时别把 store 命中当成通过。

### 根脚本自带"重新构建 + 安装"

`demo` / `test-app` 不读 `packages/` 源码，它们 `node_modules` 里的是 `dist/*.tgz`
解出来的那份。所以根层的 `test` / `test:fast` / `build` / `pages` 一律先跑
`refresh`（= 重编库 + 重编 builder + `npm pack` + `pnpm install`）再干活——
**根脚本不存在"跑了个旧构建"这种状态**。

⚠ 现状：`test` 与 `test:fast` 的脚本内容目前**完全相同**（都含 `refresh`），
"只改了 spec 就不重建"的快路径尚未实现。要分步控制，直接
`cd test-app && npx ng test`（或 `ng run demo:pages`），但得自己保证 `pnpm refresh` 过了。

### 测试工具是自举的

`pnpm test` 的最后一步解析 `godot-angular:vitest` 走 Node 包解析，拿到的是 `dist/builder/`
里**刚编译出来那份**。所以测试工具本身是被测链路的一部分，不存在"跑的是源码、发布的是产物"
两套行为。同一个 builder 就是发布给第三方用户跑测试的那个。

---

## 6. 测试架构

### 只有两层

引擎真机（test-app + demo 两份入口）与纯 Node，**没有第三层“假引擎”测试**。
| 层 | 位置 | 规模 | 能证明什么 |
| --- | --- | --- | --- |
| 引擎真机 spec | `test-app/src/tests/engine/*.spec.ts` | 611 项 / 34 文件 | 真 GodotJS 进程里跑真 vitest：模板 / 变更检测 / 信号 / 表单 / 容器真实布局 / ClassDB 怪癖，以及 CSS 文本进 `get_theme_*` 出的值语法穷举 |
| 引擎真机 spec（demo） | `demo/src/tests/engine/*.spec.ts` | 1 项 | 跑真 demo 整棵树（含只有真引擎才会算的容器布局） |
| 纯 Node | `packages/library/polyfills/test/`、`packages/builder/vite/test/` | 95 项 / 9 文件 | 我们自己那套 rAF / 帧驱动的语义、builder 选项解析与产物改写（临时目录造夹具，不碰仓库源码） |

引擎层里 `demo-app.spec.ts` 跑的是**真 demo 整棵树**，其余 spec 用内联小组件验单个机制。

### 为什么只有引擎一层（不要 Node 替身层）

这里曾经有过一整套假 ClassDB / 假 godot 命名空间 + 跑在 `environment: node` 的 TestBed
用例。它被删过一次，理由至今成立：

1. **替身会骗人，而且已经骗过两次**：
   - `usableControlClasses()` 在真引擎里直接抛异常——`get_inheriters_from_class` 返回
     **PackedStringArray**（无 `.length`、不可迭代），替身返回普通数组，永远测不出。
   - `(change)` 在 OptionButton 上绑错信号——OptionButton 继承 Button，同时有 `toggled`
     和 `item_selected`，候选表里 `toggled` 排前面，下拉选择静默失效。替身的 ClassDB
     没模拟这层继承。

   两次症状都是"Node 全绿、进引擎才炸"。
2. **替身能验的，引擎层全部能验而且更强**：同一个断言在真节点上成立，比在假节点上成立
   严格。所以"多一层快测试"在这里不省任何东西，只多一份会过期的引擎假象。

代价是内循环：改库代码要重建引擎入口（约 9s）。换来的是只有一套测试 API、一个 runner、
一个环境。

### 用例写法就是标准 Angular TestBed

```ts
beforeEach(() => initGodotTestEnvironment());     // 每个用例一个真 Control 根节点

it("signal 改动会落到真节点", async () => {
  await TestBed.configureTestingModule({
    imports: [MyComp],
    providers: [
      { provide: ComponentFixtureAutoDetect, useValue: true },
      provideZonelessChangeDetection(),
    ],
  }).compileComponents();

  const fixture = TestBed.createComponent(MyComp);
  await fixture.whenStable();
  expect(fixture.nativeElement.get_child(0).text).toBe("...");   // 真 Godot 节点
});
```

`godot-angular/testing` 只干三件事：给 TestBed 搭环境（`initGodotTestEnvironment` /
`GodotTestingModule`）、节点查询（`findAllNodes` / `nodeTexts`）、等引擎真帧（`awaitFrames`，
布局与 queue_free 用）；等变更检测一律用官方的 `fixture.whenStable()`，不另造等待函数。
**没有自研的 render helper**：以前那个 `renderInEngine()` 自己 bootstrap 应用，绕开了
TestBed，使引擎用例和浏览器用例写成两套，已删。

环境里三处不是随手写的（文件头有完整理由）：`TestComponentRenderer` 替掉 DOM 版（引擎没
document）、`ɵINJECTOR_SCOPE: "root"`（否则 `providedIn:"root"` 全报 NG0201）、
`globalThis.Node` 装一个谁都不匹配的空类（`getDebugNode` 第一行就 `instanceof Node`）。

### vitest 自定义 pool

spec 被 AOT 编译进引擎侧入口，在**真引擎进程**里由 vitest 自己收集并执行，结果回传后走
标准 reporter。builder 构建完在**同进程**里 `startVitest`（照官方
`@angular/build:unit-test` 的做法，见 angular-cli `runners/vitest/executor.ts:428`），
不是 spawn `npx vitest`。所以 reporter / 过滤 / 退出码是 vitest 原生的，而配置只有一份。
想自己接 vitest（比如接 watch 插件）也可以：`godotEngineTest()` 就是个普通 vite 插件，
塞进自己的 vitest 配置的 `plugins` 即可。

**为什么不是 vitest 的 browser provider。** 因为 provider 换不掉页面那层。vitest 把
"页面框构"和"驱动浏览器"分了两层：tester 页（Vite dev server + `/__vitest_test__/` +
ESM client）是 browser mode 的固定地基，url 在 vitest 内部是**写死的**
（`new URL("/__vitest_test__", viteOrigin)`），provider 只能"把某物导航到这个 url"，
模块图由目标自己走。而引擎实测：`fetch` 无、`XMLHttpRequest` 无、`HTTPRequest` 类在但
`request()` 抛 Bad argument、动态 `import()` 返回 `Not supported`——连第一个模块都拿不到。

所以走**自定义 pool**：pool 的契约就是"给我一批文件，你负责跑并回结果"，完全不假设页面
存在，这才是"不要页面"的那个扩展点。宿主照常跑 vitest，只是"执行一个文件"变成往
WebSocket 发一条 `WorkerRequest`。

**入口和 spec 清单都是构建期合成的虚拟模块，使用方工程里一个文件也不用写。** builder 把
入口合成为虚拟模块 `virtual:godot-angular/vitest-entry`（polyfill 在产物层注入、场景类在
`godot-angular/vitest/runtime` 里），产物名固定 `vitest-entry.js`——`.tscn` 是按名字找脚本的。
spec 清单**内联在同一个模块里**（`const __CUJ_SPEC_MODULES__ = {...}`），由 `resolveId` +
`load` 现做。表项必须是 `() => import(...)` 而不是静态 import：vitest 靠
`runner.importFile()` 的**求值时机**收集用例，提前求值一个用例也收不到。手写清单一定会和
vitest 的 `include` 漂移，症状是"宿主说要跑一个文件，引擎说没编进去"。

两段历史都已废弃：往源码树写 `__generated-specs.ts`（旧清单残留、glob 改了没重跑、两个
worktree 打架，全是脏状态），以及让每个使用方手抄一份场景脚本。现在 `angular.json` 里连
`entries` 都不用配，使用方也无需 `declare module`——`virtual:` 说明符只存在于 builder 生成的
代码里。

**glob 只有一个来源：`angular.json` 的 `specInclude`。** builder 与 vitest 同进程，把它直接
当 `include` 传下去，所以配置里不会出现第二份 glob。

### 引擎缺的东西（测试运行时的垫片清单）

- **用 `WebSocketPeer`，不是 `WebSocketClient`**。Godot 4 把 Godot 3 的
  `WebSocketClient`/`WebSocketServer` 换成了统一的 `WebSocketPeer`。GodotJS 里前者
  **not found**、后者**可用**。`HTTPRequest` 类暴露了但功能没接上（三种传参全
  `result=2`，宿主一次都没收到）。
- **`STATE_OPEN === 1`**，不是 3；`STATE_CLOSED` 是 3 而不是 2。按错值判断会永远等不到
  就绪（表现是"连上了但一条不发"，服务端那边却显示 client connected）。
- **`WebSocketPeer` 不发信号**，必须逐帧 `poll()`。所以引擎侧场景脚本每帧 `session.tick()`。
- **`outbound_buffer_size` 默认 65535**，vitest 一次性回传大结果会溢出。发送前要排空。
- **无 `TextEncoder`/`TextDecoder`** → 测试运行时用 `@nberlette/utf8` 显式装到
  `globalThis`。这里原本是一把手写的，拿原生对拍 19 项错 7 项（畸形输入静默出错字、
  lone surrogate 编成非法 UTF-8）。换包前在**真引擎里**跑过四个候选的对拍（手写 12/19、
  `fast-text-encoding` 12/19 且 `require()` 在引擎里静默失效、
  `fastestsmallesttextencoderdecoder` Node 构建加载即崩、`@nberlette/utf8` 16/19）。
  选定后**不单独设测试**：第三方 polyfill 的职责就是默默把字节编对，真坏了引擎侧每条
  vitest 消息都过它，当场就跑不起来。两个硬约束：必须**显式取导出自己挂**（靠副作用装
  全局的包在引擎里会静默失效，因为 `window`/`global` 都是 undefined）；必须走**子路径**
  import（根入口的 `export *` 名字撞车，拿到的类行为会偷变）。
  ⚠ **它属于测试侧，不在 `core/polyfills.ts`**：要 TextDecoder 的是 `vite/module-runner`，
  不是 Angular。放进应用 polyfill 会让每个应用白背依赖（实测 +33KB）。应用侧的判据只有
  一条：Angular（含 renderer）实际读它吗？读了才装。
- **无 `Event`/`EventTarget`** → 同样在测试运行时里。`abortcontroller-polyfill` 发 abort
  事件时要 `new Event("abort")`，vitest 的模块预加载失败路径也构造 `Event`；缺了它们引擎侧
  直接 `worker 处理失败: ReferenceError: Event is not defined`。Angular 一处不读（动画路径
  要的是 `CustomEvent`，而 `document.documentElement` 缺失使 `areAnimationSupported` 恒假，
  整条路径不执行），所以应用侧不装。
- **无 `AbortController`** → 同样在测试运行时里。缺了它 vitest 的 `createTestContext` 直接
  `ReferenceError`，所有 spec 全在收集阶段挂掉。包一层子类是为了补上"重复 `abort()` 是
  no-op"（ponyfill 会重复发 abort 事件）。`DOMException` 也得跟着补：ponyfill 的
  `AbortSignal.timeout()` 要 `new DOMException(...)`，缺了时 `timeout()` 在定时器里抛
  ReferenceError 且**信号永不 abort**（实测 30ms 后 aborted 仍为 false）——静默失效比报错难查。
- **flatted 不认 RegExp**：`-t "信号"` 传到引擎会变成 `{}`，名字过滤**静默失效**（不报错，
  只是全量跑了一遍）。`regexp-codec.ts` 只包 `context`（config/files），不给每秒几十上百条的
  任务更新帧做深度遍历。
- **垫片必须早于 vitest/chai 求值**。ESM 的 import 会被提升，把安装语句写在别的模块体里
  **无效**。所以测试运行时的 `setup.ts` 是 `runtime/index.ts` 的**第一行 import**，
  且必须是独立模块。
- **引擎里的 `console` 会转发到宿主**（`packages/builder/vitest/runtime/console-forward.ts`）。
  以前 stdout 只在失败/超时时回显——"spec 全绿但中间一行 warn 说中了真正问题"完全看不见。
  现在宿主实时打印并统计。
- **ICU 降级**：GodotJS 的 V8 不带完整 ICU，`\p{...}` Unicode 属性转义在**解析期**就炸
  （语法级缺失，运行时补不了）。展开表用 babel 的
  （`@babel/plugin-transform-unicode-regex`，底下是 regexpu-core 的完整 Unicode 表），
  不再手写——手写的三行 ASCII 近似对非 ASCII 标识符语义就是错的。
  **只管写死在源码里的正则字面量**，一个 `transform` 钩子（`enforce: "post"`）搞定：
  - post 拿到的是 analog 编译完的 JS（实测命中模块 7,766 B，整个 chunk 是 857,553 B，
    在 chunk 上跑 babel 贵 110 倍）；在 pre 会看到带装饰器的原始 TS。
  - `new RegExp("\\p{Foo}")` 这种字符串拼的、`new RegExp(userInput)` 这种变量拼的，
    **一律放过，不报错也不复查**。前者不是解析期炸，是运行到那一行构造时才炸，而且可能
    永远跑不到；静态拦它等于拦合法代码。计数只数一次（给日志），展开完不回看。

  没命中时只多两次 `String.includes`，babel 连 import 都不会发生（实测零命中构建 = 基线）。

### 超时为什么都压得这么短

引擎侧的 teardown 语义就是"连接断开"，没更多东西可等。宿主真去等引擎回 `stopped` 必撞
竞态（引擎可能先退了，也可能微任务排到下一帧才发），实测表现是每次白等一个
`teardownTimeout`（10s）。现在 `PoolWorker` 对 `start`/`stop` 都**就地合成响应**（转发照旧发，
但不拿它当屏障）。配套：`connectTimeout` 120s→30s（引擎冷启动含 `--import` 实测 2~4s）、
引擎 idle 120s→30s、`teardownTimeout` 2s。

结果：引擎 spec 从"含超时 130s+"降到 0.42s（含构建约 9s）。

---

## 7. 覆盖率

插桩发生在**构建期**，对象是发布物，报告再经产物自带的 source map remap 回源码。

**为什么不能直接用 vitest 自带的 v8 provider。** 两个理由都是硬的：

1. v8 provider 靠 CDP 采样，GodotJS 的 V8 没开 inspector，也没有能连的地址；
2. 更要紧的是**引擎里跑的不是源码**。test-app 装的是 `dist/*.tgz` 解出来的发布物，引擎执行
   的是 `node_modules/godot-angular/fesm2022/*.mjs`。不管 v8 的字节码偏移还是 istanbul 的
   statementMap，都得先落到**真正被执行的那份代码**上，否则拿到的数字与跑过的代码无关。

链路：

```
构建（宿主）  coverageInstrumentPlugins（发布物那份跑在 vite enforce:"pre"）把进了 bundle
              的发布物模块逐个交给 istanbul-lib-instrument，counter 落在 globalThis.__CUJ_COVERAGE__

执行（引擎）  每个 spec 文件跑完，取 __CUJ_COVERAGE__ 的**增量**，用 vitest 原生的
              rpc.onAfterSuiteRun({coverage, testFiles, projectName}) 发给宿主

汇总（宿主）  一个自定义 coverage provider：给每份上报挂上发布物自带的 .map 当
              inputSourceMap，转交 @vitest/coverage-istanbul remap，报告里的键变回 packages/**.ts
```

**插桩那份为什么必须是 `enforce: "pre"`**：Angular 的 linker 会把发布物里的 `ɵɵngDeclare*`
静态属性改写成 `ɵdir` / `ɵcmp` 运行时定义，行号全变（实测 forms 入口 553 行 → 491 行），
而它**不交 source map**（`mappings: ""`）。在 linker 之后插桩，istanbul 记的语句位置是
"linker 产物"坐标，而侧车 `.mjs.map` 说的是"发布物原文"坐标，两边对不上，remap 会把语句
归到同 bundle 里另一个源文件头上（实测 `forms/color.ts` 整块被算进 `choice.ts`，前者在报告
里永远 0%）。先插桩、linker 再改写，counter 是普通语句，改写后照样执行，而位置已经记在
coverage 对象里。（`instrument` 里显式写的文件相反，得等 analog 把 .ts 编完再插，所以插件
拆成两份。）

几个不显然的点：

- **插发布物而不是源码**：test-app 只准碰发布物。好处是报告口径 = 用户实际跑的代码，
  被 tree-shake 掉的东西不会假装被覆盖。代价是这份报告只对"手上同时有库源码"的人有意义，
  所以它默认关，靠环境变量 `CUJ_COVERAGE_PACKAGE=1` 开（`pnpm test` 已用 `cross-env` 带上；
  `FOO=1 cmd` 那种写法 Windows 的 cmd 不认）。外部用户装了发布物但手上没有库源码，插它只会
  得到一份关于 `.mjs` 的报告，还白胖产物（实测 3.14MB → 4.39MB）。
- **必须是增量上报**：vitest 把多个文件打包成一次 `run` 请求，等 suite 结束再取就只有一份
  总和，谁跑过哪一段全丢了；`onFileFinished` 才是真正的每文件钩子。取完把 counter 归零，
  否则后一份会把前一份的命中数重复累加。没跑到的文件整条不发——条目里的 statementMap 比
  计数大得多，全量发一遍是几百 KB（引擎 WS 的 `outbound_buffer_size` 默认才 64KB）。
- **remap 靠"同尾查找"**：provider 先按产物路径找同名侧车 `fesm2022/x.mjs.map`（没侧车才去
  读文件尾的 `//# sourceMappingURL=`），解析出 `sources`；但 map 里写的 `../../packages/...`
  是相对**打包时的 dist**，装进 node_modules 后同样的相对式指向 `node_modules/packages/...`，
  而且发布包根比 dist 少一层——按相对式推算一换布局就错。所以改成在 `sourceRoot` 下从最长
  尾巴开始试，第一个存在的同尾路径就是它，把 `sources` 改写成真实绝对路径后当
  `inputSourceMap` 挂上，istanbul 自己完成重映射。
- **include 在 remap 之后才生效，exclude 是逐文件匹配**：istanbul 自己的 include 是对**产物**
  路径匹配的，而产物在 node_modules 里、源码在 packages 下，两边对不上。所以 provider 在
  remap 完拿到源码路径后再自己筛一遍：include 用 `tinyglobby` 展开（基准 workspaceRoot，
  `../` 能越出去），exclude 用 `picomatch` 对"相对 workspaceRoot 的路径"逐个比 —— glob 的
  基准是 cwd，`**/*.spec.ts` 在 test-app 下根本隔不到 `../packages/**`，逐文件匹配才能
  "不管文件在哪都排得掉"。node_modules 无条件排除。
- **报告只包含真跑到的文件**：配了 `include` 之后，范围内没进 bundle 的源文件（被
  tree-shake 掉、或根本没人 import）不会出现在报告里。代价是分母只算"跑到的"，数字比
  传统 `coverage.all: true` 那份好看，看报告时心里要把没跑到的那些补回去。
- **连应用代码一起统计**（`instrument: ["src/**/*.ts"]`）：发布物的 `.mjs` 旁边有 `.map`，
  宿主直接拿它当 inputSourceMap；应用代码没侧车，构建插件就把 `this.getCombinedSourcemap()`
  （analog 的 .ts→JS 那份）交给 istanbul，跟着条目一起回传。map 对同一个文件只发一次。
  这条路的行号是 analog map 的精度，个别行会偏（实测 app.ts 39 个语句偏 1 行）。
- **外部用户没源码也能用**：`sourceRoot` 下找不到源文件时 provider 自动退回"按发布物出报告"，
  而不是交一份空报告。
- **provider 是委托而不是重写**：reporter、thresholds、临时文件、`reportOnFailure` 全是
  vitest 原生的（`coverage.provider: "custom"` + `customProviderModule`），我们只负责
  "挂 map"和"remap 后再过滤"。

三个路径字段各自的地盘（都相对 workspaceRoot）：

| 字段 | 管什么 | 默认 |
| --- | --- | --- |
| `include` / `exclude` | 哪些**源文件**计入报告（remap 之后才筛） | 不配 = 只统计真跑到的 |
| `instrument` | 额外插桩谁（用户自己的代码写这里） | 空 —— 发布物也不插 |
| `sourceRoot` | remap 落点：产物 map 里的相对式挂到哪个目录下 | `..` |

当前数字（`pnpm test`，只有引擎那一份，44 个源文件）：
Statements 96.94% / Branches 91.38% / Functions 96.41% / Lines 98.33%。
剩下没打到的分支集中在两类：防御性早退（传 null / 残缺节点）与"宿主已经有这个 API"的兜底
（GodotJS 里永远走不到另一侧）。报告在仓库根 `coverage/`（html + `lcov.info` +
`coverage-summary.json`，已在 .gitignore）。跑完宿主会打一行对账：
`覆盖率：34 份上报，73 个文件关联到 map，报告中 44 个源文件` —— remap 没命中时报告会是空的，
这行是唯一能区分"真没跑到"和"remap 失败"的线索。

分母里两个包，但只有一份报告：`include` 是 `packages/library/**` + `packages/css/**`，
两个包**都在引擎里真跑**。CSS 的值语法穷举也已经改成真机 spec
（`test-app/src/tests/engine/css-*.spec.ts`）。css 包**没有自己的 Node 套件**：它的每一行
都跑在引擎里，就应当在引擎报告里被验。为什么必须在 GodotJS 里跑而不是 Node：CSS 这条链路
的终点是 Theme / 节点属性，GodotJS 的绑定层（属性写不写得进去、theme item 叫什么）只有
真机能证明。

---

## 8. GodotJS / V8 的已证实行为

写库代码时的依据，全部来自引擎实测而非文档推断。使用者需要遵守的那部分已提炼进 README
的「限制」与「排错」。

1. `.js` 脚本按 CommonJS 执行，脚本类要在 `exports.default` 上（vite 的
   `exports: "named"` 输出自动满足）。
2. `require("./x")` 是坏的，会拼成 `res:/x`；**只能用 `res://` 绝对路径**。
   `require("res:\\x")` 也失败——`res://` 即使在 Windows 上也必须正斜杠。
3. `require("sub/dep")`（裸名）**能用**，所以分包可行，前提是把相对说明符全量改写成绝对形式。
4. `godot` 模块是 Proxy，取未知键抛异常（`Error: godot class not found 'xxx'`）。由此：
   - `import { Label, ClassDB } from "godot"` —— 只用这种。产物是 `require("godot")` +
     逐处 `godot.Label()`，惰性取属性，不经 interop 包装，**没有任何前提条件**。
   - `import godot from "godot"` —— 类型上没问题（synthetic default 生效），但带两个前提：
     ① 产物里会多出 `godot = __toESM(godot, <flag>)`，这个 flag 决定它会不会去读
     `godot.__esModule`（Proxy 读到未知键直接抛 → 模块加载即失败）。flag 由"导入方是否被
     当作 ESM"决定，隔离实验实测：

     | 导入方 package.json `type` | 入口扩展名 | flag | 结果 |
     |---|---|---|---|
     | 无 | `.ts` | 省略 | ❌ `godot class not found '__esModule'` |
     | `commonjs` | `.ts` | 省略 | ❌ 同上 |
     | `module` | `.ts` | `1` | ✅ |
     | 无 / `commonjs` | **`.mts` / `.mjs`** | `1` | ✅ |

     即：`.mjs`/`.mts` 扩展名 **或** `type: "module"` 才给 flag。同一个 bundle 里它和具名
     import 不能共存：共享绑定被改写成 interop 包装后，具名用法全变 undefined。
   - **想让 `__toESM` 不出现，没有开关可调**（均实测）：tsconfig 的
     `esModuleInterop` / `allowSyntheticDefaultImports` / `verbatimModuleSyntax` / `module` /
     `moduleResolution` 六种组合产物完全一致；vite 侧 `output.interop` / `output.esmExternals`
     被直接拒绝（`Invalid key: Expected never`）。唯一办法是**不制造 default-import-external
     边界**。
   - `import * as godot from "godot"` —— 不可用。interop 对模块做求值期属性拷贝，拷不到
     惰性暴露的类 → `class Main extends godot.Node` 报 `Class extends value undefined`。
   - `import type * as Godot from "godot"` —— 只要类型不要值时用这个：编译后完全消失，
     不产生任何 interop。
   - 按运行时字符串取类（`ns[className]`）具名形式表达不了，本库收敛在
     `core/godot-host.ts` 的 `godotClass()` 里，用**函数内裸 `require("godot")`**。
     库自己的 FESM 里那处 default/namespace 形式由 builder 的 `godot-interop.ts` 在产物层
     改写成裸 require。
5. 生成的类型有缺口：`Node.name` 运行时存在但 `godot*.gen.d.ts` 里没声明。补丁由
   `pnpm gen:typings` 写进 `typings/godot.gap-patch.d.ts`（四处共用一份）；上游哪天补了，
   重跑会变成重复声明报错 —— 那就是删补丁的信号。
6. 信号只能连 `Callable`，直接传 JS 函数报
   `Failed to convert JS variable to Variant. Expected: Callable. Found: function`。
   正确写法（`Callable.create` 的 owner 必须是 Godot 对象，`{}` / `null` 抛 bad object）：
   ```js
   const callable = Callable.create(node, cb);
   node.some_signal.connect(callable);
   node.some_signal.disconnect(callable);   // 不缓存 callable 就断不开
   ```
7. 裸 V8 缺 `document` `window` `navigator` `location` `requestAnimationFrame`
   `queueMicrotask` `performance` `Event` `EventTarget` `Intl` `fetch` `structuredClone`
   `localStorage` `process` `Buffer`（有 `setTimeout`/`Promise`/`Proxy`/`Map`/`Set`）。
   `godot-angular/polyfills` 只补**真被读到**的四项：`queueMicrotask`（调度器直接调用）、
   `requestAnimationFrame`（zoneless + 帧钟）、`performance`（`performance?.mark?.()` 的
   可选链**挡不住未声明的标识符**）、`document`（`getDocument()` 拿不到就 NG0210）。
   `navigator` `location` `structuredClone` `MutationObserver` `PerformanceObserver` 一类
   "看着像浏览器"的全局**故意不补**：读它们的代码位置要么被 `typeof` 挡住、要么根本被
   tree-shake 掉，而空实现只会让依赖它们的第三方库看起来能跑、实际静默失效。
8. `ClassDB` 和 GDScript 的同名 API 不同签名：没有 `class_has_property`；
   `class_get_property_list(cls, true)` 的 `includeInherited` **被忽略**，得自己走
   `get_parent_class`；返回的数组可 `for...of` 但不是 JS 数组，元素是 Dictionary，
   只能 `.get("name")`。
9. 另一些 API 返回 **PackedStringArray**（如 `ClassDB.get_inheriters_from_class`），行为又
   不一样：**无 `.length`、不可 `for...of`、不可展开**，只有 `.size()` 和 `.get(i)`。
   `[...(x ?? [])]` 会直接 `is not iterable`。两种容器统一走 `registry.ts` 的
   `toStringArray()`，别在调用点直接展开。
10. 给不存在的属性赋值**静默接受**（写成一个普通 JS 键，读回来还是那个值）。所以渲染器会用
    `ClassDB` 校验属性存在性并告警 —— 拼错属性名是本项目最容易踩的隐形 bug。
11. 模板里的**静态属性**（不带中括号）永远是字符串，而 Godot 属性强类型：
    `<HSlider min_value="0">` 会直接报 `Failed to call: set_min … Unable to convert JS string
    to Godot float`。渲染器现在按 ClassDB 声明的类型转（string→数字/bool，number→string），
    所以 `font_size="28"`、`editable="false"` 这类写法能直接用；转不动的原样交给引擎报错，
    不静默吞。
12. 对已有父节点的节点再 `add_child`，引擎只打 ERROR 不抛异常，渲染器必须自己先摘。
13. 改了 `.js` 但引擎不重新加载 → 什么都不打印，需要 `--import` 刷缓存。
    `pnpm demo` / `pnpm test` 用入口哈希戳自动处理了（`shared/godot-bin.ts` 的 `ensureImported`）。
14. `OS.has_cmdline_arg` 没暴露，命令行开关用 `OS.get_environment()` 传（demo 的
    `CUJ_MODE=snapshot`）。
15. **库必须用 ngc + `compilationMode: "partial"` 编译，不能用裸 `tsc`**。裸 tsc 不生成
    Angular 库元数据，消费方 AOT 认不出依赖里的 `@Directive`，报 NG2012。
16. 无显示环境（CI / 无头）下 `DisplayServer` 全是 dummy 值：`screen_get_size()` → `(0,0)`、
    `is_dark_mode()` 恒 false。媒体查询的测试只能断言"注入值 → 命中/不命中"，真实窗口尺寸
    与系统暗色模式属**待实机确认**，不许在汇报里说成已验证。

---

## 9. 构建与 Angular 侧的已证实行为

1. **`preserveEntrySignatures: "strict"` 是必须的**。不开则入口具名导出被摇掉，无错无警告。
2. **vite 的 `rollupOptions.output` 会校验键名**，传 `interop` 直接
   `Invalid key: Expected never but received "interop"`。想绕 interop 只能从源头绕（见上节）。
3. **每个 builder target 独占一个 `outputPath`**（构建是 `emptyOutDir` 的）。
4. `angularCompilerOptions` 是 tsconfig **顶层键**，塞进 `compilerOptions` 里 tsc 报 TS5023。
5. **`strictTemplates` 目前关掉，且实际不起作用**（builder 不跑模板类型检查，见第 3 节）。
   历史上开它的动机是：Angular 的模板类型检查把**它不认识的标签**一律当 DOM 元素——不开
   `dom` lib → `TS2584: Cannot find name 'document'`；开了 → `<LineEdit (input)>` 被当 DOM
   input，`$event` 推成 `InputEvent`，而 Godot 的 `text_changed` 给的是 `String`。正解是给
   每个 Godot 控件声明带类型的 directive（NativeScript-Angular 的作法）。在那之前 `lib`
   **不包含** `dom`。
6. 用 `ɵinternalCreateApplication` 而不是 `bootstrapApplication`（后者绑死浏览器平台）。
   代价是要自己补上 `BrowserModule` 原本提供的东西，缺一个就 NG0201/NG0402：
   `ɵINJECTOR_SCOPE: 'root'`（**根因**）、`ErrorHandler`、`APP_ID`。
7. 生产构建会把 `ngDevMode` 整段剥掉，Angular 错误只剩 `NG0201` 没细节。调试用
   `pnpm build:dev`（development 配置）才有完整消息。
8. 块注释里**不要写 `*/` 序列**（比如 glob `src/**/*.ts`——`**/` 里就含 `*/`，会把注释提前
   闭合）。已踩四次，而且症状不一样：源码里 esbuild 报 PARSE_ERROR，而写在
   `vitest.node.config.mts` 的注释里时，配置能"加载"但语法已碎，报的是
   `ReferenceError: test is not defined`，完全看不出原因。
9. **`packages/library` 的两份 tsconfig 分工不能合**。`tsconfig.lib.json` 是 ng-packagr 的
   **emit** 配置（有 `rootDir`），给它写 `"godot-angular/css": ["../css/index.ts"]` 必撞
   **TS6059**，而且生成的声明会引用源码路径，发布物就漏了。`tsconfig.json` 只服务
   `typecheck:lib` 与编辑器（noEmit），它**必须**把 css 指回源码：`dist/` 是 gitignore 的
   产物，新克隆里没有，不指回去就是满屏 **TS2307** + 连带一片 TS7006 implicit any。
   TS6059 的真元凶是 `rootDir` 而不是 `paths`，noEmit 下 `rootDir` 纯属空转。
10. **css 是二级入口，只能用包名引**。library / builder 里写 `from "../css/parser"` 不会
    报错，但 css 源码会被卷进库的 fesm 产物，`./css` 这个入口白设（只能靠约定）。
11. 改完库一定要确认构建真的过了：构建失败时 `dist/` 保留旧产物，下游（引擎 spec / demo）
    会**静默跑旧代码**。别把构建输出 `>/dev/null` 掉再根据结果下结论。
12. `--check-only` 在引用 autoload 的项目里用不了这类"单独编译一个文件"的坑同理适用于这里：
    任何"只编译目标文件、不带上依赖"的工具，先确认它给不给解析包名说明符。
13. **构建期 CSS lint 会在 Angular 改写 `:host` 之前检查原文**，于是组件 `styles` 里的
    `:host { … }` 会收到一行“伪类 ":host" 在 Godot 侧无对应落点，整条选择器已忽略”的**误报**
    （实测）。运行时 `:host` 是真的能落地（Angular 编译成 `[_nghost-*]` 属性选择器，
    `css-angular.spec.ts` 里有断言）。要消除误报得让 lint 认得 `:host`，而不是去掉运行时支持。

---

## 10. 跨平台

Linux 与 Windows 都必须能跑，差异全部集中在 `tools/` 与 `packages/builder/shared/`：

- **`res://` 永远正斜杠**（实测 Windows 上反斜杠加载失败），且它**永远区分大小写**
  （不走宿主 FS 的不敏感匹配），所以 `.tscn` / `require()` 里的写法必须与磁盘一致。
- 引擎二进制按 `<workspaceRoot>/bin/<平台目录>/<可执行文件>` 预置（仅检索工作区根目录，
  不向上级目录搜索），`GODOT_BIN` / `engine.godotBin` 可覆盖，且两者指**目录**时会自动按平台表
  补子目录与文件名 —— 所以 `demo/angular.json` 写一份 `"../bin"` 两个平台都能用。
  平台映射表在 `packages/builder/shared/godot-bin.ts` 的 `BIN_TABLE`。
- Windows 上 `pnpm` 是 `pnpm.cmd`，`spawnSync` 要带 `shell: isWin`。
- 从 `import.meta.url` 取路径只用 `fileURLToPath`，**不要** `.pathname`
  （Windows 上给 `/C:/...`，fs 不认）。
- 消费方 `node_modules/godot-angular` 那一层链接（tarball 解出来的目录）全部交给 pnpm，
  跨平台（含 Windows junction）由它自己处理，不手写 `symlinkSync`；仓库根不挂软链。
- 根脚本用 `pnpm --filter demo <task>` 而不是 `cd demo && ...`，两个 shell 都对。

平台支持现状：

| | 情况 |
| --- | --- |
| Linux x86_64 | 全部在此环境实跑验证（含 `bin/` 自动发现、bootstrap 全流程） |
| Windows x64 | `bin/windows-editor-4.6.1-v8/godot.windows.editor.x86_64.exe` 已预置映射，工具脚本做了跨平台修正，但**未在真 Windows 上跑过** |
| macOS / 其他 | 未预置映射（未验证过资产名），用 `GODOT_BIN` 指定即可 |

---

## 11. 手动运行引擎

```bash
# 下面用 $GODOT 代指引擎可执行文件
# （Windows 换成 bin\windows-editor-4.6.1-v8\godot.windows.editor.x86_64.exe）
GODOT=bin/linux-editor-4.6.1-v8/godot.linuxbsd.editor.x86_64

# demo（打印节点树）
CUJ_MODE=snapshot "$GODOT" --headless --path demo

# 多入口示例（场景是位置参数，不是 --scene）
"$GODOT" --headless --path demo res://pages.tscn

# 引擎真机 spec：**不要直接跑 res://engine_vitest.tscn**，它要宿主先起 WS server。
# 正确入口是 pnpm test（它会构建 + 拉引擎 + 跑 + 关闭）

# 开真窗口（需要显示环境）
"$GODOT" --path demo
```

改了 `demo/dist/*.js` 之后引擎**什么都不打印**，是脚本资源缓存没刷新。自动戳没生效时手动兜底：

```bash
"$GODOT" --headless --path demo --import
```

---

## 12. 内部工具脚本

| 脚本 | 作用 |
| --- | --- |
| `tools/vite-build.ts` | 构建 `packages/builder`（vite preserveModules → `dist/builder`） |
| `tools/gen-schema.ts` | 读官方 CLI schema + valibot 形状，生成两个 builder 的 `schema.json` |
| `tools/build-cli-schema.ts` | 把本包 builder 挂进 `dist/builder/config/schema.json` 的 target 分支 |
| `tools/gen-typings.ts` | 调引擎 `--generate-types`，同步四处 `typings/`（对外即 `npx godot-typings`） |
| `tools/gen-html-data.ts` | 生成 VSCode 用的 html data（模板补全） |
| `tools/check-schema`（`pnpm check:schema`） | 断言生成的 schema 与形状源一致 |
| `tools/run-demo.ts` | 用引擎跑 demo 并打印节点树（`--window` 开真窗口） |
| `tools/dump-vocabulary.ts` | 从引擎导出 Godot 主题词汇表 → `packages/css/vocabulary.data.ts` |

`pnpm gen:typings` 跑的是引擎自带的 codegen（不是第三方工具，也不是
`--dump-extension-api` 那份 JSON 再加工）：

```bash
godot --headless --editor --path <工程> --generate-types
```

两个实测才知道的点：`--editor` 不能省（只给 `--generate-types` 会被当普通参数忽略，
直接去跑主场景）；产物只跟引擎版本有关，跟工程内容无关（空工程生成的与 demo 工程生成的
逐字节相同），所以工具用一个临时空工程。它把 18 个 `.d.ts` 同步到 `demo/typings`、
`test-app/typings`、`packages/library/typings`、`packages/builder/typings` 四处，
**换引擎版本后要重跑**。

类型进 program 的方式是 `typeRoots` + `types`（不是 `/// <reference>`）：

```jsonc
"typeRoots": ["./typings"],
"types": ["godot"]
```

为什么不用 `include`/`files` 收 `.d.ts`：库侧走 ng-packagr，它把 `rootNames` 覆盖成单个入口
文件，`include` / `files` 在它的 emit 配置里根本不参与，只有 `compilerOptions` 这条路走得通。
⚠ `typeRoots` 一旦写出就**顶掉**默认的 `node_modules/@types` 搜索根，需要 `@types/node` 的地方
（`packages/builder`）得把它一起列上。两行必须成对，写错不会静默：指错目录或名字打错都是
`TS2688 Cannot find type definition file for 'godot'`；两行全删则是
`TS2307 Cannot find module 'godot'`。

---

## 内部约束清单（约定，不在代码里强制）

- **`packages/css` 是纯 JS，不许碰引擎**。它同时在 Node（builder 构建期抽样式）和
  GodotJS（运行时级联）里跑：`import "godot"` 在 Node 里直接解析失败，而引擎单例
  （`DisplayServer` / `Engine` / `Os`）在无头下全是 dummy 值，读到的东西看着像真的。
  需要窗口尺寸 / 暗色模式这类环境，由调用方算好再注入（见 `mediaquery.ts`）。
- **引 css 一律走包名 `godot-angular/css`**，不许用相对路径伸进 `packages/css/`：
  那样会把 css 源码卷进库的 fesm 产物，`./css` 二级入口白设，而且产物层面不报错。
- **测试/构建管道不做成库的公开入口**（判据见第 2 节）。
- 生成目录（`typings/`）必须留 `.gdignore`：重写是整目录删除，生成器靠
  `.gdignore` + `*.gen.d.ts` 认出"这确实是生成目录"，指到源码目录（或根目录）会直接拒绝
  而不是删掉它。
