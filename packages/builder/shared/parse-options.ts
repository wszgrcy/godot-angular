import * as v from "valibot";
import type { BaseIssue } from "valibot";

/**
 * 解析选项并补充默认值。默认值的唯一来源是 schema 的 `v.optional(形状, 默认值)`，下游无需
 * 再写 `?? 默认值`。注意 `v.object` 会丢弃未声明的键，因此 parse 必须在附加内部字段之前执行。
 */
export function parseOptions<S extends v.BaseSchema<unknown, unknown, BaseIssue<unknown>>>(
  schema: S,
  raw: unknown,
  label: string,
): v.InferOutput<S> {
  // 使用 safeParse 而不是 parse：校验失败是**预期内的返回值**（result.issues），
  // 而不是异常。parse 会把 issues 包装成 ValiError 抛出，就需要 try/catch + instanceof
  // 才能取回原始 issue，还会顺手吞掉或误判其他异常。
  const result = v.safeParse(schema, raw);
  if (!result.success) {
    // label 放在开头：一次调用只校验一个 schema，summarize 的行内路径不需要再带前缀。
    throw new Error(`${label} 选项校验失败：\n${v.summarize(result.issues)}`);
  }
  return result.output;
}
