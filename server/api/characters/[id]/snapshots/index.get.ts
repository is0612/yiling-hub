import { createError, getRouterParam } from "h3";
import { requireLocalDevOwner, requireUuid } from "~/server/utils/local-api";
import { getPrisma } from "~/server/utils/prisma";
import { toMemorySnapshotDtos } from "~/server/utils/memory-snapshot-dto";

export default defineEventHandler(async (event) => {
  const ownerId = requireLocalDevOwner(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();

  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: {
      id: true,
      memorySetting: { select: { timezone: true } },
      memoryScopes: {
        where: { scopeType: "CHARACTER_GLOBAL" },
        select: {
          snapshots: {
            orderBy: [{ createdAt: "desc" }, { version: "desc" }],
            include: { sources: { select: { sourceType: true } } },
          },
        },
      },
    },
  });

  if (!character) {
    throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  }

  const snapshots = character.memoryScopes.flatMap((scope) => scope.snapshots);
  return toMemorySnapshotDtos(snapshots, character.memorySetting?.timezone || "Asia/Shanghai");
});
