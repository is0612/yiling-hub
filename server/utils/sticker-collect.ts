import { createHash } from "node:crypto";
import { buildChatCompletionsEndpoint } from "./chat-model-config";
import { downloadImage, resolveImageUnderstandingSettings } from "./image-understanding";
import { readModelUsage, recordModelUsage } from "./model-usage";
import { normalizeStickerImage } from "./sticker-image";
import {
  invalidateStickerCache,
  resolveStickerExtension,
  saveStickerFile,
  deleteStickerFile,
  toStickerDto,
} from "./stickers";

/**
 * 「偷表情包」：看到群友发图/表情，判断这张值得收，就存进她自己的表情库，
 * 再用视觉模型自动补上「名字 + 什么时候用」。
 *
 * 设计边界（别越界）：
 *   1. **只收群聊里的图**，且不看她自己（ASSISTANT）发的 —— 偷自己的图没有意义，还容易无限循环。
 *   2. 复用看图旁路的 `downloadImage`（rkey 时效 + 公网白名单 + 4MB 上限），不重写一套下载。
 *      拿不到 url 的商城表情包（`marketface`）本来就没有图片本体，自然收不了。
 *   3. **按内容 hash 去重**：群里一张图被转来转去，只收第一次；她自己库里的图也不再重复偷。
 *   4. 打标复用视觉模型配置（不配 `VISION_MODEL` / 没开看图就完全不动），但提示词换成
 *      「给表情包起名 + 写使用场景」输出 JSON，而不是看图旁路那段画面描述。
 *   5. **起不出名字就不收**：名字是模型挑图的唯一依据，`收藏的表情` 这种兜底名等于废图，
 *      存进去只是白占名额。没配视觉模型时同理，整条自动收图等于关着。
 *   6. 整条链路失败都静默：收图是锦上添花，不能让一轮群聊因此变成错误。
 */

export type StickerCollectCandidate = {
  /** 图片直链（有时效，必须当场下载）。 */
  url: string;
  /** 表情包常带的一句梗说明，能帮视觉模型起名。 */
  summary?: string;
};

export type StickerCollectContext = {
  characterId: string;
  bindingId?: string;
  modelConfig: unknown;
  chatModel: string;
  chatApiBaseUrl: string;
  chatApiKey: string;
};

const MAX_COLLECT_PER_TURN = 1;
const LABEL_TIMEOUT_MS = 20_000;
const LABEL_MAX_TOKENS = 200;

/** 角色是否开了「自动收图」。默认关：一开就会在群里为每张图花钱，不能静默上线。 */
export function isStickerAutoCollectEnabled(modelConfig: unknown): boolean {
  const record = modelConfig && typeof modelConfig === "object" && !Array.isArray(modelConfig)
    ? modelConfig as Record<string, unknown>
    : {};
  return record.stickerAutoCollect === true;
}

