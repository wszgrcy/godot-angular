import type { Plugin } from "vite";
import MagicString from "magic-string";

/** 外部说明符判定：与 build-core 中 external 的判定保持一致 */
const isGodotSpecifier = (source: string): boolean =>
  source === "godot" || source.startsWith("godot/");

/** filter 的“包含”闸门：源码中未出现带引号的 godot 时整个模块跳过 */
const GODOT_GATE = ['"godot"', "'godot'"];

/** babel 的 AST 节点，此处仅用到极少的字段，不引入 @babel/types 依赖 */
interface LooseSpecifier {
  type: string;
  start: number | null;
  end: number | null;
  local?: { name: string };
}
interface LooseImport {
  type: string;
  start: number | null;
  end: number | null;
  specifiers: LooseSpecifier[];
  source: { value: string; start: number | null; end: number | null };
}

async function loadBabel(): Promise<{ parseSync: typeof import("@babel/core").parseSync }> {
  // 仅在确实命中时才会执行到此处，因此 babel 采用动态加载（构建期零成本）
  const babel = await import("@babel/core");
  return { parseSync: babel.parseSync };
}

export function godotInteropPlugin(
  log: (msg: string) => void,
): Plugin {
  return {
    name: "godot-angular-godot-interop",
    enforce: "post",

    transform: {
      filter: { code: GODOT_GATE },
      async handler(code, id) {
        let program: { body: LooseImport[] };
        try {
          const { parseSync } = await loadBabel();
          const file = parseSync(code, {
            configFile: false,
            babelrc: false,
            sourceType: "unambiguous",
            // post 阶段拿到的是编译后的 JS，不需要任何 TS / 装饰器插件
            parserOpts: { sourceType: "unambiguous", allowAwaitOutsideFunction: true },
          });
          if (!file) return null;
          program = file.program as unknown as { body: LooseImport[] };
        } catch (err) {
          // 无法解析时保持原样：保留 interop 包装，避免正常模块损坏
          log(
            `godot interop：跳过 ${id.split("/").slice(-2).join("/")}（解析失败：${(err as Error).message}）`,
          );
          return null;
        }

        const targets = program.body.filter(
          (n) => n.type === "ImportDeclaration" && isGodotSpecifier(n.source?.value ?? ""),
        );
        if (targets.length === 0) return null;

        const s = new MagicString(code);
        let rewritten = 0;

        for (const decl of targets) {
          // default / namespace：这两个才产生 interop 包装
          const wrapped = decl.specifiers.filter(
            (sp) => sp.type === "ImportDefaultSpecifier" || sp.type === "ImportNamespaceSpecifier",
          );
          if (wrapped.length === 0) continue;

          const named = decl.specifiers.filter((sp) => sp.type === "ImportSpecifier");
          const sourceText = code.slice(decl.source.start!, decl.source.end!);
          const consts = wrapped
            .map((sp) => `const ${sp.local!.name} = require(${sourceText});`)
            .join("\n");

          // 重写整条语句，不逐个删除说明符：后者需要自行处理逗号位置与非法形状，分支多且容易出错。
          // 统一替换为“一条纯具名 import（可能没有）+ 几个 const”，对任意形状都成立。
          const replacement = named.length
            ? `import { ${named.map((sp) => code.slice(sp.start!, sp.end!)).join(", ")} } from ${sourceText};\n${consts}`
            : consts;
          s.overwrite(decl.start!, decl.end!, replacement);
          rewritten += wrapped.length;
        }

        if (rewritten === 0) return null;

        log(
          `godot interop：${id.split("/").slice(-2).join("/")} 改写 ${rewritten} 处 ` +
            `default/namespace 导入为裸 require`,
        );
        return { code: s.toString(), map: s.generateMap({ hires: true }).toString() };
      },
    },
  };
}
