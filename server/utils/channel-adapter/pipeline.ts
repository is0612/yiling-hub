import { generateConversationReply, type ConversationContextMessage, type ConversationGroupDecision } from "../chat-reply";
import { isEmojiEnabled, resolveChatModelSettings } from "../chat-model-config";
import { resolveCharacterApiKey } from "../credential-encryption";
import {
  rankMemoriesWithBudget, rankSnapshotsWithBudget,
  resolveMemoryItemLimit, resolveMemoryTokenBudget, resolveSnapshotTokenBudget,
} from "../memory-retrieval";
import { recordModelUsage, readDailyQuota, toUsageTokens } from "../model-usage";
import {
  applyImageDescriptions,
  describeImages,
  MAX_IMAGES_PER_TURN,
  resolveImageUnderstandingSettings,
  type ChannelImageRef,
} from "../image-understanding";
import { ensureExternalIdentityScope } from "../identity-scope";
import { ensureOwnerPrivateScope } from "../memory-scope-access";
import { getPrisma } from "../prisma";
import { pickStickerCatalog, type StickerCatalogEntry } from "../stickers";
import { collectStickersFromTurn } from "../sticker-collect";

export type ChannelReplyOptions = {
  /** 表情 id。渠道自己保证 id 合法；不支持表情的渠道忽略即可。 */
  faces?: string[];
  /**
   * 她自己的表情包（贴图）。渠道把它当图片单独发一条；与 faces 二选一，
   * 传了 sticker 就不再发内置表情。
   */
  sticker?: { id: string; filePath: string };
  /** 引用回复的消息 id（本平台原始 id）。群聊里让她锚定「接的是哪一句」。 */
  replyToMessageId?: string;
};

export type ChannelReplySender = (text: string, options?: ChannelReplyOptions) => Promise<void>;

/** 上一条回复带过表情后，多久之内不再发——连着两条都贴图，像自动回复机器人。 */
const FACE_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * 渠道会话键 `g:<群号>` / `c:<账号>` 里取出群号。
 *
 * 只用于把「这是哪个群」写进会话标题和 metadata —— 路由仍以完整的 externalConversationId
 * 为准。群聊记录会进角色全局记忆，事后要能看出「这句话是在哪个群说的」，而标题原来
 * 取的是第一条消息的前 80 字，翻记录时根本认不出是哪个群。
 */
function readGroupIdFromConversationKey(key: string): string | null {
  const matched = /^g:(\d+)$/.exec(key);
  return matched?.[1] ?? null;
}

/** 一轮里的一个人说的话。群聊会把几秒内的几条消息合成一轮。 */
export type ChannelTurnMessage = {
  externalMessageId: string;
  authorOpenId: string;
  /** Stable per-platform author id (bili uid / qq openid). Used to upsert ExternalIdentity. */
  authorPlatformUid?: string;
  /** Optional author display name for identity metadata. */
  authorDisplayName?: string;
  content: string;
  /** 给模型看的正文（@ 已代号化）；不传就等于 content。落库仍用 content。 */
  promptContent?: string;
  /** 群聊里的成员代号；只有群聊会传。 */
  member?: string;
  /** 收到这条消息的时刻（不是模型返回的时刻）。 */
  occurredAt?: Date;
  /** 这条消息里带的图。只有接了「看图」旁路才会被读，没配视觉模型时完全忽略。 */
  images?: ChannelImageRef[];
  /** 当前说话人是不是主人；只用于提示词，不参与鉴权。 */
  speaker?: {
    displayName?: string;
    isOwner: boolean;
    ownerDisplayName?: string;
  };
};

