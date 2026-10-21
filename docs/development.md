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
    css-runtime.ts         StyleRuntime：把纯包的 Cascade 接到节点树，并接上刷新调度
    style-scheduler.ts     刷新调度：只有 effect 一条路（injector 由应用传入）
    style-target.ts        CSS 声明 → Godot theme 落点（实现 css 包的 StyleBackend）
  forms/                 → godot-angular/forms        输入控件的 CVA **指令**
    base.ts                GodotControlBase / GodotValueAccessorBase / GodotMouseDisabledBase
  testing/               → godot-angular/testing      TestBed 环境（引擎）/ 节点查询 / spy
    style-scheduler.ts     测试专用脚手架：独立根 injector / 同步 flush effect / newStyleRuntime()

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
                           ← `test-app/` 就靠 `"godot-angular": "link:../dist"` 软链它

test-app/                ← **核心测试**：只吃发布物，不接触源码
tools/                   构建脚本（见第 12 节）
bin/                     引擎二进制（gitignore，放置说明见 bin/README.md）
docs/                    本文 + css-plan.md
```

根 `angular.json` 只有 `library`；test-app 的 target 在它自己的 `angular.json`。
纯 Node 测试的配置是根目录 `vitest.node.config.mts`；引擎测试**没有** vitest 配置文件，
配置由 builder 从 `angular.json` 生成。

两边各管一段，同一个断言只保留一份：

- **引擎测试**（`test-app/src/tests/engine/`）：凡是需要真引擎才能判定的，全部在这边。
  典型是「某条 CSS 声明到底写了哪个主题属性」「状态盒是怎么组成的」「上一轮的值有没有被
  撤掉」。断言只看节点上的主题覆盖与节点属性，不看像素。需要自动刷新时机的用例用
  `godot-angular/testing` 的 `newStyleRuntime()` 建运行时（内部传入一个独立 injector，走的
  是和生产同一条 effect 链路）；`new StyleRuntime()` 不传 injector 时不安排自动刷新，
  只能手动 `flush()`。
- **Node 测试**（`packages/css/test/`）：只留纯算法与内部成本探针 —— CSS 解析、特异度
  比较、标脏范围、`hasNodeProperty` 调用次数。这些量在引擎侧没有对应的可观察出口，搬过去
  只会变成无法断言或断言无意义。判据是“这个事实的最终表现在哪”：凡终点是节点属性的，
  就在引擎里用真节点断言——刷新调度的契约（多次标记合并为一次、回调未被执行时不残留
  已调度状态、effect 的实际时机）在
  `test-app/src/tests/engine/css-scheduler-contract.spec.ts` 里读真 `Label` 的 theme
  override 断。Node 里只能拿假 backend 记录写入流水，而“流水里有”不等于“节点上写进了”。

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
tsx tools/gen-emmet-snippets.ts # Emmet 标签补全 snippets.json（两者共用一次引擎导出）
pnpm --filter test-app test  # 此时 builder 才能按包名解析到（消费方视角的端到端）
```

消费方（`test-app/`）写的是 `"godot-angular": "link:../dist"`，pnpm 的 **`link:` 协议**
（`node_modules/godot-angular` 就是指向 `../dist` 的软链）。没有 pack / 重命名这一步，
也就没有"文件名里那个版本号每次升版都要回来改一行"；锁文件里只记 `version: link:../dist`，
**既不记版本号也不记校验和**，所以 `dist/package.json` 升版连 `--frozen-lockfile` 都不用放宽。

`link:` 比 `file:../dist`（目录型，install 时复制）好在两处，这两处都是实测：

- **`pnpm install` 根本不碰 `dist/`**：不读、不复制、不解析。`dist` 不存在也照装（软链先
  建着，build 完就通了），所以干净 clone 不再需要"先 `--filter .` 装根工程、build 完再装
  一遂"那套两步式。
- **重建即生效**：软链是活的，`pnpm build` 之后不需要再 `pnpm install`。`refresh` 就是 `build`。

⚠ 三个得知道的：

1. `link:` **不会装目标包的 `dependencies`**：`dist/package.json` 里那些依赖是从
   `<root>/node_modules`（根 `devDependencies`）解析的。所以**改发布物的 dependencies
   时必须同步根 devDeps**，否则 builder 运行期才 module not found。（当前已核对：
   `packages/library/package.json` 的 dependencies 全部能在根 devDeps 找到。）
2. 软链会被解成 realpath（`<root>/dist/...`），所以库里的 `import "@angular/core"` 会从根
   `node_modules` 解析，而不是 test-app 那份 —— 单例靠 builder vite 配置里的
   `resolve.dedupe: ["@angular/core"]` 兜（`preserveSymlinks` 选项可覆盖）。
3. 测的是 `dist/` 目录本身，不是 `npm pack` 的 tarball，所以 `.npmignore`（发布物里那份）
   漏没漏东西这条路测不出来。真要 publish 前验一手，`cd dist && npm pack` 把 tgz 装上跑一遍。

⚠ `build:lib`（ng-packagr 的 `deleteDestPath`）会先洗 `dist`，这期间软链是悬空的；
但 `pnpm install` 不受影响（见上），只是别在 build 中途跑 `pnpm test`。

### CJS / ESM 的分界线：Godot 会不会直接加载它

整个仓库只有一条格式规则：

| 产物 | 谁加载 | 格式 |
| --- | --- | --- |
| `test-app/dist*/**.js` | Godot 直接当 Script 跑 | **必 CJS** |
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
tsconfig**。`basePath` 是**使用方**的工程目录，所以这条需求由 `test-app/`
自己 node_modules 里那份指向 `dist/` 的软链（`"godot-angular": "link:../dist"`）满足，跟仓库根无关。产物侧同理：builder 里的
`import "godot-angular/css"` 在打包时故意保持 external，跑起来由使用方解析（包内自引用
命中自己），实测 `pnpm --filter test-app test` 里 css-plugin 正常干活。

