/**
 * QQ 语音：她「说话」（TTS → silk）与「听懂语音」（silk → ASR）。
 *
 * 为什么单独一条链路，而不是让聊天模型直接处理音频：
 *   聊天模型走的是文本 chat/completions，音频既进不去也出不来。所以语音只能发生在
 *   两个边界上 —— 发出前（文字 → 声音）和收到后（声音 → 文字）。中间那一段仍然是
 *   原来那套 chat-reply / pipeline，一个字都不用改。
 *
 * QQ 语音条只吃 **silk**（Tencent 私有编码），而 TTS 给的是 wav/mp3，所以这条链路上
 * 必然有一次转码。转码用 `silk-wasm`（纯 wasm，不需要 ffmpeg）：
 *   - 出站：TTS 直接要 `wav` → silk；要不到 wav 就当合成失败，退回发文字。
 *   - 入站：silk → pcm → 补一个 wav 头 → 交 ASR。
 * **不要再退回「让网关自己转码」**：网关不一定和适配器同机，也不一定装了 ffmpeg。
 *
 * 三件事必须在这里守住，别挪到调用方：
 *   1. **语音是钱**：TTS 按字符计费、ASR 按秒计费，且都不进 token 报表（见下）。
 *      所以打开开关、长度上限、冷却时间都在这一层定死。
 *   2. **url 是外部输入**：语音直链和图片直链一样可以指向内网，下载前过同一套白名单。
 *   3. **失败必须静默降级**：合成失败就发文字，识别失败就保留 `[语音]`，
 *      绝不能让一轮普通聊天变成失败事件。
 *
 * 关于记账：`model_usages` 是按 token 结算的表，语音按字符/秒计费，塞进去会污染
 * 「未定价 token」统计和金额报表（CLAUDE.md 那条「认不出的模型不许当 0 元」）。
 * 所以语音**不写 model_usages**，只在日志里留 `[voice]` 一行，便于按天估算。
 */

import { decode as decodeSilk, encode as encodeSilk, isSilk, isWav } from "silk-wasm";

import { validateChatApiBaseUrl } from "./chat-model-config";
import { assertFetchableImageUrl, assertPublicHost } from "./image-understanding";

/** 这条回复最多合成多少字。再长就该用文字说：没人愿意听 40 秒的语音条。 */
export const VOICE_TEXT_MAX_CHARS = 60;

/** 上一条发过语音后多久之内不再发。连发两条语音像在读稿。 */
export const VOICE_COOLDOWN_MS = 20 * 60 * 1000;

/** 一轮最多转写几条语音。群里一轮三条已经不少，再多就是在替群友开会。 */
export const MAX_VOICES_PER_TURN = 2;

/** 单条语音上限：15 分钟以外的语音基本没人发给她。超过就整条不转写。 */
const MAX_VOICE_BYTES = 6 * 1024 * 1024;
const MAX_VOICE_DURATION_MS = 60_000;

/**
 * QQ 语音的采样率。silk 文件头里不写采样率，解码时得由调用方告知；
 * QQ 移动端录的语音是 24kHz，与这里保持一致。
 */
export const VOICE_SAMPLE_RATE = 24_000;

const DOWNLOAD_TIMEOUT_MS = 8_000;
// 实测硅基流动 CosyVoice2 单次合成 16-21 秒（排队开销，与字数无关），
// 超时给 30 秒时偶尔会踩线失败 —— 那会变成「莫名其妙只发了文字」，放宽到 45 秒。
const TTS_TIMEOUT_MS = 45_000;
const ASR_TIMEOUT_MS = 30_000;
const MODEL_MAX_CHARS = 120;
const VOICE_NAME_MAX_CHARS = 100;

/** 她这条回复能不能发语音：角色级开关，默认关（同 emojiEnabled 的路子）。 */
export function isVoiceReplyEnabled(configValue: unknown): boolean {
  return asRecord(configValue).voiceEnabled === true;
}

