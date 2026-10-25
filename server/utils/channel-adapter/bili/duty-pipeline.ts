/**
 * B站值班流水线（脚本化）—— 从 bili-desk 的 agent.py run_round 迁移而来。
 *
 * 采用"方案 B（脚本化）"：把"刷一轮"拆成固定步骤，只在「判断这条值不值得」时调用
 * yiling-hub 的模型（复用 generateConversationReply），其余步骤直接调 bili CLI。
 *
 * 与 bili-desk 的差异：
 *   - 判重表 / 报告 / 札记不再读写本地文件，而是写 yiling-hub 的数据库。
 *   - 人设来自角色 basePrompt，札记来自角色长期记忆（由调用方注入）。
 *   - 不依赖 headless dsh 会话，改用 yiling-hub 的模型调用。
 */

import { getPrisma } from "../../prisma";
import { runBili } from "./runner";
import { buildDutyPrompt, type BiliDutyRoundSettings } from "./duty-prompt";
import { generateConversationReply } from "../../chat-reply";
import { resolveChatModelSettings } from "../../chat-model-config";
import { resolveCharacterApiKey } from "../../credential-encryption";
import type { BiliConnectionRecord, BiliDutyConfig } from "./configure";
import { remainingQuota, toDayKey } from "./duty-scheduler";

export type BiliCandidate = {
  bvid: string;
  title: string;
  author: string;
  detail: string;
};

export type BiliDutyRoundResult = {
  ok: boolean;
  reportId?: string;
  picked: number;
  skipped: number;
  seenVideos: number;
  error?: string;
};

const MAX_CANDIDATES = 25;

/**
 * 读取 bili JSON 结果里的 data 字段，兼容 {ok, data} 与裸数组/对象。
 */
function readBiliData(json: unknown): unknown {
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const record = json as Record<string, unknown>;
    if ("data" in record) return record.data;
  }
  return json;
}

/** 从 feed recommend / hot rank / search 的结果里抽取视频列表。 */
function extractVideos(data: unknown): Array<{ bvid: string; title: string; author: string }> {
  const list = Array.isArray(data) ? data : (data && typeof data === "object" ? (data as Record<string, unknown>).list ?? (data as Record<string, unknown>).items ?? [] : []);
  if (!Array.isArray(list)) return [];
  const result: Array<{ bvid: string; title: string; author: string }> = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as Record<string, unknown>;
    const bvid = typeof record.bvid === "string" ? record.bvid : "";
    if (!bvid) continue;
    result.push({
      bvid,
      title: typeof record.title === "string" ? record.title.slice(0, 200) : "",
      author: typeof record.author === "string" ? record.author.slice(0, 100) : "",
    });
  }
  return result;
}

/**
 * 跑一轮值班。绑定到某个角色（binding），读该角色的长期记忆做判断，写报告/判重/札记。
 *
 * 注意：这里 bili CLI 的"找候选/看懂"是真实跨进程调用；模型判断是真实模型调用。
 * 在没有配置 bili CLI / 模型 / 凭证的环境下，本函数会返回明确的错误，而不是假装成功。
 */
