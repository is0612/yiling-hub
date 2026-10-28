import "dotenv/config";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";

/**
 * 从 bili-desk 迁移历史数据到 yiling-hub。
 *
 * 迁移内容：
 *   - workspace/AGENTS.md（人设）→ 角色 basePrompt（仅当目标角色人设为空时）
 *   - human-world.md（人格札记）→ 角色长期记忆条目（标记来源 bili-desk）
 *   - seen.md（判重表）→ BiliSeenVideo 表
 *   - config.json（值班设置）→ 连接的 metadata.duty
 *
 * 注意：
 *   - B站登录凭证（%APPDATA%\bili-cli\credential.json）由 bili-cli 自己管理，
 *     不随代码、不入库，yiling-hub 的 B站适配器直接复用，无需迁移。
 *   - 默认 dry-run，只打印会做什么，不写库；加 --apply 才真正执行。
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL，迁移无法运行。");

const apply = process.argv.includes("--apply");

// bili-desk 数据目录：便携 data/ 或 %APPDATA%\bili-desk
const biliDeskRoot = process.env.BILI_DESK_PATH || (existsSync("D:/AI/bili-desk/data") ? "D:/AI/bili-desk" : join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "bili-desk"));
const dataHome = existsSync(join(biliDeskRoot, "data")) ? join(biliDeskRoot, "data") : biliDeskRoot;

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

type SeenEntry = { date: string; bvid: string; title: string; author: string; result: string };

function parseSeen(text: string): SeenEntry[] {
  const entries: SeenEntry[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // bili-desk 的 seen.md 有两种写法：markdown 列表「- 2026-…」和直接「2026-… · BV…」，都认
    const body = line.startsWith("- ") ? line.slice(2) : line;
    const parts = body.split("·").map((p) => p.trim());
    if (parts.length < 5) continue;
    const [date, bvid, title, author, ...rest] = parts;
    if (!/^BV[0-9A-Za-z]+$/.test(bvid)) continue;
    const result = rest.join(" · ");
    entries.push({ date, bvid, title, author, result: result.startsWith("收") ? "picked" : "skipped" });
  }
  return entries;
}

function parseJournal(text: string): Array<{ date: string; content: string }> {
  const entries: Array<{ date: string; content: string }> = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const m = line.match(/^-\s+(\d{4}-\d{2}-\d{2})\s*·\s*(.+)$/);
    if (m) entries.push({ date: m[1], content: m[2].trim() });
  }
  return entries;
}

async function main() {
  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  const agentsMd = readText(join(dataHome, "workspace", "AGENTS.md"));
  const journal = parseJournal(readText(join(dataHome, "human-world.md")));
  const seen = parseSeen(readText(join(dataHome, "seen.md")));
  const config = readJson<Record<string, unknown>>(join(dataHome, "config.json"), {});
  const reports = readdirSync(join(dataHome, "out")).filter((f) => f.endsWith(".md")).length;

  console.log(`数据目录：${dataHome}`);
  console.log(`模式：${apply ? "APPLY（写入数据库）" : "DRY-RUN（只预览）"}`);
  console.log("");
  console.log(`  AGENTS.md 人设：${agentsMd ? `${agentsMd.length} 字符` : "（无）"}`);
  console.log(`  人格札记：${journal.length} 条`);
  console.log(`  判重表：${seen.length} 条`);
  console.log(`  值班设置 config.json：${Object.keys(config).length} 个字段`);
  console.log(`  报告 out/：${reports} 份`);
  console.log("");

  // 找到要迁移到的目标：B站连接 + 绑定 + 角色
  const connection = await prisma.platformConnection.findFirst({
    where: { platform: "bili" },
    include: { characterBindings: { where: { status: "ACTIVE" }, select: { id: true, characterId: true } } },
  });

  if (!connection) {
    console.log("⚠️ 尚未创建 B站连接。请先在「系统管理 → B站值班台」添加账号并绑定角色，再运行迁移。");
    console.log("（或者你也可以直接删除 bili-desk —— 当前没有可迁移的历史数据，凭证由 bili-cli 独立管理。）");
    await prisma.$disconnect();
    return;
  }

  const binding = connection.characterBindings[0];
  if (!binding) {
    console.log("⚠️ B站连接已存在但未绑定角色。请先绑定角色再迁移。");
    await prisma.$disconnect();
    return;
  }

  // 1. 人设 → basePrompt（仅当角色人设为空）
  if (agentsMd) {
    const character = await prisma.character.findUnique({ where: { id: binding.characterId }, select: { basePrompt: true, name: true } });
    if (character && character.basePrompt.trim().length === 0) {
      console.log(`  迁移人设 → 角色「${character.name}」的 basePrompt`);
      if (apply) {
        await prisma.character.update({ where: { id: binding.characterId }, data: { basePrompt: agentsMd } });
      }
    } else {
      console.log(`  跳过人设迁移（角色已有 basePrompt 或目标人设为空）`);
    }
  }

  // 2. 人格札记 → 长期记忆
  if (journal.length > 0) {
    const globalScope = await prisma.memoryScope.findFirst({ where: { characterId: binding.characterId, scopeType: "CHARACTER_GLOBAL" }, select: { id: true } });
    if (globalScope) {
      console.log(`  迁移 ${journal.length} 条札记 → 长期记忆`);
      if (apply) {
        for (const entry of journal) {
          await prisma.memoryItem.create({
            data: {
              memoryScopeId: globalScope.id,
              category: "EVENT",
              content: `[bili-desk 札记 ${entry.date}] ${entry.content}`,
              confidence: 0.8,
              status: "ACTIVE",
            },
          });
        }
      }
    }
  }

  // 3. 判重表 → BiliSeenVideo
  if (seen.length > 0) {
    console.log(`  迁移 ${seen.length} 条判重 → BiliSeenVideo`);
    if (apply) {
      for (const entry of seen) {
        await prisma.biliSeenVideo.create({
          data: { bindingId: binding.id, bvid: entry.bvid, title: entry.title, author: entry.author, result: entry.result, seenAt: new Date(entry.date + "T00:00:00Z") },
        }).catch(() => undefined); // 唯一约束：已存在则跳过
      }
    }
  }

  // 4. 值班设置 → 连接 metadata（只补缺失字段，不覆盖 yiling-hub 里已有的设置和 taste）
  if (Object.keys(config).length > 0) {
    const existing = (connection.metadata ?? {}) as Record<string, unknown>;
    const currentDuty = (existing.duty ?? {}) as Record<string, unknown>;
    const merged = { ...config, ...currentDuty };
    const added = Object.keys(config).filter((k) => !(k in currentDuty));
    console.log(
      added.length > 0
        ? `  补 ${added.length} 个缺失的值班字段 → 连接 metadata.duty（已有设置保持不变）`
        : `  跳过设置迁移（连接里已有完整值班设置，不覆盖 taste）`,
    );
    if (apply && added.length > 0) {
      await prisma.platformConnection.update({
        where: { id: connection.id },
        data: { metadata: { ...existing, duty: merged } },
      });
    }
  }

  if (reports > 0) {
    console.log(`  ℹ️ ${reports} 份报告（out/*.md）不自动迁移，请按需手工归档（报告是历史记录，不影响记忆）。`);
  }

  console.log("");
  if (!apply) {
    console.log("以上是预览。确认无误后加 --apply 真正执行。");
  } else {
    console.log("✅ 迁移完成。确认后即可删除 bili-desk 目录。");
  }

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error("❌ 迁移失败：", error);
  process.exit(1);
});
