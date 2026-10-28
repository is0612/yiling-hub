import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { encryptApiKey } from "../server/utils/credential-encryption";
import { loadOnebotConnections } from "../server/utils/channel-adapter/onebot/configure";
import { createOnebotMessageHandler } from "../server/utils/channel-adapter/onebot/serve";
import { connectOnebot, resolveOnebotEvent } from "../server/utils/channel-adapter/onebot/client";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("缺少 DATABASE_URL，OneBot 渠道测试无法运行。");

process.env.LLM_BASE_URL = "http://127.0.0.1:4010/v1";
process.env.LLM_API_KEY = "ci-only";
process.env.LLM_MODEL = "ci-channel-test";
process.env.ONEBOT_WS_URL = "ws://127.0.0.1:4030";
process.env.ONEBOT_HTTP_URL = "http://127.0.0.1:4031";

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
  children.push(await spawnServer("scripts/mock-onebot-gateway.mjs", { ONEBOT_MOCK_HTTP_PORT: "4031", ONEBOT_MOCK_WS_PORT: "4030", ONEBOT_MOCK_REQUIRE_TOKEN: "mock-ws-token" }, "mock-onebot-ready"));

  // 1. Seed a character (with a global scope) and an OneBot connection + default binding.
  const user = await prisma.user.create({ data: { username: `onebot-test-${suffix}`, passwordHash: "x", role: "ADMIN" }, select: { id: true } });
  await prisma.character.create({
    data: {
      id: characterId,
      ownerId: user.id,
      name: "测试角色",
      avatar: "测",
      basePrompt: "你是一个用于 OneBot 渠道联调的测试角色。",
      modelConfig: {},
      status: "ACTIVE",
      memoryScopes: { create: { scopeType: "CHARACTER_GLOBAL", scopeKey: `character:${characterId}:global` } },
    },
  });
  const credentialsCiphertext = Buffer.from(await encryptApiKey(JSON.stringify({
    wsUrl: "ws://127.0.0.1:4030",
    httpUrl: "http://127.0.0.1:4031",
    accessToken: "mock-ws-token",
    httpToken: "mock-http-token",
  })), "utf8");
  await prisma.platformConnection.create({
    data: {
      id: connectionId,
      platform: "qq-onebot",
      platformAccountKey: "123456789",
      displayName: "测试 QQ 小号",
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
  // 只按本用例自己建的 id 找：库里可能还躺着真实连接（本地联调用的那个），断言总数会被它带偏。
  const records = await loadOnebotConnections();
  const record = records.find((item) => item.id === connectionId);
  assert(record, "The adapter must discover the OneBot connection.");
  assert.equal(record.config.wsUrl, "ws://127.0.0.1:4030");
  assert.equal(record.config.httpUrl, "http://127.0.0.1:4031");
  assert.equal(record.config.accessToken, "mock-ws-token");
  assert.equal(record.config.httpToken, "mock-http-token");
  assert.equal(record.replyOnlyWhenMentioned, false);

  // 3. Unit-check the segment flattening + event resolution before the live round-trip.
  const resolved = resolveOnebotEvent({
    post_type: "message",
    message_type: "group",
    self_id: 123456789,
    message_id: 42,
    user_id: 111,
    group_id: 999,
    sender: { user_id: 111, nickname: "小明", card: "小明(群)" },
    message: [
      { type: "text", data: { text: "你好" } },
      { type: "at", data: { qq: 123456789 } },
      { type: "image", data: { url: "http://x/y.png" } },
    ],
  });
  assert(resolved, "A group message must resolve.");
  assert.equal(resolved.conversationKey, "g:999");
  assert.equal(resolved.content, "你好@123456789[图片]");
  assert.equal(resolved.displayName, "小明(群)");

  const handler = createOnebotMessageHandler(record);
  const closeGateway = await connectOnebot(record.config, { onMessage: handler });

  // 3b. WS 鉴权与握手次数：token 只能挂查询参数（Node 内置 WebSocket 加不了自定义头），
  // 且一次连接只该有一次握手 —— 反复重连会在这条断言上炸。
  const readHandshakes = async () => ((await (await fetch("http://127.0.0.1:4031/__mock/handshakes")).json()) as {
    handshakes: Array<{ url: string; query: Record<string, string>; authorization: string | null; authorized: boolean }>;
  }).handshakes;
  const firstHandshakes = await readHandshakes();
  assert.equal(firstHandshakes.length, 1, "连上一次就够，不能反复握手。");
  assert.equal(firstHandshakes[0]!.authorized, true, "握手必须带上 WS token。");
  assert.equal(
    firstHandshakes[0]!.query.access_token,
    "mock-ws-token",
    "token 必须拼成 ?access_token= 查询参数。",
  );

  // 4. Emit a group message event and wait for a reply.
  await fetch("http://127.0.0.1:4031/__mock/emit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event: {
        post_type: "message",
        message_type: "group",
        self_id: 123456789,
        message_id: 1,
        user_id: 111,
        group_id: 999,
        sender: { user_id: 111, nickname: "小明" },
        message: [{ type: "text", data: { text: "你好呀" } }],
      },
    }),
  });

  await waitFor(async () => {
    const res = await fetch("http://127.0.0.1:4031/__mock/messages");
    const payload = await res.json() as { messages: unknown[] };
    return payload.messages.length >= 1;
  });

  const sent = (await (await fetch("http://127.0.0.1:4031/__mock/messages")).json()) as { messages: Array<Record<string, unknown>> };
  assert.equal(sent.messages.length, 1, "Exactly one reply must be sent for one event.");
  const sentMessage = sent.messages[0]!;
  assert.equal(sentMessage.action, "send_group_msg");
  assert.equal((sentMessage.body as Record<string, unknown>).group_id, 999);
  assert(String((sentMessage.body as Record<string, unknown>).message).includes("CI 模拟模型回复"), "The reply must come from the mock LLM.");

  // 5. The conversation and both messages are persisted, with an ExternalIdentity created.
  const conversation = await prisma.conversation.findFirst({
    where: { channelBindingId: bindingId, externalConversationId: "g:999" },
    select: { id: true },
  });
  assert(conversation, "A channel conversation must be persisted.");
  conversationId = conversation.id;
  const messages = await prisma.message.findMany({ where: { conversationId }, orderBy: { occurredAt: "asc" } });
  assert.equal(messages.length, 2);
  assert.equal(messages[0]!.role, "USER");
  assert.equal(messages[1]!.role, "ASSISTANT");

  const identity = await prisma.externalIdentity.findUnique({
    where: { platform_platformUid: { platform: "qq-onebot", platformUid: "111" } },
  });
  assert(identity, "An ExternalIdentity must be upserted for the OneBot author.");

  // 6. A re-delivered event with the same message id is deduplicated.
  await fetch("http://127.0.0.1:4031/__mock/emit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event: {
        post_type: "message",
        message_type: "group",
        self_id: 123456789,
        message_id: 1,
        user_id: 111,
        group_id: 999,
        sender: { user_id: 111, nickname: "小明" },
        message: [{ type: "text", data: { text: "重复消息" } }],
      },
    }),
  });
  await sleep(1500);
  const afterDuplicate = (await (await fetch("http://127.0.0.1:4031/__mock/messages")).json()) as { messages: unknown[] };
  assert.equal(afterDuplicate.messages.length, 1, "A duplicate event must not trigger a second reply.");

  // 7. 表情：开关打开后正文一条、表情单独一条；紧接着的下一条不再重复发表情（冷却）。
  const readSent = async () => ((await (await fetch("http://127.0.0.1:4031/__mock/messages")).json()) as {
    messages: Array<{ action: string; body: Record<string, unknown> }>;
  }).messages;
  const emitText = (messageId: number, text: string) => fetch("http://127.0.0.1:4031/__mock/emit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event: {
        post_type: "message",
        message_type: "group",
        self_id: 123456789,
        message_id: messageId,
        user_id: 111,
        group_id: 999,
        sender: { user_id: 111, nickname: "小明" },
        message: [{ type: "text", data: { text } }],
      },
    }),
  });

  const beforeFaces = (await readSent()).length;
  await prisma.character.update({ where: { id: characterId }, data: { modelConfig: { emojiEnabled: true } } });

  await emitText(2, "你猜");
  await waitFor(async () => (await readSent()).length >= beforeFaces + 2);
  const withFace = await readSent();
  assert.equal(withFace.length, beforeFaces + 2, "一次回复带表情时，恰好是正文加表情两条。");
  assert(String(withFace[beforeFaces]!.body.message).includes("CI 模拟模型回复"), "正文必须先发。");
  assert.deepEqual(
    withFace[beforeFaces + 1]!.body.message,
    [{ type: "face", data: { id: "0" } }],
    "表情必须是独立的 face 段，不能拼进正文。",
  );

  await emitText(3, "然后呢");
  await waitFor(async () => (await readSent()).length >= beforeFaces + 3);
  await sleep(800);
  const cooled = await readSent();
  assert.equal(cooled.length, beforeFaces + 3, "冷却期内只发正文，不再跟一张表情。");
  assert.equal(typeof cooled[beforeFaces + 2]!.body.message, "string", "冷却期内发出去的必须是纯文本。");

  // 表情段不进 content（否则会被当成用户打的字），只记在 metadata 里。
  const assistantMeta = await prisma.message.findMany({
    where: { conversationId, role: "ASSISTANT" },
    orderBy: { occurredAt: "asc" },
    select: { content: true, metadata: true },
  });
  const faceIdsPerReply = assistantMeta.map((item) => (item.metadata as { faceIds?: string[] } | null)?.faceIds ?? []);
  assert.deepEqual(faceIdsPerReply, [[], ["0"], []], "只有开了开关的那一条带 faceIds。");
  assert(
    assistantMeta.every((item) => !item.content.includes("face")),
    "正文里不能残留任何段标记。",
  );

  const stillOneHandshake = await readHandshakes();
  assert.equal(stillOneHandshake.length, 1, "整个用例期间连接一直活着，不该再有第二次握手。");

  closeGateway();

  console.log("OneBot 渠道端到端测试通过：WS token 鉴权与单次握手、事件接入、CQ 码解析、凭据解密、角色绑定路由、记忆检索、模型回复、表情段发送与冷却、消息持久化、外部身份 upsert、回发平台与幂等去重。");
} finally {
  for (const child of children) child.kill();
  if (conversationId) await prisma.conversation.deleteMany({ where: { channelBindingId: bindingId } }).catch(() => undefined);
  await prisma.characterChannelBinding.deleteMany({ where: { connectionId } }).catch(() => undefined);
  await prisma.memoryScope.deleteMany({ where: { characterId } }).catch(() => undefined);
  // 只删本用例造的假作者（111），别把真实连接的 external identity 一起端掉。
  await prisma.externalIdentity.deleteMany({ where: { platform: "qq-onebot", platformUid: "111" } }).catch(() => undefined);
  await prisma.character.deleteMany({ where: { id: characterId } }).catch(() => undefined);
  await prisma.platformConnection.deleteMany({ where: { id: connectionId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { username: { startsWith: "onebot-test-" } } }).catch(() => undefined);
  await prisma.$disconnect();
}
