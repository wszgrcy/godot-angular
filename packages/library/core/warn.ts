const warned = new Set<string>();

export function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[godot-angular] ${message}`);
}

/**
 * 清空去重表，使下一条 `warnOnce` 重新输出。
 *
 * 仅供测试使用：warnOnce 是全局去重的，同一引擎进程里运行多个 spec 时，
 * 先运行的用例会消耗 key，后运行用例中“确实告警了”这类断言就会误失败。
 * 产品代码不应调用它。
 */
export function resetWarnOnce(): void {
  warned.clear();
}
