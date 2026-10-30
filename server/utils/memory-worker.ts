import { resolveChatModelSettings } from "./chat-model-config";
import { resolveCharacterApiKey } from "./credential-encryption";
import { recordModelUsage, toUsageTokens } from "./model-usage";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../../src/generated/prisma/client";
import {
  analyzeMemoryPeriod,
  isMemoryModelConfigured,
  type MemoryAiMessage,
  type MemoryChange,
} from "./memory-ai";
import { applyMemoryChange, normalizeMemoryText } from "./memory-change-apply";
import {
  PER_CONVERSATION_SOURCE_WINDOW,
  selectPeriodSourceMessages,
} from "./memory-source-selection";

const LEASE_MS = 5 * 60 * 1000;
/** 一个周期最多看几个会话：会话再多，也只给最近活跃的这几个分配来源配额。 */
const MAX_SCOPE_CONVERSATIONS = 12;
const MAX_SOURCE_MEMORIES = 250;
const MAX_AI_MESSAGES = 120;
const MAX_AI_MEMORIES = 80;
const MIN_MEMORY_CONFIDENCE = 0.65;

export type MemoryWorkerResult =
  | { processed: false; message: string }
  | { processed: true; jobId: string; status: "SUCCEEDED" | "SKIPPED" | "RETRY_WAIT" | "FAILED" | "CANCELLED"; snapshotId?: string; message: string };

type WorkerOptions = {
  ownerId?: string;
  workerId?: string;
  now?: Date;
};

function ownerFilter(ownerId?: string) {
  return ownerId ? { memoryScope: { is: { character: { is: { ownerId } } } } } : {};
}

type PeriodSourceMessage = {
  id: string;
  role: string;
  eventType: string;
  content: string;
  occurredAt: Date;
  conversationId: string;
  /** 这条消息来自哪种对话：群聊带群号，私聊/本地对话各有一个固定标签。 */
  origin: string;
  /** 这条是主人发的。群聊里主人和群友混在一起，要靠它让提炼时认得出主人。 */
  isOwner: boolean;
};

/** 会话在提示词里的来源标签。群聊必须带上群号，否则模型分不清是哪段关系在说话。 */
function conversationOriginLabel(conversation: { externalConversationId: string | null }): string {
  const key = conversation.externalConversationId ?? "";
  const group = /^g:(\d+)$/.exec(key);
  if (group?.[1]) return `QQ群 ${group[1]}`;
  if (key.startsWith("c:")) return "私聊";
  return "本地对话";
}

/**
 * 按会话取本周期来源消息。
 *
 * 每个会话单独查最近的一批，再交给 selectPeriodSourceMessages 做配额分配 ——
 * 一条 SQL 取不出「每个会话各 N 条」，而按全局时间取正是私聊被水群挤掉的原因。
 */
async function loadPeriodSourceMessages(
  prisma: PrismaClient,
  conversations: Array<{ id: string; externalConversationId: string | null }>,
  periodStart: Date,
  periodEnd: Date,
): Promise<PeriodSourceMessage[]> {
  const batches = await Promise.all(conversations.map(async (conversation) => {
    const rows = await prisma.message.findMany({
      where: { conversationId: conversation.id, occurredAt: { gte: periodStart, lt: periodEnd } },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: PER_CONVERSATION_SOURCE_WINDOW,
      select: { id: true, role: true, eventType: true, content: true, occurredAt: true, metadata: true },
    });
    const origin = conversationOriginLabel(conversation);
    return rows.map((row) => ({
      ...row,
      conversationId: conversation.id,
      origin,
      isOwner: readIsOwnerFlag(row.metadata),
    }));
  }));
  return selectPeriodSourceMessages(batches.flat());
}

function readIsOwnerFlag(metadata: unknown): boolean {
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  return record.isOwner === true;
}