仓库内唯一还需要"按包名找到类型"的地方是 `packages/builder` 的 `tsc`，而且只有两个站点：
`vite/css-plugin.ts` 引 `godot-angular/css`，`vitest/runtime/index.ts` 引
`godot-angular/testing`（帧钟不再按包名引：补丁模块已住在 `vite/polyfills.ts`，相对路径就
到）。`vitest/build/virtual-entry.ts` 里那个
`godot-angular/vitest/runtime` 是写给用户产物的字符串，不是本包的 import）。它过去靠根
devDependency `"godot-angular": "link:./dist"`，现在改成 `packages/builder/tsconfig.json`
的 `paths` 按这三个说明符指到 `dist/types/*.d.ts`——删掉任一条，`tsc` 就在对应那行报
`TS2307`（实测）。理由：

- `link:./dist` 是把**构建产物当依赖声明**。干净 clone 里 `dist` 不存在，pnpm 不报错而是
  留下一条悬空软链（实测），于是真正的失败拖到 typecheck 才以 `TS2307` 出现。
- `link:` **不会装目标包的 dependencies**，所以根 devDependencies 得把库的依赖清单抄一份。
- 指 `dist/types` 而不是指回源码，保住了软链时代唯一的实质好处：类型消费的是外部用户
  真正拿到的那份产物（含 `exports` 映射），exports 写错当场就炸。

⚠ 上面那条"干净 clone 里 `dist` 不存在 → 悬空软链 → 失败拖到 typecheck 才报 TS2307"在
消费方一侧仍然存在（`test-app` 就是 `link:../dist`），现在的兼法是“根脚本先重建”：
`pnpm test` 走 `refresh`（= `build`），`pnpm typecheck` 也把 `pnpm run build` 排在最前面，
所以两个入口都不会在"没构建"的状态下跑。单跑 `pnpm typecheck:builder` 不在此列。

`paths` 只列本包自己 import 的那三个就够：产物内部的互引（`testing.d.ts` → `core` → `css`）
发生在 `dist/` 里面，由 `dist/package.json` 的 `exports` 自引用解析掉（实测
`--traceResolution`：`Entering conditional exports`）。注意别拿它当"能编译就行"的依据：
`skipLibCheck: true` 会把 .d.ts 内部的解析失败盖掉，所以这里是用 `--listFiles` 确认四个
`.d.ts` 真的进了 program，而不是只看退出码。

消费方 `angular.json` 的 `$schema` 指向 `./node_modules/godot-angular/...`（它自己装的那份），
不写 `../node_modules`：工程目录得能独立存在，`../node_modules` 在仓库之外就不存在了。

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
   入口的 `create` 和整个 `App` 组件凭空消失，产物从 308 kB 缩到 206 kB，**一个错都不报**。
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

- 类型检查靠 `pnpm typecheck`（根脚本，先 `pnpm run build` 再逐包 `tsc --noEmit`）与编辑器；
- 模板诊断不会以编译错误的形式出现，写错模板往往在运行时才暴露；
- 最典型的例子是自闭合标签：`<Label />` 会让该组件的 AOT 定义静默缺失，构建成功，
  运行时才报 "needs to be compiled using the JIT compiler"。

---

## 4. 构建链路与顺序

见第 2 节"构建顺序"。补充两条链路上的行为：

**polyfill 是虚拟入口。** builder 生成一个只含 `import "godot-angular/builder/vite/polyfills.mjs";`
（加上 `polyfills` 选项追加的项）的虚拟模块，作为额外入口参与构建，再在产物层把
`require(那个 chunk)` 钉到每个业务入口的第一行。因此使用方不需要在自己的源码里写任何
polyfill import，也关不掉它。补丁实现本身是构建器的普通文件（`vite/polyfills.ts`），不是库入口。

**`fileReplacements` 不能用 vite `resolve.alias` 实现。** alias 比的是**未解析的说明符**
（`./env`），而 `fileReplacements` 给的是文件路径，正则永远不命中，且不报错——构建照样
成功，只是默默没换。必须走 `resolveId`（analog 插件已实现，builder 直接把选项透传给它）。

**每个 builder target 独占一个 `outputPath`。** 构建是 `emptyOutDir` 的，两个 target 共用
一个目录会互相抹掉（实测跑完 `pnpm test` 再构建应用入口就找不到 `main.js`）。

**未暴露的 vite 能力走 `viteConfig`。** 用户配置叠加在 builder 之上，plugins 是**追加**
不是替换——builder 自己的 polyfill / res:// require / ICU 那几个承重插件顶不掉。

---

## 5. 工作区与发布物

**分发状态：尚未发布到 npm**（`npm view godot-angular` 返回 404）。对外分发单位就是
`dist/`（发布时 `cd dist && npm publish`，或先 `npm pack` 出 tgz）。README 面向使用者写的是
`npm install godot-angular`，发布后即为真实行为；在那之前，仓库内的 `test-app/`
用 `link:../dist` 软链本地产物。

`test-app/` 是**独立的 Angular 工作区 + 独立的 Godot 工程**，自己一份 `angular.json`，
只通过 `link:../dist` 用库 —— **它碰不到源码**。为什么必须这样：

- 做 builder 的项目不能又当 builder 的使用方，否则"发布物自不自足"永远测不到。
  `link:../dist` 吃的是**构建产物**，`packages/` 源码依旧碰不到：`dist/` 里少一个文件
  当场就炸。但它测的是 `dist/` 目录，**测不到 `npm pack` 那一层**（见上一节），
  真要 publish，发布前手动装一次 tgz 验。
- 测试基础设施全在 `test-app/`，`packages/` 里不养另一套入端测试。

根脚本一律 `pnpm --filter test-app <task>` 进去执行。

### 第一步就是 `pnpm install`

以前要先 `pnpm install --filter .` 再 build 再装一遂，是因为消费方依赖的是
`dist/` 这个构建产物，而 pnpm 解析阶段就要读它；干净 clone 里它不存在，install 直接挂。
改成 `link:../dist` 之后这事没了：pnpm 对 `link:` 只是建个软链，**不要求目标存在**
（实测：`rm -rf dist` 后 `pnpm install` 照样 Done）。所以干净 clone 就是：

