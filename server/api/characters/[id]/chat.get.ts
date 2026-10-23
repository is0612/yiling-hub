import { createError, getQuery, getRouterParam } from "h3";
import { resolveChatModelSettings } from "../../../utils/chat-model-config";
import { requireLocalDevOwner, requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";

type StoredSources = {
  memories: Array<{ id: string; category: string; content: string }>;
  snapshots: Array<{ id: string; summary: string; periodStart: string; periodEnd: string; version: number }>;
};

function readStoredSources(metadata: unknown): StoredSources {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return { memories: [], snapshots: [] };
  const root = metadata as Record<string, unknown>;
  const raw = root.usedSources;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { memories: [], snapshots: [] };
  const sourceRoot = raw as Record<string, unknown>;
  const memories = Array.isArray(sourceRoot.memories)
    ? sourceRoot.memories.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const record = item as Record<string, unknown>;
        if (typeof record.id !== "string" || typeof record.content !== "string") return [];
        return [{ id: record.id, category: typeof record.category === "string" ? record.category : "OTHER", content: record.content }];
      }).slice(0, 12)
    : [];
  const snapshots = Array.isArray(sourceRoot.snapshots)
    ? sourceRoot.snapshots.flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const record = item as Record<string, unknown>;
        if (typeof record.id !== "string" || typeof record.summary !== "string" ||
          typeof record.periodStart !== "string" || typeof record.periodEnd !== "string" || typeof record.version !== "number") return [];
        return [{ id: record.id, summary: record.summary, periodStart: record.periodStart, periodEnd: record.periodEnd, version: record.version }];
      }).slice(0, 12)
    : [];
  return { memories, snapshots };
}

export default defineEventHandler(async (event) => {
  const ownerId = requireLocalDevOwner(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const query = getQuery(event);
  const requestedConversationId = query.conversationId;
  if (requestedConversationId !== undefined && typeof requestedConversationId !== "string") {
    throw createError({ statusCode: 400, statusMessage: "conversationId 参数无效。" });
  }
  const conversationId = typeof requestedConversationId === "string" && requestedConversationId
    ? requireUuid(requestedConversationId, "会话")
    : null;

  const requestedStatus = query.status;
  if (requestedStatus !== undefined && requestedStatus !== "ACTIVE" && requestedStatus !== "ARCHIVED") {
    throw createError({ statusCode: 400, statusMessage: "status 只支持 ACTIVE 或 ARCHIVED。" });
  }
  const conversationStatus: "ACTIVE" | "ARCHIVED" = requestedStatus === "ARCHIVED" ? "ARCHIVED" : "ACTIVE";
  const rawSearchTerm = query.q;
  if (rawSearchTerm !== undefined && typeof rawSearchTerm !== "string") {
    throw createError({ statusCode: 400, statusMessage: "q 参数无效。" });
  }
  const searchTerm = typeof rawSearchTerm === "string" ? rawSearchTerm.trim() : "";
  if (searchTerm.length > 120) {
    throw createError({ statusCode: 400, statusMessage: "会话搜索词不能超过 120 个字符。" });
  }

  const prisma = getPrisma();

  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true, name: true, modelConfig: true, memoryScopes: { where: { scopeType: "CHARACTER_GLOBAL" }, select: { id: true }, take: 1 } },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  const memoryScopeId = character.memoryScopes[0]?.id;
  if (!memoryScopeId) throw createError({ statusCode: 409, statusMessage: "该角色尚未建立全局记忆范围，请重新保存角色档案。" });

  const conversationWhere = {
    characterId,
    memoryScopeId,
    status: conversationStatus,
    ...(searchTerm ? {
      OR: [
        { title: { contains: searchTerm, mode: "insensitive" as const } },
        { messages: { some: { content: { contains: searchTerm, mode: "insensitive" as const } } } },
      ],
    } : {}),
  };
  const conversations = await prisma.conversation.findMany({
    where: conversationWhere,
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: 50,
    select: { id: true, title: true, lastMessageAt: true, updatedAt: true, _count: { select: { messages: true } } },
  });
  const selectedConversation = conversationId
    ? await prisma.conversation.findFirst({
        where: { id: conversationId, characterId, memoryScopeId, status: conversationStatus },
        select: { id: true, title: true, lastMessageAt: true, updatedAt: true, _count: { select: { messages: true } } },
      })
    : conversations[0] ?? null;

  if (conversationId && !selectedConversation) throw createError({ statusCode: 404, statusMessage: "会话不存在或不属于当前角色。" });
  if (selectedConversation && !conversations.some((conversation) => conversation.id === selectedConversation.id)) {
    conversations.unshift(selectedConversation);
    conversations.splice(20);
  }

  let messages: Array<{ id: string; role: string; content: string; occurredAt: Date; metadata: unknown }> = [];
  if (selectedConversation) {
    const descending = await prisma.message.findMany({
      where: { conversationId: selectedConversation.id },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: 80,
      select: { id: true, role: true, content: true, occurredAt: true, metadata: true },
    });
    messages = descending.reverse();
  }

  const chatSettings = resolveChatModelSettings(character.modelConfig);
  return {
    character: {
      id: character.id,
      name: character.name,
      chatModel: chatSettings.model,
      chatTemperature: chatSettings.temperature,
      chatMaxTokens: chatSettings.maxTokens,
      chatApiBaseUrl: chatSettings.apiBaseUrl,
      chatApiKeyConfigured: chatSettings.apiKeyConfigured,
      chatApiKeySource: chatSettings.apiKeySource,
    },
    modelConfigured: Boolean(chatSettings.apiKeyConfigured && chatSettings.model),
    conversations: conversations.map((conversation) => ({
      id: conversation.id,
      title: conversation.title || "未命名对话",
      lastMessageAt: conversation.lastMessageAt,
      updatedAt: conversation.updatedAt,
      messageCount: conversation._count.messages,
    })),
    selectedConversationId: selectedConversation?.id ?? null,
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      occurredAt: message.occurredAt,
      sources: message.role === "ASSISTANT" ? readStoredSources(message.metadata) : { memories: [], snapshots: [] },
    })),
  };
});
