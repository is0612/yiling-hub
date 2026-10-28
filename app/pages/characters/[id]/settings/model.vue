<script setup lang="ts">
import { Connection, Cpu, InfoFilled, Promotion, Refresh, Select } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import type { Character } from "~/utils/mock-data";
import { MODEL_PROVIDERS, buildModelOptions, providerByBaseUrl, providerByKey } from "~/utils/model-catalog";

/**
 * 模型设置：从「角色设置」弹窗里搬出来的。
 * 弹窗要装 9 个字段 + 6 段说明，在 1440×900 的笔记本上一屏放不下，
 * 而 el-dialog 是整层遮罩滚动 —— 打开后连保存按钮都看不到。这里跟「记忆设置」同形态。
 */
const route = useRoute();
const id = computed(() => String(route.params.id || ""));

const character = ref<Character | null>(null);
const loading = ref(true);
const saving = ref(false);
const testing = ref(false);
const fetchingModels = ref(false);

const draftChatModel = ref("");
const draftChatTemperature = ref(0.7);
const draftChatMaxTokens = ref(1800);
const draftChatApiBaseUrl = ref("https://api.deepseek.com");
const draftChatApiKey = ref("");
const clearSavedApiKey = ref(false);
const draftProviderKey = ref("deepseek");
const draftDailyTokenLimit = ref(0);
const draftMemoryTokenBudget = ref(1200);
const draftSnapshotTokenBudget = ref(2000);
const draftEmojiEnabled = ref(false);
/** 本页「获取模型」拉回来的列表；换地址就作废 */
const fetchedModels = ref<string[]>([]);

type ProactiveSettings = NonNullable<Character["proactive"]>;

const PROACTIVE_FALLBACK: ProactiveSettings = {
  enabled: false,
  dailyMax: 2,
  minGapMinutes: 180,
  quietStart: "23:00",
  quietEnd: "08:00",
  userActiveMinutes: 30,
  minConfidence: 0.4,
};
const draftProactive = ref<ProactiveSettings>({ ...PROACTIVE_FALLBACK });

type ProactiveSnapshot = {
  settings: ProactiveSettings;
  status: {
    sentToday: number;
    pendingCount: number;
    recipient: string | null;
    lastSentAt: string | null;
    gapRemainingMinutes: number;
    quietNow: boolean;
    quotaExceeded: boolean;
    canSendNow: boolean;
    reason: string;
    reasonLabel: string;
  };
  recent: Array<{
    id: string;
    kind: string;
    goal: string;
    status: string;
    content: string | null;
    confidence: number;
    sentAt: string | null;
  }>;
};
const proactiveSnapshot = ref<ProactiveSnapshot | null>(null);
const tryingProactive = ref(false);

const PROACTIVE_KIND_LABELS: Record<string, string> = {
  SHARE: "分享",
  ASK: "想问",
  INVITE: "邀约",
  CONFIDE: "心里话",
  CURIOUS: "好奇",
  FOLLOWUP: "追问",
};

const PROACTIVE_STATUS_LABELS: Record<string, string> = {
  PENDING: "待说",
  SENT: "已发",
  SKIPPED: "略过",
  EXPIRED: "过期",
};

async function loadProactive() {
  if (!id.value) return;
  try {
    proactiveSnapshot.value = await $fetch<ProactiveSnapshot>(
      `/api/characters/${encodeURIComponent(id.value)}/proactive`,
    );
  } catch {
    // 状态读不到不影响改设置，静默即可。
    proactiveSnapshot.value = null;
  }
}

type DailyUsage = {
  day: string;
  usage: { totalTokens: number; promptTokens: number; completionTokens: number; calls: number; byKind: Record<string, { totalTokens: number; calls: number }> };
  quota: { limit: number; used: number; remaining: number; exceeded: boolean };
};
const dailyUsage = ref<DailyUsage | null>(null);