```bash
pnpm install          # 消费方软链指向不存在的 dist 也无所谓
pnpm run gen:typings  # 引擎 .d.ts（被 gitignore）
pnpm run build        # dist/：软链落地，消费方立刻看得到
```

日常手感：改了库/ builder 就 `pnpm refresh`（= `pnpm build`），**不需要重安装**。

### 根脚本自带"重新构建"

`test-app` 不读 `packages/` 源码，它通过软链吃 `dist/` 那份产物。所以根层的
`test` 一律先跑 `refresh`（= 重编库 + 重编 builder）再干活——
**根脚本不存在"跑了个旧构建"这种状态**。

⚠ 现状：`test` 与 `test:fast` 的脚本内容目前**完全相同**（都含 `refresh`），
"只改了 spec 就不重建"的快路径尚未实现。要分步控制，直接
`cd test-app && npx ng test`，但得自己保证 `pnpm refresh` 过了。

### 测试工具是自举的

`pnpm test` 的最后一步解析 `godot-angular:vitest` 走 Node 包解析，拿到的是 `dist/builder/`
里**刚编译出来那份**。所以测试工具本身是被测链路的一部分，不存在"跑的是源码、发布的是产物"
两套行为。同一个 builder 就是发布给第三方用户跑测试的那个。

---

## 6. 测试架构

### 引擎真机 + 纯 Node，没有“假引擎”层

引擎真机（test-app 那份入口）与纯 Node，**没有第三层“假引擎”测试**。
| 层 | 位置 | 规模 | 能证明什么 |
| --- | --- | --- | --- |
| 引擎真机 spec | `test-app/src/tests/engine/*.spec.ts` | 902 项 / 50 文件 | 真 GodotJS 进程里跑真 vitest：模板 / 变更检测 / 信号 / 表单 / 容器真实布局 / ClassDB 怪癖，以及 CSS 文本进 `get_theme_*` 出的值语法穷举；其中 6 项是像素级验证，无头下自动跳过 |
| 纯 Node | `packages/{css,library,builder}/**/test/` | 218 项 / 20 文件 | 我们自己那套 rAF / 帧驱动的语义、builder 选项解析与产物改写（临时目录造夹具，不碰仓库源码） |

引擎层里 `app-sample.spec.ts` 跑的是**示例 App 的整棵树**，其余 spec 用内联小组件验单个机制。

### 像素级验证（`visual-pixels.spec.ts`，需要显示环境）

引擎真机 spec 断言的对象全部是**节点属性**：`has_theme_color_override("font_color")` 为真、
`get_theme_color(...)` 分量正确。但“属性已写入”不等于“屏幕上有对应像素”，两者确实会分离：
实测的一例是——为 Button 写入 `font_hover_color` 覆盖后属性断言全部通过，而 Button 依据
**真实鼠标位置**选择绘制状态，鼠标不在其上方时不会读取该 item，屏幕上没有任何变化。

`test-app/src/tests/engine/visual-pixels.spec.ts` 用于补上这一段：在真实窗口里渲染一个组件，
读取窗口实际画出的图像，统计指定节点画面矩形内目标颜色的像素数量。它和其它引擎 spec 一起跑，
不是独立脚本。操作工具在 `godot-angular/testing` 的 `Screen`：

| 能力 | 方法 | 无头下 |
| --- | --- | --- |
| 定位 | `byName` / `byText` / `byClass` / `byType` | 可用 |
| 输入注入 | `click` / `hover` / `typeText` / `pressKey` | 点击与键盘可用；`hover` 靠移动真实指针，无头下不动 |
| 读取像素 | `screenshot` / `countColor` / `hasColor` / `savePng` | 直接报错，不返回空图 |
| 等待 | `settle` / `waitFor` / `waitForColor` | 可用 |

```bash
cd test-app && ../node_modules/.bin/ng test                          # 有头（默认），含像素用例
cd test-app && ../node_modules/.bin/ng test --configuration=headless  # 无头，像素用例自动跳过
```

有头还是无头由 angular.json 测试目标的 `engine.headless` 决定，默认 false（有头）。同一套用例
有头比无头慢约 5 秒（本机 5.7s → 11.7s），为此起一条独立链路不划算，所以两套跑的是同一条。

这些断言遵循几条约定，修改时不要破坏：

- **颜色只取纯色原色 / 二次色**（红蓝青黄品红）。Godot 的 UI 颜色要经过 sRGB ↔ 线性转换，
  只有 0 与 1 两个端点转换后不变；取中间值（绿 200）读回的数值会偏移，断言必须放宽容差。
- **每条“必须存在”都配一条“必须不存在”**。只断言存在无法验证撤销，
  `03-class-off` / `05-hover-off` 才是撤销逻辑的证明。
- **统计像素数量而不是取单点**。文字只占节点矩形的一小部分，取中心点大概率落在文字间隙上。
- **用 `waitForColor` 轮询，而不是固定等几帧**。`_process` 在本帧绘制之前执行，截图取到的是
  上一帧的画面；指针事件从窗口系统送过来还要多花几帧，且帧数不稳定。固定等两帧实测会
  间歇性误报，轮询到颜出现（超时上限 60 帧）才不会拿偶发慢一帧当失败。
- **悬停使用 `Input.warp_mouse()` 实际移动指针**，而不是 `emit_signal("mouse_entered")`。
  后者只能让样式层写入颜色，无法验证按钮是否按悬停状态绘制。
- **有头专属用例用 `describe.skipIf(!isHeaded())` 包起来**。需要真实指针或真实渲染的断言
  （`:hover` 合成态到底画哪一支、贴图是否真画出来、悬停冒泡在真实事件下成不成立）写在各自
  的 spec 末尾，无头下整组跳过而不是静默通过。写这种用例前先问一句：它验的是不是
  「引擎真的会这么做」——只验「我们往对的 item 写了值」的话，属性级断言更快也更稳。
