import assert from "node:assert/strict";
import { buildStoredMessageMetadata } from "../server/utils/channel-adapter/pipeline";

/**
 * 渠道消息落库 metadata 的单元测试。
 *
 * 重点锁 `mentionTargets`：群聊里同时跑着好几个 bot，别人 @ 另一个号说的话
 * 如果没被落库，提炼忆泡时就只能靠猜 —— 于是出现「群友嫌她 AI 味太浓」其实在说别人。
 */

const base = {
  platform: "qq-onebot",
  storedReason: "replied" as const,
  message: { authorOpenId: "556", content: "你好" },
};

assert.equal(
  buildStoredMessageMetadata(base).mentionTargets,
  undefined,
  "没有 @ 段时不能凭空写 mentionTargets。",
);
assert.deepEqual(
  buildStoredMessageMetadata({
    ...base,
    message: { authorOpenId: "556", content: "@别人 你今天怎么没来", mentionTargets: ["other"] },
  }).mentionTargets,
  ["other"],
  "@ 别人的消息要标 other，提炼时才知道这句话不是冲她说的。",
);
assert.deepEqual(
  buildStoredMessageMetadata({
    ...base,
    message: { authorOpenId: "556", content: "@她 在吗", mentionTargets: ["self", "all"] },
  }).mentionTargets,
  ["self", "all"],
  "@ 她 / @全体 要原样保留。",
);
assert.equal(
  buildStoredMessageMetadata({ ...base, storedReason: "mentioned" }).storedReason,
  "mentioned",
  "被闸门挡下的点名轮次要标 mentioned，方便按原因做保留策略。",
);
assert.equal(
  buildStoredMessageMetadata({
    ...base,
    message: { authorOpenId: "222", content: "在吗", speaker: { isOwner: true }, member: "member_1" },
  }).isOwner,
  true,
  "主人发的消息要标 isOwner，群聊提炼才认得出主人。",
);
assert.equal(
  buildStoredMessageMetadata({
    ...base,
    message: { authorOpenId: "556", content: "管理命令仅管理员可用。", member: "member_3" },
  }).systemBroadcast,
  true,
  "别的机器人的命令回执要标 systemBroadcast，后面整批跳过。",
);
assert.equal(
  buildStoredMessageMetadata({
    ...base,
    message: { authorOpenId: "556", content: "今天好热", voices: [{ url: "x" }] },
  }).hasVoice,
  true,
  "语音转写落库要标 hasVoice。",
);

console.log("渠道消息 metadata 测试通过：无 @ / @ 别人 / @ 她与 @全体 / mentioned / 主人 / 系统播报 / 语音。");
