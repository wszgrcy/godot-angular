import { toJsonSchema, type ConversionConfig } from "@valibot/to-json-schema";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  applicationOptionsSchema,
  assetPatternSchema,
  budgetSchema,
  engineOptionsSchema,
  vitestOptionsSchema,
} from "../packages/builder/vite/options-schema";

type Schema = Parameters<typeof toJsonSchema>[0];

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "dist", "builder");

const UPSTREAM_PACKAGE = "@angular/build";
const UPSTREAM_SCHEMA_SUBPATH = "src/builders/application/schema.json";

/** 名称与语义取自上游的字段。上游删除其中任何一个都会在此处报错，而不是静默缺少字段。 */
const UPSTREAM_FIELDS = [
  "assets",
  "budgets",
  "conditions",
  "define",
  "deleteOutputPath",
  "externalDependencies",
  "fileReplacements",
  "loader",
  "optimization",
  "outputHashing",
  "outputPath",
  "poll",
  "polyfills",
  "preserveSymlinks",
  "sourceMap",
  "statsJson",
  "styles",
  "tsConfig",
  "verbose",
  "watch",
] as const;

/** 读取上游 schema。exports 阻止访问子路径，只能先解析 package.json 再拼接。 */
function readUpstream(): { properties: Record<string, unknown>; version: string } {
  const pkgJson = require.resolve(`${UPSTREAM_PACKAGE}/package.json`);
  const version = JSON.parse(readFileSync(pkgJson, "utf8")).version as string;
  const schema = JSON.parse(
    readFileSync(join(dirname(pkgJson), UPSTREAM_SCHEMA_SUBPATH), "utf8"),
  ) as { properties?: Record<string, unknown> };
  return { properties: schema.properties ?? {}, version };
}

/** 上游删除所接续的字段时直接报错，不默默缺少字段。 */
function assertUpstream(
  upstream: Record<string, unknown>,
  version: string,
): void {
  const missing = UPSTREAM_FIELDS.filter((k) => !(k in upstream));
  if (missing.length) {
    throw new Error(
      `在 ${UPSTREAM_PACKAGE}@${version} 中未找到以下字段：${missing.join(", ")}。` +
        `上游可能已移除这些字段，请同步更新 options-schema 与 UPSTREAM_FIELDS。`,
    );
  }
}

/**
 * 转换器输出的是 draft-2020 风格的 `$defs`，Angular CLI 侧按 draft-07 的 `definitions`
 * 解析。同时移除空 `required: []`——那是 valibot 对全可选项对象的写法，在此处属于噪声。
 */
function toDraft7(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toDraft7);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === "$defs") {
      out["definitions"] = toDraft7(v);
      continue;
    }
    if (k === "required" && Array.isArray(v) && v.length === 0) continue;
    if (k === "$ref" && typeof v === "string") {
      out[k] = v.replace("#/$defs/", "#/definitions/");
      continue;
    }
    out[k] = toDraft7(v);
  }
  return out;
}

function convert(
  schema: Schema,
  definitions?: ConversionConfig["definitions"],
): Record<string, unknown> {
  return toDraft7(
    toJsonSchema(schema, { target: "draft-07", errorMode: "throw", definitions }),
  ) as Record<string, unknown>;
}

interface Target {
  /** 仅用于日志 */
  name: string;
  /** 相对 dist/builder 的输出路径，同时也是 builders.json 里 schema 的相对路径 */
  out: string;
  title: string;
  summary: string;
  schema: Schema;
  /** 仅登记确实被引用到的子形状，否则 definitions 中会出现无人引用的定义 */
  definitions?: ConversionConfig["definitions"];
  /** 存在上游时才做对账；vitest builder / typings 是本包独有的 */
  upstream: boolean;
  /** 本包独有时的形状源文件（写入产物描述，不要指向错误文件） */
  source?: string;
}

const TARGETS: Target[] = [
  {
    name: "application",
    out: "application/schema.json",
    title: "GodotJS application",
    summary: "将 Angular 应用构建为 GodotJS 可 require 的 CJS（vite + @analogjs/vite-plugin-angular）。",
    schema: applicationOptionsSchema,
    upstream: true,
  },
  {
    name: "vitest",
    out: "vitest/build/schema.json",
    title: "GodotJS engine vitest",
    summary:
      "构建引擎测试产物，随后在同进程内运行 vitest，用例在真实 Godot 中执行。" +
      "对外仅提供一个 ng run <app>:engine-test，reporter / 过滤 / 退出码均与原生 vitest 一致。",
    schema: vitestOptionsSchema,
    definitions: { assetPattern: assetPatternSchema, budget: budgetSchema, engine: engineOptionsSchema },
    upstream: false,
    source: "packages/builder/vite/options-schema.ts",
  },
];

function render(target: Target, upstream: { properties: Record<string, unknown>; version: string }): string {
  if (target.upstream) assertUpstream(upstream.properties, upstream.version);
  const json = convert(target.schema, target.definitions);
  const properties = (json.properties ?? {}) as Record<string, unknown>;
  const required = (json.required ?? []) as string[];
  // required 派生自“未包裹 v.optional”，写错名称会让 CLI 要求一个不存在的选项
  const dangling = required.filter((k) => !(k in properties));
  if (dangling.length)
    throw new Error(`${target.name}: required 中包含未声明的字段 ${dangling.join(", ")}`);

  const source = target.upstream
    ? `${UPSTREAM_PACKAGE}@${upstream.version}`
    : (target.source ?? "packages/builder/vite/options-schema.ts");
  return `${JSON.stringify(
    {
      $schema: "http://json-schema.org/draft-07/schema",
      title: target.title,
      description: `${target.summary}本文件由 tools/gen-schema.ts 从 ${source} 生成，请勿手工修改。`,
      ...json,
      ...(target.upstream ? { "x-generated-from": source } : {}),
    },
    null,
    2,
  )}\n`;
}

const check = process.argv.includes("--check");
const upstream = readUpstream();
for (const target of TARGETS) {
  const text = render(target, upstream);
  const target_path = join(outDir, target.out);
  if (check) {
    // “不存在”与“内容不同步”必须分开报告：dist 是库与 builder 共用的，
    // ng-packagr 的 deleteDestPath 会将整个 dist 清除，只运行过 build:lib 时此处根本没有
    // 文件。统一描述为“不同步”会误导为“形状改了未提交”，而真实原因只是未运行 build:builder。
    if (!existsSync(target_path)) {
      console.error(
        `${target.out} 不存在（dist/builder 不完整）。请先执行 pnpm build:builder 再校验。`,
      );
      process.exit(1);
    }
    const current = readFileSync(target_path, "utf8");
    if (current !== text) {
      console.error(`${target.out} 与形状源不同步，请执行 pnpm gen:schema 并一并提交`);
      process.exit(1);
    }
    console.log(`${target.out} 与形状源一致（${Object.keys(JSON.parse(text).properties).length} 个选项）`);
    continue;
  }
  mkdirSync(dirname(target_path), { recursive: true });
  writeFileSync(target_path, text);
  console.log(
    `${target.out} 已生成（${Object.keys(JSON.parse(text).properties).length} 个选项，` +
      `对账 ${target.upstream ? `@angular/build@${upstream.version}` : "本包独有"}）`,
  );
}
