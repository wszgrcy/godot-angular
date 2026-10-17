/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: SelectorTier
 * 等级：完全来自（一字未改）
 *
 * 选择器所在样式表的**层级**。特异度相同的两条规则靠它判定优先级：
 * 全局样式（Application）始终低于组件样式（Local），与 Angular 的封装语义一致。
 *
 * 注意：位置(pos)只在同一 tier 内可比——两棵索引是分别编号的。
 */
export enum SelectorTier {
  Application = 0,
  Local = 1,
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: Node
 * 等级：部分修改（主体一致）
 * 相同：parent / id / cssType / cssClasses / cssPseudoClasses 与三个兄弟访问器
 * （getChildIndex / getChildAt / getChildrenCount）逐字对应。
 * 改动：删除 nodeName 与 _modalParent（无模态呈现概念）；新增索引签名供属性选择器取值。
 *
 * 选择器匹配所依赖的极小节点接口：没有 DOM、没有布局、没有引擎类型——这是能在 Node
 * 中测试的根本原因。引擎的 `Control` 结构上满足它（`cssType` 由 renderer 写入）。
 * 索引签名供属性选择器使用：`[_ngcontent_xxx]` 读取的是节点上任意一个键。
 */
export interface CssNode {
  /** 父节点（组合器 `>` / 空格 / `+` / `~` 全部依靠它回溯） */
  parent?: CssNode | null;
  /** `#id` 用：Angular 的 `id` 绑定值，**不是** Godot 的 `node.name`（兄弟可同名） */
  id?: string;
  /** 元素选择器的落点 = 节点类名，不可覆写（Godot 没有可写的 theme_type） */
  cssType?: string;
  /**
   * `attach` 之后必定是 `TrackingClassSet`：向其中 add / delete 是“class 发生变化”的唯一通知源。
   * class 需要在 attach 之后写入，attach 前放入的内容不会被保留。
   */
  cssClasses?: Set<string>;
  /** 同上，只是内容换成了伪类名（`:hover` 这类由 Godot 信号写入） */
  cssPseudoClasses?: Set<string>;
  [key: string]: unknown;
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: Declaration
 * 等级：部分修改（主体一致）
 * 改动：新增 important（上游 cleanupImportantFlags 剥除该标记并告警，不支持其语义）。
 *
 * 一条已展开为 longhand 的声明
 */
export interface Declaration {
  property: string;
  /** 原始 CSS 文本（shorthand 已在解析期展开为 longhand，级联定义在 longhand 上） */
  value: string;
  /** `!important`：不参与特异度比较，而是整批排在普通声明之后 */
  important?: boolean;
}

/**
 * 来源：NativeScript/packages/core/ui/styling/css-selector.ts :: RuleSet
 * 等级：部分修改（主体一致）
 * 改动：上游是携带 toString / lookupSort 的类，本侧只留数据形状（索引与排序在
 * StyleSheetIndex）；上游另有 tag 用于按登记方批量撤除，本侧由样式表句柄承担。
 *
 * 一条规则（选择器 + 声明 + 可选的媒体查询条件）
 */
export interface RuleSet {
  selectors: string[];
  declarations: Declaration[];
  /** 所在 @media 的原文；null 表示无条件 */
  mediaQueryString?: string;
  /** 组件作用域标记（有值 = 只对该组件生效） */
  scopedTag?: string;
}

/**
 * 来源：NativeScript/packages/core/color/color-types.ts :: IColor
 * 等级：仅思路一致
 * 差异：上游 Color 以 32 位 ARGB 整数存储，a/r/g/b 读出 0..255；本类型直接用 0..1 浮点，
 * 因为 Godot 的 Color 通道就是 float，中转一次只会丢精度。
 *
 * 颜色：0..1 浮点四通道（Godot `Color` 的通道就是 float，不做 0..255 中转）
 */
export interface ColorLike {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * 来源：NativeScript/packages/core/ui/styling/style-properties.ts :: ShorthandPositioning
 * 等级：部分修改（主体一致）
 * 改动：上游四个字段装的是未解析的 CSS 片段（随后逐条交给 Length.parse），本侧直接
 * 装已解析的像素数。
 *
 * 四值（上右下左）—— border / margin / padding / content-margin 共用
 */
export interface FourSides {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * 来源：无
 *
 * 四个圆角。**不能复用 FourSides**：`top-left` 这种名称中“上”与“左”属于两个维度，
 * 当作 side 映射会把 top-left 归到 left。
 * 顺序沿用 CSS 的 border-radius：左上 → 右上 → 右下 → 左下。
 */
export interface FourCorners {
  topLeft: number;
  topRight: number;
  bottomRight: number;
  bottomLeft: number;
}

/**
 * 来源：无
 *
 * StyleBoxFlat 的句柄：由引擎侧实现，纯包只调用方法、不持有 Godot 对象。
 * StyleBoxFlat 从 Theme 取出时是共享实例，直接修改会污染整个 Theme，因此 duplicate → 修改
 * → override 三步收拢到 `mutateStyleBox` 一处——句柄拿到的已是副本，写入它始终安全。
 */
export interface StyleBoxHandle {
  setBackground(color: ColorLike | null): void;
  setCornerRadii(radii: Partial<FourCorners>): void;
  setBorderWidths(widths: Partial<FourSides>): void;
  setBorderColor(color: ColorLike | null): void;
  setShadow(shadow: { color: ColorLike; size: number; offsetX: number; offsetY: number }): void;
  /**
   * 纹理（`background-image` 的落点）。path 是 `res://` 路径，由实现侧加载。
   *
   * 一个 StyleBox 只能绘制底色或纹理此中的一种（StyleBoxFlat 无 texture，StyleBoxTexture 无
   * bg_color），因此该条与 `setBackground` 互斥，何者生效由层叠顺序决定。
   */
  setTexture(path: string): void;
  /** 内容留白（Godot 的 content_margin）—— CSS 的 padding 落在这里 */
  setContentMargin(margin: Partial<FourSides>): void;
}

/**
 * 来源：NativeScript/packages/core/ui/styling/style-properties.ts（CSS 属性 → 原生 setter 的注册表）
 * 等级：仅思路一致
 * 差异：上游的“落点”是 Style 上的属性访问器（每个 CSS 属性一个 CssProperty 对象），
 * 本侧的落点是 theme override / StyleBoxFlat / 节点属性三类完全不同的东西，因此接口
 * 形状完整重写，只沿用“属性落点集中的一个出口”这一约束。
 *
 * CSS 属性落到 Godot 节点的唯一出口。由 `packages/library/core/style-target.ts` 实现。
 *
 * 每个方法只负责一件事，且**不自行做去重 / 记账**——那些属于级联层职责。
 */
/**
 * `font-family` 的两种落点。
 *
 * - `{ path }`：`@font-face` 已登记的工程内资源（确定答案，跨平台一致）。
 * - `{ systemFontNames }`：全部未登记，整串候选交给 `SystemFont.font_names`，
 *   由引擎按序选取系统中首个存在的字体；若全部不存在则由引擎回退至默认字体。
 *   本库仅负责“尽力回退”，不判定最终是否生效。
 */
export type FontSource = { path: string } | { systemFontNames: string[] };

export interface StyleBackend {
  /** 节点类名（引擎侧 = `get_class()`）；元素选择器与 theme_type 都依赖它 */
  classOf(node: CssNode): string;