- **不得改动共享状态**。整个套件共用一个引擎进程与一个窗口，以下三处已经踩过：
  1. 不要改窗口尺寸（`Viewport.size`），布局影响会泄给其它文件；测试根尺寸取默认窗口的
     一半以内即可。
  2. 注入过全局样式表（`provideGlobalCss`）的文件必须在 `afterAll` 里调
     `resetGlobalCssCache()`，否则 `readGlobalCss()` 的缓存会把这条规则给后面每个运行时重注一遍。
  3. 指针停在某个控件上时，引擎会给后来建在该位置的控件发真实的 `mouse_entered`，依赖悬停
     状态的用例会随机失败。`initGodotTestEnvironment()` 已在每个用例开始时把指针移到窗口右下角。

CI 侧不需要单独的工作流：`publish.yml` 的 ubuntu job 就是开 Xvfb（1280x720）后直接跑
`pnpm run test:ci`，像素用例与其它用例同批跑，截图作为 artifact 上传（失败时也上传）。
`mesa-vulkan-drivers` 提供 lavapipe（CPU 实现的 Vulkan），所以 runner 没有 GPU 也能跑；
开跑前有 `check-display-and-vulkan` 步骤先确认分辨率与 Vulkan 设备，缺任一项直接报错退出
——否则 Godot 报的是“创建表面失败”一类的间接错误，看不出是环境问题。

runner 没有 GPU 不影响这件事：lavapipe 报 Vulkan 1.4 / `PHYSICAL_DEVICE_TYPE_CPU`，满足
Forward+ 的要求。本地强制只用 lavapipe（`VK_ICD_FILENAMES=/usr/share/vulkan/icd.d/lvp_icd.json`）
跑过，引擎输出 `Using Device #0: Unknown - llvmpipe`，断言全过。**不要改成 `opengl3`
+ `gl_compatibility`**：那验的是项目根本不发布的渲染器，而颜色断言是在 Forward+ 的 sRGB
转换下校准的。

windows job 跑 `--configuration=headless`：runner 上的软件 Vulkan 不可靠，而像素用例在无头下
会自动跳过，其余 896 项照常跑。本地没有显示环境时也用这个配置。

`visual-out/` 里必须留一个 `.gdignore`（已进版本库）：截图就存在工程目录内，没有这个文件时
`--import` 会把上一轮的 PNG 当贴图导入，导入完成后退出会崩。

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
- **无 `Event`/`EventTarget`** → 测试运行时里装（`event-target-shim`）。vitest 的模块预加载
  失败路径构造 `Event`，`abortcontroller-polyfill` 发 abort 事件也要 `new Event("abort")`；
  缺了它们引擎侧直接 `worker 处理失败: ReferenceError: Event is not defined`。Angular 与
  `@angular/router` 一处不读（动画路径要的是 `CustomEvent`，而 `document.documentElement`
  缺失使 `areAnimationSupported` 恒假，整条路径不执行），所以**应用侧不装**。
- **无 `AbortController`** → **应用侧与测试运行时都装**，两边消费者不同：
  - 测试运行时：缺了它 vitest 的 `createTestContext` 直接 `ReferenceError`，所有 spec 全在
    收集阶段挂掉。`DOMException` 得跟着补：ponyfill 的 `AbortSignal.timeout()` 要
    `new DOMException(...)`，缺了时 `timeout()` 在定时器里抛 ReferenceError 且**信号永不
    abort**（实测 30ms 后 aborted 仍为 false）——静默失效比报错难查。
  - 应用侧：`vite/abort-shim.ts`（零依赖手写，不引包的理由写在该文件头）。消费者是
    `@angular/router`——每轮导航一个 `AbortController`，而它抛的 ReferenceError 会被路由
    自己吞掉（见第 9 节第 20 条），症状是“点了不跳转、不报错、不发事件”。
    ⚠ 这一项曾经**只装在测试运行时**，于是引擎测试全绿而应用里路由是死的。应用侧的判据
    仍只有一条：Angular（含 router）实际读它吗？读了就装，并且装在应用侧。
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
2. 更要紧的是**引擎里跑的不是源码**。test-app 通过软链吃的是 `dist/` 那份发布物，引擎执行
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
   补丁模块（`builder/vite/polyfills.ts`）只补**真被读到**的四项：`queueMicrotask`（Angular
   zoneless 调度器调用）、
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
    `pnpm test` 用入口哈希戳自动处理了（`shared/godot-bin.ts` 的 `ensureImported`）。
14. `OS.has_cmdline_arg` 没暴露，给入口脚本传开关只能用 `OS.get_environment()`
    走环境变量（引擎 argv 里没有能读的口子）。
15. **库必须用 ngc + `compilationMode: "partial"` 编译，不能用裸 `tsc`**。裸 tsc 不生成
    Angular 库元数据，消费方 AOT 认不出依赖里的 `@Directive`，报 NG2012。
16. 无显示环境（CI / 无头）下 `DisplayServer` 全是 dummy 值：`screen_get_size()` → `(0,0)`、
    `is_dark_mode()` 恒 false。根窗口自身也不是 `(0,0)` 而是 `64×64`（4.6.1 / 4.8-dev6 实测
    一致），所以无头下媒体查询会静默落在窄屏分支。但**坐标系换算不依赖显示**：自己
    `new Window()` 再设 `content_scale_*` 与 `size`，`get_visible_rect()` 与子 `Control.size`
    在无头下就是真值，`css-media.spec.ts` 靠这个在 CI 里断言了内容缩放与挂载点区域（含
    `Control.resized` 驱动的重算）。真实窗口拖拽尺寸
    与系统暗色模式仍属**待实机确认**，不许在汇报里说成已验证。
17. **引擎对"未处理的 promise rejection"的口径比浏览器宽**。一个 promise 在 reject 的那一
    瞬间手上没有处理器，就刷一行 `unhandled promise rejection`，**不看下一句有没有接**。
    最小复现：`const p = Promise.reject(new Error("x")); p.catch(() => {});` 在引擎里照样
    报错，浏览器控制台则是静默的。

    靠异常控制流的库会撞上它：`@angular/router` 试匹配候选路由时抛 `NoMatch`，下一句就被
    `catch`，但每次导航仍多一行 `unhandled promise rejection: NoMatch`。**不影响行为**，
    导航结果在 `test-app/src/tests/engine/router.spec.ts` 里逐条断言过。看到这类日志先查
    同一条链路上的断言到底有没有失败，别被它带偏。
