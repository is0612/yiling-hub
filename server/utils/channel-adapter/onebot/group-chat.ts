/**
 * QQ 群聊的「自然接话」：攒批 → 过闸门 → 由模型决定说不说。
 *
 * 群聊和私聊不是一回事。私聊里对方说一句就该回一句；群里是一群人在聊，
 * 她要么插得进去、要么就该潜水。逐条回复会变成客服，而「群里每句话都回」
 * 正是 2026-10-29 那次 32 秒刷 6 条的直接原因。
 *
 * 这里负责两件**不花 token** 的事：把连发的消息攒成一轮，以及判断这一轮值不值得看。
 * 真正的「说不说」交给模型（它可以直接返回 silent），因为该不该插话是语义问题，
 * 用规则判不准 —— 规则只负责把明显不该看的挡在外面。
 */

import { formatClockMinutes, inQuietHours, readClockMinutes } from "../../proactive-settings";
import { usageDayKey } from "../../model-usage";

export type GroupChatMode = "mention" | "ambient" | "all";

export type GroupChatSettings = {
  /** mention = 只回 @ 她的；ambient = 判断着接话（默认）；all = 每句都回（老行为）。 */
  mode: GroupChatMode;
  /** 最后一条消息之后安静这么久，算一轮结束。 */
  batchWindowSeconds: number;
  /** 被 @ 时等这么久就处理，不用等整轮聊完 —— 点名叫她还要等十秒，太迟钝。 */
  mentionWindowSeconds: number;
  /** 两条回复之间至少隔多久。 */
  minGapSeconds: number;
  /** 每天最多说几句（按群算，东八区日界）。 */
  dailyMax: number;
  quietStart: string;
  quietEnd: string;
  /** 跟她完全无关的闲聊，被放进去看一眼的概率。 */
  ambientChance: number;
  /** 群里怎么叫她（昵称、简称）。留空就只认 @ 和角色名。 */
  aliases: string[];
};

/**
 * 默认取「自然」档：接得上就说、接不上就潜水。
 * `ambiguous` 的边界留给模型，闸门只拦明显不该开口的情况。
 */
export const GROUP_CHAT_DEFAULTS: GroupChatSettings = {
  mode: "ambient",
  batchWindowSeconds: 12,
  mentionWindowSeconds: 4,
  minGapSeconds: 90,
  dailyMax: 60,
  quietStart: "23:30",
  quietEnd: "07:30",
  ambientChance: 0.15,
  aliases: [],
};

const MODES: readonly GroupChatMode[] = ["mention", "ambient", "all"];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(Math.round(value), max));
}

/** 别名接受数组或「小鱼,大傻鱼 小鲸鱼」这种手填串：两种都常见，没必要让一种报错。 */
function readAliases(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,，、\s]+/)
      : [];
  return [...new Set(
    raw
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length >= 1 && item.length <= 20),
  )].slice(0, 12);
}

function clampRatio(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.round(Math.max(0, Math.min(1, value)) * 100) / 100;
}

/**
 * 从绑定配置里读群聊设置。
 *
 * `legacyMentionOnly` 是连接级的旧开关：绑定没写 `groupChatMode` 时用它兜底，
 * 所以老数据不用迁移也能继续用。**注意旧语义 `replyOnlyWhenMentioned: false`
 * 现在解释成 ambient 而不是「全都回」** —— 「全都回」只有显式选 `all` 才会有。
 */