/** 她听不听得懂语音：角色级开关，默认关。与「发语音」是两个开关。 */
export function isVoiceTranscribeEnabled(configValue: unknown): boolean {
  return asRecord(configValue).voiceTranscribe === true;
}

/**
 * 随机发语音的概率（百分比，0-100）。**默认 0**。
 *
 * 为什么不默认随手发：合成实测 16-21 秒（服务商排队），随机触发等于随机让一条回复迟到。
 * 她仍然会在用户明确要语音时发（`isVoiceRequested`），这条概率只是「她自己偶尔也想说」的开关，
 * 由用户按自己用的服务商快慢决定要不要拧开。
 */
export function resolveVoiceChance(configValue: unknown): number {
  const raw = asRecord(configValue).voiceChance;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  return Math.min(100, Math.max(0, Math.round(raw)));
}

export type VoiceTtsProvider = "openai" | "minimax";

/**
 * 这两家的差别不只是端点：MiniMax 的 `data.audio` 是 **hex 字符串**（不是二进制），
 * 还要一个 `GroupId` 查询参数。所以不能"一个 OpenAI 兼容实现打天下"。
 */
export type VoiceTtsSettings = {
  provider: VoiceTtsProvider;
  model: string;
  voice: string;
  apiBaseUrl: string;
  apiKey: string;
  /** 仅 MiniMax 需要；留空就不拼查询参数（新账号改纯 Bearer 时也不至于卡住）。 */
  groupId: string;
  /** 语速。0.5–2.0，默认 1。 */
  speed: number;
  /**
   * 请求的采样率。**只有配了 `VOICE_TTS_SAMPLE_RATE` 才会带上** ——
   * OpenAI 官方不认这个字段（多传会 400），而 SiliconFlow 这类服务默认 44100，
   * 我们最终要转成 24k silk，直接要 24000 能省一半体积和一次重采样。
   */
  sampleRate?: number;
};

/** MiniMax 国内站默认端点。国际站是 api.minimax.io，靠地址推断。 */
const MINIMAX_DEFAULT_BASE = "https://api.minimaxi.com/v1";

export type VoiceAsrSettings = {
  model: string;
  apiBaseUrl: string;
  apiKey: string;
  /** 留空 = 让服务商自己判断语言。OpenAI 之外的兼容服务不一定认这个字段。 */
  language: string;
};

