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
import { loadBiliConnections } from "../bili/configure";
import { runDutyRound, type BiliDutyRoundResult } from "../bili/duty-pipeline";
import { isBiliRunCommand } from "./bili-run";
import { ONEBOT_PLATFORM } from "./types";
import {
  claimPendingAnnouncement,
  createPendingAnnouncement,
  draftAnnouncementText,
  findAnnouncementConversationId,
  findDuplicateAnnouncementEvent,
  findPendingAnnouncement,
  finishAnnouncement,
  isAnnouncementConfirm,
  parseAnnouncementRequest,
  publishPendingAnnouncement,
  recordAnnouncementExchange,
  writeAnnouncementAudit,
} from "./announcement";

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

/** 已处理的群指令消息 id，防止 QQ 网关重复投递导致连刷两轮。 */
const processedBiliRunCommands = new Set<string>();
/** 正在跑 B站 的角色；同一角色不并发跑两轮。 */
const biliRunInFlight = new Set<string>();

function rememberBiliRunCommand(messageId: string) {
  processedBiliRunCommands.add(messageId);
  if (processedBiliRunCommands.size > 500) {
    const oldest = processedBiliRunCommands.values().next().value;
    if (oldest) processedBiliRunCommands.delete(oldest);
  }
}

function summarizeBiliRound(result: BiliDutyRoundResult): string {
  if (!result.ok) return `这轮没刷成：${result.error ?? "未知原因"}`;
  if (result.picked === 0) {
    return result.error ? `这轮没刷成：${result.error}` : "刷完了，这轮没有挑中新视频。";
  }
  const parts = [`刷完了：挑中 ${result.picked} 条，跳过 ${result.skipped} 条`];
  if (result.delivered.comments > 0) parts.push(`评论 ${result.delivered.comments} 条`);
  if (result.delivered.fav > 0) parts.push(`收藏 ${result.delivered.fav} 条`);
  if (result.delivered.dynamic) parts.push("发了动态");
  const lines = [parts.join("，") + "。"];
  // 只回条数等于没评价。把挑中的标题、分数、理由带回来，主人不用再翻值班台。
  for (const item of result.pickedItems.slice(0, 3)) {
    const score = item.score !== null ? `${item.score} 分` : "未评分";
    const reason = item.reason.trim().slice(0, 48);
    lines.push(`· 《${item.title.slice(0, 30)}》${score}${reason ? `：${reason}` : ""}`);
  }
  if (result.picked > 3) lines.push(`· 还有 ${result.picked - 3} 条，详见 B站 值班台。`);
  return lines.join("\n");
}

/** 主人让鱼刷一轮 B站：先回执，再在后台跑；同一角色不并发。 */
async function handleBiliRunCommand(
  event: OnebotResolvedEvent,
  characterId: string,
  sendReply: (text: string) => Promise<void>,
): Promise<OnebotHandleOutcome> {
  if (processedBiliRunCommands.has(event.messageId)) return { status: "duplicate" };
  rememberBiliRunCommand(event.messageId);

  if (biliRunInFlight.has(characterId)) {
    await sendReply("上一轮 B站 还在跑，等它结束再说。");
    return { status: "replied", conversationId: "" };
  }

  let target: Awaited<ReturnType<typeof loadBiliConnections>>[number] | null = null;
  let binding: { id: string; characterId: string } | null = null;
  try {
    const connections = await loadBiliConnections();
    for (const connection of connections) {
      const found = connection.bindings.find((item) => item.characterId === characterId);
      if (found) {
        target = connection;
        binding = found;
        break;
      }
    }
  } catch (error) {
    await sendReply(`读 B站 配置失败：${(error instanceof Error ? error.message : String(error)).slice(0, 120)}`);
    return { status: "replied", conversationId: "" };
  }

  if (!target || !binding) {
    await sendReply("这个角色还没绑定 B站 值班账号，先到「B站 值班台」绑定后再试。");
    return { status: "replied", conversationId: "" };
  }

  const connection = target;
  const biliBinding = binding;
  biliRunInFlight.add(characterId);
  await sendReply("收到，我去刷一轮 B站，刷完在群里说。");
  void (async () => {
    try {
      const result = await runDutyRound(connection, biliBinding);
      await sendReply(summarizeBiliRound(result));
    } catch (error) {
      await sendReply(`这轮没刷成：${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`).catch(() => undefined);
    } finally {
      biliRunInFlight.delete(characterId);
    }
  })();
  return { status: "replied", conversationId: "" };
}

