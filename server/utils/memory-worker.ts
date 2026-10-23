import { resolveChatModelSettings } from "./chat-model-config";
import { resolveCharacterApiKey } from "./credential-encryption";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../../src/generated/prisma/client";
import {
  analyzeMemoryPeriod,
  isMemoryModelConfigured,
  makeMemoryDedupeKey,
  type MemoryAiMessage,
  type MemoryCategoryValue,
  type MemoryChange,
} from "./memory-ai";

const LEASE_MS = 5 * 60 * 1000;
const MAX_SOURCE_MESSAGES = 250;
const SOURCE_MESSAGE_WINDOW = MAX_SOURCE_MESSAGES / 2;
const MAX_SOURCE_MEMORIES = 250;
const MAX_AI_MESSAGES = 120;
const MAX_AI_MEMORIES = 80;
const MIN_MEMORY_CONFIDENCE = 0.65;

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

function selectAiMessages(messages: Array<{
  id: string; role: string; eventType: string; content: string; occurredAt: Date;
}>): MemoryAiMessage[] {
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
  }));
}

function normalizeMemoryText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, " ").trim();
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

  const staleJobs = await prisma.memoryJob.findMany({
    where: {
      type: { in: ["GENERATE_SNAPSHOT", "REGENERATE_SNAPSHOT"] },
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
      message: "待处理快照关联的角色尚未配置模型 API。请打开该角色的 AI 对话 → 模型参数填写 API 地址、Key 和模型名称；任务会保留在队列中。",
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

  if (!claimedJobId) return { processed: false, message: "当前没有可领取的周期快照任务。" };

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
      if (!job.snapshotId) throw new Error("AI 快照重新提炼任务缺少原始快照 ID。");
      const regenerationTarget = await prisma.memorySnapshot.findFirst({
        where: { id: job.snapshotId, memoryScopeId: job.memoryScopeId },
        select: { id: true, snapshotKey: true, kind: true, periodStart: true, periodEnd: true },
      });
      if (!regenerationTarget || regenerationTarget.kind !== "AUTOMATIC") {
        throw new Error("AI 快照重新提炼只能针对仍保留在数据库中的自动快照。");
      }
      if (
        regenerationTarget.periodStart.getTime() !== job.periodStart.getTime() ||
        regenerationTarget.periodEnd.getTime() !== job.periodEnd.getTime()
      ) {
        throw new Error("重新提炼任务的周期范围与原始快照不一致。");
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
        return { processed: true, jobId: job.id, status: "SUCCEEDED", snapshotId: priorSnapshot.id, message: "检测到相同周期已有快照，已复用历史结果。" };
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

    const [messageCount, eventCount, sourceMessagesFirst, sourceMessagesLast, memoryActivityCount, activeItems, scope, previousSnapshot] = await Promise.all([
      prisma.message.count({ where: messageWhere }),
      prisma.message.count({ where: { ...messageWhere, eventType: { not: "message" } } }),
      prisma.message.findMany({
        where: messageWhere,
        orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
        take: SOURCE_MESSAGE_WINDOW,
        select: { id: true, role: true, eventType: true, content: true, occurredAt: true },
      }),
      prisma.message.findMany({
        where: messageWhere,
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: SOURCE_MESSAGE_WINDOW,
        select: { id: true, role: true, eventType: true, content: true, occurredAt: true },
      }),
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
      return { processed: true, jobId: job.id, status: "SKIPPED", message: "周期内无已保存活动，已跳过快照生成。" };
    }

    // Keep the oldest and newest source messages in long periods, instead of silently
    // analyzing only the first 250 and missing the period's later conversations.
    const sourceMessages = [...new Map(
      [...sourceMessagesFirst, ...sourceMessagesLast].map((message) => [message.id, message]),
    ).values()].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id));
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
          return { status: "SUCCEEDED" as const, snapshotId: racedSnapshot.id, message: "同一周期已由其他执行完成，复用已有快照。" };
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

      for (const change of aiResult.analysis.memoryChanges) {
        if (isRegeneration) {
          appliedChanges.push({ action: change.action, result: "NOT_APPLIED_REGENERATION", category: change.category, content: change.content, confidence: change.confidence, evidenceMessageIds: change.evidenceMessageIds, ...(change.relatedMemoryId ? { relatedMemoryId: change.relatedMemoryId } : {}) });
          continue;
        }
        if (!validConfidence(change)) continue;
        const evidence = change.evidenceMessageIds
          .map((id) => messagesById.get(id))
          .filter((message): message is NonNullable<typeof message> => Boolean(message));
        if (evidence.length === 0) continue;
        const primaryEvidence = [...evidence].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())[0]!;
        const validFrom = primaryEvidence.occurredAt;
        const relatedId = change.relatedMemoryId;

        if (change.action === "ADD") {
          const signature = change.category + ":" + normalizeMemoryText(change.content);
          if (existingItemSignatures.has(signature)) {
            appliedChanges.push({
              action: "ADD",
              result: "DUPLICATE_IGNORED",
              category: change.category,
              content: change.content,
              evidenceMessageIds: change.evidenceMessageIds,
            });
            continue;
          }

          const dedupeKey = makeMemoryDedupeKey(change.category, change.content);
          const keyUsed = existingDedupeKeys.has(dedupeKey) || Boolean(await tx.memoryItem.findFirst({
            where: { memoryScopeId: job.memoryScopeId, dedupeKey },
            select: { id: true },
          }));
          existingDedupeKeys.add(dedupeKey);
          const created = await tx.memoryItem.create({
            data: {
              memoryScopeId: job.memoryScopeId,
              category: change.category as MemoryCategoryValue,
              content: change.content,
              confidence: change.confidence,
              status: "ACTIVE",
              validFrom,
              sourceMessageId: primaryEvidence.id,
              sourceSnapshotId: snapshot.id,
              dedupeKey: keyUsed ? null : dedupeKey,
            },
            select: { id: true },
          });
          existingItemSignatures.add(signature);
          await tx.auditLog.create({
            data: {
              actorType: "WORKER",
              characterId: scope.characterId,
              action: "memory.ai_added",
              entityType: "MemoryItem",
              entityId: created.id,
              details: {
                category: change.category,
                confidence: change.confidence,
                evidenceMessageIds: change.evidenceMessageIds,
                snapshotId: snapshot.id,
              },
            },
          });
          appliedChanges.push({
            action: "ADD",
            result: "CREATED",
            memoryItemId: created.id,
            category: change.category,
            content: change.content,
            confidence: change.confidence,
            evidenceMessageIds: change.evidenceMessageIds,
          });
          continue;
        }

        if (!relatedId || handledMemoryIds.has(relatedId) || !eligibleModelMemoryIds.has(relatedId)) continue;
        const previous = currentItems.get(relatedId);
        if (!previous) continue;

        if (change.action === "INVALIDATE") {
          const invalidated = await tx.memoryItem.updateMany({
            where: { id: relatedId, memoryScopeId: job.memoryScopeId, status: "ACTIVE" },
            data: { status: "INVALIDATED", validTo: primaryEvidence.occurredAt },
          });
          if (invalidated.count !== 1) continue;
          handledMemoryIds.add(relatedId);
          await tx.auditLog.create({
            data: {
              actorType: "WORKER",
              characterId: scope.characterId,
              action: "memory.ai_invalidated",
              entityType: "MemoryItem",
              entityId: relatedId,
              details: {
                reason: change.changeReason ?? change.content,
                confidence: change.confidence,
                evidenceMessageIds: change.evidenceMessageIds,
                snapshotId: snapshot.id,
              },
            },
          });
          appliedChanges.push({
            action: "INVALIDATE",
            result: "INVALIDATED",
            memoryItemId: relatedId,
            content: change.content,
            evidenceMessageIds: change.evidenceMessageIds,
          });
          continue;
        }

        if (
          change.action === "UPDATE" &&
          (previous.category !== change.category || normalizeMemoryText(previous.content) !== normalizeMemoryText(change.content))
        ) {
          const superseded = await tx.memoryItem.updateMany({
            where: { id: relatedId, memoryScopeId: job.memoryScopeId, status: "ACTIVE" },
            data: { status: "SUPERSEDED", validTo: primaryEvidence.occurredAt },
          });
          if (superseded.count !== 1) continue;
          handledMemoryIds.add(relatedId);
          const dedupeKey = makeMemoryDedupeKey(change.category, change.content);
          const keyUsed = existingDedupeKeys.has(dedupeKey) || Boolean(await tx.memoryItem.findFirst({
            where: { memoryScopeId: job.memoryScopeId, dedupeKey },
            select: { id: true },
          }));
          existingDedupeKeys.add(dedupeKey);
          const created = await tx.memoryItem.create({
            data: {
              memoryScopeId: job.memoryScopeId,
              category: change.category as MemoryCategoryValue,
              content: change.content,
              confidence: change.confidence,
              status: "ACTIVE",
              validFrom,
              sourceMessageId: primaryEvidence.id,
              sourceSnapshotId: snapshot.id,
              dedupeKey: keyUsed ? null : dedupeKey,
            },
            select: { id: true },
          });
          existingItemSignatures.add(change.category + ":" + normalizeMemoryText(change.content));
          await tx.auditLog.create({
            data: {
              actorType: "WORKER",
              characterId: scope.characterId,
              action: "memory.ai_updated",
              entityType: "MemoryItem",
              entityId: created.id,
              details: {
                supersededMemoryId: relatedId,
                previousContent: previous.content.slice(0, 1000),
                newContent: change.content,
                confidence: change.confidence,
                evidenceMessageIds: change.evidenceMessageIds,
                snapshotId: snapshot.id,
              },
            },
          });
          appliedChanges.push({
            action: "UPDATE",
            result: "REPLACED",
            memoryItemId: created.id,
            supersededMemoryId: relatedId,
            category: change.category,
            content: change.content,
            confidence: change.confidence,
            evidenceMessageIds: change.evidenceMessageIds,
          });
        }
      }

      // Keep applied mutation results with the immutable snapshot used to produce them.
      const finalStructuredContent = {
        ...structuredContent,
        memoryChangesApplied: appliedChanges,
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
          ? `AI 快照重新提炼完成，已创建版本 ${nextSnapshotVersion}；长期记忆变化仅供审核，未自动应用。`
          : `AI 周期总结已生成；应用 ${appliedChanges.length} 项长期记忆变化。`
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
