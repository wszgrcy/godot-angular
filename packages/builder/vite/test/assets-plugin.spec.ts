import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { assetsPlugin } from "../assets-plugin";
import type { NormalizedAsset } from "../options";

/**
 * assets 的产物名相对 vite outDir（就是 outputPath），由 asset.output 与匹配到的相对路径
 * 拼成。这里钉住拼接结果与斜杠方向（Windows 上 join 会给反斜杠，产物名必须是 /）。
 */
function collect(assets: NormalizedAsset[]): string[] {
  const plugin = assetsPlugin(assets, resolve(__dirname));
  const names: string[] = [];
  const hook = plugin.generateBundle as unknown as (
    this: { emitFile: (f: { fileName: string }) => void },
    info: unknown,
    bundle: unknown,
  ) => void;
  hook.call({ emitFile: (f) => names.push(f.fileName) }, {}, {});
  return names.sort();
}

const asset: NormalizedAsset = { glob: "**/*.ts", input: "fixtures/entries", output: "static", ignore: [] };

describe("assets 产物名", () => {
  it("落在 output 子目录下，且一律用 /", () => {
    const names = collect([asset]);
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => n.startsWith("static/"))).toBe(true);
    expect(names).toContain("static/src/main.ts");
    expect(names.every((n) => !n.includes("\\"))).toBe(true);
  });
});
