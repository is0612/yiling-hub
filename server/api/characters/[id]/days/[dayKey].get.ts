import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { resolveDayWindow } from "../../../../utils/memory-event-time";

/**
 * 某一天的忆泡 + 当天原文。
 *
 * 两部分一起给：忆泡是整理过的「那天发生了什么」，原文是「当时到底怎么说的」。
 * 页面上默认看忆泡，需要时再展开原文 —— 两者都受同一套范围隔离约束。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const dayKey = String(getRouterParam(event, "dayKey") ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
    throw createError({ statusCode: 400, statusMessage: "日期格式应为 YYYY-MM-DD。" });
  }

  const prisma = getPrisma();
  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: { id: true, memorySetting: { select: { timezone: true } } },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const timeZone = character.memorySetting?.timezone || "Asia/Shanghai";
  const day = await prisma.memoryEventDay.findFirst({
    where: { dayKey, memoryScope: { is: { characterId } } },
    select: { id: true, dayKey: true, state: true, eventCount: true, extractedAt: true },
  });

  const events = await prisma.memoryEvent.findMany({
    where: { dayKey, memoryScope: { is: { characterId } } },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    take: 100,
    select: {
      id: true,
      occurredAt: true,
      timeOfDay: true,
      place: true,
      participants: true,
      title: true,
      detail: true,
      state: true,
      status: true,
      confidence: true,
      memoryScope: { select: { scopeType: true } },
    },
  });

  const window = resolveDayWindow(dayKey, timeZone);
  const messages = await prisma.message.findMany({
    where: {
      conversation: { is: { characterId } },
      occurredAt: { gte: window.start, lt: window.end },
    },
    orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
    take: 300,
    select: { id: true, role: true, content: true, occurredAt: true },
  });

  return {
    day: day
      ? {
        dayKey: day.dayKey,
        state: day.state,
        eventCount: day.eventCount,
        extractedAt: day.extractedAt?.toISOString() ?? null,
      }
      : { dayKey, state: null, eventCount: 0, extractedAt: null },
    events: events.map((entry) => ({
      id: entry.id,
      occurredAt: entry.occurredAt.toISOString(),
      timeOfDay: entry.timeOfDay,
      place: entry.place,
      participants: entry.participants,
      title: entry.title,
      detail: entry.detail,
      state: entry.state,
      status: entry.status,
      confidence: entry.confidence,
      scope: entry.memoryScope.scopeType === "USER_PRIVATE" ? "private" : "character",
    })),
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content.slice(0, 500),
      occurredAt: message.occurredAt.toISOString(),
    })),
  };
});