export type VoiceSettingsInput = {
  modelConfig?: unknown;
  chatModel?: string;
  chatApiBaseUrl?: string;
  chatApiKey?: string;
  /**
   * 角色级语音 Key（页面上填的那个，已解密）。优先级：
   * 它 > 环境变量 `VOICE_*_API_KEY` > 角色自己的聊天 Key。
   */
  voiceApiKey?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** 有人把 /audio/speech 当成 Base URL 填进来是常见错误，这种值不能拿来拼端点。 */
const AUDIO_ENDPOINT_SUFFIX = /\/(audio\/speech|audio\/transcriptions)$/;

/**
 * 语音服务的 Base URL。
 *
 * 显式配了 `VOICE_*_BASE_URL` 就必须是对的：写错时**不**回落到聊天端点 ——
 * 那样用户会以为语音走的是另一个服务，实际却悄悄打到了聊天服务商，
 * 出问题时日志里一句解释都没有。宁可不发语音。
 */
function resolveVoiceBaseUrl(explicit: string, fallback: string): string | null {
  const primary = explicit.trim();
  if (primary) {
    try {
      const normalized = validateChatApiBaseUrl(primary);
      return normalized && !AUDIO_ENDPOINT_SUFFIX.test(normalized) ? normalized : null;
    } catch {
      return null;
    }
  }
  const secondary = fallback.trim();
  if (!secondary) return null;
  try {
    const normalized = validateChatApiBaseUrl(secondary);
    return normalized && !AUDIO_ENDPOINT_SUFFIX.test(normalized) ? normalized : null;
  } catch {
    // 地址写错当没配：语音不能因为一个坏 URL 整轮失败。
    return null;
  }
}

/**
 * 解析 TTS 配置。返回 null = 不发语音（这是默认状态，不是错误）。
 *
 * 模型优先级：角色 `modelConfig.ttsModel` > `VOICE_TTS_MODEL`。
 * 地址/密钥：`VOICE_TTS_*` > 角色自己的聊天模型地址与密钥。
 *
 * 回落到聊天模型是刻意的：OpenAI 官方与多数中转站的 chat 与 audio 共用同一份凭据，
 * 所以「填一个 VOICE_TTS_MODEL 就能用」，不必再准备第二套 key。
 */
export function resolveVoiceTtsSettings(input: VoiceSettingsInput): VoiceTtsSettings | null {
  const config = asRecord(input.modelConfig);
  const model = (readString(config.ttsModel)
    || readString(process.env.VOICE_TTS_MODEL)
    || "").slice(0, MODEL_MAX_CHARS);
  if (!model) return null;

  // 服务商：显式配了就用（`ttsProvider` / `VOICE_TTS_PROVIDER`），没配就看地址里的 minimax。
  // 自动推断是刻意的 —— 用户只想换一家服务，不该被逼着多填一个枚举。
  const explicitProvider = readString(config.ttsProvider) || readString(process.env.VOICE_TTS_PROVIDER);
  const explicitBase = readString(config.voiceApiBaseUrl) || readString(process.env.VOICE_TTS_BASE_URL);
  const chatBase = input.chatApiBaseUrl ?? "";
  const provider: VoiceTtsProvider = explicitProvider === "minimax" || explicitProvider === "openai"
    ? explicitProvider
    : (/minimax/i.test(explicitBase || chatBase) ? "minimax" : "openai");

  const apiBaseUrl = resolveVoiceBaseUrl(
    explicitBase || (provider === "minimax" ? MINIMAX_DEFAULT_BASE : ""),
    chatBase,
  );
  if (!apiBaseUrl) return null;

  // 页面填的 Key > 环境变量 > 角色聊天 Key。前两个是「语音专用」，最后一个只是同服务商时的便利。
  const apiKey = input.voiceApiKey?.trim()
    || readString(process.env.VOICE_TTS_API_KEY)
    || input.chatApiKey?.trim()
    || "";
  if (!apiKey) return null;

  const voice = (readString(config.ttsVoice)
    || readString(process.env.VOICE_TTS_VOICE)
    || (provider === "minimax" ? "female-shaonv" : "alloy")).slice(0, VOICE_NAME_MAX_CHARS);
  const speedRaw = Number(process.env.VOICE_TTS_SPEED ?? "1");
  const speed = Number.isFinite(speedRaw) ? Math.min(2, Math.max(0.5, speedRaw)) : 1;
  // 只接受 silk 认识的几档采样率，其余当没配（写错了不如不传）。
  const sampleRateRaw = Number(process.env.VOICE_TTS_SAMPLE_RATE ?? "");
  const sampleRate = [8000, 16000, 24000, 32000, 44100, 48000].includes(sampleRateRaw)
    ? sampleRateRaw
    : undefined;
  const groupId = (readString(config.ttsGroupId) || readString(process.env.VOICE_TTS_GROUP_ID))
    .slice(0, VOICE_NAME_MAX_CHARS);

  return {
    provider,
    model,
    voice,
    apiBaseUrl,
    apiKey,
    groupId,
    speed,
    ...(sampleRate ? { sampleRate } : {}),
  };
}

/** 解析 ASR 配置。返回 null = 不转写语音。优先级规则同 TTS。 */
export function resolveVoiceAsrSettings(input: VoiceSettingsInput): VoiceAsrSettings | null {
  const config = asRecord(input.modelConfig);
  const model = (readString(config.asrModel)
    || readString(process.env.VOICE_ASR_MODEL)
    || "").slice(0, MODEL_MAX_CHARS);
  if (!model) return null;

  // ASR 地址：**环境变量优先于页面上的「服务地址」**。
  //
  // 页面上那个字段是给合成用的。用户把合成换成 MiniMax 之后，识别不该跟着搬过去 ——
  // MiniMax 没有 /audio/transcriptions，两边一起改的结果是「语音能发、但突然听不懂话了」，
  // 而页面上看不出任何异常（开关都还开着）。所以识别地址以 `.env` 的 VOICE_ASR_* 为准，
  // 没配它才复用页面地址（只有一家服务商、且支持音频两个端点时这是对的）。
  const apiBaseUrl = resolveVoiceBaseUrl(
    readString(process.env.VOICE_ASR_BASE_URL) || readString(config.voiceApiBaseUrl),
    input.chatApiBaseUrl ?? "",
  );
  if (!apiBaseUrl) return null;

  const apiKey = input.voiceApiKey?.trim()
    || readString(process.env.VOICE_ASR_API_KEY)
    || input.chatApiKey?.trim()
    || "";
  if (!apiKey) return null;

  return {
    model,
    apiBaseUrl,
    apiKey,
    language: readString(process.env.VOICE_ASR_LANGUAGE).slice(0, 20),
  };
}

export function buildSpeechEndpoint(baseUrl: string): URL {
  const normalized = validateChatApiBaseUrl(baseUrl);
  if (!normalized) throw new Error("请先填写语音 API Base URL。");
  return new URL(normalized + "/audio/speech");
}

/**
 * MiniMax 的语音端点是 `/t2a_v2`，并且 **GroupId 在查询串里**而不是 body 里。
 * 留空就不带这个参数：新版账号可能只需要 Bearer，硬要求 GroupId 反而会把能用的配置卡死。
 */
export function buildMinimaxEndpoint(baseUrl: string, groupId: string): URL {
  const normalized = validateChatApiBaseUrl(baseUrl);
  if (!normalized) throw new Error("请先填写语音 API Base URL。");
  const url = new URL(normalized + "/t2a_v2");
  if (groupId) url.searchParams.set("GroupId", groupId);
  return url;
}

export function buildTranscriptionEndpoint(baseUrl: string): URL {
  const normalized = validateChatApiBaseUrl(baseUrl);
  if (!normalized) throw new Error("请先填写语音 API Base URL。");
  return new URL(normalized + "/audio/transcriptions");
}

/** 16bit PCM 补一个标准 44 字节 wav 头。silk 解码结果没有头，ASR 要的是完整 wav。 */
export function buildWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // 单声道
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * 重算 wav 的长度字段。
 *
 * 为什么需要：好几家 TTS（硅基流动实测）返回的 wav 里 RIFF size 与 data size 是负值
 * （`0xFFFFFFA6` / `0xFFFFFF00`），文件本身能播，但严格校验的实现（`silk-wasm` 的 `isWav`）
 * 会直接判成「不是 wav」。长度是可以自己算的 —— 文件总长减去头，本来就不该信服务商填的数。
 *
 * 只修长度，不动格式字段：采样率/声道/位深写错的话那是另一回事，改不了也不该猜。
 */
export function repairWavSizes(buffer: Buffer): Buffer {
  if (buffer.length < 44) throw new Error("VOICE_NOT_WAV");
  if (buffer.subarray(0, 4).toString("latin1") !== "RIFF") throw new Error("VOICE_NOT_WAV");
  if (buffer.subarray(8, 12).toString("latin1") !== "WAVE") throw new Error("VOICE_NOT_WAV");

  const fixed = Buffer.from(buffer);
  fixed.writeUInt32LE(fixed.length - 8, 4);

  // 按 chunk id 找 data。不能靠「顺着 size 走」—— 坏掉的那个 size 正是我们要修的。
  let offset = 12;
  while (offset + 8 <= fixed.length) {
    const id = fixed.subarray(offset, offset + 4).toString("latin1");
    if (id === "data") {
      fixed.writeUInt32LE(fixed.length - offset - 8, offset + 4);
      return fixed;
    }
    const size = fixed.readUInt32LE(offset + 4);
    if (offset + 8 + size > fixed.length) break;
    offset += 8 + size + (size % 2);
  }
  return fixed;
}

/** wav → silk。不是 wav 就抛错 —— 这里宁可失败也不想发一段别人听不了的文件。 */
export async function wavToSilk(wav: Buffer): Promise<Buffer> {
  let input = wav;
  if (!isWav(input)) input = repairWavSizes(input);
  if (!isWav(input)) throw new Error("VOICE_NOT_WAV");
  // sampleRate 传 0：silk-wasm 会自己从 wav 头里读采样率。
  const result = await encodeSilk(input, 0);
  return Buffer.from(result.data);
}

/** silk → wav。已经是 wav 就原样返回（有的网关会把语音转存成 wav 再给直链）。 */
export async function silkToWav(input: Buffer): Promise<Buffer> {
  if (isWav(input)) return input;
  // 网关转存的 wav 可能同样带坏长度字段：先试修一次，再按 silk 解。
  if (isWavLenient(input)) return repairWavSizes(input);
  if (!isSilk(input)) throw new Error("VOICE_NOT_SILK");
  const result = await decodeSilk(input, VOICE_SAMPLE_RATE);
  return buildWav(Buffer.from(result.data), VOICE_SAMPLE_RATE);
}

/** 只看 magic，不看长度字段：用来判断「这是个坏头的 wav」而不是「这根本不是 wav」。 */
function isWavLenient(buffer: Buffer): boolean {
  return buffer.length >= 44
    && buffer.subarray(0, 4).toString("latin1") === "RIFF"
    && buffer.subarray(8, 12).toString("latin1") === "WAVE";
}

/**
 * 文字 → wav 字节。两家服务商的请求形状完全不同，所以分成两支。
 *
 * 都只要 wav：mp3 需要额外的解码器才能进 silk 编码，多一个依赖只为了兜底不值得。
 * 服务商不支持 wav 时这条链路就是不工作，日志里会写清楚。
 */
async function requestWav(text: string, settings: VoiceTtsSettings): Promise<Buffer | null> {
  if (settings.provider === "minimax") return requestMinimaxWav(text, settings);
  return requestOpenaiWav(text, settings);
}

async function requestOpenaiWav(text: string, settings: VoiceTtsSettings): Promise<Buffer | null> {
  let endpoint: URL;
  try {
    endpoint = buildSpeechEndpoint(settings.apiBaseUrl);
  } catch {
    return null;
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: { authorization: "Bearer " + settings.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        model: settings.model,
        voice: settings.voice,
        input: text,
        response_format: "wav",
        speed: settings.speed,
        ...(settings.sampleRate ? { sample_rate: settings.sampleRate } : {}),
      }),
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error("[voice] tts 失败：HTTP " + response.status + " " + (await safeText(response)).slice(0, 200));
      return null;
    }
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    console.error("[voice] tts 请求异常：", error instanceof Error ? error.message : String(error));
    return null;
  }
}

