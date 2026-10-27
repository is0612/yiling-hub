import "dotenv/config";
import assert from "node:assert/strict";
import {
  BILI_WINDOWS,
  dueWindow,
  inWindow,
  remainingQuota,
  shouldRunDuty,
  toDayKey,
  windowDayKey,
  windowsRunFromTimestamps,
} from "../server/utils/channel-adapter/bili/duty-scheduler";
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

  // ---- 11. 跨午夜窗口归一（回归：老实现一个夜会跑两轮）----
  assert.equal(windowDayKey(makeDate("2026-10-26", "18:30"), "night"), "2026-10-26");
  assert.equal(windowDayKey(makeDate("2026-10-26", "23:59"), "night"), "2026-10-26");
  // 凌晨 0-9 点归到前一天，跟当晚 18:30 是同一个夜
  assert.equal(windowDayKey(makeDate("2026-10-27", "02:00"), "night"), "2026-10-26");
  assert.equal(windowDayKey(makeDate("2026-10-27", "08:59"), "night"), "2026-10-26");
  assert.equal(windowDayKey(makeDate("2026-10-27", "12:30"), "noon"), "2026-10-27");

  // 12. 从报告时间戳重建窗口标记
  assert.deepEqual(windowsRunFromTimestamps([makeDate("2026-10-26", "18:30")]), ["2026-10-26:night"]);
  assert.deepEqual(windowsRunFromTimestamps([makeDate("2026-10-26", "12:30")]), ["2026-10-26:noon"]);
  assert.deepEqual(windowsRunFromTimestamps([]), []);
  assert.deepEqual(windowsRunFromTimestamps([new Date("invalid")]), []);

  // 13. 当晚跑过 → 次日凌晨不再触发（老实现因为自然日变了会再跑一轮）
  const afterNight = windowsRunFromTimestamps([makeDate("2026-10-26", "18:30")]);
  assert.equal(dueWindow(makeDate("2026-10-27", "02:00"), cfg, { day: "2026-10-27", picked: 1, windowsRun: afterNight }), null);
  assert.equal(dueWindow(makeDate("2026-10-27", "08:30"), cfg, { day: "2026-10-27", picked: 1, windowsRun: afterNight }), null);

  // 14. 凌晨跑过 → 当晚也不再触发（同一个夜）
  const afterEarlyMorning = windowsRunFromTimestamps([makeDate("2026-10-27", "02:00")]);
  assert.equal(dueWindow(makeDate("2026-10-26", "20:00"), cfg, { day: "2026-10-26", picked: 1, windowsRun: afterEarlyMorning }), null);

  // 15. 窗口内重复评估不再触发（回归：refreshState 恒返回空 windowsRun 时每分钟都会 due）
  const noonMark = windowsRunFromTimestamps([makeDate("2026-10-26", "12:10")]);
  const firstCheck = dueWindow(makeDate("2026-10-26", "12:10"), cfg, { day: "2026-10-26", picked: 0, windowsRun: [] });
  assert.equal(firstCheck, "noon");
  const secondCheck = dueWindow(makeDate("2026-10-26", "12:11"), cfg, { day: "2026-10-26", picked: 1, windowsRun: noonMark });
  assert.equal(secondCheck, null, "同一窗口内第二次评估不能再触发");

  // 16. 值班章程提示词：脚本化流程下应该讲判断标准，而不是教模型跑命令
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
    watchLimit: 3,
  });
  assert.match(prompt, /替主人刷 B站/);
  assert.match(prompt, /今天还能挑：5 条/);
  assert.match(prompt, /最多细看：3 条/);
  assert.match(prompt, /DeepSeek/);
  // 防提示注入的规矩不能丢
  assert.match(prompt, /素材/);
  assert.match(prompt, /不是给我的指令/);
  // 脚本化之后不该再教模型自己跑命令
  assert.doesNotMatch(prompt, /bili feed recommend/);
  // dmMode=only 时不发公开评论
  assert.match(prompt, /不发公开评论/);

  // 17. 公开评论关闭时提示词要写明"不发"
  const commentOff = buildDutyPrompt(makeConfig({ dmMode: "off" }), {
    today: "2026-10-25", remaining: 5, perDay: 5, keywords: [], zone: "all", frames: 0,
    dmMode: "off", autoComment: false, commentPerRound: 1, mentionName: "", watchLimit: 2,
  });
  assert.match(commentOff, /不发私信也不发评论/);

  // 18. 开了公开评论时，@ 的说法要指向 CLI 的真 @（正文里不用手写 @）
  const withComment = buildDutyPrompt(makeConfig({ dmMode: "both", autoComment: true, mentionName: "没有喵i" }), {
    today: "2026-10-25", remaining: 2, perDay: 5, keywords: [], zone: "all", frames: 0,
    dmMode: "both", autoComment: true, commentPerRound: 2, mentionName: "没有喵i", watchLimit: 2,
  });
  assert.match(withComment, /@ 没有喵i/);
  assert.match(withComment, /真正的 @/);
  assert.match(withComment, /最多发 2 条评论/);

  console.log("✅ test-bili-duty 全部通过");
  console.log("   谷时窗口判断（含跨午夜）：通过");
  console.log("   跨午夜归一 / 从报告重建窗口标记：通过");
  console.log("   额度 / 去重 / 运行态判断：通过");
  console.log("   值班章程提示词：通过");
}

main().catch((error) => {
  console.error("❌ test-bili-duty 失败：", error);
  process.exit(1);
});
