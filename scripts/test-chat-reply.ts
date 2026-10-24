import assert from "node:assert/strict";
import { generateConversationReply } from "../server/utils/chat-reply";

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
  assert(systemMessage.content.includes("YILING_CONVERSATION_REPLY_V2"), "The system prompt marker must stay in sync with the prompt template version.");
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
  console.log("Chat reply tests passed: prompt credential isolation, source ID validation, and malformed provider response handling.");
} finally {
  globalThis.fetch = originalFetch;
}
