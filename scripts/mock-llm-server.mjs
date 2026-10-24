import http from "node:http";

const host = "127.0.0.1";
const portInput = Number(process.env.LLM_MOCK_PORT ?? 4010);
const port = Number.isInteger(portInput) && portInput >= 1024 && portInput <= 65535 ? portInput : 4010;
const expectedApiKey = process.env.LLM_MOCK_API_KEY ?? "ci-only";

if (process.env.NODE_ENV === "production") {
  throw new Error("The CI mock LLM server must never run in production.");
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > 1_000_000) throw new Error("Request body exceeds mock server limit.");
  }
  return JSON.parse(body);
}

function chatCompletion(body, content) {
  return {
    id: "chatcmpl-ci-test",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: typeof body.model === "string" ? body.model : "ci-memory-test",
    choices: [{
      index: 0,
      message: { role: "assistant", content: JSON.stringify(content) },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 120, completion_tokens: 180, total_tokens: 300 },
  };
}

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    sendJson(response, 200, { ok: true, service: "ci-mock-llm" });
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    sendJson(response, 404, { error: { message: "Not found" } });
    return;
  }
  if (request.headers.authorization !== "Bearer " + expectedApiKey) {
    sendJson(response, 401, { error: { message: "Invalid CI test key" } });
    return;
  }

  try {
    const body = await readJson(request);
    const systemMessage = Array.isArray(body.messages)
      ? body.messages.find((message) => message && message.role === "system" && typeof message.content === "string")
      : undefined;
    const userMessage = Array.isArray(body.messages)
      ? body.messages.find((message) => message && message.role === "user" && typeof message.content === "string")
      : undefined;
    if (!userMessage) {
      sendJson(response, 400, { error: { message: "Missing structured input" } });
      return;
    }

    const input = JSON.parse(userMessage.content);
    if (typeof systemMessage?.content === "string" && systemMessage.content.includes("YILING_CONVERSATION_REPLY_V1")) {
      const forbiddenPromptKeys = ["apiKey", "apiBaseUrl", "model", "temperature", "maxTokens"];
      const leakedSetting = forbiddenPromptKeys.find((key) => Object.prototype.hasOwnProperty.call(input, key));
      if (leakedSetting) {
        sendJson(response, 400, { error: { message: "Chat prompt must not contain provider connection settings." } });
        return;
      }
      const memories = Array.isArray(input.memories) ? input.memories : [];
      const snapshots = Array.isArray(input.snapshots) ? input.snapshots : [];
      const firstMemory = memories[0] && typeof memories[0].id === "string" ? memories[0].id : null;
      const firstSnapshot = snapshots[0] && typeof snapshots[0].id === "string" ? snapshots[0].id : null;
      sendJson(response, 200, chatCompletion(body, {
        reply: "CI 模拟模型回复：" + String(input.currentMessage ?? "").slice(0, 150),
        usedMemoryIds: firstMemory ? [firstMemory] : [],
        usedSnapshotIds: firstSnapshot ? [firstSnapshot] : [],
      }));
      return;
    }

    const sourceMessages = Array.isArray(input.messages) ? input.messages : [];
    const source = sourceMessages.find((message) => message && message.role === "USER" && typeof message.id === "string")
      || sourceMessages.find((message) => message && typeof message.id === "string");
    const evidenceMessageIds = source ? [source.id] : [];
    const memoryContent = source ? "CI AI 提炼记忆：" + String(source.content ?? "").slice(0, 500) : "";
    const analysis = {
      summary: "CI 模拟模型已分析当前周期的 " + sourceMessages.length + " 条抽样对话。",
      importantEvents: source ? [{
        title: "周期对话来源验证",
        detail: "CI 模拟模型依据真实消息 ID 生成结构化分析。",
        evidenceMessageIds,
      }] : [],
      factAndPreferenceChanges: source ? [{
        description: "CI 模拟模型产出的记忆必须保留原始消息证据。",
        changeType: "新增",
        evidenceMessageIds,
      }] : [],
      relationshipChanges: [],
      goalsAndCommitments: [],
      unresolvedTopics: [],
      differencesFromPrevious: ["CI 本地模拟模型已完成一次周期提炼。"],
      memoryChanges: source ? [{
        action: "ADD",
        category: "PREFERENCE",
        content: memoryContent,
        confidence: 0.99,
        evidenceMessageIds,
      }] : [],
    };
    sendJson(response, 200, chatCompletion(body, analysis));
  } catch (error) {
    sendJson(response, 400, { error: { message: error instanceof Error ? error.message : "Invalid request" } });
  }
});

server.listen(port, host, () => {
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), event: "mock-llm-ready", host, port }) + "\n");
});
function shutdown() { server.close(() => process.exit(0)); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
