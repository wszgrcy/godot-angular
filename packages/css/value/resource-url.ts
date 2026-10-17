/**
 * 来源：无（CSS 的 `url()` 只借语法，不实现 CSS Values 的 url 解析）
 * 等级：本侧新增
 *
 * `url()` → 引擎资源路径的公共校验，`@font-face` 与 `background-image` 共用同一套规则。
 *
 * 为何仅接受 `res://`：CSS 编译后会被内联进 JS（组件样式来自 styleUrls，编译后文件名亦
 * 不再保留），相对路径在运行时已无参照物。`res://` 是引擎的虚拟根，指向 `project.godot`
 * 所在目录，位于工程目录内的资源会随工程一并导出，运行时可直接加载。
 */

export interface ResourceUrlOptions {
  /** 告警中对该条声明的称呼，例如 `font-family "X" 的 src` 或 `background-image` */
  subject: string;
  /** 允许的后缀（小写、不带点） */
  extensions: ReadonlySet<string>;
  /** 后缀说明文案，直接拼接进告警 */
  extensionsText: string;
  /** 告警中给出的正确写法示例 */
  example: string;
}

/**
 * 从一段值中取出**唯一一个** `url()` 并校验路径。失败时返回 null，原因已写入 warnings。
 *
 * 仅允许一个 `url()`：CSS 的候选源列表依赖「逐个尝试直至可用」，Godot 的资源加载不存在
 * 该机制，书写多个只能拒收，而非默认取第一个。
 */
export function extractResourceUrl(
  raw: string,
  warnings: string[],
  options: ResourceUrlOptions,
): string | null {
  const { subject, extensions, extensionsText, example } = options;

  if (/\blocal\s*\(/i.test(raw)) {
    if (ngDevMode) warnings.push(`${subject} 的 local() 无落点：Godot 不按名称从系统取资源，请书写 res:// 路径`);
    return null;
  }

  const urls = [...raw.matchAll(/url\s*\(\s*([^)]*?)\s*\)/gi)];
  if (urls.length === 0) {
    if (ngDevMode) warnings.push(`${subject} 的 url() 缺失或写法不合法，已忽略（正确写法：${example}）`);
    return null;
  }
  if (urls.length > 1) {
    if (ngDevMode) warnings.push(`${subject} 书写了 ${urls.length} 个 url()，只支持一个：Godot 的资源加载不做候选源回退`);
    return null;
  }

  const path = unquote(urls[0][1]);
  if (!path.startsWith("res://")) {
    if (ngDevMode)
      warnings.push(
        `${subject} 的 url("${path}") 不是 res:// 路径，已忽略。CSS 编译后会被内联进 JS，相对路径`
          + `已无参照物；请将资源放入 Godot 工程目录并书写完整路径（如 ${example}）`,
      );
    return null;
  }
  const ext = (path.split("/").pop() ?? "").split(".").pop()?.toLowerCase() ?? "";
  if (!extensions.has(ext)) {
    if (ngDevMode)
      warnings.push(
        `${subject} 的 "${path}" 后缀 .${ext || "?"} 不在可加载范围内（${extensionsText}）`,
      );
    return null;
  }
  return path;
}

/** 去掉 CSS 字符串的外层引号 */
export function unquote(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.length > 1 && trimmed[trimmed.length - 1] === quote) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}
