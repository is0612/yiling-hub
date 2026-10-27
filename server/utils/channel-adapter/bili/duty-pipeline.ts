/**
 * B站值班流水线（脚本化）—— 从 bili-desk 的 agent.py run_round 迁移而来。
 *
 * 采用"方案 B（脚本化）"：把"刷一轮"拆成固定步骤，只在「粗筛」「终判」「写评论」时
 * 调用 yiling-hub 的模型，其余步骤直接调 bili CLI。
 *
 * 一轮的步骤（对齐 docs/bili-desk-integration.md 第 5.1 节）：
 *   1. 读判重表（7 天内看过的不再挑）+ 今日额度
 *   2. 找候选：feed recommend / hot rank / search video
 *   3. 粗筛：把候选的标题/简介/推荐理由/播放量交给模型挑出值得细看的
 *   4. 看懂：对粗筛入选的逐条 `bili video watch`（信息+AI总结+字幕+热评）
 *   5. 终判：结合看懂的正文判断值不值得占主人的注意力
 *   6. 投递：私信主人（dm send owner）/ 公开评论（comment post --at）
 *   7. 收尾：报告 / 判重 / 人格札记写库
 *
 * ⚠️ 所有写操作（私信/评论）都检查 CLI 的 `ok` 字段与 error.code：
 *   risk_control / captcha_required / auth_expired 立即停手并写进报告，不重试、不绕过。
 */

import { randomUUID } from "node:crypto";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPrisma } from "../../prisma";
import { runBili, type BiliRunResult } from "./runner";
import { buildDutyPrompt, type BiliDutyRoundSettings } from "./duty-prompt";
import { generateConversationReply } from "../../chat-reply";
import { resolveChatModelSettings } from "../../chat-model-config";
import { resolveCharacterApiKey } from "../../credential-encryption";
import type { BiliConnectionRecord, BiliDutyConfig } from "./configure";
import { remainingQuota, toDayKey } from "./duty-scheduler";
import {
  extractBvids,
  formatCardForModel,
  formatWatchedForModel,
  isFatalBiliError,
  isRateLimited,
  parseJsonLoose,
  parseVerdict,
  parseVideoCards,
  parseWatchedVideo,
  readBiliError,
  unwrapBiliData,
  type BiliVideoCard,
  type BiliWatchedVideo,
} from "./cards";

export type BiliDutyRoundResult = {
  ok: boolean;
  reportId?: string;
  /** 最终挑中的条数。 */
  picked: number;
  /** 判为跳过（含看懂后放弃）的条数。 */
  skipped: number;
  /** 实际调用 `video watch` 看懂的条数。 */
  watched: number;
  seenVideos: number;
  /** 投递结果。 */
  delivered: { dm: boolean; comments: number };
  error?: string;
  /** 过程中值得记一笔的事（风控、限流、命令失败等）。 */
  notes: string[];
};

/** 最多攒多少条候选。 */
const MAX_CANDIDATES = 25;
/** 一轮最多「看懂」几条 —— watch 会拉字幕甚至触发语音转写，是这里最贵的操作。 */
const MAX_WATCH_PER_ROUND = 5;
/** watch 单条的超时：可能要等语音转写。 */
const WATCH_TIMEOUT_MS = 10 * 60 * 1000;
/** 私信正文上限（CLI 硬限制 500 字，留余量）。 */
const DM_MAX_CHARS = 480;
/** 评论文本上限（CLI 没有硬限，但像真人随口说一句）。 */
const COMMENT_MAX_CHARS = 120;

type CandidateSource = "feed" | "hot" | "search";

type Candidate = BiliVideoCard & { source: CandidateSource };

type PickedVideo = {
  candidate: Candidate;
  watched: BiliWatchedVideo | null;
  /** 模型给的一句话理由。 */
  reason: string;
  /** 模型写的公开评论（可能为空）。 */
  comment: string;
};

/** 把一段文本写进临时文件，交给 bili 的 `--file`（避免命令行被引号/换行切碎）。 */
async function withTempText<T>(text: string, fn: (path: string) => Promise<T>): Promise<T> {
  const path = join(tmpdir(), `yiling-bili-${randomUUID()}.txt`);
  await writeFile(path, text, "utf8");
  try {
    return await fn(path);
  } finally {
    await unlink(path).catch(() => undefined);
  }
}

