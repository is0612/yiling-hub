import { createError, getRouterParam, readBody } from "h3";
import { generateConversationReply, type ConversationContextMessage } from "../../../utils/chat-reply";
import { isMemoryModelConfigured } from "../../../utils/memory-ai";
import { rankMemoryCandidates, rankSnapshotCandidates } from "../../../utils/memory-retrieval";
import { readTrimmedString, requireLocalDevOwner, requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = requireLocalDevOwner(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const body = await readBody<Record<string, unknown>>(event);
  const message = readTrimmedString(body?.message, "消息", 8000, { required: true });
  const rawConversationId = body?.conversationId;
  if (rawConversationId !== undefined && typeof rawConversationId !== "string") {
    throw createError({ statusCode: 400, statusMessage: "conversationId 格式无效。" });
  }
  const requestedConversationId = typeof rawConversationId === "string" && rawConversationId
    ? requireUuid(rawConversationId, "会话")
    : null;

  const prisma = getPrisma();
  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: {
      id: true,
      name: true,
      basePrompt: true,
      memoryScopes: { where: { scopeType: "CHARACTER_GLOBAL" }, select: { id: true }, take: 1 },
    },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  const memoryScopeId = character.memoryScopes[0]?.id;
  if (!memoryScopeId) throw createError({ statusCode: 409, statusMessage: "该角色尚未建立全局记忆范围，请重新保存角色档案。" });
  if (!isMemoryModelConfigured()) {
    throw createError({ statusCode: 503, statusMessage: "尚未配置 AI 模型。请先在服务端 .env 填写 LLM_API_KEY 和 LLM_MODEL。" });
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
    where: { memoryScopeId, status: "ACTIVE", deletedAt: null },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: 250,
    select: { id: true, category: true, content: true, confidence: true, updatedAt: true, createdAt: true },
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
  }));

  const snapshotCandidates = await prisma.memorySnapshot.findMany({
    where: { memoryScopeId, status: "CURRENT" },
    orderBy: [{ createdAt: "desc" }, { version: "desc" }],
    take: 80,
    select: { id: true, summary: true, periodStart: true, periodEnd: true, version: true, createdAt: true },
  });
  const snapshots = rankSnapshotCandidates(retrievalQuery, snapshotCandidates, 4).map((snapshot) => ({
    id: snapshot.id,
    summary: snapshot.summary.slice(0, 3000),
    periodStart: snapshot.periodStart.toISOString(),
    periodEnd: snapshot.periodEnd.toISOString(),
    version: snapshot.version,
    relevanceScore: snapshot.relevanceScore,
  }));

  let generated;
  try {
    generated = await generateConversationReply({
      characterName: character.name,
      characterPrompt: character.basePrompt.slice(0, 12_000),
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
      .map(({ id, category, content }) => ({ id, category, content })),
    snapshots: snapshots.filter((snapshot) => usedSnapshotIds.has(snapshot.id))
      .map(({ id, summary, periodStart, periodEnd, version }) => ({ id, summary, periodStart, periodEnd, version })),
  };

  const now = new Date();
  const assistantAt = new Date(now.getTime() + 1);
  const proposedTitle = message.slice(0, 80);
  const title = existingConversation?.title || proposedTitle;
  const saved = await prisma.$transaction(async (tx) => {
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
    return { conversationId: conversation.id, title: conversation.title || title, userMessage, assistantMessage };
  });

  setResponseStatus(event, 201);
  return {
    ...saved,
    userMessage: { ...saved.userMessage, sources: { memories: [], snapshots: [] } },
    assistantMessage: { ...saved.assistantMessage, sources: usedSources },
    model: { name: generated.model, provider: generated.provider, promptTemplateVersion: generated.promptTemplateVersion },
    retrieval: { memoriesAvailable: memories.length, snapshotsAvailable: snapshots.length },
  };
});
