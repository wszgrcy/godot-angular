import { CssCode, CssWarning, cssCodeLabel } from "godot-angular/css";

/**
 * 一次 `captureWarn` 期间收集到的告警。
 *
 * 断言优先用 `codes` / `items`（按 `CssCode` 判断）。`warnings` 保留原始文本，
 * 只用于“确实告警了 / 一条都没告警”这类粗断言，以及失败时把内容带进断言信息。
 */
export interface WarnCapture {
  /** 打印出来的原文（含 `[godot-angular]` 前缀） */
  warnings: string[];
  /** 从原文解析出的诊断码，顺序与 `warnings` 一致 */
  codes: CssCode[];
  /** 被捕获的告警条数 */
  count: number;
}

/** 输出格式由 `packages/library/core/warn.ts` 固定：`[godot-angular] [忽略] CUJ-1001: 文案` */
const CODE_IN_TEXT = /CUJ-(\d+)/;

export function captureWarn<T>(fn: () => T): { result: T; warn: WarnCapture } {
  const warn: WarnCapture = { warnings: [], codes: [], count: 0 };
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    const text = args.map((a) => String(a)).join(" ");
    warn.count++;
    warn.warnings.push(text);
    warn.codes.push(Number(CODE_IN_TEXT.exec(text)?.[1] ?? 0));
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

/**
 * 断言某个诊断码出现过。
 *
 * 文案会随说明需要调整，码不会，因此测试一律按码断言。
 */
export function expectWarnCode(warn: WarnCapture, code: CssCode): void {
  if (!warn.codes.includes(code)) {
    throw new Error(
      `期望出现诊断码 ${cssCodeLabel(code)}（${CssWarning.name}），实际捕获到 ` +
        `[${warn.codes.join(", ")}]：\n${warn.warnings.join("\n")}`,
    );
  }
}

/** 断言一条告警都没有（比 `expect(warnings).toEqual([])` 多出码信息） */
export function expectNoWarn(warn: WarnCapture): void {
  if (warn.count > 0) {
    throw new Error(`期望没有告警，实际捕获到：\n${warn.warnings.join("\n")}`);
  }
}
