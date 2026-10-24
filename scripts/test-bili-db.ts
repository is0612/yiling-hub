import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { loadBiliConnections, BILI_DUTY_DEFAULTS } from "../server/utils/channel-adapter/bili/configure";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL，B站 渠道数据库测试无法运行。");

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

async function main() {
  const ownerId = randomUUID();
  const characterId = randomUUID();
  const connectionId = randomUUID();
  const bindingId = randomUUID();

  // 建最小依赖：用户 → 角色 → 连接 → 绑定
  await prisma.user.create({
    data: {
      id: ownerId,
      username: `bili-test-${randomUUID().slice(0, 8)}`,
      passwordHash: "test",
      role: "USER",
    },
  });
  const character = await prisma.character.create({
    data: {
      id: characterId,
      ownerId,
      name: "bili-test-character",
      basePrompt: "test persona",
    },
  });
  const connection = await prisma.platformConnection.create({
    data: {
      id: connectionId,
      platform: "bili",
      displayName: "bili-test-connection",
      metadata: {
        dataHome: "/tmp/bili-test",
        biliBin: "bili",
        duty: { perDay: 3, keywords: ["DeepSeek"], zone: "tech", dmMode: "both" },
      },
    },
  });
  await prisma.characterChannelBinding.create({
    data: {
      id: bindingId,
      characterId,
      connectionId,
    },
  });

  // 1. BiliSeenVideo 写入 + 唯一约束幂等（同 binding 同 bvid 第二次 upsert 不新增）
  const seen = await prisma.biliSeenVideo.create({
    data: { bindingId, bvid: "BV1TEST000000001", title: "测试视频", author: "测试UP", result: "picked", reason: "值得" },
  });
  assert.equal(seen.bvid, "BV1TEST000000001");

  // 重复创建应触发唯一约束错误
  let dupError = false;
  try {
    await prisma.biliSeenVideo.create({
      data: { bindingId, bvid: "BV1TEST000000001", title: "重复", author: "x", result: "skipped" },
    });
  } catch {
    dupError = true;
  }
  assert.ok(dupError, "同 binding 同 bvid 重复写入应失败（唯一约束）");

  // 2. BiliRoundReport 写入 + 唯一约束（bindingId+day+roundIndex）
  const report = await prisma.biliRoundReport.create({
    data: { bindingId, day: "2026-10-25", roundIndex: 1, pickedCount: 1, content: "### BV1TEST000000001\n值得一看" },
  });
  assert.equal(report.pickedCount, 1);

  // 3. loadBiliConnections 能加载配置并解析 duty 默认值/覆盖值
  const records = await loadBiliConnections();
  const record = records.find((r) => r.id === connectionId);
  assert.ok(record, "应能加载 B站 连接");
  assert.equal(record?.duty.perDay, 3);
  assert.deepEqual(record?.duty.keywords, ["DeepSeek"]);
  assert.equal(record?.duty.zone, "tech");
  assert.equal(record?.duty.dmMode, "both");
  assert.equal(record?.duty.autoComment, BILI_DUTY_DEFAULTS.autoComment); // 未配置的用默认值
  assert.equal(record?.bindings.length, 1);

  // 4. 默认值正确性
  assert.equal(BILI_DUTY_DEFAULTS.perDay, 5);
  assert.equal(BILI_DUTY_DEFAULTS.zone, "all");
  assert.equal(BILI_DUTY_DEFAULTS.dmMode, "only");

  console.log("✅ test-bili-db 全部通过");
  console.log(`   判重表唯一约束幂等：通过`);
  console.log(`   值班配置解析（覆盖 + 默认）：通过`);

  // 清理测试数据（级联删除）
  await prisma.character.delete({ where: { id: characterId } });
  await prisma.platformConnection.delete({ where: { id: connectionId } });
  await prisma.user.delete({ where: { id: ownerId } });
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error("❌ test-bili-db 失败：", error);
  await prisma.$disconnect();
  process.exit(1);
});