/** MiniMax 失败时 HTTP 可能仍是 200，真正的结果在 `base_resp.status_code` 里。 */
function readMinimaxError(payload: unknown): string {
  const record = asRecord(payload);
  const base = asRecord(record.base_resp);
  const code = base.status_code;
  if (code === 0 || code === undefined) return "";
  const message = typeof base.status_msg === "string" ? base.status_msg : "";
  return `code=${String(code)} ${message}`.trim();
}

async function requestMinimaxWav(text: string, settings: VoiceTtsSettings): Promise<Buffer | null> {
  let endpoint: URL;
  try {
    endpoint = buildMinimaxEndpoint(settings.apiBaseUrl, settings.groupId);
  } catch {
    return null;
  }

  let payload: unknown;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: { authorization: "Bearer " + settings.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        model: settings.model,
        text,
        stream: false, // wav 只在非流式下支持
        voice_setting: {
          voice_id: settings.voice,
          speed: settings.speed,
          vol: 1,
          pitch: 0,
        },
        audio_setting: {
          format: "wav",
          // 文档示例用 32000；silk 编码这边认得，最终会转成 24k。
          sample_rate: settings.sampleRate ?? 32000,
          channel: 1,
        },
        language_boost: "auto",
      }),
      signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error("[voice] tts 失败：HTTP " + response.status + " " + (await safeText(response)).slice(0, 200));
      return null;
    }
    payload = await response.json();
  } catch (error) {
    console.error("[voice] tts 请求异常：", error instanceof Error ? error.message : String(error));
    return null;
  }

  const failure = readMinimaxError(payload);
  if (failure) {
    // 200 + 业务错误码是常态（余额不足、音色不存在、GroupId 不匹配都走这里）。
    console.error("[voice] tts 失败：" + failure);
    return null;
  }

  const audioHex = readString(asRecord(asRecord(payload).data).audio);
  if (!audioHex) {
    console.error("[voice] tts 返回里没有 data.audio");
    return null;
  }
  // **MiniMax 给的是 hex 字符串**，不是二进制。直接当 buffer 写会得到一坨乱码。
  if (audioHex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(audioHex)) {
    console.error("[voice] tts 返回的 audio 不是合法 hex（长度 " + audioHex.length + "）");
    return null;
  }
  return Buffer.from(audioHex, "hex");
}

