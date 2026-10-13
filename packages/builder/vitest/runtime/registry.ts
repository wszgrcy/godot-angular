import { toPosix } from "../../shared/path";

/**
 * spec 模块注册表。表中存储 `() => import(...)` 而不是静态 import：vitest 依赖
 * `importFile()` 的求值时机收集用例，提前求值 = `describe()` 跑在收集上下文之外。
 * 宿主下发的是宿主机绝对路径，此处按后缀匹配，两边经过同一个 normalize。
 */
export type TestModuleMap = Readonly<Record<string, () => unknown | Promise<unknown>>>;

export interface TestModuleRegistry {
  load(filepath: string): unknown | Promise<unknown>;
  keys(): string[];
}

function normalize(value: string): string {
  return toPosix(value)
    .replace(/^\.\//, "")
    .toLowerCase();
}

export function createTestModuleRegistry(modules: TestModuleMap): TestModuleRegistry {
  const entries = Object.entries(modules).map(
    ([key, load]) => [normalize(key), load] as const,
  );
  const describe = (): string =>
    `已打包模块 ${entries.length} 个：${entries
      .map(([key]) => key)
      .slice(0, 10)
      .join(", ")}`;

  return {
    keys: () => entries.map(([key]) => key),
    load(filepath: string) {
      const target = normalize(filepath);
      const matches = entries.filter(([key]) => target.endsWith(key));
      if (matches.length === 0) {
        throw new Error(
          `spec "${filepath}" 未被打包进引擎产物。${describe()}\n` +
            `宿主侧依据 sidecar 中的 glob 重新匹配到该文件，两侧 glob 规则一致，\n` +
            `因此最常见的原因是**引擎 bundle 已过期**：新增或重命名 spec 后未重新构建。` +
            `请重新执行 ng run <app>:engine-test（或 pnpm test），二者都会先重建产物。`,
        );
      }
      if (matches.length > 1) {
        throw new Error(
          `spec "${filepath}" 同时匹配到多个已打包模块：${matches.map(([key]) => key).join(", ")}`,
        );
      }
      return matches[0][1]();
    },
  };
}