function selectAiMessages(messages: PeriodSourceMessage[]): MemoryAiMessage[] {
  let selected = messages;
  if (messages.length > MAX_AI_MESSAGES) {
    const edge = Math.floor(MAX_AI_MESSAGES / 2);
    selected = [...messages.slice(0, edge), ...messages.slice(-edge)];
  }
  return selected.map((message) => ({
    id: message.id,
    role: message.role,
    eventType: message.eventType,
    occurredAt: message.occurredAt.toISOString(),
    content: message.content.slice(0, 1200),
    origin: message.origin,
    isOwner: message.isOwner,
  }));
}

function validConfidence(change: MemoryChange): boolean {
  return change.confidence >= MIN_MEMORY_CONFIDENCE;
}

export async function processNextMemoryJob(
  prisma: PrismaClient,
  options: WorkerOptions = {},
): Promise<MemoryWorkerResult> {
  const now = options.now ?? new Date();
  const workerId = options.workerId ?? `worker-${process.pid}-${randomUUID()}`;
  const ownership = ownerFilter(options.ownerId);
  const staleBefore = new Date(now.getTime() - LEASE_MS);

  // Retention jobs are safe to replay: deleting an already deleted message is a no-op.
  // Foreign keys preserve snapshot/source records while nulling links to expired raw messages.
  const cleanupCandidates = await prisma.memoryJob.findMany({
    where: {
      type: "CLEAN_EXPIRED_MESSAGES",
      status: { in: ["QUEUED", "RETRY_WAIT"] },
      runAt: { lte: now },
      ...ownership,
    },
    orderBy: [{ runAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: 20,
    select: { id: true, status: true, memoryScopeId: true, periodEnd: true, attemptCount: true, maxAttempts: true },
  });
  let deferredCleanupResult: MemoryWorkerResult | null = null;
  for (const candidate of cleanupCandidates) {
    if (!candidate.periodEnd) {
      await prisma.memoryJob.updateMany({
        where: { id: candidate.id, status: candidate.status },
        data: { status: "FAILED", completedAt: now, lastError: "原始消息清理任务缺少截止时间。" },
      });
      continue;
    }
    if (candidate.attemptCount >= candidate.maxAttempts) {
      await prisma.memoryJob.updateMany({
        where: { id: candidate.id, status: candidate.status },
        data: {
          status: "FAILED",
          completedAt: now,
          lockedAt: null,
          lockedBy: null,
          lastError: "任务已达到最大尝试次数。",
        },
      });
      continue;
    }
    const claim = await prisma.memoryJob.updateMany({
      where: { id: candidate.id, status: candidate.status, runAt: { lte: now } },
      data: { status: "RUNNING", attemptCount: { increment: 1 }, lockedAt: now, lockedBy: workerId, startedAt: now, lastError: null },
    });
    if (claim.count !== 1) continue;

    const scope = await prisma.memoryScope.findUnique({
      where: { id: candidate.memoryScopeId },
      select: {
        characterId: true,
        character: {
          select: {
            memorySetting: {
              select: {
                rawMessageCleanupEnabled: true,
                rawMessageRetentionDays: true,
              },
            },
          },
        },
      },
    });
    if (!scope) {
      await prisma.memoryJob.updateMany({
        where: { id: candidate.id, status: "RUNNING", lockedBy: workerId },
        data: { status: "FAILED", completedAt: now, lockedAt: null, lockedBy: null, lastError: "找不到清理任务关联的记忆范围。" },
      });
      return { processed: true, jobId: candidate.id, status: "FAILED", message: "找不到清理任务关联的记忆范围。" };
    }

    const currentRetentionDays = scope.character.memorySetting?.rawMessageRetentionDays;
    const currentCutoff = scope.character.memorySetting?.rawMessageCleanupEnabled &&
      currentRetentionDays && currentRetentionDays > 0
      ? new Date(now.getTime() - currentRetentionDays * 24 * 60 * 60 * 1000)
      : null;
    if (!currentCutoff || candidate.periodEnd.getTime() > currentCutoff.getTime()) {
      const reason = !currentCutoff
        ? "当前角色尚未明确授权原始消息自动清理，或已选择永久保留；该旧任务已取消，未删除原始消息。"
        : "原始消息保留期限已放宽，当前任务的截止范围比最新策略更激进；该旧任务已取消，未删除原始消息。";
      const cancelled = await prisma.memoryJob.updateMany({
        where: { id: candidate.id, status: "RUNNING", lockedBy: workerId },
        data: {
          status: "CANCELLED",
          attemptCount: { decrement: 1 },
          completedAt: now,
          lockedAt: null,
          lockedBy: null,
          lastError: reason,
        },
      });
      if (cancelled.count === 1) {
        return { processed: true, jobId: candidate.id, status: "CANCELLED", message: reason };
      }
      continue;
    }

    const pendingSnapshot = await prisma.memoryJob.findFirst({
      where: {
        memoryScopeId: candidate.memoryScopeId,
        type: { in: ["GENERATE_SNAPSHOT", "REGENERATE_SNAPSHOT"] },
        status: { in: ["QUEUED", "RUNNING", "RETRY_WAIT", "FAILED"] },
        periodStart: { lt: candidate.periodEnd },
      },
      select: { id: true },
    });
    if (pendingSnapshot) {
      const deferred = await prisma.memoryJob.updateMany({
        where: { id: candidate.id, status: "RUNNING", lockedBy: workerId },
        data: {
          status: "RETRY_WAIT",
          // This is a dependency wait, not a failed cleanup attempt.
          attemptCount: { decrement: 1 },
          runAt: new Date(now.getTime() + 60_000),
          lockedAt: null,
          lockedBy: null,
          completedAt: null,
          lastError: "仍有更早的归档任务待处理，清理已延后。",
        },
      });
      if (deferred.count === 1) {
        deferredCleanupResult ??= { processed: true, jobId: candidate.id, status: "RETRY_WAIT", message: "仍有过期区间的归档任务待处理，已延后清理。" };
      }
      continue;
    }

    try {
      // Keep the deletion, job completion, and audit record in one transaction.
      // Lock/verify ownership first so a stale or displaced worker cannot delete content.
      const deletedCount = await prisma.$transaction(async (tx) => {
        const claim = await tx.memoryJob.updateMany({
          where: { id: candidate.id, status: "RUNNING", lockedBy: workerId },
          data: { lastError: null },
        });
        if (claim.count !== 1) {
          throw new Error("清理任务租约已失效；拒绝删除原始消息。");
        }
        // Lock the current policy row so a concurrent settings change cannot
        // revoke authorization between this check and the irreversible delete.
        const policyRows = await tx.$queryRaw<Array<{
          rawMessageCleanupEnabled: boolean;
          rawMessageRetentionDays: number | null;
        }>>`
          SELECT "rawMessageCleanupEnabled", "rawMessageRetentionDays"
          FROM "character_memory_settings"
          WHERE "characterId" = ${scope.characterId}::uuid
          FOR UPDATE
        `;
        const latestPolicy = policyRows[0] ?? null;
        const latestRetentionDays = latestPolicy?.rawMessageRetentionDays;
        const latestCutoff = latestPolicy?.rawMessageCleanupEnabled &&
          latestRetentionDays && latestRetentionDays > 0
          ? new Date(now.getTime() - latestRetentionDays * 24 * 60 * 60 * 1000)
          : null;
        if (!latestCutoff || candidate.periodEnd!.getTime() > latestCutoff.getTime()) {
          throw new Error("CLEANUP_POLICY_CHANGED");
        }

        const deleted = await tx.message.deleteMany({
          where: {
            conversation: { is: { memoryScopeId: candidate.memoryScopeId } },
            occurredAt: { lt: candidate.periodEnd! },
          },
        });
        await tx.memoryJob.update({
          where: { id: candidate.id },
          data: { status: "SUCCEEDED", completedAt: now, lockedAt: null, lockedBy: null, lastError: null },
        });
        await tx.auditLog.create({
          data: {
            actorType: "WORKER",
            characterId: scope.characterId,
            action: "message.retention_cleanup",
            entityType: "MemoryScope",
            entityId: candidate.memoryScopeId,
            details: { cutoff: candidate.periodEnd!.toISOString(), deletedMessages: deleted.count, jobId: candidate.id },
          },
        });
        return deleted.count;
      });
      return { processed: true, jobId: candidate.id, status: "SUCCEEDED", message: `原始消息清理完成，删除 ${deletedCount} 条过期消息；阶段总结与来源记录已保留。` };
    } catch (error) {
      if (error instanceof Error && error.message === "CLEANUP_POLICY_CHANGED") {
        const message = "清理策略已变更或尚未授权；该任务已取消，未删除原始消息。";
        const cancelled = await prisma.memoryJob.updateMany({
          where: { id: candidate.id, status: "RUNNING", lockedBy: workerId },
          data: {
            status: "CANCELLED",
            attemptCount: { decrement: 1 },
            runAt: now,
            lockedAt: null,
            lockedBy: null,
            lastError: message,
            completedAt: now,
          },
        });
        if (cancelled.count === 1) {
          return { processed: true, jobId: candidate.id, status: "CANCELLED", message };
        }
        return { processed: false, message: "清理任务状态已变化，未删除原始消息。" };
      }
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 2000);
      const attemptCount = candidate.attemptCount + 1;
      const exhausted = attemptCount >= candidate.maxAttempts;
      const status: "FAILED" | "RETRY_WAIT" = exhausted ? "FAILED" : "RETRY_WAIT";
      const retryDelayMs = Math.min(60 * 60 * 1000, 30_000 * (2 ** Math.max(0, attemptCount - 1)));
      await prisma.memoryJob.updateMany({
        where: { id: candidate.id, status: "RUNNING", lockedBy: workerId },
        data: {
          status,
          runAt: exhausted ? now : new Date(now.getTime() + retryDelayMs),
          lockedAt: null,
          lockedBy: null,
          lastError: exhausted ? `原始消息清理失败，已达到最大尝试次数：${message}` : message,
          completedAt: exhausted ? now : null,
        },
      });
      return {
        processed: true,
        jobId: candidate.id,
        status,
        message: exhausted
          ? `原始消息清理失败，已达到最大尝试次数：${message}`
          : `原始消息清理失败，将稍后重试：${message}`,
      };
    }
  }

  if (deferredCleanupResult) return deferredCleanupResult;

  const staleJobs = await prisma.memoryJob.findMany({
    where: {
      type: { in: ["GENERATE_SNAPSHOT", "REGENERATE_SNAPSHOT", "CLEAN_EXPIRED_MESSAGES"] },
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
      type: { in: ["GENERATE_SNAPSHOT", "REGENERATE_SNAPSHOT"] },
      status: { in: ["QUEUED", "RETRY_WAIT"] },
      runAt: { lte: now },
      ...ownership,
    },
    orderBy: [{ runAt: "asc" }, { periodEnd: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    take: 100,
    select: {
      id: true,
      type: true,
      status: true,
      attemptCount: true,
      maxAttempts: true,
      memoryScope: { select: { character: { select: { modelConfig: true } } } },
    },
  });

  const configuredCandidates = candidates.filter((candidate) => isMemoryModelConfigured(candidate.memoryScope.character.modelConfig));
  if (configuredCandidates.length === 0 && candidates.length > 0) {
    return {
      processed: false,
      message: "待处理阶段总结关联的角色尚未配置模型 API。请打开该角色的 AI 对话 → 模型参数填写 API 地址、Key 和模型名称；任务会保留在队列中。",
    };
  }

  let claimedJobId = "";
  for (const candidate of configuredCandidates) {
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

  if (!claimedJobId) return { processed: false, message: "当前没有可领取的周期归档任务。" };

  try {
    const job = await prisma.memoryJob.findUnique({
      where: { id: claimedJobId },
      select: {
        id: true,
        type: true,
        snapshotId: true,
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

    const isRegeneration = job.type === "REGENERATE_SNAPSHOT";
    let logicalSnapshotKey = job.idempotencyKey;

    if (isRegeneration) {
      if (!job.snapshotId) throw new Error("AI 重新提炼任务缺少原始总结 ID。");
      const regenerationTarget = await prisma.memorySnapshot.findFirst({
        where: { id: job.snapshotId, memoryScopeId: job.memoryScopeId },
        select: { id: true, snapshotKey: true, kind: true, periodStart: true, periodEnd: true },
      });
      if (!regenerationTarget || regenerationTarget.kind !== "AUTOMATIC") {
        throw new Error("AI 重新提炼只能针对仍保留在数据库中的自动归档。");
      }
      if (
        regenerationTarget.periodStart.getTime() !== job.periodStart.getTime() ||
        regenerationTarget.periodEnd.getTime() !== job.periodEnd.getTime()
      ) {
        throw new Error("重新提炼任务的周期范围与原始总结不一致。");
      }
      logicalSnapshotKey = regenerationTarget.snapshotKey;
    } else {
      const priorSnapshot = await prisma.memorySnapshot.findFirst({
        where: { snapshotKey: job.idempotencyKey, memoryScopeId: job.memoryScopeId },
        orderBy: [{ version: "desc" }, { createdAt: "desc" }],
        select: { id: true },
      });
      if (priorSnapshot) {
        await prisma.memoryJob.updateMany({
          where: { id: job.id, status: "RUNNING", lockedBy: workerId },
          data: { status: "SUCCEEDED", snapshotId: priorSnapshot.id, completedAt: now, lockedAt: null, lockedBy: null, lastError: null },
        });
        return { processed: true, jobId: job.id, status: "SUCCEEDED", snapshotId: priorSnapshot.id, message: "检测到相同周期已有总结，已复用历史结果。" };
      }
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

    // 先列本周期内有消息的会话，来源再按会话配额取 —— 不能再用「整个范围按时间取前后各 125 条」：
    // 一个热闹的群就能把私聊整个挤出窗口，总结只剩群里与她无关的闲话。
    // 会话也一样：一对一（私聊/本地）永远排在群聊前面，不能靠 lastMessageAt 硬排 —— 群多了
    // 之后私聊会话会被挤到第 12 名开外，直接从会话级消失。所以非群聊会话先全量取，
    // 剩下的名额再按最近活跃度给群会话。
    const periodBaseWhere = {
      memoryScopeId: job.memoryScopeId,
      messages: { some: { occurredAt: { gte: job.periodStart, lt: job.periodEnd } } },
    };
    const [directConversations, groupConversations] = await Promise.all([
      prisma.conversation.findMany({
        where: { ...periodBaseWhere, OR: [
          { externalConversationId: null },
          { externalConversationId: { startsWith: "c:" } },
        ] },
        orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
        select: { id: true, externalConversationId: true },
      }),
      prisma.conversation.findMany({
        where: { ...periodBaseWhere, externalConversationId: { startsWith: "g:" } },
        orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
        take: MAX_SCOPE_CONVERSATIONS,
        select: { id: true, externalConversationId: true },
      }),
    ]);
    const periodConversations = [...directConversations, ...groupConversations];

    const [messageCount, eventCount, memoryActivityCount, activeItems, scope, previousSnapshot] = await Promise.all([
      prisma.message.count({ where: messageWhere }),
      prisma.message.count({ where: { ...messageWhere, eventType: { not: "message" } } }),
      prisma.memoryItem.count({ where: memoryActivityWhere }),
      prisma.memoryItem.findMany({
        where: {
          memoryScopeId: job.memoryScopeId,
          status: "ACTIVE",
          // AI-created memories use the evidence timestamp as validFrom. Do not
          // filter by createdAt/updatedAt: backfilled jobs may write those later.
          OR: [
            { validFrom: { lte: job.periodEnd } },
            { validFrom: null, createdAt: { lte: job.periodEnd } },
          ],
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: MAX_SOURCE_MEMORIES,
        select: {
          id: true, category: true, content: true, confidence: true,
          validFrom: true, validTo: true, createdAt: true,
        },
      }),
      prisma.memoryScope.findUnique({
        where: { id: job.memoryScopeId },
        select: {
          id: true,
          scopeType: true,
          characterId: true,
          character: { select: { name: true, modelConfig: true, memorySetting: { select: { timezone: true } } } },
        },
      }),
      prisma.memorySnapshot.findFirst({
        where: {
          memoryScopeId: job.memoryScopeId,
          periodEnd: { lte: job.periodStart },
          status: "CURRENT",
        },
        orderBy: [{ periodEnd: "desc" }, { version: "desc" }],
        select: { summary: true, periodEnd: true },
      }),
    ]);

    if (!scope) throw new Error("找不到任务关联的记忆范围。");

    if (messageCount === 0 && memoryActivityCount === 0) {
      await prisma.memoryJob.updateMany({
        where: { id: job.id, status: "RUNNING", lockedBy: workerId },
        data: {
          status: "SKIPPED",
          completedAt: now,
          lastError: "该周期内没有已保存的对话消息、平台事件或长期记忆变更。",
          lockedAt: null,
          lockedBy: null,
        },
      });
      return { processed: true, jobId: job.id, status: "SKIPPED", message: "周期内无已保存活动，已跳过总结生成。" };
    }

    // 按会话配额取来源：每个会话先保住自己最新的一条，再在总预算内按时间填满。
    const sourceMessages = await loadPeriodSourceMessages(
      prisma, periodConversations, job.periodStart, job.periodEnd,
    );
    const aiMessages = selectAiMessages(sourceMessages);
    // activeItems is newest-first, so the model sees the latest memory state.
    const aiMemoryContext = activeItems.slice(0, MAX_AI_MEMORIES).map((item) => ({
      id: item.id,
      category: item.category,
      content: item.content.slice(0, 800),
      confidence: item.confidence,
      validFrom: item.validFrom?.toISOString() ?? null,
      validTo: item.validTo?.toISOString() ?? null,
      createdAt: item.createdAt.toISOString(),
    }));

    // The model call deliberately happens outside a database transaction.
    const chatSettings = resolveChatModelSettings(scope.character.modelConfig);
    const apiKey = await resolveCharacterApiKey(scope.character.modelConfig, chatSettings.apiBaseUrl);
    if (!apiKey || !chatSettings.model) {
      throw new Error("角色尚未配置模型 API。请先在角色的 AI 对话 → 模型参数中填写 API Key 与模型名称。");
    }
    const aiResult = await analyzeMemoryPeriod({
      apiKey,
      apiBaseUrl: chatSettings.apiBaseUrl,
      model: chatSettings.model,
      periodStart: job.periodStart.toISOString(),
      periodEnd: job.periodEnd.toISOString(),
      timezone: scope.character.memorySetting?.timezone ?? "UTC",
      scopeType: scope.scopeType,
      characterName: scope.character.name,
      messages: aiMessages,
      totalMessageCount: messageCount,
      omittedMessageCount: Math.max(0, messageCount - aiMessages.length),
      activeMemories: aiMemoryContext,
      previousSnapshotSummary: previousSnapshot?.summary ?? null,
    });

    // 记账放在事务之前：模型已经调用过，后面事务失败也不能漏掉这笔花费。
    await recordModelUsage({
      kind: "snapshot",
      model: chatSettings.model,
      usage: toUsageTokens(aiResult.usage),
      characterId: scope.characterId,
    });

    const outcome = await prisma.$transaction(async (tx) => {
      const latestJob = await tx.memoryJob.findUnique({
        where: { id: job.id },
        select: { status: true, lockedBy: true },
      });
      if (latestJob?.status !== "RUNNING" || latestJob.lockedBy !== workerId) {
        throw new Error("任务租约已失效；拒绝提交模型结果。");
      }

      if (!isRegeneration) {
        const racedSnapshot = await tx.memorySnapshot.findFirst({
          where: { snapshotKey: job.idempotencyKey, memoryScopeId: job.memoryScopeId },
          orderBy: [{ version: "desc" }, { createdAt: "desc" }],
          select: { id: true },
        });
        if (racedSnapshot) {
          await tx.memoryJob.update({
            where: { id: job.id },
            data: { status: "SUCCEEDED", snapshotId: racedSnapshot.id, completedAt: now, lockedAt: null, lockedBy: null, lastError: null },
          });
          return { status: "SUCCEEDED" as const, snapshotId: racedSnapshot.id, message: "同一周期已由其他执行完成，复用已有总结。" };
        }
      }

      const latestSnapshot = await tx.memorySnapshot.findFirst({
        where: { snapshotKey: logicalSnapshotKey, memoryScopeId: job.memoryScopeId },
        orderBy: [{ version: "desc" }, { createdAt: "desc" }],
        select: { version: true },
      });
      const nextSnapshotVersion = isRegeneration ? (latestSnapshot?.version ?? 0) + 1 : 1;

      if (isRegeneration) {
        await tx.memorySnapshot.updateMany({
          where: { snapshotKey: logicalSnapshotKey, memoryScopeId: job.memoryScopeId, status: "CURRENT" },
          data: { status: "SUPERSEDED" },
        });
      }
      const structuredContent = {
        generatedBy: "llm",
        generationMode: isRegeneration ? "REGENERATE" : "GENERATE",
        capturedAt: now.toISOString(),
        period: {
          start: job.periodStart!.toISOString(),
          end: job.periodEnd!.toISOString(),
          timezone: scope.character.memorySetting?.timezone ?? "UTC",
          interval: "[start, end)",
        },
        counts: {
          messageCount,
          eventCount,
          storedSourceMessageCount: sourceMessages.length,
          aiAnalyzedMessageCount: aiMessages.length,
          omittedMessageCount: Math.max(0, messageCount - aiMessages.length),
          memoryActivityCount,
        },
        model: {
          name: aiResult.model,
          provider: aiResult.provider,
          promptTemplateVersion: aiResult.promptTemplateVersion,
          ...(aiResult.usage ? { usage: aiResult.usage } : {}),
        },
        analysis: aiResult.analysis,
        activeMemoriesConsidered: aiMemoryContext.map((item) => item.id),
        memoryChangesApplied: [] as Array<Record<string, unknown>>,
        note: isRegeneration
          ? "AI 重新提炼版本；为避免历史重放改写当前长期记忆，本次提出的长期记忆变化仅供审核，不会自动应用。"
          : "AI 提炼结果；每条被采纳的新长期记忆都关联至少一条本周期原始消息。",
      };

      const snapshot = await tx.memorySnapshot.create({
        data: {
          snapshotKey: logicalSnapshotKey,
          memoryScopeId: job.memoryScopeId,
          kind: "AUTOMATIC",
          version: nextSnapshotVersion,
          periodStart: job.periodStart!,
          periodEnd: job.periodEnd!,
          summary: aiResult.analysis.summary,
          structuredContent: structuredContent as never,
          status: "CURRENT",
          modelMetadata: {
            provider: aiResult.provider,
            model: aiResult.model,
            promptTemplateVersion: aiResult.promptTemplateVersion,
            ...(aiResult.usage ? { usage: aiResult.usage } : {}),
          },
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

      const currentItems = new Map(activeItems.map((item) => [item.id, item]));
      const eligibleModelMemoryIds = new Set(aiMemoryContext.map((item) => item.id));
      const handledMemoryIds = new Set<string>();
      const appliedChanges: Array<Record<string, unknown>> = [];
      const messagesById = new Map(sourceMessages.map((message) => [message.id, message]));
      const existingDedupeKeys = new Set<string>();
      const existingItemSignatures = new Set(
        activeItems.map((item) => item.category + ":" + normalizeMemoryText(item.content)),
      );

      // 模型提出但没通过校验的条数。没有这个数字，人分不清「模型没提」和「提了但不合格」。
      let rejectedChangeCount = 0;

      for (const change of aiResult.analysis.memoryChanges) {
        // 置信度门槛必须排在重新提炼分支之前：审核清单是最需要人看的一份数据，
        // 不能变成唯一一条绕过 MIN_MEMORY_CONFIDENCE 的路径。
        if (!validConfidence(change)) {
          rejectedChangeCount += 1;
          continue;
        }
        const evidence = change.evidenceMessageIds
          .map((id) => messagesById.get(id))
          .filter((message): message is NonNullable<typeof message> => Boolean(message));
        if (evidence.length === 0) {
          rejectedChangeCount += 1;
          continue;
        }

        if (isRegeneration) {
          // relatedMemoryId 已由 memory-ai 校验过属于本轮输入记忆，直接取当期快照里的原文做对照。
          const relatedItem = change.relatedMemoryId ? currentItems.get(change.relatedMemoryId) ?? null : null;
          appliedChanges.push({
            action: change.action,
            result: "NOT_APPLIED_REGENERATION",
            category: change.category,
            content: change.content,
            confidence: change.confidence,
            // 只留本周期真实存在、能回溯到原文的证据，UI 的「依据 #N」才对得上来源列表。
            evidenceMessageIds: evidence.map((message) => message.id),
            ...(change.relatedMemoryId ? { supersededMemoryId: change.relatedMemoryId } : {}),
            ...(relatedItem
              ? { supersededCategory: relatedItem.category, supersededContent: relatedItem.content }
              : {}),
          });
          continue;
        }

        const applied = await applyMemoryChange(
          tx,
          {
            memoryScopeId: job.memoryScopeId,
            characterId: scope.characterId,
            snapshotId: snapshot.id,
            actorType: "WORKER",
            auditActionPrefix: "memory.ai_",
            // 自动生成用周期时点的记忆快照做对照；人工采纳才用数据库里的最新值。
            resolvePrevious: async (memoryId) => currentItems.get(memoryId) ?? null,
            canTarget: (memoryId) => eligibleModelMemoryIds.has(memoryId),
            handledMemoryIds,
            existingItemSignatures,
            existingDedupeKeys,
          },
          change,
          evidence,
        );
        if (applied) appliedChanges.push(applied);
      }

      // Keep applied mutation results with the immutable snapshot used to produce them.
      const finalStructuredContent = {
        ...structuredContent,
        memoryChangesApplied: appliedChanges,
        memoryChangesRejected: rejectedChangeCount,
      };
      await tx.memorySnapshot.update({
        where: { id: snapshot.id },
        data: { structuredContent: finalStructuredContent as never },
      });

      if (isRegeneration) {
        await tx.auditLog.create({
          data: { actorType: "WORKER", characterId: scope.characterId, action: "snapshot.ai_regenerated", entityType: "MemorySnapshot", entityId: snapshot.id, details: { previousSnapshotId: job.snapshotId, version: nextSnapshotVersion, periodStart: job.periodStart!.toISOString(), periodEnd: job.periodEnd!.toISOString(), memoryChangesApplied: false } },
        });
      }

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
      return {
        status: "SUCCEEDED" as const,
        snapshotId: snapshot.id,
        message: isRegeneration
          ? `AI 重新提炼完成，已创建版本 ${nextSnapshotVersion}；长期记忆变化仅供审核，未自动应用。`
          : `AI 阶段总结已生成；应用 ${appliedChanges.length} 项长期记忆变化。`
      };
    });

    return { processed: true, jobId: job.id, ...outcome };
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
