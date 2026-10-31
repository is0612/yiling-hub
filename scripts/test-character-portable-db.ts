import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { buildUserPrivateScopeKey } from "../server/utils/memory-scope-access";
import {
  importCharacterCard,
  loadCharacterExportBundle,
} from "../server/utils/character-transfer";


/**
 * 角色卡导出 / 导入的数据库回环测试。
 *
 * 重点验证三件事，而不是「字段都搬过去了」：
 *   1. 别人的私人记忆（USER_PRIVATE 属于其他用户）和外部身份记忆（QQ/B站 群友）不出包；
 *   2. 密钥字段不出包、导入后也不认；
 *   3. 导入只新增，不动原角色；原文没随包走时来源字段确实为空。
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL，角色卡测试无法运行。");

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

const ownerA = randomUUID();
const userB = randomUUID();
const characterIds: string[] = [];

async function main() {
  await prisma.user.createMany({
    data: [
      { id: ownerA, username: `card-test-a-${randomUUID().slice(0, 8)}`, passwordHash: "x", role: "ADMIN" },
      { id: userB, username: `card-test-b-${randomUUID().slice(0, 8)}`, passwordHash: "x", role: "USER" },
    ],
  });

  // ── 造一个「养了一阵子」的角色 ────────────────────────────
  const characterId = randomUUID();
  characterIds.push(characterId);
  await prisma.character.create({
    data: {
      id: characterId,
      ownerId: ownerA,
      name: "小鱼",
      basePrompt: "你是小鱼，说话很短。",
      styleExamples: "主人：在吗\n小鱼：在。",
      userAddress: "主人",
      modelConfig: {
        alias: "小鱼",
        description: "一条鱼",
        avatarTone: "purple",
        chatModel: "deepseek-chat",
        chatApiKeyEncrypted: "v1.aaa.bbb.ccc",
        emojiEnabled: true,
      },
      memorySetting: {
        create: { snapshotIntervalDays: 8, timezone: "Asia/Shanghai", autoSnapshotEnabled: true },
      },
    },
  });

  const globalScopeId = randomUUID();
  const privateAId = randomUUID();
  const privateBId = randomUUID();
  const externalScopeId = randomUUID();
  await prisma.memoryScope.createMany({
    data: [
      { id: globalScopeId, characterId, scopeType: "CHARACTER_GLOBAL", scopeKey: `character:${characterId}:global` },
      { id: privateAId, characterId, scopeType: "USER_PRIVATE", scopeKey: buildUserPrivateScopeKey(characterId, ownerA), userId: ownerA },
      { id: privateBId, characterId, scopeType: "USER_PRIVATE", scopeKey: buildUserPrivateScopeKey(characterId, userB), userId: userB },
      { id: externalScopeId, characterId, scopeType: "EXTERNAL_IDENTITY", scopeKey: `character:${characterId}:external:qq-onebot:888888` },
    ],
  });

  const conversationId = randomUUID();
  await prisma.conversation.create({
    data: { id: conversationId, characterId, memoryScopeId: globalScopeId, title: "旧会话" },
  });
  const messageId = randomUUID();
  await prisma.message.create({
    data: {
      id: messageId,
      conversationId,
      role: "USER",
      content: "我住杭州",
      occurredAt: new Date("2026-10-01T10:00:00Z"),
    },
  });

  await prisma.memoryItem.createMany({
    data: [
      { memoryScopeId: globalScopeId, category: "FACT", content: "主人住在杭州", confidence: 0.9, importance: 0.7, sourceMessageId: messageId, dedupeKey: "fact-hz" },
      { memoryScopeId: globalScopeId, category: "PREFERENCE", content: "主人怕辣", importance: 0.6 },
      { memoryScopeId: privateAId, category: "PREFERENCE", content: "主人喜欢冰美式", importance: 0.5 },
      { memoryScopeId: privateBId, category: "FACT", content: "B 的秘密：他姓王", importance: 0.9 },
      { memoryScopeId: externalScopeId, category: "FACT", content: "群里某人的私人信息", importance: 0.9 },
    ],
  });

  await prisma.memoryEvent.createMany({
    data: [
      {
        memoryScopeId: globalScopeId,
        dayKey: "2026-10-30",
        state: "FINAL",
        occurredAt: new Date("2026-10-30T12:00:00Z"),
        precision: "part_of_day",
        timeOfDay: "下午",
        place: "北海银滩",
        title: "去海边游泳",
        detail: "和小关一起",
        keywords: ["海边"],
        participants: ["小关"],
        sourceMessageId: messageId,
        sourceMessageIds: [messageId],
        dedupeKey: "evt-swim",
      },
      {
        memoryScopeId: privateAId,
        dayKey: "2026-10-29",
        state: "FINAL",
        occurredAt: new Date("2026-10-29T12:00:00Z"),
        title: "主人加班到很晚",
        detail: "她说很累",
        dedupeKey: "evt-ot",
      },
    ],
  });

  await prisma.memorySnapshot.createMany({
    data: [
      {
        snapshotKey: `auto-snapshot:${globalScopeId}:p1`,
        memoryScopeId: globalScopeId,
        kind: "AUTOMATIC",
        version: 1,
        periodStart: new Date("2026-10-01T00:00:00Z"),
        periodEnd: new Date("2026-10-08T00:00:00Z"),
        summary: "这一段她学会了游泳。",
        structuredContent: { highlights: ["游泳"] },
        status: "CURRENT",
        generatedAt: new Date("2026-10-08T01:00:00Z"),
      },
      {
        snapshotKey: `auto-snapshot:${globalScopeId}:p0`,
        memoryScopeId: globalScopeId,
        kind: "AUTOMATIC",
        version: 1,
        periodStart: new Date("2026-09-24T00:00:00Z"),
        periodEnd: new Date("2026-10-01T00:00:00Z"),
        summary: "更早的旧版本总结。",
        structuredContent: {},
        status: "SUPERSEDED",
      },
    ],
  });

  await prisma.characterCatchphrase.createMany({
    data: [
      { characterId, phrase: "不烧心吗", usage: "吃到辣的", status: "ACTIVE", enabled: true },
      { characterId, phrase: "待确认的梗", usage: "还没点头", status: "PENDING", enabled: true },
    ],
  });

  // ── 1. 导出 ───────────────────────────────────────────────
  const exported = await loadCharacterExportBundle({ characterId, ownerId: ownerA });
  assert.ok(exported, "本人导出应该拿得到包");
  const bundle = exported.bundle;

  assert.equal(bundle.character.name, "小鱼");
  assert.equal(bundle.counts.memories, 3, "只有角色全局 + 自己的私人记忆进包");
  assert.equal(bundle.counts.privateMemories, 1, "私人记忆要单独计数，导入时要提示");
  assert.equal(bundle.counts.events, 2, "忆泡同样按范围过滤");
  assert.equal(bundle.counts.snapshots, 1, "只带 CURRENT 版本，旧版本不进包");
  assert.equal(bundle.counts.catchphrases, 1, "待确认的梗不进包");

  const contents = bundle.memories.map((item) => item.content);
  assert.ok(contents.includes("主人住在杭州"));
  assert.ok(contents.includes("主人喜欢冰美式"));
  assert.ok(!contents.includes("B 的秘密：他姓王"), "别的用户的私人记忆绝对不能进包");
  assert.ok(!contents.includes("群里某人的私人信息"), "外部身份（群友）的记忆不能进包");

  const serialized = JSON.stringify(bundle);
  assert.ok(!serialized.includes("v1.aaa.bbb.ccc"), "导出的 JSON 里不能出现 API Key 密文");
  assert.ok(!serialized.includes("chatApiKeyEncrypted"));

  // 非本人导出 = 查不到
  assert.equal(
    await loadCharacterExportBundle({ characterId, ownerId: userB }),
    null,
    "别人的角色导不出来",
  );

  // ── 2. 导入（同一个人另一台机器）────────────────────────────
  const first = await importCharacterCard({ raw: JSON.parse(serialized), ownerId: ownerA });
  characterIds.push(first.characterId);
  assert.equal(first.name, "小鱼 副本", "撞名加后缀，不覆盖原角色");
  assert.deepEqual(first.counts, bundle.counts, "导入条数与包内声明一致");

  const imported = await prisma.character.findUniqueOrThrow({
    where: { id: first.characterId },
    include: {
      memorySetting: true,
      memoryScopes: { include: { memoryItems: true, events: true, snapshots: true } },
      catchphrases: true,
    },
  });
  assert.equal(imported.status, "ACTIVE", "导入后可直接对话");
  assert.equal(imported.modelConfig && (imported.modelConfig as Record<string, unknown>).chatModel, "deepseek-chat");
  assert.equal(
    (imported.modelConfig as Record<string, unknown>).chatApiKeyEncrypted,
    undefined,
    "导入不认密钥字段，必须重新配置",
  );
  assert.equal(imported.memorySetting?.nextSnapshotAt, null, "周期边界不继承旧机器");
  assert.equal(imported.memorySetting?.rawMessageCleanupEnabled, false, "清理开关不能跟着包走");

  const importedGlobal = imported.memoryScopes.find((scope) => scope.scopeType === "CHARACTER_GLOBAL");
  const importedPrivate = imported.memoryScopes.find((scope) => scope.scopeType === "USER_PRIVATE");
  assert.ok(importedGlobal, "必须新建角色全局范围");
  assert.ok(importedPrivate, "有私人记忆时要建私人范围");
  assert.equal(importedPrivate?.userId, ownerA, "私人记忆归属导入者");
  assert.equal(importedGlobal?.memoryItems.length, 2);
  assert.equal(importedPrivate?.memoryItems.length, 1);
  assert.equal(importedGlobal?.events.length, 1);
  assert.equal(importedGlobal?.snapshots.length, 1);
  assert.equal(importedGlobal?.snapshots[0]?.version, 1, "只带当前版本，导入后记为第 1 版");
  assert.ok(
    importedGlobal?.snapshots[0]?.snapshotKey.startsWith("imported-snapshot:"),
    "导入的总结用独立 key，不冒充自动生成的那一条",
  );
  assert.equal(imported.catchphrases.length, 1);

  const importedEvent = importedGlobal?.events[0];
  assert.deepEqual(importedEvent?.sourceMessageIds, [], "原文没跟过来，来源数组必须为空");
  assert.equal(importedEvent?.sourceMessageId, null, "来源指针必须置空，不能指向别的消息");
  assert.equal(importedEvent?.participants[0], "小关", "参与者照常保留");

  // 原角色一条记忆都不能少
  const originalMemoryCount = await prisma.memoryItem.count({
    where: { memoryScope: { characterId } },
  });
  assert.equal(originalMemoryCount, 5, "导入不动原角色（5 条记忆仍在）");

  // ── 3. 导入到另一个人手上 ─────────────────────────────────
  const forB = await importCharacterCard({ raw: JSON.parse(serialized), ownerId: userB });
  characterIds.push(forB.characterId);
  assert.equal(forB.name, "小鱼", "B 没有同名角色，用原名");

  const bPrivate = await prisma.memoryScope.findFirst({
    where: { characterId: forB.characterId, scopeType: "USER_PRIVATE" },
    select: { userId: true, memoryItems: { select: { content: true } } },
  });
  assert.equal(bPrivate?.userId, userB, "私人记忆换人后归导入者，不串给导出者");
  assert.ok(bPrivate?.memoryItems.some((item) => item.content === "主人喜欢冰美式"));

  console.log("角色卡数据库测试通过：范围过滤（他人私人 / 外部身份记忆不出包）、密钥不出包、导入只新增、来源置空、双人导入归属正确。");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    const scoped = { memoryScope: { characterId: { in: characterIds } } };
    await prisma.message.deleteMany({ where: { conversation: { characterId: { in: characterIds } } } });
    await prisma.conversation.deleteMany({ where: { characterId: { in: characterIds } } });
    await prisma.memoryItem.deleteMany({ where: scoped });
    await prisma.memoryEvent.deleteMany({ where: scoped });
    await prisma.memorySnapshotSource.deleteMany({ where: { snapshot: { memoryScope: { characterId: { in: characterIds } } } } });
    await prisma.memorySnapshot.deleteMany({ where: scoped });
    await prisma.memoryJob.deleteMany({ where: scoped });
    await prisma.characterCatchphrase.deleteMany({ where: { characterId: { in: characterIds } } });
    await prisma.memoryScope.deleteMany({ where: { characterId: { in: characterIds } } });
    await prisma.auditLog.deleteMany({ where: { characterId: { in: characterIds } } });
    await prisma.character.deleteMany({ where: { id: { in: characterIds } } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerA, userB] } } });
    await prisma.$disconnect();
  });
