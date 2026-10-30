/**
 * QQ 小号（OneBot v11）渠道的消息处理 —— 对应官方 QQ 的 serve.ts。
 *
 * 把 OneBot 消息事件路由到绑定角色，走通用流水线，再把回复通过 OneBot HTTP API 发回。
 * 群聊默认仅在被 @ 时回复（replyOnlyWhenMentioned），私聊总是回复。
 */

import fs from "node:fs/promises";
import { getPrisma } from "../../prisma";
import { loadStickerCatalog, MAX_STICKER_BYTES } from "../../stickers";
import type { OnebotConnectionConfig, OnebotOutgoingMessage, OnebotResolvedEvent } from "./client";
import type { OnebotSegment } from "./types";
import { sendOnebotGroupMessage, sendOnebotPrivateMessage } from "./client";
import type { OnebotBindingRecord, OnebotConnectionRecord } from "./configure";
import { ONEBOT_FACES, toOnebotFaceSegments } from "./faces";
import { handleChannelBatch, handleChannelMessage, type ChannelReplySender } from "../pipeline";
import { loadBiliConnections } from "../bili/configure";
import { runDutyRound, type BiliDutyRoundResult } from "../bili/duty-pipeline";
import { isBiliRunCommand } from "./bili-run";
import {
  createGroupChatBuffer,
  evaluateGroupChatGate,
  groupChatDayStart,
  groupChatWindowMs,
  mentionsCharacterName,
} from "./group-chat";
import { createGroupContext, type GroupMessageFacts } from "./group-context";
import { ONEBOT_PLATFORM, readOnebotMentionTargets, readOnebotReplyToId } from "./types";
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
  | { status: "silent"; conversationId: string }
  /** 群聊攒批中：几秒后连同这一轮其他人的话一起处理。 */
  | { status: "buffered" }
  | { status: "duplicate" }
  | { status: "ignored"; reason: string };

/**
 * 把绑定里存的 routingKey 拆成群号列表。routingKey 现在支持逗号分隔的多个群号
 * （如 "12345,67890"），老的单群号数据天然是只有一个元素的列表。
 */
export function parseBindingRoutingKeys(routingKey: string | null): string[] {
  if (!routingKey) return [];
  return [...new Set(
    routingKey
      .split(",")
      .map((key) => key.trim())
      .filter((key) => key.length > 0),
  )];
}

/**
 * 选择处理此事件的绑定角色：群聊优先匹配 routingKey（支持一个绑定挂多个群号），
 * 否则用默认绑定（routingKey 为空或 "*"）；私聊优先默认绑定，
 * 没有默认绑定但只有一条启用中的绑定时也用她（否则填了群号就私聊永久静默）。
 */
export function routeOnebotEventToBinding(
  bindings: readonly OnebotBindingRecord[],
  event: OnebotResolvedEvent,
): OnebotBindingRecord | null {
  const defaults = bindings.filter((binding) => !binding.routingKey || binding.routingKey === "*");
  if (event.messageType === "group" && event.groupId) {
    const exact = bindings.find((binding) => parseBindingRoutingKeys(binding.routingKey).includes(event.groupId!));
    if (exact) return exact;
  }
  if (defaults[0]) return defaults[0]!;
  // 私聊的兜底：没有默认绑定时，只有一条启用中的绑定就直接给她。
  //
  // 以前这里只有 defaults[0]，于是「把群号填进绑定」等于「私聊永久静默」——
  // 而群里照常能回，从群聊那边完全看不出问题，用户只会觉得「她私聊不理我了」。
  // 多条绑定又没有默认绑定时仍然返回 null：那种情况下猜错人比不回更糟。
  return event.messageType === "private" && bindings.length === 1 ? bindings[0]! : null;
}

/**
 * 判断群聊消息是否 @ 了机器人自己。
 *
 * 优先用事件里的 self_id；网关没给时退回连接上记的小号 QQ —— 少了这个兜底，
 * 一旦 self_id 缺失，「仅 @ 时回复」就变成「永远不回」，而且日志里只会是一串 not_mentioned。
 */
