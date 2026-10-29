import type { Prisma } from "../../src/generated/prisma/client";
import { makeMemoryDedupeKey, type MemoryCategoryValue, type MemoryChange } from "./memory-ai";

/**
 * 单条长期记忆变更的落库逻辑。
 *
 * 抽出来的原因：同一条模型建议有两条执行路径 —— Worker 自动生成时直接应用，
 * 人工在阶段总结详情里「采纳」时按需应用。两套实现迟早会漂移，
 * 所以落库、去重、审计都在这里，两边只负责决定「要不要调」。
 */

export type MemoryApplyTx = Prisma.TransactionClient;

export type MemoryEvidenceMessage = {
  id: string;
  occurredAt: Date;
};

export type MemoryApplyContext = {
  memoryScopeId: string;
  characterId: string;
  snapshotId: string;
  actorType: "WORKER" | "USER";
  /** 审计动作前缀：自动生成 `memory.ai_`，人工采纳 `memory.review_`。 */
  auditActionPrefix: "memory.ai_" | "memory.review_";
  actorId?: string | null;
  /**
   * 目标记忆的「当前状态」。Worker 用周期时点的快照，人工采纳用数据库里最新的值 ——
   * 中间可能有别的归档改过这条记忆，对照的基准不该是旧的。
   */
  resolvePrevious: (memoryId: string) => Promise<{ category: MemoryCategoryValue; content: string } | null>;
  /** 是否允许把变更指向这条记忆（Worker 限制在模型看过的集合内；人工采纳不限制）。 */
  canTarget: (memoryId: string) => boolean;
  handledMemoryIds: Set<string>;
  existingItemSignatures: Set<string>;
  existingDedupeKeys: Set<string>;
};

export function normalizeMemoryText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, " ").trim();
}

type ApplyResult = Record<string, unknown>;

/**
 * 应用一条变更。返回 null 表示这条被跳过（目标记忆不可用、已被同一轮处理过、
 * 或者内容与现状相同），调用方不应把它算作已应用。
 */
