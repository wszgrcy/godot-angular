import type { MediaEnvironment } from "./types";
import { CssCode, CssError } from "./diagnostics";

// 来源：NativeScript/packages/core/css-mediaquery/index.ts :: RE_MEDIA_QUERY / RE_MQ_EXPRESSION / RE_MQ_FEATURE
// 等级：完全来自（一字未改）
const RE_MEDIA_QUERY = /^(?:(only|not)?\s*([_a-z][_a-z0-9-]*)|(\([^\)]+\)))(?:\s*and\s*(.*))?$/i;
const RE_MQ_EXPRESSION = /^\(\s*([_a-z-][_a-z0-9-]*)\s*(?::\s*([^\)]+))?\s*\)$/;
const RE_MQ_FEATURE = /^(?:(min|max)-)?(.+)/;

/**
 * 来源：NativeScript/packages/core/css-mediaquery/index.ts :: MediaQueryFeature
 * 等级：部分修改（主体一致）
 * 改动：modifier 改为可选（无 min/max 前缀时为 undefined，上游统一存 undefined 但类型上
 * 是必填）；property 不再枚举已知键名。
 */
export interface MediaQueryFeature {
  modifier?: string;
  property: string;
  value?: string;
}

/**
 * 来源：NativeScript/packages/core/css-mediaquery/index.ts :: MediaQueryExpression
 * 等级：部分修改（主体一致）
 * 改动：type 由 MediaQueryType 枚举改为 string（本侧不预设 print / screen）。
 */
export interface MediaQueryExpression {
  inverse: boolean;
  type: string;
  features: MediaQueryFeature[];
}

/**
 * 来源：NativeScript/packages/core/css-mediaquery/index.ts :: matchQuery 内的 switch 分支
 * 等级：部分修改（主体一致）
 * 改动：上游用两层 switch 硬编码已知特性名，本侧改为两张集合；字符串特性额外收录
 * color-gamut / display-mode，数值特性集合与上游一致。
 *
 * 数值型特性，取值以像素计。
 */
const NUMERIC_PROPERTIES: ReadonlySet<string> = new Set(["width", "height", "device-width", "device-height"]);
/**
 * 来源：NativeScript/packages/core/css-mediaquery/index.ts :: matchQuery 的 orientation /
 * prefers-color-scheme 分支
 * 等级：部分修改（主体一致）
 * 改动：同一思路（按字符串相等比较），从 switch 分支改为集合，并多收录 color-gamut
 * 与 display-mode。
 *
 * 字符串型特性。
 */
const STRING_PROPERTIES: ReadonlySet<string> = new Set(["orientation", "prefers-color-scheme", "color-gamut", "display-mode"]);

/**
 * 来源：NativeScript/packages/core/css-mediaquery/index.ts :: parseQuery
 * 等级：部分修改（主体一致）
 * 相同：拆分逗号、正则捕获 modifier / type / featureString、再逐个解析特性的步骤逐行对应；
 * 三处抛 SyntaxError 的位置也相同。
 * 改动：文案本地化；type 不再查 MediaQueryType 表；modifier 多一步去尾横线（对上游
 * 那条正则而言是空操作，其捕获组本就不含横线）；featureData 为空时补上抛错。
 */
export function parseQuery(mediaQuery: string): MediaQueryExpression[] {
  return mediaQuery.split(",").map((query) => {
    const trimmed = query.trim();
    const captures = trimmed.match(RE_MEDIA_QUERY);
    if (!captures) throw new CssError(CssCode.MediaQuerySyntax, `无效的 CSS 媒体查询：'${trimmed}'`);

    const modifier = captures[1];
    const type = captures[2];
    const featureString = `${captures[3] ?? ""}${captures[4] ?? ""}`.trim();

    const expression: MediaQueryExpression = {
      inverse: !!modifier && modifier.toLowerCase() === "not",
      type: (type ? type.toLowerCase() : "all") || "all",
      features: [],
    };

    if (!featureString) return expression;

    const features = featureString.match(/\([^\)]+\)/g);
    if (!features) throw new CssError(CssCode.MediaQuerySyntax, `媒体查询缺少特性：'${featureString}'（查询：'${trimmed}'）`);

    for (const feature of features) {
      const captures = feature.match(RE_MQ_EXPRESSION);
      if (!captures) throw new CssError(CssCode.MediaQuerySyntax, `无效的媒体查询特性：'${feature}'（查询：'${trimmed}'）`);
      const featureData = captures[1].toLowerCase().match(RE_MQ_FEATURE);
      if (!featureData) throw new CssError(CssCode.MediaQuerySyntax, `无效的媒体查询特性名：'${feature}'`);
      expression.features.push({
        modifier: featureData[1] ? featureData[1].replace(/-$/, "") : undefined,
        property: featureData[2],
        value: captures[2],
      });
    }
    return expression;
  });
}

