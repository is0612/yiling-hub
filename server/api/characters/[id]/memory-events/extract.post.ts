import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import {
  localDayHour, resolveDailyEventWindow, resolveDayWindow,
} from "../../../../utils/memory-event-time";
import { processNextMemoryJob } from "../../../../utils/memory-worker";

/**
 * 立即整理忆泡（手动触发）。
 *
 * 调度器每小时才跑一次增量、夜里才收口；用户点这个按钮时不该等。
 * 这里做两件事：① 把「昨天（收口）」和「今天（增量）」两段写进队列；
 * ② 当场把刚排的任务跑掉，不用另开 worker 进程。
 *
 * 为什么要走队列而不是直接调抽取函数：任务表本来就是唯一的执行入口，
 * 手动触发和定时触发必须共用同一套幂等键（`events-final:` / `events-hour:`），
 * 否则同一天会被整理两遍。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const prisma = getPrisma();

  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: {
      id: true,
      memorySetting: { select: { timezone: true } },
      memoryScopes: { where: { scopeType: "CHARACTER_GLOBAL" }, select: { id: true } },
    },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const scopeId = character.memoryScopes[0]?.id;
  if (!scopeId) throw createError({ statusCode: 409, statusMessage: "角色还没有记忆范围，先完成初始化。" });

  const now = new Date();
  const timeZone = character.memorySetting?.timezone || "Asia/Shanghai";
  const { dayKey: todayKey, hour } = localDayHour(now, timeZone);
  const todayWindow = resolveDayWindow(todayKey, timeZone);
  const yesterday = resolveDailyEventWindow(now, timeZone);

  const windows = [
    { key: `events-final:${scopeId}:${yesterday.dayKey}`, start: yesterday.start, end: yesterday.end, label: "昨天收口" },
    { key: `events-hour:${scopeId}:${todayKey}:${hour}`, start: todayWindow.start, end: todayWindow.end, label: "今天增量" },
  ];

  const queued: string[] = [];
  for (const window of windows) {
    const hasMessages = await prisma.message.findFirst({
      where: {
        conversation: { is: { memoryScopeId: scopeId } },
        occurredAt: { gte: window.start, lt: window.end },
      },
      select: { id: true },
    });
    if (!hasMessages) continue;
    const created = await prisma.memoryJob.createMany({
      data: [{
        memoryScopeId: scopeId,
        type: "EXTRACT_EVENTS" as const,
        idempotencyKey: window.key,
        periodStart: window.start,
        periodEnd: window.end,
        status: "QUEUED" as const,
        runAt: now,
      }],
      skipDuplicates: true,
    });
    if (created.count > 0) queued.push(window.label);
  }

  // 当场执行刚排的任务（最多两段：昨天收口 + 今天增量）。
  // 如果另有 worker 在跑，它可能先领走 —— 那时这里返回「已排队」也算正常。
  const processed: Array<{ status: string; message: string }> = [];
  for (let index = 0; index < 2; index += 1) {
    const result = await processNextMemoryJob(prisma, { ownerId });
    if (!result.processed) break;
    processed.push({ status: result.status, message: result.message });
  }

  return {
    queued,
    processed,
    windows: windows.map((window) => ({ label: window.label, start: window.start.toISOString(), end: window.end.toISOString() })),
  };
});