export function resolveGroupChatSettings(config: unknown, legacyMentionOnly = true): GroupChatSettings {
  const raw = asRecord(config);
  const stored = raw.groupChatMode;
  let mode: GroupChatMode;
  if (typeof stored === "string" && (MODES as readonly string[]).includes(stored)) {
    mode = stored as GroupChatMode;
  } else if (typeof raw.replyOnlyWhenMentioned === "boolean") {
    mode = raw.replyOnlyWhenMentioned ? "mention" : "ambient";
  } else {
    mode = legacyMentionOnly ? "mention" : "ambient";
  }
  const clock = (value: unknown, fallback: string) => {
    const minutes = readClockMinutes(value);
    return minutes === null ? fallback : formatClockMinutes(minutes);
  };
  return {
    mode,
    batchWindowSeconds: clampInt(raw.batchWindowSeconds, GROUP_CHAT_DEFAULTS.batchWindowSeconds, 3, 60),
    mentionWindowSeconds: clampInt(raw.mentionWindowSeconds, GROUP_CHAT_DEFAULTS.mentionWindowSeconds, 1, 30),
    minGapSeconds: clampInt(raw.minGapSeconds, GROUP_CHAT_DEFAULTS.minGapSeconds, 0, 3600),
    dailyMax: clampInt(raw.dailyMax, GROUP_CHAT_DEFAULTS.dailyMax, 0, 1000),
    quietStart: clock(raw.quietStart, GROUP_CHAT_DEFAULTS.quietStart),
    quietEnd: clock(raw.quietEnd, GROUP_CHAT_DEFAULTS.quietEnd),
    ambientChance: clampRatio(raw.ambientChance, GROUP_CHAT_DEFAULTS.ambientChance),
    aliases: readAliases(raw.groupAliases),
  };
}

/** 群聊里她这一次的提示词版本，用于排查「她为什么没说话」。 */
export type GroupChatGateInput = {
  settings: GroupChatSettings;
  now: Date;
  /** 批次里有真实 @ 她（at 段的 QQ 是她）。 */
  direct: boolean;
  /** 正文里出现了她的名字/别名。弱线索：可以看一眼，但不强制回。 */
  named: boolean;
  /** 程序从短期话题参与里找到的候选：有人在接着她参与过的话题说。 */
  topicCandidate: boolean;
  lastSpokeAt: Date | null;
  /** 今天这个群她已说过的句数。 */
  spokenToday: number;
  /** 0-1，由调用方注入，方便测试抽签边界。 */
  random: number;
};

export type GroupChatGateResult = {
  allowed: boolean;
  reason: string;
  /** 放行后是否「不允许主动沉默」：只有真实 @ 与 all 档为 true。 */
  mustReply: boolean;
};

/**
 * 闸门顺序：先判配置性问题（模式），再判时间性问题（安静时段 / 每日上限 / 间隔），
 * 最后才轮到相关性。顺序不能反 —— 反过来会出现「明明已经吵到上限了，还在算该不该接话」。
 *
 * direct（真实 @）是程序事实，不能被模型或名额改写：它可以绕过安静时段，
 * 但仍要受每日上限与最短间隔约束；all 档保持旧的「每条都回」行为。
 */
export function evaluateGroupChatGate(input: GroupChatGateInput): GroupChatGateResult {
  const { settings, now, direct } = input;

  // 「全都回」是用户显式选的，保持老行为，不再叠任何门槛。
  if (settings.mode === "all") return { allowed: true, reason: "all_messages", mustReply: true };
  if (settings.mode === "mention" && !direct && !input.named && !input.topicCandidate) {
    return { allowed: false, reason: "not_cued", mustReply: false };
  }

  if (!direct && inQuietHours(now, settings)) {
    return { allowed: false, reason: "quiet_hours", mustReply: false };
  }
  if (settings.dailyMax > 0 && input.spokenToday >= settings.dailyMax) {
    return { allowed: false, reason: "daily_limit", mustReply: false };
  }
  if (input.lastSpokeAt && settings.minGapSeconds > 0) {
    const gapMs = now.getTime() - input.lastSpokeAt.getTime();
    if (gapMs < settings.minGapSeconds * 1000) {
      return { allowed: false, reason: "too_soon", mustReply: false };
    }
  }
  if (direct) return { allowed: true, reason: "direct", mustReply: true };
  if (input.named) return { allowed: true, reason: "named", mustReply: false };
  if (input.topicCandidate) return { allowed: true, reason: "topic", mustReply: false };
  if (input.random < settings.ambientChance) return { allowed: true, reason: "chance", mustReply: false };
  return { allowed: false, reason: "not_relevant", mustReply: false };
}

