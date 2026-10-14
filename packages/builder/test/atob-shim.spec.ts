import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * GodotJS 的裸 V8 没有 `atob`，而 `whatwg-url-minimum` 在模块求值期就要它来解内嵌的 IDNA
 * 表。这里不测「能不能跑」，而是拿 Node 原生 `atob`（规范实现）当参考做**差分**：
 * 结果或抛错行为有任何一条不一致就算失败。
 *
 * 实现取 `base-64`，但这套差分守的是「装到 globalThis 上的那个函数行为合规」，与底下用谁
 * 无关。手写的第一版就是在合法输入上全对、却在「中段 padding」「长度模 4 余 1」「`\f` 没当
 * 空白」这些畸形路径上静默给出错误结果 —— 只测正常路径永远发现不了。
 *
 * ⚠ 装 shim 前必须先把原生摘掉：shim 只在 `globalThis.atob` 缺失时才安装，Node 自带原生，
 * 不摘就是拿原生和原生比 —— 永远全绿，什么都测不到。下面 `shim !== native` 那条就是防这个。
 */
const native = globalThis.atob;
let shim: (input: string) => string;

beforeAll(async () => {
  delete (globalThis as { atob?: unknown }).atob;
  await import("../vite/atob-shim");
  shim = globalThis.atob as (input: string) => string;
});

afterAll(() => {
  (globalThis as { atob?: unknown }).atob = native;
});

describe("atob shim（与 Node 原生 atob 差分）", () => {
  it("装上的确实是自己写的实现，不是被原生顶掉", () => {
    expect(shim).toBeTypeOf("function");
    expect(shim).not.toBe(native);
  });

  it("合法 base64 逐条与原生一致（含全字节值与所有长度余数）", () => {
    let checked = 0;
    for (let n = 0; n < 400; n++) {
      const len = n % 41;
      const bytes = Buffer.from(
        Array.from({ length: len }, (_, i) => (i * 31 + n * 17) % 256),
      );
      const encoded = bytes.toString("base64");
      expect(shim(encoded), `len=${len}`).toBe(bytes.toString("binary"));
      checked++;
    }
    expect(checked).toBe(400);
  });

  it("畸形输入的抛错行为与原生一致", () => {
    const malformed = [
      "aGVsbG8=Zm8", // padding 出现在中段
      "=aGVsbG8", // padding 在开头
      "aGVsbG8=x", // padding 之后还有字符
      "a",
      "abcde", // 长度模 4 余 1
      "!!!!",
      "aGVs-bG8=", // 字母表外字符
      "aGVsbG8=\u00a0", // 非 ASCII 空白不算空白
      "====",
      "A=A=",
      "AAAA====",
    ];
    for (const input of malformed) {
      const nativeThrew = (() => {
        try {
          native(input);
          return false;
        } catch {
          return true;
        }
      })();
      const shimThrew = (() => {
        try {
          shim(input);
          return false;
        } catch {
          return true;
        }
      })();
      expect(shimThrew, `输入 ${JSON.stringify(input)} 的接受/拒绝应与原生一致`).toBe(
        nativeThrew,
      );
    }
  });

  it("剥空白覆盖 TAB / LF / FF / CR / 空格", () => {
    // `\f` 是最容易漏的一个：规范把它算作要剥掉的 ASCII 空白
    expect(shim("aGVs bG8=")).toBe("hello");
    expect(shim("aGVs\nbG8=")).toBe("hello");
    expect(shim("aGVs\fbG8=")).toBe("hello");
    expect(shim("aGVs\rbG8=")).toBe("hello");
    expect(shim("aGVs\tbG8=")).toBe("hello");
    // 垂直制表符不在 ASCII 空白集合里，应当判失败
    expect(() => shim("aGVs\vbG8=")).toThrow();
  });

  it("隐式 padding 与空串与原生一致", () => {
    for (const input of ["", "aGk", "aGk=", "aGVsbG8", "aGVsbG8=", "/+j/", "QQ=="]) {
      expect(shim(input), `输入 ${JSON.stringify(input)}`).toBe(native(input));
    }
    expect(shim("/+j/").charCodeAt(0)).toBe(0xff);
  });
});
