import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { enqueueDueMemorySnapshots } from "../server/utils/memory-scheduler";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL，数据库集成测试无法运行。");

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });
const suffix = randomUUID();
const ownerId = randomUUID();
const characterId = randomUUID();
const scopeId = randomUUID();
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
      modelConfig: {},
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
    },
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

  console.log("Memory scheduler DB integration passed: concurrent scheduling, overdue backfill, cursor advancement, and repeat-run idempotency.");
} finally {
  await prisma.characterMemorySetting.deleteMany({ where: { characterId } });
  await prisma.memoryScope.deleteMany({ where: { id: scopeId } });
  await prisma.character.deleteMany({ where: { id: characterId } });
  await prisma.user.deleteMany({ where: { id: ownerId } });
  await prisma.$disconnect();
}
