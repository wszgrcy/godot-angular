type Level = "log" | "info" | "warn" | "error" | "debug";

const LEVELS: readonly Level[] = ["log", "info", "warn", "error", "debug"];
const MAX_TEXT = 4000;

function formatArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value);
  } catch {
    /* Godot 包装对象常常无法 stringify，逐级降级 */
  }
  try {
    return String(value);
  } catch {
    return `[unprintable ${typeof value}]`;
  }
}

/**
 * 安装转发。返回还原函数。
 *
 * 原始 console 仍会被调用一次——stdout 中保留一份，`--headless` 直接运行引擎时才有内容可看。
 */
export function forwardConsole(send: (payload: unknown) => void): () => void {
  // lib 中包含 dom 之后 console 就是真实 Console 类型，直接按 level 索引，
  // 不需要再绕 globalThis 做断言。
  const originals: Partial<Record<Level, Console[Level]>> = {};
  let inside = false;

  for (const level of LEVELS) {
    const original = console[level];
    originals[level] = original;

    console[level] = (...args: unknown[]) => {
      original.apply(console, args);
      if (inside) return;
      inside = true;
      try {
        const text = args.map(formatArg).join(" ");
        send({
          t: "log",
          level,
          text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}… [截断]` : text,
        });
      } catch {
        /* 转发失败绝不能导致测试本身失败 */
      } finally {
        inside = false;
      }
    };
  }

  return () => {
    for (const level of LEVELS) {
      const original = originals[level];
      if (original) console[level] = original;
    }
  };
}
