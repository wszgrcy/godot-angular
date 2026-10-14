/** 构建器补丁模块（`builder/vite/polyfills.ts`）挂到 globalThis 上的句柄键。 */
const CUJ_FRAME_KEY = "__CUJ_FRAME__";

export interface GodotFrameClock {
  /** 每帧调用一次，驱动 rAF 队列。 */
  run(deltaMs: number): void;
  /** 应用销毁：停止帧驱动并丢弃队列。 */
  stop(): void;
  /** 新应用启动：恢复帧驱动。 */
  resume(): void;
}

/**
 * 取得帧钟。补丁未安装时调用，说明入口加载顺序有误——此处立即显式报错，
 * 比界面静默不刷新更易于定位。
 */
export function frameClock(): GodotFrameClock {
  const clock = (globalThis as Record<string, unknown>)[CUJ_FRAME_KEY] as GodotFrameClock | undefined;
  if (!clock) {
    throw new Error(
      "[godot-angular] 帧钟未安装：构建器的补丁模块未先于本入口求值。" +
        "builder 会自动前置它；手写入口（或手工拼装 bundle）时，第一条 import 必须是它。",
    );
  }
  return clock;
}
