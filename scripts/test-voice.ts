/**
 * 语音（TTS / ASR）链路的纯逻辑测试：段解析、silk 编解码、占位符回填、
 * 发语音判定、配置解析。
 *
 * 都不联网：真正调用 TTS / ASR 需要服务商凭据，不适合放进每次 verify:local。
 * silk 编解码是真的跑（wasm 在本地），因为「转码能不能用」正是这条链路最脆的地方。
 */

import assert from "node:assert/strict";

import {
  applyVoiceTranscripts,
  buildWav,
  isVoiceReplyEnabled,
  isVoiceRequested,
  isVoiceTranscribeEnabled,
  MAX_VOICES_PER_TURN,
  normalizeSpeakableText,
  repairWavSizes,
  resolveVoiceAsrSettings,
  resolveVoiceChance,
  resolveVoiceTtsSettings,
  sanitizeTranscript,
  shouldSendVoice,
  silkToWav,
  VOICE_COOLDOWN_MS,
  VOICE_TEXT_MAX_CHARS,
  wavToSilk,
} from "../server/utils/voice";
import { readOnebotVoices } from "../server/utils/channel-adapter/onebot/types";
import { toCharacterDto } from "../server/utils/character-dto";
import {
  encryptApiKey,
  isVoiceApiKeySaved,
  resolveCharacterVoiceApiKey,
} from "../server/utils/credential-encryption";

// ── 1. 从段数组里取语音 ─────────────────────────────────
const voices = readOnebotVoices({
  message: [
    { type: "text", data: { text: "听我说" } },
    { type: "record", data: { url: "https://multimedia.nt.qq.com.cn/v?rkey=1", file: "a.amr", duration: 7 } },
    { type: "voice", data: { file: "b.silk", duration: 5200 } },
    { type: "record", data: { file: "c.amr" } },
  ],
});
assert.equal(voices.length, 3, "record 与 voice 段都算语音。");
assert.equal(voices[0]!.url, "https://multimedia.nt.qq.com.cn/v?rkey=1");
assert.equal(voices[0]!.durationSec, 7, "duration 是秒时按秒用。");
assert.equal(voices[1]!.url, "", "没有 url 时留空，不能拿 file 当路径去读。");
assert.equal(voices[1]!.durationSec, 5.2, "大于 1000 的 duration 按毫秒换算。");
assert.equal(voices[2]!.durationSec, -1, "网关没给时长记 -1。");

assert.deepEqual(readOnebotVoices({ message: "你好" }), []);
assert.deepEqual(readOnebotVoices({}), []);

// ── 2. 可读文本归一化 ──────────────────────────────────
assert.equal(normalizeSpeakableText("今天好累啊"), "今天好累啊");
assert.equal(normalizeSpeakableText("嗯[图片：一只猫]就这样"), "嗯 就这样", "段标记读出来是噪音。");
assert.equal(normalizeSpeakableText("@12345 在吗"), "在吗");
assert.equal(normalizeSpeakableText("……"), "", "只剩标点就不读了。");
assert.equal(normalizeSpeakableText("😀😀"), "", "纯表情没有可读内容。");
assert.equal(normalizeSpeakableText("啊".repeat(200)).length, VOICE_TEXT_MAX_CHARS, "超长截断。");

// ── 3. wav 头 ─────────────────────────────────────────
const pcm = Buffer.alloc(480, 0);
const wav = buildWav(pcm, 24000);
assert.equal(wav.length, 44 + 480);
assert.equal(wav.subarray(0, 4).toString(), "RIFF");
assert.equal(wav.subarray(8, 12).toString(), "WAVE");
assert.equal(wav.readUInt32LE(24), 24000, "采样率写在头里。");
assert.equal(wav.readUInt32LE(40), 480, "data 长度写在头里。");

// ── 4. silk 编解码（真跑 wasm）──────────────────────────
const silk = await wavToSilk(wav);
assert.ok(silk.length > 0, "wav 能编成 silk。");
const back = await silkToWav(silk);
assert.equal(back.subarray(0, 4).toString(), "RIFF", "silk 解回来是完整 wav。");
assert.ok(back.length > 44);

// 已经是 wav 的直链（有的网关转存成 wav）原样返回，不再解码。
assert.equal(await silkToWav(wav), wav);

// 喂一段垃圾进去必须报错，而不是产出一个坏文件发给 QQ。
await assert.rejects(() => wavToSilk(Buffer.from("not a wav")), /VOICE_NOT_WAV/);
await assert.rejects(() => silkToWav(Buffer.from("not a silk")), /VOICE_NOT_SILK/);

