/**
 * OneBot v11 forward-WebSocket client. yiling-hub connects to a third-party QQ gateway
 * (e.g. SnowLuma) as a WS *client* and receives message events, then calls the gateway's
 * HTTP API to send replies.
 *
 * - Reconnect with exponential backoff (1s → 30s cap).
 * - Liveness probe every 30s (calls get_status); a failed probe triggers a reconnect.
 * - Only `post_type === "message"` events with `message_type` private/group are surfaced.
 */

import {
  onebotConversationKey,
  readOnebotDisplayName,
  readOnebotGroupRole,
  readOnebotImages,
  readOnebotMessageId,
  readOnebotMessageText,
  readOnebotUserId,
  readOnebotVoices,
  type OnebotGroupRole,
  type OnebotImageRef,
  type OnebotMessageType,
  type OnebotSegment,
  type OnebotVoiceRef,
} from "./types";

/** 出站消息：纯文本，或段数组（表情、图片、@）。 */
export type OnebotOutgoingMessage = string | OnebotSegment[];

export type OnebotConnectionConfig = {
  wsUrl: string;
  httpUrl: string;
  /** WS 鉴权 token，连接时拼成 `?access_token=`；SnowLuma 的 WS token 与 HTTP token 是两个不同的值。 */
  accessToken?: string;
  /** HTTP API auth token. */
  httpToken?: string;
};

export type OnebotResolvedEvent = {
  messageType: OnebotMessageType;
  data: unknown;
  messageId: string;
  userId: string;
  groupId: string;
  conversationKey: string;
  displayName: string;
  content: string;
  /** 这一条消息里带的图。正文里只有 `[图片]`，直链在这里等「看图」旁路来取。 */
  images: OnebotImageRef[];
  /** 这一条消息里带的语音。正文里只有 `[语音]`，直链在这里等「听懂语音」旁路来取。 */
  voices: OnebotVoiceRef[];
  selfId: string;
  /** 群成员身份；私聊或网关未提供时为 member。 */
  senderRole: OnebotGroupRole;
};

export type OnebotHandlers = {
  onMessage: (event: OnebotResolvedEvent) => void | Promise<unknown>;
  onStatus?: (status: "connecting" | "ready" | "disconnected" | "error", detail?: string) => void;
};

function isMessageEvent(data: unknown): boolean {
  const record = data as { post_type?: unknown; message_type?: unknown } | null;
  if (record?.post_type !== "message") return false;
  const mt = record.message_type;
  return mt === "private" || mt === "group";
}

