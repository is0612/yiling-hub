/**
 * QQ 小号（OneBot v11）渠道的消息处理 —— 对应官方 QQ 的 serve.ts。
 *
 * 把 OneBot 消息事件路由到绑定角色，走通用流水线，再把回复通过 OneBot HTTP API 发回。
 * 群聊默认仅在被 @ 时回复（replyOnlyWhenMentioned），私聊总是回复。
 */

import { getPrisma } from "../../prisma";
import type { OnebotConnectionConfig, OnebotOutgoingMessage, OnebotResolvedEvent } from "./client";
import { sendOnebotGroupMessage, sendOnebotPrivateMessage } from "./client";
import type { OnebotBindingRecord, OnebotConnectionRecord } from "./configure";
import { ONEBOT_FACES, toOnebotFaceSegments } from "./faces";
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
    const sendReply = async (reply: string, options?: { faces?: string[] }): Promise<void> => {
      const send = (message: OnebotOutgoingMessage): Promise<void> => {
        if (event.messageType === "group" && event.groupId) {
          return sendOnebotGroupMessage(config, event.groupId, message);
        }
        if (event.userId) {
          return sendOnebotPrivateMessage(config, event.userId, message);
        }
        return Promise.resolve();
      };
      await send(reply);
      const segments = toOnebotFaceSegments(options?.faces ?? []);
      if (!segments.length) return;
      // 表情单独一条。拼进正文会卡在句子中间，而且它发失败也没必要让正文背锅。
      await send(segments).catch((error) => {
        console.error("[onebot] 表情发送失败：", error instanceof Error ? error.message : String(error));
      });
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
      // QQ 是唯一能发表情的渠道；清单非空即声明能力，是否真发还要过角色开关和冷却。
      faceCatalog: ONEBOT_FACES,
      sendReply,
    });
  };
}
