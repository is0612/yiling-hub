import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { localDayKey } from "../../../../utils/memory-event-time";

/**
 * 角色「有忆泡的日子」列表。
 *
 * 数据源是 `memory_event_days`（一天一行，带整理进度），不是从忆泡反推的 ——
 * 这样「今天还没整理」的日子也能出现在列表里，而不是凭空消失。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();

  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true, memorySetting: { select: { timezone: true } } },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const timeZone = character.memorySetting?.timezone || "Asia/Shanghai";
  const today = localDayKey(new Date(), timeZone);
  const days = await prisma.memoryEventDay.findMany({
    where: { memoryScope: { is: { characterId } } },
    orderBy: { dayKey: "desc" },
    take: 90,
    select: { dayKey: true, state: true, eventCount: true, extractedAt: true },
  });

  const rows = days.map((day) => ({
    dayKey: day.dayKey,
    state: day.state as "DRAFT" | "FINAL",
    eventCount: day.eventCount,
    extractedAt: day.extractedAt?.toISOString() ?? null,
  }));
  // 今天还没整理过时也补一行：否则「今天」会从列表里整个消失，用户以为页面坏了。
  if (!rows.some((row) => row.dayKey === today)) {
    rows.unshift({ dayKey: today, state: "DRAFT", eventCount: 0, extractedAt: null });
  }

  return { today, days: rows };
});