export type ChannelMessageInput = {
  platform: string;
  characterId: string;
  bindingId: string;
  /** Platform-specific message event type (e.g. QQ group message, bili dm). */
  eventType: string;
  /** Stable key for the conversation: "g:<group_openid>", "c:<user_openid>", "dm:<id>", etc. */
  externalConversationId: string;
  externalMessageId: string;
  authorOpenId: string;
  /** Stable per-platform author id (bili uid / qq openid). Used to upsert ExternalIdentity. */
  authorPlatformUid?: string;
  /** Optional author display name for identity metadata. */
  authorDisplayName?: string;
  /** 当前说话人是不是主人；只用于提示词，不参与鉴权。 */
  speaker?: {
    displayName?: string;
    isOwner: boolean;
    ownerDisplayName?: string;
  };
  content: string;
  /** 这条消息带的图。渠道不传就等于「这个渠道没有图」，不影响其他行为。 */
  images?: ChannelImageRef[];
  /**
   * 这个渠道能发的表情清单。**传了就等于声明「本渠道支持表情」**——B站 私信没有表情段，
   * 不传；流水线不认平台名，只认这份清单在不在。
   */
  faceCatalog?: ReadonlyArray<{ id: string; name: string }>;
  /**
   * 这个角色的表情包清单。**传了就等于声明「本渠道能发图片」**，并且优先于内置表情：
   * 有清单时模型从里面挑一张，内置表情不再进提示词。
   */
  stickerCatalog?: ReadonlyArray<StickerCatalogEntry>;
  sendReply: ChannelReplySender;
};

/** 群聊这一轮的上下文：本轮是否 @ 她、之前几句、她参与过的话题。 */
export type ChannelGroupTurnContext = {
  direct: boolean;
  background: Array<{ id: string; at: number; member: string; speaker: string; text: string }>;
  anchors: Array<{ id: string; label: string }>;
};

/** 群聊一轮：几秒内几个人说的话，一次看、最多回一次。 */
export type ChannelBatchInput = {
  platform: string;
  characterId: string;
  bindingId: string;
  eventType: string;
  externalConversationId: string;
  messages: ChannelTurnMessage[];
  faceCatalog?: ReadonlyArray<{ id: string; name: string }>;
  stickerCatalog?: ReadonlyArray<StickerCatalogEntry>;
  /** 允许模型说「这轮不插嘴」。被 @ 时传 false —— 点名了还不回比乱回更糟。 */
  allowSilent?: boolean;
  /** 群聊上下文；私聊不传。 */
  group?: ChannelGroupTurnContext;
  sendReply: ChannelReplySender;
};

export type ChannelMessageResult =
  | { status: "replied"; conversationId: string; groupDecision?: ConversationGroupDecision }
  | { status: "silent"; conversationId: string; groupDecision?: ConversationGroupDecision }
  | { status: "duplicate" }
  | { status: "ignored"; reason: string };

/** 从已存消息的 metadata 里取表情 id。更早的消息没有这个字段，返回空数组。 */
function readStoredFaceIds(metadata: unknown): string[] {
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  const ids = record.faceIds;
  return Array.isArray(ids) ? ids.filter((item): item is string => typeof item === "string") : [];
}

/** 从已存消息的 metadata 里取表情包 id。没有（或不是字符串）返回 null。 */
function readStoredStickerId(metadata: unknown): string | null {
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  return typeof record.stickerId === "string" && record.stickerId ? record.stickerId : null;
}

/**
 * 把这一轮里的图先变成文字，再交给聊天模型。
 *
 * 聊天模型（deepseek-flash 这类）在聊天这条路上走的是文本 body，图没法直接混进去，
 * 所以"看图"只能发生在进提示词之前：视觉模型出 2-4 句描述，正文里的 `[图片]` 换成
 * `[图片：描述]`。角色没打开 `imageUnderstanding` 时这里原样返回 —— 行为与接入前一致。
 *
 * 放在额度检查之后：额度已经超了就别再为看图多花一次调用。
 * 失败一律吞掉：少一句描述不该让整轮回复变成错误事件。
 */
