import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../utils/auth";
import { requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";
import { toMemoryTimelineDtos } from "../../../utils/memory-timeline-dto";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();

  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true, memorySetting: { select: { timezone: true } } },
  });

  if (!character) {
    throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  }

  const [messages, memoryItems, snapshots] = await Promise.all([
    prisma.message.findMany({
      where: { conversation: { is: { characterId } } },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: 250,
      select: {
        id: true,
        role: true,
        eventType: true,
        content: true,
        occurredAt: true,
        externalMessageId: true,
        conversation: {
          select: {
            id: true,
            title: true,
            channelBinding: {
              select: { connection: { select: { displayName: true } } },
            },
          },
        },
      },
    }),
    prisma.memoryItem.findMany({
      where: { status: { not: "TRASHED" }, memoryScope: { is: { characterId } } },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 250,
      select: {
        id: true,
        category: true,
        content: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        memoryScope: { select: { scopeType: true } },
      },
    }),
    prisma.memorySnapshot.findMany({
      where: { memoryScope: { is: { characterId } } },
      orderBy: [{ createdAt: "desc" }, { version: "desc" }],
      take: 100,
      include: { sources: { select: { sourceType: true } } },
    }),
  ]);

  return toMemoryTimelineDtos(
    { messages, memoryItems, snapshots },
    character.memorySetting?.timezone || "Asia/Shanghai",
  );
});
