import type { WarnLevel } from "./types";

/**
 * 诊断码。
 *
 * 测试与文档引用码，不引用中文文案——文案会随说明需要调整，码保持不变。
 * 分段即分类：
 *
 * - `1xxx` 属性或取值在 Godot 侧没有对应实现（声明被丢弃，或仅近似生效）
 * - `2xxx` 选择器与语法（解析阶段）
 * - `3xxx` 节点与库层（写入节点时发现问题）
 */
export enum CssCode {
  /** 该类没有可写入背景的位置（底色、边框、内边距都需要一个 stylebox） */
  BackgroundNoTarget = 1001,
  /** 该类的主题中不存在这个属性对应的项 */
  ThemeItemMissing = 1002,
  /** 单边边框颜色被合并为整圈边框颜色 */
  BorderSidesMerged = 1003,
  /** 文字阴影的模糊半径被丢弃（Godot 只有偏移与颜色） */
  TextShadowBlurDropped = 1004,
  /** `justify-content` 的取值超出 Godot 的三档对齐 */
  JustifyContentUnsupported = 1005,
  /** 该属性需要节点具备某个 Godot 属性，但当前节点没有 */
  NodePropertyMissing = 1006,
  /** `overflow` 的取值超出 Godot 的裁剪开关 */
  OverflowUnsupported = 1007,
  /** `pointer-events` 无法恢复 Godot 的默认鼠标过滤方式 */
  PointerEventsRestoreUnsupported = 1008,
  /** `pointer-events: none` 不会屏蔽子节点 */
  PointerEventsSubtree = 1009,
  /** `text-align` 取值无对应 */
  TextAlignUnsupported = 1010,
  /** `cursor` 取值无对应 */
  CursorUnsupported = 1011,
  /** `white-space` 取值无对应 */
  WhiteSpaceUnsupported = 1012,
  /** `direction` 取值无对应 */
  DirectionUnsupported = 1013,
  /** 该属性在 Godot 侧没有对应实现 */
  PropertyUnsupported = 1014,
  /** CSS 关键字（`inherit` / `initial` / `unset`）无对应实现 */
  KeywordUnsupported = 1015,
  /** `var()` 需要运行期求值，当前不支持 */
  VarUnsupported = 1016,
  /** `calc()` 需要布局引擎配合，当前不支持 */
  CalcUnsupported = 1017,
  /** 该类不是 BoxContainer / GridContainer，没有间距常量 */
  GapUnsupported = 1018,
  /** BoxContainer 只有单轴间距，另一轴不产生间距 */
  GapAxisUnsupported = 1019,
  /** 该类不是 MarginContainer，没有 margin 常量 */
  MarginUnsupported = 1020,
  /** 属性名本身不认识 */
  UnknownProperty = 1021,
  /** `var()` 引用的变量没有值且未提供 fallback */
  VarUnresolved = 1022,
  /** 声明的值解析失败，该条声明被丢弃 */
  ValueIgnored = 1023,
  /** 伪类在该类上推导不出来（该类没有对应属性） */
  PseudoNotDerivable = 1024,
  /** 样式表使用了 Godot 没有对应信号的伪类 */
  PseudoUnbound = 1025,
  /** 整张样式表解析失败，未应用 */
  StyleSheetIgnored = 1026,
  /** `@font-face` 指向的字体资源加载失败 */
  FontLoadFailed = 1027,

  /** 属性选择器的操作符不支持 */
  AttrOperatorUnsupported = 2001,
  /** 函数式伪类不支持（`:has` / `:nth-child` 等） */
  FunctionalPseudoUnsupported = 2002,
  /** 伪类不支持 */
  PseudoUnsupported = 2003,
  /** 选择器语法错误 */
  SelectorSyntax = 2004,
  /** 媒体查询语法错误 */
  MediaQuerySyntax = 2005,
  /** 样式表语法错误（缺少 `{`、括号未闭合、at-rule 缺少结尾） */
  StyleSheetSyntax = 2006,
  /** 不支持的 at-rule（包括 `@keyframes` 与声明块内嵌套） */
  AtRuleUnsupported = 2007,
  /** 元素选择器不是已知的 Godot 类名，不会命中任何节点 */
  ElementNameUnknown = 2008,
  /** `#id` 在 Godot 没有对应写法 */
  IdSelectorUnsupported = 2009,
  /** 整条选择器无法使用，已丢弃 */
  SelectorIgnored = 2010,
  /** `@font-face` 内容无效 */
  FontFaceInvalid = 2011,
  /** `@font-face` 的描述符没有对应实现 */
  FontFaceDescriptorUnsupported = 2012,
  /** `local()` 没有对应实现（Godot 不按名称从系统取资源） */
  LocalSourceUnsupported = 2013,
  /** 颜色无法解析 */
  ColorInvalid = 2014,
  /** 长度无法解析（含百分比与不支持的单位） */
  LengthInvalid = 2015,
  /** 阴影的该部分没有对应实现（`inset` / `spread` / 多层） */
  ShadowPartUnsupported = 2016,
  /** 简写写法无效（值的数量不符、无法解析） */
  ShorthandInvalid = 2017,
  /** 简写中某一段没有对应实现（`border-style`、`flex-basis`、背景图片等） */
  ShorthandPartUnsupported = 2018,
  /** 该取值没有对应实现（解析阶段即可判定） */
  ValueUnsupported = 2019,
  /** `url()` 写法无效（非 `res://` 路径、多个 url、后缀不可加载） */
  ResourceUrlInvalid = 2020,

