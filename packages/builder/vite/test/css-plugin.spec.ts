import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Plugin } from "vite";
import {
  GLOBAL_CSS_VIRTUAL,
  cssGlobalStylesPlugin,
  cssSourceGuardPlugin,
} from "../css-plugin";
import { filterMatches, filterOf, handlerOf } from "./hook";

type Transform = (this: object, code: string, id: string) => Promise<null>;

/* ------------------------------------------------------------------ 测试夹具 */

/** vite 的 this.error 会抛出；此处同样抛出，测试使用 toThrow 断言 */
function makeCtx() {
  const warnings: string[] = [];
  const watched: string[] = [];
  const ctx = {
    error(message: string): never {
      throw new Error(message);
    },
    warn(message: string): void {
      warnings.push(String(message));
    },
    addWatchFile(file: string): void {
      watched.push(String(file));
    },
  };
  return { ctx, warnings, watched };
}

function callConfigResolved(plugin: Plugin, root: string): void {
  const hook = plugin.configResolved as unknown as ((this: object, config: unknown) => void) | undefined;
  hook?.call(makeCtx().ctx, { root, css: { preprocessorOptions: {} } });
}

function callTransform(
  plugin: Plugin,
  code: string,
  id: string,
): { code: string; map?: string | null } | null {
  const { ctx } = makeCtx();
  const out = handlerOf<(this: object, code: string, id: string) => unknown>(plugin.transform).call(
    ctx,
    code,
    id,
  );
  if (out instanceof Promise) throw new Error("这个 hook 不该是异步的");
  return out as { code: string; map?: string | null } | null;
}

async function callTransformAsync(plugin: Plugin, code: string, id: string): Promise<{ code: string } | null> {
  const { ctx } = makeCtx();
  return handlerOf<Transform>(plugin.transform).call(ctx, code, id) as Promise<{ code: string } | null>;
}

/* ------------------------------------------------------------------ 源码层守卫 */