  /** 将一批改动包进 `begin/end_bulk_theme_override`，分摊批量刷新的开销 */
  bulk<T>(node: CssNode, apply: () => T): T;

  /** duplicate → 改 → add_theme_stylebox_override */
  mutateStyleBox(node: CssNode, item: string, apply: (box: StyleBoxHandle) => void): void;

  // 只提供 set：撤销统一走 clearProperty（“这条 CSS 属性不再需要”），单条 remove 从未被调用
  setColorOverride(node: CssNode, item: string, color: ColorLike): void;
  setFontSizeOverride(node: CssNode, item: string, size: number): void;
  setConstantOverride(node: CssNode, item: string, value: number): void;

  /**
   * 字体覆盖（`font-family` 的落点），两种来源见 {@link FontSource}。加载与缓存由实现侧负责。
   *
   * 返回 false 仅可能发生在 `path` 分支：资源加载失败。调用方必须输出告警——静默回落至主题
   * 默认字体是最难排查的一类问题。`systemFontNames` 分支恒返回 true：系统安装了哪些字体
   * 本库无法查得（TextServer 未提供该 API），是否生效交由引擎处理。
   */
  setFontOverride(node: CssNode, item: string, source: FontSource): boolean;

  /** 最小尺寸（CSS 的 min-width / min-height 落点，**下界**而非等值）；null 表示不修改这一轴 */
  setMinimumSize(node: CssNode, width: number | null, height: number | null): void;
  /** opacity → modulate.a（连子树一起调制） */
  setOpacity(node: CssNode, alpha: number): void;
  /** 直接设一个数值型节点属性（BoxContainer.separation 这类） */
  setNodeNumber(node: CssNode, prop: string, value: number): void;
  getNodeNumber(node: CssNode, prop: string): number;
  /** 设一个布尔型节点属性（visibility → visible 这类） */
  setNodeBoolean(node: CssNode, prop: string, value: boolean): void;
  /** 节点上是否存在该属性——L3 的落点判断完全依赖它，写入不存在的属性引擎只会静默接受 */
  hasNodeProperty(node: CssNode, prop: string): boolean;
  /** 父节点（组合器回溯 + `gap` 落到父容器） */
  parentOf(node: CssNode): CssNode | null;