  /** 标签名不是可用的 Godot 控件，已降级为容器 */
  NodeClassFallback = 3001,
  /** 赋值的名字不是该类的真实属性 */
  NodePropertyNotReal = 3002,
  /** ClassDB 里有该属性，但 JS 绑定没有生成访问器 */
  NodePropertyNoAccessor = 3003,
  /** 组件使用了 ShadowDom 封装，Godot 无 shadow root */
  ShadowDomUnsupported = 3004,
  /** 该盒不是 StyleBoxFlat，只有内边距可写 */
  StyleBoxNotFlat = 3005,
  /** stylebox 字段在该盒上没有对应属性 */
  StyleBoxFieldUnsupported = 3006,
  /** `background-image` 指向的纹理加载失败 */
  TextureLoadFailed = 3007,
  /** 帧钟未安装（构建器补丁未先于本入口求值） */
  FrameClockMissing = 3008,
  /** 写入类方法未经 applyProperty 的作用域门面调用 */
  BackendScopeMissing = 3009,
}

/** 诊断码前缀，输出时形如 `CUJ-1001`。`CUJ` 即仓库名 Control UI JS 的缩写。 */
const CODE_PREFIX = "CUJ-";

/** 诊断码的对外写法（如 `CUJ-1001`）。运行期告警、抛出的异常、构建期日志共用该格式。 */
export function cssCodeLabel(code: CssCode): string {
  return `${CODE_PREFIX}${code}`;
}

/** 去重与输出时附带的参数（类名、属性名等） */
export type CssWarnDetail = Readonly<Record<string, string | number>>;

/**
 * 解析阶段的一条告警（样式表文本、选择器、简写展开、值解析）。
 *
 * `toString()` 返回文案本身，因此 `warnings.join("\n")` 与改成结构化之前完全一致；
 * 新代码按 `code` 断言，不匹配文案。
 */
export class CssWarnEntry {
  constructor(
    readonly code: CssCode,
    readonly message: string,
  ) {}

  toString(): string {
    return this.message;
  }
}

/**
 * 内部告警上报函数形状。各层向下传递的都是它，最外层（`StyleRuntimeOptions.warn`）
 * 收到的是组装好的 `CssWarning`。
 *
 * 文案由调用点就地传入，不查表：集中表是模块级常量，打包器不会摇除，
 * 生产产物就会带上全部文案。
 */
export type CssWarnReport = (
  code: CssCode,
  message: string,
  detail?: CssWarnDetail,
  level?: WarnLevel,
) => void;

/**
 * 一条运行期告警。
 *
 * `onDiagnostic` 回调与测试断言拿到的都是该实例；`instanceof CssWarning` 可用于区分
 * 本包产生的诊断与其它来源的输出。
 *
 * 文案由调用点就地给出（而非集中查表），以便生产构建连同文案一并摇除；码是稳定契约。
 */
export class CssWarning {
  constructor(
    readonly code: CssCode,
    readonly message: string,
    readonly level: WarnLevel = "ignore",
    readonly detail: CssWarnDetail = {},
  ) {}

  /**
   * 去重键：同一码 + 同一组参数 + 同一句文案只输出一次。
   *
   * 文案必须进键：`ValueIgnored` 这类码不带参数，不带文案就会退化成“全局只报一条”。
   */
  get dedupeKey(): string {
    const parts = Object.keys(this.detail)
      .sort()
      .map((k) => `${k}=${this.detail[k]}`);
    return `${this.code}|${parts.join(",")}|${this.message}`;
  }

  toString(): string {
    const parts = Object.keys(this.detail)
      .sort()
      .map((k) => `${k}=${this.detail[k]}`);
    const suffix = parts.length ? `（${parts.join(", ")}）` : "";
    return `${cssCodeLabel(this.code)}: ${this.message}${suffix}`;
  }
}

/**
 * 本包抛出的异常。
 *
 * `message` 已含码前缀，未捕获时控制台直接打印出 `CssError: CUJ-2004: …`；
 * 测试断言 `code` 或 `instanceof CssError`，不匹配中文句子。
 */
export class CssError extends Error {
  override name = "CssError";

  constructor(
    readonly code: CssCode,
    message: string,
    readonly detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(`${cssCodeLabel(code)}: ${message}`);
  }
}
