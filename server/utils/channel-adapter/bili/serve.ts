/**
 * B站渠道的被动回复处理 —— 对应 QQ 的 serve.ts。
 *
 * 与 QQ 的差异：B站没有 WebSocket 推送，被动消息（私信/评论/@）靠轮询 bili CLI 的
 * 收件箱命令（feed inbox / feed replies / feed mentions）获取。这里提供：
 *   - createBiliMessageHandler：把一条 B站 消息事件转成通用流水线调用。
 *   - pollInbox：轮询收件箱，把新消息交给 handler。
 */

import { getPrisma } from "../../prisma";
import type { BiliConnectionRecord, BiliBindingRecord } from "./configure";
import { handleChannelMessage } from "../pipeline";
import { runBili } from "./runner";
import { readBiliMessageId, readBiliMessageText, type BiliMessageEventType } from "./types";

export type BiliHandleOutcome =
  | { status: "replied"; conversationId: string }
  | { status: "duplicate" }
  | { status: "ignored"; reason: string };

/**
 * 构造一个 B站 消息事件处理器：把事件路由到绑定角色，走通用流水线，再把回复通过
 * bili dm send / comment post 发回。
 */
export function createBiliMessageHandler(record: BiliConnectionRecord, binding: BiliBindingRecord) {
  return async (eventType: BiliMessageEventType, data: unknown): Promise<BiliHandleOutcome> => {
    const content = readBiliMessageText(eventType, data);
    const externalMessageId = readBiliMessageId(data);
    const externalConversationId = (data as { conversationKey?: unknown } | null)?.conversationKey;
    const authorUid = (data as { authorUid?: unknown } | null)?.authorUid;
    if (!content || !externalMessageId || typeof externalConversationId !== "string" || !externalConversationId) {
      return { status: "ignored", reason: "missing_fields" };
    }

    await getPrisma()
      .platformConnection.update({ where: { id: record.id }, data: { lastEventAt: new Date() } })
      .catch(() => undefined);

    // 回发：私信走 dm send，评论/提及走 comment post
    const sendReply = async (reply: string): Promise<void> => {
      if (eventType === "DM_MESSAGE_CREATE") {
        const uid = typeof authorUid === "string" && authorUid ? authorUid : "owner";
        await runBili(["dm", "send", uid, reply], {
          bin: record.biliBin || undefined,
          env: record.dataHome ? { BILI_DESK_HOME: record.dataHome } : undefined,
        });
      } else {
        const bvid = (data as { bvid?: unknown } | null)?.bvid;
        if (typeof bvid === "string" && bvid) {
          await runBili(["comment", "post", bvid, reply], {
            bin: record.biliBin || undefined,
            env: record.dataHome ? { BILI_DESK_HOME: record.dataHome } : undefined,
          });
        }
      }
    };

    return handleChannelMessage({
      platform: "bili",
      characterId: binding.characterId,
      bindingId: binding.id,
      eventType,
      externalConversationId,
      externalMessageId,
      authorOpenId: typeof authorUid === "string" ? authorUid : "",
      authorPlatformUid: typeof authorUid === "string" ? authorUid : "",
      content,
      sendReply,
    });
  };
}

/** 轮询收件箱一次，把未读消息交给 handler。返回处理条数。 */
export async function pollBiliInbox(
  record: BiliConnectionRecord,
  binding: BiliBindingRecord,
  handler: ReturnType<typeof createBiliMessageHandler>,
): Promise<number> {
  const env = record.dataHome ? { BILI_DESK_HOME: record.dataHome } : undefined;
  const bin = record.biliBin || undefined;
  let handled = 0;

  // 收私信
  const dm = await runBili(["dm", "list", "--unread"], { bin, env });
  const dmData = readList(dm.json);
  for (const item of dmData) {
    const outcome = await handler("DM_MESSAGE_CREATE", {
      type: "DM_MESSAGE_CREATE",
      id: String(item.id ?? ""),
      authorUid: String(item.uid ?? ""),
      conversationKey: `dm:${item.id ?? ""}`,
      content: String(item.text ?? ""),
      timestamp: String(item.time ?? ""),
    });
    if (outcome.status === "replied" || outcome.status === "duplicate") handled += 1;
  }

  // 收回复我的评论
  const replies = await runBili(["feed", "replies"], { bin, env });
  const replyData = readList(replies.json);
  for (const item of replyData) {
    const outcome = await handler("COMMENT_CREATE", {
      type: "COMMENT_CREATE",
      id: String(item.rpid ?? ""),
      authorUid: String(item.uid ?? ""),
      conversationKey: `video:${item.bvid ?? ""}`,
      content: String(item.text ?? ""),
      timestamp: String(item.time ?? ""),
      bvid: String(item.bvid ?? ""),
    });
    if (outcome.status === "replied" || outcome.status === "duplicate") handled += 1;
  }

  return handled;
}

function readList(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) return data.filter((x): x is Record<string, unknown> => x !== null && typeof x === "object");
  if (data && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const inner = record.data ?? record.list ?? record.items;
    if (Array.isArray(inner)) return inner.filter((x): x is Record<string, unknown> => x !== null && typeof x === "object");
  }
  return [];
}