  /**
   * 子节点清单。class 变化需要连带子树重算（`.card .title` 这种后代选择器），
   * 而 `CssNode` 只有 `parent` 没有 children（组合器回溯用不到子节点），因此子树由 backend 提供。
   */
  childrenOf(node: CssNode): CssNode[];

  /**
   * 撤销某条 CSS 属性写入的全部内容。一条属性可能写了多个 theme item（`border` 写四条
   * 边宽 + 边框色），而“写过哪些”记在引擎侧 ledger 上，级联只报告属性名。
   * 必须只撤销本库写入的内容，用户自行 `add_theme_color_override` 的内容不能动。
   */
  clearProperty(node: CssNode, cssName: string): void;

  /**
   * 落一条 CSS 属性，返回 false 表示属性名不认识。必须走这个入口而不是级联自行调用
   * applyCssProperty：引擎侧 ledger 按 CSS 属性名分组记账，绕过它会使撤销全部失效。
   *
   * `states`：声明所在的选择器自身要求的状态伪类（见 `MergedDeclaration.states`）。
   * 空集 = 基规则或内联，写基 item；非空 = 写引擎在该状态下读取的 item。落点完全由它
   * 推导，与节点当前处于哪些状态无关。
   *
   * `resolveFont`：将 `font-family` 的家族名解析为 `@font-face` 登记的资源路径。仅样式表
   * 中才含 `@font-face`，因此内联与裸声明通道不传该字段。
   */
  applyProperty(
    node: CssNode,
    cssName: string,
    raw: string,
    warnings: string[],
    states: ReadonlySet<string>,
    resolveFont?: (family: string) => string | null,
  ): boolean;
}

/**
 * 来源：NativeScript/packages/core/css-mediaquery/index.ts :: MediaQueryEnvironmentParams
 * 等级：部分修改（主体一致）
 * 改动：键集完全相同；type 由 MediaQueryType 枚举放宽为 string（本侧不预设设备类型枚举）。
 * 上游的取值来自 media-query-list（Screen.mainScreen），本侧禁止自行读取环境。
 *
 * 媒体查询的环境值。**由调用方注入**——本包不得读取 DisplayServer（无头模式下恒为 (0,0)）。
 */
export interface MediaEnvironment {
  type?: string;
  width?: number;
  height?: number;
  "device-width"?: number;
  "device-height"?: number;
  orientation?: string;
  "prefers-color-scheme"?: string;
}

/**
 * 来源：无
 *
 * 告警等级。两者的区别在于使用者是否需要修改代码：
 * - `ignore`：完全不支持，该条声明被丢弃，Godot 侧无对应实现，必须改写。
 * - `compat`：已写入并生效，但 Godot 的语义与 CSS 不同，结果仅为近似，
 *   能否接受由使用者判断。
 *
 * 两者都只在开发模式输出（见构建器对 `ngDevMode` 的处理）。
 */
export type WarnLevel = "ignore" | "compat";

/**
 * 来源：无
 *
 * 解析 / 应用过程中产生的一次告警
 */
export interface CssWarning {
  key: string;
  message: string;
  level?: WarnLevel;
}
