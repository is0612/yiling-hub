import { createError, getQuery } from "h3";
import { requireLocalDevOwner } from "../../utils/local-api";
import { getPrisma } from "../../utils/prisma";

const statuses = ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "SKIPPED", "RETRY_WAIT", "CANCELLED"] as const;
type JobStatus = (typeof statuses)[number];

export default defineEventHandler(async (event) => {
  const ownerId = requireLocalDevOwner(event);
  const query = getQuery(event);
  const statusValue = typeof query.status === "string" ? query.status.toUpperCase() : "";
  if (statusValue && !(statuses as readonly string[]).includes(statusValue)) {
    throw createError({ statusCode: 400, statusMessage: "任务状态筛选值无效。" });
  }
  const limitRaw = typeof query.limit === "string" ? Number(query.limit) : 50;
  if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 100) {
    throw createError({ statusCode: 400, statusMessage: "每页任务数必须为 1–100。" });
  }

  const prisma = getPrisma();
  const where = {
    memoryScope: { is: { character: { is: { ownerId } } } },
    ...(statusValue ? { status: statusValue as JobStatus } : {}),
  };
  const [jobs, total, statusGroups] = await Promise.all([
    prisma.memoryJob.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limitRaw,
      select: {
        id: true,
        type: true,
        status: true,
        attemptCount: true,
        maxAttempts: true,
        runAt: true,
        periodStart: true,
        periodEnd: true,
        lastError: true,
        startedAt: true,
        completedAt: true,
        createdAt: true,
        updatedAt: true,
        memoryScope: { select: { character: { select: { id: true, name: true } } } },
      },
    }),
    prisma.memoryJob.count({ where }),
    prisma.memoryJob.groupBy({ by: ["status"], where: { memoryScope: { is: { character: { is: { ownerId } } } }, ...(statusValue ? { status: statusValue as JobStatus } : {}) }, _count: { _all: true } }),
  ]);

  return {
    items: jobs.map((job) => ({
      id: job.id,
      type: job.type,
      status: job.status,
      attemptCount: job.attemptCount,
      maxAttempts: job.maxAttempts,
      runAt: job.runAt.toISOString(),
      periodStart: job.periodStart?.toISOString() ?? null,
      periodEnd: job.periodEnd?.toISOString() ?? null,
      lastError: job.lastError,
      startedAt: job.startedAt?.toISOString() ?? null,
      completedAt: job.completedAt?.toISOString() ?? null,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      characterId: job.memoryScope.character.id,
      characterName: job.memoryScope.character.name,
    })),
    total,
    statusCounts: {
      QUEUED: statusGroups.find((group) => group.status === "QUEUED")?._count._all ?? 0,
      RUNNING: statusGroups.find((group) => group.status === "RUNNING")?._count._all ?? 0,
      SUCCEEDED: statusGroups.find((group) => group.status === "SUCCEEDED")?._count._all ?? 0,
      FAILED: statusGroups.find((group) => group.status === "FAILED")?._count._all ?? 0,
      RETRY_WAIT: statusGroups.find((group) => group.status === "RETRY_WAIT")?._count._all ?? 0,
      SKIPPED: statusGroups.find((group) => group.status === "SKIPPED")?._count._all ?? 0,
      CANCELLED: statusGroups.find((group) => group.status === "CANCELLED")?._count._all ?? 0,
    },
  };
});
