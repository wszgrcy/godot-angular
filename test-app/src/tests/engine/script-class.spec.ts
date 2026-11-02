/// <reference types="vitest" />
// 脚本类（`export default class extends 引擎类`）在真引擎里的实例化与生命周期驱动。
//
// 两个关键前提（GodotJS 源码 + 实测）：只有被引擎当 Script 资源加载过的模块，它的默认
// 导出才会被登记成脚本类；登记了但产物不在 res://.godot/GodotJS 下时，`new` 会让引擎直接
// 崩溃（不是可捕获异常）。产物由构建器在测试前构建出来，该目录被 .gitignore 忽略。
import { beforeEach, describe, expect, it } from "vitest";
import { Node, ResourceLoader } from "godot";
import { initGodotTestEnvironment, awaitFrames, getEngineSceneRoot } from "godot-angular/testing";

// 产物层的 require：GodotJS 的 CJS 模块自带。声明在本地，不用全局类型污染其他测试。
declare const require: (path: string) => unknown;

/**
 * 引擎硬编码的产物目录 res://.godot/GodotJS。这个文件由构建器的 scriptClassEntries 产出
 * （入口名 = 源码相对路径，保证引擎反推 .ts 源码对得上），不在 outputPath 下。
 */
const CONVENTION_JS = "res://.godot/GodotJS/src/fixtures/script-class-probe.js";

/** fixture 里那个类的形状 */
interface ScriptClassProbe extends Node {
  readyCalls: number;
  processCalls: number;
  twice(x: number): number;
}

interface ProbeClass {
  new (): ScriptClassProbe;
}

/** 按条件轮询等帧：无头下一帧可能远快于 1/60 秒，等固定帧数不一定够。 */
async function waitUntil(predicate: () => boolean, maxFrames = 120): Promise<boolean> {
  for (let i = 0; i < maxFrames; i++) {
    if (predicate()) return true;
    await awaitFrames(1);
  }
  return predicate();
}

describe("脚本类（引擎约定目录下的产物）", () => {
  let root: Node;

  beforeEach(() => {
    initGodotTestEnvironment();
    root = new Node();
    root.name = "ScriptClassRoot";
    getEngineSceneRoot()!.add_child(root);
  });

  it("构建器已把脚本类产物写到引擎约定目录", () => {
    expect(ResourceLoader.exists(CONVENTION_JS)).toBe(true);
  });

  it("require 进来的模块默认导出就是类，直接 new 能建出实例", () => {
    const mod = require(CONVENTION_JS) as { default?: ProbeClass };
    const Probe = mod.default;
    expect(typeof Probe).toBe("function");
    const inst = new Probe!();
    expect(inst.get_class()).toBe("Node");
    expect(inst.twice(21)).toBe(42);
    inst.free();
  });

  it("这样建出的实例是引擎认的真脚本实例，_ready 与 _process 由引擎驱动", async () => {
    const Probe = (require(CONVENTION_JS) as { default: ProbeClass }).default;
    const inst = new Probe();
    root.add_child(inst);
    expect(await waitUntil(() => inst.processCalls >= 3, 240)).toBe(true);
    expect(inst.readyCalls).toBeGreaterThan(0);
    inst.free();
  });

  it("多个位置的脚本类都能 new（input 只决定去哪找文件，不决定产物叫什么）", () => {
    // 两个 fixture 分属 src/fixtures 与 src/more 两个 input，产物名仍按相对工程根算
    const two = require("res://.godot/GodotJS/src/more/script-class-probe-two.js") as {
      default?: new () => { plusOne(x: number): number; free(): void };
    };
    expect(typeof two.default).toBe("function");
    const inst = new two.default!();
    expect(inst.plusOne(41)).toBe(42);
    inst.free();
  });

  it("被打包器内联进 bundle 的子类没被登记，new 它会抛错", () => {
    // 这个类从没被引擎当 Script 资源加载过，所以不是脚本类。
    // 注意：只有“没登记”才是可捕获异常；已登记但产物不在 res://.godot/GodotJS 下时，
    // new 会让引擎崩溃，那种情况不能写成测试。
    class InlinedProbe extends Node {}
    let message = "";
    try {
      new InlinedProbe();
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain("new.target");
    expect(message).toContain("not exported as default");
  });
});
