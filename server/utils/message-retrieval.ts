/**
 * 原始消息的兜底检索。
 *
 * 忆泡是「整理过的一天」，但它有产出延迟（小时级）；超过最近对话窗口、又还没进忆泡的
 * 那一段就会变成真空。原文一直存在库里（保留期内），所以回忆时按「忆泡 → 原文」两级回退：
 * 先看那天有没有整理好的事件，没有就按同样的时间区间直接找原始对话。
 *
 * 注意：原文是**未整理的证据**，可能混着玩笑、重复和别人的话。提示词里必须和忆泡分开，
 * 并且规定「冲突时以整理过的事件为准」。
 */

import { estimateTokens, extractRetrievalTerms } from "./memory-retrieval";
import { parseEventTimeRange, type EventTimeRange } from "./memory-event-time";

export const RAW_MESSAGE_TOKEN_BUDGET_DEFAULT = 900;
export const RAW_MESSAGE_LIMIT_DEFAULT = 6;

export type RawMessageCandidate = {
  id: string;
  role: string;
  content: string;
  occurredAt: Date;
};

export type RankedRawMessage<T> = T & { relevanceScore: number; tokens: number };

export type SelectedRawMessages<T> = {
  items: RankedRawMessage<T>[];
  range: EventTimeRange | null;
  usedTokens: number;
};

export type RawMessageSelectionOptions = {
  now?: Date;
  timeZone?: string;
  tokenBudget?: number;
  limit?: number;
  /** 已经进过最近对话窗口的消息，别重复塞一遍。 */
  excludeIds?: Set<string>;
};

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function scoreOf(query: string, content: string): number {
  const text = normalize(content);
  let hit = 0;
  for (const term of extractRetrievalTerms(query)) {
    if (term && text.includes(normalize(term))) hit += term.length >= 3 ? 1.5 : 1;
  }
  return Math.round(hit * 100) / 100;
}

/**
 * 在「问句指向的那一天」里挑几句原文。
 *
 * 挑法：先按关键词匹配；匹配不到就按离问句最近的时间补足 —— 那天确实没有相关话时，
 * 至少给她一句当时在场的话，而不是空手说「记不得」。
 */
export function selectRawMessagesForPrompt<T extends RawMessageCandidate>(
  query: string,
  messages: T[],
  options: RawMessageSelectionOptions = {},
): SelectedRawMessages<T> {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? "Asia/Shanghai";
  const limit = options.limit && options.limit > 0 ? options.limit : RAW_MESSAGE_LIMIT_DEFAULT;
  const tokenBudget = options.tokenBudget && options.tokenBudget > 0
    ? options.tokenBudget
    : RAW_MESSAGE_TOKEN_BUDGET_DEFAULT;
  const range = parseEventTimeRange(query, now, timeZone);
  if (!range) return { items: [], range: null, usedTokens: 0 };

  const excluded = options.excludeIds ?? new Set<string>();
  const inRange = messages.filter((message) => {
    if (excluded.has(message.id)) return false;
    if (!message.content.trim()) return false;
    const at = message.occurredAt.getTime();
    return at >= range.start.getTime() && at < range.end.getTime();
  });

  const scored = inRange.map((message) => ({
    ...message,
    relevanceScore: scoreOf(query, message.content),
    tokens: estimateTokens(message.content),
  }));
  const matched = scored
    .filter((message) => message.relevanceScore > 0)
    .sort((left, right) =>
      right.relevanceScore - left.relevanceScore || right.occurredAt.getTime() - left.occurredAt.getTime(),
    );
  const fallback = scored
    .filter((message) => message.relevanceScore === 0)
    .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime());

  const items: Array<RankedRawMessage<T>> = [];
  let usedTokens = 0;
  for (const entry of [...matched, ...fallback]) {
    if (items.length >= limit) break;
    // 和记忆、忆泡同一条规矩：装不下就整条跳过，但第一条永远放行。
    if (tokenBudget > 0 && usedTokens + entry.tokens > tokenBudget && items.length > 0) continue;
    usedTokens += entry.tokens;
    items.push(entry);
  }

  // 输出按时间正序：原文是「那天先后说了什么」，读起来才像时间线。
  items.sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime());
  return { items, range, usedTokens };
}

function positive(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export function resolveRawMessageTokenBudget(modelConfig: unknown): number {
  const record = modelConfig && typeof modelConfig === "object" ? modelConfig as Record<string, unknown> : {};
  return positive(record.rawMessageTokenBudget) || RAW_MESSAGE_TOKEN_BUDGET_DEFAULT;
}

export function resolveRawMessageLimit(modelConfig: unknown): number {
  const record = modelConfig && typeof modelConfig === "object" ? modelConfig as Record<string, unknown> : {};
  return positive(record.rawMessageLimit) || RAW_MESSAGE_LIMIT_DEFAULT;
}
