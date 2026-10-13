export interface WarnCapture {
  /** 期间收集到的 warn 首参（转为字符串） */
  warnings: string[];
  /** 被捕获的 warn 条数 */
  count: number;
}

export function captureWarn<T>(fn: () => T): { result: T; warn: WarnCapture } {
  const warn: WarnCapture = { warnings: [], count: 0 };
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warn.count++;
    warn.warnings.push(args.map((a) => String(a)).join(" "));
  };
  try {
    return { result: fn(), warn };
  } finally {
    console.warn = original;
  }
}

/** 断言“确实发生了告警”，并将 warn 内容一并带入失败信息 */
export function expectWarned(warn: WarnCapture): void {
  if (warn.count === 0) {
    throw new Error("期望 console.warn 被调用，但未捕获到任何调用");
  }
}