function biliOptions(record: BiliConnectionRecord) {
  return {
    bin: record.biliBin || undefined,
    env: record.dataHome ? { BILI_DESK_HOME: record.dataHome } : undefined,
  };
}

/** 执行一条 bili 命令并把错误收进 notes；返回解析后的 data。 */
function readCommandData(result: BiliRunResult, label: string, notes: string[]): unknown | null {
  const error = readBiliError(result.json);
  if (error) {
    notes.push(`${label} 失败：${error.code}${error.message ? `（${error.message}）` : ""}`);
    return null;
  }
  if (result.timedOut) {
    notes.push(`${label} 超时（${Math.round(result.elapsed)} 秒）`);
    return null;
  }
  if (result.code !== 0 || result.json === null) {
    notes.push(`${label} 未返回 JSON（退出码 ${result.code}${result.stderr ? `：${result.stderr.slice(0, 120)}` : ""}）`);
    return null;
  }
  return unwrapBiliData(result.json);
}

/** 从模型回复里取「标签：内容」这一行。 */
function readLabeledLine(text: string, label: string): string {
  const match = text.match(new RegExp(`${label}\\s*[：:]\\s*(.+)`));
  if (!match) return "";
  const value = (match[1] ?? "").trim();
  return value === "无" || value === "没有" || value === "-" ? "" : value;
}

/**
 * 找候选：推荐流 + 分区热榜 + 关键词搜索。
 * 按 bvid 去重；已看过（7 天内）的不再进来。
 */
async function collectCandidates(
  record: BiliConnectionRecord,
  config: BiliDutyConfig,
  seenBvids: Set<string>,
  notes: string[],
): Promise<Candidate[]> {
  const options = biliOptions(record);
  const candidates: Candidate[] = [];
  const used = new Set<string>();

  const push = (cards: BiliVideoCard[], source: CandidateSource) => {
    for (const card of cards) {
      if (candidates.length >= MAX_CANDIDATES) return;
      if (seenBvids.has(card.bvid) || used.has(card.bvid)) continue;
      used.add(card.bvid);
      candidates.push({ ...card, source });
    }
  };

  const feed = await runBili(["feed", "recommend", "--unseen", "-n", "12"], options);
  const feedData = readCommandData(feed, "feed recommend", notes);
  if (feedData) push(parseVideoCards(feedData), "feed");

  // 排行榜是最稳的来源：不依赖这个账号的推荐画像，每天都有新东西。
  const hot = await runBili(["hot", "rank", "--zone", config.zone || "all", "--limit", "15", "--unseen"], options);
  const hotData = readCommandData(hot, "hot rank", notes);
  if (hotData) push(parseVideoCards(hotData), "hot");

  if (config.keywords.length > 0 && candidates.length < MAX_CANDIDATES) {
    for (const keyword of config.keywords.slice(0, 3)) {
      if (candidates.length >= MAX_CANDIDATES) break;
      // --order 的合法值只有 default/views/new/danmaku/favorites/comments。
      // 老实现传的是 pubdate（不存在），CLI 直接抛 invalid_argument，整条搜索路径全废。
      const searchResult = await runBili(["search", "video", keyword, "--order", "new", "--size", "10"], options);
      const searchData = readCommandData(searchResult, `search "${keyword}"`, notes);
      if (searchData) push(parseVideoCards(searchData), "search");
    }
  }

  return candidates;
}