const KIND_LABELS: Record<string, string> = {
  chat: "AI 对话",
  channel: "QQ 回复",
  snapshot: "阶段总结",
  "bili-screening": "值班粗筛",
  "bili-judge": "值班终判",
  proactive: "主动找话",
  other: "其他",
};

async function loadUsage() {
  if (!id.value) return;
  try {
    dailyUsage.value = await $fetch<DailyUsage>(`/api/characters/${encodeURIComponent(id.value)}/usage`);
  } catch {
    // 看板读不到不影响改设置，静默即可。
    dailyUsage.value = null;
  }
}

/** 三个入口各回各家：对话页、角色管理页、角色记忆页 */
const backTarget = computed(() => {
  if (route.query.from === "chat") return `/chat?c=${id.value}`;
  if (route.query.from === "characters") return "/characters";
  return `/memory?c=${id.value}`;
});
const backLabel = computed(() => {
  if (route.query.from === "chat") return "返回对话";
  if (route.query.from === "characters") return "返回角色管理";
  return "返回角色记忆";
});

const apiKeySource = computed(() => character.value?.chatApiKeySource ?? "missing");
const apiKeyPlaceholder = computed(() => {
  if (apiKeySource.value === "character") return "已加密保存；留空表示保持不变";
  if (apiKeySource.value === "environment") return "当前使用服务端默认 Key；填写可覆盖";
  return "请填写 API Key";
});
const apiKeyHint = computed(() => {
  if (apiKeySource.value === "character") return "此角色已保存 API Key。留空可保持现有 Key，不会在网页中显示原文。";
  if (apiKeySource.value === "environment") return "当前使用服务端默认 Key。输入新 Key 后会为本角色单独保存。";
  return "Key 只提交到本机服务端，使用 AES-256-GCM 加密后保存，不会回传给网页。";
});

const currentProvider = computed(() => providerByKey(draftProviderKey.value));
const providerLabel = computed(() => currentProvider.value?.name ?? "自定义");
const modelOptions = computed(() => buildModelOptions({
  baseUrl: draftChatApiBaseUrl.value,
  current: draftChatModel.value,
  fetched: fetchedModels.value,
}));
const providerHint = computed(() => {
  const preset = currentProvider.value;
  if (!preset || preset.key === "custom") return "没有列出的平台选「自定义」，手填 API 地址和模型名即可。";
  if (!preset.supportsModelList) return preset.name + " 不提供模型列表接口，下面的选项来自内置清单，也可以直接手填。";
  return "已填入 " + preset.name + " 的公开兼容地址；点「获取模型」可拉取该 Key 能用的全部模型。";
});

function readError(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "statusMessage" in error) {
    const message = String((error as { statusMessage?: unknown }).statusMessage ?? "");
    if (message) return message;
  }
  return fallback;
}

function applyProvider(key: string) {
  draftProviderKey.value = key;
  const preset = providerByKey(key);
  if (preset?.baseUrl) draftChatApiBaseUrl.value = preset.baseUrl;
}

/** 地址能反推服务商：直接把地址粘进来时下拉要跟着对上，否则一直停在「自定义」 */
watch(draftChatApiBaseUrl, (value) => {
  const nextKey = providerByBaseUrl(value)?.key ?? "custom";
  if (nextKey === draftProviderKey.value) return;
  draftProviderKey.value = nextKey;
  fetchedModels.value = [];
});

async function loadCharacter() {
  loading.value = true;
  try {
    const data = await $fetch<Character>(`/api/characters/${encodeURIComponent(id.value)}`);
    character.value = data;
    draftChatModel.value = data.chatModel ?? "";
    draftChatTemperature.value = data.chatTemperature ?? 0.7;
    draftChatMaxTokens.value = data.chatMaxTokens ?? 1800;
    draftChatApiBaseUrl.value = data.chatApiBaseUrl || "https://api.deepseek.com/v1";
    draftChatApiKey.value = "";
    clearSavedApiKey.value = false;
    draftDailyTokenLimit.value = data.dailyTokenLimit ?? 0;
    draftMemoryTokenBudget.value = data.memoryTokenBudget ?? 1200;
    draftSnapshotTokenBudget.value = data.snapshotTokenBudget ?? 2000;
    draftEmojiEnabled.value = data.emojiEnabled === true;
    draftProactive.value = { ...PROACTIVE_FALLBACK, ...(data.proactive ?? {}) };
    draftProviderKey.value = providerByBaseUrl(draftChatApiBaseUrl.value)?.key ?? "custom";
    fetchedModels.value = [];
    await Promise.all([loadUsage(), loadProactive()]);
  } catch {
    character.value = null;
    ElMessage.error("加载角色失败，请确认角色仍存在且本地数据库已初始化。");
  } finally {
    loading.value = false;
  }
}

