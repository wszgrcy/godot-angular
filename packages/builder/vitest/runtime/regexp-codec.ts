const RE_TAG = "__cujRegExp__";

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

/** 还原宿主 packContext 打出去的 RegExp（只走 context，成本可控） */
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