/**
 * 文字 → silk。任何一步失败都返回 null，调用方退回发文字。
 */
export async function synthesizeSpeechSilk(
  text: string,
  settings: VoiceTtsSettings,
): Promise<Buffer | null> {
  const spoken = normalizeSpeakableText(text);
  if (!spoken) return null;

  const audio = await requestWav(spoken, settings);
  if (!audio?.length) return null;

  try {
    const silk = await wavToSilk(audio);
    console.log("[voice] tts ok " + JSON.stringify({
      provider: settings.provider,
      chars: spoken.length,
      silkBytes: silk.length,
    }));
    return silk;
  } catch {
    // 修过长度字段仍然不行 = 真的不是 wav（多半是 mp3/opus）。打头部 magic 出来，省得靠猜。
    const head = audio.subarray(0, 4).toString("latin1").replace(/[^\x20-\x7e]/g, "?");
    console.error(`[voice] tts 返回的不是 wav（头部 "${head}"，${audio.length} 字节），无法转 silk；请把输出格式配成 wav`);
    return null;
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/**
 * 压成适合读出来的一句话（不截断）。
 *
 * 正文里的段标记（`[图片：…]`、`@123`、颜文字）读出来是一串噪音，
 * 所以先把方括号内容、@、以及控制字符去掉。
 */
function cleanSpeakable(raw: string): string {
  return raw
    .replace(/\[[^\]]{0,200}\]/g, " ")
    .replace(/@\S+/g, " ")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** 只剩标点/表情就没有可读内容：读出来只有一个语气词，比不发更怪。 */
function hasReadableText(text: string): boolean {
  return Boolean(text.replace(/[\s\p{P}\p{S}]/gu, ""));
}

/** 真正送去合成的那段话：清洗 + 限长。 */
export function normalizeSpeakableText(raw: string): string {
  const text = cleanSpeakable(raw);
  if (!hasReadableText(text)) return "";
  return text.slice(0, VOICE_TEXT_MAX_CHARS);
}

/** 一条语音在 OneBot 事件里的样子。`url` 带 rkey 且有时效，只在收到消息的当口可用。 */
export type ChannelVoiceRef = {
  /** 直链；网关没给就是空字符串。 */
  url: string;
  /** 网关给的文件名 —— 只是文件名，不是本地路径。 */
  file?: string;
  /** 网关给的时长（秒）；没有就按字节数估。 */
  durationSec?: number;
};

/**
 * 下载一条语音。白名单与图片共用（`image-understanding` 里那两个函数），
 * 不另写一套 —— 两套白名单迟早会有一套漏掉某个私网段。
 */
export async function downloadVoice(rawUrl: string): Promise<Buffer> {
  const url = assertFetchableImageUrl(rawUrl);
  await assertPublicHost(url.hostname);

  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch {
    throw new Error("VOICE_DOWNLOAD_FAILED");
  }
  if (!response.ok) throw new Error("VOICE_HTTP_" + response.status);

  // 重定向后可能换了 host，最终地址要再过一遍。
  try {
    await assertPublicHost(new URL(response.url).hostname);
  } catch {
    throw new Error("VOICE_BLOCKED_HOST");
  }

  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_VOICE_BYTES) throw new Error("VOICE_TOO_LARGE");

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_VOICE_BYTES) throw new Error("VOICE_TOO_LARGE");
  if (!buffer.length) throw new Error("VOICE_EMPTY");
  return buffer;
}