// 服务商返回的 wav 头里长度字段是坏的（硅基流动实测 0xFFFFFFA6 / 0xFFFFFF00）：
// 格式字段都是对的，只是长度写成负值。这种必须能救回来，否则「合成了但发不出去」。
{
  const broken = Buffer.from(wav);
  broken.writeUInt32LE(0xffffffa6, 4);
  broken.writeUInt32LE(0xffffff00, 40);
  const repaired = repairWavSizes(broken);
  assert.equal(repaired.readUInt32LE(4), repaired.length - 8, "RIFF 长度按实际文件重算。");
  assert.equal(repaired.readUInt32LE(40), repaired.length - 44, "data 长度按实际文件重算。");
  assert.ok((await wavToSilk(broken)).length > 0, "坏头 wav 也能编成 silk。");

  // fmt/data 之外还夹了 LIST chunk 时也要能找到 data（服务商常塞元数据）。
  const withList = Buffer.concat([
    wav.subarray(0, 36),
    Buffer.from("LIST"), Buffer.from([0x04, 0x00, 0x00, 0x00]), Buffer.from("INFO"),
    wav.subarray(36),
  ]);
  withList.writeUInt32LE(0, 4);
  const repairedList = repairWavSizes(withList);
  assert.ok((await wavToSilk(repairedList)).length > 0, "带 LIST chunk 的 wav 也能用。");
}

// ── 5. 转写回填 ────────────────────────────────────────
assert.equal(applyVoiceTranscripts("早上好", []), "早上好");
assert.equal(applyVoiceTranscripts("听听[语音]", ["我今天不去"]), "听听[语音：我今天不去]");
assert.equal(
  applyVoiceTranscripts("[语音]和[语音]", ["第一句", "第二句"]),
  "[语音：第一句]和[语音：第二句]",
  "多条各回各的位置。",
);
assert.equal(applyVoiceTranscripts("[语音]", [null]), "[语音]", "转写失败原样保留。");
// 转写文本里带 `[语音]` 时不能反复替换同一段。
assert.equal(applyVoiceTranscripts("[语音]好", ["他说[语音]"]), "[语音：他说[语音]]好");

assert.equal(sanitizeTranscript("  嗯\n\n就是这样  "), "嗯 就是这样");
assert.equal(sanitizeTranscript("   "), null);

// ── 6. 开关与概率 ──────────────────────────────────────
assert.equal(isVoiceReplyEnabled({}), false, "默认不发语音。");
assert.equal(isVoiceReplyEnabled({ voiceEnabled: true }), true);
assert.equal(isVoiceTranscribeEnabled({}), false, "默认不转写语音。");
assert.equal(isVoiceTranscribeEnabled({ voiceTranscribe: true }), true);
assert.equal(resolveVoiceChance({}), 0, "默认 0：合成太慢，不随机发。");
assert.equal(resolveVoiceChance({ voiceChance: 80 }), 80);
assert.equal(resolveVoiceChance({ voiceChance: 999 }), 100, "越界夹到 100。");
assert.equal(resolveVoiceChance({ voiceChance: -5 }), 0);

// ── 7. 要不要发语音 ────────────────────────────────────
const on = { voiceEnabled: true, voiceChance: 100 };
assert.equal(
  shouldSendVoice({ modelConfig: on, text: "在的", random: () => 0 }),
  true,
  "开关开、概率 100、冷却已过 → 发。",
);
assert.equal(
  shouldSendVoice({ modelConfig: { voiceChance: 100 }, text: "在的", random: () => 0 }),
  false,
  "开关关着就不发，概率不起作用。",
);
assert.equal(
  shouldSendVoice({ modelConfig: on, text: "啊".repeat(VOICE_TEXT_MAX_CHARS + 1), random: () => 0 }),
  false,
  "超长回复发语音=让人干等，宁可发文字。",
);
assert.equal(
  shouldSendVoice({ modelConfig: on, text: "……", random: () => 0 }),
  false,
  "没有可读内容不发。",
);
assert.equal(
  shouldSendVoice({
    modelConfig: on,
    text: "在的",
    lastVoiceAt: new Date(Date.now() - VOICE_COOLDOWN_MS / 2),
    random: () => 0,
  }),
  false,
  "冷却期内不连发。",
);
assert.equal(
  shouldSendVoice({
    modelConfig: on,
    text: "在的",
    lastVoiceAt: new Date(Date.now() - VOICE_COOLDOWN_MS - 1000),
    random: () => 0,
  }),
  true,
  "冷却过了可以再发。",
);
assert.equal(
  shouldSendVoice({ modelConfig: on, text: "在的", random: () => 0.999 }),
  true,
  "概率 100 时任何随机值都命中。",
);
assert.equal(
  shouldSendVoice({ modelConfig: { voiceEnabled: true, voiceChance: 0 }, text: "在的", random: () => 0 }),
  false,
  "概率 0 永不发语音。",
);

