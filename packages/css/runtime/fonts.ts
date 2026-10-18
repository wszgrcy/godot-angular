/**
 * 来源：无（CSS `@font-face` 只借语法，不实现 CSS Fonts 规范）
 * 等级：本侧新增
 *
 * `@font-face` 在本项目中并非「字体加载规则」，而是一条**字体登记**：将一份 Godot 可加载的
 * 字体资源关联到一个家族名下，`font-family: 名称` 此后方可解析到该资源。
 *
 * 之所以需要严格限制写法，是由引擎侧的能力决定的：
 *   - 资源路径必须在构建期确定。运行时取得的 CSS 已内联至 JS，`url()` 中的相对路径
 *     已失去参照物（组件样式来自 styleUrls，编译后文件名亦不再保留），因此仅接受 `res://`。
 *   - `res://` 是引擎的虚拟根，指向 `project.godot` 所在目录；位于工程目录内的字体文件会随
 *     工程一并导出至 `.pck`，运行时由 `ResourceLoader` 直接加载，无需额外的资源通道。
 *   - Godot 的 FontFile 不存在「同一家族按 weight / style 选择变体」的机制，一个名称仅对应
 *     一份字体，因此 `font-weight` / `font-style` 一类描述符没有对应实现。
 */
import { CssCode, CssWarnEntry } from "../diagnostics";
import type { CssFontFace } from "../parser";
import { extractResourceUrl, unquote } from "../value/resource-url";

/** FontFile 支持的容器格式（引擎实测：ttf / ttc / otf / otc / woff / woff2 / type1） */
const FONT_EXTENSIONS = new Set(["ttf", "ttc", "otf", "otc", "woff", "woff2", "pfb"]);

/**
 * Godot 自身的资源后缀。`FontVariation`（继承 Font）这类派生字体在工程中以 `.tres` 形式
 * 存在，若一律按后缀拒收，将把合法写法挡在门外；是否为真正的 Font 交由加载时判定，
 * 加载失败时会输出告警（font-family 的「字体资源加载失败」告警）。
 */
const RESOURCE_EXTENSIONS = new Set(["tres", "res"]);

const ACCEPTED_EXTENSIONS = new Set([...FONT_EXTENSIONS, ...RESOURCE_EXTENSIONS]);

/** 一份已登记的字体：家族名 + 引擎资源路径 */
export interface FontFace {
  /** CSS 中书写的家族名，保留原样；比较时不区分大小写 */
  family: string;
  /** `res://` 开头的引擎资源路径 */
  path: string;
}

/** 去掉 CSS 字符串的外层引号（实现在 value/resource-url，两处共用同一条规则） */

/**
 * 校验一条 `@font-face`。返回 null 表示该条登记无效，`warnings` 中已写明原因。
 *
 * 一律按「未书写即视为未提供」处理：字体登记失败不会使整张样式表失效，但一定会输出告警——
 * 静默退回主题默认字体的排查成本过高。
 */
export function parseFontFace(
  node: CssFontFace,
  line: number,
  warnings: CssWarnEntry[],
): FontFace | null {
  const at = `第 ${line} 行：@font-face`;
  const family = unquote(node.descriptors["font-family"] ?? "");
  if (!family) {
    if (ngDevMode) warnings.push(new CssWarnEntry(CssCode.FontFaceInvalid, `${at} 缺少 font-family，已忽略（该描述符即 font-family 属性查找所用的名称）`));
    return null;
  }

  const src = node.descriptors["src"];
  if (!src) {
    if (ngDevMode) warnings.push(new CssWarnEntry(CssCode.FontFaceInvalid, `${at} "${family}" 缺少 src，已忽略`));
    return null;
  }

  const path = extractResourceUrl(src, warnings, {
    subject: `${at} "${family}" 的 src`,
    extensions: ACCEPTED_EXTENSIONS,
    extensionsText: `字体文件：${[...FONT_EXTENSIONS].join(" / ")}；或包含 Font 派生类型的 ${[...RESOURCE_EXTENSIONS].join(" / ")} 资源`,
    example: "res://assets/fonts/x.ttf",
  });
  if (!path) return null;

  // 这些描述符在 CSS 中用于「同一家族选择变体」，Godot 的 FontFile 无对应概念
  for (const ignored of ["font-weight", "font-style", "font-stretch", "font-display", "unicode-range"]) {
    if (node.descriptors[ignored] !== undefined && ngDevMode) {
      warnings.push(new CssWarnEntry(CssCode.FontFaceDescriptorUnsupported, `${at} "${family}" 的 ${ignored} 没有对应实现，已丢弃：Godot 中一个字体名仅对应一份字体文件`));
    }
  }

  return { family, path };
}

/** 家族名比较：CSS 规范中 font-family 不区分大小写 */
export function fontFamilyKey(family: string): string {
  return unquote(family).toLowerCase();
}
