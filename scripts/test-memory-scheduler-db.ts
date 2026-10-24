import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { enqueueDueMemorySnapshots } from "../server/utils/memory-scheduler";
import { processNextMemoryJob } from "../server/utils/memory-worker";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL，数据库集成测试无法运行。");

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });
const suffix = randomUUID();
const ownerId = randomUUID();
const characterId = randomUUID();
const scopeId = randomUUID();
const retentionScopeId = randomUUID();
const conversationId = randomUUID();
const blockedConversationId = randomUUID();
const username = `scheduler-test-${suffix}`;
const now = new Date("2026-10-24T12:00:00.000Z");
const nextSnapshotAt = new Date("2026-10-01T00:00:00.000Z");
const expectedNextSnapshotAt = new Date("2026-10-25T00:00:00.000Z");

try {
  await prisma.user.create({
    data: {
      id: ownerId,
      username,
      passwordHash: "integration-test-only",
    },
  });
  await prisma.character.create({
    data: {
      id: characterId,
      ownerId,
      name: "调度器集成测试角色",
      basePrompt: "仅用于自动化测试。",
      modelConfig: {
        chatModel: "integration-test-model",
        chatApiBaseUrl: "http://127.0.0.1:4010/v1",
        chatApiKeyEncrypted: "v1.integration-test-placeholder",
      },
    },
  });
  await prisma.memoryScope.create({
    data: {
      id: scopeId,
      characterId,
      scopeType: "CHARACTER_GLOBAL",
      scopeKey: `scheduler-test:${suffix}`,
    },
  });
  await prisma.characterMemorySetting.create({
    data: {
      characterId,
      snapshotIntervalDays: 8,
      anchorAt: new Date("2026-09-23T00:00:00.000Z"),
      nextSnapshotAt,
      autoSnapshotEnabled: true,
      rawMessageRetentionDays: 30,
    },
  });

  // This message falls in the failed overdue snapshot's period and before the cleanup cutoff.
  await prisma.conversation.create({
    data: {
      id: blockedConversationId,
      characterId,
      memoryScopeId: scopeId,
      title: "失败快照阻塞清理集成测试",
    },
  });
  const blockedExpiredMessage = await prisma.message.create({
    data: {
      conversationId: blockedConversationId,
      role: "USER",
      eventType: "message",
      content: "较早快照失败时，这条尚待归档的过期原文也必须保留。",
      occurredAt: new Date("2026-09-24T00:00:00.000Z"),
    },
    select: { id: true },
  });

  // Two schedulers starting together must not lose the cursor or duplicate cycle jobs.
  await Promise.all([
    enqueueDueMemorySnapshots(prisma, { now }),
    enqueueDueMemorySnapshots(prisma, { now }),
  ]);

  const jobs = await prisma.memoryJob.findMany({
    where: { memoryScopeId: scopeId, type: "GENERATE_SNAPSHOT" },
    orderBy: { periodEnd: "asc" },
    select: { idempotencyKey: true, periodStart: true, periodEnd: true },
  });
  assert.equal(jobs.length, 3, "Concurrent scheduler runs must enqueue each overdue cycle exactly once.");
  assert.equal(new Set(jobs.map((job) => job.idempotencyKey)).size, 3, "Each overdue cycle must have a unique idempotency key.");
  assert.deepEqual(
    jobs.map((job) => job.periodEnd.toISOString()),
    [
      "2026-10-01T00:00:00.000Z",
      "2026-10-09T00:00:00.000Z",
      "2026-10-17T00:00:00.000Z",
    ],
    "Backfill must enqueue every due period in chronological order.",
  );

  const settingAfterConcurrentRuns = await prisma.characterMemorySetting.findUniqueOrThrow({
    where: { characterId },
    select: { nextSnapshotAt: true },
  });
  assert.equal(
    settingAfterConcurrentRuns.nextSnapshotAt?.toISOString(),
    expectedNextSnapshotAt.toISOString(),
    "Concurrent scheduler runs must advance the cycle cursor exactly once past the overdue periods.",
  );

  // Re-running at the same instant should be a no-op.
  const repeatedRun = await enqueueDueMemorySnapshots(prisma, { now });
  const jobsAfterRepeatedRun = await prisma.memoryJob.count({
    where: { memoryScopeId: scopeId, type: "GENERATE_SNAPSHOT" },
  });
  assert.equal(repeatedRun.jobsQueued, 0, "A repeated scheduler pass must not enqueue duplicates.");
  assert.equal(jobsAfterRepeatedRun, 3, "A repeated scheduler pass must preserve the one-job-per-period invariant.");

  // Simulate a retry/replay after the snapshot was committed but before the job was marked complete.
  const firstJob = jobs[0]!;
  const existingSnapshot = await prisma.memorySnapshot.create({
    data: {
      snapshotKey: firstJob.idempotencyKey,
      memoryScopeId: scopeId,
      kind: "AUTOMATIC",
      version: 1,
      periodStart: firstJob.periodStart,
      periodEnd: firstJob.periodEnd,
      summary: "集成测试中预先保存的快照",
      structuredContent: {},
      status: "CURRENT",
    },
    select: { id: true },
  });
  const workerResult = await processNextMemoryJob(prisma, {
    now,
    workerId: `integration-worker-${suffix}`,
  });
  assert.equal(workerResult.processed, true, "Worker should claim the queued replay job.");
  assert.equal(workerResult.status, "SUCCEEDED", "Worker should mark a replay as successful when its snapshot already exists.");
  assert.equal(
    workerResult.snapshotId,
    existingSnapshot.id,
    "Worker should reuse the existing snapshot rather than creating a second copy.",
  );
  const snapshotCount = await prisma.memorySnapshot.count({
    where: { memoryScopeId: scopeId, snapshotKey: firstJob.idempotencyKey },
  });
  assert.equal(snapshotCount, 1, "Worker replay must not create a duplicate snapshot.");

  // Retention cleanup must delete expired raw messages but preserve snapshot/source/memory records.
  await prisma.memoryScope.create({
    data: {
      id: retentionScopeId,
      characterId,
      scopeType: "CHARACTER_GLOBAL",
      scopeKey: `retention-test:${suffix}`,
    },
  });
  await prisma.conversation.create({
    data: {
      id: conversationId,
      characterId,
      memoryScopeId: retentionScopeId,
      title: "原始消息保留策略集成测试",
    },
  });
  const expiredMessage = await prisma.message.create({
    data: {
      conversationId,
      role: "USER",
      eventType: "message",
      content: "这条过期原文应该被清理，但其来源记录要保留。",
      occurredAt: new Date("2026-08-01T00:00:00.000Z"),
    },
    select: { id: true },
  });
  const retainedMessage = await prisma.message.create({
    data: {
      conversationId,
      role: "ASSISTANT",
      eventType: "message",
      content: "这条未过期原文必须保留。",
      occurredAt: new Date("2026-10-20T00:00:00.000Z"),
    },
    select: { id: true },
  });
  const retentionSnapshot = await prisma.memorySnapshot.create({
    data: {
      snapshotKey: `retention-test:${suffix}`,
      memoryScopeId: retentionScopeId,
      kind: "AUTOMATIC",
      version: 1,
      periodStart: new Date("2026-07-01T00:00:00.000Z"),
      periodEnd: new Date("2026-08-31T00:00:00.000Z"),
      summary: "用于验证原文清理后快照仍然存在。",
      structuredContent: {},
      status: "CURRENT",
    },
    select: { id: true },
  });
  const sourceRecord = await prisma.memorySnapshotSource.create({
    data: {
      snapshotId: retentionSnapshot.id,
      sourceType: "MESSAGE",
      sourceRef: expiredMessage.id,
      messageId: expiredMessage.id,
    },
    select: { id: true },
  });
  const memoryItem = await prisma.memoryItem.create({
    data: {
      memoryScopeId: retentionScopeId,
      category: "FACT",
      content: "集成测试中的长期记忆。",
      status: "ACTIVE",
      sourceMessageId: expiredMessage.id,
      sourceSnapshotId: retentionSnapshot.id,
      validFrom: new Date("2026-08-01T00:00:00.000Z"),
    },
    select: { id: true },
  });
  // Leave one failed overdue period in the primary scope to assert cleanup is conservatively blocked there.
  await prisma.memoryJob.update({
    where: { idempotencyKey: firstJob.idempotencyKey },
    data: { status: "FAILED", completedAt: now, lastError: "集成测试：模拟失败的逾期快照。" },
  });

  // Disable automatic snapshots only after scheduler/backfill assertions; retention remains enabled.
  await prisma.characterMemorySetting.update({
    where: { characterId },
    data: { autoSnapshotEnabled: false },
  });
  await enqueueDueMemorySnapshots(prisma, { now });
  const blockedCleanupJob = await prisma.memoryJob.findUniqueOrThrow({
    where: { idempotencyKey: `clean-expired-messages:${scopeId}:2026-09-24` },
    select: { id: true, memoryScopeId: true },
  });
  const cleanupJob = await prisma.memoryJob.findUniqueOrThrow({
    where: { idempotencyKey: `clean-expired-messages:${retentionScopeId}:2026-09-24` },
    select: { id: true, memoryScopeId: true },
  });
  assert.equal(cleanupJob.memoryScopeId, retentionScopeId, "Scheduler should enqueue cleanup for scopes whose retention period has expired.");

  // Make ordering deterministic: the scope with an unresolved older snapshot is examined first.
  await prisma.memoryJob.update({
    where: { id: blockedCleanupJob.id },
    data: { runAt: new Date(now.getTime() - 2_000) },
  });
  await prisma.memoryJob.update({
    where: { id: cleanupJob.id },
    data: { runAt: new Date(now.getTime() - 1_000) },
  });
  const cleanupResult = await processNextMemoryJob(prisma, {
    now,
    workerId: `retention-worker-${suffix}`,
  });
  assert.equal(cleanupResult.processed, true, "Worker should process a due retention cleanup job.");
  assert.equal(cleanupResult.status, "SUCCEEDED", "Retention cleanup should complete successfully.");
  assert.equal(await prisma.message.count({ where: { id: expiredMessage.id } }), 0, "Expired raw message must be deleted.");
  assert.equal(await prisma.message.count({ where: { id: retainedMessage.id } }), 1, "Message newer than cutoff must remain.");
  assert.equal(await prisma.memorySnapshot.count({ where: { id: retentionSnapshot.id } }), 1, "Snapshot must survive raw message cleanup.");
  const preservedSource = await prisma.memorySnapshotSource.findUniqueOrThrow({ where: { id: sourceRecord.id } });
  assert.equal(preservedSource.messageId, null, "Source trace must remain while the raw-message relation is nulled.");
  assert.equal(preservedSource.sourceRef, expiredMessage.id, "Source reference must remain traceable after raw content expires.");
  const preservedMemory = await prisma.memoryItem.findUniqueOrThrow({ where: { id: memoryItem.id } });
  assert.equal(preservedMemory.sourceMessageId, null, "Long-term memory must survive with a nullable raw-message relation.");
  assert.equal(preservedMemory.sourceSnapshotId, retentionSnapshot.id, "Long-term memory must keep its snapshot provenance.");
  const completedCleanup = await prisma.memoryJob.findUniqueOrThrow({ where: { id: cleanupJob.id } });
  assert.equal(completedCleanup.status, "SUCCEEDED", "Cleanup job should be marked successful.");

  const blockedCleanupState = await prisma.memoryJob.findUniqueOrThrow({ where: { id: blockedCleanupJob.id } });
  assert.equal(blockedCleanupState.status, "RETRY_WAIT", "Cleanup must defer while an earlier snapshot job has failed.");
  assert.match(blockedCleanupState.lastError ?? "", /更早的快照任务待处理/, "The deferred cleanup task should explain the snapshot dependency.");
  assert.equal(blockedCleanupState.attemptCount, 0, "Waiting for a snapshot dependency must not consume a cleanup attempt.");
  assert.equal(
    await prisma.message.count({ where: { id: blockedExpiredMessage.id } }),
    1,
    "Raw messages in an unresolved snapshot period must remain untouched.",
  );

  const cleanupAudit = await prisma.auditLog.findFirstOrThrow({
    where: {
      action: "message.retention_cleanup",
      entityType: "MemoryScope",
      entityId: retentionScopeId,
      details: { path: ["jobId"], equals: cleanupJob.id },
    },
    select: { details: true, characterId: true },
  });
  assert.equal(cleanupAudit.characterId, characterId, "Cleanup audit should retain the owning character context.");
  assert.deepEqual(
    cleanupAudit.details,
    {
      cutoff: "2026-09-24T12:00:00.000Z",
      deletedMessages: 1,
      jobId: cleanupJob.id,
    },
    "Cleanup audit must record the exact cutoff, deletion count, and originating task.",
  );

  // A repeated scheduler pass on the same day must not enqueue duplicate cleanup work.
  await enqueueDueMemorySnapshots(prisma, { now });
  assert.equal(
    await prisma.memoryJob.count({ where: { idempotencyKey: `clean-expired-messages:${retentionScopeId}:2026-09-24` } }),
    1,
    "Repeating the scheduler must not create a second cleanup job for the same scope and cutoff.",
  );
  assert.equal(
    await prisma.auditLog.count({
      where: {
        action: "message.retention_cleanup",
        entityType: "MemoryScope",
        entityId: retentionScopeId,
      },
    }),
    1,
    "A repeated scheduler pass must not duplicate a completed cleanup audit.",
  );

  console.log("Memory retention integration passed: safe deletion, blocked-snapshot protection, provenance preservation, accurate audit data, and cleanup scheduling idempotency.");

  console.log("Memory DB integration passed: concurrent scheduling, overdue backfill, cursor advancement, repeat-run idempotency, worker replay reuse, and retention cleanup.");
} finally {
  await prisma.characterMemorySetting.deleteMany({ where: { characterId } });
  await prisma.conversation.deleteMany({ where: { id: { in: [conversationId, blockedConversationId] } } });
  await prisma.memoryScope.deleteMany({ where: { id: { in: [scopeId, retentionScopeId] } } });
  await prisma.character.deleteMany({ where: { id: characterId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await prisma.$disconnect();
}
