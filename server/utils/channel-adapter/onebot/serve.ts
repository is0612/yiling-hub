/**
 * QQ 小号（OneBot v11）渠道的消息处理 —— 对应官方 QQ 的 serve.ts。
 *
 * 把 OneBot 消息事件路由到绑定角色，走通用流水线，再把回复通过 OneBot HTTP API 发回。
 * 群聊默认仅在被 @ 时回复（replyOnlyWhenMentioned），私聊总是回复。
 */

import { getPrisma } from "../../prisma";
import type { OnebotConnectionConfig, OnebotResolvedEvent } from "./client";
import { sendOnebotGroupMessage, sendOnebotPrivateMessage } from "./client";
import type { OnebotBindingRecord, OnebotConnectionRecord } from "./configure";
import { handleChannelMessage } from "../pipeline";
import { ONEBOT_PLATFORM } from "./types";

export type OnebotHandleOutcome =
  | { status: "replied"; conversationId: string }
  | { status: "duplicate" }
  | { status: "ignored"; reason: string };

/**
 * 选择处理此事件的绑定角色：群聊优先匹配 routingKey（群号），否则用默认绑定（routingKey
 * 为空或 "*"）；私聊用默认绑定。
 */
export function routeOnebotEventToBinding(
  bindings: readonly OnebotBindingRecord[],
  event: OnebotResolvedEvent,
): OnebotBindingRecord | null {
  const defaults = bindings.filter((binding) => !binding.routingKey || binding.routingKey === "*");
  if (event.messageType === "group" && event.groupId) {
    const exact = bindings.find((binding) => binding.routingKey === event.groupId);
    if (exact) return exact;
  }
  return defaults[0] ?? null;
}

/** 判断群聊消息是否 @ 了机器人自己（selfId）。 */
function isSelfMentioned(event: OnebotResolvedEvent): boolean {
  const data = event.data as { message?: unknown } | null;
  const message = data?.message;
  if (!Array.isArray(message)) {
    // 非数组时退回检查文本里的 @selfId
    return event.selfId ? event.content.includes(`@${event.selfId}`) : false;
  }
  for (const segment of message) {
    if (!segment || typeof segment !== "object") continue;
    const seg = segment as { type?: unknown; data?: { qq?: unknown } | null };
    if (seg.type === "at" && seg.data?.qq !== undefined) {
      if (String(seg.data.qq) === event.selfId) return true;
    }
  }
  return false;
}

export function createOnebotMessageHandler(record: OnebotConnectionRecord) {
  return async (event: OnebotResolvedEvent): Promise<OnebotHandleOutcome> => {
    const binding = routeOnebotEventToBinding(record.bindings, event);
    if (!binding) return { status: "ignored", reason: "no_binding" };

    // 群聊：仅当配置要求 @ 且未被 @ 时忽略。
    if (event.messageType === "group" && record.replyOnlyWhenMentioned && !isSelfMentioned(event)) {
      return { status: "ignored", reason: "not_mentioned" };
    }

    if (!event.content) return { status: "ignored", reason: "missing_fields" };

    await getPrisma()
      .platformConnection.update({ where: { id: record.id }, data: { lastEventAt: new Date() } })
      .catch(() => undefined);

    const config = record.config;
    const sendReply = async (reply: string): Promise<void> => {
      if (event.messageType === "group" && event.groupId) {
        await sendOnebotGroupMessage(config, event.groupId, reply);
      } else if (event.userId) {
        await sendOnebotPrivateMessage(config, event.userId, reply);
      }
    };

    return handleChannelMessage({
      platform: ONEBOT_PLATFORM,
      characterId: binding.characterId,
      bindingId: binding.id,
      eventType: event.messageType === "group" ? "GROUP_MESSAGE" : "PRIVATE_MESSAGE",
      externalConversationId: event.conversationKey,
      externalMessageId: event.messageId,
      authorOpenId: event.userId,
      authorPlatformUid: event.userId,
      authorDisplayName: event.displayName || undefined,
      content: event.content,
      sendReply,
    });
  };
}
