import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { isStickerAutoCollectEnabled } from "../server/utils/sticker-collect";
/**
 * 「偷表情包」回归测试。
 *
 * collectSticker 依赖真实下载（公网 url）与视觉模型，没法在单测里真正跑通，
 * 这里只覆盖能脱离网络验证的部分：开关判定。下载、打标、去重这三段要么走
 * downloadImage（已有 image-understanding 的测试兜底）、要么在 dev 服务里冒烟。
 */
assert.equal(isStickerAutoCollectEnabled(undefined), false, "没配置时默认关。");
assert.equal(isStickerAutoCollectEnabled({}), false, "空配置也是关。");
assert.equal(isStickerAutoCollectEnabled({ stickerAutoCollect: true }), true, "显式 true 才开。");
assert.equal(isStickerAutoCollectEnabled({ stickerAutoCollect: false }), false);
assert.equal(isStickerAutoCollectEnabled({ stickerAutoCollect: "true" }), false, "字符串不算，别让「顺手写个字符串」悄悄打开开关。");
assert.equal(isStickerAutoCollectEnabled(null), false);

// collectStickersFromTurn 在开关关着时必须一帧不跑（不下载、不调模型）。
// 这里用一个带 url 的候选验证它直接早退 —— 开关关着，url 再合法也不该被碰。
const { collectStickersFromTurn } = await import("../server/utils/sticker-collect");
let touched = false;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  touched = true;
  throw new Error("不该发起的请求");
};
await collectStickersFromTurn(
  [{ url: "https://example.com/a.png" }],
  {
    characterId: "00000000-0000-4000-8000-00000000dead",
    modelConfig: {},
    chatModel: "test",
    chatApiBaseUrl: "https://example.com/v1",
    chatApiKey: "sk-test",
  },
);
assert.equal(touched, false, "开关关着时不能下载、不能调模型。");
globalThis.fetch = originalFetch;

// ── collectSticker 端到端（mock 网络，不碰真实公网）────────────────────────
// mock fetch：第一次是 downloadImage 的图（返回 PNG 字节），第二次是视觉模型打标（返回 JSON）。
// downloadImage 会在重定向后对 response.url 再做公网校验；undici 的 Response.url 只读，
// 这里用 defineProperty 把它钉成公网地址，避免空 url 被当成内网拦掉。
const { collectSticker } = await import("../server/utils/sticker-collect");
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
let callCount = 0;
globalThis.fetch = async (input: RequestInfo | URL) => {
  callCount += 1;
  const url = String(input);
  if (url.includes("example.com/sticker")) {
    // 下载图
    const response = new Response(pngBytes, {
      status: 200,
      headers: { "content-type": "image/png" },
    });
    Object.defineProperty(response, "url", { value: url });
    return response as Response;
  }
  // 视觉模型打标
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ name: "偷来的图", usage: "群友斗图时" }) } }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  }), { status: 200, headers: { "content-type": "application/json" } }) as Response;
};

// 需要一个开了视觉模型配置 + 开了自动收图的 context。
// characterId 必须是库里真实存在的角色（外键约束），从库里取第一个。
const { getPrisma } = await import("../server/utils/prisma");
const prisma = getPrisma();
const anyCharacter = await prisma.character.findFirst({ select: { id: true } });
if (!anyCharacter) {
  // 没有角色也能跑开关那一半的断言，但端到端这段跳过。
  console.log("（无角色，跳过落库端到端）偷表情包（sticker-collect）：开关部分通过");
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
}

const context = {
  characterId: anyCharacter.id,
  modelConfig: { stickerAutoCollect: true, imageUnderstanding: true },
  chatModel: "test-model",
  chatApiBaseUrl: "https://api.openai.com/v1",
  chatApiKey: "sk-test",
};

const created = await collectSticker(
  { url: "https://example.com/sticker.png", summary: "一只猫" },
  context,
);
assert.ok(created, "图能下载、打标、落库。");
assert.equal(created.name, "偷来的图");
assert.equal(created.usage, "群友斗图时");
assert.equal(created.source, "collected");
assert.equal(callCount, 2, "先下载一次，再打标一次。");

// 同一张图再收一次：contentHash 相同，去重返回 null（不再多花一次下载/打标）。
const before = callCount;
const dup = await collectSticker(
  { url: "https://example.com/sticker.png", summary: "一只猫" },
  context,
);
assert.equal(dup, null, "同一张图不重复偷。");
assert.equal(callCount, before + 1, "去重只多一次下载，不调打标。");

// 清理落盘的文件（避免污染仓库 .data）。
const { stickerFilePath } = await import("../server/utils/stickers");
try {
  const row = await prisma.characterSticker.findFirst({ where: { id: created.id } });
  if (row) {
    await prisma.characterSticker.delete({ where: { id: created.id } });
    const fp = stickerFilePath(context.characterId, row.fileName);
    if (fp) await fs.rm(fp, { force: true });
  }
} catch {
  // 清理失败不影响测试结论
}
try { await prisma.$disconnect(); } catch { /* ignore */ }

globalThis.fetch = originalFetch;

console.log("偷表情包（sticker-collect）：全部通过");