18. **Godot 信号不携带事件对象**。`BaseButton.pressed()` / `button_down()` / `focus_entered()`
    零参数，引擎文档里括号内就是空的；DOM 那种“每个监听器都收到一个 MouseEvent”在 Godot
    不存在。但“谁触发的”仍然知道：`Callable` 绑在具体节点上，模板里每个元素有自己的闭包。
    需要真的输入事件（坐标 / 双击 / 修饰键）时去绑 `Control.gui_input(event: InputEvent)`，
    那个信号确实递 `InputEvent`——只是 `pressed` 把它丢掉了。

    结论：**`$event` 的实参个数永远等于引擎信号的参数个数，不做任何补偿**。`pressed()` 零参数
    就是 `undefined`。曾经为了 `RouterLink` 补过一个事件对象，但那是拿全局语义换一个小功能：
    库内 `css-pseudo` 驱动 `:checked` 用的就是 `args !== undefined` 这类“信号到底递没递东西”
    的判断，凭空多一个参数就是改变已有行为。

    `RouterLink` 因此**不支持**，两条退路都实测过：

    - 继承覆写 `onClick` 不行。`core/src/render3/features/inherit_definition_feature.ts` 的
      `inheritHostBindings` 是**合并**（先跑 `superHostBindings(rf, ctx)` 再跑子类那份），
      没有覆盖机制；报错在 Angular 生成的 `RouterLink_click_HostBindingHandler` 里，根本
      进不到 `onClick`。实测：子类已 `override onClick`，仍原样抛 `reading 'button'`。
      另外 `RouterLink` 的 `router` / `route` 是 `private`，子类连 `this.router` 都拿不到。
    - 自己写一个 `[routerLink]` 替身指令能跳转，但 `RouterLinkActive` 会失效：它靠
      `@ContentChildren(RouterLink)` 找链接，而 `di.ts` 的 `locateDirectiveOrProvider` 用
      `def.type === token` **精确相等**匹配，不走 `instanceof`，子类与替身都查不到。

19. **GodotJS 缺的宿主 API 比想象的多**，实测 `typeof` 全是 `undefined`：`URL`、
    `URLSearchParams`、`atob`、`TextEncoder`、`TextDecoder`。V8 只提供 ECMAScript，这些都是
    宿主 API（Node / 浏览器各自自己给的）。后果：`new URL("/detail/7")` 直接
    `TypeError: g.URL is not a constructor`，`atob("aGVsbG8=")` 直接 ReferenceError。

    ⚠ 这类缺口很容易漏：手写解析时 `new TextEncoder()` 写在函数里、只在编码非 ASCII 时才碰，
    路径全 ASCII 就永远撞不到；换成真库后它变成**加载期**行为，缺口才暴露。“测试没红”
    不等于“没用到”。

    现在补的：`atob` 在 `builder/vite/atob-shim.ts`，实现取 `base-64`（MIT、零依赖），
    不手写 —— 手写第一版在合法输入上全对，却在畸形路径上静默出错，是拿 Node 原生 `atob`
    差分才拓出来的（见第 9 节第 17 条）。`URL` / `URLSearchParams` 在 `polyfills`（装
    `whatwg-url-minimum`，见第 9 节第 17 条）。`TextEncoder` / `TextDecoder` 引擎测试运行时
    会装（`@nberlette/utf8`，vitest 消息编解码要用），但库自己不再需要它们，所以没进
    `polyfills` —— 没有真实消费者的补丁不补。

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
11. 改完库一定要确认构建真的过了：构建失败时 `dist/` 保留旧产物，下游（引擎 spec）
    会**静默跑旧代码**。别把构建输出 `>/dev/null` 掉再根据结果下结论。
12. `--check-only` 在引用 autoload 的项目里用不了这类"单独编译一个文件"的坑同理适用于这里：
    任何"只编译目标文件、不带上依赖"的工具，先确认它给不给解析包名说明符。
13. **构建期 CSS lint 会在 Angular 改写 `:host` 之前检查原文**，于是组件 `styles` 里的
    `:host { … }` 会收到一行“伪类 ":host" 在 Godot 侧无对应落点，整条选择器已忽略”的**误报**
    （实测）。运行时 `:host` 是真的能落地（Angular 编译成 `[_nghost-*]` 属性选择器，
    `css-angular.spec.ts` 里有断言）。要消除误报得让 lint 认得 `:host`，而不是去掉运行时支持。
14. **`DOCUMENT` 不需要 provide**（与直觉相反）。它是 `@angular/core` 里一个无 factory 的
    裸 token，浏览器下由 `platformBrowser` 提供（`platform-browser` 的 `provide: DOCUMENT`），
    看起来像“不用 BrowserModule 就必须自己补”的那一类。但本项目的装配链里**没人**
    `inject(DOCUMENT)`：

    - `Title`（唯一会注入它的常规消费者）只被 `DefaultTitleStrategy` 用，而 `route.title`
      已改走 `GodotTitleStrategy`；
    - `PathLocationStrategy` 的 `href ?? getBaseHrefFromDOM() ?? inject(DOCUMENT).location` 走
      `??`，而 `GodotPlatformLocation.getBaseHrefFromDOM()` 返回**空串**（非 nullish），
      链路到它就断了；
    - `ViewportScroller` 的默认工厂确实 `inject(DOCUMENT)`，但我们给的是 `ɵNullViewportScroller`。

    实测：删掉 provider 后引擎全套 634 条全绿。另注意区分两条独立的路：`globalThis.document`
    （polyfills 装的，给“源码里直接写 `document`”）与 `DOCUMENT`（DI token）互不相干，
    前者存在不代表后者有值。
