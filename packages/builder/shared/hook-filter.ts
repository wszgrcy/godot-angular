import { makeIdFiltersToMatchWithQuery } from "@rolldown/pluginutils";

/** 恒不匹配。用于“白名单为空”的场景（空数组是“全匹配”，不是“全不匹配”） */
export const NEVER_ID: RegExp = /(?!)/;

/** 后缀匹配——`id.endsWith(suffix)` 的 filter 版本；pluginutils 只提供了 exact 与 prefix */
export function idEndingWith(suffix: string): RegExp {
  return makeIdFiltersToMatchWithQuery(new RegExp(`${escapeRe(suffix)}$`));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