function isSelfMentioned(event: OnebotResolvedEvent, fallbackSelfId = ""): boolean {
  const selfId = event.selfId || fallbackSelfId;
  if (!selfId) return false;
  const data = event.data as { message?: unknown } | null;
  const message = data?.message;
  if (!Array.isArray(message)) {
    // 非数组时退回检查文本里的 @selfId
    return event.content.includes(`@${selfId}`);
  }
  for (const segment of message) {
    if (!segment || typeof segment !== "object") continue;
    const seg = segment as { type?: unknown; data?: { qq?: unknown } | null };
    if (seg.type === "at" && seg.data?.qq !== undefined) {
      if (String(seg.data.qq) === selfId) return true;
    }
  }
  return false;
}

/** 已处理的群指令消息 id，防止 QQ 网关重复投递导致连刷两轮。 */
const processedBiliRunCommands = new Set<string>();
/** 正在跑 B站 的角色；同一角色不并发跑两轮。 */
const biliRunInFlight = new Set<string>();

/**
 * 同一个绑定在同一个会话里的消息必须排队处理，不能并发。
 *
 * OneBot 的 WS 帧是各帧独立派发的：群里连着来 6 条消息，6 个 handler 会同时跑起来。
 * 而群聊限流统计的是「已经落库的回复」—— 前面几条还在等模型，库里还是 0 条，
 * 于是全部放行，32 秒说完本该撑 10 分钟的 5 条额度（2026-10-29 实测 6 条）。
 * 排队同时修掉另一件事：回复顺序不再和群里的发言顺序错开。
 */
const conversationChains = new Map<string, Promise<unknown>>();

/** 排到队时已经过了这么久 = 这句话在群里早过去了，补一句只会更怪。 */
const QUEUE_STALE_MS = 20_000;

type PendingGroupMessage = {
  event: OnebotResolvedEvent;
  binding: OnebotBindingRecord;
  at: number;
  /** 这一条真实 @ 了她。 */
  direct: boolean;
  /** 这一条正文里出现了她的名字/别名。 */
  named: boolean;
  /** 这一条是主人发的。群聊里也要认得主人，落库和提炼时标「主人」。 */
  isOwner: boolean;
};

/** 群里怎么叫她：角色名 + 手填的昵称。@ 由 isSelfMentioned 单独判。 */
function cueNames(binding: OnebotBindingRecord): string[] {
  return [binding.characterName, ...binding.groupChat.aliases]
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

function enqueueConversation<T>(key: string, task: () => Promise<T>): Promise<T> {
  const tail = conversationChains.get(key) ?? Promise.resolve();
  // 前一个失败也要继续跑自己的，所以 then 的 onRejected 也接 task。
  const run = tail.then(task, task);
  const guard = run.then(() => undefined, () => undefined);
  conversationChains.set(key, guard);
  void guard.then(() => {
    // 只有自己还是队尾时才清理，否则会把后来者的链一起删掉。
    if (conversationChains.get(key) === guard) conversationChains.delete(key);
  });
  return run;
}

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

/**
 * 回复发回原处：群消息发群，私聊发人。
 * 表情必须单独一条 —— 拼进正文会卡在句子中间，而且它发失败也没必要让正文背锅。
 */
/**
 * 把正文和可选的「引用回复」拼成出站消息。
 *
 * 群聊里多条鱼并存时，引用让「我接的是哪一句」不再靠猜：模型给的 replyToMessageId
 * 是 transcript 里那条消息的 QQ 真实 message id，这里转成 OneBot reply 段拼在正文前。
 * id 必须是纯数字（QQ message id），否则退回纯文本 —— 宁可少引一次，也不发坏段。
 */
export function buildOnebotReplyMessage(reply: string, replyToMessageId?: string): OnebotOutgoingMessage {
  if (replyToMessageId && /^\d+$/.test(replyToMessageId)) {
    return [
      { type: "reply", data: { id: replyToMessageId } },
      { type: "text", data: { text: reply } },
    ];
  }
  return reply;
}

/**
 * 表情包（贴图）段：图片走 `image` 段的 base64 形式。
 *
 * 用 `base64://` 而不是本地路径：网关不一定和适配器在同一台机器上，路径方式一旦跨机就是
 * 一张发不出去的图，而表情包最多 2MB，base64 传过去完全够用（本地路径省下的那点开销不值这个风险）。
 */
export function toOnebotStickerSegments(base64: string): OnebotSegment[] {
  if (!base64) return [];
  return [{ type: "image", data: { file: `base64://${base64}` } }];
}

/** 读回表情包文件并转成段。文件没了（换电脑只搬了库）返回空数组，静默跳过。 */
export async function loadStickerSegments(filePath: string): Promise<OnebotSegment[]> {
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_STICKER_BYTES) return [];
    const file = await fs.readFile(filePath);
    return toOnebotStickerSegments(file.toString("base64"));
  } catch {
    return [];
  }
}