// 概率 50：random 0.4 命中、0.6 不命中。
assert.equal(shouldSendVoice({ modelConfig: { voiceEnabled: true, voiceChance: 50 }, text: "在的", random: () => 0.4 }), true);
assert.equal(shouldSendVoice({ modelConfig: { voiceEnabled: true, voiceChance: 50 }, text: "在的", random: () => 0.6 }), false);

// ── 7.1 用户明确要语音 ─────────────────────────────────
// 合成要十几秒，所以默认概率是 0；「发个语音」这条路径才是日常真正的入口。
for (const text of ["发个语音", "发条语音呗", "用语音说", "语音条呢", "给我说句话吧", "来一段语音"]) {
  assert.equal(isVoiceRequested(text), true, `应识别为要语音：${text}`);
}
for (const text of ["别发语音", "不要用语音", "语音没有，我只有打字", "这语音条音质不错", "在吗"]) {
  assert.equal(isVoiceRequested(text), false, `不该识别为要语音：${text}`);
}

// 明确要求时跳过概率与冷却，但**不**跳过开关和长度。
assert.equal(
  shouldSendVoice({ modelConfig: { voiceEnabled: true, voiceChance: 0 }, text: "在的", force: true, random: () => 0.99 }),
  true,
  "概率 0 也要发：他要的。",
);
assert.equal(
  shouldSendVoice({
    modelConfig: { voiceEnabled: true, voiceChance: 0 },
    text: "在的",
    force: true,
    lastVoiceAt: new Date(),
  }),
  true,
  "冷却期内被点名也要发。",
);
assert.equal(
  shouldSendVoice({ modelConfig: { voiceChance: 0 }, text: "在的", force: true }),
  false,
  "开关没开就不发，force 不能绕过开关。",
);
assert.equal(
  shouldSendVoice({ modelConfig: { voiceEnabled: true, voiceChance: 0 }, text: "啊".repeat(200), force: true }),
  false,
  "超长也不发，force 不能让人干等 20 秒。",
);

// 一轮最多转几条。
assert.equal(MAX_VOICES_PER_TURN, 2);

// ── 8. 配置解析 ────────────────────────────────────────
const VOICE_ENV_KEYS = [
  "VOICE_TTS_MODEL", "VOICE_TTS_BASE_URL", "VOICE_TTS_API_KEY", "VOICE_TTS_VOICE", "VOICE_TTS_SPEED",
  "VOICE_ASR_MODEL", "VOICE_ASR_BASE_URL", "VOICE_ASR_API_KEY", "VOICE_ASR_LANGUAGE",
] as const;
const savedEnv = new Map<string, string | undefined>(VOICE_ENV_KEYS.map((key) => [key, process.env[key]]));
const clearVoiceEnv = () => {
  for (const key of VOICE_ENV_KEYS) delete process.env[key];
};

