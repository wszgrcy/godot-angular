import { createServer, type AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { GodotVitestSession } from "../node/session";

/** 占住一个随机端口。`free()` 之前它一直不可用。 */
async function occupy(): Promise<{ port: number; free(): Promise<void> }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { port, free: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe("GodotVitestSession 端口", () => {
  it("起始端口空着就直接用", async () => {
    const taken = await occupy();
    await taken.free();
    const session = new GodotVitestSession({ port: taken.port });
    await session.start();
    expect(session.port).toBe(taken.port);
    await session.release();
  });

  it("起始端口被占则 +1 继续绑", async () => {
    const taken = await occupy();
    const session = new GodotVitestSession({ port: taken.port });
    await session.start();
    expect(session.port).toBeGreaterThan(taken.port);
    await session.release();
    await taken.free();
  });

  it("portTries 为 0 时不让端口漂移（noLaunch：引擎只认产物里写死的那个）", async () => {
    const taken = await occupy();
    const session = new GodotVitestSession({ port: taken.port, portTries: 0 });
    await expect(session.start()).rejects.toThrow(/EADDRINUSE/);
    await taken.free();
  });

  it("失败的监听不留在原地，同一个会话可以再试", async () => {
    const taken = await occupy();
    const session = new GodotVitestSession({ port: taken.port, portTries: 0 });
    await expect(session.start()).rejects.toThrow(/EADDRINUSE/);
    await taken.free();
    await session.start();
    expect(session.port).toBe(taken.port);
    await session.release();
  });

  it("关闭后重新监听沿用首次绑定到的端口", async () => {
    // 引擎已经拿到那个端口（CUJ_WS_PORT），重听换一个就等于把引擎丢在原地
    const taken = await occupy();
    const session = new GodotVitestSession({ port: taken.port });
    await session.start();
    const port = session.port;
    await session.release();
    await session.start();
    expect(session.port).toBe(port);
    await session.release();
    await taken.free();
  });
});