async function attachImageDescriptions(
  messages: ChannelTurnMessage[],
  context: {
    modelConfig: unknown;
    chatModel: string;
    apiBaseUrl: string;
    apiKey: string;
    characterId: string;
    bindingId: string;
  },
): Promise<ChannelTurnMessage[]> {
  if (!messages.some((message) => (message.images?.length ?? 0) > 0)) return messages;
  const settings = resolveImageUnderstandingSettings({
    modelConfig: context.modelConfig,
    chatModel: context.chatModel,
    chatApiBaseUrl: context.apiBaseUrl,
    chatApiKey: context.apiKey,
  });
  if (!settings) return messages;

  let remaining = MAX_IMAGES_PER_TURN;
  const descriptionsByMessage = new Map<string, Array<string | null>>();
  for (const message of messages) {
    if (remaining <= 0) break;
    const refs = (message.images ?? []).filter((image) => Boolean(image.url));
    if (!refs.length) continue;
    const batch = refs.slice(0, remaining);
    remaining -= batch.length;
    try {
      descriptionsByMessage.set(
        message.externalMessageId,
        await describeImages(batch, settings, {
          characterId: context.characterId,
          channelBindingId: context.bindingId,
        }),
      );
    } catch {
      // 看图失败只是少一句描述，`[图片]` 原样保留。
    }
  }
  if (!descriptionsByMessage.size) return messages;

  return messages.map((message) => {
    const descriptions = descriptionsByMessage.get(message.externalMessageId);
    if (!descriptions?.length) return message;
    return { ...message, content: applyImageDescriptions(message.content, descriptions) };
  });
}

/**
 * The reusable channel event pipeline: idempotent ingest → character binding → character-global
 * memory retrieval → model reply → persistence → send back. This is platform-agnostic apart from
 * the QQ message-event type used for the conversation key.
 *
 * 群聊（`GROUP_MESSAGE`）只读角色全局记忆：一个群里说话的是不同的人，
 * 把某一个人的私人记忆端到另一个人面前，等于当面念别人的悄悄话。
 * 私聊仍然带上这个人的 identity scope。
 */
