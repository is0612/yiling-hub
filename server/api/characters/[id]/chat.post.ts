import { createHash, randomUUID } from "node:crypto";
import { createError, getRouterParam, readBody, setResponseStatus } from "h3";
import { generateConversationReply, type ConversationContextMessage } from "../../../utils/chat-reply";
import { resolveChatModelSettings } from "../../../utils/chat-model-config";
import { resolveCharacterApiKey } from "../../../utils/credential-encryption";
import { rankMemoryCandidates, rankSnapshotCandidates } from "../../../utils/memory-retrieval";
import { resolveChatMemoryScopes } from "../../../utils/memory-scope-access";
import { requireActorUserId } from "../../../utils/auth";
import { readTrimmedString, requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const body = await readBody<Record<string, unknown>>(event);
  const message = readTrimmedString(body?.message, "消息", 8000, { required: true });
  const rawRequestKey = body?.requestKey;
  if (rawRequestKey !== undefined && typeof rawRequestKey !== "string") {
    throw createError({ statusCode: 400, statusMessage: "requestKey 格式无效。" });
  }
  const requestKey = typeof rawRequestKey === "string" && rawRequestKey
    ? requireUuid(rawRequestKey, "请求")
    : randomUUID();
  const rawConversationId = body?.conversationId;
  if (rawConversationId !== undefined && typeof rawConversationId !== "string") {
    throw createError({ statusCode: 400, statusMessage: "conversationId 格式无效。" });
  }
  const requestedConversationId = typeof rawConversationId === "string" && rawConversationId
    ? requireUuid(rawConversationId, "会话")
    : null;
  // Bind a stable idempotency key to the exact user input and target conversation.
  // The hash contains no credentials or model configuration.
  const requestHash = createHash("sha256")
    .update(JSON.stringify({ message, conversationId: requestedConversationId }))
    .digest("hex");

  const prisma = getPrisma();
  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: {
      id: true,
      name: true,
      basePrompt: true,
      modelConfig: true,
      memoryScopes: {
        select: {
          id: true,
          scopeType: true,
          userId: true,
          externalIdentityId: true,
          externalIdentity: { select: { status: true, linkedUserId: true } },
        },
      },
    },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  // A stable client requestKey prevents duplicate model calls and duplicate conversation creation on retries.
  const staleBefore = new Date(Date.now() - 10 * 60 * 1000);
  let chatRequest = await prisma.chatRequest.findUnique({
    where: { ownerId_characterId_requestKey: { ownerId, characterId, requestKey } },
  });
  if (chatRequest && chatRequest.requestHash !== requestHash) {
    throw createError({ statusCode: 409, statusMessage: "该请求标识已用于不同的消息内容，请重新发送以生成新的请求标识。" });
  }
  if (chatRequest?.status === "COMPLETED" && chatRequest.response) {
    setResponseStatus(event, 200);
    return chatRequest.response;
  }
  if (chatRequest) {
    const claimed = await prisma.chatRequest.updateMany({
      where: {
        id: chatRequest.id,
        OR: [
          { status: "FAILED" },
          { status: "PROCESSING", updatedAt: { lt: staleBefore } },
        ],
      },
      data: { status: "PROCESSING", claimToken: randomUUID(), lastError: null, response: undefined, conversationId: null },
    });
    if (claimed.count !== 1) {
      throw createError({ statusCode: 409, statusMessage: "相同聊天请求正在处理中，请稍后刷新会话，避免重复发送。" });
    }
    chatRequest = await prisma.chatRequest.findUniqueOrThrow({ where: { id: chatRequest.id } });
  } else {
    try {
      chatRequest = await prisma.chatRequest.create({
        data: { ownerId, characterId, requestKey, requestHash, claimToken: randomUUID(), status: "PROCESSING" },
      });
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
        const concurrentRequest = await prisma.chatRequest.findUnique({
          where: { ownerId_characterId_requestKey: { ownerId, characterId, requestKey } },
        });
        if (concurrentRequest && concurrentRequest.requestHash !== requestHash) {
          throw createError({ statusCode: 409, statusMessage: "该请求标识已用于不同的消息内容，请重新发送以生成新的请求标识。" });
        }
        if (concurrentRequest?.status === "COMPLETED" && concurrentRequest.response) {
          setResponseStatus(event, 200);
          return concurrentRequest.response;
        }
        throw createError({ statusCode: 409, statusMessage: "相同聊天请求正在处理中，请稍后刷新会话，避免重复发送。" });
      }
      throw error;
    }
  }

  try {

  // Only character-global scopes and the acting user's own verified private scopes may be read.
  const accessibleScopes = resolveChatMemoryScopes(character.memoryScopes, ownerId);
  const globalScope = accessibleScopes.find((scope) => scope.origin === "character");
  if (!globalScope) throw createError({ statusCode: 409, statusMessage: "该角色尚未建立全局记忆范围，请重新保存角色档案。" });
  const memoryScopeId = globalScope.id;
  const readableScopeIds = accessibleScopes.map((scope) => scope.id);
  const scopeOriginById = new Map(accessibleScopes.map((scope) => [scope.id, scope.origin]));
  const privateScopeActive = accessibleScopes.some((scope) => scope.origin === "private");
  const chatSettings = resolveChatModelSettings(character.modelConfig);
  let apiKey = "";
  try {
    apiKey = await resolveCharacterApiKey(character.modelConfig, chatSettings.apiBaseUrl);
  } catch {
    throw createError({ statusCode: 503, statusMessage: "当前角色保存的 API Key 无法解密，请重新打开模型参数并填写 API Key。" });
  }
  if (!apiKey || !chatSettings.model) {
    throw createError({ statusCode: 503, statusMessage: "尚未配置模型 API。请在当前角色的「AI 对话 → 模型参数」中填写 API Key 和模型名称。" });
  }

  const existingConversation = requestedConversationId
    ? await prisma.conversation.findFirst({
        where: { id: requestedConversationId, characterId, memoryScopeId, status: "ACTIVE" },
        select: { id: true, title: true },
      })
    : null;
  if (requestedConversationId && !existingConversation) {
    throw createError({ statusCode: 404, statusMessage: "会话不存在或不属于当前角色。" });
  }

  const recentStoredMessages = existingConversation
    ? await prisma.message.findMany({
        where: { conversationId: existingConversation.id },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: 20,
        select: { role: true, content: true, occurredAt: true },
      })
    : [];
  const recentMessages: ConversationContextMessage[] = recentStoredMessages
    .reverse()
    .filter((item) => item.role === "USER" || item.role === "ASSISTANT")
    .map((item) => ({
      role: item.role as "USER" | "ASSISTANT",
      content: item.content.slice(0, 1800),
      occurredAt: item.occurredAt.toISOString(),
    }));

  const memoryCandidates = await prisma.memoryItem.findMany({
    where: { memoryScopeId: { in: readableScopeIds }, status: "ACTIVE", deletedAt: null },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: 300,
    select: { id: true, category: true, content: true, confidence: true, updatedAt: true, createdAt: true, memoryScopeId: true },
  });
  const retrievalQuery = [
    message,
    ...recentMessages.filter((item) => item.role === "USER").slice(-2).map((item) => item.content),
  ].join("\n");
  const memories = rankMemoryCandidates(retrievalQuery, memoryCandidates, 8).map((memory) => ({
    id: memory.id,
    category: memory.category,
    content: memory.content.slice(0, 1200),
    confidence: memory.confidence,
    relevanceScore: memory.relevanceScore,
    scope: scopeOriginById.get(memory.memoryScopeId) ?? "character",
  }));

  const snapshotCandidates = await prisma.memorySnapshot.findMany({
    where: { memoryScopeId: { in: readableScopeIds }, status: "CURRENT" },
    orderBy: [{ createdAt: "desc" }, { version: "desc" }],
    take: 80,
    select: { id: true, summary: true, periodStart: true, periodEnd: true, version: true, createdAt: true, memoryScopeId: true },
  });
  const snapshots = rankSnapshotCandidates(retrievalQuery, snapshotCandidates, 4).map((snapshot) => ({
    id: snapshot.id,
    summary: snapshot.summary.slice(0, 3000),
    periodStart: snapshot.periodStart.toISOString(),
    periodEnd: snapshot.periodEnd.toISOString(),
    version: snapshot.version,
    relevanceScore: snapshot.relevanceScore,
    scope: scopeOriginById.get(snapshot.memoryScopeId) ?? "character",
  }));

  let generated;
  try {
    generated = await generateConversationReply({
      characterName: character.name,
      characterPrompt: character.basePrompt.slice(0, 12_000),
      model: chatSettings.model,
      apiKey,
      apiBaseUrl: chatSettings.apiBaseUrl,
      temperature: chatSettings.temperature,
      maxTokens: chatSettings.maxTokens,
      currentMessage: message,
      recentMessages,
      memories,
      snapshots,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "模型调用失败。";
    throw createError({
      statusCode: detail.startsWith("LLM_NOT_CONFIGURED") ? 503 : 502,
      statusMessage: detail.slice(0, 700),
    });
  }

  const usedMemoryIds = new Set(generated.usedMemoryIds);
  const usedSnapshotIds = new Set(generated.usedSnapshotIds);
  const usedSources = {
    memories: memories.filter((memory) => usedMemoryIds.has(memory.id))
      .map(({ id, category, content, scope }) => ({ id, category, content, scope })),
    snapshots: snapshots.filter((snapshot) => usedSnapshotIds.has(snapshot.id))
      .map(({ id, summary, periodStart, periodEnd, version, scope }) => ({ id, summary, periodStart, periodEnd, version, scope })),
  };

  const now = new Date();
  const assistantAt = new Date(now.getTime() + 1);
  const proposedTitle = message.slice(0, 80);
  const title = existingConversation?.title || proposedTitle;
  const response = await prisma.$transaction(async (tx) => {
    const conversation = existingConversation ?? await tx.conversation.create({
      data: { characterId, memoryScopeId, title, status: "ACTIVE", metadata: { createdFrom: "yiling-chat-ui" } },
      select: { id: true, title: true },
    });
    const userMessage = await tx.message.create({
      data: {
        conversationId: conversation.id,
        role: "USER",
        content: message,
        occurredAt: now,
        metadata: { source: "yiling-chat-ui" },
      },
      select: { id: true, role: true, content: true, occurredAt: true },
    });
    const assistantMessage = await tx.message.create({
      data: {
        conversationId: conversation.id,
        role: "ASSISTANT",
        content: generated.reply,
        occurredAt: assistantAt,
        metadata: {
          generatedBy: "llm",
          model: generated.model,
          provider: generated.provider,
          promptTemplateVersion: generated.promptTemplateVersion,
          usedMemoryIds: generated.usedMemoryIds,
          usedSnapshotIds: generated.usedSnapshotIds,
          usedSources,
          usage: generated.usage ?? {},
        },
      },
      select: { id: true, role: true, content: true, occurredAt: true },
    });
    await tx.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: assistantAt } });

    const saved = {
      conversationId: conversation.id,
      title: conversation.title || title,
      userMessage,
      assistantMessage,
    };
    const result = {
      ...saved,
      userMessage: { ...saved.userMessage, sources: { memories: [], snapshots: [] } },
      assistantMessage: { ...saved.assistantMessage, sources: usedSources },
      model: { name: generated.model, provider: generated.provider, promptTemplateVersion: generated.promptTemplateVersion },
      retrieval: { memoriesAvailable: memories.length, snapshotsAvailable: snapshots.length, privateScopeActive },
    };
    // Commit messages and the replayable response atomically. A database failure must not
    // leave saved messages behind while the request is marked FAILED and retried.
    const finalized = await tx.chatRequest.updateMany({
      where: { id: chatRequest.id, status: "PROCESSING", claimToken: chatRequest.claimToken },
      data: { status: "COMPLETED", conversationId: saved.conversationId, response: result, lastError: null },
    });
    if (finalized.count !== 1) {
      // The lease was reclaimed while this model call was running. Throwing rolls back
      // this transaction, so the stale claimant cannot append duplicate messages.
      throw createError({ statusCode: 409, statusMessage: "聊天请求已被新的重试接管，请刷新会话后查看结果。" });
    }
    return result;
  });
  setResponseStatus(event, 201);
  return response;
  } catch (error) {
    const statusMessage = error instanceof Error ? error.message : "聊天请求失败。";
    try {
      await prisma.chatRequest.updateMany({
        where: { id: chatRequest.id, status: "PROCESSING", claimToken: chatRequest.claimToken },
        data: { status: "FAILED", lastError: statusMessage.slice(0, 700) },
      });
    } catch {
      // Preserve the original error; a stale PROCESSING request can be reclaimed after the lease expires.
    }
    throw error;
  }
});
