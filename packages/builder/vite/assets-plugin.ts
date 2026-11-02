import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite";
import { toPosix } from "../shared/path";
import { globInputPaths } from "./glob-input";
import type { NormalizedAsset } from "./options";

/**
 * `assets` 插件。产物名相对 vite outDir（就是 outputPath），与上游给的 output 子目录直接拼。
 */
export function assetsPlugin(assets: NormalizedAsset[], workspaceRoot: string): Plugin {
  return {
    name: "godot-angular-assets",
    enforce: "post",
    generateBundle(_info, _bundle) {
      for (const asset of assets) {
        for (const { rel, abs } of globInputPaths(workspaceRoot, asset)) {
          // fileName 会进入产物目录与 emitFile，只认 /；Windows 上 join 返回反斜杠
          const fileName = toPosix(join(asset.output, rel));
          this.emitFile({
            type: "asset",
            fileName,
            source: new Uint8Array(readFileSync(abs)),
          });
        }
      }
    },
  };
}
