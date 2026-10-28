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
  readOnebotMessageId,
  readOnebotMessageText,
  readOnebotUserId,
  type OnebotMessageType,
  type OnebotSegment,
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
  selfId: string;
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
    selfId: String(record?.self_id ?? ""),
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
 * failure so the caller can back off and retry. The socket auto-reconnects internally on
 * unexpected drops and reports status through `handlers.onStatus`.
 */
export function connectOnebot(
  config: OnebotConnectionConfig,
  handlers: OnebotHandlers,
): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(withWsAccessToken(config.wsUrl, config.accessToken));
    let probeTimer: ReturnType<typeof setInterval> | null = null;
    let settled = false;
    let closedByCaller = false;

    const clearProbe = () => {
      if (probeTimer) {
        clearInterval(probeTimer);
        probeTimer = null;
      }
    };

    const startProbe = () => {
      clearProbe();
      probeTimer = setInterval(async () => {
        try {
          await fetch(config.httpUrl + "/get_status", {
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
    };

    socket.onopen = () => {
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

    socket.onerror = () => {
      handlers.onStatus?.("error", "ONEBOT_WS_ERROR");
      if (!settled) {
        settled = true;
        reject(new Error("ONEBOT_WS_ERROR: OneBot WebSocket 连接失败。"));
      }
    };

    socket.onclose = (event) => {
      clearProbe();
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
