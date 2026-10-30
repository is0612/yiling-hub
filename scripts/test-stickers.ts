import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  buildStickerCatalog,
  MAX_STICKER_BYTES,
  pickStickerCatalog,
  resolveStickerExtension,
  safeFileName,
  stickerFilePath,
  saveStickerFile,
  readStickerFile,
  deleteStickerFile,
  toStickerDto,
} from "../server/utils/stickers";
import { loadStickerSegments, toOnebotStickerSegments } from "../server/utils/channel-adapter/onebot/serve";

/**
 * 表情包（贴图）回归测试。
 *
 * 覆盖三件事：
 *   1. 文件名只认我们自己生成的形状 —— 库里一条被改坏的记录不能变成任意路径读文件；
 *   2. 清单做减法：剔除上一张、封顶，避免她一直贴同一张、也避免提示词被几十张图撑爆；
 *   3. 模型侧：有素材库时只给素材库（与内置表情互斥），编造的 id 一律丢弃。
 */

// ── 1. 文件名与路径 ────────────────────────────────────────────────────────
const goodName = "3f2a1c4e-5b6d-4a7f-8c9d-0e1f2a3b4c5d.png";
assert.equal(safeFileName(goodName), goodName, "uuid.png 是我们自己生成的形状，必须放行。");
assert.equal(safeFileName("../credentials-encryption.key"), null, "目录穿越必须挡住。");
assert.equal(safeFileName("evil.png"), null, "非 uuid 文件名挡住。");
assert.equal(safeFileName("3f2a1c4e-5b6d-4a7f-8c9d-0e1f2a3b4c5d.exe"), null, "只放行图片扩展名。");
assert.equal(safeFileName(null), null);
assert.equal(safeFileName(42), null);

const testCharacterId = "00000000-0000-4000-8000-00000000abcd";
assert.equal(
  stickerFilePath(testCharacterId, goodName),
  path.join(process.cwd(), ".data", "stickers", testCharacterId, goodName),
  "路径必须落在 .data/stickers/<角色>/ 下。",
);
assert.equal(stickerFilePath(testCharacterId, "../../.env"), null, "坏文件名直接返回 null，不拼路径。");

// ── 2. 扩展名推断 ──────────────────────────────────────────────────────────
assert.equal(resolveStickerExtension("image/png"), "png");
assert.equal(resolveStickerExtension("image/gif"), "gif", "动图表情包是常态，gif 必须支持。");
assert.equal(resolveStickerExtension(undefined, "猫.JPG"), "jpg");
assert.equal(resolveStickerExtension(undefined, "cat.jpeg"), "jpg");
assert.equal(resolveStickerExtension("image/svg+xml"), null, "svg 不收：它会在客户端当 XML 解析。");
assert.equal(resolveStickerExtension("text/plain", "a.txt"), null);

