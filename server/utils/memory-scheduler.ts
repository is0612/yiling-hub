import type { PrismaClient } from "../../src/generated/prisma/client";
import { localDayHour, resolveDailyEventWindow, resolveDayWindow } from "./memory-event-time";
import { listFriendScopesWithActivity } from "./friends";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_PERIODS_PER_SETTING = 24;

export type DueMemoryPeriod = {
  periodStart: Date;
  periodEnd: Date;
  idempotencyKey: string;
};

export function buildDueMemoryPeriods(input: {
  memoryScopeId: string;
  nextSnapshotAt: Date | null;
  intervalDays: number;
  now: Date;
  pendingIntervalDays?: number | null;
  maxPeriods?: number;
}): { periods: DueMemoryPeriod[]; nextSnapshotAt: Date | null; stillDue: boolean } {
  const { memoryScopeId, nextSnapshotAt, intervalDays, now } = input;
  const pendingIntervalDays = input.pendingIntervalDays ?? null;
  const maxPeriods = input.maxPeriods ?? DEFAULT_MAX_PERIODS_PER_SETTING;
  if (
    !nextSnapshotAt ||
    !Number.isFinite(nextSnapshotAt.getTime()) ||
    !Number.isFinite(now.getTime()) ||
    !Number.isInteger(intervalDays) ||
    intervalDays < 1 ||
    intervalDays > 365 ||
    (pendingIntervalDays !== null && (!Number.isInteger(pendingIntervalDays) || pendingIntervalDays < 1 || pendingIntervalDays > 365)) ||
    !Number.isInteger(maxPeriods) ||
    maxPeriods < 1 ||
    nextSnapshotAt.getTime() > now.getTime()
  ) {
    return { periods: [], nextSnapshotAt, stillDue: false };
  }

  const periods: DueMemoryPeriod[] = [];
  let periodEnd = new Date(nextSnapshotAt);
  let intervalForCurrentPeriod = intervalDays;
  let pendingIntervalAppliesAfterCurrentPeriod = pendingIntervalDays !== null;

  while (periodEnd.getTime() <= now.getTime() && periods.length < maxPeriods) {
    const intervalMs = intervalForCurrentPeriod * DAY_MS;
    const periodStart = new Date(periodEnd.getTime() - intervalMs);
    periods.push({
      periodStart,
      periodEnd: new Date(periodEnd),
      idempotencyKey: `auto-snapshot:${memoryScopeId}:${periodStart.toISOString()}:${periodEnd.toISOString()}`,
    });

    // The in-flight period uses the active interval. The pending interval applies
    // to the period that starts at this boundary and all subsequent periods.
    const intervalForNextPeriod = pendingIntervalAppliesAfterCurrentPeriod
      ? pendingIntervalDays!
      : intervalForCurrentPeriod;
    periodEnd = new Date(periodEnd.getTime() + intervalForNextPeriod * DAY_MS);
    intervalForCurrentPeriod = intervalForNextPeriod;
    pendingIntervalAppliesAfterCurrentPeriod = false;
  }

  return {
    periods,
    nextSnapshotAt: periodEnd,
    stillDue: periodEnd.getTime() <= now.getTime(),
  };
}

export type MemorySchedulerReport = {
  settingsChecked: number;
  settingsEnabled: number;
  settingsDisabled: number;
  settingsWithoutNextSnapshotAt: number;
  settingsNotDue: number;
  settingsInitialized: number;
  settingsAdvanced: number;
  jobsQueued: number;
  periodsConsidered: number;
  missingGlobalScope: number;
  settingsStillDue: number;
};

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

