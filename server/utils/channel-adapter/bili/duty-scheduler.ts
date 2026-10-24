/**
 * B站值班的谷时窗口调度逻辑 —— 从 bili-desk 的 agent.py scheduler_loop 迁移而来。
 *
 * 与 bili-desk 的关键差异：这里只做**纯逻辑判断**（现在是不是谷时窗口、今天刷过没、
 * 还有没有额度），不做进程内死循环。真正的"何时触发"由调用方（长驻脚本或
 * MemoryJob 队列）决定，满足 CLAUDE.md 第 8 条的持久化/幂等要求。
 */

import type { BiliDutyConfig } from "./configure";

export type BiliWindowKey = "noon" | "night";

/** 谷时窗口定义（与 bili-desk 一致）。 */
export const BILI_WINDOWS: Record<BiliWindowKey, { start: string; end: string }> = {
  noon: { start: "12:00", end: "14:00" },
  night: { start: "18:00", end: "09:00" },
};

export type BiliDutyState = {
  day: string;
  /** 今天已挑条数。 */
  picked: number;
  /** 今天已跑的窗口标记，如 "2026-10-25:noon"。 */
  windowsRun: string[];
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function toDayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 判断某个时刻是否落在某个谷时窗口内（支持跨午夜，如夜间 18:00-09:00）。 */
export function inWindow(time: string, window: BiliWindowKey): boolean {
  const { start, end } = BILI_WINDOWS[window];
  if (start < end) {
    return start <= time && time < end;
  }
  // 跨午夜窗口（night：18:00-09:00）
  return time >= start || time < end;
}

/** 计算此刻应触发哪个窗口（若在窗口内且今天该窗口还没跑过）。 */
export function dueWindow(now: Date, config: BiliDutyConfig, state: BiliDutyState): BiliWindowKey | null {
  if (!config.peakValley) return null;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  for (const key of ["noon", "night"] as const) {
    if (!config[key]) continue;
    if (!inWindow(time, key)) continue;
    const mark = `${state.day}:${key}`;
    if (state.windowsRun.includes(mark)) continue;
    return key;
  }
  return null;
}

/** 今天是否还有额度可以刷。 */
export function hasQuota(config: BiliDutyConfig, state: BiliDutyState): boolean {
  return state.picked < config.perDay;
}

/**
 * 综合判断：此刻是否应该刷一轮。
 * 需要满足：谷时窗口内 + 今天该窗口没跑过 + 还有额度 + 没在跑。
 */
export function shouldRunDuty(
  now: Date,
  config: BiliDutyConfig,
  state: BiliDutyState,
  running: boolean,
): { due: boolean; window: BiliWindowKey | null; reason: string } {
  if (running) return { due: false, window: null, reason: "上一轮还没跑完" };
  if (!config.peakValley) return { due: false, window: null, reason: "已关闭谷时调度" };
  if (!hasQuota(config, state)) {
    return { due: false, window: null, reason: `今天额度已用完（${state.picked}/${config.perDay}）` };
  }
  const window = dueWindow(now, config, state);
  if (!window) {
    return { due: false, window: null, reason: "当前不在谷时窗口内，或该窗口今天已跑过" };
  }
  return { due: true, window, reason: `谷时窗口 ${window} 触发` };
}

/** 剩余额度。 */
export function remainingQuota(config: BiliDutyConfig, state: BiliDutyState): number {
  return Math.max(0, config.perDay - state.picked);
}
