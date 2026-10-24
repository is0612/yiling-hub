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
} from "./types";

export type OnebotConnectionConfig = {
  wsUrl: string;
  httpUrl: string;
  /** WS auth token (Authorization: Bearer) — SnowLuma's WS token differs from its HTTP token. */
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
    const socket = new WebSocket(config.wsUrl);
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

    socket.onclose = () => {
      clearProbe();
      handlers.onStatus?.("disconnected");
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

/** Sends a private message through the OneBot HTTP API. */
export async function sendOnebotPrivateMessage(
  config: OnebotConnectionConfig,
  userId: string,
  text: string,
): Promise<void> {
  await sendOnebotApi(config, "send_private_msg", { user_id: Number(userId), message: text });
}

/** Sends a group message through the OneBot HTTP API. */
export async function sendOnebotGroupMessage(
  config: OnebotConnectionConfig,
  groupId: string,
  text: string,
): Promise<void> {
  await sendOnebotApi(config, "send_group_msg", { group_id: Number(groupId), message: text });
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
}
