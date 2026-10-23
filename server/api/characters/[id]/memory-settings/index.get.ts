import { createError } from "h3";
import { requireLocalDevOwner, requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = requireLocalDevOwner(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "");
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true },
  });

  if (!character) {
    throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  }

  const settings = await prisma.characterMemorySetting.upsert({
    where: { characterId },
    create: {
      characterId,
      snapshotIntervalDays: 8,
      timezone: "Asia/Shanghai",
      anchorAt: new Date(),
      autoSnapshotEnabled: false,
      rawMessageRetentionDays: 90,
    },
    update: {},
  });

  return {
    snapshotIntervalDays: settings.snapshotIntervalDays,
    timezone: settings.timezone,
    anchorAt: settings.anchorAt.toISOString().slice(0, 19),
    rawMessageRetentionDays: settings.rawMessageRetentionDays ?? 0,
    autoSnapshotEnabled: settings.autoSnapshotEnabled,
    changePolicy: settings.changePolicy,
    nextSnapshotAt: settings.nextSnapshotAt?.toISOString() ?? null,
    updatedAt: settings.updatedAt.toISOString(),
  };
});