function safeJson(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Parses a raw WS text frame into a resolved event, or null if it's not a handleable message. */
export function resolveOnebotEvent(data: unknown): OnebotResolvedEvent | null {
  const record = data as { message_type?: unknown; self_id?: unknown } | null;
  const messageType = record?.message_type;
  if (messageType !== "private" && messageType !== "group") return null;

  const content = readOnebotMessageText(data);
  const messageId = readOnebotMessageId(data);
  const userId = readOnebotUserId(data);
  const conversationKey = onebotConversationKey(messageType, data);
  if (!messageId || !conversationKey) return null;

  return {
    messageType,
    data,
    messageId,
    userId,
    groupId: messageType === "group" ? String((data as { group_id?: unknown } | null)?.group_id ?? "") : "",
    conversationKey,
    displayName: readOnebotDisplayName(data),
    content,
    images: readOnebotImages(data),
    voices: readOnebotVoices(data),
    selfId: String(record?.self_id ?? ""),
    senderRole: readOnebotGroupRole(data),
  };
}

/**
 * 把 WS token 拼进 URL 查询串。
 *
 * OneBot v11 两种带法（`Authorization: Bearer` 头与 `?access_token=` 查询参数）SnowLuma 都认，
 * 但 Node 内置的 WebSocket 不支持自定义握手头，所以只能走查询参数。
 * 地址里已经自带 access_token（用户手填或网关给的）就不重复拼。
 * ⚠️ 返回值里含明文 token，只能用来建连接，不许写日志、不许落库。
 */
function withWsAccessToken(url: string, token: string | undefined): string {
  if (!token) return url;
  if (/[?&]access_token=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
}

/**
 * Connects to the OneBot gateway and dispatches message events. Resolves with a `close`
 * function once the socket is open; the returned promise rejects on the first connection
 * failure so the supervisor can back off and retry. Abort also cancels a pending handshake;
 * the returned close function waits for onclose before a replacement socket is started.
 */
export function connectOnebot(
  config: OnebotConnectionConfig,
  handlers: OnebotHandlers,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("ONEBOT_STOPPED"));
      return;
    }
    const socket = new WebSocket(withWsAccessToken(config.wsUrl, config.accessToken));
    let probeTimer: ReturnType<typeof setInterval> | null = null;
    let settled = false;
    let closedByCaller = false;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((done) => { resolveClosed = done; });
    let probeAbort: AbortController | undefined;

    const clearProbe = () => {
      probeAbort?.abort();
      if (probeTimer) {
        clearInterval(probeTimer);
        probeTimer = null;
      }
    };

    const startProbe = () => {
      clearProbe();
      probeTimer = setInterval(async () => {
        try {
          probeAbort?.abort();
          probeAbort = new AbortController();
          await fetch(config.httpUrl + "/get_status", {
            signal: probeAbort.signal,
            headers: config.httpToken ? { authorization: "Bearer " + config.httpToken } : {},
          });
        } catch {
          // Probe failed: the gateway may be down. Close so the caller can reconnect.
          try {
            socket.close();
          } catch {
            // already closing
          }
        }
      }, 30_000);
      probeTimer.unref?.();
    };

    const close = () => {
      closedByCaller = true;
      clearProbe();
      try {
        socket.close();
      } catch {
        // already closing
      }
      return closed;
    };
    const abort = () => { void close(); };
    signal?.addEventListener("abort", abort, { once: true });

    socket.onopen = () => {
      if (closedByCaller) { void close(); return; }
      handlers.onStatus?.("ready");
      startProbe();
      if (!settled) {
        settled = true;
        resolve(close);
      }
    };

    socket.onmessage = async (event) => {
      const text = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
      const payload = safeJson(text);
      if (!payload || typeof payload !== "object") return;
      if (!isMessageEvent(payload)) return;
      const resolved = resolveOnebotEvent(payload);
      if (!resolved) return;
      try {
        await handlers.onMessage(resolved);
      } catch (error) {
        handlers.onStatus?.("error", error instanceof Error ? error.message : String(error));
      }
    };

    /**
     * 一个 socket 的 error 可能连发几百次（网关不可达时实测 9 秒 835 次，还能把调用栈打爆）。
     * 只认第一次：close() 里置了 closedByCaller，后续事件直接丢掉，
     * 否则每一发都会写一次状态、刷一行日志，页面上看到的就是状态反复跳。
     *
     * ⚠️ 光丢弃还不够：握手失败时有些运行时不派发 close 事件，socket 卡在 CONNECTING，
     * 这个 Promise 就永远不 settle —— supervisor 会一直等它，再也不重试。
     * 所以这里主动 reject，让退避重连照常进行。
     */
    socket.onerror = () => {
      if (closedByCaller) return;
      handlers.onStatus?.("error", "ONEBOT_WS_ERROR");
      void close();
      if (!settled) {
        settled = true;
        reject(new Error("ONEBOT_WS_ERROR"));
      }
    };

    socket.onclose = (event) => {
      clearProbe();
      signal?.removeEventListener("abort", abort);
      resolveClosed();
      // 带上关闭码：1006 是网络/握手异常，1008 通常是鉴权或策略拒绝，两者排查方向完全不同。
      handlers.onStatus?.("disconnected", `code=${event.code}${event.reason ? ` reason=${event.reason}` : ""}`);
      if (!settled) {
        settled = true;
        reject(new Error("ONEBOT_WS_CLOSED: OneBot WebSocket 在就绪前关闭。"));
      }
      if (!closedByCaller) {
        // Unexpected drop: the caller's reconnect loop will re-invoke connectOnebot.
        handlers.onStatus?.("error", "ONEBOT_WS_CLOSED");
      }
    };
  });
}

/**
 * Sends a private message through the OneBot HTTP API. `message` is either plain text or a
 * segment array (face / image / at), which is what the v11 spec calls CQ messages.
 */
export async function sendOnebotPrivateMessage(
  config: OnebotConnectionConfig,
  userId: string,
  message: OnebotOutgoingMessage,
): Promise<void> {
  await sendOnebotApi(config, "send_private_msg", { user_id: Number(userId), message });
}

/**
 * 发布群公告。SnowLuma 的扩展动作，要求登录的小号在群里是管理员。
 * OneBot v11 标准没有公告接口；换网关时要确认动作名与参数。
 */
export async function sendOnebotGroupNotice(
  config: OnebotConnectionConfig,
  groupId: string,
  content: string,
): Promise<void> {
  await sendOnebotApi(config, "_send_group_notice", {
    group_id: Number(groupId),
    content,
  });
}

/** Sends a group message through the OneBot HTTP API. */
export async function sendOnebotGroupMessage(
  config: OnebotConnectionConfig,
  groupId: string,
  message: OnebotOutgoingMessage,
): Promise<void> {
  await sendOnebotApi(config, "send_group_msg", { group_id: Number(groupId), message });
}

async function sendOnebotApi(
  config: OnebotConnectionConfig,
  action: string,
  params: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(config.httpUrl + "/" + action, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.httpToken ? { authorization: "Bearer " + config.httpToken } : {}),
    },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    throw new Error(`ONEBOT_SEND_HTTP_${response.status}: 发送 OneBot 消息失败。`);
  }
  // ⚠️ OneBot v11 发送失败时 HTTP 仍是 200，错误藏在 retcode 里（被风控、小号下线、群已解散）。
  // 只看 response.ok 会把「没发出去」当成「发成功」，还要等用户来问「她怎么不回我」。
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return;
  }
  const record = payload as { retcode?: unknown; wording?: unknown; message?: unknown } | null;
  const retcode = record?.retcode;
  if (typeof retcode === "number" && retcode !== 0) {
    const detail = typeof record?.wording === "string" && record.wording
      ? record.wording
      : typeof record?.message === "string" && record.message
        ? record.message
        : "未知原因";
    throw new Error(`ONEBOT_SEND_${retcode}: 发送 OneBot 消息失败（${detail}）。`);
  }
}
