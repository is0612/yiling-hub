/**
 * 模型调用的 token 记账与每日额度。
 *
 * 只统计、不拦截计费：额度是"别把一天的预算烧光"，不是计费系统。
 * 记账失败必须吞掉 —— 回复已经生成成功了，不能因为一行统计写失败就把用户的对话变成 500。
 */

import { getPrisma } from "./prisma";

export type ModelUsageKind = "chat" | "channel" | "snapshot" | "bili-screening" | "bili-judge" | "proactive" | "other";

export type ModelUsageTokens = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
};

export type ModelUsageInput = {
  kind: ModelUsageKind;
  model: string;
  usage?: ModelUsageTokens | null;
  characterId?: string | null;
  userId?: string | null;
  conversationId?: string | null;
  channelBindingId?: string | null;
  /** 只收 JSON 可序列化的平铺值：Prisma 的 Json 字段不接受 unknown。 */
  metadata?: Record<string, string | number | boolean | null> | null;
};

export type DailyQuota = {
  /** 0 表示不限。 */
  limit: number;
  used: number;
  /** null = 不限额度（JSON 里不会把 Infinity 变成 null 误导前端）。 */
  remaining: number | null;
  exceeded: boolean;
};

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * 从 OpenAI 兼容响应的 `usage` 读 token。
 * 缺 `total_tokens` 时用 prompt+completion 补，但两者都没有就返回 null —— 不拿估算值冒充真实用量。
 */
export function readModelUsage(payload: unknown): ModelUsageTokens | null {
  const usage = asRecord(asRecord(payload).usage);
  if (!Object.keys(usage).length) return null;

  const promptTokens = nonNegativeInt(usage.prompt_tokens);
  const completionTokens = nonNegativeInt(usage.completion_tokens);
  const totalTokens = nonNegativeInt(usage.total_tokens) || promptTokens + completionTokens;
  if (totalTokens <= 0) return null;

  const details = asRecord(usage.completion_tokens_details);
  const reasoningTokens = nonNegativeInt(details.reasoning_tokens);

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
  };
}

/**
 * 把各调用点已经解析好的「宽松 usage」（字段都可选）归一化成记账用的结构。
 * 三个调用点（chat-reply / memory-ai / bili llm）各自解析出来都缺字段，统一走这里补零。
 */
export function toUsageTokens(
  input: { promptTokens?: number; completionTokens?: number; totalTokens?: number; reasoningTokens?: number } | null | undefined,
): ModelUsageTokens | null {
  if (!input) return null;
  const promptTokens = nonNegativeInt(input.promptTokens);
  const completionTokens = nonNegativeInt(input.completionTokens);
  const totalTokens = nonNegativeInt(input.totalTokens) || promptTokens + completionTokens;
  if (totalTokens <= 0) return null;
  const reasoningTokens = nonNegativeInt(input.reasoningTokens);
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(reasoningTokens > 0 ? { reasoningTokens } : {}),
  };
}

export async function recordModelUsage(input: ModelUsageInput): Promise<void> {
  const usage = input.usage;
  if (!usage || usage.totalTokens <= 0) return;
  try {
    await getPrisma().modelUsage.create({
      data: {
        kind: input.kind,
        model: input.model.slice(0, 120),
        characterId: input.characterId || null,
        userId: input.userId || null,
        conversationId: input.conversationId || null,
        channelBindingId: input.channelBindingId || null,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        reasoningTokens: usage.reasoningTokens ?? null,
        metadata: input.metadata ?? undefined,
      },
    });
  } catch (error) {
    console.error("[usage] 写入模型用量失败：", error instanceof Error ? error.message : String(error));
  }
}

/**
 * 日界固定东八区：与 B站 值班的 `toDayKey` 用同一套「今天」，
 * 否则同一时刻会出现两个日期，额度与值班额度对不上。
 */
export function usageDayKey(date: Date = new Date()): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function dayStart(day: string): Date {
  return new Date(`${day}T00:00:00+08:00`);
}

export function resolveDailyTokenLimit(modelConfig: unknown): number {
  const raw = asRecord(modelConfig).dailyTokenLimit;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(Math.round(raw), 100_000_000);
}

export type DailyUsageSummary = {
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  calls: number;
  byKind: Record<string, { totalTokens: number; calls: number }>;
};

export async function readDailyUsage(characterId: string, day: string = usageDayKey()): Promise<DailyUsageSummary> {
  const start = dayStart(day);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  const rows = await getPrisma().modelUsage.groupBy({
    by: ["kind"],
    where: { characterId, createdAt: { gte: start, lt: end } },
    _sum: { promptTokens: true, completionTokens: true, totalTokens: true },
    _count: { _all: true },
  });

  const summary: DailyUsageSummary = { totalTokens: 0, promptTokens: 0, completionTokens: 0, calls: 0, byKind: {} };
  for (const row of rows) {
    const total = row._sum.totalTokens ?? 0;
    const calls = row._count._all ?? 0;
    summary.totalTokens += total;
    summary.promptTokens += row._sum.promptTokens ?? 0;
    summary.completionTokens += row._sum.completionTokens ?? 0;
    summary.calls += calls;
    summary.byKind[row.kind] = { totalTokens: total, calls };
  }
  return summary;
}

export async function readDailyQuota(
  characterId: string,
  modelConfig: unknown,
  day: string = usageDayKey(),
): Promise<DailyQuota> {
  const limit = resolveDailyTokenLimit(modelConfig);
  const usage = await readDailyUsage(characterId, day);
  if (!limit) return { limit: 0, used: usage.totalTokens, remaining: null, exceeded: false };
  return {
    limit,
    used: usage.totalTokens,
    remaining: Math.max(0, limit - usage.totalTokens),
    exceeded: usage.totalTokens >= limit,
  };
}