/** 图的 SHA-256。用内容而不是 url：同一张图换了直链还是同一张。 */
function hashOf(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * 这些名字等于「没起名」。模型偶尔会偷懒直接回「表情」「表情包」，
 * 存下来就是占着额度、又永远挑不中的图 —— 名字里没有任何可判断的信息。
 */
const GENERIC_NAMES = new Set(["表情", "表情包", "图片", "收藏的表情", "未知", "无", "表情图片", "一张图"]);

function isUsableStickerName(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return false;
  return !GENERIC_NAMES.has(trimmed);
}

/** 给一张图起名 + 写使用场景。失败返回 null，调用方当没收下。 */
async function labelSticker(
  dataUrl: string,
  summary: string,
  context: StickerCollectContext,
): Promise<{ name: string; usage: string } | null> {
  const settings = resolveImageUnderstandingSettings({
    modelConfig: context.modelConfig,
    chatModel: context.chatModel,
    chatApiBaseUrl: context.chatApiBaseUrl,
    chatApiKey: context.chatApiKey,
  });
  if (!settings) return null;

  let endpoint: URL;
  try {
    endpoint = buildChatCompletionsEndpoint(settings.apiBaseUrl);
  } catch {
    return null;
  }

  const hint = summary.trim() ? `（图自带的梗说明：${summary.trim().slice(0, 80)}）` : "";
  const body = {
    model: settings.model,
    temperature: 0.2,
    max_tokens: LABEL_MAX_TOKENS,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: [
          "你给一张 QQ 表情包起名并写使用场景。只返回 JSON：{\"name\":\"...\",\"usage\":\"...\"}。",
          "name 是一个简短的中文名（2-6 个字，写成情绪或动作词，如「委屈」「拍桌笑」「比心」），不要编号、不要带「表情包」三个字。",
          "usage 是一句话（20 字内），写「什么时候用这张」，如「被冤枉、想撒娇时」。",
          "只看图里确实存在的东西，不要推测。名字和 usage 不要照抄这段提示词。",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          { type: "text", text: `给这张表情包起名并写使用场景。${hint}` },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  };

  let payload: unknown;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: { authorization: "Bearer " + settings.apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(LABEL_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    payload = await response.json();
  } catch {
    return null;
  }

  const usage = (payload as { usage?: unknown } | null)?.usage;
  const tokens = readModelUsage(usage);
  if (tokens) {
    await recordModelUsage({
      kind: "sticker-label",
      model: settings.model,
      usage: tokens,
      characterId: context.characterId,
      ...(context.bindingId ? { channelBindingId: context.bindingId } : {}),
    }).catch(() => undefined);
  }

  const record = payload as { choices?: Array<{ message?: { content?: unknown } }> } | null;
  const content = typeof record?.choices?.[0]?.message?.content === "string"
    ? record.choices[0].message.content
    : "";
  let parsed: { name?: unknown; usage?: unknown } = {};
  try {
    parsed = JSON.parse(content) as { name?: unknown; usage?: unknown };
  } catch {
    return null;
  }
  const name = typeof parsed.name === "string" ? parsed.name.trim().slice(0, 60) : "";
  const usageText = typeof parsed.usage === "string" ? parsed.usage.trim().slice(0, 200) : "";
  if (!isUsableStickerName(name)) return null;
  return { name, usage: usageText };
}

/**
 * 收一张图进角色表情库。返回新增的 DTO，失败返回 null。
 *
 * 去重分两层：先查这个角色有没有 `contentHash` 相同的图（偷过的不再偷），
 * 再落库前用唯一性兜底 —— 并发时两条同 hash 的记录可能同时通过查询，靠再次校验挡住。
 */
export async function collectSticker(
  candidate: StickerCollectCandidate,
  context: StickerCollectContext,
): Promise<ReturnType<typeof toStickerDto> | null> {
  if (!candidate.url) return null;

  let image: { buffer: Buffer; mime: string };
  try {
    image = await downloadImage(candidate.url);
  } catch {
    return null;
  }

  const extension = resolveStickerExtension(image.mime);
  if (!extension) return null;

  const contentHash = hashOf(image.buffer);
  const { getPrisma } = await import("./prisma");
  const prisma = getPrisma();

  const existing = await prisma.characterSticker.findFirst({
    where: { characterId: context.characterId, contentHash },
    select: { id: true },
  });
  if (existing) return null;

  /**
   * 缩到宽 240 再存：QQ 按图片原始像素显示，群里偷来的图常常 1000px 以上，
   * 存原件就是存一张「发出去占满一屏」的巨图。
   *
   * 用缩好的这张去打标也有好处：240 宽的 base64 小一大截，视觉请求更快更便宜，
   * 而判断「这张适合什么时候用」看 240 宽完全够。
   */
  const normalized = await normalizeStickerImage(image.buffer, image.mime);
  const storedImage = normalized?.resized ? normalized.buffer : image.buffer;

  const dataUrl = `data:${image.mime};base64,${storedImage.toString("base64")}`;
  const label = await labelSticker(dataUrl, candidate.summary ?? "", context);
  /**
   * 起不出名字就不收。
   *
   * 以前用「收藏的表情」兜底存下来，结果库里攒了几张既没名字线索、也没使用场景的图：
   * 提示词里模型只看到「收藏的表情 / usage 空」，根本判断不出什么时候该用，
   * 等于白占一个名额（实测 25 张里有 3 张是这种）。识别不了就别进库 ——
   * 用户要的是「她的表情包」，不是「一堆图」。
   */
  if (!label) return null;
  const name = label.name;
  const usage = label.usage;

  const fileName = await saveStickerFile(context.characterId, extension, storedImage);
  let row;
  try {
    row = await prisma.characterSticker.create({
      data: {
        characterId: context.characterId,
        name,
        usage,
        fileName,
        mimeType: image.mime,
        sizeBytes: storedImage.byteLength,
        contentHash,
        source: "collected",
      },
    });
  } catch {
    // 并发下撞了唯一约束或别的写入错误：删掉刚落的文件，当没收下。
    await deleteStickerFile(context.characterId, fileName);
    return null;
  }
  invalidateStickerCache(context.characterId);
  return toStickerDto(row);
}

/**
 * 从一轮群聊的图里挑要收的。当前策略：收第一张能拿到的图，一轮最多一张。
 * 不调模型判断「值不值得收」——那张图已经在提示词里了，这里只负责把图本体存下来。
 */
export async function collectStickersFromTurn(
  candidates: readonly StickerCollectCandidate[],
  context: StickerCollectContext,
): Promise<void> {
  if (!isStickerAutoCollectEnabled(context.modelConfig)) return;
  for (const candidate of candidates.slice(0, MAX_COLLECT_PER_TURN)) {
    await collectSticker(candidate, context);
  }
}
