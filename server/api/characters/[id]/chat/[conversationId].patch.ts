import { createError, getRouterParam, readBody } from "h3";
import { requireLocalDevOwner, requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = requireLocalDevOwner(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const conversationId = requireUuid(getRouterParam(event, "conversationId") ?? "", "会话");
  const body = await readBody<Record<string, unknown>>(event);
  const requestedStatus = body?.status;
  if (requestedStatus !== "ACTIVE" && requestedStatus !== "ARCHIVED") {
    throw createError({ statusCode: 400, statusMessage: "status 只支持 ACTIVE 或 ARCHIVED。" });
  }

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
    select: { id: true, status: true, updatedAt: true },
  });
  if (!conversation) throw createError({ statusCode: 404, statusMessage: "会话不存在或不属于当前角色。" });
  if (conversation.status === requestedStatus) {
    return { id: conversation.id, status: conversation.status, updatedAt: conversation.updatedAt };
  }

  const updated = await prisma.$transaction(async (tx) => {
    const saved = await tx.conversation.update({
      where: { id: conversation.id },
      data: { status: requestedStatus },
      select: { id: true, status: true, updatedAt: true },
    });
    await tx.auditLog.create({
      data: {
        actorType: "USER",
        actorId: ownerId,
        characterId,
        action: requestedStatus === "ARCHIVED" ? "CONVERSATION_ARCHIVED" : "CONVERSATION_RESTORED",
        entityType: "Conversation",
        entityId: conversation.id,
        details: { from: conversation.status, to: requestedStatus },
      },
    });
    return saved;
  });

  return updated;
});
