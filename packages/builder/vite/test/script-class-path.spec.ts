import { describe, expect, it } from "vitest";
import { assertEngineOutDir, scriptClassEntryName } from "../script-class-path";

describe("assertEngineOutDir", () => {
  it("引擎约定目录本身与它的子目录都通过", () => {
    expect(assertEngineOutDir(".godot/GodotJS")).toBe(".godot/GodotJS");
    expect(assertEngineOutDir(".godot/GodotJS/pages")).toBe(".godot/GodotJS/pages");
  });

  it("归一化分隔符与尾部斜杠", () => {
    expect(assertEngineOutDir(".godot\\GodotJS\\")).toBe(".godot/GodotJS");
  });

  it("写到约定目录外直接报错，不给人静默崩在运行时的机会", () => {
    // dist 是以前用的目录：产物在那里时，带导出属性的脚本类会让引擎 SIGILL
    expect(() => assertEngineOutDir("dist")).toThrow(/\.godot\/GodotJS/);
    // begins_with 是纯前缀比较，引擎会把 GodotJSx 也当成命中，构建器不能跟着错
    expect(() => assertEngineOutDir(".godot/GodotJSx")).toThrow(/\.godot\/GodotJS/);
    expect(() => assertEngineOutDir("../outside")).toThrow(/\.godot\/GodotJS/);
  });
});

describe("scriptClassEntryName", () => {
  it("去掉扩展名并统一成 /", () => {
    expect(scriptClassEntryName("src/view/probe-body.ts")).toBe("src/view/probe-body");
    expect(scriptClassEntryName("src\\view\\probe-body.cts")).toBe("src/view/probe-body");
    expect(scriptClassEntryName("main.mts")).toBe("main");
  });

  it("非脚本扩展名不去尾巴，避免拼出错误产物名", () => {
    expect(scriptClassEntryName("src/data.json")).toBe("src/data.json");
  });
});