try {
  clearVoiceEnv();
  assert.equal(resolveVoiceTtsSettings({}), null, "没配模型就不发语音（默认状态）。");
  assert.equal(resolveVoiceAsrSettings({}), null);

  // 页面上填的那一套优先于环境变量：换服务商不该逼人去改 .env。
  const fromPage = resolveVoiceTtsSettings({
    modelConfig: {
      voiceApiBaseUrl: "https://api.siliconflow.cn/v1",
      ttsModel: "FunAudioLLM/CosyVoice2-0.5B",
      ttsVoice: "FunAudioLLM/CosyVoice2-0.5B:claire",
    },
    chatApiBaseUrl: "https://api.deepseek.com/v1",
    chatApiKey: "sk-chat",
    voiceApiKey: "sk-voice",
  });
  assert.ok(fromPage, "页面上填齐了就该能用，不必先配 .env。");
  assert.equal(fromPage!.apiBaseUrl, "https://api.siliconflow.cn/v1", "语音地址独立于聊天地址。");
  assert.equal(fromPage!.apiKey, "sk-voice", "语音 Key 与聊天 Key 是两把。");
  assert.equal(fromPage!.voice, "FunAudioLLM/CosyVoice2-0.5B:claire");

  const asrFromPage = resolveVoiceAsrSettings({
    modelConfig: { voiceApiBaseUrl: "https://api.siliconflow.cn/v1", asrModel: "FunAudioLLM/SenseVoiceSmall" },
    chatApiBaseUrl: "https://api.deepseek.com/v1",
    chatApiKey: "sk-chat",
    voiceApiKey: "sk-voice",
  });
  assert.ok(asrFromPage);
  assert.equal(asrFromPage!.apiKey, "sk-voice");
  assert.equal(asrFromPage!.model, "FunAudioLLM/SenseVoiceSmall");

  // 只配模型 + 走角色自己的聊天地址与 key：OpenAI 官方这类「同一份凭据」的场景。
  process.env.VOICE_TTS_MODEL = "tts-1";
  process.env.VOICE_ASR_MODEL = "whisper-1";
  const chatInput = { chatApiBaseUrl: "https://api.openai.com/v1", chatApiKey: "sk-test" };
  const tts = resolveVoiceTtsSettings(chatInput);
  assert.ok(tts);
  assert.equal(tts!.model, "tts-1");
  assert.equal(tts!.apiBaseUrl, "https://api.openai.com/v1");
  assert.equal(tts!.voice, "alloy", "没指定音色用默认值。");
  assert.equal(tts!.speed, 1);

  const asr = resolveVoiceAsrSettings(chatInput);
  assert.ok(asr);
  assert.equal(asr!.model, "whisper-1");
  assert.equal(asr!.language, "", "没配语言就交给服务商自己判断。");

  // 角色级覆盖环境变量。
  const overridden = resolveVoiceTtsSettings({
    modelConfig: { ttsModel: "gpt-4o-mini-tts", ttsVoice: "shimmer" },
    ...chatInput,
  });
  assert.equal(overridden!.model, "gpt-4o-mini-tts");
  assert.equal(overridden!.voice, "shimmer");

  // 独立端点优先于聊天端点。
  process.env.VOICE_TTS_BASE_URL = "https://tts.example.com/v1";
  process.env.VOICE_TTS_API_KEY = "tts-key";
  const separate = resolveVoiceTtsSettings(chatInput);
  assert.equal(separate!.apiBaseUrl, "https://tts.example.com/v1");
  assert.equal(separate!.apiKey, "tts-key");

  // 地址写错当没配，不能让整轮聊天失败。
  process.env.VOICE_TTS_BASE_URL = "not-a-url";
  assert.equal(resolveVoiceTtsSettings(chatInput), null);

  // 没有 key 就发不出去，当作没配。
  delete process.env.VOICE_TTS_BASE_URL;
  delete process.env.VOICE_TTS_API_KEY;
  assert.equal(resolveVoiceTtsSettings({ chatApiBaseUrl: "https://api.openai.com/v1" }), null);
} finally {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// ── 9. DTO 透传 ────────────────────────────────────────
const dto = toCharacterDto({
  id: "c1",
  name: "测试",
  avatar: null,
  basePrompt: "",
  styleExamples: "",
  userAddress: "",
  status: "ACTIVE",
  modelConfig: { voiceEnabled: true, voiceTranscribe: true, voiceChance: 60 },
  updatedAt: new Date(),
  memorySetting: null,
  channelBindings: [],
  memoryScopes: [],
} as never);
assert.equal(dto.voiceEnabled, true);
assert.equal(dto.voiceTranscribe, true);
assert.equal(dto.voiceChance, 60);

const dtoDefault = toCharacterDto({
  id: "c2",
  name: "默认",
  avatar: null,
  basePrompt: "",
  styleExamples: "",
  userAddress: "",
  status: "ACTIVE",
  modelConfig: {},
  updatedAt: new Date(),
  memorySetting: null,
  channelBindings: [],
  memoryScopes: [],
} as never);
assert.equal(dtoDefault.voiceEnabled, false);
assert.equal(dtoDefault.voiceTranscribe, false);
assert.equal(dtoDefault.voiceChance, 0);

// ── 10. 页面填的 Key：加密存、解密用 ───────────────────
// 这一段会读写 .data/credentials-encryption.key（本机已有的那把密钥），
// 不碰数据库、不联网：验证的是「存进去的是一坨密文，取出来还能用」。
{
  const encrypted = await encryptApiKey("sk-voice-from-page");
  assert.ok(encrypted.startsWith("v1."), "落库的是加密串，不是明文。");
  assert.ok(!encrypted.includes("sk-voice-from-page"), "密文里不能出现明文片段。");

  const config = {
    voiceApiKeyEncrypted: encrypted,
    voiceApiBaseUrl: "https://api.siliconflow.cn/v1",
    ttsModel: "FunAudioLLM/CosyVoice2-0.5B",
  };
  assert.equal(isVoiceApiKeySaved(config), true);
  assert.equal(isVoiceApiKeySaved({}), false);

  const decrypted = await resolveCharacterVoiceApiKey(config);
  assert.equal(decrypted, "sk-voice-from-page", "解密后能直接用。");

  // 解密出来的 Key 必须压过聊天 Key —— 否则「语音另一家服务商」这件事就不成立。
  const resolved = resolveVoiceTtsSettings({
    modelConfig: config,
    chatApiBaseUrl: "https://api.deepseek.com/v1",
    chatApiKey: "sk-chat-key",
    voiceApiKey: decrypted,
  });
  assert.equal(resolved!.apiKey, "sk-voice-from-page");
  assert.equal(resolved!.apiBaseUrl, "https://api.siliconflow.cn/v1");

  // 没存过 Key 时是空字符串，不是抛错。
  assert.equal(await resolveCharacterVoiceApiKey({}), "");
}

console.log("test:voice —— 全部通过");