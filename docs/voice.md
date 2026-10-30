# QQ 语音：她说话，与听懂别人说话

两个方向，两条独立链路，各自一个角色级开关（默认都关）：

| 方向 | 走的路 | 开关 |
| --- | --- | --- |
| 她发语音条 | 回复文字 → TTS → wav → **silk** → OneBot `record` 段 | `modelConfig.voiceEnabled` |
| 她听懂语音 | `record` 段直链 → 下载 → silk → wav → ASR → 文字进提示词 | `modelConfig.voiceTranscribe` |

页面上在「系统管理 → QQ 渠道 → 角色行为 → 语音」。

## 为什么必须转 silk

QQ 客户端只认 Tencent silk。网关把 `record` 段的 `file` 交给 QQ 之前不会替你转码，
所以喂 mp3/wav 的结果是一条打不开的语音。转码用 `silk-wasm`（纯 wasm，无需 ffmpeg）：

- 出站：TTS 直接要 `wav`（`response_format: "wav"`）→ `silk-wasm.encode`
- 入站：`silk-wasm.decode` → 补 44 字节 wav 头 → multipart 交给 ASR

**没有 mp3 解码器，这是有意的。** 服务商不支持 wav 时这条链路就是不工作，
日志里有 `[voice] tts 返回的不是 wav`，比多加一个解码依赖去兜底更省事。

## 配置

语音要**单独一家**服务商。这不是设计偏好，是现实：`LLM_BASE_URL` 指向 DeepSeek 时，
`/audio/speech` 直接 404 —— DeepSeek、通义这类纯文本服务商没有语音接口。
所以「留空就沿用聊天配置」这条捷径只对 OpenAI 官方或支持 audio 的中转站成立。

### 在页面上配（推荐）

「系统管理 → QQ 渠道 → 角色行为 → 语音」，五个输入框：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| 语音服务的 Key | — | 必填。硅基流动后台 `cloud.siliconflow.cn/account/ak` 拿 `sk-` 开头的 |
| 服务地址 | `https://api.siliconflow.cn/v1` | TTS 与 ASR 共用 |
| 合成模型 | `FunAudioLLM/CosyVoice2-0.5B` | |
| 音色 | `FunAudioLLM/CosyVoice2-0.5B:claire` | 要带模型前缀 |
| 识别模型 | `FunAudioLLM/SenseVoiceSmall` | |

Key 加密后存进角色 `modelConfig.voiceApiKeyEncrypted`（与聊天 Key 分开两把），
只回显「已保存」，页面拿不回明文。换服务商时改这几项即可，不用碰 `.env`。

女声：`claire` 温柔 / `anna` 沉稳 / `bella` 热情 / `diana` 活泼；男声：`alex` / `benjamin` / `charles` / `david`。

### 在 `.env` 里配（服务级默认值）

页面留空时才会用到，适合「所有角色共用一家」。见 `.env.example`：

```
VOICE_TTS_MODEL=FunAudioLLM/CosyVoice2-0.5B
VOICE_TTS_BASE_URL=https://api.siliconflow.cn/v1
VOICE_TTS_API_KEY=
VOICE_TTS_VOICE=FunAudioLLM/CosyVoice2-0.5B:claire
VOICE_TTS_SPEED=1
VOICE_TTS_SAMPLE_RATE=24000   # OpenAI 官方不认这个字段，换官方时删掉

VOICE_ASR_MODEL=FunAudioLLM/SenseVoiceSmall
VOICE_ASR_BASE_URL=https://api.siliconflow.cn/v1
VOICE_ASR_API_KEY=
VOICE_ASR_LANGUAGE=           # 留空 = 服务商自己判断（SenseVoice 不认这个字段）
```

优先顺序：**页面 > 环境变量 > 角色的聊天地址与 Key**。
最后那条只是「同一家服务商」时的便利；显式配了 `VOICE_*_BASE_URL` 却写错时**不会**回落，
否则会让人以为语音走的是独立服务，实际却打到了聊天服务商，出错时日志里一句解释都没有。

