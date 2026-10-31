import assert from "node:assert/strict";
import { buildOnebotReplyMessage } from "../server/utils/channel-adapter/onebot/serve";

// 纯文本：无引用目标时原样返回字符串。
assert.equal(buildOnebotReplyMessage("几点啊就起床"), "几点啊就起床");

// 有引用目标：拼成 reply 段 + text 段，reply 段在前。
const withReply = buildOnebotReplyMessage("这账谁结", "123456");
assert.ok(Array.isArray(withReply), "带引用时应返回段数组。");
assert.equal(withReply[0]!.type, "reply", "第一个段必须是 reply。");
assert.deepEqual(withReply[0]!.data, { id: "123456" }, "reply 段的 id 是 QQ 消息 id。");
assert.equal(withReply[1]!.type, "text");
assert.deepEqual(withReply[1]!.data, { text: "这账谁结" });

// 非法 id（非纯数字）退回纯文本，不发坏段。
assert.equal(buildOnebotReplyMessage("嗯", "ghost-id"), "嗯");
assert.equal(buildOnebotReplyMessage("嗯", ""), "嗯");
assert.equal(buildOnebotReplyMessage("嗯", undefined), "嗯");

/**
 * 引用 + @：QQ 的引用块只是把原文贴出来，被回的人收不到提醒，只有 at 段才亮红点。
 * 顺序固定 reply → at → text，@ 落在正文开头。
 */
const withAt = buildOnebotReplyMessage("这账谁结", "123456", "2243049685");
assert.ok(Array.isArray(withAt));
assert.deepEqual(withAt.map((segment) => segment.type), ["reply", "at", "text"], "顺序必须是 reply → at → text。");
assert.deepEqual(withAt[1]!.data, { qq: "2243049685" }, "at 段的 qq 是被引用那条消息的作者。");

// 号不合法（拿不到作者、或作者是她自己）就当没有 @，引用照发。
const replyOnly = buildOnebotReplyMessage("这账谁结", "123456", null);
assert.deepEqual(replyOnly.map((segment) => segment.type), ["reply", "text"]);
assert.deepEqual(
  buildOnebotReplyMessage("这账谁结", "123456", "not-a-qq").map((segment) => segment.type),
  ["reply", "text"],
  "非数字的 qq 不许变成坏段。",
);

console.log("onebot reply 段构造：全部通过");
