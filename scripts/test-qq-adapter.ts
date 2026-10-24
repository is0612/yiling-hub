import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { encryptApiKey } from "../server/utils/credential-encryption";
import { loadQqConnections } from "../server/utils/channel-adapter/configure";
import { connectQqGateway, resolveQqConfig } from "../server/utils/channel-adapter/qq";
import { createQqMessageHandler } from "../server/utils/channel-adapter/serve";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL，QQ 渠道测试无法运行。");

process.env.LLM_BASE_URL = "http://127.0.0.1:4010/v1";
process.env.LLM_API_KEY = "ci-only";
process.env.LLM_MODEL = "ci-channel-test";
process.env.QQ_TOKEN_URL = "http://127.0.0.1:4021/app/getAppAccessToken";
process.env.QQ_API_BASE_URL = "http://127.0.0.1:4021";
process.env.QQ_GATEWAY_URL = "ws://127.0.0.1:4020";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnServer(script: string, env: NodeJS.ProcessEnv, readyMarker: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    const onData = (data: Buffer) => {
      out += data.toString("utf8");
      if (out.includes(readyMarker)) {
        cleanup();
        resolve(child);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${script} 未在超时内就绪。输出：${out.slice(0, 500)}`));
    }, 20_000);
    function cleanup() {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
    }
  });
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await sleep(200);
  }
  throw new Error("等待条件超时。");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const suffix = randomUUID();
const characterId = randomUUID();
const connectionId = randomUUID();
let conversationId = "";
let bindingId = "";

const children: ChildProcess[] = [];
try {
  children.push(await spawnServer("scripts/mock-llm-server.mjs", { LLM_MOCK_PORT: "4010", LLM_MOCK_API_KEY: "ci-only" }, "mock-llm-ready"));
  children.push(await spawnServer("scripts/mock-qq-gateway.mjs", { QQ_MOCK_HTTP_PORT: "4021", QQ_MOCK_WS_PORT: "4020" }, "mock-qq-ready"));

  // 1. Seed a character (with a global scope), a QQ connection and a default binding.
  const user = await prisma.user.create({ data: { username: `qq-test-${suffix}`, passwordHash: "x", role: "ADMIN" }, select: { id: true } });
  await prisma.character.create({
    data: {
      id: characterId,
      ownerId: user.id,
      name: "测试角色",
      avatar: "测",
      basePrompt: "你是一个用于渠道联调的测试角色。",
      modelConfig: {},
      status: "ACTIVE",
      memoryScopes: { create: { scopeType: "CHARACTER_GLOBAL", scopeKey: `character:${characterId}:global` } },
    },
  });
  const credentialsCiphertext = Buffer.from(await encryptApiKey(JSON.stringify({ appId: "mock-app", appSecret: "mock-secret" })), "utf8");
  await prisma.platformConnection.create({
    data: {
      id: connectionId,
      platform: "qq",
      platformAccountKey: "mock-app",
      displayName: "测试 QQ",
      status: "DISCONNECTED",
      credentialsCiphertext,
      metadata: {},
    },
  });
  const binding = await prisma.characterChannelBinding.create({
    data: { characterId, connectionId, status: "ACTIVE", routingKey: null },
    select: { id: true },
  });
  bindingId = binding.id;

  // 2. The adapter discovers the connection and decrypts its credentials.
  const records = await loadQqConnections();
  assert.equal(records.length, 1, "The adapter must discover the QQ connection.");
  const record = records[0]!;
  assert.equal(record.appId, "mock-app");
  assert.equal(record.appSecret, "mock-secret");

  const config = resolveQqConfig({ appId: record.appId, appSecret: record.appSecret });
  const handler = createQqMessageHandler(record, config);
  const closeGateway = await connectQqGateway(config, { onMessageEvent: handler });

  // 3. Emit a group @-message event and wait for a reply to be sent back.
  const event = {
    t: "GROUP_AT_MESSAGE_CREATE",
    d: { id: "msg-1", author: { user_openid: "openid-1" }, group_openid: "group-1", content: "你好呀", timestamp: String(Date.now()) },
  };
  await fetch("http://127.0.0.1:4021/__mock/emit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });

  await waitFor(async () => {
    const res = await fetch("http://127.0.0.1:4021/__mock/messages");
    const payload = await res.json() as { messages: unknown[] };
    return payload.messages.length >= 1;
  });

  const sent = (await (await fetch("http://127.0.0.1:4021/__mock/messages")).json()) as { messages: Array<Record<string, unknown>> };
  assert.equal(sent.messages.length, 1, "Exactly one reply must be sent for one event.");
  const sentMessage = sent.messages[0]!;
  assert.equal(sentMessage.path, "/v2/groups/group-1/messages");
  assert.equal((sentMessage.body as Record<string, unknown>).msg_id, "msg-1");
  assert.equal((sentMessage.body as Record<string, unknown>).msg_type, 0);
  assert(String((sentMessage.body as Record<string, unknown>).content).includes("CI 模拟模型回复"), "The reply must come from the mock LLM.");
  assert.equal(sentMessage.authorization, "QQBot mock-access-token");

  // 4. The conversation and both messages are persisted.
  const conversation = await prisma.conversation.findFirst({
    where: { channelBindingId: bindingId, externalConversationId: "g:group-1" },
    select: { id: true },
  });
  assert(conversation, "A channel conversation must be persisted.");
  conversationId = conversation.id;
  const messages = await prisma.message.findMany({ where: { conversationId }, orderBy: { occurredAt: "asc" } });
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.role, "USER");
  assert.equal(messages[0]!.externalMessageId, "msg-1");
  assert.equal(messages[1]!.role, "ASSISTANT");
  assert(String(messages[1]!.content).includes("CI 模拟模型回复"));

  // 5. A re-delivered event with the same message id is deduplicated.
  await fetch("http://127.0.0.1:4021/__mock/emit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ t: event.t, d: { ...event.d, content: "重复消息" } }),
  });
  await sleep(1500);
  const afterDuplicate = (await (await fetch("http://127.0.0.1:4021/__mock/messages")).json()) as { messages: unknown[] };
  assert.equal(afterDuplicate.messages.length, 1, "A duplicate event must not trigger a second reply.");
  const userMessages = await prisma.message.findMany({ where: { conversationId, role: "USER" } });
  assert.equal(userMessages.length, 1, "A duplicate event must not persist a second user message.");

  closeGateway();

  console.log("QQ 渠道端到端测试通过：事件接入、凭据解密、角色绑定路由、记忆检索、模型回复、消息持久化、回发平台与幂等去重。");
} finally {
  for (const child of children) child.kill();
  if (conversationId) await prisma.conversation.deleteMany({ where: { channelBindingId: bindingId } }).catch(() => undefined);
  await prisma.characterChannelBinding.deleteMany({ where: { connectionId } }).catch(() => undefined);
  await prisma.memoryScope.deleteMany({ where: { characterId } }).catch(() => undefined);
  await prisma.character.deleteMany({ where: { id: characterId } }).catch(() => undefined);
  await prisma.platformConnection.deleteMany({ where: { id: connectionId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { username: { startsWith: "qq-test-" } } }).catch(() => undefined);
  await prisma.$disconnect();
}