/** silent：测试连接和拉取模型都要先保存，那两步不该再弹一次「已保存」 */
async function save(silent = false): Promise<boolean> {
  if (saving.value || !character.value) return false;
  if (draftChatModel.value.trim().length > 120) {
    ElMessage.warning("模型名称不能超过 120 个字符。");
    return false;
  }
  saving.value = true;
  try {
    const updated = await $fetch<Character>(`/api/characters/${encodeURIComponent(id.value)}`, {
      method: "PATCH",
      body: {
        chatModel: draftChatModel.value.trim(),
        chatTemperature: draftChatTemperature.value,
        chatMaxTokens: draftChatMaxTokens.value,
        chatApiBaseUrl: draftChatApiBaseUrl.value.trim(),
        chatApiKey: draftChatApiKey.value,
        clearApiKey: clearSavedApiKey.value && !draftChatApiKey.value.trim(),
        dailyTokenLimit: draftDailyTokenLimit.value,
        memoryTokenBudget: draftMemoryTokenBudget.value,
        snapshotTokenBudget: draftSnapshotTokenBudget.value,
        emojiEnabled: draftEmojiEnabled.value,
        proactive: { ...draftProactive.value },
      },
    });
    character.value = updated;
    draftChatApiKey.value = "";
    clearSavedApiKey.value = false;
    if (!silent) ElMessage.success("模型设置已保存。");
    await Promise.all([loadUsage(), loadProactive()]);
    return true;
  } catch (error) {
    ElMessage.error(readError(error, "保存失败，请稍后重试。"));
    return false;
  } finally {
    saving.value = false;
  }
}

/** 服务端只认已保存的配置（Key 加密存放），所以步调统一为「先存再测 / 先存再拉」 */
async function testConnection() {
  if (testing.value || saving.value || fetchingModels.value || !character.value) return;
  testing.value = true;
  try {
    const saved = await save(true);
    if (!saved) return;
    const result = await $fetch<{ ok: boolean; message: string; elapsedMs?: number }>(
      `/api/characters/${encodeURIComponent(id.value)}/chat/test-connection`,
      { method: "POST" },
    );
    if (result.ok) {
      ElMessage.success(result.message + (result.elapsedMs !== undefined ? `（${result.elapsedMs} ms）` : ""));
    } else {
      ElMessage.error(result.message || "API 连通性测试失败。");
    }
  } catch (error) {
    ElMessage.error(readError(error, "API 连通性测试失败，请检查地址、Key 和模型名称。"));
  } finally {
    testing.value = false;
  }
}

async function fetchModels() {
  if (fetchingModels.value || saving.value || testing.value || !character.value) return;
  fetchingModels.value = true;
  try {
    const saved = await save(true);
    if (!saved) return;
    const result = await $fetch<{ ok: boolean; models: string[]; message: string; unsupported?: boolean }>(
      `/api/characters/${encodeURIComponent(id.value)}/chat/models`,
    );
    if (!result.ok) {
      if (result.unsupported) ElMessage.warning(result.message);
      else ElMessage.error(result.message);
      return;
    }
    fetchedModels.value = result.models;
    if (!draftChatModel.value.trim() && result.models.length) {
      draftChatModel.value = result.models[0] ?? "";
    }
    ElMessage.success(result.message);
  } catch (error) {
    ElMessage.error(readError(error, "获取模型列表失败，请稍后重试。"));
  } finally {
    fetchingModels.value = false;
  }
}