15. **`new InjectionToken(name, { factory })` 会隐式 `providedIn: 'root'`**（core 里
    `InjectionToken` 构造：`providedIn: options.providedIn || 'root'`）。两个后果：

    - 好处：带 factory 的 token 在真实应用注入器里总能解出默认值，不需要谁去 provide。
    - 坑：**裸 `Injector.create` / `createEnvironmentInjector` 解不出它**（root 作用域不在那条链上），
      报 NG0201。所以“token 的默认值”这类断言在 Node 侧用裸注入器测不了，只能在真应用 /
      TestBed 里验。曾试图在 `packages/library/core/test/` 里用 `Injector.create({providers: []})`
      断言默认值，就是撞的这个。
16. **TestBed 有两层注入器，跳 token 比实例会翻车**。`{ provide: A, useExisting: B }`（写在
    模块 / 环境 provider 里）+ `B` 自身 `providedIn: 'root'` 时，`TestBed.inject(A)` 与
    `TestBed.inject(B)` 可能落在不同层，拿到两个不同实例——而且**是否翻车取决于同文件里
    前面跑过哪些用例**（实测：单独跑绿，前面多两个用例就红）。要断“是不是单例服务”，
    只比同一个 token 两次：`inject(A) === inject(A)`。

17. **URL 解析直接交给现成的规范实现，不要手写**。曾经手写过一份“标准子集”，拿参考实现
    对拍只对上 **51/100**：漏了 dot-segment 折叠、相对 base 目录解析、`?q=1#frag` 里
    fragment 被留在 search、空 `?`/`#` 该视为“没有这段”、percent 编码。手写看着自洽，
    但“测试没红”只能说明测过的那几条对。现在 `location.ts` 只拼基准 URL + 切三段。

    用的是 **`whatwg-url-minimum`**（whatwg-url 的衍化版）：零依赖、215KB，而原版 15.x 要
    tr46 + webidl-conversions + punycode 约 440KB。拿原版对拍过 **24222 条**（手挑 + 模糊
    生成，含非 ASCII），逐条一致。它仍带 IDNA 表，以 base64 内嵌、**加载期**就解，所以
    `atob` 得先有。

    三个已踩过的坑：

    a) **`atob` 必须比 `whatwg-url-minimum` 先跑，而“先”很难表达**。库在**模块求值期**就要
       `atob`（原版是要 `TextEncoder`），而一个模块的语句永远排在它所有 import 之后 —— 赋值
       写在引它的文件里，永远跑在库后面。

       最终形态很普通：补丁与 shim 都是构建器自己的文件，`builder/vite/polyfills.ts` 开头两行

       ```ts
       import "./atob-shim";                                            // 必须是第一行
       import { URL, URLSearchParams } from "whatwg-url-minimum";
       ```

       两者同属一个模块的同级 import，按书写顺序求值。产物里：

       ```js
       //#region ../dist/builder/vite/atob-shim.mjs          ← 第 1 行
       //#region .../whatwg-url-minimum.mjs                 ← 第 43 行
       //#region ../dist/builder/vite/polyfills.mjs         ← 第 1822 行
       ```

       之前踩的坑全部源于补丁当时是**库的二级入口**，而库入口内部造不出这条边：

       | 写法 | 结果 | 为什么 |
       | --- | --- | --- |
       | 同入口内 `import "./atob"`（文件带副作用） | 引擎 `no tests` | ng-packagr 把同入口模块展平进一个 fesm，外部 import 被提到最顶，atob 赋值落在第 21 行 |
       | 同入口内 `import { fn } from "./atob"` + 本模块赋值 | 引擎 `no tests` | 同上。函数从哪来不影响 —— 赋值动作仍在被展平的那个模块体里 |
       | 构建器虚拟入口里写语句 | 引擎 `no tests` | rolldown 出 CJS 时把 `require()` 提到 chunk 体之前，语句落在后面 |
       | 构建器第二个虚拟模块 | 引擎 `no tests` | 只有一个引用者 → 被内联进补丁 chunk，一个内联一个外部，层级错位 |
       | atob 当第二个 rollup input | 引擎 `no tests` | 确实独立成 chunk 了，但 rolldown 排外部 require 不跟随 import 书写顺序，polyfills 反而在前 |

       一句话规则：**顺序按 import 图走，但前提是两者在同一层级** —— 同为外部依赖，或同被
       内联进一个 chunk。一个内联一个外部就会反过来。要 A 先于 B，就得让 B 依赖 A，
       而不是赌打包器对平级 chunk 的排序。

       一个必须守住的细节：`atob-shim.ts` 的依赖只能往下长，不能反过来让 `polyfills.ts`
       多一条指向它的额外路径 —— shim 及其依赖（`base-64`）靠“被 atob-shim 依赖”这条边
       跟着排在 `whatwg-url-minimum` 前面，边在，顺序就在。

       顺序最终靠 `build-core.ts` 的 `output.manualChunks` 钉死，而不是靠“谁 import 谁”：

       ```ts
       // atob 补丁单独一个 chunk；补丁模块与 whatwg-url-minimum 另一个
       if (POLYFILL_CHUNK_RE.test(id)) return "godot-atob";
       return URL_CHUNK_RE.test(id) ? "godot-polyfills" : undefined;
       ```

       产物里 `chunks/godot-polyfills.js` 第一行就是 `require("chunks/godot-atob.js")`，
       外部 require 一律提升到 chunk 体之前，而 `whatwg-url-minimum` 内联在同一 chunk 的体里
       —— atob 先装，库后求值，边和顺序都是声明出来的。

       为什么不用一个 manual chunk 把三个全装进去（已试，会挂）：rolldown 在 manual chunk
       **内部不保持 import 书写顺序**，实测排成 `[whatwg-url, base-64, atob-shim, polyfills]`，
       库反而第一个求值 → `atob is not defined`。分成两个 chunk 才能把顺序交给依赖边。

       为什么不能靠“某个入口 import 一下补丁模块”（也已试）：那条边确实能把 `polyfills` 撑成
       共享 chunk、凑出正确布局，但它是巧合，引擎入口会多出一条看着重复的
       `require("chunks/polyfills.js")`，下一个人完全有理由把它当冗余删掉 —— 删了就 `no tests`。
       补丁模块现在**不导出任何东西**，取用一律走 `globalThis.__CUJ_FRAME__`（库主入口与
       引擎测试运行时同此），没有“从副作用模块 import API”这回事。

    b) **`whatwg-url` 钉在 15.x，不要升 16+**。16 起多了依赖 `@exodus/bytes`，它加载期就
       `new TextDecoder("latin1")` 并读 `globalThis.atob`，而 utf8 那份 TextDecoder 只认
       utf-8，实测 `TypeError: The encoding label provided ('latin1') is invalid`。15.x 的
       加载期依赖只有 `TextEncoder` 与 `TextDecoder("utf-8")`。

    c) **`bare-url` 用不了**，它不是纯 JS：`binding.js` 就一行 `require.addon()`，真正解析
       URL 的 `url_parse()` 在 `binding.c` 里（`index.js:387` 直接 `binding.parse(...)`），
       没有 JS 兜底；删掉 C 与 prebuilds 后连 `require('bare-path')` / `Bare.platform` 都
       过不去（实测依次报 `Cannot find module 'bare-path'` → `Bare is not defined`）。

    剩下两处刻意偏离（都在 Angular 递不出的输入上）：authority 后的空 path 归一成 `/`
    （合成 scheme 非特殊协议，规范允许空 path）；规范解不出的输入（非法主机名）按
    `URL` 的语义抛，与浏览器 `pushState` 抛 DOMException 一致。

    代价：`whatwg-url-minimum` 约 **215KB 源码**、零依赖（大头仍是内嵌的 IDNA 表，合成
    origin 其实用不到，但拆不掉）。`location.spec.ts` 里的期望表由参考实现生成，不手写；
    换掉 URL 实现时它就是回归线。