/** 群规限流：滚动时间窗由绑定自己定，只统计这条鱼在该群已落库的回复。0 条 = 不限。 */
async function isGroupReplyLimited(
  binding: OnebotBindingRecord,
  event: OnebotResolvedEvent,
): Promise<boolean> {
  if (event.messageType !== "group" || binding.replyLimitPerWindow <= 0) return false;
  const windowMs = Math.max(1, binding.replyWindowMinutes) * 60 * 1000;
  const recentReplies = await getPrisma().message.count({
    where: {
      role: "ASSISTANT",
      occurredAt: { gte: new Date(Date.now() - windowMs) },
      conversation: {
        is: { channelBindingId: binding.id, externalConversationId: event.conversationKey },
      },
    },
  });
  return recentReplies >= binding.replyLimitPerWindow;
}

function announcementErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  if (code === "MODEL_NOT_CONFIGURED") return "模型还没配置，写不了公告。请先在角色模型设置里填好 API。";
  if (code === "DAILY_QUOTA_EXCEEDED") return "今天的模型额度用完了，暂时写不了公告。";
  if (code === "CHARACTER_INACTIVE") return "这个角色当前不在运行中，写不了公告。";
  if (code === "CHARACTER_MISSING") return "找不到绑定到这个群的角色。";
  if (code === "API_KEY_DECRYPT_FAILED") return "角色 API Key 解不开，请到模型设置里重新填写。";
  if (code === "EMPTY_ANNOUNCEMENT") return "模型这次没写出正文，请再说一次公告主题。";
  return `写公告失败：${code.slice(0, 160)}`;
}

function announcementErrorReply(error: unknown): string {
  if (error instanceof Error && error.message.startsWith("ONEBOT_SEND_")) {
    return `公告发布失败：${error.message.slice(0, 220)}`;
  }
  return `公告发布失败：${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`;
}

/** 群里让角色拟公告：先写成草稿，等管理员确认后才发。 */
async function handleAnnouncementDraft(
  record: OnebotConnectionRecord,
  event: OnebotResolvedEvent,
  binding: OnebotBindingRecord,
  topic: string,
  sendReply: (text: string) => Promise<void>,
): Promise<OnebotHandleOutcome> {
  if (await findDuplicateAnnouncementEvent(event.messageId)) return { status: "duplicate" };

  const prisma = getPrisma();
  await prisma.platformConnection.update({
    where: { id: record.id },
    data: { lastEventAt: new Date() },
  }).catch(() => undefined);

  let reply: string;
  try {
    const conversationId = await findAnnouncementConversationId(binding.id, event.conversationKey);
    const draft = await draftAnnouncementText({
      characterId: binding.characterId,
      bindingId: binding.id,
      conversationId,
      topic,
    });
    await createPendingAnnouncement({
      connectionId: record.id,
      groupId: event.groupId,
      requestedBy: event.userId,
      characterId: binding.characterId,
      topic,
      content: draft.content,
    });
    reply = [
      "公告草稿（10 分钟内回复「确认发布」才会发出）：",
      "",
      draft.content,
    ].join("\n");
  } catch (error) {
    reply = announcementErrorMessage(error);
  }

  const persisted = await recordAnnouncementExchange({
    characterId: binding.characterId,
    bindingId: binding.id,
    event,
    userContent: event.content,
    assistantContent: reply,
  }).catch(() => null);
  await sendReply(reply);
  return { status: "replied", conversationId: persisted ?? "" };
}