export async function enqueueDueMemorySnapshots(
  prisma: PrismaClient,
  options: { now?: Date; ownerId?: string; maxPeriodsPerSetting?: number } = {},
): Promise<MemorySchedulerReport> {
  const now = options.now ?? new Date();
  const settings = await prisma.characterMemorySetting.findMany({
    where: {
      ...(options.ownerId ? { character: { is: { ownerId: options.ownerId } } } : {}),
    },
    select: {
      characterId: true,
      snapshotIntervalDays: true,
      pendingSnapshotIntervalDays: true,
      anchorAt: true,
      nextSnapshotAt: true,
      autoSnapshotEnabled: true,
      timezone: true,
      rawMessageRetentionDays: true,
      rawMessageCleanupEnabled: true,
      character: {
        select: {
          ownerId: true,
          memoryScopes: {
            select: { id: true, scopeType: true, userId: true },
          },
        },
      },
    },
  });

  const report: MemorySchedulerReport = {
    settingsChecked: settings.length,
    settingsEnabled: settings.filter((setting) => setting.autoSnapshotEnabled).length,
    settingsDisabled: settings.filter((setting) => !setting.autoSnapshotEnabled).length,
    settingsWithoutNextSnapshotAt: settings.filter((setting) => setting.autoSnapshotEnabled && !setting.nextSnapshotAt).length,
    settingsNotDue: 0,
    settingsInitialized: 0,
    settingsAdvanced: 0,
    jobsQueued: 0,
    periodsConsidered: 0,
    missingGlobalScope: 0,
    settingsStillDue: 0,
  };

  for (const setting of settings) {
    const globalScopeId = setting.character.memoryScopes.find((scope) => scope.scopeType === "CHARACTER_GLOBAL")?.id;

    // Queue retention cleanup independently from automatic snapshot generation.
    // Do not queue a cleanup while an older snapshot period is still pending.
    const retentionDays = setting.rawMessageRetentionDays;
    const cutoff = setting.rawMessageCleanupEnabled && retentionDays && retentionDays > 0
      ? addDays(now, -retentionDays)
      : null;
    const firstSnapshotBoundary = setting.nextSnapshotAt ?? addDays(setting.anchorAt, setting.snapshotIntervalDays);
    const hasUnqueuedExpiredSnapshotPeriods = Boolean(
      setting.autoSnapshotEnabled &&
      cutoff &&
      firstSnapshotBoundary.getTime() <= now.getTime() &&
      firstSnapshotBoundary.getTime() - setting.snapshotIntervalDays * DAY_MS < cutoff.getTime()
    );
    if (cutoff && !hasUnqueuedExpiredSnapshotPeriods) {
      for (const scope of setting.character.memoryScopes) {
        const pendingSnapshot = await prisma.memoryJob.findFirst({
          where: {
            memoryScopeId: scope.id,
            type: { in: ["GENERATE_SNAPSHOT", "REGENERATE_SNAPSHOT"] },
            status: { in: ["QUEUED", "RUNNING", "RETRY_WAIT"] },
            periodStart: { lt: cutoff },
          },
          select: { id: true },
        });
        if (pendingSnapshot) continue;
        const cutoffKey = cutoff.toISOString().slice(0, 10);
        await prisma.memoryJob.createMany({
          data: [{
            memoryScopeId: scope.id,
            type: "CLEAN_EXPIRED_MESSAGES",
            idempotencyKey: `clean-expired-messages:${scope.id}:${cutoffKey}`,
            periodEnd: cutoff,
            status: "QUEUED",
            runAt: now,
          }],
          skipDuplicates: true,
        });
      }
    }

    if (!setting.autoSnapshotEnabled) continue;
    if (!globalScopeId) {
      report.missingGlobalScope += 1;
      continue;
    }
    const memoryScopeId = globalScopeId;

    // 主人专属私人范围：角色 owner 的 USER_PRIVATE scope。主人的私聊会话挂在这里，
    // 需要和全局一起排快照 —— 否则「角色记得主人」这一环只有写入、没有提炼。
    // 周期边界跟随全局（同一个 anchor/interval），只是 job 挂在 owner scope 上；
    // 该周期内没有主人私聊时 worker 会按既有逻辑 SKIPPED，不产生空总结。
    const ownerPrivateScopeId = setting.character.ownerId
      ? setting.character.memoryScopes.find((scope) => scope.scopeType === "USER_PRIVATE" && scope.userId === setting.character.ownerId)?.id
      : null;

    // 忆泡按天整理：和 8 天快照周期解耦 —— 昨天的对话第二天就该查得到，
    // 不能等下一个周期。幂等键带日期，一天只排一次；当天没有对话就不排。
    const eventScopeIds = [globalScopeId, ownerPrivateScopeId].filter((id): id is string => Boolean(id));
    // 自动记忆总开关关掉时，忆泡也不偷偷跑 —— 一次模型调用也是钱，不能绕过用户的选择。
    if (setting.autoSnapshotEnabled && eventScopeIds.length > 0) {
      const timeZone = setting.timezone || "Asia/Shanghai";
      const { dayKey: todayKey, hour } = localDayHour(now, timeZone);
      const todayWindow = resolveDayWindow(todayKey, timeZone);
      const yesterdayWindow = resolveDailyEventWindow(now, timeZone);
      const recentCutoff = new Date(now.getTime() - 60 * 60_000);

      for (const scopeId of eventScopeIds) {
        // 增量：最近一小时有新消息才排，幂等键带小时 —— 同一天可以长很多次。
        const recent = await prisma.message.findFirst({
          where: {
            conversation: { is: { memoryScopeId: scopeId } },
            occurredAt: { gte: recentCutoff, lt: now },
          },
          select: { id: true },
        });
        if (recent) {
          const created = await prisma.memoryJob.createMany({
            data: [{
              memoryScopeId: scopeId,
              type: "EXTRACT_EVENTS" as const,
              idempotencyKey: `events-hour:${scopeId}:${todayKey}:${hour}`,
              periodStart: todayWindow.start,
              periodEnd: todayWindow.end,
              status: "QUEUED" as const,
              runAt: now,
            }],
            skipDuplicates: true,
          });
          report.jobsQueued += created.count;
        }

        // 收口：昨天整天跑完后标成 FINAL，之后不再追加。
        const hasYesterday = await prisma.message.findFirst({
          where: {
            conversation: { is: { memoryScopeId: scopeId } },
            occurredAt: { gte: yesterdayWindow.start, lt: yesterdayWindow.end },
          },
          select: { id: true },
        });
        if (!hasYesterday) continue;
        const finalized = await prisma.memoryJob.createMany({
          data: [{
            memoryScopeId: scopeId,
            type: "EXTRACT_EVENTS" as const,
            idempotencyKey: `events-final:${scopeId}:${yesterdayWindow.dayKey}`,
            periodStart: yesterdayWindow.start,
            periodEnd: yesterdayWindow.end,
            status: "QUEUED" as const,
            runAt: now,
          }],
          skipDuplicates: true,
        });
        report.jobsQueued += finalized.count;
      }
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const latest = await tx.characterMemorySetting.findUnique({
          where: { characterId: setting.characterId },
          select: {
            characterId: true,
            snapshotIntervalDays: true,
            pendingSnapshotIntervalDays: true,
            anchorAt: true,
            nextSnapshotAt: true,
            autoSnapshotEnabled: true,
          },
        });
        if (!latest?.autoSnapshotEnabled) {
          return { jobsQueued: 0, periodsConsidered: 0, advanced: false, initialized: false, notDue: false, stillDue: false, periods: [] };
        }

        // Repair an enabled setting missing its next boundary from the saved anchor.
        const firstBoundary = latest.nextSnapshotAt ?? addDays(latest.anchorAt, latest.snapshotIntervalDays);
        if (firstBoundary.getTime() > now.getTime()) {
          if (!latest.nextSnapshotAt) {
            const init = await tx.characterMemorySetting.updateMany({
              where: {
                characterId: latest.characterId,
                autoSnapshotEnabled: true,
                nextSnapshotAt: null,
                anchorAt: latest.anchorAt,
                snapshotIntervalDays: latest.snapshotIntervalDays,
                pendingSnapshotIntervalDays: latest.pendingSnapshotIntervalDays,
              },
              data: { nextSnapshotAt: firstBoundary },
            });
            if (init.count === 1) {
              return { jobsQueued: 0, periodsConsidered: 0, advanced: false, initialized: true, notDue: true, stillDue: false, periods: [] };
            }
          }
          return { jobsQueued: 0, periodsConsidered: 0, advanced: false, initialized: false, notDue: true, stillDue: false, periods: [] };
        }

        const built = buildDueMemoryPeriods({
          memoryScopeId,
          nextSnapshotAt: firstBoundary,
          intervalDays: latest.snapshotIntervalDays,
          pendingIntervalDays: latest.pendingSnapshotIntervalDays,
          now,
          maxPeriods: options.maxPeriodsPerSetting,
        });
        if (built.periods.length === 0 || !built.nextSnapshotAt) {
          return { jobsQueued: 0, periodsConsidered: 0, advanced: false, initialized: false, notDue: false, stillDue: false, periods: [] };
        }

        const createResult = await tx.memoryJob.createMany({
          data: built.periods.map((period) => ({
            memoryScopeId,
            type: "GENERATE_SNAPSHOT" as const,
            idempotencyKey: period.idempotencyKey,
            periodStart: period.periodStart,
            periodEnd: period.periodEnd,
            status: "QUEUED" as const,
            runAt: now,
          })),
          skipDuplicates: true,
        });

        // Compare-and-set protects the period cursor when schedulers run concurrently.
        const updateResult = await tx.characterMemorySetting.updateMany({
          where: {
            characterId: latest.characterId,
            autoSnapshotEnabled: true,
            nextSnapshotAt: latest.nextSnapshotAt,
            snapshotIntervalDays: latest.snapshotIntervalDays,
            pendingSnapshotIntervalDays: latest.pendingSnapshotIntervalDays,
          },
          data: {
            nextSnapshotAt: built.nextSnapshotAt,
            ...(latest.pendingSnapshotIntervalDays !== null
              ? { snapshotIntervalDays: latest.pendingSnapshotIntervalDays, pendingSnapshotIntervalDays: null }
              : {}),
          },
        });
        if (updateResult.count !== 1) {
          throw new Error("MEMORY_SCHEDULER_RACE");
        }

        return {
          jobsQueued: createResult.count,
          periodsConsidered: built.periods.length,
          advanced: true,
          initialized: latest.nextSnapshotAt === null,
          notDue: false,
          stillDue: built.stillDue,
          periods: built.periods,
        };
      });

      report.jobsQueued += result.jobsQueued;
      report.periodsConsidered += result.periodsConsidered;
      if (result.advanced) report.settingsAdvanced += 1;
      if (result.initialized) report.settingsInitialized += 1;
      if (result.notDue) report.settingsNotDue += 1;
      if (result.stillDue) report.settingsStillDue += 1;

      // 主人专属范围跟随全局周期补排快照。幂等键含 scope id，与全局不冲突；
      // 只有全局真推进了周期（advanced）才补，避免重复。
      if (ownerPrivateScopeId && result.advanced && result.periods.length) {
        const ownerPeriods = result.periods.map((period) => ({
          memoryScopeId: ownerPrivateScopeId,
          type: "GENERATE_SNAPSHOT" as const,
          idempotencyKey: `auto-snapshot:${ownerPrivateScopeId}:${period.periodStart.toISOString()}:${period.periodEnd.toISOString()}`,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          status: "QUEUED" as const,
          runAt: now,
        }));
        const ownerResult = await prisma.memoryJob.createMany({ data: ownerPeriods, skipDuplicates: true });
        report.jobsQueued += ownerResult.count;
      }

      /**
       * 朋友范围跟着同一个周期补排快照。
       *
       * 以前这里只有「全局」和「主人私人」两种范围，`EXTERNAL_IDENTITY` 从不入队 ——
       * 结果是身份行建了一堆，记忆条数是 0，绑过去也读不到任何东西。补上这一环，
       * 「跟某个人聊过的细节」才第一次真的存在。
       *
       * 只排本周期有会话的（见 `listFriendScopesWithActivity`），并且有数量上限。
       */
      if (result.advanced && result.periods.length) {
        const first = result.periods[0]!;
        const last = result.periods[result.periods.length - 1]!;
        const friendScopeIds = await listFriendScopesWithActivity({
          characterId: setting.characterId,
          since: first.periodStart,
          until: last.periodEnd,
        }).catch(() => []);
        if (friendScopeIds.length) {
          const friendPeriods = friendScopeIds.flatMap((scopeId) => result.periods.map((period) => ({
            memoryScopeId: scopeId,
            type: "GENERATE_SNAPSHOT" as const,
            idempotencyKey: `auto-snapshot:${scopeId}:${period.periodStart.toISOString()}:${period.periodEnd.toISOString()}`,
            periodStart: period.periodStart,
            periodEnd: period.periodEnd,
            status: "QUEUED" as const,
            runAt: now,
          })));
          const friendResult = await prisma.memoryJob.createMany({ data: friendPeriods, skipDuplicates: true });
          report.jobsQueued += friendResult.count;
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message === "MEMORY_SCHEDULER_RACE") continue;
      throw error;
    }
  }

  return report;
}