18. **自己实现宿主 API 时，差分测试必须含畸形输入**。`atob` 的第一版是手写的位循环，
    合法 base64 全对，却与规范有 10 处分歧 —— 全部在畸形路径上：中段 padding
    （`aGVsbG8=Zm8`）、开头 padding、长度模 4 余 1（`a`、`abcde`）被静默解成错误结果，
    而 `\f` 没归入要剥的 ASCII 空白（容易漏的那个，集合是 TAB / LF / FF / CR / 空格，
    **不含** `\v`）。

    现在用的是社区那个 `btoa/atob` gist 的算法（去掉 UMD 与 `btoa`），它靠一条结构正则
    把上述畸形输入全拒掉。拿 Node 原生 `atob` 差分：**合法 400/400 + 边界 39 条零分歧**。
    差分测试在 `packages/builder/test/atob-shim.spec.ts`，Node 自带原生 `atob`，所以参考
    实现是免费的 —— 能拿宿主已有的规范实现做参考时，就不要手写期望值。

19. **`polyfills` 选项目前只接受能直接解析的说明符**。extras 被原样写进虚拟入口，而虚拟模块
    没有目录基准，写 `./src/foo.js` 会报 `UNRESOLVED_IMPORT`（实测）。绝对路径、包名可用；
    相对路径待修（应在 `build-core` 里按 workspaceRoot 解析后再传）。

20. **路由把导航流水线的错误静默吞了**，“点了不跳转、不报错”优先查这里。
    `NavigationTransitions.setupNavigations(...).subscribe({ error: e => {} })`（`@angular/router`
    自己的代码）——错误处理是个空函数。而它的外层 `switchMap` 体里有一句
    `new AbortController()`：抛出的 ReferenceError 不走 `catchError`（那个只包内层管道），
    直接落进那个空 error 回调，订阅解体。此后 `transitions.next()` 打在已关闭的 Subject 上，
    `navigate()` 的 promise **既不 resolve 也不 reject**、`router.events` 一条不发、outlet 永远空。
    实测特征：`router.navigationTransitions.transitions.observers.length === 0`。
    查法：把 `node_modules/@angular/router/fesm2022/_router-chunk.mjs` 里那句 `error: e => {}`
    临时改成打印，真因当场出来（本库就是这么定位到 GodotJS 缺 `AbortController` 的）。

21. **改补丁入口的依赖会改所有入口的分块，进而改顶层变量重命名**。实测：给
    `vite/polyfills.ts` 加一个包依赖后，引擎测试入口加载即
    `TypeError: Cannot read properties of undefined (reading 'toStringTag')`——
    `@nberlette/utf8` 顶层那句 `var Symbol = $global.Symbol` 原本被 rolldown 重命名成
    `Symbol$1`，模块图一变就不重命名了，于是遮蔽全局 `Symbol`，而生成入口的第 4 行正是
    `[Symbol.toStringTag]`。两个结论：补丁入口尽量**只加本地模块、不加包**（`abort-shim.ts`
    因此手写而不用 `abortcontroller-polyfill`）；改动后必须跑引擎套件，光跑 node 侧看不出来。

---

## 10. 跨平台

Linux 与 Windows 都必须能跑，差异全部集中在 `tools/` 与 `packages/builder/shared/`：

- **`res://` 永远正斜杠**（实测 Windows 上反斜杠加载失败），且它**永远区分大小写**
  （不走宿主 FS 的不敏感匹配），所以 `.tscn` / `require()` 里的写法必须与磁盘一致。
- 引擎二进制按 `<workspaceRoot>/bin/<平台目录>/<可执行文件>` 预置（仅检索工作区根目录，
  不向上级目录搜索），`GODOT_BIN` / `engine.godotBin` 可覆盖，且两者指**目录**时会自动按平台表
  补子目录与文件名 —— 所以 `test-app/angular.json` 写一份 `"../bin"` 两个平台都能用。
  平台映射表在 `packages/builder/shared/godot-bin.ts` 的 `BIN_TABLE`。
- Windows 上 `pnpm` 是 `pnpm.cmd`，`spawnSync` 要带 `shell: isWin`。
- 从 `import.meta.url` 取路径只用 `fileURLToPath`，**不要** `.pathname`
  （Windows 上给 `/C:/...`，fs 不认）。