/** 粗筛：把候选列表交给模型，让它挑出值得细看的（返回 bvid 数组）。 */
async function shortlistCandidates(
  candidates: Candidate[],
  limit: number,
  model: {
    characterName: string;
    characterPrompt: string;
    model: string;
    apiKey: string;
    apiBaseUrl?: string;
    memoryLines: string[];
  },
  notes: string[],
): Promise<string[]> {
  if (candidates.length === 0 || limit <= 0) return [];

  const listing = candidates.map((card, index) => formatCardForModel(card, index)).join("\n");
  const memoryText = model.memoryLines.length ? `我记得这些：\n${model.memoryLines.join("\n")}\n\n` : "";

  const prompt = [
    "这是我这轮刷到的候选视频。",
    "",
    `${memoryText}先粗筛一遍：把明显不值得花时间的剔掉，只留最值得细看的，最多 ${limit} 条。`,
    "拿不准的可以留，后面我会真的去看内容再定。",
    "",
    `只输出一个 JSON 数组，元素是 BV 号，按值得看的程度从高到低排，不要任何别的文字。`,
    `例如：["BV1xx411c7mD"]`,
    "",
    "候选：",
    listing,
  ].join("\n");

  let reply = "";
  try {
    const result = await generateConversationReply({
      characterName: model.characterName,
      characterPrompt: model.characterPrompt,
      model: model.model,
      apiKey: model.apiKey,
      apiBaseUrl: model.apiBaseUrl,
      temperature: 0.3,
      maxTokens: 512,
      currentMessage: prompt,
      recentMessages: [],
      memories: [],
      snapshots: [],
    });
    reply = result.reply;
  } catch (error) {
    notes.push(`粗筛调用模型失败：${error instanceof Error ? error.message : String(error)}`);
    return [];
  }

  const parsed = parseJsonLoose(reply);
  const known = new Set(candidates.map((c) => c.bvid));
  let picked: string[] = [];
  if (Array.isArray(parsed)) {
    picked = parsed.filter((item): item is string => typeof item === "string" && known.has(item));
  }
  // 模型没老实给 JSON 时，退化成从文本里抓 BV 号
  if (picked.length === 0) {
    picked = extractBvids(reply).filter((bvid) => known.has(bvid));
  }
  if (picked.length === 0) {
    notes.push(`粗筛没有选中任何候选（模型输出无法解析：${reply.slice(0, 80)}）`);
    return [];
  }
  // 去重并保持顺序，再按 limit 截断
  return [...new Set(picked)].slice(0, limit);
}

/** 看懂一条视频。失败返回 null（note 里会留下原因）。 */
async function watchVideo(
  record: BiliConnectionRecord,
  config: BiliDutyConfig,
  bvid: string,
  notes: string[],
): Promise<BiliWatchedVideo | null> {
  const args = ["video", "watch", bvid, "--comments", "5", "--max-chars", "1200", "--frames", String(config.frames)];
  const result = await runBili(args, { ...biliOptions(record), timeoutMs: WATCH_TIMEOUT_MS });
  const data = readCommandData(result, `video watch ${bvid}`, notes);
  if (!data) return null;
  const watched = parseWatchedVideo(data);
  if (!watched) notes.push(`video watch ${bvid} 返回结构无法解析`);
  return watched;
}

/** 终判：看着正文判断这条值不值得占主人的注意力。 */
async function judgeVideo(
  candidate: Candidate,
  watched: BiliWatchedVideo,
  model: {
    characterName: string;
    characterPrompt: string;
    model: string;
    apiKey: string;
    apiBaseUrl?: string;
    memoryLines: string[];
  },
  notes: string[],
): Promise<{ worth: boolean; reason: string; comment: string }> {
  const material = formatWatchedForModel(watched);
  const memoryText = model.memoryLines.length ? `我记得这些：\n${model.memoryLines.join("\n")}\n\n` : "";

  const prompt = [
    `${memoryText}我把这条视频看完了，材料如下：`,
    "",
    material,
    "",
    "---",
    "判断：这条值不值得占主人的注意力？拿不准就跳过，别反复权衡。",
    "按下面三行回答，一行一个字段，不要用 JSON、不要加别的解释：",
    "判断：值得  或  判断：跳过",
    "理由：一句话，30 字内，说清为什么",
    "评论：如果要公开评论，写一句 60 字内、像自己刷到随口说一句的话；不需要就写「无」",
  ].join("\n");

  let reply = "";
  try {
    const result = await generateConversationReply({
      characterName: model.characterName,
      characterPrompt: model.characterPrompt,
      model: model.model,
      apiKey: model.apiKey,
      apiBaseUrl: model.apiBaseUrl,
      temperature: 0.4,
      maxTokens: 400,
      currentMessage: prompt,
      recentMessages: [],
      memories: [],
      snapshots: [],
    });
    reply = result.reply;
  } catch (error) {
    notes.push(`终判 ${candidate.bvid} 调用模型失败：${error instanceof Error ? error.message : String(error)}`);
    return { worth: false, reason: "", comment: "" };
  }

  const verdict = parseVerdict(reply);
  const reason = readLabeledLine(reply, "理由").slice(0, 120) || verdict.reason.slice(0, 120);
  const comment = readLabeledLine(reply, "评论").slice(0, COMMENT_MAX_CHARS);
  return { worth: verdict.worth, reason, comment };
}