/**
 * 攒批窗口：被 @ 或叫到名字用短窗口（有人在找她，别让人等一整轮）；
 * all 档也用短窗口（它要保持「很快回」的手感）；其余走整轮窗口。
 */
export function groupChatWindowMs(settings: GroupChatSettings, urgent: boolean): number {
  if (urgent) return settings.mentionWindowSeconds * 1000;
  if (settings.mode === "all") return Math.min(settings.mentionWindowSeconds, 3) * 1000;
  return settings.batchWindowSeconds * 1000;
}

/** 文字里有没有叫到她的名字。大小写不敏感，去掉空白再比 —— 群里打字很少规范。 */
export function mentionsCharacterName(content: string, names: readonly string[]): boolean {
  if (!content) return false;
  const text = content.toLowerCase().replace(/\s+/g, "");
  for (const name of names) {
    const target = name.toLowerCase().replace(/\s+/g, "");
    if (target && text.includes(target)) return true;
  }
  return false;
}

/** 东八区当天零点，用于按天统计她说过几句。 */
export function groupChatDayStart(now: Date = new Date()): Date {
  return new Date(`${usageDayKey(now)}T00:00:00+08:00`);
}

export type GroupChatBatchItem = { at: number };

/**
 * 按「绑定 + 群」攒消息。
 *
 * 两个时间概念：
 *   - 窗口：最后一条消息之后安静 `windowMs` 才算聊完，期间每来一条就顺延；
 *   - 兜底：从第一条起最多等 `maxWaitMs`，否则一群人一直在聊，她就永远等不到开口的时机。
 *
 * 已经开跑的批次立刻从 Map 里摘掉，新消息进下一批 —— 不能让 flush 期间的等待
 * 把新消息也拖进旧批次，那会让她回一句已经过时的话。
 */
export function createGroupChatBuffer<T extends GroupChatBatchItem>(options: {
  onFlush: (key: string, items: T[]) => void | Promise<void>;
  maxItems?: number;
  maxWaitMs?: number;
  now?: () => number;
}) {
  const maxItems = options.maxItems ?? 30;
  const maxWaitMs = options.maxWaitMs ?? 45_000;
  const now = options.now ?? Date.now;
  const pending = new Map<string, { items: T[]; timer: ReturnType<typeof setTimeout> | null; firstAt: number }>();

  const flush = (key: string) => {
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    if (!entry.items.length) return;
    void Promise.resolve(options.onFlush(key, entry.items)).catch((error) => {
      console.error("[onebot] 群聊批次处理失败：", error instanceof Error ? error.message : String(error));
    });
  };

  return {
    push(key: string, item: T, windowMs: number): void {
      const at = now();
      let entry = pending.get(key);
      if (!entry) {
        entry = { items: [], timer: null, firstAt: at };
        pending.set(key, entry);
      }
      entry.items.push(item);
      if (entry.items.length > maxItems) entry.items.splice(0, entry.items.length - maxItems);
      if (entry.timer) clearTimeout(entry.timer);
      const remaining = Math.max(200, maxWaitMs - (at - entry.firstAt));
      const delay = Math.min(Math.max(200, windowMs), remaining);
      entry.timer = setTimeout(() => flush(key), delay);
      entry.timer.unref?.();
    },
    /** 测试与停机用：立刻把某一群或全部待处理批次冲出去。 */
    drain(key?: string): void {
      if (key) {
        flush(key);
        return;
      }
      for (const pendingKey of [...pending.keys()]) flush(pendingKey);
    },
    size(key: string): number {
      return pending.get(key)?.items.length ?? 0;
    },
  };
}