// ── 3. 文件读写（真的写一个小文件，用完删掉）────────────────────────────────
const saved = await saveStickerFile(testCharacterId, "png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
assert.ok(safeFileName(saved), "保存返回的文件名必须是我们生成的形状。");
const readBack = await readStickerFile(testCharacterId, saved!);
assert.equal(readBack?.length, 4, "写进去的字节要能原样读回来。");
await deleteStickerFile(testCharacterId, saved!);
assert.equal(await readStickerFile(testCharacterId, saved!), null, "删掉之后读回来是 null（不是异常）。");
await fs.rm(path.join(process.cwd(), ".data", "stickers", testCharacterId), { recursive: true, force: true });

// ── 4. 清单做减法 ──────────────────────────────────────────────────────────
const rows = Array.from({ length: 15 }, (_, index) => ({
  id: `sticker-${index}`,
  characterId: testCharacterId,
  name: `表情 ${index}`,
  usage: "测试",
  fileName: goodName,
  enabled: true,
}));
const catalog = buildStickerCatalog(rows);
assert.equal(catalog.length, 15, "全部文件名合法时一条都不能丢。");
assert.equal(buildStickerCatalog([{ ...rows[0]!, fileName: "../x.png" }]).length, 0, "坏文件名的条目直接跳过。");

const picked = pickStickerCatalog(catalog, "sticker-0");
assert.equal(picked.length, 12, "清单封顶 12 条：几十张图全进提示词，模型反而挑不准。");
assert.ok(!picked.some((entry) => entry.id === "sticker-0"), "上一张用过的要剔掉，否则她会一直贴同一张。");

const single = [{ id: "only-one", characterId: testCharacterId, name: "唯一", usage: "", fileName: goodName, enabled: true }];
assert.equal(pickStickerCatalog(single, "only-one").length, 1, "只剩一张时不再剔除——总比没有强。");

// ── 5. 出站段 ──────────────────────────────────────────────────────────────
assert.deepEqual(
  toOnebotStickerSegments("QQ=="),
  [{ type: "image", data: { file: "base64://QQ==" } }],
  "表情包走 image 段 + base64：网关可能不在本机，路径方式跨机就是一张发不出去的图。",
);
assert.deepEqual(toOnebotStickerSegments(""), [], "空 base64 不产生段。");
assert.ok(MAX_STICKER_BYTES <= 2 * 1024 * 1024, "单张上限 2MB：base64 之后还要再涨三分之一。");

// 5b. 真读一次文件：拿到的是 image 段，内容就是这张图的 base64。
const tempDir = path.join(process.cwd(), ".data", "stickers", "00000000-0000-4000-8000-00000000beef");
await fs.mkdir(tempDir, { recursive: true });
const tempFile = path.join(tempDir, goodName);
await fs.writeFile(tempFile, Buffer.from([0x01, 0x02, 0x03]));
const fileSegments = await loadStickerSegments(tempFile);
assert.equal(fileSegments.length, 1, "文件在就出一个 image 段。");
assert.equal(fileSegments[0]!.data.file, `base64://${Buffer.from([0x01, 0x02, 0x03]).toString("base64")}`);
// 文件不在（换电脑只搬了库）→ 空数组，静默跳过，不能让整条回复失败。
assert.deepEqual(await loadStickerSegments(path.join(tempDir, "404.png")), []);
// 超限的大文件也跳过：base64 之后更大，网关很可能直接拒。
const bigFile = path.join(tempDir, "3f2a1c4e-5b6d-4a7f-8c9d-0e1f2a3b4c5e.png");
await fs.writeFile(bigFile, Buffer.alloc(MAX_STICKER_BYTES + 1));
assert.deepEqual(await loadStickerSegments(bigFile), []);
await fs.rm(tempDir, { recursive: true, force: true });

// ── 6. DTO ─────────────────────────────────────────────────────────────────
const dto = toStickerDto({
  id: "s1", name: "委屈", usage: "被冤枉时", enabled: true,
  mimeType: "image/png", sizeBytes: 2048, useCount: 3,
  lastUsedAt: new Date("2026-10-30T00:00:00.000Z"), createdAt: new Date("2026-10-29T00:00:00.000Z"),
});
assert.equal(dto.lastUsedAt, "2026-10-30T00:00:00.000Z", "时间统一转成 ISO 字符串。");
assert.equal(toStickerDto({ ...dto, lastUsedAt: null as unknown as Date, createdAt: new Date(dto.createdAt) }).lastUsedAt, null);
assert.equal(dto.source, "manual", "老数据没有 source 时默认 manual。");
assert.equal(
  toStickerDto({
    id: "s1", name: "委屈", usage: "被冤枉时", enabled: true,
    mimeType: "image/png", sizeBytes: 2048, useCount: 3,
    lastUsedAt: null, createdAt: new Date("2026-10-29T00:00:00.000Z"), source: "collected",
  }).source,
  "collected",
  "群里收的要标成 collected，页面才好显示「从群里收的」。",
);

// ── 7. 模型侧：挑图与互斥 ──────────────────────────────────────────────────
const originalFetch = globalThis.fetch;
let capturedBody = "";
let modelReply: Record<string, unknown> = { reply: "好呀。", usedMemoryIds: [], usedSnapshotIds: [] };

globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  capturedBody = typeof init?.body === "string" ? init.body : "";
  return new Response(JSON.stringify({
    model: "test-model",
    choices: [{ message: { role: "assistant", content: JSON.stringify(modelReply) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }), { status: 200, headers: { "content-type": "application/json" } });
};

try {
  const { generateConversationReply } = await import("../server/utils/chat-reply");
  const stickers = [
    { id: "sticker-a", name: "委屈", usage: "被冤枉、想撒娇时" },
    { id: "sticker-b", name: "得意", usage: "被夸、小得意时" },
  ];

  // 7a. 选了清单里的 id → 收下。
  modelReply = { reply: "才没有。", usedMemoryIds: [], usedSnapshotIds: [], sticker: "sticker-a" };
  const pickedResult = await generateConversationReply({
    characterName: "小鱼", characterPrompt: "温柔。", model: "test-model", apiKey: "sk-test",
    currentMessage: "你又偷吃", recentMessages: [], memories: [], snapshots: [],
    emojiStickers: stickers,
  });
  assert.equal(pickedResult.stickerId, "sticker-a", "清单内的 id 要收下。");
  assert.deepEqual(pickedResult.faceIds, [], "有素材库时不再返回内置表情。");
  assert.ok(capturedBody.includes("availableStickers"), "素材库要进提示词。");
  assert.ok(capturedBody.includes("被冤枉、想撒娇时"), "usage 要进提示词——只给名字模型挑不准。");
  assert.ok(!capturedBody.includes("availableFaces"), "两套清单不能同时给，模型会在两者之间犹豫。");

  // 7b. 编造的 id → 丢弃。
  modelReply = { reply: "嗯。", usedMemoryIds: [], usedSnapshotIds: [], sticker: "sticker-zzz" };
  const invented = await generateConversationReply({
    characterName: "小鱼", characterPrompt: "温柔。", model: "test-model", apiKey: "sk-test",
    currentMessage: "在吗", recentMessages: [], memories: [], snapshots: [],
    emojiStickers: stickers,
  });
  assert.equal(invented.stickerId, null, "清单外的 id 一律丢弃——模型偶尔会自己编一个。");

  // 7c. 把名字写进 sticker 字段（常见抽风）→ 丢弃。
  modelReply = { reply: "嗯。", usedMemoryIds: [], usedSnapshotIds: [], sticker: "委屈" };
  const byName = await generateConversationReply({
    characterName: "小鱼", characterPrompt: "温柔。", model: "test-model", apiKey: "sk-test",
    currentMessage: "在吗", recentMessages: [], memories: [], snapshots: [],
    emojiStickers: stickers,
  });
  assert.equal(byName.stickerId, null, "只认 id，名字不算。");

  // 7d. 没传素材库 → 字段为 null，提示词里不出现 availableStickers。
  modelReply = { reply: "好。", usedMemoryIds: [], usedSnapshotIds: [], sticker: "sticker-a" };
  const withoutCatalog = await generateConversationReply({
    characterName: "小鱼", characterPrompt: "温柔。", model: "test-model", apiKey: "sk-test",
    currentMessage: "在吗", recentMessages: [], memories: [], snapshots: [],
  });
  assert.equal(withoutCatalog.stickerId, null, "没传清单时恒为 null。");
  assert.ok(!capturedBody.includes("availableStickers"), "没传清单就不该提这件事（省 token）。");
} finally {
  globalThis.fetch = originalFetch;
}

console.log("表情包（贴图）：全部通过");
