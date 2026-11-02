import { describe, expect, it } from "vitest";
import { scriptClassEntryName } from "../script-class-path";

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
