/**
 * 日记 / 手账的「取材 → 生成 → 落库」。
 *
 * 两份文本同一天共用一份素材，但独立生成、独立版本、独立编辑：
 *   - DIARY：第一人称叙事；
 *   - HANDBOOK：结构化记录，今日一句必须引用某一版日记正文。
 *
 * Worker 的自动任务和页面上的手动生成 / 重写共用这一份实现 ——
 * 两条路径各写一套，迟早出现「自动的能带来源、手动的不能」这种偏差。
 *
 * 范围（V1）：
 *   - 挂在角色全局范围下，一天一条日期主体；
 *   - 取材包含角色全局范围 + 角色主人自己的私人范围（主人 QQ 私聊），
 *     其他用户的私人范围**不读**；
 *   - 两份都没有内容时落一条 SKIPPED 标记，不生成空文本。
 */

import type { Prisma, PrismaClient } from "../../src/generated/prisma/client";
import { resolveChatModelSettings } from "./chat-model-config";
import { resolveCharacterApiKey } from "./credential-encryption";
import { readDailyQuota, recordModelUsage } from "./model-usage";
import {
  DIARY_CONTENT_MAX,
  DIARY_CONTENT_MIN,
  HANDBOOK_CONTENT_MAX,
  HANDBOOK_QUOTE_MAX,
  HANDBOOK_TAG_LIMIT,
  HANDBOOK_THOUGHT_MAX,
  generateDiary,
  generateHandbook,
  isQuoteFromContent,
  type JournalAiEvent,
  type JournalAiMessage,
} from "./journal-ai";
import { localDayKey, resolveDailyEventWindow, resolveDayWindow } from "./memory-event-time";
import { resolveChatTimeZone } from "./chat-time-context";
import { selectPeriodSourceMessages } from "./memory-source-selection";
import {
  conversationOriginLabel,
  readMessageIsOwner,
  readMessageMentionTargets,
} from "./conversation-message";

/** 一天最多把多少条消息喂给日记/手账（按会话配额分配）。 */
export const JOURNAL_MESSAGE_BUDGET = 150;
export const JOURNAL_PER_CONVERSATION = 80;
/** 单条消息进提示词时的截断长度。 */
export const JOURNAL_AI_MESSAGE_CHARS = 800;
export const JOURNAL_EVENT_LIMIT = 30;

export type JournalTextKind = "DIARY" | "HANDBOOK";
export type JournalGenerationTarget = JournalTextKind | "BOTH";
export type JournalGenerationMode = "auto" | "manual" | "regenerate";

export type JournalRevisionRow = {
  id: string;
  journalId: string;
  kind: JournalTextKind;
  version: number;
  title: string | null;
  content: string;
  thought: string | null;
  quote: string | null;
  tags: string[];
  sourceDiaryRevisionId: string | null;
  sourceMessageIds: string[];
  sourceEventIds: string[];
  revisionType: string;
  promptVersion: string | null;
  model: string | null;
  editedByUserId: string | null;
  createdAt: Date;
};

export type JournalGenerationOutcome = {
  status: "created" | "skipped" | "existing" | "inactive" | "not_configured" | "quota_exceeded";
  journalId?: string;
  created?: Partial<Record<JournalTextKind, JournalRevisionRow>>;
  reason?: string;
  message?: string;
};

