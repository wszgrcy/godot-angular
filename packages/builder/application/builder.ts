import { createBuilder, type Builder } from "@angular-devkit/architect";
import type { JsonObject } from "@angular-devkit/core";
import { parseOptions } from "../shared/parse-options";
import {
  runGodotViteBuild,
  runGodotViteWatch,
} from "../vite/build-core";
import { applicationOptionsSchema, type RawApplicationOptions } from "../vite/options-schema";

const builder: Builder<RawApplicationOptions & JsonObject> = createBuilder<RawApplicationOptions>(
  async function* (raw, context) {
    // parse 补充默认值：默认值的唯一来源是 schema 中的 v.optional(形状, 默认值)，
    // 因此下游无需再写 `?? 默认值`。必须在附加内部字段之前完成——v.object 会丢弃未声明的键，
    // 而 extraPlugins 由 runGodotViteWatch 自身注入，入口处本来就没有。
    const options = parseOptions(applicationOptionsSchema, raw, "application");

    // 写为 async generator：两条分支都只能输出同一种 BuilderOutput，
    // 三元中混用 AsyncGenerator 与 Promise 会被 BuilderOutputLike 拒绝。
    if (options.watch) {
      yield* runGodotViteWatch(options, context);
      return;
    }
    yield await runGodotViteBuild(options, context);
  },
);

export default builder;
