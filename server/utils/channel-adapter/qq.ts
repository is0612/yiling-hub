import type { QqMessageEventType } from "./types";
import { readQqAuthorOpenId, readQqMessageId } from "./types";

export type QqConnectionConfig = {
  appId: string;
  appSecret: string;
  tokenUrl: string;
  apiBaseUrl: string;
  gatewayUrl: string;
};

export function resolveQqConfig(overrides: {
  appId: string;
  appSecret: string;
  tokenUrl?: string;
  apiBaseUrl?: string;
  gatewayUrl?: string;
}): QqConnectionConfig {
  return {
    appId: overrides.appId,
    appSecret: overrides.appSecret,
    tokenUrl: overrides.tokenUrl || process.env.QQ_TOKEN_URL || "https://bots.qq.com/app/getAppAccessToken",
    apiBaseUrl: overrides.apiBaseUrl || process.env.QQ_API_BASE_URL || "https://api.sgroup.qq.com",
    gatewayUrl: overrides.gatewayUrl || process.env.QQ_GATEWAY_URL || "wss://api.sgroup.qq.com/websocket",
  };
}

// ---------------------------------------------------------------------------
// Access token (OAuth2 app token, cached until shortly before expiry)
// ---------------------------------------------------------------------------

type CachedToken = { token: string; expiresAt: number };
const tokenCache = new Map<string, CachedToken>();

export async function getQqAccessToken(config: QqConnectionConfig): Promise<string> {
  const cached = tokenCache.get(config.appId);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appId: config.appId, clientSecret: config.appSecret }),
  });
  if (!response.ok) {
    throw new Error("QQ_TOKEN_HTTP_" + response.status + ": 获取 QQ 访问令牌失败。");
  }
  const payload = await response.json() as { access_token?: unknown; expires_in?: unknown };
  const token = typeof payload.access_token === "string" ? payload.access_token : "";
  if (!token) throw new Error("QQ_TOKEN_INVALID: QQ 返回的访问令牌为空。");
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : 7200;
  const expiresAt = Date.now() + Math.max(60, expiresIn - 120) * 1000;
  tokenCache.set(config.appId, { token, expiresAt });
  return token;
}

// ---------------------------------------------------------------------------
// Message sending (REST). Passive replies echo the incoming msg_id (+ msg_seq for groups).
// ---------------------------------------------------------------------------

const msgSeqByMsgId = new Map<string, number>();
const MSG_SEQ_TTL_MS = 5 * 60 * 1000;

function nextMsgSeq(msgId: string): number {
  const current = msgSeqByMsgId.get(msgId) ?? 0;
  const next = current + 1;
  msgSeqByMsgId.set(msgId, next);
  setTimeout(() => {
    if (msgSeqByMsgId.get(msgId) === next) msgSeqByMsgId.delete(msgId);
  }, MSG_SEQ_TTL_MS).unref?.();
  return next;
}

export async function sendQqMessage(
  config: QqConnectionConfig,
  token: string,
  input: { eventType: QqMessageEventType; data: unknown; text: string },
): Promise<void> {
  const msgId = readQqMessageId(input.data);
  const authorOpenId = readQqAuthorOpenId(input.data);
  const record = input.data as { group_openid?: unknown };
  const groupOpenId = typeof record?.group_openid === "string" ? record.group_openid : "";

  let url: string;
  let body: Record<string, unknown>;
  if (input.eventType === "GROUP_AT_MESSAGE_CREATE") {
    if (!groupOpenId) throw new Error("QQ_SEND_NO_GROUP: 群消息缺少 group_openid。");
    url = `${config.apiBaseUrl}/v2/groups/${encodeURIComponent(groupOpenId)}/messages`;
    body = { content: input.text, msg_type: 0, msg_id: msgId, msg_seq: nextMsgSeq(msgId) };
  } else {
    if (!authorOpenId) throw new Error("QQ_SEND_NO_USER: 私聊消息缺少 user_openid。");
    url = `${config.apiBaseUrl}/v2/users/${encodeURIComponent(authorOpenId)}/messages`;
    body = { content: input.text, msg_type: 0, msg_id: msgId };
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { authorization: "QQBot " + token, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error("QQ_SEND_HTTP_" + response.status + ": 发送 QQ 消息失败。");
  }
}

// ---------------------------------------------------------------------------
// Gateway (WebSocket). Opcodes: 10 hello, 2 identify, 1 heartbeat, 0 dispatch.
// ---------------------------------------------------------------------------

export type QqGatewayHandlers = {
  onMessageEvent: (eventType: QqMessageEventType, data: unknown) => void | Promise<void>;
  onStatus?: (status: "connecting" | "ready" | "disconnected" | "error", detail?: string) => void;
  onClose?: () => void;
};

const QQ_GATEWAY_INTENTS = (1 << 0) | (1 << 25); // GROUP_AT_MESSAGE_CREATE | C2C_MESSAGE_CREATE

function safeJson(value: unknown): { op?: number; d?: unknown; t?: string } | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as { op?: number; d?: unknown; t?: string };
    return parsed && typeof parsed.op === "number" ? parsed : null;
  } catch {
    return null;
  }
}

export function connectQqGateway(config: QqConnectionConfig, handlers: QqGatewayHandlers): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(config.gatewayUrl);
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let seq = 0;
    let identified = false;
    let settled = false;

    const settleClose = () => {
      if (!settled) {
        settled = true;
        resolve(() => close());
      }
    };
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
      handlers.onStatus?.("error", error.message);
    };

    socket.onopen = () => {
      handlers.onStatus?.("connecting");
    };

    socket.onmessage = async (event) => {
      const text = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
      const payload = safeJson(text);
      if (!payload) return;

      if (payload.op === 10) {
        const interval = (payload.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval;
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op: 1, d: seq }));
        }, Math.max(5000, Number(interval) || 41_250));
        if (!identified) {
          identified = true;
          socket.send(JSON.stringify({
            op: 2,
            d: { token: "QQBot " + (await getQqAccessToken(config)), intents: QQ_GATEWAY_INTENTS, shard: [0, 1] },
          }));
        }
        return;
      }

      if (payload.op === 0) {
        if (typeof payload.s === "number") seq = payload.s;
        const eventType = payload.t as string | undefined;
        if (eventType === "READY") {
          handlers.onStatus?.("ready");
          settleClose();
          return;
        }
        if (eventType === "GROUP_AT_MESSAGE_CREATE" || eventType === "C2C_MESSAGE_CREATE") {
          settleClose();
          handlers.onStatus?.("ready");
          try {
            await handlers.onMessageEvent(eventType as QqMessageEventType, payload.d);
          } catch (error) {
            handlers.onStatus?.("error", error instanceof Error ? error.message : String(error));
          }
        }
        return;
      }

      if (payload.op === 11) return; // heartbeat ack
    };

    socket.onclose = () => {
      if (heartbeat) clearInterval(heartbeat);
      handlers.onStatus?.("disconnected");
      handlers.onClose?.();
    };

    socket.onerror = () => {
      fail(new Error("QQ_GATEWAY_ERROR: WebSocket 连接失败。"));
    };

    function close() {
      if (heartbeat) clearInterval(heartbeat);
      try {
        socket.close();
      } catch {
        // already closing
      }
    }
  });
}
