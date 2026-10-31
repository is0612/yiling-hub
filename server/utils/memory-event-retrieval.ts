/**
 * 忆泡的选择与排序。
 *
 * 和长期记忆不一样：记忆是「她知道的结论」，检索按相关度挑几条就够；
 * 忆泡是「发生过的事」，问「前天我做了什么」时要的是**那一天的清单**，
 * 所以先按时间区间框住，再排序；框不住才退化成关键词。
 */

import { estimateTokens, extractRetrievalTerms } from "./memory-retrieval";
import { parseEventTimeRange, type EventTimeRange } from "./memory-event-time";

export const EVENT_TOKEN_BUDGET_DEFAULT = 800;
export const EVENT_LIMIT_DEFAULT = 8;

export type EventCandidate = {
  id: string;
  title: string;
  detail: string;
  occurredAt: Date;
  timeOfDay?: string | null;
  place?: string | null;
  participants: string[];
  keywords: string[];
};

export type RankedEvent<T> = T & {
  relevanceScore: number;
  tokens: number;
};

export type SelectedEvents<T> = {
  items: RankedEvent<T>[];
  /** 命中的时间区间；null = 没认出日期，走的是关键词。 */
  range: EventTimeRange | null;
  usedTokens: number;
  dropped: number;
};

export type EventSelectionOptions = {
  now?: Date;
  timeZone?: string;
  tokenBudget?: number;
  limit?: number;
};

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

function eventText(event: EventCandidate): string {
  return [
    event.title,
    event.detail,
    event.place ?? "",
    event.timeOfDay ?? "",
    event.keywords.join(" "),
    event.participants.join(" "),
  ].filter(Boolean).join("\n");
}

function scoreByKeywords(query: string, event: EventCandidate): { score: number; tokens: number } {
  const text = normalize(eventText(event));
  const terms = extractRetrievalTerms(query);
  let hit = 0;
  for (const term of terms) {
    if (!term) continue;
    if (text.includes(normalize(term))) hit += term.length >= 3 ? 1.5 : 1;
  }
  return {
    score: Math.round(hit * 100) / 100,
    tokens: estimateTokens(eventText(event)),
  };
}

function applyBudget<T extends EventCandidate>(
  ranked: Array<RankedEvent<T>>,
  tokenBudget: number,
  limit: number,
): { items: Array<RankedEvent<T>>; usedTokens: number; dropped: number } {
  const items: Array<RankedEvent<T>> = [];
  let usedTokens = 0;
  let dropped = 0;
  for (const entry of ranked) {
    if (items.length >= limit) {
      dropped += 1;
      continue;
    }
    // 和记忆预算同一条规矩：装不下就整条跳过，但第一条永远放行。
    if (tokenBudget > 0 && usedTokens + entry.tokens > tokenBudget && items.length > 0) {
      dropped += 1;
      continue;
    }
    usedTokens += entry.tokens;
    items.push(entry);
  }
  return { items, usedTokens, dropped };
}

export function selectEventsForPrompt<T extends EventCandidate>(  query: string,
  events: T[],
  options: EventSelectionOptions = {},
): SelectedEvents<T> {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? "Asia/Shanghai";
  const tokenBudget = options.tokenBudget && options.tokenBudget > 0 ? options.tokenBudget : EVENT_TOKEN_BUDGET_DEFAULT;
  const limit = options.limit && options.limit > 0 ? options.limit : EVENT_LIMIT_DEFAULT;
  const range = parseEventTimeRange(query, now, timeZone);

  let ranked: Array<RankedEvent<T>>;
  if (range) {
    // 「那天」问的是清单：按发生时间正序，关键词只影响同一天内的先后。
    const inRange = events
      .filter((event) => event.occurredAt.getTime() >= range.start.getTime() && event.occurredAt.getTime() < range.end.getTime())
      .map((event) => {
        const { score, tokens } = scoreByKeywords(query, event);
        return { ...event, relevanceScore: score, tokens };
      })
      .sort((left, right) =>
        left.occurredAt.getTime() - right.occurredAt.getTime() || right.relevanceScore - left.relevanceScore,
      );
    const selected = applyBudget(inRange, tokenBudget, limit);
    return { ...selected, range };
  }

  ranked = events
    .map((event) => {
      const { score, tokens } = scoreByKeywords(query, event);
      return { ...event, relevanceScore: score, tokens };
    })
    // 没有日期指向时，只保留真的匹配上的；不匹配的不该为了凑数进来。
    .filter((event) => event.relevanceScore > 0)
    .sort((left, right) =>
      right.relevanceScore - left.relevanceScore || right.occurredAt.getTime() - left.occurredAt.getTime(),
    );
  return { ...applyBudget(ranked, tokenBudget, limit), range: null };
}

function positive(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

/** 忆泡预算单独一份：问「那天发生了什么」时它才是主角，不该和记忆条目抢同一个池子。 */
export function resolveEventTokenBudget(modelConfig: unknown): number {
  const record = modelConfig && typeof modelConfig === "object" ? modelConfig as Record<string, unknown> : {};
  return positive(record.eventTokenBudget) || EVENT_TOKEN_BUDGET_DEFAULT;
}

export function resolveEventItemLimit(modelConfig: unknown): number {
  const record = modelConfig && typeof modelConfig === "object" ? modelConfig as Record<string, unknown> : {};
  return positive(record.eventItemLimit) || EVENT_LIMIT_DEFAULT;
}
