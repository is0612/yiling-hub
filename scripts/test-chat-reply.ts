import assert from "node:assert/strict";
import { generateConversationReply, STYLE_EXAMPLES_HEADING } from "../server/utils/chat-reply";

const originalFetch = globalThis.fetch;
const secretApiKey = "sk-test-secret-must-not-appear-in-prompt";
const privateProviderUrl = "https://private-provider.example/v1";
let capturedUrl = "";
let capturedHeaders: Headers | null = null;
let capturedBody = "";

globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  capturedUrl = String(input);
  capturedHeaders = new Headers(init?.headers);
  capturedBody = typeof init?.body === "string" ? init.body : "";
  return new Response(JSON.stringify({
    model: "test-chat-model",
    choices: [{
      message: {
        role: "assistant",
        content: JSON.stringify({
          reply: "我记得你的偏好。",
          usedMemoryIds: ["memory-1", "invented-memory"],
          usedSnapshotIds: ["snapshot-1"],
        }),
      },
    }],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

try {
  const result = await generateConversationReply({
    characterName: "测试角色",
    characterPrompt: "温柔、自然地回复。",
    model: "test-chat-model",
    apiKey: secretApiKey,
    apiBaseUrl: privateProviderUrl,
    temperature: 0.4,
    maxTokens: 512,
    currentMessage: "你还记得我喜欢什么吗？",
    recentMessages: [{ role: "USER", content: "我喜欢星空。", occurredAt: "2026-10-24T10:00:00.000Z" }],
    memories: [{
      id: "memory-1",
      category: "PREFERENCE",
      content: "用户喜欢星空。",
      confidence: 0.95,
      relevanceScore: 4,
      scope: "character",
    }],
    snapshots: [{
      id: "snapshot-1",
      summary: "曾聊到观星。",
      periodStart: "2026-10-01T00:00:00.000Z",
      periodEnd: "2026-10-09T00:00:00.000Z",
      version: 1,
      relevanceScore: 2,
      scope: "character",
    }],
  });

  assert.equal(capturedUrl, privateProviderUrl + "/chat/completions");
  assert.equal(capturedHeaders?.get("authorization"), "Bearer " + secretApiKey);
  assert(capturedBody.length > 0, "The model request body should be captured for assertions.");
  assert(!capturedBody.includes(secretApiKey), "The API key must not appear in the request body.");
  assert(!capturedBody.includes(privateProviderUrl), "The provider URL must not appear in the prompt body.");

  const requestBody = JSON.parse(capturedBody) as {
    model: string;
    messages: Array<{ role: string; content: string }>;
  };
  assert.equal(requestBody.model, "test-chat-model");
  const systemMessage = requestBody.messages.find((item) => item.role === "system");
  assert(systemMessage, "The request must include a system prompt.");
  assert(systemMessage.content.includes("YILING_CONVERSATION_REPLY_V3"), "The system prompt marker must stay in sync with the prompt template version.");
  const userMessage = requestBody.messages.find((item) => item.role === "user");
  assert(userMessage, "The request must include a structured user context.");
  const promptInput = JSON.parse(userMessage.content) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(promptInput).sort(),
    ["characterName", "characterPrompt", "currentMessage", "recentMessages", "memories", "snapshots"].sort(),
    "Only explicit conversation-context fields should be serialized into the prompt.",
  );
  assert.equal(result.reply, "我记得你的偏好。");
  const promptMemories = promptInput.memories as Array<Record<string, unknown>>;
  const promptSnapshots = promptInput.snapshots as Array<Record<string, unknown>>;
  assert.equal(promptMemories[0]?.scope, "character", "Character-global memory keeps its scope label.");
  assert.equal(promptSnapshots[0]?.scope, "character", "Character-global snapshot keeps its scope label.");
  assert(!capturedBody.includes("scopeType"), "Internal scope typing must not leak into the prompt.");
  assert.deepEqual(result.usedMemoryIds, ["memory-1"], "Invented source IDs must be filtered out.");
  assert.deepEqual(result.usedSnapshotIds, ["snapshot-1"]);
  assert.equal(result.usage?.totalTokens, 20);

  // ── 对话示例：只拼进 characterPrompt 尾部，带边界，且不新增顶层字段 ──
  // 为什么不能新增字段/不能做成 few-shot 轮次：这个接口要求返回 JSON 信封，
  // 真给它几轮「用户 / 她」的对话，模型会学着直接吐纯文本，解析就炸。
  assert(!String(promptInput.characterPrompt).includes("对话示例"), "没填示例时不该出现这一节");

  capturedBody = "";
  const withExamples = await generateConversationReply({
    characterName: "鲸鱼娘",
    characterPrompt: "你是「鲸鱼娘」，一只蓝色的大鲸鱼。",
    styleExamples: "用户：今天好累啊\n鲸鱼娘：欸，你怎么又累了？本鱼都还没开始努力呢。",
    model: "test-chat-model",
    apiKey: secretApiKey,
    apiBaseUrl: privateProviderUrl,
    currentMessage: "在吗",
    recentMessages: [],
    memories: [],
    snapshots: [],
  });
  assert.equal(withExamples.reply, "我记得你的偏好。");
  const examplesInput = JSON.parse(
    (JSON.parse(capturedBody) as { messages: Array<{ role: string; content: string }> })
      .messages.find((item) => item.role === "user")!.content,
  ) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(examplesInput).sort(),
    Object.keys(promptInput).sort(),
    "示例必须是 characterPrompt 的一部分，不能另起字段（否则模型输出格式会跑偏）",
  );
  const mergedPrompt = String(examplesInput.characterPrompt);
  assert(mergedPrompt.startsWith("你是「鲸鱼娘」"), "人设要原样排在最前面");
  assert(mergedPrompt.includes(STYLE_EXAMPLES_HEADING), "示例要单独成节");
  assert(mergedPrompt.includes("本鱼都还没开始努力呢"), "示例正文要带进提示词");
  assert.match(mergedPrompt, /别把示例里的内容当成发生过的事/, "要写明只学语气，否则她会把示例当回忆");
  assert.match(mergedPrompt, /仍然只返回规定的 JSON/, "要写死不改变输出格式");

  // ── 称呼：设了才进 promptInput，系统提示词同步解释这个字段 ──
  capturedBody = "";
  await generateConversationReply({
    characterName: "鲸鱼娘",
    characterPrompt: "你是「鲸鱼娘」。",
    userAddress: "主人",
    model: "test-chat-model",
    apiKey: secretApiKey,
    apiBaseUrl: privateProviderUrl,
    currentMessage: "在吗",
    recentMessages: [],
    memories: [],
    snapshots: [],
  });
  const addressedMessages = (JSON.parse(capturedBody) as { messages: Array<{ role: string; content: string }> }).messages;
  const addressedInput = JSON.parse(addressedMessages.find((item) => item.role === "user")!.content) as Record<string, unknown>;
  assert.equal(addressedInput.userAddress, "主人", "称呼要作为独立字段进提示词");
  const addressedSystem = addressedMessages.find((item) => item.role === "system")!.content;
  assert(addressedSystem.includes("userAddress"), "系统提示词要说明这个字段是什么");
  assert.match(addressedSystem, /not in every sentence/, "要写清是偶尔称呼，不是每句都喊");

  capturedBody = "";
  await generateConversationReply({
    characterName: "鲸鱼娘",
    characterPrompt: "你是「鲸鱼娘」。",
    userAddress: "   ",
    model: "test-chat-model",
    apiKey: secretApiKey,
    apiBaseUrl: privateProviderUrl,
    currentMessage: "在吗",
    recentMessages: [],
    memories: [],
    snapshots: [],
  });
  const blankMessages = (JSON.parse(capturedBody) as { messages: Array<{ role: string; content: string }> }).messages;
  const blankInput = JSON.parse(blankMessages.find((item) => item.role === "user")!.content) as Record<string, unknown>;
  assert(!("userAddress" in blankInput), "空白称呼等于没设，不该塞空字段");
  assert(!blankMessages.find((item) => item.role === "system")!.content.includes("userAddress"), "没设称呼就别加这段说明");

  globalThis.fetch = async (): Promise<Response> => new Response("not-json", {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  await assert.rejects(
    generateConversationReply({
      characterName: "测试角色",
      characterPrompt: "温柔地回复。",
      model: "test-chat-model",
      apiKey: secretApiKey,
      apiBaseUrl: privateProviderUrl,
      currentMessage: "再试一次",
      recentMessages: [],
      memories: [],
      snapshots: [],
    }),
    /LLM_INVALID_RESPONSE: 模型服务没有返回有效的 JSON 响应。/,
    "Malformed provider JSON should become a safe, predictable model error.",
  );

  // 模型抽风吐了非 JSON：再要一次就能拿到，不该把整条消息咽掉（QQ 上就是「她没理我」）。
  const replyOnce = (content: string) => JSON.stringify({
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  let calls = 0;
  globalThis.fetch = async (): Promise<Response> => {
    calls += 1;
    const body = calls === 1
      ? "抱歉，我刚刚走神了（这不是 JSON）"
      : replyOnce(JSON.stringify({ reply: "重试后拿到了", usedMemoryIds: [], usedSnapshotIds: [] }));
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };
  const retried = await generateConversationReply({
    characterName: "测试角色",
    characterPrompt: "温柔地回复。",
    model: "test-chat-model",
    apiKey: secretApiKey,
    apiBaseUrl: privateProviderUrl,
    currentMessage: "在吗",
    recentMessages: [],
    memories: [],
    snapshots: [],
  });
  assert.equal(retried.reply, "重试后拿到了", "第一次格式不对，重试后要能正常回。");
  assert.equal(calls, 2, "只多要一次，不能无限重试。");

  // 一直抽风：两次就停手。
  calls = 0;
  globalThis.fetch = async (): Promise<Response> => {
    calls += 1;
    return new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
  };
  await assert.rejects(
    generateConversationReply({
      characterName: "测试角色",
      characterPrompt: "温柔地回复。",
      model: "test-chat-model",
      apiKey: secretApiKey,
      apiBaseUrl: privateProviderUrl,
      currentMessage: "还是不行",
      recentMessages: [],
      memories: [],
      snapshots: [],
    }),
    /LLM_INVALID_RESPONSE/,
  );
  assert.equal(calls, 2, "重试上限是一次。");

  console.log("Chat reply tests passed: prompt credential isolation, source ID validation, malformed provider response handling, and one retry for malformed model output.");
  console.log("对话示例注入：拼进 characterPrompt、带边界、不新增顶层字段 —— 通过");
} finally {
  globalThis.fetch = originalFetch;
}