/**
 * 来源：NativeScript/packages/core/css-mediaquery/index.ts :: matchQuery 中的
 * Length.toDevicePixels(Length.parse(feature.value), 0)
 * 等级：部分修改（主体一致）
 * 改动：不再依赖 Length（那会连带拖入 layout 与 dip 换算）；新增 em / rem 按根字号
 * 换算——上游将 `48em` 当作 48 个设备像素，媒体查询里的 em 有确定定义（相对根字号），
 * 不换算会让最常见的断点写法全错。注意 rootFontSize 目前无调用方传入，恒为 16：
 * MediaEnvironment 尚未收录根字号，要支持自定义根字号得先扩环境类型。
 */
function toPixels(value: string | undefined, rootFontSize = 16): number | null {
  if (value === undefined) return null;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+))(px|em|rem)?$/.exec(value.trim());
  if (!m) return null;
  const number = Number.parseFloat(m[1]);
  if (!Number.isFinite(number)) return null;
  // 媒体查询中的 em / rem 有确定定义（相对根字号，缺省 16），而不是“相对父控件字号”
  // 这类无法计算的相对单位，因此此处可以安全换算——`48em` 是 CSS 中最常见的断点写法。
  if (m[2] === "em" || m[2] === "rem") return number * rootFontSize;
  return number;
}

/**
 * 来源：NativeScript/packages/core/css-mediaquery/index.ts :: matchQuery
 * 等级：部分修改（主体一致）
 * 相同：type / inverse 的早退表达式与特性汇总表达式逐字相同；min / max / 相等三分支相同。
 * 改动：解析失败时返回 false（上游直接抛出）；缺失值判定从「falsy 且非 0」改为
 * 「undefined / null」；上游会先查缓存数组，本侧的缓存上移到 StyleSheetIndex。
 *
 * 判断一条媒体查询（可含逗号）在给定环境值下是否命中。
 * 解析失败时返回 false 而非抛错——运行期一条书写错误的查询不应导致整棵树的样式失效。
 */
export function matchQuery(mediaQuery: string, values: MediaEnvironment): boolean {
  let expressions: MediaQueryExpression[];
  try {
    expressions = parseQuery(mediaQuery);
  } catch {
    return false;
  }
  return expressions.some((query) => matchOne(query, values));
}

/**
 * 来源：NativeScript/packages/core/css-mediaquery/index.ts :: matchQuery（内部 some 回调体）
 * 等级：部分修改（主体一致）
 * 改动：上游是内联在 matchQuery 里的匿名回调，本侧拆为独立函数；特性取值不再走
 * Trace 告警分支，而是由两张集合判定后静默不命中。
 */
function matchOne(query: MediaQueryExpression, values: MediaEnvironment): boolean {
  const { inverse, features } = query;

  // 要么两侧均为 all，要么类型完全一致
  const typeMatch = query.type === "all" || values.type === query.type;
  if ((typeMatch && inverse) || !(typeMatch || inverse)) return false;

  const featuresMatch = features.every((feature) => {
    const raw = (values as Record<string, string | number | undefined>)[feature.property];
    if (raw === undefined || raw === null) return false;

    if (STRING_PROPERTIES.has(feature.property)) {
      if (typeof raw !== "string") return false;
      return raw.toLowerCase() === (feature.value ?? "").toLowerCase();
    }

    if (!NUMERIC_PROPERTIES.has(feature.property)) return false;
    if (typeof raw !== "number") return false;
    const wanted = toPixels(feature.value);
    if (wanted === null) return false;

    switch (feature.modifier) {
      case "min":
        return raw >= wanted;
      case "max":
        return raw <= wanted;
      default:
        return raw === wanted;
    }
  });

  return (featuresMatch && !inverse) || (!featuresMatch && inverse);
}

/**
 * 来源：无
 *
 * 一条查询所引用的全部环境键，用于判定环境变化后是否需要重新计算。
 */
export function mediaQueryDependencies(mediaQuery: string): string[] {
  try {
    const deps = new Set<string>();
    for (const expression of parseQuery(mediaQuery)) {
      if (expression.type !== "all") deps.add("type");
      for (const feature of expression.features) deps.add(feature.property);
    }
    return [...deps];
  } catch {
    return [];
  }
}