async function runChannelTurn(input: {
  platform: string;
  characterId: string;
  bindingId: string;
  eventType: string;
  externalConversationId: string;
  messages: ChannelTurnMessage[];
  faceCatalog?: ReadonlyArray<{ id: string; name: string }>;
  stickerCatalog?: ReadonlyArray<StickerCatalogEntry>;
  /** 允许模型说「这轮我不插嘴」。只有群聊批处理会传。 */
  allowSilent?: boolean;
  /** 群聊上下文；私聊不传。 */
  group?: ChannelGroupTurnContext;
  sendReply: ChannelReplySender;
}): Promise<ChannelMessageResult> {
  const prisma = getPrisma();
  const isGroup = input.eventType === "GROUP_MESSAGE";
  let messages = input.messages
    .filter((message) => message.externalMessageId && message.content)
    .slice(-10);
  if (!messages.length) return { status: "ignored", reason: "missing_fields" };

  // Character lookup comes first: a paused or archived character must not answer channel
  // messages, and rejecting early also avoids creating an external identity for a dead character.
  const character = await prisma.character.findUnique({
    where: { id: input.characterId },
    select: {
      id: true,
      name: true,
      ownerId: true,
      basePrompt: true,
      styleExamples: true,
      status: true,
      modelConfig: true,
      memoryScopes: { where: { scopeType: "CHARACTER_GLOBAL" }, select: { id: true } },
    },
  });
  if (!character) return { status: "ignored", reason: "character_missing" };
  if (character.status !== "ACTIVE") return { status: "ignored", reason: "character_inactive" };
  const globalScope = character.memoryScopes[0];
  if (!globalScope) return { status: "ignored", reason: "no_global_scope" };

  // Idempotency: a QQ message id is unique for the application, so a re-delivered event is dropped
  // regardless of whether its conversation has been created yet. 群聊一轮里有几条，全查一遍。
  const seen = await prisma.message.findMany({
    where: { externalMessageId: { in: messages.map((message) => message.externalMessageId) } },
    select: { externalMessageId: true },
  });
  if (seen.length) {
    const seenIds = new Set(seen.map((row) => row.externalMessageId));
    const fresh = messages.filter((message) => !seenIds.has(message.externalMessageId));
    if (!fresh.length) return { status: "duplicate" };
    messages = fresh;
  }

  // Upsert the external identities for the people in this turn. 群聊一轮里可能有好几个人，
  // 每个人各自一行；同一轮里同一个人说两句就只 upsert 一次。
  let primaryIdentityScopeId: string | null = null;
  const identityScopeByAuthor = new Map<string, string | null>();
  for (const message of messages) {
    const platformUid = (message.authorPlatformUid || message.authorOpenId || "").trim();
    if (!platformUid || identityScopeByAuthor.has(platformUid)) continue;
    const identity = await prisma.externalIdentity.upsert({
      where: { platform_platformUid: { platform: input.platform, platformUid } },
      create: {
        platform: input.platform,
        platformUid,
        displayName: message.authorDisplayName?.slice(0, 255) || null,
        status: "UNVERIFIED",
      },
      update: {
        ...(message.authorDisplayName ? { displayName: message.authorDisplayName.slice(0, 255) } : {}),
      },
      select: { id: true },
    });
    // Establish the identity's dedicated memory scope so its private memory can be
    // isolated per platform (and later linked via admin verification). Best-effort:
    // a scope that already exists is reused; failure must not block the message.
    const scope = await ensureExternalIdentityScope(
      input.characterId, input.platform, platformUid, identity.id,
    ).catch(() => null);
    identityScopeByAuthor.set(platformUid, scope?.scopeId ?? null);
  }
  {
    const first = messages[0]!;
    const firstUid = (first.authorPlatformUid || first.authorOpenId || "").trim();
    primaryIdentityScopeId = firstUid ? identityScopeByAuthor.get(firstUid) ?? null : null;
  }

  // 主人专属私人范围：说话人明确是主人（私聊里渠道传 isOwner）时，会话挂到角色主人的
  // USER_PRIVATE 范围，而不是该账号的外部身份范围。这样主人的私聊走「角色主人私人记忆」，
  // 由调度器单独排快照，且只在主人自己的对话里可读 —— 不会混进全局、也不会串给群友。
  const isOwnerTurn = !isGroup && messages[0]?.speaker?.isOwner === true;
  let ownerPrivateScopeId: string | null = null;
  if (isOwnerTurn) {
    ownerPrivateScopeId = await ensureOwnerPrivateScope(input.characterId, character.ownerId);
  }

  const chatSettings = resolveChatModelSettings(character.modelConfig);
  let apiKey = "";
  try {
    apiKey = await resolveCharacterApiKey(character.modelConfig, chatSettings.apiBaseUrl);
  } catch {
    return { status: "ignored", reason: "api_key_decrypt_failed" };
  }
  if (!apiKey || !chatSettings.model) return { status: "ignored", reason: "model_not_configured" };

  // 额度用完就静默不回：渠道里抛错会把一条普通聊天变成失败事件，还会触发重试。
  const quota = await readDailyQuota(input.characterId, character.modelConfig);
  if (quota.exceeded) return { status: "ignored", reason: "daily_quota_exceeded" };

  // 图先变成文字再进提示词；角色没开看图开关时这一步什么都不做。
  messages = await attachImageDescriptions(messages, {
    modelConfig: character.modelConfig,
    chatModel: chatSettings.model,
    apiBaseUrl: chatSettings.apiBaseUrl,
    apiKey,
    characterId: input.characterId,
    bindingId: input.bindingId,
  });

  // 「偷表情包」：群里的图值得收就存进她的表情库。只收群聊、不看她自己发的图，
  // 由开关 `modelConfig.stickerAutoCollect` 控制（默认关）。失败静默，不影响这轮回复。
  if (isGroup) {
    const collectCandidates = messages.flatMap((message) =>
      (message.images ?? []).filter((img) => img.url).map((img) => ({
        url: img.url,
        ...(img.summary ? { summary: img.summary } : {}),
      })),
    );
    if (collectCandidates.length) {
      await collectStickersFromTurn(collectCandidates, {
        characterId: input.characterId,
        ...(input.bindingId ? { bindingId: input.bindingId } : {}),
        modelConfig: character.modelConfig,
        chatModel: chatSettings.model,
        chatApiBaseUrl: chatSettings.apiBaseUrl,
        chatApiKey: apiKey,
      }).catch(() => undefined);
    }
  }

  const existingConversation = await prisma.conversation.findFirst({
    where: { channelBindingId: input.bindingId, externalConversationId: input.externalConversationId },
    select: { id: true, title: true },
  });

  const recentStoredMessages = existingConversation
    ? await prisma.message.findMany({
        where: { conversationId: existingConversation.id },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: 20,
        select: { role: true, content: true, occurredAt: true, metadata: true, externalMessageId: true },
      })
    : [];

  // 表情要看三件事：渠道收不收（清单）、角色开没开开关、上一条是不是刚贴过。
  // 只看前两个的话，一个爱发表情的角色会在每句后面都挂一张。
  const lastAssistant = recentStoredMessages.find((item) => item.role === "ASSISTANT");
  const lastStickerId = lastAssistant ? readStoredStickerId(lastAssistant.metadata) : null;
  const facesCoolingDown = Boolean(
    lastAssistant
    && Date.now() - lastAssistant.occurredAt.getTime() < FACE_COOLDOWN_MS
    && (readStoredFaceIds(lastAssistant.metadata).length > 0 || Boolean(lastStickerId)),
  );
  // 表情包优先于内置表情：有素材库就只给素材库（并剔除上一张，避免她一直贴同一张）。
  const stickerCatalog = input.stickerCatalog?.length
    && isEmojiEnabled(character.modelConfig)
    && !facesCoolingDown
    ? pickStickerCatalog(input.stickerCatalog, lastStickerId)
    : undefined;
  const emojiFaces = !stickerCatalog?.length
    && input.faceCatalog?.length
    && isEmojiEnabled(character.modelConfig)
    && !facesCoolingDown
    ? input.faceCatalog
    : undefined;

  const recentMessages: ConversationContextMessage[] = recentStoredMessages
    .reverse()
    .filter((item) => item.role === "USER" || item.role === "ASSISTANT")
    .map((item) => ({
      role: item.role as "USER" | "ASSISTANT",
      content: item.content.slice(0, 1800),
      occurredAt: item.occurredAt.toISOString(),
    }));

  const modelText = (message: ChannelTurnMessage) => message.promptContent ?? message.content;
  const currentMessage = messages.length === 1
    ? modelText(messages[0]!)
    : messages.map((message) => `${message.authorDisplayName || "群友"}：${modelText(message)}`).join("\n");

  const retrievalQuery = [
    currentMessage,
    ...recentMessages.filter((item) => item.role === "USER").slice(-2).map((item) => item.content),
  ].join("\n");

  // Retrieval scope: character-global (shared persona) plus the author's own identity scope
  // (per-platform private memory). 群聊只用全局：一轮里好几个人，谁的私人记忆都不该端出来。
  // 主人私聊用 owner 的 USER_PRIVATE 范围（而不是外部身份范围）。
  const readableScopeIds = isGroup
    ? [globalScope.id]
    : (isOwnerTurn && ownerPrivateScopeId
      ? [globalScope.id, ownerPrivateScopeId]
      : (primaryIdentityScopeId ? [globalScope.id, primaryIdentityScopeId] : [globalScope.id]));

  const memoryCandidates = await prisma.memoryItem.findMany({
    where: { memoryScopeId: { in: readableScopeIds }, status: "ACTIVE", deletedAt: null },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: 300,
    select: {
      id: true, category: true, content: true, confidence: true, updatedAt: true, createdAt: true,
      memoryScopeId: true, importance: true, lastRecalledAt: true, recallCount: true,
    },
  });
  const memoryRank = rankMemoriesWithBudget(retrievalQuery, memoryCandidates, {
    limit: resolveMemoryItemLimit(character.modelConfig),
    tokenBudget: resolveMemoryTokenBudget(character.modelConfig),
  });
  const memories = memoryRank.items.map((memory) => ({
    id: memory.id,
    category: memory.category,
    content: memory.content.slice(0, 1200),
    confidence: memory.confidence,
    relevanceScore: memory.relevanceScore,
    scope: memory.memoryScopeId === globalScope.id ? ("character" as const) : ("private" as const),
  }));

  const snapshotCandidates = await prisma.memorySnapshot.findMany({
    where: { memoryScopeId: { in: readableScopeIds }, status: "CURRENT" },
    orderBy: [{ createdAt: "desc" }, { version: "desc" }],
    take: 80,
    select: { id: true, summary: true, periodStart: true, periodEnd: true, version: true, createdAt: true, memoryScopeId: true },
  });
  const snapshotRank = rankSnapshotsWithBudget(retrievalQuery, snapshotCandidates, {
    limit: 4,
    tokenBudget: resolveSnapshotTokenBudget(character.modelConfig),
  });
  const snapshots = snapshotRank.items.map((snapshot) => ({
    id: snapshot.id,
    summary: snapshot.summary.slice(0, 3000),
    periodStart: snapshot.periodStart.toISOString(),
    periodEnd: snapshot.periodEnd.toISOString(),
    version: snapshot.version,
    relevanceScore: snapshot.relevanceScore,
    scope: snapshot.memoryScopeId === globalScope.id ? ("character" as const) : ("private" as const),
  }));

  // 群聊一轮是「几个人在聊」，不是「某个人在对我说话」：交给 transcript。
  // 进了群聊管道就一律用群聊语境 —— 被 @ 时虽然不允许沉默，但同样需要上下文。
  const allowSilent = input.allowSilent === true && isGroup;
  const useTranscript = Boolean(input.group) || isGroup || messages.length > 1;

  // 群聊背景里可能混着已经落库的历史（recentMessages 里也有一份），按消息 id 去重，
  // 免得同一句在提示词里出现两遍。
  const storedMessageIds = new Set(
    recentStoredMessages
      .map((item) => item.externalMessageId)
      .filter((id): id is string => Boolean(id)),
  );
  const backgroundLines = (input.group?.background ?? []).filter((line) => !storedMessageIds.has(line.id));

  let generated;
  try {
    generated = await generateConversationReply({
      characterName: character.name,
      characterPrompt: character.basePrompt.slice(0, 12_000),
      ...(!useTranscript && messages[0]!.speaker ? { speaker: messages[0]!.speaker } : {}),
      styleExamples: (character.styleExamples ?? "").slice(0, 8000),
      model: chatSettings.model,
      apiKey,
      apiBaseUrl: chatSettings.apiBaseUrl,
      temperature: chatSettings.temperature,
      maxTokens: chatSettings.maxTokens,
      currentMessage,
      ...(useTranscript
        ? {
            transcript: messages.map((message) => ({
              id: message.externalMessageId,
              ...(message.member ? { member: message.member } : {}),
              speaker: message.authorDisplayName ?? "",
              content: message.promptContent ?? message.content,
              ...(message.occurredAt ? { occurredAt: message.occurredAt.toISOString() } : {}),
            })),
          }
        : {}),
      ...(input.group
        ? {
            groupChat: true,
            direct: input.group.direct,
            ...(backgroundLines.length
              ? {
                  groupBackground: backgroundLines.map((line) => ({
                    id: line.id,
                    member: line.member,
                    speaker: line.speaker,
                    content: line.text,
                    occurredAt: new Date(line.at).toISOString(),
                  })),
                }
              : {}),
            ...(input.group.anchors.length ? { groupAnchors: input.group.anchors } : {}),
          }
        : {}),
      ...(allowSilent ? { allowSilent } : {}),
      recentMessages,
      memories,
      snapshots,
      ...(emojiFaces ? { emojiFaces } : {}),
      ...(stickerCatalog?.length ? { emojiStickers: stickerCatalog } : {}),
    });
  } catch (error) {
    return { status: "ignored", reason: (error instanceof Error ? error.message : "model_error").slice(0, 200) };
  }

  const now = new Date();
  const assistantAt = new Date(now.getTime() + 1);
  const groupId = isGroup ? readGroupIdFromConversationKey(input.externalConversationId) : null;
  // 群会话标题用群号：原来的「第一条消息前 80 字」在记忆页翻记录时完全认不出是哪个群。
  const title = existingConversation?.title
    || (groupId ? `QQ群 ${groupId}` : currentMessage.slice(0, 80));
  const replyFaces = generated.action === "silent" ? [] : generated.faceIds;
  // 贴纸只认本次给的清单：模型返回了 id 但图不在清单里（比如刚被删掉），就当没选。
  const replySticker = generated.action === "silent" || !generated.stickerId
    ? null
    : input.stickerCatalog?.find((entry) => entry.id === generated.stickerId) ?? null;
  const conversationScopeId = isGroup
    ? globalScope.id
    : (isOwnerTurn && ownerPrivateScopeId ? ownerPrivateScopeId : (primaryIdentityScopeId ?? globalScope.id));

  const conversationId = await prisma.$transaction(async (tx) => {
    const conversation = existingConversation ?? await tx.conversation.create({
      data: {
        characterId: input.characterId,
        // 群聊挂在角色全局 scope 下：它属于一群人，不属于某一个外部身份。
        memoryScopeId: conversationScopeId,
        channelBindingId: input.bindingId,
        externalConversationId: input.externalConversationId,
        title,
        status: "ACTIVE",
        // kind/groupId 让「这段记录属于哪个群」可查；记忆页的群聊记录按它分组。
        metadata: {
          platform: input.platform,
          kind: isGroup ? "group" : "private",
          ...(groupId ? { groupId } : {}),
        },
      },
      select: { id: true, title: true },
    });
    for (const [index, message] of messages.entries()) {
      await tx.message.create({
        data: {
          conversationId: conversation.id,
          externalMessageId: message.externalMessageId,
          role: "USER",
          content: message.content,
          // 一条一轮时保持原来的「处理时刻」，多条时用各自的收到时刻，别让并发把顺序搅乱。
          occurredAt: messages.length === 1 ? now : (message.occurredAt ?? new Date(now.getTime() - (messages.length - index))),
          metadata: {
            source: "channel",
            platform: input.platform,
            authorOpenId: message.authorOpenId,
            ...(message.authorDisplayName ? { authorDisplayName: message.authorDisplayName } : {}),
            // 群聊的成员代号（member_n）：昵称可能缺失或被改，代号在同一个群里稳定。
            ...(message.member ? { member: message.member } : {}),
            // 主人发的消息：群聊提炼时也要认得出「这是主人」，不能跟群友混。
            ...(message.speaker?.isOwner ? { isOwner: true } : {}),
          },
        },
        select: { id: true },
      });
    }
    if (generated.action === "reply") {
      await tx.message.create({
        data: {
          conversationId: conversation.id,
          role: "ASSISTANT",
          content: generated.reply,
          occurredAt: assistantAt,
          metadata: {
            source: "channel",
            platform: input.platform,
            generatedBy: "llm",
            model: generated.model,
            provider: generated.provider,
            promptTemplateVersion: generated.promptTemplateVersion,
            usedMemoryIds: generated.usedMemoryIds,
            usedSnapshotIds: generated.usedSnapshotIds,
            // 表情段不进 content：正文要能原样重放给下一轮模型，混进 [face] 会被当成用户打的字。
            ...(replyFaces.length ? { faceIds: replyFaces } : {}),
            ...(replySticker ? { stickerId: replySticker.id } : {}),
          },
        },
        select: { id: true },
      });
      await tx.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: assistantAt } });
    } else {
      await tx.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: messages[messages.length - 1]!.occurredAt ?? now } });
    }
    return conversation.id;
  });

  if (generated.action === "reply") {
    const replyOptions = replyFaces.length || replySticker || generated.groupDecision?.replyToMessageId
      ? {
          ...(replyFaces.length ? { faces: replyFaces } : {}),
          ...(replySticker ? { sticker: { id: replySticker.id, filePath: replySticker.filePath } } : {}),
          ...(generated.groupDecision?.replyToMessageId ? { replyToMessageId: generated.groupDecision.replyToMessageId } : {}),
        }
      : undefined;
    await input.sendReply(generated.reply, replyOptions);
    // 记一次使用：页面要能看出「哪几张她根本没用过」。写失败不影响已经发出去的回复。
    if (replySticker) {
      await prisma.characterSticker.update({
        where: { id: replySticker.id },
        data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
      }).catch(() => undefined);
    }
  }
  if (generated.usedMemoryIds.length) {
    await prisma.memoryItem.updateMany({
      where: { id: { in: generated.usedMemoryIds } },
      data: { lastRecalledAt: new Date(), recallCount: { increment: 1 } },
    }).catch(() => undefined);
  }
  await recordModelUsage({
    kind: "channel",
    model: chatSettings.model,
    usage: toUsageTokens(generated.usage),
    characterId: input.characterId,
    channelBindingId: input.bindingId,
    conversationId,
  });
  const decision = generated.groupDecision ? { groupDecision: generated.groupDecision } : {};
  return generated.action === "silent"
    ? { status: "silent", conversationId, ...decision }
    : { status: "replied", conversationId, ...decision };
}

