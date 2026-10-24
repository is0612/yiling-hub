import "dotenv/config";
import assert from "node:assert/strict";
import { BILI_WINDOWS, inWindow, dueWindow, shouldRunDuty, remainingQuota, toDayKey } from "../server/utils/channel-adapter/bili/duty-scheduler";
import { buildDutyPrompt } from "../server/utils/channel-adapter/bili/duty-prompt";
import { BILI_DUTY_DEFAULTS, type BiliDutyConfig } from "../server/utils/channel-adapter/bili/configure";

function makeConfig(overrides: Partial<BiliDutyConfig> = {}): BiliDutyConfig {
  return { ...BILI_DUTY_DEFAULTS, ...overrides };
}

function makeDate(day: string, time: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}

async function main() {
  // 1. 谷时窗口定义（与 bili-desk 一致）
  assert.deepEqual(BILI_WINDOWS.noon, { start: "12:00", end: "14:00" });
  assert.deepEqual(BILI_WINDOWS.night, { start: "18:00", end: "09:00" });

  // 2. inWindow：中午窗口 12:00-14:00（左闭右开）
  assert.equal(inWindow("12:00", "noon"), true);
  assert.equal(inWindow("13:59", "noon"), true);
  assert.equal(inWindow("14:00", "noon"), false); // 右开
  assert.equal(inWindow("11:59", "noon"), false);

  // 3. inWindow：夜间窗口跨午夜 18:00-09:00
  assert.equal(inWindow("18:00", "night"), true);
  assert.equal(inWindow("23:59", "night"), true);
  assert.equal(inWindow("00:00", "night"), true);
  assert.equal(inWindow("08:59", "night"), true);
  assert.equal(inWindow("09:00", "night"), false); // 右开
  assert.equal(inWindow("12:00", "night"), false);

  // 4. dueWindow：中午窗口 + 该窗口今天没跑过 → 触发
  const cfg = makeConfig();
  const noon = dueWindow(makeDate("2026-10-25", "12:30"), cfg, { day: "2026-10-25", picked: 0, windowsRun: [] });
  assert.equal(noon, "noon");

  // 5. dueWindow：该窗口今天已跑过 → 不触发
  const done = dueWindow(makeDate("2026-10-25", "13:00"), cfg, { day: "2026-10-25", picked: 0, windowsRun: ["2026-10-25:noon"] });
  assert.equal(done, null);

  // 6. dueWindow：关闭中午窗口 → 不触发（但夜间窗口若开启仍可触发）
  const noNoon = dueWindow(makeDate("2026-10-25", "12:30"), makeConfig({ noon: false }), { day: "2026-10-25", picked: 0, windowsRun: [] });
  assert.equal(noNoon, null);

  // 7. shouldRunDuty：额度用完 → 不触发
  const noQuota = shouldRunDuty(makeDate("2026-10-25", "12:30"), makeConfig({ perDay: 3 }), { day: "2026-10-25", picked: 3, windowsRun: [] }, false);
  assert.equal(noQuota.due, false);
  assert.match(noQuota.reason, /额度已用完/);

  // 8. shouldRunDuty：正在跑 → 不触发
  const running = shouldRunDuty(makeDate("2026-10-25", "12:30"), cfg, { day: "2026-10-25", picked: 0, windowsRun: [] }, true);
  assert.equal(running.due, false);
  assert.match(running.reason, /还没跑完/);

  // 9. shouldRunDuty：窗口内 + 有额度 + 没跑过 + 没在跑 → 触发
  const go = shouldRunDuty(makeDate("2026-10-25", "12:30"), cfg, { day: "2026-10-25", picked: 0, windowsRun: [] }, false);
  assert.equal(go.due, true);
  assert.equal(go.window, "noon");

  // 10. remainingQuota / toDayKey
  assert.equal(remainingQuota(makeConfig({ perDay: 5 }), { day: "x", picked: 2, windowsRun: [] }), 3);
  assert.equal(toDayKey(new Date(2026, 9, 25)), "2026-10-25");

  // 11. 值班章程提示词：包含步骤、规矩、设置
  const prompt = buildDutyPrompt(makeConfig({ keywords: ["DeepSeek"], dmMode: "only" }), {
    today: "2026-10-25",
    remaining: 5,
    perDay: 5,
    keywords: ["DeepSeek"],
    zone: "all",
    frames: 0,
    dmMode: "only",
    autoComment: false,
    commentPerRound: 1,
    mentionName: "",
  });
  assert.match(prompt, /刷B站/);
  assert.match(prompt, /bili feed recommend/);
  assert.match(prompt, /risk_control/);
  assert.match(prompt, /今天还能挑：5 条/);
  assert.match(prompt, /DeepSeek/);

  // 12. 公开评论关闭时提示词要写明"一条都别发"
  const commentOff = buildDutyPrompt(makeConfig({ dmMode: "off" }), {
    today: "2026-10-25", remaining: 5, perDay: 5, keywords: [], zone: "all", frames: 0,
    dmMode: "off", autoComment: false, commentPerRound: 1, mentionName: "",
  });
  assert.match(commentOff, /不发私信，也不发评论/);

  console.log("✅ test-bili-duty 全部通过");
  console.log("   谷时窗口判断（含跨午夜）：通过");
  console.log("   额度 / 去重 / 运行态判断：通过");
  console.log("   值班章程提示词：通过");
}

main().catch((error) => {
  console.error("❌ test-bili-duty 失败：", error);
  process.exit(1);
});
