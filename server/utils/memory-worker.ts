import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../../src/generated/prisma/client";

const LEASE_MS = 5 * 60 * 1000;
const MAX_SOURCE_MESSAGES = 250;
const MAX_SOURCE_MEMORIES = 250;

export type MemoryWorkerResult =
  | { processed: false; message: string }
  | { processed: true; jobId: string; status: "SUCCEEDED" | "SKIPPED" | "RETRY_WAIT" | "FAILED"; snapshotId?: string; message: string };

type WorkerOptions = {
  ownerId?: string;
  workerId?: string;
  now?: Date;
};

function ownerFilter(ownerId?: string) {
  return ownerId ? { memoryScope: { is: { character: { is: { ownerId } } } } } : {};
}

export async function processNextMemoryJob(
  prisma: PrismaClient,
  options: WorkerOptions = {},
): Promise<MemoryWorkerResult> {
  const now = options.now ?? new Date();
  const workerId = options.workerId ?? `worker-${process.pid}-${randomUUID()}`;
  const ownership = ownerFilter(options.ownerId);
  const staleBefore = new Date(now.getTime() - LEASE_MS);

  const staleJobs = await prisma.memoryJob.findMany({
    where: {
      type: "GENERATE_SNAPSHOT",
      status: "RUNNING",
      lockedAt: { lt: staleBefore },
      ...ownership,
    },
    select: { id: true, attemptCount: true, maxAttempts: true },
    take: 100,
  });
  for (const stale of staleJobs) {
    const exhausted = stale.attemptCount >= stale.maxAttempts;
    await prisma.memoryJob.updateMany({
      where: { id: stale.id, status: "RUNNING", lockedAt: { lt: staleBefore } },
      data: {
        status: exhausted ? "FAILED" : "RETRY_WAIT",
        runAt: now,
        lockedAt: null,
        lockedBy: null,
        lastError: "任务执行租约已过期，系统已恢复该任务的队列状态。",
        completedAt: exhausted ? now : null,
      },
    });
  }

  const candidates = await prisma.memoryJob.findMany({
    where: {
      type: "GENERATE_SNAPSHOT",
      status: { in: ["QUEUED", "RETRY_WAIT"] },
      runAt: { lte: now },
      ...ownership,
    },
    orderBy: [{ runAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: 10,
    select: { id: true, status: true, attemptCount: true, maxAttempts: true },
  });

  let claimedJobId = "";
  for (const candidate of candidates) {
    if (candidate.attemptCount >= candidate.maxAttempts) {
      await prisma.memoryJob.updateMany({
        where: { id: candidate.id, status: candidate.status },
        data: {
          status: "FAILED",
          completedAt: now,
          lastError: "任务已达到最大尝试次数。",
          lockedAt: null,
          lockedBy: null,
        },
      });
      continue;
    }

    const claim = await prisma.memoryJob.updateMany({
      where: { id: candidate.id, status: candidate.status, runAt: { lte: now } },
      data: {
        status: "RUNNING",
        attemptCount: { increment: 1 },
        lockedAt: now,
        lockedBy: workerId,
        startedAt: now,
        lastError: null,
      },
    });
    if (claim.count === 1) {
      claimedJobId = candidate.id;
      break;
    }
  }

  if (!claimedJobId) return { processed: false, message: "当前没有可领取的周期快照任务。" };

  try {
    const outcome = await prisma.$transaction(async (tx) => {
      const job = await tx.memoryJob.findUnique({
        where: { id: claimedJobId },
        select: {
          id: true,
          memoryScopeId: true,
          idempotencyKey: true,
          periodStart: true,
          periodEnd: true,
          status: true,
          lockedBy: true,
          attemptCount: true,
        },
      });
      if (!job || job.status !== "RUNNING" || job.lockedBy !== workerId) {
        throw new Error("任务已不属于当前 Worker，拒绝继续执行。");
      }
      if (!job.periodStart || !job.periodEnd || job.periodStart >= job.periodEnd) {
        throw new Error("周期任务缺少有效的起止时间。");
      }

      const priorSnapshot = await tx.memorySnapshot.findFirst({
        where: { snapshotKey: job.idempotencyKey, memoryScopeId: job.memoryScopeId },
        orderBy: [{ version: "desc" }, { createdAt: "desc" }],
        select: { id: true },
      });
      if (priorSnapshot) {
        await tx.memoryJob.update({
          where: { id: job.id },
          data: {
            status: "SUCCEEDED",
            snapshotId: priorSnapshot.id,
            completedAt: now,
            lockedAt: null,
            lockedBy: null,
            lastError: null,
          },
        });
        return { status: "SUCCEEDED" as const, snapshotId: priorSnapshot.id, message: "检测到相同周期已有快照，已复用历史结果。" };
      }

      const messageWhere = {
        conversation: { is: { memoryScopeId: job.memoryScopeId } },
        occurredAt: { gte: job.periodStart, lt: job.periodEnd },
      };
      const memoryActivityWhere = {
        memoryScopeId: job.memoryScopeId,
        status: { not: "TRASHED" as const },
        OR: [
          { createdAt: { gte: job.periodStart, lt: job.periodEnd } },
          { updatedAt: { gte: job.periodStart, lt: job.periodEnd } },
        ],
      };

      const [messageCount, eventCount, sourceMessages, memoryActivityCount, activeItems] = await Promise.all([
        tx.message.count({ where: messageWhere }),
        tx.message.count({ where: { ...messageWhere, eventType: { not: "message" } } }),
        tx.message.findMany({
          where: messageWhere,
          orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
          take: MAX_SOURCE_MESSAGES,
          select: { id: true, role: true, eventType: true, content: true, occurredAt: true },
        }),
        tx.memoryItem.count({ where: memoryActivityWhere }),
        tx.memoryItem.findMany({
          where: {
            memoryScopeId: job.memoryScopeId,
            status: "ACTIVE",
            createdAt: { lte: job.periodEnd },
            updatedAt: { lte: job.periodEnd },
          },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          take: MAX_SOURCE_MEMORIES,
          select: {
            id: true, category: true, content: true, confidence: true,
            validFrom: true, validTo: true, createdAt: true,
          },
        }),
      ]);

      if (messageCount === 0 && memoryActivityCount === 0) {
        await tx.memoryJob.update({
          where: { id: job.id },
          data: {
            status: "SKIPPED",
            completedAt: now,
            lastError: "该周期内没有已保存的对话消息、平台事件或长期记忆变更。",
            lockedAt: null,
            lockedBy: null,
          },
        });
        return { status: "SKIPPED" as const, message: "周期内无已保存活动，已跳过快照生成。" };
      }

      const storedMessages = sourceMessages.map((message) => ({
        id: message.id,
        role: message.role,
        eventType: message.eventType,
        occurredAt: message.occurredAt.toISOString(),
        excerpt: message.content.slice(0, 1000),
        excerptTruncated: message.content.length > 1000,
      }));
      const structuredContent = {
        generatedBy: "rule-based-worker-v1",
        capturedAt: now.toISOString(),
        messageCount,
        storedSourceMessageCount: sourceMessages.length,
        omittedMessageCount: Math.max(0, messageCount - sourceMessages.length),
        eventCount,
        memoryActivityCount,
        messages: storedMessages,
        memoryItems: activeItems.map((item) => ({
          id: item.id,
          category: item.category,
          content: item.content,
          ...(item.confidence !== null ? { confidence: item.confidence } : {}),
          ...(item.validFrom ? { validFrom: item.validFrom.toISOString() } : {}),
          ...(item.validTo ? { validTo: item.validTo.toISOString() } : {}),
          createdAt: item.createdAt.toISOString(),
        })),
        note: "规则版结构化快照；未调用大模型，不代表语义总结。",
      };
      const summary = `自动周期快照（规则版）：记录 ${messageCount} 条消息、${eventCount} 个事件、${memoryActivityCount} 条长期记忆变更。仅保存结构化记录，未调用大模型生成语义总结。`;

      const snapshot = await tx.memorySnapshot.create({
        data: {
          snapshotKey: job.idempotencyKey,
          memoryScopeId: job.memoryScopeId,
          kind: "AUTOMATIC",
          version: 1,
          periodStart: job.periodStart,
          periodEnd: job.periodEnd,
          summary,
          structuredContent,
          status: "CURRENT",
          generatedAt: now,
          sources: {
            create: [
              ...sourceMessages.map((message) => ({
                sourceType: message.eventType === "message" ? "MESSAGE" as const : "PLATFORM_EVENT" as const,
                sourceRef: message.id,
                messageId: message.id,
              })),
              ...activeItems.map((item) => ({
                sourceType: "MEMORY_ITEM" as const,
                sourceRef: item.id,
                memoryItemId: item.id,
              })),
            ],
          },
        },
        select: { id: true },
      });

      await tx.memoryJob.update({
        where: { id: job.id },
        data: {
          status: "SUCCEEDED",
          snapshotId: snapshot.id,
          completedAt: now,
          lockedAt: null,
          lockedBy: null,
          lastError: null,
        },
      });
      return { status: "SUCCEEDED" as const, snapshotId: snapshot.id, message: "已生成规则版结构化快照；尚未调用大模型。" };
    });

    return { processed: true, jobId: claimedJobId, ...outcome };
  } catch (error) {
    const failedAt = new Date();
    const latest = await prisma.memoryJob.findUnique({
      where: { id: claimedJobId },
      select: { attemptCount: true, maxAttempts: true, lockedBy: true, status: true },
    });
    if (!latest || latest.status !== "RUNNING" || latest.lockedBy !== workerId) {
      return { processed: true, jobId: claimedJobId, status: "FAILED", message: "任务执行失败或租约已被其他 Worker 接管。" };
    }
    const exhausted = latest.attemptCount >= latest.maxAttempts;
    const retryDelayMs = Math.min(60 * 60 * 1000, 30_000 * (2 ** Math.max(0, latest.attemptCount - 1)));
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
    await prisma.memoryJob.updateMany({
      where: { id: claimedJobId, status: "RUNNING", lockedBy: workerId },
      data: {
        status: exhausted ? "FAILED" : "RETRY_WAIT",
        runAt: exhausted ? failedAt : new Date(failedAt.getTime() + retryDelayMs),
        completedAt: exhausted ? failedAt : null,
        lastError: message,
        lockedAt: null,
        lockedBy: null,
      },
    });
    return {
      processed: true,
      jobId: claimedJobId,
      status: exhausted ? "FAILED" : "RETRY_WAIT",
      message: exhausted ? `任务失败，已达到最大尝试次数：${message}` : `任务执行失败，将延迟重试：${message}`,
    };
  }
}
