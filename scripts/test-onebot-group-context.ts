/**
 * 群聊短期上下文与话题参与的纯逻辑测试：成员代号、背景预算、话题建立/续期/过期。
 * 不连数据库、不调模型。
 */

import assert from "node:assert/strict";
import { createGroupContext, type GroupMessageFacts } from "../server/utils/channel-adapter/onebot/group-context";
import { readOnebotMentionTargets, readOnebotReplyToId } from "../server/utils/channel-adapter/onebot/types";

const SELF = "999";
let now = 1_000_000;
const minutes = (n: number) => n * 60_000;

const ctx = createGroupContext({
  selfQq: SELF,
  now: () => now,
  maxMessages: 5,
  maxChars: 60,
  topicTtlMs: minutes(3),
  topicMaxLifeMs: minutes(15),
  maxTopics: 3,
});

const facts = (patch: Partial<GroupMessageFacts> & { messageId: string; senderQq: string }): GroupMessageFacts => ({
  at: now,
  displayName: `用户${patch.senderQq}`,
  text: "",
  mentionTargets: [],
  replyToMessageId: "",
  ...patch,
});

// ── 1. 成员代号：同 QQ 改名仍是同一人，同名不同 QQ 分开 ─────────
ctx.remember("g:1", facts({ messageId: "m1", senderQq: "111", displayName: "小鱼", text: "在吗" }));
ctx.remember("g:1", facts({ messageId: "m2", senderQq: "222", displayName: "小鱼", text: "我也叫小鱼" }));
ctx.remember("g:1", facts({ messageId: "m3", senderQq: "111", displayName: "改了名", text: "还是我" }));
assert.equal(ctx.memberCode("g:1", "111"), "member_1", "QQ 111 的代号要稳定。");
assert.equal(ctx.memberCode("g:1", "222"), "member_2", "同名不同 QQ 必须是两个成员。");
assert.equal(ctx.memberCode("g:1", "111"), "member_1", "改昵称不改代号。");

// 不同群各自编号，不串。
assert.equal(ctx.memberCode("g:2", "111"), "member_1", "另一个群的代号从 member_1 重新开始。");

// ── 2. 入模正文：@ 她自己 / 别人 / 全体 ────────────────────────
assert.equal(ctx.formatText("g:1", `@${SELF} 你好`), "@self 你好");
assert.equal(ctx.formatText("g:1", "@111 你好"), "@member_1 你好");
assert.equal(ctx.formatText("g:1", "@222 你好"), "@member_2 你好");
assert.equal(ctx.formatText("g:1", "@all 开会了"), "@all 开会了", "@全体不是她本人。");
assert.equal(ctx.formatText("g:1", "[CQ:at,qq=999] 你好"), "@self 你好", "字符串消息里的 CQ 码也要代号化。");
assert.equal(ctx.formatText("g:1", "没有 at 的正文"), "没有 at 的正文");

// ── 3. 背景：排除本轮、按时间正序、受预算限制 ──────────────────
const background = ctx.background("g:1", ["m3"]);
assert.deepEqual(background.map((line) => line.id), ["m1", "m2"], "本轮消息不能再当背景拼一遍。");
assert.equal(background[0]!.member, "member_1");
assert.equal(background[0]!.text, "在吗");

// 条数上限：只留最近 maxMessages 条。
for (let index = 0; index < 8; index += 1) {
  now += 1;
  ctx.remember("g:3", facts({ messageId: `x${index}`, senderQq: "111", text: `第${index}条` }));
}
assert.equal(ctx.background("g:3", []).length, 5, "缓存按 maxMessages 截断。");
assert.equal(ctx.background("g:3", [])[4]!.id, "x7", "留下的是最近的。");

// ── 4. 话题：建立、候选、过期 ─────────────────────────────────
const topicKey = "g:9";
assert.equal(ctx.topicCandidate(topicKey, []), false, "没有任何话题时不是候选。");

