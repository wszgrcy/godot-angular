import { describe, expect, it } from "vitest";
import { DEFAULT_ENGINE_PORT, PORT_RETRIES, startPort } from "../../shared/engine-port";

describe("startPort", () => {
  it("未配置、0、负数都取默认起始端口", () => {
    expect(startPort(undefined)).toBe(DEFAULT_ENGINE_PORT);
    expect(startPort(0)).toBe(DEFAULT_ENGINE_PORT);
    expect(startPort(-1)).toBe(DEFAULT_ENGINE_PORT);
  });
  it("配置了就照用（它是起始值，不是“必须”）", () => {
    expect(startPort(18782)).toBe(18782);
    expect(startPort(30000)).toBe(30000);
  });
  it("自增上限是个正数，不会无限试下去", () => {
    expect(PORT_RETRIES).toBeGreaterThan(0);
  });
});
