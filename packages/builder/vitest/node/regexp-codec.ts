const RE_TAG = "__cujRegExp__";

function packValue(value: unknown): unknown {
  if (value instanceof RegExp) return { [RE_TAG]: [value.source, value.flags] };
  if (Array.isArray(value)) return value.map(packValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = packValue(v);
    return out;
  }
  return value;
}

function reviveValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviveValue);
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const tag = rec[RE_TAG];
    if (Array.isArray(tag) && typeof tag[0] === "string") {
      return new RegExp(tag[0], String(tag[1] ?? ""));
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) out[k] = reviveValue(v);
    return out;
  }
  return value;
}

/** 宿主下发前调用：将 WorkerRequest.context 中的 RegExp 转为可序列化形状 */
export function packContext(message: unknown): unknown {
  const msg = message as { context?: Record<string, unknown> } | null;
  if (!msg || typeof msg !== "object" || !msg.context) return message;
  const ctx = msg.context;
  return {
    ...msg,
    context: {
      ...ctx,
      ...(ctx.config !== undefined ? { config: packValue(ctx.config) } : {}),
      ...(ctx.files !== undefined ? { files: packValue(ctx.files) } : {}),
    },
  };
}

/** 引擎收到后调用：还原 packContext 输出的 RegExp */
export function reviveContext(frame: unknown): unknown {
  const msg = frame as { context?: Record<string, unknown> } | null;
  if (!msg || typeof msg !== "object" || !msg.context) return frame;
  const ctx = msg.context;
  return {
    ...msg,
    context: {
      ...ctx,
      ...(ctx.config !== undefined ? { config: reviveValue(ctx.config) } : {}),
      ...(ctx.files !== undefined ? { files: reviveValue(ctx.files) } : {}),
    },
  };
}
