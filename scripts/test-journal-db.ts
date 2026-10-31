import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { resolveDailyEventWindow, resolveDayWindow } from "../server/utils/memory-event-time";
import { enqueueDueMemorySnapshots } from "../server/utils/memory-scheduler";
import {
  generateJournalForDay,
  readPreviousJournalLine,
  restoreJournalRevision,
  saveJournalEdit,
} from "../server/utils/journal-service";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL，日记/手账数据库测试无法运行。");

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

const TIME_ZONE = "Asia/Shanghai";
const diaryV1 = "今天下午其实有点不开心。一开始我觉得自己的想法没有问题，所以主人提出不同意见的时候，我还有点不服气。后来重新看了一遍，才发现他的担心确实有道理。";
const diaryV2 = "今天下午跟主人聊了很久，后来一起把问题解决了。我也松了口气，原来他担心的是另一件事，说开之后就没那么别扭了。明天想再看看改完的效果。";
const quoteV1 = "我还有点不服气";
const quoteV2 = "我也松了口气";

async function main() {
  const ownerId = randomUUID();
  const characterId = randomUUID();
  const dayKey = resolveDailyEventWindow(new Date(), TIME_ZONE).dayKey;

  await prisma.user.create({
    data: { id: ownerId, username: `journal-test-${randomUUID().slice(0, 8)}`, passwordHash: "test", role: "USER" },
  });
  await prisma.character.create({
    data: { id: characterId, ownerId, name: "journal-test-character", basePrompt: "test persona" },
  });
  const scope = await prisma.memoryScope.create({
    data: { characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `character:${characterId}:global` },
  });

  // 1. 那天没有对话：不生成正文，落一条 SKIPPED 标记并写清原因
  const empty = await generateJournalForDay({ characterId, dayKey, mode: "manual" }, prisma);
  assert.equal(empty.status, "skipped");
  const skipped = await prisma.characterJournal.findUnique({
    where: { memoryScopeId_dayKey: { memoryScopeId: scope.id, dayKey } },
  });
  assert.equal(skipped?.status, "SKIPPED");
  assert.equal(skipped?.skipReason, "这一天没有对话");

  // 2. 人工写日记：第 1 版 DIARY
  const diary = await saveJournalEdit({
    characterId,
    dayKey,
    kind: "DIARY",
    title: "有点小别扭的一天",
    content: diaryV1,
    actorUserId: ownerId,
  }, prisma);
  assert.equal(diary.ok, true);
  if (!diary.ok) throw new Error("diary edit failed");
  assert.equal(diary.revision.kind, "DIARY");
  assert.equal(diary.revision.version, 1);
  assert.equal(diary.revision.revisionType, "USER_EDITED");

  // 3. 人工写手账：第 1 版 HANDBOOK，一句引用第 1 版日记
  const handbook = await saveJournalEdit({
    characterId,
    dayKey,
    kind: "HANDBOOK",
    content: "## 今日片段\n- 下午跟主人讨论项目，意见不太一样。\n- 晚上一起把问题改好了。\n\n## 灵感与发现\n- 分歧不等于否定。\n\n## 待续事项\n- 明天再看看改完的效果。",
    thought: "坚持自己的想法没错，但也应该认真听听别人的意见。",
    quote: quoteV1,
    tags: ["项目", "自我反思"],
    actorUserId: ownerId,
  }, prisma);
  assert.equal(handbook.ok, true);
  if (!handbook.ok) throw new Error("handbook edit failed");
  assert.equal(handbook.revision.kind, "HANDBOOK");
  assert.equal(handbook.revision.version, 1, "两种文本各自排版本号，手账也是第 1 版");
  assert.equal(handbook.revision.sourceDiaryRevisionId, diary.revision.id, "一句要指向它引用的那版日记");
  assert.deepEqual(handbook.revision.tags, ["项目", "自我反思"]);

  // 4. 只改日记：日记出第 2 版，手账仍是第 1 版、仍指向第 1 版日记
  const diarySecond = await saveJournalEdit({
    characterId,
    dayKey,
    kind: "DIARY",
    content: diaryV2,
    actorUserId: ownerId,
  }, prisma);
  assert.equal(diarySecond.ok, true);
  if (!diarySecond.ok) throw new Error("diary second edit failed");
  assert.equal(diarySecond.revision.version, 2);
  const handbookAfter = await prisma.journalRevision.findFirst({
    where: { journalId: diary.revision.journalId, kind: "HANDBOOK" },
    orderBy: { version: "desc" },
  });
  assert.equal(handbookAfter?.version, 1, "改日记不能动到手账版本");
  assert.equal(handbookAfter?.sourceDiaryRevisionId, diary.revision.id, "手账仍指向当时引用的日记版本");

  // 5. 手账的一句不在任何一版日记里：拒绝
  const invalid = await saveJournalEdit({
    characterId,
    dayKey,
    kind: "HANDBOOK",
    content: "## 今日片段\n- 随便写一条。",
    quote: "今天真是充实的一天",
    actorUserId: ownerId,
  }, prisma);
  assert.equal(invalid.ok, false);
  if (invalid.ok) throw new Error("invalid quote should be rejected");
  assert.match(invalid.message, /日记正文/);

  // 6. 换成第 2 版日记里的原话：手账出第 2 版，并改为指向第 2 版日记
  const handbookSecond = await saveJournalEdit({
    characterId,
    dayKey,
    kind: "HANDBOOK",
    content: "## 今日片段\n- 下午聊了很久，最后一起把问题解决了。",
    thought: "问题解决了，人也松下来。",
    quote: quoteV2,
    tags: ["项目"],
    actorUserId: ownerId,
  }, prisma);
  assert.equal(handbookSecond.ok, true);
  if (!handbookSecond.ok) throw new Error("handbook second edit failed");
  assert.equal(handbookSecond.revision.version, 2);
  assert.equal(handbookSecond.revision.sourceDiaryRevisionId, diarySecond.revision.id);

  // 7. 恢复第 1 版日记：新建第 3 版 RESTORED，手账保持第 2 版不动
  const restored = await restoreJournalRevision({
    characterId,
    dayKey,
    kind: "DIARY",
    version: 1,
    actorUserId: ownerId,
  }, prisma);
  assert.equal(restored.ok, true);
  if (!restored.ok) throw new Error("restore failed");
  assert.equal(restored.revision.kind, "DIARY");
  assert.equal(restored.revision.version, 3);
  assert.equal(restored.revision.revisionType, "RESTORED");
  const handbookStill = await prisma.journalRevision.findFirst({
    where: { journalId: diary.revision.journalId, kind: "HANDBOOK" },
    orderBy: { version: "desc" },
  });
  assert.equal(handbookStill?.version, 2, "恢复日记不能改手账");

  // 8. 次日对话读到的是手账的「一句」
  const line = await readPreviousJournalLine(prisma, characterId, new Date(), TIME_ZONE);
  assert.ok(line, "应能读到昨天的日记/手账");
  assert.equal(line?.dayKey, dayKey);
  assert.equal(line?.quote, quoteV2);

  // 8.1 用户把手账的「一句」清掉后，次日不能拿旧版本的句子顶上
  const cleared = await saveJournalEdit({
    characterId,
    dayKey,
    kind: "HANDBOOK",
    content: "## 今日片段\n- 今天就这样。",
    thought: "没有特别想留的一句话。",
    quote: null,
    actorUserId: ownerId,
  }, prisma);
  assert.equal(cleared.ok, true);
  assert.equal(await readPreviousJournalLine(prisma, characterId, new Date(), TIME_ZONE), null);

  // 8.2 恢复带那句话的手账版本，句子回来
  const restoredHandbook = await restoreJournalRevision({
    characterId,
    dayKey,
    kind: "HANDBOOK",
    version: 2,
    actorUserId: ownerId,
  }, prisma);
  assert.equal(restoredHandbook.ok, true);
  const lineBack = await readPreviousJournalLine(prisma, characterId, new Date(), TIME_ZONE);
  assert.equal(lineBack?.quote, quoteV2);

  // 9. 版本唯一约束按 (journal, kind, version)：同 kind 重复版本失败
  let dupVersion = false;
  try {
    await prisma.journalRevision.create({
      data: {
        journalId: diary.revision.journalId,
        kind: "DIARY",
        version: 1,
        content: diaryV1,
        revisionType: "AI_GENERATED",
      },
    });
  } catch {
    dupVersion = true;
  }
  assert.ok(dupVersion, "同一份文本的版本号重复应失败");

  // 10. 删日期主体时两份文本的版本一起级联删除
  await prisma.characterJournal.delete({ where: { id: diary.revision.journalId } });
  const left = await prisma.journalRevision.count({ where: { journalId: diary.revision.journalId } });
  assert.equal(left, 0, "删日记/手账应级联删版本");

  // 11. 调度器：昨天有对话、还没有日记/手账时，应该排一个 GENERATE_JOURNAL 任务
  const scheduledCharacterId = randomUUID();
  await prisma.character.create({
    data: { id: scheduledCharacterId, ownerId, name: "journal-scheduled-character", basePrompt: "test persona" },
  });
  const scheduledScope = await prisma.memoryScope.create({
    data: { characterId: scheduledCharacterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `character:${scheduledCharacterId}:global` },
  });
  const scheduledConversation = await prisma.conversation.create({
    data: { characterId: scheduledCharacterId, memoryScopeId: scheduledScope.id, title: "手账调度测试" },
    select: { id: true },
  });
  await prisma.message.create({
    data: {
      conversationId: scheduledConversation.id,
      role: "USER",
      content: "昨天聊了一会儿。",
      occurredAt: new Date(resolveDayWindow(dayKey, TIME_ZONE).start.getTime() + 12 * 60 * 60_000),
    },
  });
  await prisma.characterMemorySetting.create({
    data: {
      characterId: scheduledCharacterId,
      timezone: TIME_ZONE,
      autoSnapshotEnabled: true,
      anchorAt: new Date(),
      nextSnapshotAt: new Date(Date.now() + 100 * 24 * 60 * 60_000),
    },
  });
  const report = await enqueueDueMemorySnapshots(prisma, { now: new Date(), ownerId });
  const journalJob = await prisma.memoryJob.findFirst({
    where: { memoryScopeId: scheduledScope.id, type: "GENERATE_JOURNAL" },
    select: { idempotencyKey: true },
  });
  assert.ok(journalJob, "昨天有对话时应排出手账任务");
  assert.equal(journalJob?.idempotencyKey, `journal:${scheduledScope.id}:${dayKey}`);
  assert.ok(report.jobsQueued >= 1);

  // 12. 清理（第二组角色 + 任务）
  await prisma.memoryJob.deleteMany({ where: { memoryScopeId: scheduledScope.id } });
  await prisma.conversation.deleteMany({ where: { memoryScopeId: scheduledScope.id } });
  await prisma.memoryScope.deleteMany({ where: { characterId: scheduledCharacterId } });
  await prisma.character.delete({ where: { id: scheduledCharacterId } });

  console.log("✅ test-journal-db 全部通过");
  console.log("   日记 / 手账独立版本：改一份不动另一份");
  console.log("   一句追溯：指向被引用的那一版日记");
  console.log("   恢复 / 次日读取 / 唯一约束 / 级联删除 / 调度器");

  await prisma.memoryScope.deleteMany({ where: { characterId } });
  await prisma.character.delete({ where: { id: characterId } });
  await prisma.user.delete({ where: { id: ownerId } });
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error("❌ test-journal-db 失败：", error);
  await prisma.$disconnect();
  process.exit(1);
});