/** 管理员确认发布：认领草稿 → 调 SnowLuma 公告接口 → 记审计。 */
async function handleAnnouncementConfirm(
  record: OnebotConnectionRecord,
  event: OnebotResolvedEvent,
  binding: OnebotBindingRecord,
  sendReply: (text: string) => Promise<void>,
): Promise<OnebotHandleOutcome> {
  if (await findDuplicateAnnouncementEvent(event.messageId)) return { status: "duplicate" };

  const prisma = getPrisma();
  await prisma.platformConnection.update({
    where: { id: record.id },
    data: { lastEventAt: new Date() },
  }).catch(() => undefined);

  let reply: string;
  const pending = await findPendingAnnouncement(record.id, event.groupId);
  if (!pending) {
    reply = "没有待发布的公告，或草稿已过期。先 @我 说要写什么公告。";
  } else if (!(await claimPendingAnnouncement(pending.id))) {
    reply = "这条公告正在发布或已经处理过，不会重复发送。";
  } else {
    const result = await publishPendingAnnouncement({
      pending,
      config: record.config,
      groupId: event.groupId,
    });
    await finishAnnouncement(pending.id, result);
    await writeAnnouncementAudit({
      connectionId: record.id,
      characterId: pending.characterId ?? binding.characterId,
      groupId: event.groupId,
      announcementId: pending.id,
      requestedBy: pending.requestedBy,
      ok: result.ok,
      error: result.error,
    });
    reply = result.ok ? "公告已发布。" : announcementErrorReply(new Error(result.error ?? ""));
  }

  const persisted = await recordAnnouncementExchange({
    characterId: binding.characterId,
    bindingId: binding.id,
    event,
    userContent: event.content,
    assistantContent: reply,
  }).catch(() => null);
  await sendReply(reply);
  return { status: "replied", conversationId: persisted ?? "" };
}

/** 主人的显示名：优先当前消息里的群名片，其次外部身份表里记过的昵称。 */
async function resolveOwnerDisplayName(record: OnebotConnectionRecord, event: OnebotResolvedEvent): Promise<string> {
  if (!record.ownerQq) return "";
  // 手填的称呼优先：外部身份表里可能是旧昵称，群名片又只在这个群有效。
  if (record.ownerName) return record.ownerName;
  if (event.userId === record.ownerQq && event.displayName) return event.displayName;
  try {
    const identity = await getPrisma().externalIdentity.findUnique({
      where: { platform_platformUid: { platform: ONEBOT_PLATFORM, platformUid: record.ownerQq } },
      select: { displayName: true },
    });
    return identity?.displayName?.trim() ?? "";
  } catch {
    return "";
  }
}

export function createOnebotMessageHandler(record: OnebotConnectionRecord) {
  return async (event: OnebotResolvedEvent): Promise<OnebotHandleOutcome> => {
    const binding = routeOnebotEventToBinding(record.bindings, event);
    if (!binding) return { status: "ignored", reason: "no_binding" };

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

    const canManageAnnouncement = record.groupAnnouncementEnabled
      && event.messageType === "group"
      && Boolean(event.groupId)
      && event.senderRole !== "member";

    // 确认发布允许不带 @：管理员刚看完草稿，回一句「确认发布」就够了。
    if (canManageAnnouncement && isAnnouncementConfirm(event.content)) {
      return handleAnnouncementConfirm(record, event, binding, sendReply);
    }

    // 群聊：仅当绑定要求 @ 且未被 @ 时忽略。
    if (event.messageType === "group" && binding.replyOnlyWhenMentioned && !isSelfMentioned(event)) {
      return { status: "ignored", reason: "not_mentioned" };
    }

    if (!event.content) return { status: "ignored", reason: "missing_fields" };

    // 拟稿请求必须先 @ 她，否则管理员在群里正常聊到「群公告」也会被当成指令。
    if (canManageAnnouncement) {
      const request = parseAnnouncementRequest(event.content);
      if (request) return handleAnnouncementDraft(record, event, binding, request.topic, sendReply);
    }

    // B站 指令只认主人：群友发同一句话直接忽略，不进入普通聊天，避免她答应别人。
    if (binding.groupBiliRunEnabled && event.messageType === "group" && isBiliRunCommand(event.content)) {
      if (!record.ownerQq || event.userId !== record.ownerQq) {
        return { status: "ignored", reason: "bili_run_not_owner" };
      }
      return handleBiliRunCommand(event, binding.characterId, sendReply);
    }

    // 群规限流只拦普通聊天；群公告是管理员显式确认的动作，不在这里静默。
    if (await isGroupReplyLimited(binding, event)) {
      return { status: "ignored", reason: "group_reply_limit" };
    }

    await getPrisma()
      .platformConnection.update({ where: { id: record.id }, data: { lastEventAt: new Date() } })
      .catch(() => undefined);

    const ownerDisplayName = await resolveOwnerDisplayName(record, event);
    const speaker = record.ownerQq
      ? {
          ...(event.displayName ? { displayName: event.displayName } : {}),
          isOwner: event.userId === record.ownerQq,
          ...(ownerDisplayName ? { ownerDisplayName } : {}),
        }
      : undefined;

    return handleChannelMessage({
      platform: ONEBOT_PLATFORM,
      ...(speaker ? { speaker } : {}),
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