/**
 * 转写一条语音。失败返回 null —— 调用方把 `[语音]` 原样留着。
 *
 * 先转 wav 再上传：silk 不在任何 ASR 服务商的 accepted 格式里，
 * `silkToWav` 同时兜住「网关给的已经是 wav」这种情况。
 */
async function transcribeOne(
  ref: ChannelVoiceRef,
  settings: VoiceAsrSettings,
): Promise<string | null> {
  if (!ref.url) return null;
  if (typeof ref.durationSec === "number" && ref.durationSec * 1000 > MAX_VOICE_DURATION_MS) return null;

  let endpoint: URL;
  try {
    endpoint = buildTranscriptionEndpoint(settings.apiBaseUrl);
  } catch {
    return null;
  }

  let wav: Buffer;
  try {
    wav = await silkToWav(await downloadVoice(ref.url));
  } catch {
    return null;
  }

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "voice.wav");
  form.append("model", settings.model);
  if (settings.language) form.append("language", settings.language);

  let payload: unknown;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: { authorization: "Bearer " + settings.apiKey },
      body: form,
      signal: AbortSignal.timeout(ASR_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.error("[voice] asr 失败：HTTP " + response.status + " " + (await safeText(response)).slice(0, 200));
      return null;
    }
    payload = await response.json();
  } catch (error) {
    console.error("[voice] asr 请求异常：", error instanceof Error ? error.message : String(error));
    return null;
  }

  // OpenAI 是 `{text}`；少数兼容服务给 `{result}`。
  const record = asRecord(payload);
  const text = readString(record.text) || readString(record.result);
  return sanitizeTranscript(text);
}