describe("styleUrls 源码层守卫", () => {
  function workspace(): string {
    return mkdtempSync(join(tmpdir(), "cuj-css-"));
  }

  it("文件存在 → 不改写，但登记 watch", async () => {
    const root = workspace();
    writeFileSync(join(root, "exists.css"), ".a { color: red }");
    writeFileSync(join(root, "comp.ts"), '@Component({ styleUrls: ["./exists.css"] })\n');
    const plugin = cssSourceGuardPlugin();
    callConfigResolved(plugin, root);
    const { ctx, watched } = makeCtx();
    const hook = handlerOf<Transform>(plugin.transform);
    const out = await hook.call(ctx, readFileSync(join(root, "comp.ts"), "utf8"), join(root, "comp.ts"));
    expect(out).toBeNull();
    expect(watched).toContain(join(root, "exists.css"));
  });

  it("文件不存在 → 硬失败，文案带组件文件与解析后的路径", async () => {
    const root = workspace();
    writeFileSync(join(root, "comp.ts"), '@Component({ styleUrls: ["./nope.css"] })\n');
    const plugin = cssSourceGuardPlugin();
    callConfigResolved(plugin, root);
    const { ctx } = makeCtx();
    const hook = handlerOf<Transform>(plugin.transform);
    let message = "";
    try {
      await hook.call(ctx, readFileSync(join(root, "comp.ts"), "utf8"), join(root, "comp.ts"));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("./nope.css");
    expect(message).toContain(join(root, "nope.css"));
    expect(message).toContain("静默");
  });

  it("预处理器编不过 → 硬失败，不是打一行 [sass] Error 后 rc=0", async () => {
    const root = workspace();
    writeFileSync(join(root, "broken.scss"), ".broken {\n  color: red\n");
    const plugin = cssSourceGuardPlugin({
      preprocessCss: async () => {
        throw new Error("[sass] Error: expected end of rule.");
      },
    });
    callConfigResolved(plugin, root);
    const { ctx } = makeCtx();
    const hook = handlerOf<Transform>(plugin.transform);
    await expect(
      hook.call(ctx, '@Component({ styleUrls: ["./broken.scss"] })', join(root, "comp.ts")),
    ).rejects.toThrow(/预处理失败/);
  });

  it("styleUrl（单数）与模板串写法也认", async () => {
    const root = workspace();
    writeFileSync(join(root, "one.css"), ".a{}");
    const plugin = cssSourceGuardPlugin();
    callConfigResolved(plugin, root);
    const { ctx, watched } = makeCtx();
    const hook = handlerOf<Transform>(plugin.transform);
    await hook.call(ctx, "@Component({ styleUrl: `./one.css` })", join(root, "comp.ts"));
    expect(watched).toContain(join(root, "one.css"));
  });

  /**
   * lint 在源码层完成（而不是产物层）的理由全部在这几条用例中：源码中 CSS 是现成的
   * 字面量，不需要到生成 JS 中识别。检查本体是纯包的 `buildRuleSets`，与运行时同一份。
   */
  it("内联 styles 里元素选择器拼错 → 构建期就报（不用等启动）", async () => {
    const logged: string[] = [];
    const plugin = cssSourceGuardPlugin({ log: (m) => logged.push(m) });
    callConfigResolved(plugin, "/repo");
    await callTransformAsync(
      plugin,
      '@Component({ styles: ["Buton { color: red }"] })',
      "/repo/src/a.ts",
    );
    expect(logged.join("\n")).toContain("Buton");
    expect(logged.join("\n")).toContain("src/a.ts");
  });

  it("styleUrls 文件内容也 lint（内容本来就要读来跑预处理器）", async () => {
    const root = workspace();
    writeFileSync(join(root, "bad.css"), "Lable { color: red }");
    const logged: string[] = [];
    const plugin = cssSourceGuardPlugin({ log: (m) => logged.push(m) });
    callConfigResolved(plugin, root);
    const { ctx } = makeCtx();
    const hook = handlerOf<Transform>(plugin.transform);
    await hook.call(ctx, '@Component({ styleUrls: ["./bad.css"] })', join(root, "comp.ts"));
    expect(logged.join("\n")).toContain("Lable");
  });

  /**
   * lint 的输入是预处理后的 CSS。使用“原文干净、预处理后才出现问题”的输入验证：
   * 若 lint 读取的是原文，这条告警不会出现。
   */
  it("lint 的是预处理后的 CSS，不是文件原文", async () => {
    const root = workspace();
    writeFileSync(join(root, "nest.scss"), ".wrap { color: red }\n");
    const logged: string[] = [];
    const plugin = cssSourceGuardPlugin({
      log: (m) => logged.push(m),
      // 假预处理器：输出中埋入一个错误类名，只有“读取预处理结果”才看得见
      preprocessCss: async () => "Buton { color: red }",
    });
    callConfigResolved(plugin, root);
    const { ctx } = makeCtx();
    const hook = handlerOf<Transform>(plugin.transform);
    await hook.call(ctx, '@Component({ styleUrls: ["./nest.scss"] })', join(root, "comp.ts"));
    expect(logged.join("\n")).toContain("Buton");
  });

  it("干净的样式不产生任何 lint 输出", async () => {
    const logged: string[] = [];
    const plugin = cssSourceGuardPlugin({ log: (m) => logged.push(m) });
    callConfigResolved(plugin, "/repo");
    await callTransformAsync(
      plugin,
      '@Component({ styles: ["Label { color: red } .x > Button { opacity: 0.5}"] })',
      "/repo/src/a.ts",
    );
    expect(logged.filter((m) => m.includes("不是已知的 Godot 类名"))).toEqual([]);
  });

  it("同一次 transform 里撞了同一份样式 → 同一条只报一次", async () => {
    const logged: string[] = [];
    const plugin = cssSourceGuardPlugin({ log: (m) => logged.push(m) });
    callConfigResolved(plugin, "/repo");
    await callTransformAsync(
      plugin,
      '@Component({ styles: ["Buton { color: red }"] })\n@Component({ styles: ["Buton { color: red }"] })',
      "/repo/src/a.ts",
    );
    expect(logged.filter((m) => m.includes("Buton")).length).toBe(1);
  });

  it("不含 styleUrls 的模块直接返回 null（热路径）", async () => {
    const plugin = cssSourceGuardPlugin();
    expect(await callTransformAsync(plugin, "export class A {}", "/repo/src/a.ts")).toBeNull();
  });

  /**
   * filter 运行在 rolldown 中，测试环境没有那一层，因此按同一套语义自行执行一遍（见 hook.ts）。
   * 被 filter 排除的模块根本不会进入 handler，写错时的表现是“少检查”而不是“报错”。
   */
  describe("transform 的 filter", () => {
    const guard = cssSourceGuardPlugin();
    const filter = filterOf(guard.transform);
    const css = '@Component({ styleUrls: ["./a.css"] })';

    it("组件源码命中，带查询串也命中", () => {
      for (const id of ["/repo/src/a.ts", "/repo/src/a.tsx", "/repo/src/a.mts", "/repo/src/a.ts?v=1"]) {
        expect(filterMatches(filter, { id, code: css })).toBe(true);
      }
    });

    it("非组件模块与 node_modules 不进 JS", () => {
      for (const id of ["/repo/src/a.css", "/repo/src/a.html", "/repo/node_modules/x/index.js"]) {
        expect(filterMatches(filter, { id, code: css })).toBe(false);
      }
    });

    it("代码里没有 styles / styleUrls 时不进 JS", () => {
      expect(filterMatches(filter, { id: "/repo/src/a.ts", code: "export class A {}" })).toBe(false);
      // 单数 styleUrl 与内联 styles 各自都需要能够触发匹配
      expect(filterMatches(filter, { id: "/repo/src/a.ts", code: "styleUrl: 'x.css'" })).toBe(true);
      expect(filterMatches(filter, { id: "/repo/src/a.ts", code: "styles: []" })).toBe(true);
    });
  });
});

/* ------------------------------------------------------------------ 全局样式 */

describe("全局样式表（angular.json 的 styles）", () => {
  function hooks(plugin: Plugin) {
    const { ctx } = makeCtx();
    return {
      ctx,
      resolveId: (id: string) =>
        handlerOf<(this: object, id: string) => string>(plugin.resolveId).call(ctx, id),
      buildStart: () =>
        handlerOf<(this: object) => Promise<void>>(plugin.buildStart).call(ctx),
      load: (id: string) =>
        handlerOf<(this: object, id: string) => string>(plugin.load).call(ctx, id),
    };
  }

  /** handler 不判断 id，“只有虚拟说明符能解析”完全依赖 filter */
  it("resolveId / load 只在虚拟 id 精确命中时跑", () => {
    const plugin = cssGlobalStylesPlugin({});
    expect(filterMatches(filterOf(plugin.resolveId), { id: GLOBAL_CSS_VIRTUAL })).toBe(true);
    expect(filterMatches(filterOf(plugin.resolveId), { id: "virtual:other" })).toBe(false);
    expect(filterMatches(filterOf(plugin.load), { id: `\0${GLOBAL_CSS_VIRTUAL}` })).toBe(true);
    expect(filterMatches(filterOf(plugin.load), { id: GLOBAL_CSS_VIRTUAL })).toBe(false);
  });

  it("内容编进虚拟模块，运行时从 globalThis 上取", async () => {
    const root = mkdtempSync(join(tmpdir(), "cuj-global-"));
    writeFileSync(join(root, "global.css"), "Button { color: rgb(1, 2, 3) }");
    const plugin = cssGlobalStylesPlugin({ globalStyles: [join(root, "global.css")], workspaceRoot: root });
    callConfigResolved(plugin, root);
    const api = hooks(plugin);

    const resolved = api.resolveId(GLOBAL_CSS_VIRTUAL);
    expect(resolved).toBe(`\0${GLOBAL_CSS_VIRTUAL}`);

    await api.buildStart();
    const code = api.load(resolved);
    expect(code).toContain("globalThis.__CUJ_GLOBAL_CSS__");
    expect(code).toContain("Button { color: rgb(1, 2, 3) }");
  });

  it("scss 走预处理器后再编进产物", async () => {
    const root = mkdtempSync(join(tmpdir(), "cuj-global-"));
    writeFileSync(join(root, "global.scss"), "Button { color: red; &.big { opacity: 0.5 } }");
    const plugin = cssGlobalStylesPlugin({
      globalStyles: ["global.scss"],
      workspaceRoot: root,
      preprocessCss: async () => "Button { color: red }\nButton.big { opacity: 0.5 }",
    });
    callConfigResolved(plugin, root);
    const api = hooks(plugin);
    await api.buildStart();
    expect(api.load(api.resolveId(GLOBAL_CSS_VIRTUAL))).toContain("Button.big");
  });

  it("配了不存在的文件 → 构建失败", async () => {
    const root = mkdtempSync(join(tmpdir(), "cuj-global-"));
    const plugin = cssGlobalStylesPlugin({ globalStyles: ["missing.css"], workspaceRoot: root });
    callConfigResolved(plugin, root);
    await expect(hooks(plugin).buildStart()).rejects.toThrow(/全局样式表不存在/);
  });

  it("没配 styles 时虚拟模块是空数组（交接位存在但为空）", async () => {
    const plugin = cssGlobalStylesPlugin({ workspaceRoot: process.cwd() });
    callConfigResolved(plugin, process.cwd());
    const api = hooks(plugin);
    await api.buildStart();
    expect(api.load(api.resolveId(GLOBAL_CSS_VIRTUAL))).toContain("= [];\n");
  });
});
