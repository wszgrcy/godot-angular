import { CUJ_COVERAGE_KEY } from "../../shared/coverage";

export { CUJ_COVERAGE_KEY };

/** istanbul 单个文件的覆盖率条目，仅声明此处需要修改的字段。 */
interface CoverageEntry {
  s?: Record<string, number>;
  f?: Record<string, number>;
  b?: Record<string, number[]>;
  inputSourceMap?: unknown;
  [key: string]: unknown;
}

export type CoverageStore = Record<string, CoverageEntry>;

function anyHit(entry: CoverageEntry): boolean {
  for (const v of Object.values(entry.s ?? {})) if (v) return true;
  for (const v of Object.values(entry.f ?? {})) if (v) return true;
  for (const counts of Object.values(entry.b ?? {})) if (counts.some((c) => c)) return true;
  return false;
}

function cloneCounters(entry: CoverageEntry): CoverageEntry {
  const b: Record<string, number[]> = {};
  for (const [key, counts] of Object.entries(entry.b ?? {})) b[key] = [...counts];
  return { ...entry, s: { ...(entry.s ?? {}) }, f: { ...(entry.f ?? {}) }, b };
}

function zeroCounters(entry: CoverageEntry): void {
  for (const key of Object.keys(entry.s ?? {})) entry.s![key] = 0;
  for (const key of Object.keys(entry.f ?? {})) entry.f![key] = 0;
  for (const key of Object.keys(entry.b ?? {})) entry.b![key] = entry.b![key].map(() => 0);
}

/**
 * 取出“自上次调用以来确实执行过”的文件，并将其计数清零。
 * 未执行到的文件整体跳过：条目中的 statementMap 远大于计数，全量上报一次就是几百 KB。
 *
 * `sentMaps` 是一份去重名单：inputSourceMap（仅应用代码插桩时存在）对同一个文件恒定不变，
 * 但同一个模块会被多个 spec 命中，不去重则会上报 N 份相同的 map。
 */
export function takeCoverageDelta(store: CoverageStore | undefined | null, sentMaps?: Set<string>): CoverageStore {
  const delta: CoverageStore = {};
  if (!store) return delta;
  for (const [file, entry] of Object.entries(store)) {
    if (!anyHit(entry)) continue;
    const copy = cloneCounters(entry);
    if (copy.inputSourceMap === undefined || sentMaps?.has(file)) delete copy.inputSourceMap;
    else sentMaps?.add(file);
    zeroCounters(entry);
    delta[file] = copy;
  }
  return delta;
}