/** 试跑前先保存：后台用的是库里那份设置，不先存就等于拿旧设置试。 */
async function tryProactive() {
  if (tryingProactive.value || saving.value || !character.value) return;
  tryingProactive.value = true;
  try {
    const saved = await save(true);
    if (!saved) return;
    const result = await $fetch<{
      status: string;
      reason: string;
      reasonLabel: string;
      content: string | null;
      detail: string | null;
    }>(`/api/characters/${encodeURIComponent(id.value)}/proactive/try`, { method: "POST" });

    if (result.status === "sent") ElMessage.success(`发出去了：「${result.content ?? ""}」`);
    else if (result.status === "skipped") ElMessage.warning(`这次没发：${result.reasonLabel}`);
    else ElMessage.error(`这次失败：${result.reasonLabel}${result.detail ? `（${result.detail}）` : ""}`);

    await Promise.all([loadProactive(), loadUsage()]);
  } catch (error) {
    ElMessage.error(readError(error, "试跑失败，请稍后重试。"));
  } finally {
    tryingProactive.value = false;
  }
}

onMounted(() => void loadCharacter());
watch(id, () => void loadCharacter());
</script>

<template>
  <div class="page-wrap">
    <PageHeader
      :eyebrow="'角色管理 / ' + (character?.name ?? '角色') + ' / 模型设置'"
      title="模型设置"
      description="决定这个角色用哪家模型对话。配置写入 PostgreSQL，API Key 加密保存、不回传给网页；测试连接与拉取模型都基于已保存的配置。"
      :back-to="backTarget"
      :back-label="backLabel"
    />

    <div
      v-if="!loading && !character"
      class="empty-block"
    >
      <h4>读不到这个角色</h4>
      <p>角色可能已被删除，或本地数据库还没迁移。返回列表重新选择一个。</p>
      <button
        type="button"
        class="btn"
        @click="navigateTo('/characters')"
      >
        返回角色列表
      </button>
    </div>

    <div
      v-else
      v-loading="loading"
      class="settings-grid"
    >
      <div>
        <!-- 服务商与凭据 -->
        <section class="surface form-section">
          <div class="settings-section-head">
            <div>
              <div class="form-title">
                服务商与凭据 <span class="pill pill-purple">连接</span>
              </div>
              <p class="section-description">
                选服务商会自动填好公开兼容地址和常用模型，也可以完全手填。
              </p>
            </div>
            <el-icon class="section-icon">
              <Cpu />
            </el-icon>
          </div>

          <el-form
            label-position="top"
            style="margin-top:18px"
          >
            <el-form-item label="服务商">
              <el-select
                :model-value="draftProviderKey"
                placeholder="选择服务商，自动填好地址与常用模型"
                style="width:100%"
                @change="applyProvider"
              >
                <el-option
                  v-for="preset in MODEL_PROVIDERS"
                  :key="preset.key"
                  :label="preset.name"
                  :value="preset.key"
                />
              </el-select>
              <div class="form-help">
                {{ providerHint }}
              </div>
            </el-form-item>

            <el-form-item
              label="API 地址"
              required
            >
              <el-input
                v-model="draftChatApiBaseUrl"
                maxlength="500"
                placeholder="https://api.deepseek.com/v1"
              />
              <div class="form-help">
                填 API 根地址，不要追加 /chat/completions。必须 HTTPS；HTTP 仅允许本机地址。
              </div>
            </el-form-item>

            <el-form-item label="API Key">
              <el-input
                v-model="draftChatApiKey"
                type="password"
                show-password
                autocomplete="new-password"
                maxlength="8192"
                :placeholder="apiKeyPlaceholder"
              />
              <div class="form-help">
                {{ apiKeyHint }}
              </div>
              <el-checkbox
                v-if="apiKeySource === 'character'"
                v-model="clearSavedApiKey"
              >
                移除此角色单独保存的 API Key
              </el-checkbox>
            </el-form-item>
          </el-form>
        </section>

        <!-- 模型与生成参数 -->
        <section class="surface form-section">
          <div class="settings-section-head">
            <div>
              <div class="form-title">
                模型与生成参数
              </div>
              <p class="section-description">
                模型名可以点选，也可以直接输入厂商文档里的任意名字。
              </p>
            </div>
          </div>

          <el-form
            label-position="top"
            style="margin-top:18px"
          >
            <el-form-item
              label="模型名称"
              required
            >
              <div class="model-row">
                <el-select
                  v-model="draftChatModel"
                  class="model-select"
                  filterable
                  allow-create
                  default-first-option
                  placeholder="选择，或直接输入模型名"
                >
                  <el-option
                    v-for="model in modelOptions"
                    :key="model"
                    :label="model"
                    :value="model"
                  />
                </el-select>
                <button
                  type="button"
                  class="btn"
                  :disabled="saving || testing || fetchingModels"
                  @click="fetchModels"
                >
                  <el-icon><Refresh /></el-icon>{{ fetchingModels ? "获取中…" : "获取模型" }}
                </button>
              </div>
              <div class="form-help">
                选项来自内置目录；「获取模型」会先保存再向服务商拉取真实列表，失败的原始提示会直接显示。
              </div>
            </el-form-item>

            <el-form-item label="温度">
              <el-slider
                v-model="draftChatTemperature"
                :min="0"
                :max="2"
                :step="0.1"
                show-input
              />
              <div class="form-help">
                越低越稳定、越像在照本宣科；越高越发散，也越容易跑题。
              </div>
            </el-form-item>

            <el-form-item label="最大输出 Token">
              <el-input-number
                v-model="draftChatMaxTokens"
                :min="256"
                :max="8192"
                :step="256"
              />
              <div class="form-help">
                数值越大，回复可能越长，单次请求的消耗也越高。
              </div>
            </el-form-item>

            <el-form-item label="每日 token 额度">
              <el-input-number
                v-model="draftDailyTokenLimit"
                :min="0"
                :max="10000000"
                :step="10000"
              />
              <div class="form-help">
                0 = 不限。按东八区自然日累计全部调用（对话 / QQ / 值班 / 总结）；用完后对话直接拒绝，QQ 与值班静默跳过。
              </div>
            </el-form-item>

            <el-form-item label="记忆注入预算（token）">
              <el-input-number
                v-model="draftMemoryTokenBudget"
                :min="0"
                :max="20000"
                :step="200"
              />
              <div class="form-help">
                每次对话最多带多少记忆。0 = 用默认 1200。超出预算时按「相关度 × 新鲜度衰减 × 重要度」取到这个上限为止。
              </div>
            </el-form-item>

            <el-form-item label="阶段总结注入预算（token）">
              <el-input-number
                v-model="draftSnapshotTokenBudget"
                :min="0"
                :max="20000"
                :step="200"
              />
              <div class="form-help">
                一篇周期总结动辄两三千字，所以和记忆分开算预算，否则两者会互相挤掉。0 = 用默认 2000。
              </div>
            </el-form-item>

            <el-form-item label="QQ 渠道发表情">
              <el-switch v-model="draftEmojiEnabled" />
              <div class="form-help">
                开启后 QQ 回复偶尔会在正文之后单独跟一条表情。默认关闭；上一条刚发过表情的话，10 分钟内不会再发。网页对话与 B站 私信不受影响。
              </div>
            </el-form-item>
          </el-form>
        </section>

        <!-- 主动找话 -->
        <section class="surface form-section">
          <div class="settings-section-head">
            <div>
              <div class="form-title">
                主动找话
                <span
                  class="pill"
                  :class="draftProactive.enabled ? 'pill-green' : ''"
                >{{ draftProactive.enabled ? "已开启" : "默认关闭" }}</span>
              </div>
              <p class="section-description">
                想开口的时候，她自己先发一条 QQ 私信。不是定时群发：先攒「想做但还没做的事」，再由硬闸门决定这一刻能不能说。
              </p>
            </div>
            <el-icon class="section-icon">
              <Promotion />
            </el-icon>
          </div>

          <el-form
            label-position="top"
            style="margin-top:18px"
          >
            <el-form-item label="开启主动找话">
              <el-switch v-model="draftProactive.enabled" />
              <div class="form-help">
                默认关闭——这是唯一一条「她先开口」的路径，开着的话你得先接受她突然找你。收件人取的是这个角色最近一次 QQ 私聊的对象，没私聊过就不会发。
              </div>
            </el-form-item>

            <template v-if="draftProactive.enabled">
              <el-form-item label="每天最多几条">
                <el-input-number
                  v-model="draftProactive.dailyMax"
                  :min="0"
                  :max="24"
                />
                <div class="form-help">
                  0 = 关掉这个口子。按东八区自然日计，和 token 额度同一把尺量日子。
                </div>
              </el-form-item>

              <el-form-item label="两条之间至少隔多久（分钟）">
                <el-input-number
                  v-model="draftProactive.minGapMinutes"
                  :min="15"
                  :max="1440"
                  :step="15"
                />
                <div class="form-help">
                  默认 180 分钟。间隔太短，她会变成「刚聊完又凑上来」。
                </div>
              </el-form-item>

              <el-form-item label="安静时段">
                <div class="quiet-row">
                  <el-time-select
                    v-model="draftProactive.quietStart"
                    start="00:00"
                    step="00:30"
                    end="23:30"
                    placeholder="23:00"
                  />
                  <span class="quiet-sep">到</span>
                  <el-time-select
                    v-model="draftProactive.quietEnd"
                    start="00:00"
                    step="00:30"
                    end="23:30"
                    placeholder="08:00"
                  />
                </div>
                <div class="form-help">
                  允许跨午夜（23:00 到 08:00 就是整夜闭嘴）。起止填成一样会被拒绝保存，因为那等于没有安静时段。
                </div>
              </el-form-item>

              <el-form-item label="刚聊过就先不打扰（分钟）">
                <el-input-number
                  v-model="draftProactive.userActiveMinutes"
                  :min="0"
                  :max="720"
                  :step="10"
                />
                <div class="form-help">
                  你在这段时间内说过话，她就不会主动开口——那样叫接话，不叫主动找。0 = 不判这条。
                </div>
              </el-form-item>

              <el-form-item label="最低置信度">
                <el-slider
                  v-model="draftProactive.minConfidence"
                  :min="0"
                  :max="1"
                  :step="0.05"
                  show-input
                />
                <div class="form-help">
                  她会给每件「想做的事」打 0–1 分，低于这个值就不开口。调高更安静。
                </div>
              </el-form-item>
            </template>
          </el-form>

          <div class="proactive-foot">
            <div class="proactive-state">
              <template v-if="proactiveSnapshot">
                <span
                  class="pill"
                  :class="proactiveSnapshot.status.canSendNow ? 'pill-green' : ''"
                >{{ proactiveSnapshot.status.reasonLabel }}</span>
                <span class="proactive-meta">
                  今天 {{ proactiveSnapshot.status.sentToday }} / {{ proactiveSnapshot.settings.dailyMax }} 条 ·
                  池子 {{ proactiveSnapshot.status.pendingCount }} 条 ·
                  收件人 {{ proactiveSnapshot.status.recipient ?? "还没有" }}
                </span>
              </template>
              <span
                v-else
                class="proactive-meta"
              >还读不到当前状态，保存后刷新一次。</span>
            </div>
            <button
              type="button"
              class="btn"
              :disabled="tryingProactive || saving"
              @click="tryProactive"
            >
              <el-icon><Promotion /></el-icon>{{ tryingProactive ? "试跑中…" : "立即试一次" }}
            </button>
          </div>

          <div class="form-help">
            「立即试一次」只跳过时间类限制（安静时段 / 间隔 / 每日上限）；开关、收件人和当日额度照判，否则这个按钮就等于绕过所有保护。
          </div>

          <div
            v-if="proactiveSnapshot?.recent.length"
            class="proactive-recent"
          >
            <div class="recent-head">
              最近的想法
            </div>
            <div
              v-for="item in proactiveSnapshot.recent.slice(0, 5)"
              :key="item.id"
              class="recent-row"
            >
              <span class="pill">{{ PROACTIVE_KIND_LABELS[item.kind] ?? item.kind }}</span>
              <span class="recent-text">{{ item.status === "SENT" ? (item.content ?? item.goal) : item.goal }}</span>
              <span class="recent-status">{{ PROACTIVE_STATUS_LABELS[item.status] ?? item.status }}</span>
            </div>
          </div>
        </section>

        <div class="form-actions">
          <button
            type="button"
            class="btn"
            :disabled="saving || testing || fetchingModels"
            @click="testConnection"
          >
            <el-icon><Connection /></el-icon>{{ testing ? "测试中…" : "保存并测试" }}
          </button>
          <button
            type="button"
            class="btn primary"
            :disabled="saving || testing || fetchingModels"
            @click="save(false)"
          >
            <el-icon><Select /></el-icon>{{ saving ? "保存中…" : "保存设置" }}
          </button>
        </div>
      </div>

      <aside class="settings-side">
        <section class="surface panel side-panel">
          <div class="card-head">
            <h2>当前配置</h2>
            <span class="sub">已写入数据库</span>
          </div>
          <div class="metric-row">
            <span>模型</span><span class="metric-value">{{ character?.chatModel || "未配置" }}</span>
          </div>
          <div class="metric-row">
            <span>服务商</span><span class="metric-value">{{ providerLabel }}</span>
          </div>
          <div class="metric-row">
            <span>API Key</span><span
              class="pill"
              :class="apiKeySource === 'missing' ? 'pill-rose' : 'pill-green'"
            >{{ apiKeySource === "character" ? "角色独立 Key" : apiKeySource === "environment" ? "服务端默认 Key" : "未配置" }}</span>
          </div>
          <div class="metric-row">
            <span>温度 / 上限</span><span class="metric-value">{{ character?.chatTemperature ?? "—" }} · {{ character?.chatMaxTokens ?? "—" }} tokens</span>
          </div>
          <div class="info-callout side-callout">
            <el-icon><InfoFilled /></el-icon><span>模型未配置时，对话与自动归档会留在队列里，不会用规则摘要冒充 AI 输出。</span>
          </div>
        </section>

        <section class="surface panel side-panel">
          <div class="card-head">
            <h2>今日用量</h2>
            <span class="sub">{{ dailyUsage?.day ?? "—" }}</span>
          </div>
          <div class="metric-row">
            <span>已用 token</span>
            <span class="metric-value">
              {{ dailyUsage ? dailyUsage.usage.totalTokens.toLocaleString() : "—" }}
              <template v-if="dailyUsage?.quota.limit"> / {{ dailyUsage.quota.limit.toLocaleString() }}</template>
            </span>
          </div>
          <div class="metric-row">
            <span>调用次数</span><span class="metric-value">{{ dailyUsage?.usage.calls ?? 0 }}</span>
          </div>
          <div
            v-for="(value, kind) in dailyUsage?.usage.byKind ?? {}"
            :key="kind"
            class="metric-row"
          >
            <span>{{ KIND_LABELS[String(kind)] ?? kind }}</span>
            <span class="metric-value">{{ value.totalTokens.toLocaleString() }} · {{ value.calls }} 次</span>
          </div>
          <div
            class="form-help"
            style="margin-top:8px"
          >
            额度用完时这里不会自动清零 —— 统计的是真实花费，调高额度或等次日恢复。
          </div>
          <button
            type="button"
            class="btn sm"
            style="margin-top:10px"
            @click="loadUsage"
          >
            <el-icon><Refresh /></el-icon>刷新用量
          </button>
        </section>

        <section class="surface panel">
          <div class="side-icon">
            <el-icon><Cpu /></el-icon>
          </div>
          <h2 class="section-heading">
            几个要知道的点
          </h2>
          <div class="rule-item">
            <span class="rule-number">01</span><div><strong>Key 不会回传网页</strong><p>保存后页面只显示"已保存"，原文无法再读出；留空即保持不变。</p></div>
          </div>
          <div class="rule-item">
            <span class="rule-number">02</span><div><strong>测试与拉取都先保存</strong><p>两步都用服务端已存的配置发起请求，所以会先写入数据库。</p></div>
          </div>
          <div class="rule-item">
            <span class="rule-number">03</span><div><strong>内置清单会过期</strong><p>厂商改名很常见，清单只作起点；能拉取就以拉取结果为准。</p></div>
          </div>
        </section>
      </aside>
    </div>

    <p class="footer-note">
      这里的配置只影响该角色的 AI 对话与自动归档提炼，不改变其他角色。
    </p>
  </div>