export async function applyMemoryChange(
  tx: MemoryApplyTx,
  ctx: MemoryApplyContext,
  change: MemoryChange,
  evidence: MemoryEvidenceMessage[],
): Promise<ApplyResult | null> {
  if (evidence.length === 0) return null;
  const primaryEvidence = [...evidence].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())[0]!;
  const validFrom = primaryEvidence.occurredAt;
  const relatedId = change.relatedMemoryId;
  const auditActor = ctx.actorType === "USER" && ctx.actorId
    ? { actorType: "USER" as const, actorId: ctx.actorId }
    : { actorType: ctx.actorType };

  if (change.action === "ADD") {
    const signature = change.category + ":" + normalizeMemoryText(change.content);
    if (ctx.existingItemSignatures.has(signature)) {
      return {
        action: "ADD",
        result: "DUPLICATE_IGNORED",
        category: change.category,
        content: change.content,
        evidenceMessageIds: change.evidenceMessageIds,
      };
    }

    const dedupeKey = makeMemoryDedupeKey(change.category, change.content);
    const keyUsed = ctx.existingDedupeKeys.has(dedupeKey) || Boolean(await tx.memoryItem.findFirst({
      where: { memoryScopeId: ctx.memoryScopeId, dedupeKey },
      select: { id: true },
    }));
    ctx.existingDedupeKeys.add(dedupeKey);
    const created = await tx.memoryItem.create({
      data: {
        memoryScopeId: ctx.memoryScopeId,
        category: change.category as MemoryCategoryValue,
        content: change.content,
        confidence: change.confidence,
        status: "ACTIVE",
        validFrom,
        sourceMessageId: primaryEvidence.id,
        sourceSnapshotId: ctx.snapshotId,
        dedupeKey: keyUsed ? null : dedupeKey,
      },
      select: { id: true },
    });
    ctx.existingItemSignatures.add(signature);
    await tx.auditLog.create({
      data: {
        ...auditActor,
        characterId: ctx.characterId,
        action: ctx.auditActionPrefix + "added",
        entityType: "MemoryItem",
        entityId: created.id,
        details: {
          category: change.category,
          confidence: change.confidence,
          evidenceMessageIds: change.evidenceMessageIds,
          snapshotId: ctx.snapshotId,
        },
      },
    });
    return {
      action: "ADD",
      result: "CREATED",
      memoryItemId: created.id,
      category: change.category,
      content: change.content,
      confidence: change.confidence,
      evidenceMessageIds: change.evidenceMessageIds,
    };
  }

  if (!relatedId || ctx.handledMemoryIds.has(relatedId) || !ctx.canTarget(relatedId)) return null;
  const previous = await ctx.resolvePrevious(relatedId);
  if (!previous) return null;

  if (change.action === "INVALIDATE") {
    const invalidated = await tx.memoryItem.updateMany({
      where: { id: relatedId, memoryScopeId: ctx.memoryScopeId, status: "ACTIVE" },
      data: { status: "INVALIDATED", validTo: primaryEvidence.occurredAt },
    });
    if (invalidated.count !== 1) return null;
    ctx.handledMemoryIds.add(relatedId);
    await tx.auditLog.create({
      data: {
        ...auditActor,
        characterId: ctx.characterId,
        action: ctx.auditActionPrefix + "invalidated",
        entityType: "MemoryItem",
        entityId: relatedId,
        details: {
          reason: change.changeReason ?? change.content,
          confidence: change.confidence,
          evidenceMessageIds: change.evidenceMessageIds,
          snapshotId: ctx.snapshotId,
        },
      },
    });
    return {
      action: "INVALIDATE",
      result: "INVALIDATED",
      memoryItemId: relatedId,
      content: change.content,
      evidenceMessageIds: change.evidenceMessageIds,
    };
  }

  if (
    change.action === "UPDATE" &&
    (previous.category !== change.category || normalizeMemoryText(previous.content) !== normalizeMemoryText(change.content))
  ) {
    const superseded = await tx.memoryItem.updateMany({
      where: { id: relatedId, memoryScopeId: ctx.memoryScopeId, status: "ACTIVE" },
      data: { status: "SUPERSEDED", validTo: primaryEvidence.occurredAt },
    });
    if (superseded.count !== 1) return null;
    ctx.handledMemoryIds.add(relatedId);
    const dedupeKey = makeMemoryDedupeKey(change.category, change.content);
    const keyUsed = ctx.existingDedupeKeys.has(dedupeKey) || Boolean(await tx.memoryItem.findFirst({
      where: { memoryScopeId: ctx.memoryScopeId, dedupeKey },
      select: { id: true },
    }));
    ctx.existingDedupeKeys.add(dedupeKey);
    const created = await tx.memoryItem.create({
      data: {
        memoryScopeId: ctx.memoryScopeId,
        category: change.category as MemoryCategoryValue,
        content: change.content,
        confidence: change.confidence,
        status: "ACTIVE",
        validFrom,
        sourceMessageId: primaryEvidence.id,
        sourceSnapshotId: ctx.snapshotId,
        dedupeKey: keyUsed ? null : dedupeKey,
      },
      select: { id: true },
    });
    ctx.existingItemSignatures.add(change.category + ":" + normalizeMemoryText(change.content));
    await tx.auditLog.create({
      data: {
        ...auditActor,
        characterId: ctx.characterId,
        action: ctx.auditActionPrefix + "updated",
        entityType: "MemoryItem",
        entityId: created.id,
        details: {
          supersededMemoryId: relatedId,
          previousContent: previous.content.slice(0, 1000),
          newContent: change.content,
          confidence: change.confidence,
          evidenceMessageIds: change.evidenceMessageIds,
          snapshotId: ctx.snapshotId,
        },
      },
    });
    return {
      action: "UPDATE",
      result: "REPLACED",
      memoryItemId: created.id,
      supersededMemoryId: relatedId,
      category: change.category,
      content: change.content,
      confidence: change.confidence,
      evidenceMessageIds: change.evidenceMessageIds,
    };
  }

  return null;
}
