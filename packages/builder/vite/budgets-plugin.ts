import type { Plugin } from "vite";
import type { BudgetEntry } from "./options-schema";

/** @angular/build 的 BudgetStats 中本实现使用到的部分 */
interface BudgetStats {
  chunks: { names: string[]; files: string[]; initial: boolean }[];
  assets: { name: string; size: number }[];
}

interface BudgetResult {
  severity: string;
  message: string;
}

type BudgetChecker = (
  budgets: BudgetEntry[],
  stats: BudgetStats,
  checkComponentStyles?: boolean,
) => Iterable<BudgetResult>;

export function budgetsPlugin(options: {
  budgets?: BudgetEntry[];
  statsJson?: boolean;
  log: (level: "warn" | "info", msg: string) => void;
}): Plugin {
  return {
    name: "godot-angular-budgets",
    async generateBundle(_info, bundle) {
      // bundle 的具体类型跟随 vite 的 Plugin 声明（vite 8 底层是 rolldown，
      // 而 rolldown 不是本包的直接依赖，不能 import 它的类型）。
      type Entry = (typeof bundle)[string];
      const sizeOf = (item: Entry): number => {
        if (item.type === "chunk") return Buffer.byteLength(item.code, "utf8");
        const source = item.source;
        return typeof source === "string"
          ? Buffer.byteLength(source, "utf8")
          : (source as Uint8Array).byteLength;
      };

      // stats.json 自身不应计入体积，因此先计算 stats 再 emit
      const stats: BudgetStats = { chunks: [], assets: [] };
      for (const [fileName, item] of Object.entries(bundle)) {
        stats.assets.push({ name: fileName, size: sizeOf(item) });
        if (item.type === "chunk") {
          stats.chunks.push({ names: [item.name], files: [fileName], initial: item.isEntry });
        }
      }

      if (options.statsJson) {
        this.emitFile({ type: "asset", fileName: "stats.json", source: `${JSON.stringify(stats, null, 2)}\n` });
      }
      if (!options.budgets?.length) return;

      const { checkBudgets, ThresholdSeverity } = (await import("@angular/build/private")) as unknown as {
        checkBudgets: BudgetChecker;
        ThresholdSeverity: { Warning: string; Error: string };
      };
      const errors: string[] = [];
      for (const result of checkBudgets(options.budgets, stats)) {
        if (result.severity === ThresholdSeverity.Error) errors.push(result.message);
        else options.log("warn", `[budgets] ${result.message}`);
      }
      if (errors.length) {
        throw new Error(`产物体积超出 budgets 限制：\n  - ${errors.join("\n  - ")}`);
      }
    },
  };
}
