import { createError, readBody } from "h3";
import { requireLocalDevOwner, requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";

const allowedRetentionDays = new Set([0, 30, 90, 180]);

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export default defineEventHandler(async (event) => {
  const ownerId = requireLocalDevOwner(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "");
  const body = await readBody<Record<string, unknown>>(event);
  const prisma = getPrisma();
  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true },
  });

  if (!character) {
    throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  }

  const interval = Number(body.snapshotIntervalDays);
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) {
    throw createError({ statusCode: 400, statusMessage: "快照周期必须为 1–365 天的整数。" });
  }

  if (typeof body.timezone !== "string" || body.timezone.length > 100) {
    throw createError({ statusCode: 400, statusMessage: "请选择有效的时区。" });
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: body.timezone });
  } catch {
    throw createError({ statusCode: 400, statusMessage: "不支持该时区。" });
  }

  if (typeof body.autoSnapshotEnabled !== "boolean") {
    throw createError({ statusCode: 400, statusMessage: "自动归档开关无效。" });
  }

  if (body.changePolicy !== "NEXT_CYCLE" && body.changePolicy !== "IMMEDIATE_RECALC") {
    throw createError({ statusCode: 400, statusMessage: "无效的设置生效策略。" });
  }
  const changePolicy = body.changePolicy as "NEXT_CYCLE" | "IMMEDIATE_RECALC";

  const rawRetention = Number(body.rawMessageRetentionDays);
  if (!Number.isInteger(rawRetention) || !allowedRetentionDays.has(rawRetention)) {
    throw createError({ statusCode: 400, statusMessage: "原始消息保留期限只能选择永久、30、90 或 180 天。" });
  }

  const rawAnchor = typeof body.anchorAt === "string" ? new Date(body.anchorAt) : new Date(Number.NaN);
  if (Number.isNaN(rawAnchor.getTime())) {
    throw createError({ statusCode: 400, statusMessage: "周期启用锚点无效。" });
  }

  let nextSnapshotAt: Date | null = null;
  if (body.autoSnapshotEnabled) {
    // Preserve the first cycle boundary. The scheduler uses it to backfill
    // missed cycles after downtime instead of silently jumping to the future.
    nextSnapshotAt = addDays(rawAnchor, interval);
  }

  const settings = await prisma.characterMemorySetting.upsert({
    where: { characterId },
    create: {
      characterId,
      snapshotIntervalDays: interval,
      timezone: body.timezone,
      anchorAt: rawAnchor,
      nextSnapshotAt,
      autoSnapshotEnabled: body.autoSnapshotEnabled,
      changePolicy,
      rawMessageRetentionDays: rawRetention === 0 ? null : rawRetention,
    },
    update: {
      snapshotIntervalDays: interval,
      timezone: body.timezone,
      anchorAt: rawAnchor,
      nextSnapshotAt,
      autoSnapshotEnabled: body.autoSnapshotEnabled,
      changePolicy,
      rawMessageRetentionDays: rawRetention === 0 ? null : rawRetention,
    },
  });

  return {
    snapshotIntervalDays: settings.snapshotIntervalDays,
    timezone: settings.timezone,
    anchorAt: settings.anchorAt.toISOString(),
    rawMessageRetentionDays: settings.rawMessageRetentionDays ?? 0,
    autoSnapshotEnabled: settings.autoSnapshotEnabled,
    changePolicy: settings.changePolicy,
    nextSnapshotAt: settings.nextSnapshotAt?.toISOString() ?? null,
    updatedAt: settings.updatedAt.toISOString(),
  };
});
