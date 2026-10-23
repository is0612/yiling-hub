import type { PrismaClient } from "../../src/generated/prisma/client";

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
  maxPeriods?: number;
}): { periods: DueMemoryPeriod[]; nextSnapshotAt: Date | null; stillDue: boolean } {
  const { memoryScopeId, nextSnapshotAt, intervalDays, now } = input;
  const maxPeriods = input.maxPeriods ?? DEFAULT_MAX_PERIODS_PER_SETTING;
  if (
    !nextSnapshotAt ||
    !Number.isFinite(nextSnapshotAt.getTime()) ||
    !Number.isFinite(now.getTime()) ||
    !Number.isInteger(intervalDays) ||
    intervalDays < 1 ||
    !Number.isInteger(maxPeriods) ||
    maxPeriods < 1 ||
    nextSnapshotAt.getTime() > now.getTime()
  ) {
    return { periods: [], nextSnapshotAt, stillDue: false };
  }

  const intervalMs = intervalDays * DAY_MS;
  const periods: DueMemoryPeriod[] = [];
  let periodEnd = new Date(nextSnapshotAt);

  while (periodEnd.getTime() <= now.getTime() && periods.length < maxPeriods) {
    const periodStart = new Date(periodEnd.getTime() - intervalMs);
    periods.push({
      periodStart,
      periodEnd: new Date(periodEnd),
      idempotencyKey: `auto-snapshot:${memoryScopeId}:${periodStart.toISOString()}:${periodEnd.toISOString()}`,
    });
    periodEnd = new Date(periodEnd.getTime() + intervalMs);
  }

  return {
    periods,
    nextSnapshotAt: periodEnd,
    stillDue: periodEnd.getTime() <= now.getTime(),
  };
}

export type MemorySchedulerReport = {
  settingsChecked: number;
  settingsAdvanced: number;
  jobsQueued: number;
  periodsConsidered: number;
  missingGlobalScope: number;
  settingsStillDue: number;
};

export async function enqueueDueMemorySnapshots(
  prisma: PrismaClient,
  options: { now?: Date; ownerId?: string; maxPeriodsPerSetting?: number } = {},
): Promise<MemorySchedulerReport> {
  const now = options.now ?? new Date();
  const settings = await prisma.characterMemorySetting.findMany({
    where: {
      autoSnapshotEnabled: true,
      nextSnapshotAt: { lte: now },
      ...(options.ownerId ? { character: { is: { ownerId: options.ownerId } } } : {}),
    },
    select: {
      characterId: true,
      snapshotIntervalDays: true,
      nextSnapshotAt: true,
      character: {
        select: {
          memoryScopes: {
            where: { scopeType: "CHARACTER_GLOBAL" },
            select: { id: true },
            take: 1,
          },
        },
      },
    },
  });

  const report: MemorySchedulerReport = {
    settingsChecked: settings.length,
    settingsAdvanced: 0,
    jobsQueued: 0,
    periodsConsidered: 0,
    missingGlobalScope: 0,
    settingsStillDue: 0,
  };

  for (const setting of settings) {
    const memoryScopeId = setting.character.memoryScopes[0]?.id;
    if (!memoryScopeId) {
      report.missingGlobalScope += 1;
      continue;
    }

    try {
      const result = await prisma.$transaction(async (tx) => {
        const latest = await tx.characterMemorySetting.findUnique({
          where: { characterId: setting.characterId },
          select: {
            characterId: true,
            snapshotIntervalDays: true,
            nextSnapshotAt: true,
            autoSnapshotEnabled: true,
          },
        });
        if (!latest?.autoSnapshotEnabled || !latest.nextSnapshotAt || latest.nextSnapshotAt > now) {
          return { jobsQueued: 0, periodsConsidered: 0, advanced: false, stillDue: false };
        }

        const built = buildDueMemoryPeriods({
          memoryScopeId,
          nextSnapshotAt: latest.nextSnapshotAt,
          intervalDays: latest.snapshotIntervalDays,
          now,
          maxPeriods: options.maxPeriodsPerSetting,
        });
        if (built.periods.length === 0 || !built.nextSnapshotAt) {
          return { jobsQueued: 0, periodsConsidered: 0, advanced: false, stillDue: false };
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

        // Optimistic compare-and-set protects against concurrent scheduler runs.
        const updateResult = await tx.characterMemorySetting.updateMany({
          where: {
            characterId: latest.characterId,
            autoSnapshotEnabled: true,
            nextSnapshotAt: latest.nextSnapshotAt,
          },
          data: { nextSnapshotAt: built.nextSnapshotAt },
        });
        if (updateResult.count !== 1) {
          throw new Error("MEMORY_SCHEDULER_RACE");
        }

        return {
          jobsQueued: createResult.count,
          periodsConsidered: built.periods.length,
          advanced: true,
          stillDue: built.stillDue,
        };
      });

      report.jobsQueued += result.jobsQueued;
      report.periodsConsidered += result.periodsConsidered;
      if (result.advanced) report.settingsAdvanced += 1;
      if (result.stillDue) report.settingsStillDue += 1;
    } catch (error) {
      if (error instanceof Error && error.message === "MEMORY_SCHEDULER_RACE") continue;
      throw error;
    }
  }

  return report;
}
