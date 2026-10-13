import { describe, expect, it } from "vitest";
import { resolveVars, sameVars, usesVars } from "godot-angular/css";

const scope = (vars: Record<string, string>) => (name: string) => vars[name];

describe("resolveVars", () => {
  it("没有 var() 时原样返回", () => {
    expect(resolveVars("12px", scope({}))).toBe("12px");
    expect(resolveVars("rgb(1, 2, 3)", scope({}))).toBe("rgb(1, 2, 3)");
  });

  it("单个变量与一行里多个变量", () => {
    expect(resolveVars("var(--c)", scope({ "--c": "red" }))).toBe("red");
    expect(resolveVars("0 var(--h) 0 var(--v)", scope({ "--h": "4px", "--v": "8px" }))).toBe("0 4px 0 8px");
  });

  it("fallback：变量缺失时用兜底，存在时不用", () => {
    expect(resolveVars("var(--c, blue)", scope({}))).toBe("blue");
    expect(resolveVars("var(--c, blue)", scope({ "--c": "red" }))).toBe("red");
    // fallback 中可以包含逗号（函数值），分界只认第一个顶层逗号
    expect(resolveVars("var(--c, rgb(1, 2, 3))", scope({}))).toBe("rgb(1, 2, 3)");
  });

  it("fallback 里再套 var()", () => {
    expect(resolveVars("var(--a, var(--b, green))", scope({ "--b": "blue" }))).toBe("blue");
    expect(resolveVars("var(--a, var(--b, green))", scope({}))).toBe("green");
    // 变量值自身引用其他变量
    expect(resolveVars("var(--a)", scope({ "--a": "var(--b)" , "--b": "cyan" }))).toBe("cyan");
  });

  it("取不到且没 fallback → null（调用方据此忽略这条声明）", () => {
    expect(resolveVars("var(--nope)", scope({}))).toBeNull();
  });

  it("写坏了不抛异常：括号不配对 / 名字不是 --x / 循环引用", () => {
    expect(resolveVars("var(--a", scope({ "--a": "red" }))).toBeNull();
    expect(resolveVars("var(a)", scope({ a: "red" }))).toBeNull();
    const loop = { "--a": "var(--b)", "--b": "var(--a)" };
    expect(resolveVars("var(--a)", scope(loop))).toBeNull();
  });

  it("usesVars 是个便宜的闸门", () => {
    expect(usesVars("1px solid var(--c)")).toBe(true);
    expect(usesVars("12px")).toBe(false);
  });
});

describe("sameVars", () => {
  const map = (entries: Array<[string, string]>) => new Map(entries);
  it("键值相同即相等，与插入顺序无关", () => {
    expect(sameVars(map([["--a", "1"], ["--b", "2"]]), map([["--b", "2"], ["--a", "1"]]))).toBe(true);
  });
  it("少一个键、值不同都算变了", () => {
    expect(sameVars(map([["--a", "1"]]), map([]))).toBe(false);
    expect(sameVars(map([["--a", "1"]]), map([["--a", "2"]]))).toBe(false);
  });
});
