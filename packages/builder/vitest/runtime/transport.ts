import { WebSocketPeer } from "godot";

/**
 * Godot 4 WebSocketPeer.State（文档值）：CONNECTING 0 / OPEN 1 / CLOSING 2 / CLOSED 3。
 * 注意 OPEN 是 1 而不是 3，CLOSED 是 3 而不是 2——将 2 当作 CLOSED 会把“正在关闭”误判为断开。
 */
const STATE_OPEN = 1;
const STATE_CLOSING = 2;
const STATE_CLOSED = 3;

/**
 * 出站缓冲大小。默认 65535 字节不够（见 connectChannel 内的注释），
 * 此处给到 8MB：单帧最大观测值约 61KB，这里保留了两个数量级的余量。
 */
const OUTBOUND_BUFFER_BYTES = 8 * 1024 * 1024;

export interface EngineChannel {
  readonly connected: boolean;
  readonly closed: boolean;
  /** 未就绪时先入队，连上后随 poll 冲刷 */
  send(payload: unknown): void;
  /** 每帧调用 */
  poll(): void;
  readonly pending: number;
  close(): void;
}

export function connectChannel(
  port: number,
  options: { host?: string; onMessage?: (msg: Record<string, unknown>) => void } = {},
): EngineChannel {
  if (typeof WebSocketPeer !== "function") {
    throw new Error("GodotJS 未暴露 WebSocketPeer（Godot 4 的类名，Godot 3 中为 WebSocketClient）");
  }

  const ws = new WebSocketPeer();
  // 出站缓冲默认 65535 字节，而 vitest 一个 onCollected 帧就能达到 61KB，堆积在一起就会溢出
  // （ERR_OUT_OF_MEMORY，宿主持续等待直到超时）。必须在 connect_to_url 之前修改。
  ws.outbound_buffer_size = OUTBOUND_BUFFER_BYTES;
  const queue: string[] = [];
  let isConnected = false;
  let isClosed = false;

  /**
   * 发送一条，失败则**原样放回队头**。
   * send_text 有返回码，丢弃就会变成“静默丢消息”（测试莫名减少若干条 / 卡到超时）。
   * 失败则回到队列，下个 poll() 重试。
   */
  const flushOne = (text: string): boolean => {
    if (ws.send_text(text) !== 0) {
      queue.unshift(text);
      return false;
    }
    return true;
  };

  /** 按原序冲刷；遇到第一条发送失败即停止，保证不乱序 */
  const drainQueue = (): void => {
    while (queue.length) {
      const head = queue.shift() as string;
      if (!flushOne(head)) return;
    }
  };

  const api: EngineChannel = {
    get connected() {
      return isConnected;
    },
    get closed() {
      return isClosed;
    },
    get pending() {
      return queue.length;
    },
    send(payload: unknown) {
      const text = JSON.stringify(payload);
      if (isConnected) flushOne(text);
      else queue.push(text);
    },
    poll() {
      ws.poll();
      const state = ws.get_ready_state();

      if (state === STATE_OPEN) {
        if (!isConnected) {
          isConnected = true;
        }
        drainQueue();
        const count = ws.get_available_packet_count();
        for (let i = 0; i < count; i++) {
          const packet = ws.get_packet();
          if (!options.onMessage) continue;
          try {
            options.onMessage(JSON.parse(packet.get_string_from_utf8()));
          } catch {
            /* 忽略非 JSON 帧 */
          }
        }
      } else if (state === STATE_CLOSING) {
        // 文档要求：关闭中需要继续 poll 才能完成握手式关闭，此处不能提前断开
        isConnected = false;
      } else if (state === STATE_CLOSED) {
        isClosed = true;
        isConnected = false;
      }
    },
    close() {
      try {
        ws.close();
      } catch {
        /* 已断开时 close 可能抛异常，忽略 */
      }
    },
  };

  const host = options.host ?? "127.0.0.1";
  const err = ws.connect_to_url(`ws://${host}:${port}`);
  if (err !== 0) {
    throw new Error(
      `connect_to_url 失败，Error=${err}（请确认宿主侧服务已启动，且两侧端口配置一致）`,
    );
  }
  return api;
}