</template>

<style scoped>
.settings-grid{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:18px;align-items:start}
.settings-section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:15px}
.form-title{display:flex;align-items:center;gap:9px;color:var(--text);font-size:14px;font-weight:700}
.section-icon{color:var(--brand);font-size:18px}
.form-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}

/* 模型下拉 + 「获取模型」同行：select 吃掉剩余宽度 */
.model-row{display:flex;width:100%;gap:8px}
.model-select{min-width:0;flex:1}

/* 安静时段两个时刻选择器 + 「到」 */
.quiet-row{display:flex;align-items:center;gap:8px}
.quiet-sep{color:var(--dim);font-size:12px}

.proactive-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:6px;padding-top:14px;border-top:1px solid var(--line)}
.proactive-state{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}
.proactive-meta{color:var(--faint);font-size:12px;line-height:1.7}

.proactive-recent{margin-top:14px}
.recent-head{margin-bottom:6px;color:var(--text-2);font-size:12px;font-weight:600}
.recent-row{display:flex;align-items:center;gap:8px;padding:5px 0;border-top:1px dashed var(--line)}
.recent-text{min-width:0;flex:1;overflow:hidden;color:var(--dim);font-size:12px;text-overflow:ellipsis;white-space:nowrap}
.recent-status{flex:0 0 auto;color:var(--faint);font-size:12px}