export async function runDutyRound(record: BiliConnectionRecord, binding: { id: string; characterId: string }): Promise<BiliDutyRoundResult> {
  const prisma = getPrisma();
  const now = new Date();
  const today = toDayKey(now);

  const character = await prisma.character.findUnique({
    where: { id: binding.characterId },
    select: {
      id: true,
      name: true,
      basePrompt: true,
      modelConfig: true,
      memoryScopes: { where: { scopeType: "CHARACTER_GLOBAL" }, select: { id: true } },
    },
  });
  if (!character) return { ok: false, picked: 0, skipped: 0, seenVideos: 0, error: "找不到绑定的角色" };
  const globalScope = character.memoryScopes[0];
  if (!globalScope) return { ok: false, picked: 0, skipped: 0, seenVideos: 0, error: "角色缺少全局记忆范围" };

  const config: BiliDutyConfig = record.duty;

  // 1. 读判重表（最近 7 天看过的 BV）
  const seenSince = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const seenVideos = await prisma.biliSeenVideo.findMany({
    where: { bindingId: binding.id, seenAt: { gte: seenSince } },
    select: { bvid: true },
  });
  const seenBvids = new Set(seenVideos.map((v) => v.bvid));

  // 今天已挑条数 = 今天报告的 pickedCount 之和
  const todayReports = await prisma.biliRoundReport.findMany({
    where: { bindingId: binding.id, day: today },
    select: { pickedCount: true, roundIndex: true },
  });
  const pickedToday = todayReports.reduce((sum, r) => sum + r.pickedCount, 0);
  const remaining = remainingQuota(config, { day: today, picked: pickedToday, windowsRun: [] });

  if (remaining <= 0) {
    return { ok: false, picked: pickedToday, skipped: 0, seenVideos: seenBvids.size, error: "今天额度已用完" };
  }

  // 2. 找候选
  const candidates: BiliCandidate[] = [];
  const feedResult = await runBili(["feed", "recommend", "--unseen", "-n", "12"], { bin: record.biliBin || undefined, env: record.dataHome ? { BILI_DESK_HOME: record.dataHome } : undefined });
  for (const video of extractVideos(readBiliData(feedResult.json))) {
    if (seenBvids.has(video.bvid)) continue;
    if (candidates.length >= MAX_CANDIDATES) break;
    candidates.push({ bvid: video.bvid, title: video.title, author: video.author, detail: "" });
  }

  if (config.keywords.length > 0) {
    for (const keyword of config.keywords.slice(0, 3)) {
      if (candidates.length >= MAX_CANDIDATES) break;
      const searchResult = await runBili(["search", "video", keyword, "--order", "pubdate", "--size", "10"], { bin: record.biliBin || undefined, env: record.dataHome ? { BILI_DESK_HOME: record.dataHome } : undefined });
      for (const video of extractVideos(readBiliData(searchResult.json))) {
        if (seenBvids.has(video.bvid)) continue;
        if (candidates.length >= MAX_CANDIDATES) break;
        candidates.push({ bvid: video.bvid, title: video.title, author: video.author, detail: "" });
      }
    }
  }

  if (candidates.length === 0) {
    return { ok: true, picked: 0, skipped: 0, seenVideos: seenBvids.size, error: "没有新候选" };
  }

  // 3. 判断（脚本化：对每个候选调模型判断值不值得）
  const modelSettings = resolveChatModelSettings(character.modelConfig);
  let apiKey = "";
  try {
    apiKey = await resolveCharacterApiKey(character.modelConfig, modelSettings.apiBaseUrl);
  } catch {
    return { ok: false, picked: 0, skipped: candidates.length, seenVideos: seenBvids.size, error: "角色 API Key 解密失败" };
  }
  if (!apiKey || !modelSettings.model) {
    return { ok: false, picked: 0, skipped: candidates.length, seenVideos: seenBvids.size, error: "角色未配置模型" };
  }

  const settings: BiliDutyRoundSettings = {
    today,
    remaining,
    perDay: config.perDay,
    keywords: config.keywords,
    zone: config.zone,
    frames: config.frames,
    dmMode: config.dmMode,
    autoComment: config.autoComment,
    commentPerRound: config.commentPerRound,
    mentionName: config.mentionName,
  };
  const dutyPrompt = buildDutyPrompt(config, settings);

  // 检索该角色的长期记忆，作为判断依据
  const activeMemories = await prisma.memoryItem.findMany({
    where: { memoryScopeId: globalScope.id, status: "ACTIVE", deletedAt: null },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: 20,
    select: { id: true, category: true, content: true, confidence: true },
  });

  const picked: BiliCandidate[] = [];
  const skipped: BiliCandidate[] = [];
  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    if (picked.length >= remaining) break;
    let reply: string;
    try {
      const result = await generateConversationReply({
        characterName: character.name,
        characterPrompt: character.basePrompt.slice(0, 12_000) + "\n\n" + dutyPrompt,
        model: modelSettings.model,
        apiKey,
        apiBaseUrl: modelSettings.apiBaseUrl,
        temperature: 0.4,
        maxTokens: 400,
        currentMessage: `视频：${candidate.title}（${candidate.bvid}，UP：${candidate.author}）。判断这条值不值得推荐给主人？只回答「值得」或「跳过」。`,
        recentMessages: [],
        memories: activeMemories.slice(0, 8).map((m) => ({
          id: m.id,
          category: m.category as never,
          content: m.content.slice(0, 800),
          confidence: m.confidence,
          relevanceScore: 0,
          scope: "character" as const,
        })),
        snapshots: [],
      });
      reply = result.reply;
    } catch {
      skipped.push(candidate);
      continue;
    }
    if (reply.includes("值得")) {
      picked.push(candidate);
    } else {
      skipped.push(candidate);
    }
  }

  // 4. 收尾：写报告 + 判重表（事务内）
  const roundIndex = (todayReports.reduce((max, r) => Math.max(max, r.roundIndex), 0)) + 1;
  const reportContent = picked
    .map((c) => `### ${c.bvid}\n${c.title}（UP：${c.author}）\n值得一看`)
    .join("\n\n");

  // 人格札记：替换掉 bili-desk 的 human-world.md，落成角色长期记忆。
  // 只在挑中视频时写 —— 「刷了 5 条一条没挑」不值得占用长期记忆，那种情况值班台
  // 自己的 BiliRoundReport 已经记着了。
  const journal = picked.length
    ? `我在 B站 看了 ${picked.length + skipped.length} 条视频，挑中了 ${picked.length} 条：${picked
        .map((c) => `《${c.title}》（UP：${c.author}）`)
        .join("、")}`
    : "";
  // 同一 (binding, day, roundIndex) 重跑时覆盖同一条记忆，不重复堆积
  const journalKey = `bili-duty:${binding.id}:${today}:${roundIndex}`;

  const report = await prisma.$transaction(async (tx) => {
    const created = await tx.biliRoundReport.create({
      data: {
        bindingId: binding.id,
        day: today,
        roundIndex,
        pickedCount: picked.length,
        content: reportContent || "（本轮没有挑中的视频）",
      },
      select: { id: true },
    });

    if (journal) {
      const existing = await tx.memoryItem.findFirst({
        where: { memoryScopeId: globalScope.id, dedupeKey: journalKey },
        select: { id: true },
      });
      if (existing) {
        await tx.memoryItem.update({ where: { id: existing.id }, data: { content: journal } });
      } else {
        await tx.memoryItem.create({
          data: {
            memoryScopeId: globalScope.id,
            category: "EVENT",
            content: journal,
            // 是模型自己的判断，不是主人亲口说的，可信度略低于对话抽取的记忆
            confidence: 0.8,
            dedupeKey: journalKey,
            validFrom: now,
          },
        });
      }
    }
    // 判重表：用 createMany + skipDuplicates 批量写。
    // 原来是逐条 create 再 catch 掉唯一冲突 —— 但在 Postgres 事务里，一条语句失败
    // 会让整个事务进入 aborted 状态，后面写的东西（包括上面那条记忆）跟着一起回滚。
    const seenRows = [...picked, ...skipped].map((c) => ({
      bindingId: binding.id,
      bvid: c.bvid,
      title: c.title,
      author: c.author,
      result: picked.includes(c) ? "picked" : "skipped",
      reason: picked.includes(c) ? "值得" : "跳过",
    }));
    if (seenRows.length) {
      await tx.biliSeenVideo.createMany({ data: seenRows, skipDuplicates: true });
    }
    return created;
  });

  return {
    ok: true,
    reportId: report.id,
    picked: picked.length,
    skipped: skipped.length,
    seenVideos: seenBvids.size + picked.length + skipped.length,
  };
}
