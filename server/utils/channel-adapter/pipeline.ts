import { generateConversationReply, type ConversationContextMessage } from "../chat-reply";
import { isEmojiEnabled, resolveChatModelSettings } from "../chat-model-config";
import { resolveCharacterApiKey } from "../credential-encryption";
import {
  rankMemoriesWithBudget, rankSnapshotsWithBudget,
  resolveMemoryItemLimit, resolveMemoryTokenBudget, resolveSnapshotTokenBudget,
} from "../memory-retrieval";
import { recordModelUsage, readDailyQuota, toUsageTokens } from "../model-usage";
import { ensureExternalIdentityScope } from "../identity-scope";
import { getPrisma } from "../prisma";

export type ChannelReplyOptions = {
  /** 表情 id。渠道自己保证 id 合法；不支持表情的渠道忽略即可。 */
  faces?: string[];
};

export type ChannelReplySender = (text: string, options?: ChannelReplyOptions) => Promise<void>;

/** 上一条回复带过表情后，多久之内不再发——连着两条都贴图，像自动回复机器人。 */
const FACE_COOLDOWN_MS = 10 * 60 * 1000;

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
  content: string;
  /**
   * 这个渠道能发的表情清单。**传了就等于声明「本渠道支持表情」**——B站 私信没有表情段，
   * 不传；流水线不认平台名，只认这份清单在不在。
   */
  faceCatalog?: ReadonlyArray<{ id: string; name: string }>;
  sendReply: ChannelReplySender;
};

export type ChannelMessageResult =
  | { status: "replied"; conversationId: string }
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

/**
 * The reusable channel event pipeline: idempotent ingest → character binding → character-global
 * memory retrieval → model reply → persistence → send back. This is platform-agnostic apart from
 * the QQ message-event type used for the conversation key.
 *
 * v1 reads character-global memory only; per-external-user private memory is a later step.
 */
export async function handleChannelMessage(input: ChannelMessageInput): Promise<ChannelMessageResult> {
  const prisma = getPrisma();

  // Character lookup comes first: a paused or archived character must not answer channel
  // messages, and rejecting early also avoids creating an external identity for a dead character.
  const character = await prisma.character.findUnique({
    where: { id: input.characterId },
    select: {
      id: true,
      name: true,
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
  // regardless of whether its conversation has been created yet.
  const duplicate = await prisma.message.findFirst({
    where: { externalMessageId: input.externalMessageId },
    select: { id: true },
  });
  if (duplicate) return { status: "duplicate" };

  // Upsert the external identity for this platform author, so cross-platform identity
  // management can later verify and link it. Defaults to UNVERIFIED; never auto-merge.
  const platformUid = (input.authorPlatformUid || input.authorOpenId || "").trim();
  let externalIdentityId: string | null = null;
  let identityScopeId: string | null = null;
  if (platformUid) {
    const identity = await prisma.externalIdentity.upsert({
      where: { platform_platformUid: { platform: input.platform, platformUid } },
      create: {
        platform: input.platform,
        platformUid,
        displayName: input.authorDisplayName?.slice(0, 255) || null,
        status: "UNVERIFIED",
      },
      update: {
        ...(input.authorDisplayName ? { displayName: input.authorDisplayName.slice(0, 255) } : {}),
      },
      select: { id: true },
    });
    externalIdentityId = identity.id;
    // Establish the identity's dedicated memory scope so its private memory can be
    // isolated per platform (and later linked via admin verification). Best-effort:
    // a scope that already exists is reused; failure must not block the message.
    const scope = await ensureExternalIdentityScope(input.characterId, input.platform, platformUid, externalIdentityId).catch(() => null);
    identityScopeId = scope?.scopeId ?? null;
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

  const existingConversation = await prisma.conversation.findFirst({
    where: { channelBindingId: input.bindingId, externalConversationId: input.externalConversationId },
    select: { id: true, title: true },
  });

  const recentStoredMessages = existingConversation
    ? await prisma.message.findMany({
        where: { conversationId: existingConversation.id },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: 20,
        select: { role: true, content: true, occurredAt: true, metadata: true },
      })
    : [];

  // 表情要看三件事：渠道收不收（faceCatalog）、角色开没开开关、上一条是不是刚贴过。
  // 只看前两个的话，一个爱发表情的角色会在每句后面都挂一张。
  const lastAssistant = recentStoredMessages.find((item) => item.role === "ASSISTANT");
  const facesCoolingDown = Boolean(
    lastAssistant
    && Date.now() - lastAssistant.occurredAt.getTime() < FACE_COOLDOWN_MS
    && readStoredFaceIds(lastAssistant.metadata).length > 0,
  );
  const emojiFaces = input.faceCatalog?.length
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

  const retrievalQuery = [
    input.content,
    ...recentMessages.filter((item) => item.role === "USER").slice(-2).map((item) => item.content),
  ].join("\n");

  // Retrieval scope: character-global (shared persona) plus the author's own identity scope
  // (per-platform private memory). The identity scope is only this identity's, so it never
  // leaks another external user's private memory.
  const readableScopeIds = identityScopeId ? [globalScope.id, identityScopeId] : [globalScope.id];

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

  let generated;
  try {
    generated = await generateConversationReply({
      characterName: character.name,
      characterPrompt: character.basePrompt.slice(0, 12_000),
      styleExamples: (character.styleExamples ?? "").slice(0, 8000),
      model: chatSettings.model,
      apiKey,
      apiBaseUrl: chatSettings.apiBaseUrl,
      temperature: chatSettings.temperature,
      maxTokens: chatSettings.maxTokens,
      currentMessage: input.content,
      recentMessages,
      memories,
      snapshots,
      ...(emojiFaces ? { emojiFaces } : {}),
    });
  } catch (error) {
    return { status: "ignored", reason: (error instanceof Error ? error.message : "model_error").slice(0, 200) };
  }

  const now = new Date();
  const assistantAt = new Date(now.getTime() + 1);
  const title = existingConversation?.title || input.content.slice(0, 80);
  const replyFaces = generated.faceIds;

  const conversationId = await prisma.$transaction(async (tx) => {
    const conversation = existingConversation ?? await tx.conversation.create({
      data: {
        characterId: input.characterId,
        // The conversation belongs to the identity's own scope when an external author is
        // known, otherwise to the character-global scope. This keeps per-platform private
        // memory and its conversation together.
        memoryScopeId: identityScopeId ?? globalScope.id,
        channelBindingId: input.bindingId,
        externalConversationId: input.externalConversationId,
        title,
        status: "ACTIVE",
        metadata: { platform: input.platform },
      },
      select: { id: true, title: true },
    });
    await tx.message.create({
      data: {
        conversationId: conversation.id,
        externalMessageId: input.externalMessageId,
        role: "USER",
        content: input.content,
        occurredAt: now,
        metadata: { source: "channel", platform: input.platform, authorOpenId: input.authorOpenId },
      },
      select: { id: true },
    });
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
        },
      },
      select: { id: true },
    });
    await tx.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: assistantAt } });
    return conversation.id;
  });

  await input.sendReply(generated.reply, replyFaces.length ? { faces: replyFaces } : undefined);
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
  return { status: "replied", conversationId };
}
