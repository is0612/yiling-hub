import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

/**
 * 清理本地开发环境里的测试数据。
 *
 * 删除范围：
 *   1. 测试角色：名字以「CI 」开头，或等于「id-test-character」。
 *   2. 测试用户：用户名以「id-test-owner-」或「id-test-user-」开头。
 *   3. 运行数据：全部会话、消息、记忆项、快照、快照来源、记忆任务、审计日志、登录尝试、
 *      聊天请求、会话（sessions）清空。
 *
 * 保留：
 *   - local-dev 用户（DEV_OWNER_ID）
 *   - 大肥鱼角色及其 B站连接绑定
 *   - 平台连接、外部身份
 *
 * 用法：
 *   tsx scripts/clean-test-data.ts            # 预览将删除的内容
 *   tsx scripts/clean-test-data.ts --apply    # 真正执行删除
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL，请先配置 .env。");

const apply = process.argv.includes("--apply");
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

const TEST_CHAR_PREFIX = "CI ";
const TEST_CHAR_EXACT = new Set(["id-test-character"]);
const TEST_USER_PREFIXES = ["id-test-owner-", "id-test-user-"];

function isTestCharacter(name: string): boolean {
  return name.startsWith(TEST_CHAR_PREFIX) || TEST_CHAR_EXACT.has(name);
}
function isTestUser(username: string): boolean {
  return TEST_USER_PREFIXES.some((prefix) => username.startsWith(prefix));
}

async function main() {
  // ── 盘点 ──────────────────────────────────────────────
  const allCharacters = await prisma.character.findMany({ select: { id: true, name: true, ownerId: true } });
  const testCharacters = allCharacters.filter((c) => isTestCharacter(c.name));
  const keptCharacters = allCharacters.filter((c) => !isTestCharacter(c.name));

  const allUsers = await prisma.user.findMany({ select: { id: true, username: true, role: true } });
  const testUsers = allUsers.filter((u) => isTestUser(u.username));
  const keptUsers = allUsers.filter((u) => !isTestUser(u.username));

  const testCharacterIds = testCharacters.map((c) => c.id);
  const testUserIds = testUsers.map((u) => u.id);

  // 测试角色/用户关联的会话、记忆范围数量
  const testConversations = testCharacterIds.length
    ? await prisma.conversation.count({ where: { characterId: { in: testCharacterIds } } })
    : 0;
  const testScopes = testCharacterIds.length
    ? await prisma.memoryScope.count({ where: { characterId: { in: testCharacterIds } } })
    : 0;

  const runStats = {
    conversations: await prisma.conversation.count(),
    messages: await prisma.message.count(),
    memoryItems: await prisma.memoryItem.count(),
    snapshots: await prisma.memorySnapshot.count(),
    snapshotSources: await prisma.memorySnapshotSource.count(),
    memoryJobs: await prisma.memoryJob.count(),
    auditLogs: await prisma.auditLog.count(),
    loginAttempts: await prisma.loginAttempt.count(),
    chatRequests: await prisma.chatRequest.count(),
    sessions: await prisma.session.count(),
  };

  console.log("======================================================");
  console.log("本地测试数据清理预览");
  console.log("======================================================");
  console.log(`测试角色：${testCharacters.length} 个`);
  for (const c of testCharacters) console.log(`  - ${c.name}`);
  console.log(`保留角色：${keptCharacters.length} 个`);
  for (const c of keptCharacters) console.log(`  - ${c.name}`);
  console.log(`测试用户：${testUsers.length} 个`);
  for (const u of testUsers) console.log(`  - ${u.username} (${u.role})`);
  console.log(`保留用户：${keptUsers.length} 个`);
  for (const u of keptUsers) console.log(`  - ${u.username} (${u.role})`);
  console.log(`测试角色关联的会话：${testConversations}，记忆范围：${testScopes}`);
  console.log("------------------------------------------------------");
  console.log("将清空的运行数据：");
  for (const [k, v] of Object.entries(runStats)) console.log(`  - ${k}: ${v}`);
  console.log("======================================================");

  if (!apply) {
    console.log("预览模式。加 --apply 参数真正执行删除。");
    return;
  }

  // ── 执行 ──────────────────────────────────────────────
  await prisma.$transaction(async (tx) => {
    // 1. 删测试角色的关联数据（会话 → 记忆范围 → 角色）
    if (testCharacterIds.length) {
      await tx.conversation.deleteMany({ where: { characterId: { in: testCharacterIds } } });
      await tx.memoryScope.deleteMany({ where: { characterId: { in: testCharacterIds } } });
      await tx.character.deleteMany({ where: { id: { in: testCharacterIds } } });
    }

    // 2. 删测试用户（关联的角色已在上面删掉；user 相关外键多 SetNull/Cascade）
    if (testUserIds.length) {
      await tx.user.deleteMany({ where: { id: { in: testUserIds } } });
    }

    // 3. 清空所有运行数据
    await tx.message.deleteMany();
    await tx.conversation.deleteMany();
    await tx.memoryItem.deleteMany();
    await tx.memorySnapshotSource.deleteMany();
    await tx.memorySnapshot.deleteMany();
    await tx.memoryJob.deleteMany();
    await tx.auditLog.deleteMany();
    await tx.loginAttempt.deleteMany();
    await tx.chatRequest.deleteMany();
    await tx.session.deleteMany();
  });

  console.log("\n清理完成。");
  console.log(`已删除测试角色 ${testCharacters.length} 个、测试用户 ${testUsers.length} 个。`);
  console.log("运行数据（会话/消息/记忆/快照/审计日志等）已全部清空。");
  console.log(`保留角色：${keptCharacters.map((c) => c.name).join("、")}；保留用户：${keptUsers.map((u) => u.username).join("、")}。`);
}

main()
  .catch((error) => {
    console.error("清理失败：", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
