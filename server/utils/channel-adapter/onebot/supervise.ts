/**
 * OneBot 连接守护循环：连上就待着，断开才退避重连。
 *
 * ⚠️ connectOnebot 在**连上时**就 resolve（返回 close 函数），不是断开时。
 * 所以这里必须等 onStatus 收到断开再进下一轮。若把 `connect(...)` 当成一次连接的
 * 完整生命周期直接 `await`，循环会每轮新建一条连接且不关旧的：日志看起来「一直连着」，
 * 实际每秒漏一条 socket，几百条之后协议端那边刷一屏 ECONNRESET。
 */

import type { OnebotConnectionConfig, OnebotHandlers, OnebotResolvedEvent } from "./client";
import { connectOnebot } from "./client";
import type { OnebotConnectionRecord } from "./configure";

export type OnebotConnectFn = (
  config: OnebotConnectionConfig,
  handlers: OnebotHandlers,
) => Promise<() => void>;

export type OnebotSuperviseOptions = {
  record: OnebotConnectionRecord;
  handleEvent: (event: OnebotResolvedEvent) => Promise<Record<string, unknown>>;
  log: (entry: Record<string, unknown>) => void;
  /** 把连接状态写回库 / 上报；error 只代表「掉线」不代表「配置错」。 */
  onStatusChange?: (status: "ready" | "error") => void;
  shouldStop?: () => boolean;
  /** 以下两个仅供测试注入。 */
  connect?: OnebotConnectFn;
  sleep?: (ms: number) => Promise<void>;
};

/** 指数退避：1s → 30s 封顶。 */
export function onebotBackoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function superviseOnebotConnection(options: OnebotSuperviseOptions): Promise<void> {
  const { record, handleEvent, log } = options;
  const connect = options.connect ?? connectOnebot;
  const sleep = options.sleep ?? defaultSleep;
  const shouldStop = options.shouldStop ?? (() => false);
  let attempt = 0;

  while (!shouldStop()) {
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };

        connect(record.config, {
          onMessage: async (event) => {
            const result = await handleEvent(event);
            log({ event: "onebot-message-handled", connectionId: record.id, ...result });
          },
          onStatus: (status, detail) => {
            if (status === "ready") {
              attempt = 0;
              options.onStatusChange?.("ready");
              log({ event: "onebot-connected", connectionId: record.id });
            } else if (status === "error" || status === "disconnected") {
              if (status === "error") options.onStatusChange?.("error");
              log({ event: "onebot-" + status, connectionId: record.id, detail: detail ?? "" });
              // onclose 会连发 disconnected + error，只认第一次。
              finish();
            }
          },
        }).then(
          () => {
            // 连上了：什么都不做，等上面的 onStatus 告诉我们断开。
          },
          (error: unknown) => {
            if (settled) return;
            settled = true;
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        );
      });
      // 断开后回到循环重连；attempt 已在 ready 时归零，所以间隔 1 秒起步。
      attempt = 0;
    } catch (error) {
      log({
        event: "onebot-connect-failed",
        connectionId: record.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (shouldStop()) break;
    const wait = onebotBackoffMs(attempt);
    attempt += 1;
    await sleep(wait);
  }
}