- 消费方 `node_modules/godot-angular` 那一层链接（tarball 解出来的目录）全部交给 pnpm，
  跨平台（含 Windows junction）由它自己处理，不手写 `symlinkSync`；仓库根不挂软链。
- 根脚本用 `pnpm --filter test-app <task>` 而不是 `cd test-app && ...`，两个 shell 都对。

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

# 引擎真机 spec：**不要直接跑 res://engine_vitest.tscn**，它要宿主先起 WS server。
# 正确入口是 pnpm test（它会构建 + 拉引擎 + 跑 + 关闭）

# 手上有一个自建工程（README 快速开始那份形状）时，直接按工程目录跑：
"$GODOT" --path <工程目录>                        # 开真窗口（需要显示环境）
"$GODOT" --headless --path <工程目录> res://<场景>.tscn   # 场景是位置参数，不是 --scene
```

改了产物 `*.js` 之后引擎**什么都不打印**，是脚本资源缓存没刷新。自动戳没生效时手动兜底：

```bash
"$GODOT" --headless --path <工程目录> --import
```

需要验证样式确实绘制到屏幕上（而不只是写入节点属性）时：

```bash
cd test-app && ../node_modules/.bin/ng test --configuration=headless   # 无头跑，像素用例自动跳过
```

---

## 12. 内部工具脚本

| 脚本 | 作用 |
| --- | --- |
| `tools/vite-build.ts` | 构建 `packages/builder`（vite preserveModules → `dist/builder`） |
| `tools/gen-schema.ts` | 读官方 CLI schema + valibot 形状，生成两个 builder 的 `schema.json` |
| `tools/build-cli-schema.ts` | 把本包 builder 挂进 `dist/builder/config/schema.json` 的 target 分支 |
| `tools/gen-typings.ts` | 调引擎 `--generate-types`，同步三处 `typings/`（对外即 `npx godot-typings`） |
| `tools/gen-html-data.ts` | 生成 VSCode 用的 html data（模板补全） |
| `tools/gen-emmet-snippets.ts` | 生成 Emmet 的 `snippets.json`（模板里的标签展开） |
| `tools/lib/godot-facts.ts` | 上面两个脚本共用的引擎导出 + Control 系事实表 |
| `tools/check-schema`（`pnpm check:schema`） | 断言生成的 schema 与形状源一致 |
| `tools/dump-vocabulary.ts` | 从引擎导出 Godot 主题词汇表 → `packages/css/vocabulary.data.ts`。类名来自两处并集：ClassDB 的 Control 继承者，以及默认主题 type list 里那些不是 Control 的类（PopupMenu、Window 等）；type list 中不是类的类型名会被过滤 |

两份编辑器补全产物都落在 `dist/` 里，消费方按**文件路径**吃（不是包入口，所以 `exports` 里没它们）：

| 产物 | 谁吃 | 消费方 `.vscode/settings.json` |
| --- | --- | --- |
| `dist/html-data/godot.html-data.json` | VSCode `html.customData` | `"html.customData": ["./node_modules/godot-angular/html-data/godot.html-data.json"]` |
| `dist/emmet/snippets.json` | Emmet | `"emmet.extensionsPath": ["./node_modules/godot-angular/emmet"]` |

分工：html data 管属性 / 信号的补全与悬浮说明，Emmet 管标签骨架的展开（敲 `Button` 再 Tab →
`<Button text="|"></Button>`）。两边标签全集同源（`tools/lib/godot-facts.ts`），不会一边有一边没有。

⚠ Emmet 那份的**值是缩写而不是字面 HTML**（实测 emmet 2.4）：`resolveSnippets()` 拿
`parseAbbreviation()` 解析 snippet 值，解析失败只 `warn` 不报错，展开静默退回成用户敲的那个
标签名。所以 `<Button text="${1}"></Button>` 看着合理但完全不生效，必须写 `Button[text=${1}]`。
生成脚本的自检靠「值里不得出现尖括号」钉住这条。另外 `extensionsPath` 改动后需重载窗口才生效，
而补全列表里的实际排序 / 大小写行为只能在真编辑器里确认（无头环境测不了）。

`pnpm gen:typings` 跑的是引擎自带的 codegen（不是第三方工具，也不是
`--dump-extension-api` 那份 JSON 再加工）：

```bash
godot --headless --editor --path <工程> --generate-types
```

两个实测才知道的点：`--editor` 不能省（只给 `--generate-types` 会被当普通参数忽略，
直接去跑主场景）；产物只跟引擎版本有关，跟工程内容无关（空工程生成的与真实工程生成的
逐字节相同），所以工具用一个临时空工程。它把 18 个 `.d.ts` 同步到
`test-app/typings`、`packages/library/typings`、`packages/builder/typings` 三处，
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
- **引擎测试的产物目录必须留 `.gdignore`**（`vitest` builder 构建后自动补，见 `shared/gdignore.ts`）：
  产物只由 `require()` 读取，缺了它时一次 `--import` 就为每个 chunk 生成 `.uid` 并写进
  `uid_cache.bin`，而 chunk 名每次重建都可能变。必须在构建之后写（`deleteOutputPath` 会先清空目录）。
  场景的 `ext_resource` 与 `require` 都是按路径直接读文件，不受 `.gdignore` 影响（已实测）。
- **引擎测试的源码目录 `test-app/src/tests/engine/` 也放了 `.gdignore`**：GodotJS 把 `.ts`
  当脚本资源，编辑器扫描一次就给每个 `.spec.ts` 生成一个 `.uid` 侧车文件（几十个，纯噪音）。
  这些源文件只由 vite 用 Node 的文件系统读取，编译成产物后才交给引擎，引擎从不按 `res://`
  加载它们，所以整个目录被排除在导入之外没有副作用（已实测：加完 `.gdignore` 后 `--import`
  不再生成 `.uid`，跑测 47 个文件 880 例全通过）。代价是往这个目录放需要导入的资源
  （字体 / 贴图）会静默失效——测试夹具因此放在 `test-app/fixtures/`，不在被忽略的子树里。
