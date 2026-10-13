import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const outDir = join(repoRoot, "dist", "builder");
const outFile = join(outDir, "config", "schema.json");

const PACKAGE_NAME = "godot-angular";

/** builder 名 → 其选项 schema（gen-schema.ts 的产物，形状只有一份来源） */
const BUILDERS: { name: string; schema: string }[] = [
  { name: "application", schema: join(outDir, "application", "schema.json") },
  { name: "vitest", schema: join(outDir, "vitest", "build", "schema.json") },
];

/** 与 CLI 生成器一致：内联进 workspace schema 时丢弃这些键 */
const STRIP_KEYS = new Set(["$schema", "$id", "id", "required", "x-prompt", "x-user-analytics"]);

const DEFAULT_CONFIG_DESCRIPTION =
  "A default named configuration to use when a target configuration is not provided.";

type Json = Record<string, unknown>;

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** `godot-angular` + `application` → `GodotAngularBuildersApplicationSchema` */
function definitionKey(builderName: string): string {
  return (
    PACKAGE_NAME.split(/[-_]/).map(capitalize).join("") +
    "Builders" +
    capitalize(builderName) +
    "Schema"
  );
}

/** 内联：剔除不应带入的键，并将 `#/definitions/...` 重新挂到本定义下 */
function inlineSchema(value: unknown, key: string): unknown {
  if (Array.isArray(value)) return value.map((item) => inlineSchema(item, key));
  if (!value || typeof value !== "object") return value;
  const out: Json = {};
  for (const [entryKey, entryValue] of Object.entries(value as Json)) {
    if (STRIP_KEYS.has(entryKey)) continue;
    if (entryKey === "$ref" && typeof entryValue === "string") {
      out[entryKey] = entryValue.startsWith("#/definitions/")
        ? entryValue.replace("#/definitions/", `#/definitions/${key}/definitions/`)
        : entryValue;
      continue;
    }
    out[entryKey] = inlineSchema(entryValue, key);
  }
  return out;
}

function targetBranch(builderId: string, ref: string): Json {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      builder: { const: builderId },
      defaultConfiguration: { type: "string", description: DEFAULT_CONFIG_DESCRIPTION },
      options: { $ref: ref },
      configurations: { type: "object", additionalProperties: { $ref: ref } },
    },
  };
}

/** 内联之后 `$ref` 最容易指向空，此处逐个遍历，指向空就报错而不是留下错误的 schema */
function assertRefsResolve(schema: Json): void {
  const missing: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node as Json)) {
      if (key === "$ref" && typeof value === "string" && value.startsWith("#/")) {
        let current: unknown = schema;
        for (const part of value.slice(2).split("/")) {
          current = (current as Json | undefined)?.[part];
        }
        if (current === undefined) missing.push(value);
      } else {
        walk(value);
      }
    }
  };
  walk(schema);
  if (missing.length) {
    throw new Error(`存在无法解析的 $ref：${[...new Set(missing)].join(", ")}`);
  }
}

function buildSchema(): Json {
  const basePath = require.resolve("@angular/cli/lib/config/schema.json");
  const schema = JSON.parse(readFileSync(basePath, "utf8")) as Json;
  const project = (schema.definitions as Json).project as Json;
  const target = ((project.definitions as Json).target ?? {}) as Json;
  const oneOf = target.oneOf as Json[] | undefined;
  if (!Array.isArray(oneOf)) {
    throw new Error("基底 schema 缺少 definitions.project.definitions.target.oneOf（CLI 可能已变更结构）");
  }

  const builderIds = BUILDERS.map((b) => `${PACKAGE_NAME}:${b.name}`);
  schema.$id = `${PACKAGE_NAME}://config/schema.json`;
  schema.title = "godot-angular CLI Workspace Configuration";

  // 幂等：重跑不会重复插入分支
  const builderConst = (branch: Json): string =>
    String(
      ((((branch.properties as Json | undefined) ?? {}) as Json).builder as Json | undefined)?.const ?? "",
    );
  target.oneOf = oneOf.filter((branch) => !builderIds.includes(builderConst(branch)));

  const generic = (target.oneOf as Json[]).find((branch) =>
    String(branch?.$comment ?? "").startsWith("Extendable target with custom builder"),
  );
  if (!generic) throw new Error("基底 schema 中未找到 custom builder 的兜底分支");
  const not = ((generic.properties as Json).builder as Json).not as Json | undefined;
  const notEnum = ((not?.enum ?? []) as string[]);
  if (not) not.enum = notEnum;
  for (const id of builderIds) {
    // 兜底分支必须排除本包 builder，否则 oneOf 命中两条，校验失败
    if (!notEnum.includes(id)) notEnum.push(id);
  }

  for (const builder of BUILDERS) {
    if (!existsSync(builder.schema)) {
      throw new Error(
        `无法读取 ${relative(repoRoot, builder.schema)}。请先执行 pnpm build:builder（其中的 gen-schema 步骤）。`,
      );
    }
    const builderSchema = JSON.parse(readFileSync(builder.schema, "utf8")) as Json;
    const key = definitionKey(builder.name);
    (schema.definitions as Json)[key] = inlineSchema(builderSchema, key);
    (target.oneOf as Json[]).push(targetBranch(`${PACKAGE_NAME}:${builder.name}`, `#/definitions/${key}`));
  }

  assertRefsResolve(schema);
  return schema;
}

/**
 * 登记到发布包 package.json 的 exports。
 * 必须在库构建之后运行：ng-packagr 会将 exports 中的子路径当作二级入口探测，
 * 先写入后构建会被它移除。
 */
function registerExport(outPath: string): void {
  const pkgPath = join(repoRoot, "dist", "package.json");
  if (!existsSync(pkgPath)) {
    console.warn("dist/package.json 不存在，跳过 exports 登记（请先执行 pnpm build:lib）");
    return;
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { exports?: Record<string, unknown> };
  const rel = "./" + relative(dirname(pkgPath), outPath).split("\\").join("/");
  if (rel.startsWith("./..")) return;
  pkg.exports ??= {};
  if (pkg.exports[rel] === undefined) {
    pkg.exports[rel] = { default: rel };
    writeFileSync(pkgPath, `${JSON.stringify(pkg, undefined, 2)}\n`);
    console.log(`exports 已登记：${rel}`);
  }
}

const check = process.argv.includes("--check");
const text = `${JSON.stringify(buildSchema(), undefined, 2)}\n`;
if (check) {
  if (!existsSync(outFile)) {
    console.error("dist/builder/config/schema.json 不存在（dist/builder 不完整）。请先执行 pnpm build:builder。");
    process.exit(1);
  }
  if (readFileSync(outFile, "utf8") !== text) {
    console.error("dist/builder/config/schema.json 与基底 CLI schema 不同步，请执行 pnpm build:builder");
    process.exit(1);
  }
  console.log("builder/config/schema.json 与基底一致（CLI builder 分支 + 本包 2 个）");
} else {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, text);
  registerExport(outFile);
  console.log(
    `builder/config/schema.json 已生成（基底 @angular/cli，注入 ${BUILDERS.map((b) => b.name).join(" / ")}）`,
  );
}
