import { CssWarning, type WarnLevel } from "godot-angular/css";

const warned = new Set<string>();

/**
 * 运行期覆盖。`undefined` 表示按 `ngDevMode` 判定。
 *
 * 生产构建中 `ngDevMode` 已被替换为常量，整段告警连同文案一并摇除，无需运行期开关；
 * 保留该入口是为了在未开启优化的构建（例如测试进程）中也能验证「关闭之后确实静默」。
 */
let enabled: boolean | undefined;

/**
 * 运行期告警是否允许输出到控制台。
 *
 * 此为第二道闸门。第一道位于调用点：每条告警均包裹于 `if (ngDevMode)` 中，生产构建中整条分支
 * 连同文案一并消除，根本不予收集。本函数负责的是另一件事：使测试进程能在不开启优化
 * 构建的前提下验证「关闭之后确实静默」。
 *
 * 来源：Angular `packages/core/src/util/ng_dev_mode.ts`
 * 等级：仅思路一致
 * 差异：本侧的 `ngDevMode` 由构建器于编译期固定（见 `typings/ng-dev-mode.d.ts`），
 * 运行期仅有 true / false，因此直接取用，不做 `typeof` 探测，也不挂接性能计数器。
 */
export function warnEnabled(): boolean {
  if (enabled !== undefined) return enabled;
  return ngDevMode;
}

/**
 * 清空去重表，使下一条告警重新输出。
 *
 * 仅供测试使用：控制台输出为全局去重，同一引擎进程中运行多个 spec 时，
 * 先运行的用例会消耗掉键，后运行用例中“确实告警了”一类断言就会误失败。
 * 产品代码不应调用该函数。
 */
export function resetWarnOnce(): void {
  warned.clear();
}

/**
 * 开启或关闭运行期告警（`undefined` 表示恢复按 `ngDevMode` 判定）。仅供测试使用。
 */
export function setWarnEnabled(on: boolean | undefined): void {
  enabled = on;
}

/**
 * 输出前缀：按等级附加一个标记。
 *
 * `忽略` = 该条声明被丢弃，必须改写；`兼容` = 已生效但仅为近似，能否接受由使用者判断。
 */
const LEVEL_TAG: Record<WarnLevel, string> = { ignore: "[忽略]", compat: "[兼容]" };

/**
 * 结构化诊断通道（`StyleRuntimeOptions.onDiagnostic` 注册）。
 *
 * 与控制台输出的区别：控制台输出按「码 + 参数」去重且受 `warnEnabled()` 约束，
 * 该通道每次上报都会收到，便于测试与开发者工具逐条核对。
 */
let sink: ((warning: CssWarning) => void) | undefined;

export function setDiagnosticSink(fn: ((warning: CssWarning) => void) | undefined): void {
  sink = fn;
}

/**
 * 上报一条诊断：先送结构化通道，再按去重结果决定是否打印到控制台。
 *
 * 调用点必须整条包裹于 `if (ngDevMode)`，生产构建中连 `CssWarning` 都不会构造。
 */
export function reportWarning(warning: CssWarning): void {
  sink?.(warning);
  if (!warnEnabled()) return;
  const key = warning.dedupeKey;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[godot-angular] ${LEVEL_TAG[warning.level]} ${warning}`);
}
