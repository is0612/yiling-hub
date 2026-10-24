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
      anchorAt: true,
      nextSnapshotAt: true,
      autoSnapshotEnabled: true,
      rawMessageRetentionDays: true,
      character: {
        select: {
          memoryScopes: {
            select: { id: true, scopeType: true },
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
    const cutoff = retentionDays && retentionDays > 0 ? addDays(now, -retentionDays) : null;
    const hasUnqueuedExpiredSnapshotPeriods = Boolean(
      setting.autoSnapshotEnabled &&
      cutoff &&
      (setting.nextSnapshotAt ?? addDays(setting.anchorAt, setting.snapshotIntervalDays)).getTime() < cutoff.getTime()
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

    try {
      const result = await prisma.$transaction(async (tx) => {
        const latest = await tx.characterMemorySetting.findUnique({
          where: { characterId: setting.characterId },
          select: {
            characterId: true,
            snapshotIntervalDays: true,
            anchorAt: true,
            nextSnapshotAt: true,
            autoSnapshotEnabled: true,
          },
        });
        if (!latest?.autoSnapshotEnabled) {
          return { jobsQueued: 0, periodsConsidered: 0, advanced: false, initialized: false, notDue: false, stillDue: false };
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
              },
              data: { nextSnapshotAt: firstBoundary },
            });
            if (init.count === 1) {
              return { jobsQueued: 0, periodsConsidered: 0, advanced: false, initialized: true, notDue: true, stillDue: false };
            }
          }
          return { jobsQueued: 0, periodsConsidered: 0, advanced: false, initialized: false, notDue: true, stillDue: false };
        }

        const built = buildDueMemoryPeriods({
          memoryScopeId,
          nextSnapshotAt: firstBoundary,
          intervalDays: latest.snapshotIntervalDays,
          now,
          maxPeriods: options.maxPeriodsPerSetting,
        });
        if (built.periods.length === 0 || !built.nextSnapshotAt) {
          return { jobsQueued: 0, periodsConsidered: 0, advanced: false, initialized: false, notDue: false, stillDue: false };
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
          initialized: latest.nextSnapshotAt === null,
          notDue: false,
          stillDue: built.stillDue,
        };
      });

      report.jobsQueued += result.jobsQueued;
      report.periodsConsidered += result.periodsConsidered;
      if (result.advanced) report.settingsAdvanced += 1;
      if (result.initialized) report.settingsInitialized += 1;
      if (result.notDue) report.settingsNotDue += 1;
      if (result.stillDue) report.settingsStillDue += 1;
    } catch (error) {
      if (error instanceof Error && error.message === "MEMORY_SCHEDULER_RACE") continue;
      throw error;
    }
  }

  return report;
}
