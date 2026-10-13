import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { globSync } from "tinyglobby";
import type { Plugin } from "vite";
import { toPosix } from "../shared/path";
import type { NormalizedAsset } from "./options";

export function assetsPlugin(
  assets: NormalizedAsset[],
  workspaceRoot: string,
): Plugin {
  return {
    name: "godot-angular-assets",
    enforce: "post",
    generateBundle(_info, _bundle) {
      for (const asset of assets) {
        const inputRoot = resolve(workspaceRoot, asset.input);
        const found = globSync([asset.glob], {
          cwd: inputRoot,
          ignore: asset.ignore,
          expandDirectories: false,
          onlyFiles: true,
        });
        for (const rel of found) {
          // fileName 会进入产物目录与 emitFile，只认 /；Windows 上 join 返回反斜杠
          const fileName = toPosix(join(asset.output, rel));
          this.emitFile({
            type: "asset",
            fileName,
            source: new Uint8Array(readFileSync(join(inputRoot, rel))),
          });
        }
      }
    },
  };
}