.settings-side{display:flex;flex-direction:column;gap:16px}
.settings-side .panel{padding:18px 20px}
.side-icon{display:flex;width:36px;height:36px;align-items:center;justify-content:center;margin-bottom:12px;border-radius:var(--radius);background:var(--brand-soft);color:var(--brand);font-size:18px}
.card-head{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.card-head h2{margin:0;color:var(--text-2);font-size:14px;font-weight:700}
.card-head .sub{color:var(--faint);font:400 12px/1 Consolas,monospace}
.side-callout{margin-top:14px}
.rule-item{display:flex;gap:10px;margin-top:18px}
.rule-number{display:flex;width:24px;height:24px;flex:0 0 auto;align-items:center;justify-content:center;border-radius:var(--radius-xs);background:var(--brand-soft);color:var(--brand-strong);font-size:12px;font-weight:700}
.rule-item strong{color:var(--text-2);font-size:12px;font-weight:600}
.rule-item p{margin-top:4px;color:var(--dim);font-size:12px;line-height:1.8}

.empty-block{min-height:240px;border-radius:10px;background:var(--surface);padding:34px 24px 30px}
.empty-block h4{margin:0 0 7px;color:var(--text);font-size:16px;font-weight:600}
.empty-block p{max-width:460px;margin:0 0 16px;color:var(--dim);font-size:14px;line-height:1.7}

@media(max-width:1050px){.settings-grid{grid-template-columns:1fr}.settings-side{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px}}
@media(max-width:640px){.settings-side{grid-template-columns:1fr}}
</style>