function createReplySender(
  config: OnebotConnectionConfig,
  target: Pick<OnebotResolvedEvent, "messageType" | "groupId" | "userId">,
): ChannelReplySender {
  return async (reply, options) => {
    const send = (message: OnebotOutgoingMessage): Promise<void> => {
      if (target.messageType === "group" && target.groupId) {
        return sendOnebotGroupMessage(config, target.groupId, message);
      }
      if (target.userId) {
        return sendOnebotPrivateMessage(config, target.userId, message);
      }
      return Promise.resolve();
    };
    await send(buildOnebotReplyMessage(reply, options?.replyToMessageId));
    // 表情包优先：贴了图就不再发内置表情 —— 一句话后面挂两种表情，像自动回复机器人。
    const segments = options?.sticker
      ? await loadStickerSegments(options.sticker.filePath)
      : toOnebotFaceSegments(options?.faces ?? []);
    if (!segments.length) return;
    await send(segments).catch((error) => {
      console.error("[onebot] 表情发送失败：", error instanceof Error ? error.message : String(error));
    });
  };
}

function logGroupRound(groupId: string, detail: Record<string, unknown>): void {
  console.log("[onebot] 群聊", JSON.stringify({ groupId, ...detail }));
}

export function createOnebotMessageHandler(record: OnebotConnectionRecord) {
  /** 连接内的短期群聊上下文：背景、成员代号、话题参与。按绑定+群隔离。 */
  const groupContext = createGroupContext({ selfQq: record.accountQq });

  const factsOf = (event: OnebotResolvedEvent, at: number): GroupMessageFacts => ({
    messageId: event.messageId,
    at,
    senderQq: event.userId,
    displayName: event.displayName,
    text: event.content,
    mentionTargets: readOnebotMentionTargets(event.data, event.selfId || record.accountQq),
    replyToMessageId: readOnebotReplyToId(event.data),
  });

  /**
   * 一轮群聊的判定与处理。
   *
   * 闸门放在这里而不是 push 的那一刻：push 时还不知道这一轮到底聊了什么，
   * 也不知道她上一次开口是什么时候 —— 这两样都要等这一轮安静下来才成立。
   */
  const flushGroupRound = async (items: PendingGroupMessage[]): Promise<void> => {
    const binding = items[0]!.binding;
    const groupEvent = items[0]!.event;
    const settings = binding.groupChat;
    const contextKey = `${binding.id}:${groupEvent.conversationKey}`;
    const direct = items.some((item) => item.direct);
    const named = items.some((item) => item.named);
    const facts = items.map((item) => factsOf(item.event, item.at));
    const topicCandidate = groupContext.topicCandidate(contextKey, facts);

    const prisma = getPrisma();
    // 群聊消息不再逐条写库，但「这个连接最近还有事件」仍要更新，否则页面会显示成掉线。
    void prisma.platformConnection
      .update({ where: { id: record.id }, data: { lastEventAt: new Date() } })
      .catch(() => undefined);
    const conversation = await prisma.conversation.findFirst({
      where: { channelBindingId: binding.id, externalConversationId: groupEvent.conversationKey },
      select: { id: true },
    });
    const lastAssistant = conversation
      ? await prisma.message.findFirst({
          where: { conversationId: conversation.id, role: "ASSISTANT" },
          orderBy: { occurredAt: "desc" },
          select: { occurredAt: true },
        })
      : null;
    const spokenToday = conversation
      ? await prisma.message.count({
          where: {
            conversationId: conversation.id,
            role: "ASSISTANT",
            occurredAt: { gte: groupChatDayStart() },
          },
        })
      : 0;

    const now = new Date();
    const lastSpokeAt = lastAssistant?.occurredAt ?? null;
    const gate = evaluateGroupChatGate({
      settings,
      now,
      direct,
      named,
      topicCandidate,
      lastSpokeAt,
      spokenToday,
      random: Math.random(),
    });
    if (!gate.allowed) {
      // direct / named 一定要一起打：早退时少了这两个，事后分不清是「@ 没认出来」
      // 还是「认出来了但被别的闸拦了」—— 前者换协议端，后者调参数，处理方式完全不同。
      logGroupRound(groupEvent.groupId, { reason: gate.reason, messages: items.length, direct, named });
      return;
    }
    // 群规限流仍然生效：闸门管「该不该接」，这里管「这个群十分钟能说几句」。
    if (await isGroupReplyLimited(binding, groupEvent)) {
      logGroupRound(groupEvent.groupId, { reason: "group_reply_limit", messages: items.length, direct, named });
      return;
    }

    const currentIds = items.map((item) => item.event.messageId);
    const result = await handleChannelBatch({
      platform: ONEBOT_PLATFORM,
      characterId: binding.characterId,
      bindingId: binding.id,
      eventType: "GROUP_MESSAGE",
      externalConversationId: groupEvent.conversationKey,
      messages: items.map((item) => ({
        externalMessageId: item.event.messageId,
        authorOpenId: item.event.userId,
        authorPlatformUid: item.event.userId,
        ...(item.event.displayName ? { authorDisplayName: item.event.displayName } : {}),
        content: item.event.content,
        // 入模的正文把 @ 换成代号；落库仍是原样。
        promptContent: groupContext.formatText(contextKey, item.event.content),
        member: groupContext.memberCode(contextKey, item.event.userId),
        // 主人发的消息带上 isOwner：群聊里也认得出主人，落库与提炼时标「主人」。
        ...(item.isOwner ? { speaker: { isOwner: true } } : {}),
        ...(item.event.images.length ? { images: item.event.images } : {}),
        occurredAt: new Date(item.at),
      })),
      faceCatalog: ONEBOT_FACES,
      // 她自己的表情包：清单非空时优先于内置表情（空清单 = 这个角色还没传过图）。
      stickerCatalog: await loadStickerCatalog(binding.characterId),
      // 只有真实 @ 与 all 档不允许「想了想还是不说」。
      allowSilent: !gate.mustReply,
      group: {
        direct,
        background: groupContext.background(contextKey, currentIds),
        anchors: groupContext.anchors(contextKey),
      },
      sendReply: createReplySender(record.config, groupEvent),
    });

    if (result.status === "replied") {
      groupContext.recordReply(contextKey, facts, { source: direct ? "mention" : "ambient" });
    } else if (result.status === "silent" && result.groupDecision) {
      // 沉默但认得出「还是在聊那个话题」：有界地续一下，不新建。
      groupContext.refreshFromDecision(contextKey, result.groupDecision);
    }
    // ignored 一定要带上原因：只写「ignored」时分不清是额度用完、模型没配、还是她不想说话，
    // 而这三种在群里的表现完全一样——她一句话都不说，查起来只能靠猜。
    logGroupRound(groupEvent.groupId, {
      reason: gate.reason,
      status: result.status === "ignored" ? `ignored:${result.reason}` : result.status,
      messages: items.length,
      direct,
      topics: groupContext.activeTopicCount(contextKey),
    });
  };

  const groupChatBuffer = createGroupChatBuffer<PendingGroupMessage>({
    onFlush: async (key, items) => {
      await enqueueConversation(key, () => flushGroupRound(items));
    },
  });

  const handleRoutedEvent = async (
    event: OnebotResolvedEvent,
    binding: OnebotBindingRecord,
  ): Promise<OnebotHandleOutcome> => {
    const sendReply = createReplySender(record.config, event);

    const canManageAnnouncement = record.groupAnnouncementEnabled
      && event.messageType === "group"
      && Boolean(event.groupId)
      && event.senderRole !== "member";

    // 确认发布允许不带 @：管理员刚看完草稿，回一句「确认发布」就够了。
    if (canManageAnnouncement && isAnnouncementConfirm(event.content)) {
      return handleAnnouncementConfirm(record, event, binding, sendReply);
    }

    const isGroupMessage = event.messageType === "group" && Boolean(event.groupId);
    const groupChatMode = binding.groupChat.mode;
    // 两个信号必须分开：真实 @ 是程序事实，名字只是弱线索（群里可能有好几条同款鱼）。
    const direct = isGroupMessage && isSelfMentioned(event, record.accountQq);
    const named = isGroupMessage && mentionsCharacterName(event.content, cueNames(binding));
    const contextKey = `${binding.id}:${event.conversationKey}`;

    // 先进短期上下文：哪怕这条后面被闸门丢掉，它也是下一轮的背景。
    if (isGroupMessage && event.content) {
      groupContext.remember(contextKey, factsOf(event, Date.now()));
    }

    // 「仅 @ 时回复」是对整个群聊的开关，指令类消息也受它约束（保持老行为）。
    // 名字命中与已参与话题算「可以看一眼」，交给后面的闸门与模型判断。
    if (isGroupMessage && groupChatMode === "mention") {
      const facts = [factsOf(event, Date.now())];
      if (!direct && !named && !groupContext.topicCandidate(contextKey, facts)) {
        return { status: "ignored", reason: "not_mentioned" };
      }
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

    // 群聊统一走一条攒批管道：三档只决定「放不放进来」，不再有单条快速路径。
    // 指令类（公告、B站）已经在上面的分支里返回，不会走到这里。
    if (isGroupMessage) {
      groupChatBuffer.push(
        contextKey,
        { event, binding, at: Date.now(), direct, named, isOwner: Boolean(record.ownerQq) && event.userId === record.ownerQq },
        groupChatWindowMs(binding.groupChat, direct || named),
      );
      return { status: "buffered" };
    }

    // 私聊：单条直接回，行为不变。
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
      eventType: "PRIVATE_MESSAGE",
      externalConversationId: event.conversationKey,
      externalMessageId: event.messageId,
      authorOpenId: event.userId,
      authorPlatformUid: event.userId,
      authorDisplayName: event.displayName || undefined,
      content: event.content,
      ...(event.images.length ? { images: event.images } : {}),
      // QQ 是唯一能发表情的渠道；清单非空即声明能力，是否真发还要过角色开关和冷却。
      faceCatalog: ONEBOT_FACES,
      stickerCatalog: await loadStickerCatalog(binding.characterId),
      sendReply,
    });
  };

  return async (event: OnebotResolvedEvent): Promise<OnebotHandleOutcome> => {
    const binding = routeOnebotEventToBinding(record.bindings, event);
    if (!binding) return { status: "ignored", reason: "no_binding" };
    const queuedAt = Date.now();
    return enqueueConversation(`${binding.id}:${event.conversationKey}`, async () => {
      // 排队等太久说明前一条还在跑（或者群里已经刷过去了），回过去也是对着空气说话。
      if (Date.now() - queuedAt > QUEUE_STALE_MS) {
        return { status: "ignored", reason: "stale_in_queue" };
      }
      return handleRoutedEvent(event, binding);
    });
  };
}
