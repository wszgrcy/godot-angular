import { describe, expect, it } from "vitest";
import { isAbsoluteish, toPosix } from "../../shared/path";

describe("toPosix", () => {
  it("反斜杠翻成正斜杠", () => {
    expect(toPosix("chunks\\app.js")).toBe("chunks/app.js");
    expect(toPosix("C:\\a\\b.ts")).toBe("C:/a/b.ts");
  });
  it("并掉重斜杠，但保留尾斜杠（留不留由调用方定）", () => {
    expect(toPosix("a//b")).toBe("a/b");
    expect(toPosix("a/b/")).toBe("a/b/");
  });
  it("正斜杠输入是恒等变换", () => {
    expect(toPosix("chunks/app.js")).toBe("chunks/app.js");
  });
});

describe("isAbsoluteish", () => {
  it("认盘符与 UNC，不看当前平台", () => {
    // 关键：这些在 Linux 上跑，path.isAbsolute 会全说"相对"
    expect(isAbsoluteish("C:/a/b")).toBe(true);
    expect(isAbsoluteish("C:\\a\\b")).toBe(true);
    expect(isAbsoluteish("\\\\server\\share\\x")).toBe(true);
    expect(isAbsoluteish("/a/b")).toBe(true);
  });
  it("相对路径判相对", () => {
    expect(isAbsoluteish("./a")).toBe(false);
    expect(isAbsoluteish("../a")).toBe(false);
    expect(isAbsoluteish("a/b")).toBe(false);
    expect(isAbsoluteish("bin/x/godot")).toBe(false);
  });
});