/** 转写结果会原样进提示词：压成一行、限长，别让一句口误把整轮排版搅乱。 */
export function sanitizeTranscript(raw: string): string | null {
  const text = raw
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 400)
    .trim();
  return text || null;
}

/** 依次转写这一轮里的语音。并发跑：串行会让群聊那一轮拖到十几秒。 */
export async function transcribeVoices(
  refs: ChannelVoiceRef[],
  settings: VoiceAsrSettings,
): Promise<Array<string | null>> {
  const targets = refs.slice(0, MAX_VOICES_PER_TURN);
  if (!targets.length) return [];
  const settled = await Promise.allSettled(targets.map((ref) => transcribeOne(ref, settings)));
  return settled.map((item) => (item.status === "fulfilled" ? item.value : null));
}

/**
 * 把转写填回正文里的 `[语音]` 占位符。
 *
 * 用游标而不是从头 indexOf：转写文本里本身可能带 `[语音]` 这几个字时，
 * 从头找会反复替换同一段，最后得到嵌套括号。
 */
export function applyVoiceTranscripts(content: string, transcripts: Array<string | null>): string {
  if (!transcripts.length || !content.includes("[语音]")) return content;
  let text = content;
  let cursor = 0;
  for (const transcript of transcripts) {
    const value = transcript?.trim();
    if (!value) continue;
    const index = text.indexOf("[语音]", cursor);
    if (index < 0) break;
    const replacement = `[语音：${value}]`;
    text = text.slice(0, index) + replacement + text.slice(index + "[语音]".length);
    cursor = index + replacement.length;
  }
  return text;
}