/** 组装私信正文：单条用「标题/链接/理由」，多条用编号汇总（都在 500 字内）。 */
function buildDmText(picked: PickedVideo[]): string {
  if (picked.length === 0) return "";
  if (picked.length === 1) {
    const only = picked[0];
    if (!only) return "";
    const lines = [`标题：${only.candidate.title.slice(0, 60)}`, `链接：${only.candidate.url}`];
    if (only.reason) lines.push(`理由：${only.reason}`);
    return lines.join("\n").slice(0, DM_MAX_CHARS);
  }

  const header = `今天挑了 ${picked.length} 条：`;
  const body: string[] = [];
  for (const [index, item] of picked.entries()) {
    const line = `${index + 1}. ${item.candidate.title.slice(0, 40)} — ${item.reason || "值得一看"}`;
    body.push(line);
    body.push(`   ${item.candidate.url}`);
  }
  const text = [header, ...body].join("\n");
  if (text.length <= DM_MAX_CHARS) return text;
  // 超长就少报几条，别把正文截断成半句话
  const trimmed = picked.slice(0, Math.max(1, picked.length - 1));
  return [header, ...trimmed.flatMap((item, index) => [`${index + 1}. ${item.candidate.title.slice(0, 40)} — ${item.reason || "值得一看"}`, `   ${item.candidate.url}`])]
    .join("\n")
    .slice(0, DM_MAX_CHARS);
}

type DeliveryOutcome = { sent: boolean; fatal: boolean; note?: string };

/** 私信主人。 */
async function deliverDm(record: BiliConnectionRecord, config: BiliDutyConfig, picked: PickedVideo[]): Promise<DeliveryOutcome> {
  if (config.dmMode === "off") return { sent: false, fatal: false };
  if (picked.length === 0) return { sent: false, fatal: false };
  const text = buildDmText(picked);
  if (!text.trim()) return { sent: false, fatal: false };

  const outcome = await withTempText(text, async (path) => {
    const result = await runBili(["dm", "send", "owner", "--file", path], biliOptions(record));
    return result;
  });

  const error = readBiliError(outcome.json);
  if (!error && outcome.code === 0) return { sent: true, fatal: false };
  const code = error?.code ?? (outcome.timedOut ? "timeout" : "unknown_error");
  const detail = error?.message || outcome.stderr.slice(0, 120);
  if (isFatalBiliError(code)) return { sent: false, fatal: true, note: `私信主人失败（${code}）：${detail}` };
  if (isRateLimited(code)) return { sent: false, fatal: false, note: `私信被本地限流，这轮放弃投递：${detail}` };
  return { sent: false, fatal: false, note: `私信主人失败（${code}）：${detail}` };
}

/** 发一条公开评论（有 @ 目标时用真正的 --at，对方会收到提醒）。 */
async function deliverComment(
  record: BiliConnectionRecord,
  config: BiliDutyConfig,
  bvid: string,
  text: string,
): Promise<DeliveryOutcome> {
  const trimmed = text.trim().slice(0, COMMENT_MAX_CHARS);
  if (!trimmed) return { sent: false, fatal: false };

  const args = ["comment", "post", bvid];
  const outcome = await withTempText(trimmed, async (path) => {
    const argv = [...args, "--file", path];
    if (config.mentionName) argv.push("--at", config.mentionName);
    return runBili(argv, biliOptions(record));
  });

  const error = readBiliError(outcome.json);
  if (!error && outcome.code === 0) return { sent: true, fatal: false };
  const code = error?.code ?? (outcome.timedOut ? "timeout" : "unknown_error");
  const detail = error?.message || outcome.stderr.slice(0, 120);
  if (isFatalBiliError(code)) return { sent: false, fatal: true, note: `评论 ${bvid} 失败（${code}）：${detail}` };
  if (isRateLimited(code)) return { sent: false, fatal: false, note: `评论 ${bvid} 被本地限流：${detail}` };
  return { sent: false, fatal: false, note: `评论 ${bvid} 失败（${code}）：${detail}` };
}

