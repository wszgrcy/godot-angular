import type { Plugin } from "vite";
import MagicString from "magic-string";

/** 外部说明符判定：与 build-core 中 external 的判定保持一致 */
const isGodotSpecifier = (source: string): boolean =>
  source === "godot" || source.startsWith("godot/");

/** filter 的“包含”闸门：源码中未出现带引号的 godot 时整个模块跳过 */
const GODOT_GATE = ['"godot"', "'godot'"];

/** babel 的 AST 节点，此处仅用到极少的字段，不引入 @babel/types 依赖 */
interface LooseImportedName {
  type: string;
  name?: string;
  value?: string;
  start: number | null;
  end: number | null;
}
interface LooseSpecifier {
  type: string;
  start: number | null;
  end: number | null;
  local?: { name: string };
  imported?: LooseImportedName;
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

/** `import { "a-b" as x }` 里的导入名是字符串字面量，取值方式与标识符不同 */
function importedAccessor(p: LooseImportedName, code: string): string {
  if (p.type === "StringLiteral") return `[${JSON.stringify(p.value)}]`;
  return `.${p.name ?? code.slice(p.start!, p.end!)}`;
}

/**
 * 把 `godot` 模块的 import 统一改写成“先整体取模块，再点属性”。
 *
 * 引擎侧的 `godot` 模块是一个 Proxy，列不出自有属性，因此 ESM 链接阶段无法为它生成具名导出
 * （上游用例 `tests/project/tests/esm/godot_named.mjs` 断言的就是这件事）。能用的写法只有
 * 默认导入：`import gd from "godot"; gd.Node`。
 *
 * 于是源码里三种写法都归一到同一种：
 *   import gd from "godot"        →  import __gd$0 from "godot"; const gd = __gd$0;
 *   import * as gd from "godot"   →  同上（命名空间对象上只有 default，不能直接点类名）
 *   import { Node } from "godot"  →  import __gd$0 from "godot"; const Node = __gd$0.Node;
 */
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
        // 同一条说明符只引入一个默认绑定；重复出现的声明只补属性，不再重复 import
        const bindings = new Map<string, string>();

        for (const decl of targets) {
          if (decl.specifiers.length === 0) continue; // 纯副作用 import 原样保留
          const sourceText = code.slice(decl.source.start!, decl.source.end!);
          let ns = bindings.get(sourceText);
          const first = ns === undefined;
          if (first) {
            ns = `__gd$${bindings.size}`;
            bindings.set(sourceText, ns);
          }

          const lines: string[] = [];
          for (const sp of decl.specifiers) {
            const local = sp.local!.name;
            if (sp.type === "ImportSpecifier" && sp.imported) {
              lines.push(`const ${local} = ${ns}${importedAccessor(sp.imported, code)};`);
            } else {
              // default 与 namespace 都直接等于模块本身
              lines.push(`const ${local} = ${ns};`);
            }
            rewritten++;
          }

          const head = first ? `import ${ns} from ${sourceText};\n` : "";
          s.overwrite(decl.start!, decl.end!, head + lines.join("\n"));
        }

        if (rewritten === 0) return null;

        log(
          `godot interop：${id.split("/").slice(-2).join("/")} 改写 ${rewritten} 处 ` +
            `godot 导入为“整体取模块 + 点属性”`,
        );
        return { code: s.toString(), map: s.generateMap({ hires: true }).toString() };
      },
    },
  };
}