`VOICE_TTS_SAMPLE_RATE` 建议保持 24000 —— 转 silk 只用 24k，服务商默认 44100 等于白扛一倍体积。

### 验证

`npx tsx scripts/probe-voice.ts --character <角色 id>`：读页面/环境里的配置真合成一次，
成功会写出 `.data/voice-probe.wav` 可直接试听。失败会分别说明是「配置不齐」还是
「服务商没给 wav」，不必去猜。

## 判定：什么时候她真的发语音

`isVoiceRequested()` + `shouldSendVoice()`，两个纯函数。

**主入口是「有人明确要她发语音」**：消息里出现「发个语音」「来一段语音」「用语音说」「语音条呢」「说句话」这类说法时，
跳过概率与冷却直接发（仍然受 60 字上限约束，「别发语音」这类否定句不算）。

**随机触发默认是 0**，原因见下面「代价」：硅基流动的 CosyVoice2 单次合成实测 16-21 秒，
随机把一条回复变成语音 = 随机让一条回复静默迟到。这是服务商侧的排队开销，与文本长度、采样率都无关
（wav/pcm/mp3、带不带 sample_rate 都测过）。想要她偶尔自己发，把「她自己随机发语音」调高即可 ——
先确认你的服务商够快。

另外三个硬条件始终生效：开关开着、清洗掉段标记后有可读内容（纯标点 / 纯表情不发）、长度 ≤ 60 字
（超长**不发**，而不是截一段读 —— 截断的话术在语音条里听起来像被掐断）。

语音条**替代**正文，不会「发语音 + 再补一条文字」。合成失败则原样发文字：
语音是锦上添花，不能成为整轮沉默的原因。

## 代价

- **合成慢**：硅基流动 CosyVoice2 实测 16-21 秒/次（2026-10-30，同一网络下 `/v1/models` 只要 0.7 秒，
  所以不是网络问题）。这一轮会等它合成完才发出，群里看起来就是「她愣了一会儿才说话」。
  超时阈值 45 秒；超时按失败处理，退回文字。
- **服务商返回的 wav 头是坏的**：RIFF / data 的长度字段是负值（`0xFFFFFFA6` / `0xFFFFFF00`），
  文件本身能播，但 `silk-wasm` 的 `isWav` 会判成「不是 wav」。`repairWavSizes()` 按实际文件长度重算，
  **不要删掉它** —— 删了就是「合成成功但一条语音也发不出去」，而且日志只会说「不是 wav」。
- TTS 按字符计费、ASR 按秒计费，**都不进 `model_usages`** ——
  那是一张 token 结算表，塞进去会污染「未定价 token」统计和金额报表。
  只有 `[voice]` 日志行，按天自己估。
- 一轮最多转写 2 条语音，单条不超过 60 秒（`MAX_VOICE_DURATION_MS`）。
- 单条下载上限 6MB，下载地址过与图片同一套公网白名单（`image-understanding.ts`）。

## 已知边界

- **语音里的名字不被闸门看见**：群里有人发语音喊她名字，群聊闸门看到的是 `[语音]`，
  关键词匹配不到。@ 她仍然有效，`ambient` 档抽中后也会进 pipeline 转写。
  这是「先过闸门再花钱」换来的取舍：不能对每条群语音都跑一次 ASR。
- 采样率固定按 24kHz 解码（QQ 移动端默认值）。16k 的老语音会略微变调，
  仍能识别，但不如原生清晰。
- `record` 段用 `base64://` 传，与表情包同理是为跨机部署；若某个网关不认 base64，
  改 `toOnebotVoiceSegments` 一处即可。

## 回归测试

`yarn test:voice`（已进 `verify:local`）：段解析、silk 编解码往返、占位符回填、
发语音判定、配置解析与 DTO 透传。不联网 —— 真实 TTS/ASR 需要服务商凭据。