type JournalCharacter = {
  id: string;
  ownerId: string;
  name: string;
  basePrompt: string;
  styleExamples: string;
  status: string;
  modelConfig: unknown;
  memorySetting: { timezone: string } | null;
  memoryScopes: Array<{ id: string; scopeType: string; userId: string | null }>;
};

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isJournalDayKey(value: string): boolean {
  if (!DAY_KEY_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function journalCharacterSelect() {
  return {
    id: true,
    ownerId: true,
    name: true,
    basePrompt: true,
    styleExamples: true,
    status: true,
    modelConfig: true,
    memorySetting: { select: { timezone: true } },
    memoryScopes: { select: { id: true, scopeType: true, userId: true } },
  } as const;
}

export function resolveJournalScopeIds(character: JournalCharacter): {
  globalScopeId: string;
  ownerPrivateScopeId: string | null;
} {
  const globalScope = character.memoryScopes.find((scope) => scope.scopeType === "CHARACTER_GLOBAL");
  if (!globalScope) throw new Error("角色缺少全局记忆范围");
  const ownerPrivate = character.ownerId
    ? character.memoryScopes.find((scope) => scope.scopeType === "USER_PRIVATE" && scope.userId === character.ownerId)
    : undefined;
  return {
    globalScopeId: globalScope.id,
    ownerPrivateScopeId: ownerPrivate?.id ?? null,
  };
}

export const journalRevisionSelect = {
  id: true,
  journalId: true,
  kind: true,
  version: true,
  title: true,
  content: true,
  thought: true,
  quote: true,
  tags: true,
  sourceDiaryRevisionId: true,
  sourceMessageIds: true,
  sourceEventIds: true,
  revisionType: true,
  promptVersion: true,
  model: true,
  editedByUserId: true,
  createdAt: true,
} as const;

function latestPerKind(rows: JournalRevisionRow[]): Partial<Record<JournalTextKind, JournalRevisionRow>> {
  const latest: Partial<Record<JournalTextKind, JournalRevisionRow>> = {};
  for (const row of rows) {
    if (!latest[row.kind]) latest[row.kind] = row;
  }
  return latest;
}

async function loadJournalWithRevisions(prisma: PrismaClient, globalScopeId: string, dayKey: string) {
  return prisma.characterJournal.findUnique({
    where: { memoryScopeId_dayKey: { memoryScopeId: globalScopeId, dayKey } },
    select: {
      id: true,
      status: true,
      skipReason: true,
      revisions: {
        orderBy: [{ kind: "asc" }, { version: "desc" }],
        select: journalRevisionSelect,
      },
    },
  });
}

/**
 * 取材：当天她参与的对话 + 当天已经整理出来的忆泡。
 *
 * 忆泡只作补充；日记/手账的主要证据仍然是原始消息。两条文本共用同一份素材，
 * 但各自组织，不复用输出。
 */
export async function collectJournalSources(
  prisma: PrismaClient,
  input: { scopeIds: string[]; dayKey: string; timeZone: string },
): Promise<{
  messages: JournalAiMessage[];
  events: JournalAiEvent[];
  totalMessageCount: number;
  omittedMessageCount: number;
  start: Date;
  end: Date;
}> {
  const { start, end } = resolveDayWindow(input.dayKey, input.timeZone);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) {
    throw new Error("手账日期无效");
  }

  // 一天可能有很多群。一对一（桌面端 / 主人私聊）先取，群聊再按最近活跃度取，
  // 不能一条 SQL 全量拉：几十个群 × 每群一次查询，会把一天的手账取材拖成几十次往返。
  const [directConversations, groupConversations] = await Promise.all([
    prisma.conversation.findMany({
      where: {
        memoryScopeId: { in: input.scopeIds },
        messages: { some: { occurredAt: { gte: start, lt: end } } },
        OR: [{ externalConversationId: null }, { externalConversationId: { startsWith: "c:" } }],
      },
      orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
      take: 20,
      select: { id: true, externalConversationId: true },
    }),
    prisma.conversation.findMany({
      where: {
        memoryScopeId: { in: input.scopeIds },
        messages: { some: { occurredAt: { gte: start, lt: end } } },
        externalConversationId: { startsWith: "g:" },
      },
      orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
      take: 40,
      select: { id: true, externalConversationId: true },
    }),
  ]);
  const conversations = [...directConversations, ...groupConversations];

  const batches = await Promise.all(conversations.map(async (conversation) => {
    const rows = await prisma.message.findMany({
      where: { conversationId: conversation.id, occurredAt: { gte: start, lt: end } },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: JOURNAL_PER_CONVERSATION,
      select: { id: true, role: true, content: true, occurredAt: true, metadata: true },
    });
    const origin = conversationOriginLabel(conversation);
    return rows.map((row) => ({
      ...row,
      conversationId: conversation.id,
      origin,
      isOwner: readMessageIsOwner(row.metadata),
      mentionTargets: readMessageMentionTargets(row.metadata),
    }));
  }));

  const selected = selectPeriodSourceMessages(batches.flat(), {
    budget: JOURNAL_MESSAGE_BUDGET,
    perConversation: JOURNAL_PER_CONVERSATION,
  });

  const [totalMessageCount, eventRows] = await Promise.all([
    prisma.message.count({
      where: {
        conversation: { is: { memoryScopeId: { in: input.scopeIds } } },
        occurredAt: { gte: start, lt: end },
      },
    }),
    prisma.memoryEvent.findMany({
      where: { memoryScopeId: { in: input.scopeIds }, dayKey: input.dayKey, status: "ACTIVE" },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      take: JOURNAL_EVENT_LIMIT,
      select: { id: true, occurredAt: true, title: true, detail: true },
    }),
  ]);

  const messages: JournalAiMessage[] = selected.map((message) => ({
    id: message.id,
    role: message.role,
    occurredAt: message.occurredAt.toISOString(),
    content: message.content.slice(0, JOURNAL_AI_MESSAGE_CHARS),
    origin: message.origin,
    isOwner: message.isOwner,
    ...(message.mentionTargets?.length ? { mentionTargets: message.mentionTargets } : {}),
  }));

  return {
    messages,
    events: eventRows.map((event) => ({
      id: event.id,
      occurredAt: event.occurredAt.toISOString(),
      title: event.title,
      detail: event.detail.slice(0, 600),
    })),
    totalMessageCount,
    omittedMessageCount: Math.max(0, totalMessageCount - messages.length),
    start,
    end,
  };
}

async function markDaySkipped(
  prisma: PrismaClient,
  globalScopeId: string,
  dayKey: string,
  reason: string,
): Promise<string> {
  const journal = await prisma.characterJournal.upsert({
    where: { memoryScopeId_dayKey: { memoryScopeId: globalScopeId, dayKey } },
    create: { memoryScopeId: globalScopeId, dayKey, status: "SKIPPED", skipReason: reason.slice(0, 300) },
    update: { status: "SKIPPED", skipReason: reason.slice(0, 300) },
    select: { id: true },
  });
  return journal.id;
}

async function nextVersion(
  tx: Prisma.TransactionClient,
  journalId: string,
  kind: JournalTextKind,
): Promise<number> {
  const latest = await tx.journalRevision.findFirst({
    where: { journalId, kind },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  return (latest?.version ?? 0) + 1;
}

/**
 * 版本号是「读当前最大 + 1」再写：两个写请求同时发生（页面重写 + Worker 重试）
 * 时，后写的会撞 `(journalId, kind, version)` 唯一约束。
 *
 * 只对 Prisma 的 P2002 重试：重试时会重新读到新的最大版本再写一次；
 * 其他错误原样抛出，不能把真正的写入失败吞成「重试三次」。
 */
export async function retryOnVersionConflict<T>(
  operation: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  const total = Math.max(1, Math.trunc(attempts));
  let lastError: unknown;
  for (let attempt = 0; attempt < total; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if ((error as { code?: unknown } | null)?.code !== "P2002") throw error;
    }
  }
  throw lastError;
}

async function persistRevision(
  prisma: PrismaClient,
  input: {
    globalScopeId: string;
    dayKey: string;
    kind: JournalTextKind;
    mode: JournalGenerationMode;
    title?: string | null;
    content: string;
    thought?: string | null;
    quote?: string | null;
    tags?: string[];
    sourceDiaryRevisionId?: string | null;
    sourceMessageIds: string[];
    sourceEventIds: string[];
    model: string;
    promptVersion: string;
    actorUserId?: string | null;
  },
): Promise<JournalRevisionRow> {
  return retryOnVersionConflict(() => prisma.$transaction(async (tx) => {
    const journal = await tx.characterJournal.upsert({
      where: { memoryScopeId_dayKey: { memoryScopeId: input.globalScopeId, dayKey: input.dayKey } },
      create: { memoryScopeId: input.globalScopeId, dayKey: input.dayKey, status: "ACTIVE" },
      update: { status: "ACTIVE", skipReason: null },
      select: { id: true },
    });
    const version = await nextVersion(tx, journal.id, input.kind);
    return tx.journalRevision.create({
      data: {
        journalId: journal.id,
        kind: input.kind,
        version,
        title: input.title ?? null,
        content: input.content,
        thought: input.thought ?? null,
        quote: input.quote ?? null,
        tags: input.tags ?? [],
        sourceDiaryRevisionId: input.sourceDiaryRevisionId ?? null,
        sourceMessageIds: input.sourceMessageIds,
        sourceEventIds: input.sourceEventIds,
        revisionType: input.mode === "regenerate" ? "AI_REWRITE" : "AI_GENERATED",
        promptVersion: input.promptVersion,
        model: input.model,
        editedByUserId: input.actorUserId ?? null,
      },
      select: journalRevisionSelect,
    });
  }));
}

/**
 * 生成一天的日记 / 手账。
 *
 * `target` 决定生成哪一份（BOTH = 两份都补），`mode` 决定已有内容怎么处理：
 *   - auto：已有正文的那份不动（重试不能覆盖）；
 *   - manual：没有正文时补写，已有正文返回 existing；
 *   - regenerate：强制为新版本，旧版保留。
 *
 * 手账的「今日一句」永远引用生成时那一版日记，并记下 `sourceDiaryRevisionId`。
 */
export async function generateJournalForDay(
  input: {
    characterId: string;
    dayKey: string;
    mode: JournalGenerationMode;
    target?: JournalGenerationTarget;
    now?: Date;
    actorUserId?: string | null;
  },
  prisma: PrismaClient,
): Promise<JournalGenerationOutcome> {
  if (!isJournalDayKey(input.dayKey)) {
    return { status: "skipped", reason: "日期格式无效" };
  }

  const character = await prisma.character.findUnique({
    where: { id: input.characterId },
    select: journalCharacterSelect(),
  }) as JournalCharacter | null;
  if (!character) return { status: "skipped", reason: "角色不存在" };
  if (character.status !== "ACTIVE") return { status: "inactive" };

  let scopes: { globalScopeId: string; ownerPrivateScopeId: string | null };
  try {
    scopes = resolveJournalScopeIds(character);
  } catch {
    return { status: "skipped", reason: "角色缺少全局记忆范围" };
  }
  const { globalScopeId, ownerPrivateScopeId } = scopes;
  const timeZone = resolveChatTimeZone(character.memorySetting?.timezone);
  const target = input.target ?? "BOTH";
  const requested: JournalTextKind[] = target === "BOTH" ? ["DIARY", "HANDBOOK"] : [target];

  const existing = await loadJournalWithRevisions(prisma, globalScopeId, input.dayKey);
  const latest = latestPerKind((existing?.revisions ?? []) as JournalRevisionRow[]);
  const needed = requested.filter((kind) => input.mode === "regenerate" || !latest[kind]);
  if (needed.length === 0) {
    return { status: "existing", journalId: existing?.id };
  }

  const scopeIds = [globalScopeId, ownerPrivateScopeId].filter((id): id is string => Boolean(id));
  const sources = await collectJournalSources(prisma, { scopeIds, dayKey: input.dayKey, timeZone });
  if (sources.messages.length === 0) {
    if (latest.DIARY || latest.HANDBOOK) {
      return { status: "skipped", journalId: existing?.id, reason: "这一天没有新的对话" };
    }
    const journalId = await markDaySkipped(prisma, globalScopeId, input.dayKey, "这一天没有对话");
    return { status: "skipped", journalId, reason: "这一天没有对话" };
  }

  const modelSettings = resolveChatModelSettings(character.modelConfig);
  let apiKey = "";
  try {
    apiKey = await resolveCharacterApiKey(character.modelConfig, modelSettings.apiBaseUrl);
  } catch {
    return { status: "not_configured", message: "角色 API Key 无法解密，请重新填写模型配置。" };
  }
  if (!apiKey || !modelSettings.model) {
    return { status: "not_configured", message: "角色还没有配置模型，先把「模型设置」填好。" };
  }

  const quota = await readDailyQuota(character.id, character.modelConfig);
  if (quota.exceeded) {
    return { status: "quota_exceeded", message: "今日模型额度已用完，日记/手账暂时不写。" };
  }

  const aiInput = {
    apiKey,
    ...(modelSettings.apiBaseUrl ? { apiBaseUrl: modelSettings.apiBaseUrl } : {}),
    model: modelSettings.model,
    dayKey: input.dayKey,
    timezone: timeZone,
    characterName: character.name,
    basePrompt: character.basePrompt,
    ...(character.styleExamples ? { styleExamples: character.styleExamples } : {}),
    messages: sources.messages,
    events: sources.events,
    totalMessageCount: sources.totalMessageCount,
    omittedMessageCount: sources.omittedMessageCount,
  };

  const created: Partial<Record<JournalTextKind, JournalRevisionRow>> = {};
  const skipReasons: string[] = [];

  if (needed.includes("DIARY")) {
    const result = await generateDiary(aiInput);
    if (result.usage) {
      await recordModelUsage({
        kind: "journal",
        model: result.model,
        usage: result.usage,
        characterId: character.id,
        metadata: { text: "diary" },
      });
    }
    if (result.entry.action === "CREATE") {
      const revision = await persistRevision(prisma, {
        globalScopeId,
        dayKey: input.dayKey,
        kind: "DIARY",
        mode: input.mode,
        title: result.entry.title ?? null,
        content: result.entry.content,
        sourceMessageIds: result.entry.sourceMessageIds,
        sourceEventIds: result.entry.sourceEventIds,
        model: result.model,
        promptVersion: result.promptVersion,
        actorUserId: input.actorUserId,
      });
      created.DIARY = revision;
      latest.DIARY = revision;
    } else {
      skipReasons.push(`日记：${result.entry.reason}`);
    }
  }

  if (needed.includes("HANDBOOK")) {
    const diary = latest.DIARY;
    const result = await generateHandbook(
      aiInput,
      diary ? { revisionId: diary.id, content: diary.content } : null,
    );
    if (result.usage) {
      await recordModelUsage({
        kind: "journal",
        model: result.model,
        usage: result.usage,
        characterId: character.id,
        metadata: { text: "handbook" },
      });
    }
    if (result.entry.action === "CREATE") {
      const revision = await persistRevision(prisma, {
        globalScopeId,
        dayKey: input.dayKey,
        kind: "HANDBOOK",
        mode: input.mode,
        content: result.entry.content,
        thought: result.entry.thought ?? null,
        quote: result.entry.quote ?? null,
        tags: result.entry.tags,
        sourceDiaryRevisionId: result.entry.quote ? diary?.id ?? null : null,
        sourceMessageIds: result.entry.sourceMessageIds,
        sourceEventIds: result.entry.sourceEventIds,
        model: result.model,
        promptVersion: result.promptVersion,
        actorUserId: input.actorUserId,
      });
      created.HANDBOOK = revision;
    } else {
      skipReasons.push(`手账：${result.entry.reason}`);
    }
  }

  if (Object.keys(created).length > 0) {
    return {
      status: "created",
      journalId: created.DIARY?.journalId ?? created.HANDBOOK?.journalId,
      created,
    };
  }

  const reason = skipReasons.join("；") || "这一天没有值得写的内容";
  if (latest.DIARY || latest.HANDBOOK) {
    return { status: "skipped", journalId: existing?.id, reason };
  }
  const journalId = await markDaySkipped(prisma, globalScopeId, input.dayKey, reason);
  return { status: "skipped", journalId, reason };
}

/** 人工编辑：按 kind 新建一版，绝不覆盖另一份文本或旧版本。 */
export async function saveJournalEdit(
  input: {
    characterId: string;
    dayKey: string;
    kind: JournalTextKind;
    content: string;
    title?: string | null;
    thought?: string | null;
    quote?: string | null;
    tags?: string[] | null;
    actorUserId: string;
  },
  prisma: PrismaClient,
): Promise<{ ok: true; revision: JournalRevisionRow } | { ok: false; message: string }> {
  const character = await prisma.character.findUnique({
    where: { id: input.characterId },
    select: journalCharacterSelect(),
  }) as JournalCharacter | null;
  if (!character) return { ok: false, message: "角色不存在" };
  let globalScopeId: string;
  try {
    ({ globalScopeId } = resolveJournalScopeIds(character));
  } catch {
    return { ok: false, message: "角色缺少全局记忆范围" };
  }
  const journal = await loadJournalWithRevisions(prisma, globalScopeId, input.dayKey);
  if (!journal) return { ok: false, message: "这一天还没有日记或手账" };
  const latest = latestPerKind(journal.revisions as JournalRevisionRow[]);
  const previous = latest[input.kind];

  const content = input.content.trim();
  if (input.kind === "DIARY") {
    if (content.length < DIARY_CONTENT_MIN) {
      return { ok: false, message: `日记太短了（至少 ${DIARY_CONTENT_MIN} 字）` };
    }
    if (content.length > DIARY_CONTENT_MAX) {
      return { ok: false, message: `日记太长了（最多 ${DIARY_CONTENT_MAX} 字）` };
    }
  } else if (content.length > HANDBOOK_CONTENT_MAX) {
    return { ok: false, message: `手账正文太长了（最多 ${HANDBOOK_CONTENT_MAX} 字）` };
  }

  const thought = input.kind === "HANDBOOK" ? input.thought?.trim().slice(0, HANDBOOK_THOUGHT_MAX) || null : null;
  const tags = input.kind === "HANDBOOK"
    ? [...new Set((input.tags ?? []).map((tag) => tag.trim().slice(0, 20)).filter(Boolean))].slice(0, HANDBOOK_TAG_LIMIT)
    : [];
  const quoteInput = input.kind === "HANDBOOK" ? input.quote?.trim().slice(0, HANDBOOK_QUOTE_MAX) || null : null;

  // 手账不能是空的；日记正文必填已由上面的长度校验保证。
  if (input.kind === "HANDBOOK" && !content && !thought && !quoteInput && tags.length === 0) {
    return { ok: false, message: "手账不能是空的：至少留一条片段、想法、一句或标签。" };
  }

  let sourceDiaryRevisionId: string | null = null;
  if (quoteInput) {
    // 在所有日记版本里找包含这句话的那一版：优先沿用上一版手账引用的那一版，
    // 找不到再从新到旧找。这样把「一句」改成旧日记里的原话也不会被误拒。
    const diaryRevisions = await prisma.journalRevision.findMany({
      where: { journalId: journal.id, kind: "DIARY" },
      orderBy: { version: "desc" },
      select: { id: true, content: true },
    });
    const preferred = previous?.sourceDiaryRevisionId
      ? diaryRevisions.find((revision) => revision.id === previous.sourceDiaryRevisionId)
      : undefined;
    const matched = preferred && isQuoteFromContent(preferred.content, quoteInput)
      ? preferred
      : diaryRevisions.find((revision) => isQuoteFromContent(revision.content, quoteInput));
    if (!matched) {
      return {
        ok: false,
        message: diaryRevisions.length
          ? "「一句」必须是日记正文里的原话；改完日记后请重选或清空它。"
          : "这一天还没有日记，「一句」没有可引用的原文。",
      };
    }
    sourceDiaryRevisionId = matched.id;
  }

  const revision = await retryOnVersionConflict(() => prisma.$transaction(async (tx) => {
    // 人工修改是基于上一版改的，把来源一起带过来。
    const sourceMessageIds = previous?.sourceMessageIds.length
      ? previous.sourceMessageIds
      : latest.DIARY?.sourceMessageIds ?? [];
    const sourceEventIds = previous?.sourceEventIds.length
      ? previous.sourceEventIds
      : latest.DIARY?.sourceEventIds ?? [];
    const version = await nextVersion(tx, journal.id, input.kind);
    const created = await tx.journalRevision.create({
      data: {
        journalId: journal.id,
        kind: input.kind,
        version,
        title: input.kind === "DIARY" ? input.title?.trim().slice(0, 120) || null : null,
        content,
        thought,
        quote: quoteInput,
        tags,
        sourceDiaryRevisionId,
        sourceMessageIds,
        sourceEventIds,
        revisionType: "USER_EDITED",
        editedByUserId: input.actorUserId,
      },
      select: journalRevisionSelect,
    });
    await tx.characterJournal.update({ where: { id: journal.id }, data: { status: "ACTIVE", skipReason: null } });
    return created;
  }));
  return { ok: true, revision };
}

/** 恢复旧版本：复制旧内容成新版本，旧版本原样保留。 */
export async function restoreJournalRevision(
  input: { characterId: string; dayKey: string; kind: JournalTextKind; version: number; actorUserId: string },
  prisma: PrismaClient,
): Promise<{ ok: true; revision: JournalRevisionRow } | { ok: false; message: string }> {
  const character = await prisma.character.findUnique({
    where: { id: input.characterId },
    select: journalCharacterSelect(),
  }) as JournalCharacter | null;
  if (!character) return { ok: false, message: "角色不存在" };
  let globalScopeId: string;
  try {
    ({ globalScopeId } = resolveJournalScopeIds(character));
  } catch {
    return { ok: false, message: "角色缺少全局记忆范围" };
  }
  const journal = await prisma.characterJournal.findUnique({
    where: { memoryScopeId_dayKey: { memoryScopeId: globalScopeId, dayKey: input.dayKey } },
    select: { id: true },
  });
  if (!journal) return { ok: false, message: "这一天还没有日记或手账" };
  const source = await prisma.journalRevision.findUnique({
    where: { journalId_kind_version: { journalId: journal.id, kind: input.kind, version: input.version } },
    select: journalRevisionSelect,
  });
  if (!source) return { ok: false, message: "找不到这个版本" };

  const revision = await retryOnVersionConflict(() => prisma.$transaction(async (tx) => {
    const version = await nextVersion(tx, journal.id, input.kind);
    return tx.journalRevision.create({
      data: {
        journalId: journal.id,
        kind: input.kind,
        version,
        title: source.title,
        content: source.content,
        thought: source.thought,
        quote: source.quote,
        tags: source.tags,
        sourceDiaryRevisionId: source.sourceDiaryRevisionId,
        sourceMessageIds: source.sourceMessageIds,
        sourceEventIds: source.sourceEventIds,
        revisionType: "RESTORED",
        promptVersion: source.promptVersion,
        model: source.model,
        editedByUserId: input.actorUserId,
      },
      select: journalRevisionSelect,
    });
  }));
  return { ok: true, revision };
}

/**
 * 次日对话要带上的「昨天手账里的那一句」。
 *
 * 优先取手账的 quote；老数据（拆分前）的 quote 记在日记版本上，兜底读它。
 */
export async function readPreviousJournalLine(
  prisma: PrismaClient,
  characterId: string,
  now: Date,
  timeZone: string,
): Promise<{ dayKey: string; quote: string } | null> {
  const globalScope = await prisma.memoryScope.findFirst({
    where: { characterId, scopeType: "CHARACTER_GLOBAL" },
    select: { id: true },
  });
  if (!globalScope) return null;
  const { dayKey } = resolveDailyEventWindow(now, timeZone);
  const journal = await prisma.characterJournal.findUnique({
    where: { memoryScopeId_dayKey: { memoryScopeId: globalScope.id, dayKey } },
    select: { id: true },
  });
  if (!journal) return null;

  const handbook = await prisma.journalRevision.findFirst({
    where: { journalId: journal.id, kind: "HANDBOOK" },
    orderBy: { version: "desc" },
    select: { quote: true },
  });
  // 有手账就以最新一版手账为准：用户把「一句」清掉后，不能再拿旧版的句子顶上。
  if (handbook) {
    const quote = handbook.quote?.trim();
    return quote ? { dayKey, quote } : null;
  }

  // 拆分前的旧数据没有手账版本，quote 存在日记上。
  const legacyDiary = await prisma.journalRevision.findFirst({
    where: { journalId: journal.id, kind: "DIARY" },
    orderBy: { version: "desc" },
    select: { quote: true },
  });
  const legacyQuote = legacyDiary?.quote?.trim();
  if (legacyQuote) return { dayKey, quote: legacyQuote };
  return null;
}

/** 给页面/接口用的「今天」日期键（角色时区）。 */
export function journalTodayKey(now: Date, timeZone: string): string {
  return localDayKey(now, timeZone);
}
