import assert from "node:assert/strict";
import { generateConversationReply } from "../server/utils/chat-reply";

const originalFetch = globalThis.fetch;
let capturedBody = "";
globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  capturedBody = typeof init?.body === "string" ? init.body : "";
  return new Response(JSON.stringify({
    model: "test-chat-model",
    choices: [{ message: { role: "assistant", content: JSON.stringify({ reply: "我的主人是烟火清凉。", usedMemoryIds: [], usedSnapshotIds: [] }) } }],
  }), { status: 200, headers: { "content-type": "application/json" } });
};

try {
  const result = await generateConversationReply({
    characterName: "小鲸鱼",
    characterPrompt: "你是一条嘴硬心软的鲸鱼。",
    model: "test-chat-model",
    apiKey: "sk-speaker-test",
    apiBaseUrl: "https://speaker-provider.example/v1",
    currentMessage: "你的主人是谁",
    recentMessages: [],
    memories: [],
    snapshots: [],
    speaker: { displayName: "群友", isOwner: false, ownerDisplayName: "烟火清凉" },
  });

  assert.equal(result.promptTemplateVersion, "conversation-retrieval-v4");
  const body = JSON.parse(capturedBody) as { messages: Array<{ role: string; content: string }> };
  const system = body.messages.find((item) => item.role === "system")?.content ?? "";
  const user = body.messages.find((item) => item.role === "user")?.content ?? "";
  assert(system.includes("not your own owner"), "系统提示必须明确角色不是自己的主人。");
  assert(system.includes("ownerDisplayName"), "系统提示必须解释主人名字字段。");
  assert(user.includes("\"isOwner\":false"), "非主人说话时必须标明不是主人。");
  assert(user.includes("烟火清凉"), "主人名字必须进入提示词。");
  assert(!system.includes("546280821") && !user.includes("546280821"), "提示词不能带平台账号 ID。");

  await generateConversationReply({
    characterName: "小鲸鱼",
    characterPrompt: "你是一条嘴硬心软的鲸鱼。",
    model: "test-chat-model",
    apiKey: "sk-speaker-test",
    apiBaseUrl: "https://speaker-provider.example/v1",
    currentMessage: "本宝的主人当然是我自己",
    recentMessages: [],
    memories: [],
    snapshots: [],
    speaker: { displayName: "烟火清凉", isOwner: true, ownerDisplayName: "烟火清凉" },
  });
  const body2 = JSON.parse(capturedBody) as { messages: Array<{ role: string; content: string }> };
  const user2 = body2.messages.find((item) => item.role === "user")?.content ?? "";
  assert(user2.includes("\"isOwner\":true"), "主人说话时必须标明是主人。");

  console.log("对话主人上下文测试通过：主人/群友区分、主人名字注入、平台账号 ID 不进入提示词。");
} finally {
  globalThis.fetch = originalFetch;
}
