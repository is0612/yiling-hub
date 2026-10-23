import { createError, getQuery, getRouterParam } from "h3";
import { requireLocalDevOwner, requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";

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

function readPageNumber(value: unknown, fallback: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw createError({ statusCode: 400, statusMessage: `${label} 参数无效。` });
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw createError({ statusCode: 400, statusMessage: `${label} 必须在 1 到 ${maximum} 之间。` });
  }
  return number;
}

export default defineEventHandler(async (event) => {
  const ownerId = requireLocalDevOwner(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const conversationId = requireUuid(getRouterParam(event, "conversationId") ?? "", "会话");
  const query = getQuery(event);
  const page = readPageNumber(query.page, 1, 100_000, "page");
  const pageSize = readPageNumber(query.pageSize, 200, 500, "pageSize");
  const prisma = getPrisma();

  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: {
      id: true,
      memoryScopes: { where: { scopeType: "CHARACTER_GLOBAL" }, select: { id: true }, take: 1 },
    },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  const memoryScopeId = character.memoryScopes[0]?.id;
  if (!memoryScopeId) throw createError({ statusCode: 409, statusMessage: "该角色尚未建立全局记忆范围。" });

  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, characterId, memoryScopeId },
    select: { id: true, title: true, status: true },
  });
  if (!conversation) throw createError({ statusCode: 404, statusMessage: "会话不存在或不属于当前角色。" });

  const where = { conversationId: conversation.id };
  const [total, records] = await Promise.all([
    prisma.message.count({ where }),
    prisma.message.findMany({
      where,
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: { id: true, role: true, content: true, occurredAt: true, metadata: true },
    }),
  ]);

  return {
    conversationId: conversation.id,
    title: conversation.title || "未命名对话",
    status: conversation.status,
    page,
    pageSize,
    total,
    messages: records.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      occurredAt: message.occurredAt,
      sources: message.role === "ASSISTANT" ? readStoredSources(message.metadata) : { memories: [], snapshots: [] },
    })),
  };
});
