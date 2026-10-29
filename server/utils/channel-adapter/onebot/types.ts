/**
 * Shared types and protocol constants for the QQ 小号 (OneBot v11) channel integration.
 *
 * OneBot v11 is the stable contract used by third-party QQ gateways (e.g. SnowLuma) that
 * expose a personal QQ account's messages as events over a forward WebSocket, plus an HTTP
 * API for sending replies. yiling-hub acts as a OneBot *client*: it connects to the gateway's
 * WS server and calls its HTTP API to send.
 *
 * Platform id is "qq-onebot". QQ 官方机器人渠道已下线，QQ 只保留这一条通道。
 */

import { onebotFaceName } from "./faces";

export const ONEBOT_PLATFORM = "qq-onebot";

/** OneBot v11 message types we handle. Other post_types (notice/request/meta_event) are ignored. */
export type OnebotMessageType = "private" | "group";

/** A single segment of an OneBot v11 `message` array (CQ code). */
export type OnebotSegment = {
  type: string;
  data?: Record<string, unknown>;
};

export type OnebotSender = {
  user_id?: unknown;
  nickname?: unknown;
  card?: unknown;
  /** 群成员身份：owner / admin / member。私聊事件通常没有这个字段。 */
  role?: unknown;
};

export type OnebotGroupRole = "owner" | "admin" | "member";

/**
 * 群成员身份。网关没给 role 时一律按 member 处理 —— 群管理动作宁可少做，
 * 也不能因为字段缺失把普通成员当成管理员。
 */
export function readOnebotGroupRole(data: unknown): OnebotGroupRole {
  const record = data as { sender?: { role?: unknown } | null } | null;
  const role = record?.sender?.role;
  if (role === "owner" || role === "admin") return role;
  return "member";
}

/** 只有群主与管理员能触发生效的群管理动作。 */
export function isOnebotGroupAdmin(data: unknown): boolean {
  const role = readOnebotGroupRole(data);
  return role === "owner" || role === "admin";
}

/** The message event envelope delivered by the gateway over WS. */
export type OnebotMessageEvent = {
  post_type: string;
  message_type?: unknown;
  message_type2?: unknown;
  sub_type?: unknown;
  message_id?: unknown;
  user_id?: unknown;
  group_id?: unknown;
  message?: unknown; // string or OnebotSegment[]
  raw_message?: unknown;
  sender?: OnebotSender | null;
  time?: unknown;
  self_id?: unknown;
};

/** Normalizes the author QQ number to a string. */
export function readOnebotUserId(data: unknown): string {
  const record = data as { user_id?: unknown; sender?: { user_id?: unknown } | null } | null;
  const raw = record?.user_id ?? record?.sender?.user_id;
  return raw === undefined || raw === null ? "" : String(raw);
}

/** Normalizes the group QQ number to a string. */
export function readOnebotGroupId(data: unknown): string {
  const record = data as { group_id?: unknown } | null;
  const raw = record?.group_id;
  return raw === undefined || raw === null ? "" : String(raw);
}

/** Normalizes the message id (for idempotency) to a string. */
export function readOnebotMessageId(data: unknown): string {
  const record = data as { message_id?: unknown } | null;
  const raw = record?.message_id;
  return raw === undefined || raw === null ? "" : String(raw);
}

/** Author display name: prefer the group card, then nickname. */
export function readOnebotDisplayName(data: unknown): string {
  const record = data as { sender?: { card?: unknown; nickname?: unknown } | null } | null;
  const card = record?.sender?.card;
  const nickname = record?.sender?.nickname;
  if (typeof card === "string" && card.trim()) return card.trim();
  if (typeof nickname === "string" && nickname.trim()) return nickname.trim();
  return "";
}

/**
 * Flattens an OneBot `message` into a single plain-text string. Text segments are joined;
 * `at` becomes "@<qq>"; other media segments become a placeholder.
 */
export function readOnebotMessageText(data: unknown): string {
  const record = data as { message?: unknown; raw_message?: unknown } | null;
  const message = record?.message;

  if (typeof message === "string") return message;

  if (Array.isArray(message)) {
    const parts: string[] = [];
    for (const segment of message) {
      if (!segment || typeof segment !== "object") continue;
      const seg = segment as OnebotSegment;
      const segData = seg.data ?? {};
      switch (seg.type) {
        case "text":
          if (typeof segData.text === "string" && segData.text) parts.push(segData.text);
          break;
        case "at": {
          const qq = segData.qq;
          if (qq !== undefined && qq !== null) parts.push(`@${qq}`);
          break;
        }
        case "image":
          parts.push("[图片]");
          break;
        case "face": {
          // 转成中文名而不是一律「[表情]」：对方发的是害羞还是白眼，语气完全不同。
          const name = onebotFaceName(segData.id);
          parts.push(name ? `[${name}]` : "[表情]");
          break;
        }
        case "mface":
        case "marketface":
          // 商城表情包只能拿到一句 summary，图片本身取不到。
          parts.push(typeof segData.summary === "string" && segData.summary.trim() ? segData.summary.trim() : "[表情包]");
          break;
        case "record":
          parts.push("[语音]");
          break;
        case "video":
          parts.push("[视频]");
          break;
        default:
          // Unknown segments are dropped rather than surfacing raw CQ codes.
          break;
      }
    }
    const text = parts.join("").trim();
    if (text) return text;
  }

  // Fall back to raw_message when the message array didn't yield text.
  if (typeof record?.raw_message === "string") return record.raw_message;
  return "";
}

/** The stable conversation key: "c:<user_id>" for private, "g:<group_id>" for group. */
export function onebotConversationKey(messageType: OnebotMessageType, data: unknown): string {
  if (messageType === "group") {
    const groupId = readOnebotGroupId(data);
    return groupId ? "g:" + groupId : "";
  }
  const userId = readOnebotUserId(data);
  return userId ? "c:" + userId : "";
}
