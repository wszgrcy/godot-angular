# `godot-angular/css` —— CSS 子集的纯逻辑层

**硬约束：这里任何文件都不许 `import "godot"`。** 破了，构建期 vite 插件当场炸，
而且是在 CI 的构建步骤炸、不是在测试里炸。

能在 Node 里跑不是图省事，是因为**构建进程里没有 godot 模块**，构建期要用的解析
能力只能活在这个约束里。

## 目录就是分层

```
css/
├─ parser.ts         词法 + 语法（含 @media 嵌套）
├─ ruleset.ts        解析 → 简写展开 → 选择器索引；lint 也在这（buildRuleSets）
├─ selector.ts       选择器求值 + 四桶倒排索引
├─ shorthand.ts      简写 → longhand（必须在解析期，源码顺序才是真的）
├─ mediaquery.ts     @media 条件求值
├─ vocabulary.ts     Godot 主题词汇表（item 名 / 类继承链 / 状态变体）
├─ vocabulary.data.ts 上面那份的数据，由 `pnpm dump:vocabulary` 从引擎里导出来
├─ types.ts          CssNode / StyleBackend 等接口（后端抽象的唯一出口）
├─ value/            值解析：color / sides / tokens / keyword / length / shadow
└─ runtime/          ★ 只有运行期用，构建期一行都不碰
   ├─ cascade.ts     级联：合并 → diff → 精确撤除 → 定向失效 → 帧末批量
   ├─ properties.ts  CSS 属性 → 落到哪个 theme item
   └─ vars.ts        var() 展开（级联内部已调，导出给诊断工具复用）
```

## 为什么只有 `runtime/` 这一侧能分出去

实测依赖闭包（`git log` 里那次讨论留下的结论，别再重新推一遍）：

| | 模块数 |
| --- | --- |
| 构建期需要（入口 `buildRuleSets`） | 11 |
| 运行期需要（入口 `Cascade` + `applyCssProperty`） | 17 |
| **只有构建期用** | **0** |
| 只有运行期用 | cascade、properties、vars、value/{keyword,length,shadow} |

构建期是运行期的**真子集** —— 解析层两边共用，构建期一行运行时代码都不碰。所以
"构建包 / 运行时包"这个切法不成立（会得到一个 `css-core` 让两边依赖），能分的只有
这一侧。

`runtime/` 不是"新加的一层"，是把本来就存在的边界画出来：构建期永远不可能在这里
拿到级联、帧末状态或 theme item 落点。

## 谁在用

| 使用方 | 拿什么 |
| --- | --- |
| `packages/builder/vite/css-plugin.ts` | 只有 `buildRuleSets`（构建期 lint） |
| `packages/library/core/style-target.ts` | `applyCssProperty` + 类型（实现 `StyleBackend`） |
| `packages/library/core/css-runtime.ts` | `Cascade` |

真正往 Godot 节点上写东西的代码在 `packages/library/core/style-target.ts`，
它实现本包 `types.ts` 里的 `StyleBackend` 接口。

## 加代码时的规矩

- 新模块放哪：**构建期会不会 import 它**？会 → 留在顶层；不会 → 进 `runtime/`
- 别从 `runtime/` 往顶层反向依赖之外加东西（`runtime/` 可以依赖顶层，反过来不行）
- 值解析一律进 `value/`，别按"谁用"拆散它 —— `keyword`/`length`/`shadow` 目前只有
  `properties.ts` 用，那是巧合（长度解析发生在落点而不是解析期），不是分层依据
- 改完跑 `pnpm test:node`，这一包全部是秒级纯 Node 用例