now += 10_000;
const ask = facts({ messageId: "a1", senderQq: "111", text: `@${SELF} 晚饭吃什么`, mentionTargets: ["self"] });
ctx.recordReply(topicKey, [ask], { source: "mention" });
assert.equal(ctx.activeTopicCount(topicKey), 1);
assert.equal(ctx.topicCandidate(topicKey, [facts({ messageId: "a2", senderQq: "111" })]), true, "参与者继续说，算话题候选。");
assert.equal(ctx.topicCandidate(topicKey, [facts({ messageId: "a3", senderQq: "333" })]), false, "陌生人说话不算。");
assert.deepEqual(ctx.anchors(topicKey).map((anchor) => anchor.id), ["a1"]);

// 恰好 3 分钟：还活着；超过就失效。
now += minutes(3) - 1;
assert.equal(ctx.topicCandidate(topicKey, [facts({ messageId: "a4", senderQq: "111" })]), true);
now += 2;
assert.equal(ctx.topicCandidate(topicKey, [facts({ messageId: "a5", senderQq: "111" })]), false, "3 分钟无互动就过期。");

// ── 5. 沉默续期：只认已有锚点 + followup/shared_topic，且受绝对上限 ──
const refreshKey = "g:10";
now += 1_000;
const startedAt = now;
ctx.recordReply(refreshKey, [facts({ messageId: "b1", senderQq: "111", text: "聊游戏" })], { source: "ambient" });
assert.equal(
  ctx.refreshFromDecision(refreshKey, { relation: "unrelated", evidenceMessageIds: [] }),
  false,
  "无关判断不能续期。",
);
assert.equal(
  ctx.refreshFromDecision(refreshKey, { relation: "followup", topicAnchorMessageId: "b1", evidenceMessageIds: ["b2"] }),
  true,
);
// 靠合法的 followup 一直续，但绝对上限 15 分钟一到就必须失效。
for (let step = 0; step < 7; step += 1) {
  now += minutes(2) - 1;
  ctx.refreshFromDecision(refreshKey, { relation: "followup", topicAnchorMessageId: "b1", evidenceMessageIds: [] });
}
now = startedAt + minutes(15) + 1;
assert.equal(ctx.activeTopicCount(refreshKey), 0, "话题最长活 15 分钟，不能被无限续命。");

// ── 6. 并行话题与淘汰：最多 3 个，丢最久没互动的 ───────────────
const multiKey = "g:11";
now += minutes(20);
for (const [index, qq] of ["111", "222", "333", "444"].entries()) {
  now += 1_000;
  ctx.recordReply(multiKey, [facts({ messageId: `t${index}`, senderQq: qq })], { source: "ambient" });
}
assert.equal(ctx.activeTopicCount(multiKey), 3, "话题数有上限。");
const remainingAnchors = ctx.anchors(multiKey).map((anchor) => anchor.id);
assert(remainingAnchors.includes("t3"), "最新的那条一定还在。");
assert(!remainingAnchors.includes("t0"), "最久没互动的被淘汰。");

// ── 7. 解析：@ 指向与引用 ─────────────────────────────────────
assert.deepEqual(
  readOnebotMentionTargets({ message: [
    { type: "at", data: { qq: 999 } },
    { type: "at", data: { qq: 111 } },
    { type: "at", data: { qq: "all" } },
  ] }, SELF),
  ["self", "other", "all"],
);
assert.deepEqual(
  readOnebotMentionTargets({ message: "[CQ:at,qq=999] 你好" }, SELF),
  ["self"],
  "字符串消息也要认 CQ 码。",
);
assert.deepEqual(readOnebotMentionTargets({ message: "[CQ:at,qq=111] 你好" }, ""), ["other"], "没有 selfId 时不要猜 self。");
assert.equal(
  readOnebotReplyToId({ message: [{ type: "reply", data: { id: 42 } }, { type: "text", data: { text: "嗯" } }] }),
  "42",
);
assert.equal(readOnebotReplyToId({ message: [{ type: "text", data: { text: "嗯" } }] }), "", "没有引用就是空串。");

console.log("群聊上下文测试通过：成员代号、@ 代号化、背景预算、话题建立/候选/过期/续期上限、并行话题淘汰、@ 与引用解析。");
