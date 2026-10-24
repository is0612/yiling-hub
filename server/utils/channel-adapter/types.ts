/**
 * Shared types and protocol constants for QQ official-bot channel integration.
 * Endpoints are overridable via environment variables so a local mock can stand in during tests.
 */

export const QQ_PLATFORM = "qq";

export type QqMessageEventType = "GROUP_AT_MESSAGE_CREATE" | "C2C_MESSAGE_CREATE";

export type QqAuthor = {
  user_openid: string;
  member_openid?: string;
};

export type QqGroupAtMessage = {
  id: string;
  author: QqAuthor;
  group_openid: string;
  content: string;
  timestamp: string;
};

export type QqC2cMessage = {
  id: string;
  author: QqAuthor;
  content: string;
  timestamp: string;
};

export type QqGatewayDispatch<T> = {
  op: 0;
  s?: number;
  t: QqMessageEventType;
  d: T;
};

export type QqHelloPayload = {
  op: 10;
  d: { heartbeat_interval: number };
};

export type QqGatewayEvent =
  | QqHelloPayload
  | { op: 11; d?: unknown }
  | { op: 0; s?: number; t: string; d: unknown }
  | { op: number; d?: unknown };

/** The text content QQ delivers for a message event. */
export function readQqMessageText(eventType: QqMessageEventType, data: unknown): string {
  const record = data as { content?: unknown } | null;
  return typeof record?.content === "string" ? record.content : "";
}

export function readQqMessageId(data: unknown): string {
  const record = data as { id?: unknown } | null;
  return typeof record?.id === "string" ? record.id : "";
}

export function readQqAuthorOpenId(data: unknown): string {
  const record = data as { author?: { user_openid?: unknown } } | null;
  return typeof record?.author?.user_openid === "string" ? record.author.user_openid : "";
}

/** The stable conversation key for a QQ group or private chat. */
export function qqConversationKey(eventType: QqMessageEventType, data: unknown): string {
  const record = data as { group_openid?: unknown; author?: { user_openid?: unknown } } | null;
  if (eventType === "GROUP_AT_MESSAGE_CREATE") {
    return typeof record?.group_openid === "string" ? "g:" + record.group_openid : "";
  }
  return typeof record?.author?.user_openid === "string" ? "c:" + record.author.user_openid : "";
}