/** 单条路径的结果：不传 allowSilent，所以永远不会是 silent。 */
export type ChannelSingleMessageResult =
  | { status: "replied"; conversationId: string }
  | { status: "duplicate" }
  | { status: "ignored"; reason: string };

/** 单条消息（私聊、B站、以及群聊里 @ 她的那一条）。行为与此前一致。 */
export async function handleChannelMessage(input: ChannelMessageInput): Promise<ChannelSingleMessageResult> {
  const result = await runChannelTurn({
    platform: input.platform,
    characterId: input.characterId,
    bindingId: input.bindingId,
    eventType: input.eventType,
    externalConversationId: input.externalConversationId,
    messages: [{
      externalMessageId: input.externalMessageId,
      authorOpenId: input.authorOpenId,
      ...(input.authorPlatformUid ? { authorPlatformUid: input.authorPlatformUid } : {}),
      ...(input.authorDisplayName ? { authorDisplayName: input.authorDisplayName } : {}),
      content: input.content,
      ...(input.images?.length ? { images: input.images } : {}),
      ...(input.speaker ? { speaker: input.speaker } : {}),
    }],
    ...(input.faceCatalog ? { faceCatalog: input.faceCatalog } : {}),
    ...(input.stickerCatalog?.length ? { stickerCatalog: input.stickerCatalog } : {}),
    sendReply: input.sendReply,
  });
  // 单条路径不该出现 silent；真出现了就当作没说，别让调用方去处理一个它不可能遇到的状态。
  return result.status === "silent" ? { status: "ignored", reason: "silent" } : result;
}

/** 群聊一轮：几条消息一起看，模型可以决定不说（silent）。 */
export async function handleChannelBatch(input: ChannelBatchInput): Promise<ChannelMessageResult> {
  return runChannelTurn({
    platform: input.platform,
    characterId: input.characterId,
    bindingId: input.bindingId,
    eventType: input.eventType,
    externalConversationId: input.externalConversationId,
    messages: input.messages,
    ...(input.faceCatalog ? { faceCatalog: input.faceCatalog } : {}),
    ...(input.stickerCatalog?.length ? { stickerCatalog: input.stickerCatalog } : {}),
    ...(input.group ? { group: input.group } : {}),
    allowSilent: input.allowSilent !== false,
    sendReply: input.sendReply,
  });
}
