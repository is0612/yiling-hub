import "dotenv/config";
import assert from "node:assert/strict";
import {
  extractBvids,
  formatWatchedForModel,
  isFatalBiliError,
  parseJsonLoose,
  parseVerdict,
  parseVideoCards,
  parseWatchedVideo,
  readAuthor,
  readBiliError,
} from "../server/utils/channel-adapter/bili/cards";

/** 一条 feed 卡片的真实结构（author 是对象，不是字符串）。 */
function feedCard(overrides: Record<string, unknown> = {}) {
  return {
    bvid: "BV1xx411c7mD",
    title: "标题",
    author: { mid: 12345, name: "某个UP" },
    duration: 754,
    pubdate: "2026-10-26T12:00:00+08:00",
    stat: { view: 12000, like: 300, danmaku: 45, reply: 20 },
    reason: "你常看这个分区",
    url: "https://www.bilibili.com/video/BV1xx411c7mD",
    ...overrides,
  };
}

async function main() {
  // ---- 1. readAuthor：这次 bug 的核心 ----
  // 老实现 `typeof author === "string"` 遇上对象就返回 ""，于是「UP：」后面永远是空的
  assert.deepEqual(readAuthor({ mid: 12345, name: "某个UP" }), { mid: "12345", name: "某个UP" });
  assert.deepEqual(readAuthor("纯字符串UP"), { mid: "", name: "纯字符串UP" });
  assert.deepEqual(readAuthor({ uname: "别名UP" }), { mid: "", name: "别名UP" });
  assert.deepEqual(readAuthor({ up_name: "下划线UP" }), { mid: "", name: "下划线UP" });
  assert.deepEqual(readAuthor({ author: { name: "嵌套UP" } }), { mid: "", name: "嵌套UP" });
  assert.deepEqual(readAuthor({ mid: 7, name: "  带空格  " }), { mid: "7", name: "带空格" });
  assert.deepEqual(readAuthor(null), { mid: "", name: "" });
  assert.deepEqual(readAuthor(undefined), { mid: "", name: "" });
  assert.deepEqual(readAuthor(42), { mid: "", name: "" });

  // ---- 2. parseVideoCards：feed / search / 裸数组 ----
  const feed = parseVideoCards({ page: 1, personalized: true, items: [feedCard()] });
  assert.equal(feed.length, 1);
  assert.equal(feed[0]!.author.name, "某个UP", "feed 卡片的 UP 名不能再丢");
  assert.equal(feed[0]!.author.mid, "12345");
  assert.equal(feed[0]!.stat.view, 12000);
  assert.equal(feed[0]!.reason, "你常看这个分区");

  // 搜索结果把 play / favorites 平铺在顶层，没有 stat 对象
  const search = parseVideoCards({
    keyword: "x",
    items: [{ bvid: "BV1yy411c7mD", title: "搜索结果", author: { mid: 9, name: "搜索UP" }, play: 888, favorites: 12, duration: "05:00" }],
  });
  assert.equal(search.length, 1);
  assert.equal(search[0]!.author.name, "搜索UP");
  assert.equal(search[0]!.stat.view, 888);
  assert.equal(search[0]!.stat.favorite, 12);
  assert.equal(search[0]!.duration, 300);

  // 裸数组 / list 字段
  assert.equal(parseVideoCards([feedCard()]).length, 1);
  assert.equal(parseVideoCards({ list: [feedCard()] }).length, 1);
  // 没有 bvid 的项丢掉，不要造出空卡片
  assert.equal(parseVideoCards({ items: [{ title: "无 BV" }, feedCard()] }).length, 1);
  // 空输入不炸
  assert.deepEqual(parseVideoCards(null), []);
  assert.deepEqual(parseVideoCards({}), []);

  // ---- 3. parseWatchedVideo：watch 用 owner 而不是 author ----
  const watched = parseWatchedVideo({
    bvid: "BV1zz411c7mD",
    title: "看懂的视频",
    desc: "简介正文",
    owner: { mid: 555, name: "watch的UP" },
    duration: 600,
    stat: { view: 1, like: 2, danmaku: 3, reply: 4 },
    tags: ["标签A", "标签B"],
    chapters: [{ from: 0, to: 60, title: "开场" }],
    ai_summary: "官方总结",
    transcript: { source: "subtitle:zh-CN", text: "字幕全文" },
    hot_comments: [{ user: "热评用户", content: "热评内容", like: 9 }],
    danmaku: { total: 10, peaks: [{ time: 3, time_str: "00:03", count: 5, top: ["弹幕A"] }] },
    frames_sheet: "/tmp/sheet.jpg",
  });
  assert.ok(watched);
  assert.equal(watched!.author.name, "watch的UP", "watch 的 owner.name 要认");
  assert.equal(watched!.aiSummary, "官方总结");
  assert.equal(watched!.transcriptText, "字幕全文");
  assert.equal(watched!.tags.length, 2);
  assert.equal(watched!.hotComments[0]!.user, "热评用户");
  assert.equal(watched!.danmakuPeaks[0]!.timeStr, "00:03");
  assert.equal(parseWatchedVideo({ title: "没有 bvid" }), null);

  // 给模型看的材料要带上 UP 名
  const material = formatWatchedForModel(watched!);
  assert.match(material, /UP：watch的UP/);
  assert.match(material, /字幕全文/);
  assert.match(material, /热评用户/);

  // ---- 4. parseVerdict：否定必须先判 ----
  // 老实现 reply.includes("值得") 会把「不值得」判成挑中
  assert.equal(parseVerdict("值得").worth, true);
  assert.equal(parseVerdict("不值得").worth, false, "「不值得」不能判成值得");
  assert.equal(parseVerdict("不值得，标题党").worth, false);
  assert.equal(parseVerdict("跳过。理由：标题党，不值得看").worth, false);
  assert.equal(parseVerdict("判断：跳过\n理由：内容很空").worth, false);
  assert.equal(parseVerdict("判断：值得\n理由：有实测数据").worth, true);
  assert.equal(parseVerdict("判断：值得\n理由：这不太值得错过").worth, true, "先出现「值得」就算值得");
  assert.equal(parseVerdict("").worth, false);
  assert.equal(parseVerdict("随便说说").worth, false, "判不出来就保守跳过");

  // ---- 5. parseJsonLoose / extractBvids ----
  assert.deepEqual(parseJsonLoose('```json\n["BV1xx411c7mD"]\n```'), ["BV1xx411c7mD"]);
  assert.deepEqual(parseJsonLoose('我挑了两条：["BV1xx411c7mD","BV1yy411c7mD"] 就这些'), ["BV1xx411c7mD", "BV1yy411c7mD"]);
  assert.deepEqual(parseJsonLoose('{"worth":true}'), { worth: true });
  assert.equal(parseJsonLoose("没有 JSON"), null);
  assert.equal(parseJsonLoose(""), null);
  assert.deepEqual(extractBvids("看 BV1xx411c7mD 和 BV1yy411c7mD，还有 BV1xx411c7mD"), ["BV1xx411c7mD", "BV1yy411c7mD"]);

  // ---- 6. 错误结构 ----
  const authError = readBiliError({ ok: false, error: { code: "auth_expired", message: "登录凭证已失效。" } });
  assert.equal(authError?.code, "auth_expired");
  assert.equal(readBiliError({ ok: true, data: {} }), null);
  assert.equal(isFatalBiliError("risk_control"), true);
  assert.equal(isFatalBiliError("captcha_required"), true);
  assert.equal(isFatalBiliError("auth_expired"), true);
  assert.equal(isFatalBiliError("rate_limited"), false);
  assert.equal(isFatalBiliError("invalid_argument"), false);

  console.log("✅ test-bili-cards 全部通过");
  console.log("   author 四种形态（对象/字符串/别名/嵌套）：通过");
  console.log("   列表卡片解析（feed / search / 裸数组）：通过");
  console.log("   watch 解析（owner.name / 字幕 / 热评）：通过");
  console.log("   判词否定优先（「不值得」不再判成值得）：通过");
  console.log("   宽松 JSON / BV 提取 / 错误码：通过");
}

main().catch((error) => {
  console.error("❌ test-bili-cards 失败：", error);
  process.exit(1);
});