/**
 * 跑一轮值班。绑定到某个角色（binding），读该角色的长期记忆做判断，写报告/判重/札记。
 *
 * 注意：这里 bili CLI 的"找候选/看懂/投递"是真实跨进程调用；模型判断是真实模型调用。
 * 在没有配置 bili CLI / 模型 / 凭证的环境下，本函数会返回明确的错误，而不是假装成功。
 */
export async function runDutyRound(record: BiliConnectionRecord, binding: { id: string; characterId: string }): Promise<BiliDutyRoundResult> {
  const prisma = getPrisma();
  const now = new Date();
  const today = toDayKey(now);
  const notes: string[] = [];
  const empty = { picked: 0, skipped: 0, watched: 0, seenVideos: 0, delivered: { dm: false, comments: 0 } };

  const character = await prisma.character.findUnique({
    where: { id: binding.characterId },
    select: {
      id: true,
      name: true,
      basePrompt: true,
      status: true,
      modelConfig: true,
      memoryScopes: { where: { scopeType: "CHARACTER_GLOBAL" }, select: { id: true } },
    },
  });
  if (!character) return { ok: false, ...empty, notes, error: "找不到绑定的角色" };
  // 已暂停/归档的角色不应再主动刷视频或发评论。
  if (character.status !== "ACTIVE") return { ok: false, ...empty, notes, error: "角色已停用，跳过本轮值班" };
  const globalScope = character.memoryScopes[0];
  if (!globalScope) return { ok: false, ...empty, notes, error: "角色缺少全局记忆范围" };

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
    return { ok: false, ...empty, picked: pickedToday, seenVideos: seenBvids.size, notes, error: "今天额度已用完" };
  }

  // 2. 找候选
  const candidates = await collectCandidates(record, config, seenBvids, notes);
  if (candidates.length === 0) {
    const fatal = notes.some((note) => /auth_expired|not_logged_in|login_pending/.test(note));
    return {
      ok: !fatal,
      ...empty,
      seenVideos: seenBvids.size,
      notes,
      error: fatal ? "B站凭证失效，需要重新扫码登录" : "没有新候选",
    };
  }

  // 3. 模型准备（粗筛和终判共用）
  const modelSettings = resolveChatModelSettings(character.modelConfig);
  let apiKey = "";
  try {
    apiKey = await resolveCharacterApiKey(character.modelConfig, modelSettings.apiBaseUrl);
  } catch {
    return { ok: false, ...empty, skipped: candidates.length, seenVideos: seenBvids.size, notes, error: "角色 API Key 解密失败" };
  }
  if (!apiKey || !modelSettings.model) {
    return { ok: false, ...empty, skipped: candidates.length, seenVideos: seenBvids.size, notes, error: "角色未配置模型" };
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
    watchLimit: Math.min(MAX_WATCH_PER_ROUND, Math.max(remaining, 1) + 2),
  };
  const dutyPrompt = buildDutyPrompt(config, settings);

  // 检索该角色的长期记忆，作为判断依据
  const activeMemories = await prisma.memoryItem.findMany({
    where: { memoryScopeId: globalScope.id, status: "ACTIVE", deletedAt: null },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: 20,
    select: { id: true, category: true, content: true, confidence: true },
  });
  const memoryLines = activeMemories.slice(0, 8).map((m) => `- [${m.category}] ${m.content.slice(0, 200)}`);

  const model = {
    characterName: character.name,
    // 粗筛和终判共用同一份人设 + 值班准则，避免两步的尺度不一致
    characterPrompt: `${character.basePrompt.slice(0, 12_000)}\n\n${dutyPrompt}`,
    model: modelSettings.model,
    apiKey,
    apiBaseUrl: modelSettings.apiBaseUrl,
    memoryLines,
  };

  // 4. 粗筛：只对入选的才付出 watch 的代价
  const shortlist = await shortlistCandidates(candidates, settings.watchLimit, model, notes);
  const byBvid = new Map(candidates.map((card) => [card.bvid, card]));

  // 5. 看懂 + 终判
  const picked: PickedVideo[] = [];
  const skipped: Candidate[] = [];
  let watchedCount = 0;

  for (const bvid of shortlist) {
    const candidate = byBvid.get(bvid);
    if (!candidate) continue;
    if (picked.length >= remaining) break;

    const watched = await watchVideo(record, config, bvid, notes);
    if (!watched) {
      // 看不懂就不硬判 —— 记为跳过，理由写清楚，别假装看过
      skipped.push(candidate);
      continue;
    }
    watchedCount += 1;

    // watch 返回的 owner 才是权威的 UP 名，顺手补上卡片的作者（列表卡片有时是空的）
    if (!candidate.author.name && watched.author.name) candidate.author = watched.author;

    const verdict = await judgeVideo(candidate, watched, model, notes);
    if (verdict.worth && picked.length < remaining) {
      picked.push({ candidate, watched, reason: verdict.reason, comment: verdict.comment });
    } else {
      skipped.push(candidate);
    }

    // 风控一旦出现，本轮立刻停止继续 watch
    if (notes.some((note) => /risk_control|captcha_required/.test(note))) break;
  }

  // 没进粗筛的候选也算"看过"，写进判重表，避免下一轮反复出现在候选里
  const shortlistSet = new Set(shortlist);
  for (const candidate of candidates) {
    if (!shortlistSet.has(candidate.bvid)) skipped.push(candidate);
  }

  // 6. 投递
  const delivered = { dm: false, comments: 0 };
  if (picked.length > 0) {
    const dmOutcome = await deliverDm(record, config, picked);
    delivered.dm = dmOutcome.sent;
    if (dmOutcome.note) notes.push(dmOutcome.note);

    const commentEnabled = config.autoComment && config.dmMode !== "only";
    if (commentEnabled && !dmOutcome.fatal) {
      let fatal = false;
      const commentTargets = picked.filter((item) => item.comment).slice(0, config.commentPerRound);
      for (const item of commentTargets) {
        if (fatal) break;
        const outcome = await deliverComment(record, config, item.candidate.bvid, item.comment);
        if (outcome.sent) delivered.comments += 1;
        if (outcome.note) notes.push(outcome.note);
        if (outcome.fatal) fatal = true;
      }
    }
  }

  // 7. 收尾：写报告 + 判重表（事务内）
  const roundIndex = todayReports.reduce((max, r) => Math.max(max, r.roundIndex), 0) + 1;
  const reportContent = picked
    .map((item) => {
      const lines = [`### ${item.candidate.bvid}`, `${item.candidate.title}（UP：${item.candidate.author.name || "未知"}）`, item.candidate.url];
      if (item.reason) lines.push(`理由：${item.reason}`);
      return lines.join("\n");
    })
    .join("\n\n");

  // 人格札记：替换掉 bili-desk 的 human-world.md，落成角色长期记忆。
  // 只在挑中视频时写 —— 「刷了 5 条一条没挑」不值得占用长期记忆，那种情况值班台
  // 自己的 BiliRoundReport 已经记着了。
  const journal = picked.length
    ? `我在 B站 看了 ${watchedCount} 条视频，挑中了 ${picked.length} 条：${picked
        .map((item) => `《${item.candidate.title.slice(0, 40)}》（UP：${item.candidate.author.name || "未知"}）`)
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
    const seenRows = [...picked, ...skipped].map((entry) => {
      const isPicked = "candidate" in entry;
      const candidate = isPicked ? entry.candidate : entry;
      const reason = isPicked ? entry.reason : "";
      return {
        bindingId: binding.id,
        bvid: candidate.bvid,
        title: candidate.title,
        author: candidate.author.name,
        result: isPicked ? "picked" : "skipped",
        reason: isPicked ? reason || "值得" : "跳过",
      };
    });
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
    watched: watchedCount,
    seenVideos: seenBvids.size + picked.length + skipped.length,
    delivered,
    notes,
  };
}