/**
 * 这句话是不是在让她「发语音」。
 *
 * 为什么要认这个：TTS 合成实测要 16-21 秒（硅基流动 CosyVoice2 的排队开销，与文本长度无关），
 * **随机触发一条语音就等于随机让一条回复迟到十几秒**。所以默认不走概率，
 * 而是等用户明确开口要 —— 他会愿意等，没要的时候她照常打字。
 *
 * 判定要窄：只有「发/来/用/录 + 语音/声音」这类明确搭配才算，
 * 并且先排除「别发语音」这种否定句（否则越不让她发，她越要发）。
 */
export function isVoiceRequested(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  if (!compact) return false;
  if (/(别|不要|不用|不许|不准|不想听)[^，。！？]{0,4}(语音|声音)/.test(compact)) return false;
  return /(发|来|给|用|整|录|说)[^，。！？]{0,4}(语音|声音|条)/.test(compact)
    // 「语音条呢」「语音？听听」：没有动词但句尾在催。只认句尾，避免「这语音条音质不错」被当成要求。
    || /(语音|声音)(条)?[呢吧呗啊嘛]?[？?！!。]*$/.test(compact)
    || /(语音|声音)(说|回|发)/.test(compact)
    || /说(一)?句话/.test(compact);
}

/** 这段话能不能读出来：有可读内容，且长度在限度内（超长不截断，直接不读）。 */
export function canSpeakReply(text: string): boolean {
  const cleaned = cleanSpeakable(text);
  if (!hasReadableText(cleaned)) return false;
  return cleaned.length <= VOICE_TEXT_MAX_CHARS;
}

/**
 * 这一轮打不打算发语音 —— **在生成回复之前调用**。
 *
 * 分成两步是因为顺序很关键：必须先决定「这轮要说语音」，再生成内容，
 * 模型才知道要按说话的方式写（短句、口语、不带表情和括号动作）。
 * 反过来「先生成再判定」的话，模型以为自己只是在打字 ——
 * 实测她会写出「我这打字声你当语音听吧」这种话，因为提示词里压根没提语音。
 *
 * 这里不看回复内容（还不知道），只看开关、冷却与概率；长度在生成后用 `canSpeakReply` 复核。
 */
export function planVoiceReply(input: {
  modelConfig: unknown;
  lastVoiceAt?: Date | null;
  now?: Date;
  random?: () => number;
  /** 用户在消息里明确要语音：跳过概率与冷却（但不跳过开关）。 */
  force?: boolean;
}): boolean {
  if (!isVoiceReplyEnabled(input.modelConfig)) return false;
  if (input.force === true) return true;

  const now = input.now ?? new Date();
  const lastVoiceAt = input.lastVoiceAt ?? null;
  if (lastVoiceAt && now.getTime() - lastVoiceAt.getTime() < VOICE_COOLDOWN_MS) return false;

  const chance = resolveVoiceChance(input.modelConfig);
  if (chance <= 0) return false;
  const random = input.random ?? Math.random;
  return random() * 100 < chance;
}

/**
 * 生成之后复核：这一段真的能发成语音吗。
 *
 * `shouldSendVoice` 是「计划 + 复核」的合并版，保留给只想知道结果、不需要提前告诉模型的场景。
 */
export function shouldSendVoice(input: {
  modelConfig: unknown;
  text: string;
  lastVoiceAt?: Date | null;
  now?: Date;
  random?: () => number;
  force?: boolean;
}): boolean {
  if (!planVoiceReply(input)) return false;
  return canSpeakReply(input.text);
}
