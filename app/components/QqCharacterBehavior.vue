<script setup lang="ts">
/**
 * 一张卡对应「角色 ↔ QQ 号/群」的一条绑定。
 *
 * 卡里分两层：
 * - 绑定级：群号、群聊回复策略、发言限流、刷 B站 —— 存在 binding.config，随绑定走
 * - 角色级：发表情、主动找话 —— 存在角色 modelConfig，多绑定时每张卡复用（改的是同一个角色）
 *
 * 绑定级保存走 POST /bindings（按 characterId+connectionId upsert），
 * 角色级保存走 PATCH /characters/:id，互不干扰。
 */
import { Promotion, Right } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";

type ProactiveSettings = {
  enabled: boolean;
  dailyMax: number;
  minGapMinutes: number;
  quietStart: string;
  quietEnd: string;
  userActiveMinutes: number;
  minConfidence: number;
};

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

const props = defineProps<{
  bindingId: string;
  characterId: string;
  characterName: string;
  connectionId: string;
  connectionName: string;
  routingKey: string | null;
  replyWindowMinutes: number;
  replyLimitPerWindow: number;
  replyOnlyWhenMentioned: boolean;
  /** 群聊策略：模式 + 攒批/闸门参数。后端已把默认值补齐，这里直接用。 */
  groupChat: {
    mode: "mention" | "ambient" | "all";
    batchWindowSeconds: number;
    mentionWindowSeconds: number;
    minGapSeconds: number;
    dailyMax: number;
    quietStart: string;
    quietEnd: string;
    ambientChance: number;
    aliases: string[];
  };
  groupBiliRunEnabled: boolean;
  emojiEnabled: boolean;
  /** 群友发的图要不要交给视觉模型读；角色级开关，默认关。 */
  imageUnderstanding: boolean;
  /** 服务端总会带默认值；这里仍留兜底，避免老数据没有这段时表单是空的 */
  proactive?: ProactiveSettings;
}>();

const emit = defineEmits<{ saved: [] }>();

const FALLBACK: ProactiveSettings = {
  enabled: false,
  dailyMax: 2,
  minGapMinutes: 180,
  quietStart: "23:00",
  quietEnd: "08:00",
  userActiveMinutes: 30,
  minConfidence: 0.4,
};

const KIND_LABELS: Record<string, string> = {
  SHARE: "分享",
  ASK: "想问",
  INVITE: "邀约",
  CONFIDE: "心里话",
  CURIOUS: "好奇",
  FOLLOWUP: "追问",
};

const STATUS_LABELS: Record<string, string> = {
  PENDING: "待说",
  SENT: "已发",
  SKIPPED: "略过",
  EXPIRED: "过期",
};

// ── 角色级草稿 ─────────────────────────────────────────
const emoji = ref(props.emojiEnabled);
const imageUnderstanding = ref(props.imageUnderstanding);
const draft = ref<ProactiveSettings>({ ...FALLBACK, ...(props.proactive ?? {}) });
const snapshot = ref<ProactiveSnapshot | null>(null);
const savingEmoji = ref(false);
const savingImageUnderstanding = ref(false);
const savingProactive = ref(false);
const trying = ref(false);

// ── 绑定级草稿 ─────────────────────────────────────────
const bind = reactive({
  routingKey: props.routingKey ?? "",
  replyWindowMinutes: props.replyWindowMinutes,
  replyLimitPerWindow: props.replyLimitPerWindow,
  groupChatMode: props.groupChat.mode,
  minGapSeconds: props.groupChat.minGapSeconds,
  dailyMax: props.groupChat.dailyMax,
  // 界面用百分比，存的是 0-1 的小数。
  ambientChancePercent: Math.round(props.groupChat.ambientChance * 100),
  quietStart: props.groupChat.quietStart,
  quietEnd: props.groupChat.quietEnd,
  groupAliases: props.groupChat.aliases.join("，"),
  groupBiliRunEnabled: props.groupBiliRunEnabled,
});
const savingBind = ref(false);

/** 刻度上的位置：三档是顺序关系，不是三个并列开关 */
const modeIndex = computed(() => {
  const order = ["mention", "ambient", "all"] as const;
  const index = order.indexOf(bind.groupChatMode as (typeof order)[number]);
  return index < 0 ? 1 : index;
});

/** 刻度下面那一句：说清这一档会发生什么，而不是复述选项名 */
const modeNote = computed(() => {
  if (bind.groupChatMode === "mention") return "只有 @ 她、或者叫到下面的名字才回。最省心，也最省额度；私聊永远会回。";
  if (bind.groupChatMode === "all") return "每句都回。群里一热闹就会刷屏，也最容易一次把额度用完。";
  return "攒一轮消息看完整段再决定接不接；接不上就潜水，不会一句一答。";
});

/** 头像里一个字：优先取第一个汉字 —— 名字叫「deepseek鲸鱼娘」时，取到 "d" 很难看 */
const initial = computed(() => {
  const chars = Array.from(props.characterName);
  const cjk = chars.find((char) => /[\u4e00-\u9fa5]/.test(char));
  if (cjk) return cjk;
  const latin = chars.slice(0, 2).join("");
  return latin ? latin.toUpperCase() : "?";
});

// 父级保存后会重新拉列表，这里跟着把草稿同步成库里的值
watch(() => props.emojiEnabled, (value) => {
  emoji.value = value;
});
watch(() => props.imageUnderstanding, (value) => {
  imageUnderstanding.value = value;
});
watch(() => props.proactive, (value) => {
  draft.value = { ...FALLBACK, ...(value ?? {}) };
}, { deep: true });
watch(
  () => [
    props.routingKey,
    props.replyWindowMinutes,
    props.replyLimitPerWindow,
    props.replyOnlyWhenMentioned,
    props.groupChat,
    props.groupBiliRunEnabled,
  ],
  () => {
    bind.routingKey = props.routingKey ?? "";
    bind.replyWindowMinutes = props.replyWindowMinutes;
    bind.replyLimitPerWindow = props.replyLimitPerWindow;
    bind.groupChatMode = props.groupChat.mode;
    bind.minGapSeconds = props.groupChat.minGapSeconds;
    bind.dailyMax = props.groupChat.dailyMax;
    bind.ambientChancePercent = Math.round(props.groupChat.ambientChance * 100);
    bind.quietStart = props.groupChat.quietStart;
    bind.quietEnd = props.groupChat.quietEnd;
    bind.groupAliases = props.groupChat.aliases.join("，");
    bind.groupBiliRunEnabled = props.groupBiliRunEnabled;
  },
  { deep: true },
);

function readError(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "statusMessage" in error) {
    const message = String((error as { statusMessage?: unknown }).statusMessage ?? "");
    if (message) return message;
  }
  return fallback;
}

// ── 绑定级保存 ─────────────────────────────────────────
async function saveBind() {
  if (savingBind.value) return;
  savingBind.value = true;
  try {
    await $fetch(`/api/admin/channels/${encodeURIComponent(props.connectionId)}/bindings`, {
      method: "POST",
      body: {
        characterId: props.characterId,
        routingKey: bind.routingKey.trim(),
        replyWindowMinutes: bind.replyWindowMinutes,
        replyLimitPerWindow: bind.replyLimitPerWindow,
        groupChatMode: bind.groupChatMode,
        minGapSeconds: bind.minGapSeconds,
        dailyMax: bind.dailyMax,
        ambientChance: bind.ambientChancePercent / 100,
        quietStart: bind.quietStart,
        quietEnd: bind.quietEnd,
        groupAliases: bind.groupAliases,
        groupBiliRunEnabled: bind.groupBiliRunEnabled,
      },
    });
    ElMessage.success("群聊行为已保存。");
    emit("saved");
  } catch (error) {
    ElMessage.error(readError(error, "保存失败，请稍后重试。"));
  } finally {
    savingBind.value = false;
  }
}

// ── 角色级：发表情 / 主动找话 ───────────────────────────
async function loadSnapshot() {
  try {
    snapshot.value = await $fetch<ProactiveSnapshot>(
      `/api/characters/${encodeURIComponent(props.characterId)}/proactive`,
    );
  } catch {
    // 读不到状态不影响改设置
    snapshot.value = null;
  }
}

onMounted(loadSnapshot);

async function onEmojiChange(next: string | number | boolean) {
  if (savingEmoji.value) return;
  const value = next === true;
  savingEmoji.value = true;
  try {
    await $fetch(`/api/characters/${encodeURIComponent(props.characterId)}`, {
      method: "PATCH",
      body: { emojiEnabled: value },
    });
    ElMessage.success(value ? "已开启：QQ 回复偶尔会单独跟一张表情。" : "已关闭：QQ 回复不再带表情。");
    emit("saved");
  } catch (error) {
    emoji.value = !value;
    ElMessage.error(readError(error, "保存失败，请稍后重试。"));
  } finally {
    savingEmoji.value = false;
  }
}

async function onImageUnderstandingChange(next: string | number | boolean) {
  if (savingImageUnderstanding.value) return;
  const value = next === true;
  savingImageUnderstanding.value = true;
  try {
    await $fetch(`/api/characters/${encodeURIComponent(props.characterId)}`, {
      method: "PATCH",
      body: { imageUnderstanding: value },
    });
    ElMessage.success(value
      ? "已开启：群友发的图会先读成几句文字，再交给她回复。"
      : "已关闭：群里的图又变回 [图片]。");
    emit("saved");
  } catch (error) {
    imageUnderstanding.value = !value;
    ElMessage.error(readError(error, "保存失败，请稍后重试。"));
  } finally {
    savingImageUnderstanding.value = false;
  }
}

/** silent：试跑前要先落库，那一步不该再弹一次「已保存」 */
async function saveProactive(silent = false): Promise<boolean> {
  if (savingProactive.value) return false;
  savingProactive.value = true;
  try {
    await $fetch(`/api/characters/${encodeURIComponent(props.characterId)}`, {
      method: "PATCH",
      body: { proactive: { ...draft.value } },
    });
    if (!silent) ElMessage.success("主动找话设置已保存。");
    emit("saved");
    await loadSnapshot();
    return true;
  } catch (error) {
    ElMessage.error(readError(error, "保存失败：安静时段起止不能相同。"));
    return false;
  } finally {
    savingProactive.value = false;
  }
}

async function tryOnce() {
  if (trying.value || savingProactive.value) return;
  trying.value = true;
  try {
    const saved = await saveProactive(true);
    if (!saved) return;
    const result = await $fetch<{
      status: string;
      reason: string;
      reasonLabel: string;
      content: string | null;
      detail: string | null;
    }>(`/api/characters/${encodeURIComponent(props.characterId)}/proactive/try`, { method: "POST" });

    if (result.status === "sent") ElMessage.success(`发出去了：「${result.content ?? ""}」`);
    else if (result.status === "skipped") ElMessage.warning(`这次没发：${result.reasonLabel}`);
    else ElMessage.error(`这次失败：${result.reasonLabel}${result.detail ? `（${result.detail}）` : ""}`);
    await loadSnapshot();
  } catch (error) {
    ElMessage.error(readError(error, "试跑失败，请稍后重试。"));
  } finally {
    trying.value = false;
  }
}
</script>

<template>
  <article class="beh-card">
    <div class="beh-head">
      <span class="beh-avatar">{{ initial }}</span>
      <div class="beh-id">
        <h3>{{ characterName }}</h3>
        <p>已绑定到 {{ connectionName }}</p>
      </div>
    </div>

    <!-- 绑定级：群聊行为 -->
    <div class="beh-bind">
      <div class="beh-bind-h">
        <b>她在群里怎么说话</b>
        <span class="beh-sum">只对这个号 / 群生效</span>
      </div>

      <!-- 一条刻度：三档是同一个维度的强弱，不该是三排开关 -->
      <div
        class="dial"
        :data-at="modeIndex"
        role="radiogroup"
        aria-label="群聊参与度"
      >
        <button
          type="button"
          class="dial-opt"
          role="radio"
          :aria-checked="bind.groupChatMode === 'mention'"
          @click="bind.groupChatMode = 'mention'"
        >
          <b>仅被 @ 时回复</b>
          <span>叫到才应，其余不理</span>
        </button>
        <button
          type="button"
          class="dial-opt"
          role="radio"
          :aria-checked="bind.groupChatMode === 'ambient'"
          @click="bind.groupChatMode = 'ambient'"
        >
          <b>自然接话</b>
          <span>看完整段再决定说一句</span>
        </button>
        <button
          type="button"
          class="dial-opt"
          role="radio"
          :aria-checked="bind.groupChatMode === 'all'"
          @click="bind.groupChatMode = 'all'"
        >
          <b>所有消息都回复</b>
          <span>每句都接，群里会刷屏</span>
        </button>
      </div>

      <p class="dial-note">
        {{ modeNote }}
      </p>

      <!-- 四个数就是这套行为现在的实际参数，一眼看完；改在下面的「参数」里 -->
      <dl
        v-if="bind.groupChatMode === 'ambient'"
        class="meters"
      >
        <div class="meter">
          <dt>两条之间至少</dt>
          <dd>{{ bind.minGapSeconds }}<small>秒</small></dd>
        </div>
        <div class="meter">
          <dt>每天最多</dt>
          <dd>
            {{ bind.dailyMax || "不限" }}<small v-if="bind.dailyMax">句</small>
          </dd>
        </div>
        <div class="meter">
          <dt>安静时段</dt>
          <dd class="is-clock">
            {{ bind.quietStart }}–{{ bind.quietEnd }}
          </dd>
        </div>
        <div class="meter">
          <dt>无关闲聊参与</dt>
          <dd>{{ bind.ambientChancePercent }}<small>%</small></dd>
        </div>
      </dl>

      <details class="beh-params">
        <summary>
          <span class="params-sum">参数</span>
          <span class="beh-sum">群号、别名、节奏、限流</span>
          <span class="grow" />
          <el-icon class="params-caret">
            <Right />
          </el-icon>
        </summary>

        <div class="params-body">
          <div class="beh-field">
            <span class="beh-label">群号（可留空）</span>
            <el-input
              v-model="bind.routingKey"
              placeholder="留空 = 私聊 + 所有群"
            />
            <em>填了群号就只在这个群回复；想同时听多个群，给这个角色多绑几条。</em>
          </div>

          <div
            v-if="bind.groupChatMode === 'ambient'"
            class="beh-field"
          >
            <span class="beh-label">群里怎么叫她</span>
            <el-input
              v-model="bind.groupAliases"
              placeholder="小鱼，大傻鱼，小鲸鱼"
            />
            <em>逗号分隔。没 @ 但叫到这些名字，也算在跟她说话。</em>
          </div>

          <div
            v-if="bind.groupChatMode === 'ambient'"
            class="beh-field"
          >
            <span class="beh-label">说话节奏</span>
            <div class="beh-limit">
              <span>两条之间至少隔</span>
              <el-input-number
                v-model="bind.minGapSeconds"
                :min="0"
                :max="3600"
                :step="30"
              />
              <span>秒，每天最多</span>
              <el-input-number
                v-model="bind.dailyMax"
                :min="0"
                :max="1000"
                :step="10"
              />
              <span>句</span>
            </div>
            <em>0 句 = 不限。觉得她太吵就先调小「每天最多」。</em>
          </div>

          <div
            v-if="bind.groupChatMode === 'ambient'"
            class="beh-field"
          >
            <span class="beh-label">安静时段</span>
            <div class="beh-quiet">
              <el-time-select
                v-model="bind.quietStart"
                start="00:00"
                step="00:30"
                end="23:30"
                placeholder="23:30"
              />
              <span class="beh-quiet-sep">到</span>
              <el-time-select
                v-model="bind.quietEnd"
                start="00:00"
                step="00:30"
                end="23:30"
                placeholder="07:30"
              />
            </div>
            <em>这段时间里，除了有人 @ 她，都不主动接话。允许跨午夜。</em>
          </div>

          <div
            v-if="bind.groupChatMode === 'ambient'"
            class="beh-field"
          >
            <span class="beh-label">无关闲聊的参与概率</span>
            <div class="beh-limit">
              <el-input-number
                v-model="bind.ambientChancePercent"
                :min="0"
                :max="100"
                :step="5"
              />
              <span>%</span>
            </div>
            <em>跟她完全没关系的聊天，按这个比例放进去看一眼再说。调高更活跃，也更费 token。</em>
          </div>

          <div class="beh-field">
            <span class="beh-label">群聊发言限流</span>
            <div class="beh-limit">
              <span>每</span>
              <el-input-number
                v-model="bind.replyWindowMinutes"
                :min="1"
                :max="1440"
                :step="5"
              />
              <span>分钟最多回复</span>
              <el-input-number
                v-model="bind.replyLimitPerWindow"
                :min="0"
                :max="100"
                :step="1"
              />
              <span>条</span>
            </div>
            <em>0 条 = 不限。按群分别计数，只统计她自己的回复。</em>
          </div>

          <div class="beh-toggle is-tight">
            <div class="beh-copy">
              <b>刷一轮 B站</b>
              <span>主人在群里说口令触发她跑一轮 B站 值班；主人 QQ 在连接设置里填。</span>
            </div>
            <el-switch v-model="bind.groupBiliRunEnabled" />
          </div>
        </div>
      </details>
    </div>

    <!-- 角色级开关：跟群聊策略无关，默认收起，首屏只留一句摘要 -->
    <details class="beh-extra">
      <summary>
        <span class="params-sum">更多开关</span>
        <span class="beh-sum">发表情 · 看群里的图 · 主动找话</span>
        <span class="grow" />
        <el-icon class="params-caret">
          <Right />
        </el-icon>
      </summary>

      <div class="extra-body">
        <!-- 角色级：发表情（绑定的所有号共用） -->
        <div class="beh-toggle">
          <div class="beh-copy">
            <b>发表情</b>
            <span>回复时偶尔单独跟一张表情，10 分钟内不会连发。只影响 QQ，网页对话与 B站 不受影响。</span>
          </div>
          <el-switch
            v-model="emoji"
            :loading="savingEmoji"
            @change="onEmojiChange"
          />
        </div>

        <!-- 角色级：看群里的图（绑定的所有号共用） -->
        <div class="beh-toggle">
          <div class="beh-copy">
            <b>看群里的图</b>
            <span>群友发图时先让视觉模型读成几句描述，她回的就是图里的内容；不开只看到「[图片]」。每张图多一次模型调用，一轮最多读 3 张，读失败不影响回复。</span>
          </div>
          <el-switch
            v-model="imageUnderstanding"
            :loading="savingImageUnderstanding"
            @change="onImageUnderstandingChange"
          />
        </div>

        <details class="beh-more">
          <summary>
            <span class="caret"><el-icon><Right /></el-icon></span>
            <b>主动找话</b>
            <span
              class="pill"
              :class="draft.enabled ? 'pill-green' : 'pill-gray'"
            >{{ draft.enabled ? "已开启" : "默认关闭" }}</span>
            <span class="beh-sum">她自己先发一条 QQ 私信</span>
          </summary>

          <div class="beh-body">
            <p class="beh-lead">
              不是定时群发：先攒「想做但还没做的事」，再由闸门决定这一刻能不能说。
              收件人取这个角色最近一次 QQ 私聊的对象，没私聊过就不会发。
            </p>

            <div class="beh-field">
              <div class="beh-inline">
                <span class="beh-label">开启主动找话</span>
                <el-switch v-model="draft.enabled" />
              </div>
              <em>这是唯一一条「她先开口」的路径；打开前先确认你能接受她突然找你。</em>
            </div>

            <template v-if="draft.enabled">
              <div class="beh-grid">
                <div class="beh-field">
                  <span class="beh-label">每天最多几条</span>
                  <el-input-number
                    v-model="draft.dailyMax"
                    :min="0"
                    :max="24"
                  />
                  <em>0 = 关掉这个口子。按东八区自然日算。</em>
                </div>
                <div class="beh-field">
                  <span class="beh-label">两条之间至少隔多久（分钟）</span>
                  <el-input-number
                    v-model="draft.minGapMinutes"
                    :min="15"
                    :max="1440"
                    :step="15"
                  />
                  <em>默认 180；太短会变成「刚聊完又凑上来」。</em>
                </div>
              </div>

              <div class="beh-field">
                <span class="beh-label">安静时段</span>
                <div class="beh-quiet">
                  <el-time-select
                    v-model="draft.quietStart"
                    start="00:00"
                    step="00:30"
                    end="23:30"
                    placeholder="23:00"
                  />
                  <span class="beh-quiet-sep">到</span>
                  <el-time-select
                    v-model="draft.quietEnd"
                    start="00:00"
                    step="00:30"
                    end="23:30"
                    placeholder="08:00"
                  />
                </div>
                <em>允许跨午夜（23:00 到 08:00 就是整夜闭嘴）。起止填成一样会被拒绝保存。</em>
              </div>

              <div class="beh-grid">
                <div class="beh-field">
                  <span class="beh-label">刚聊过就先不打扰（分钟）</span>
                  <el-input-number
                    v-model="draft.userActiveMinutes"
                    :min="0"
                    :max="720"
                    :step="10"
                  />
                  <em>你在这段时间内说过话，她就不主动开口 —— 那样叫接话。0 = 不判这条。</em>
                </div>
                <div class="beh-field">
                  <!-- 数字放在标签行右侧，不用 show-input：Element 那条会把轨道挤成一小截 -->
                  <div class="beh-inline">
                    <span class="beh-label">最低置信度</span>
                    <span class="beh-value">{{ draft.minConfidence.toFixed(2) }}</span>
                  </div>
                  <el-slider
                    v-model="draft.minConfidence"
                    :min="0"
                    :max="1"
                    :step="0.05"
                  />
                  <em>她给每件「想做的事」打 0–1 分，低于这个值就不开口。调高更安静。</em>
                </div>
              </div>
            </template>

            <div class="beh-state">
              <template v-if="snapshot">
                <span
                  class="pill"
                  :class="snapshot.status.canSendNow ? 'pill-green' : 'pill-gray'"
                >{{ snapshot.status.reasonLabel }}</span>
                <span class="beh-meta">
                  今天 {{ snapshot.status.sentToday }} / {{ snapshot.settings.dailyMax }} 条 ·
                  池子 {{ snapshot.status.pendingCount }} 条 ·
                  收件人 {{ snapshot.status.recipient ?? "还没有" }}
                </span>
              </template>
              <span
                v-else
                class="beh-meta"
              >还读不到当前状态，保存后刷新一次。</span>
              <span class="grow" />
              <button
                type="button"
                class="abtn"
                :disabled="trying || savingProactive"
                @click="tryOnce"
              >
                <el-icon><Promotion /></el-icon>{{ trying ? "试跑中…" : "立即试一次" }}
              </button>
              <button
                type="button"
                class="abtn is-lead"
                :disabled="savingProactive"
                @click="saveProactive()"
              >
                {{ savingProactive ? "保存中…" : "保存" }}
              </button>
            </div>

            <p class="beh-hint">
              「立即试一次」只跳过时间类限制（安静时段 / 间隔 / 每日上限）；开关、收件人和当日额度照判，
              否则这个按钮就等于绕过所有保护。
            </p>

            <div
              v-if="snapshot?.recent.length"
              class="beh-recent"
            >
              <div
                v-for="item in snapshot.recent.slice(0, 3)"
                :key="item.id"
                class="beh-recent-row"
              >
                <span class="beh-kind">{{ KIND_LABELS[item.kind] ?? item.kind }}</span>
                <span class="beh-recent-text">{{ item.status === "SENT" ? (item.content ?? item.goal) : item.goal }}</span>
                <span class="beh-recent-status">{{ STATUS_LABELS[item.status] ?? item.status }}</span>
              </div>
            </div>
          </div>
        </details>
      </div>
    </details>
    <div class="beh-bind-foot">
      <span class="beh-meta">保存后立刻生效，不用重启适配器</span>
      <span class="grow" />
      <button
        type="button"
        class="abtn is-lead"
        :disabled="savingBind"
        @click="saveBind"
      >
        {{ savingBind ? "保存中…" : "保存" }}
      </button>
    </div>
  </article>
</template>

<style scoped>
/* A 套：白砖、零描边；开关与字段都靠间距分组 */
.beh-card { border-radius: 10px; background: var(--surface); padding: 16px 18px 14px; }

.beh-head { display: flex; align-items: center; gap: 10px; }
.beh-avatar {
  display: grid;
  width: 34px;
  height: 34px;
  flex: none;
  place-items: center;
  border-radius: 8px;
  background: var(--brand-soft);
  color: var(--brand-strong);
  font-size: 14px;
  font-weight: 700;
}
.beh-id { min-width: 0; }
.beh-id h3 { margin: 0; color: var(--text); font-size: 14px; font-weight: 700; line-height: 1.4; overflow-wrap: anywhere; }
.beh-id p { margin: 2px 0 0; color: var(--dim); font-size: 12px; line-height: 1.5; }

/* 绑定级「群聊行为」区块：一条 1px 起头，内部字段纵向排 */
.beh-bind { display: flex; flex-direction: column; gap: 12px; margin-top: 12px; border-top: 1px solid var(--surface-3); padding-top: 12px; }
.beh-bind-h { display: flex; align-items: baseline; gap: 8px; }
.beh-bind-h b { color: var(--text-2); font-size: 14px; font-weight: 600; }
.beh-sum { color: var(--dim); font-size: 12px; }

.beh-field { display: flex; flex-direction: column; gap: 5px; }
.beh-label { color: var(--text-2); font-size: 12px; font-weight: 600; }
.beh-field em { color: var(--dim); font-size: 12px; font-style: normal; line-height: 1.6; }
.beh-field :deep(.el-input-number) { width: 140px; }
.beh-field :deep(.el-radio-group) { align-self: flex-start; }
.beh-field :deep(.el-radio-button__inner) { font-size: 12px; }

.beh-limit { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; color: var(--text-2); font-size: 12px; }
.beh-limit :deep(.el-input-number) { width: 120px; }

.beh-bind-foot { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; border-radius: 8px; background: var(--surface-2); padding: 8px 10px; }
.beh-bind-foot .grow { flex: 1; }

/* ── 参与度刻度：一条轨道上三个位置 ─────────────────── */
.dial {
  position: relative;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  background: var(--surface-2);
  padding: 4px;
}
/* 选中的那块白底滑块：位置由 data-at 决定，动的是它而不是三个按钮各变各的 */
.dial::before {
  position: absolute;
  top: 4px;
  bottom: 4px;
  left: 4px;
  width: calc((100% - 24px) / 3);
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface);
  box-shadow: 0 1px 2px rgb(16 22 32 / 6%);
  content: "";
  transition: transform .22s var(--ease);
}
.dial[data-at="1"]::before { transform: translateX(calc(100% + 8px)); }
.dial[data-at="2"]::before { transform: translateX(calc(200% + 16px)); }

.dial-opt {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 1px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  padding: 7px 6px;
  text-align: center;
  cursor: pointer;
  transition: color .14s var(--ease);
}
.dial-opt b { color: var(--text-2); font-size: 12.5px; font-weight: 600; line-height: 1.4; }
.dial-opt span { color: var(--dim); font-size: 11.5px; line-height: 1.4; }
.dial-opt[aria-checked="true"] b { color: var(--brand-strong); font-weight: 700; }
.dial-opt[aria-checked="true"] span { color: #a8546f; }
.dial-opt:hover b { color: var(--brand-strong); }
.dial-opt:focus-visible { outline: 2px solid var(--brand); outline-offset: -2px; }

.dial-note { margin: 0; color: var(--dim); font-size: 12px; line-height: 1.65; }

/* ── 四格仪表：一眼看完现在的实际参数 ───────────────── */
.meters {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  margin: 0;
  border-radius: 8px;
  background: var(--surface-3);
  overflow: hidden;
}
.meter { background: var(--surface); padding: 8px 10px 9px; }
.meter dt { color: var(--dim); font-size: 11.5px; line-height: 1.4; }
.meter dd {
  margin: 2px 0 0;
  color: var(--text);
  font-size: 16px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  line-height: 1.25;
  white-space: nowrap;
}
.meter dd small { margin-left: 1px; color: var(--dim); font-size: 11px; font-weight: 500; }
.meter dd.is-clock { font-size: 13px; font-weight: 600; }

/* ── 参数 / 更多开关：默认折起来，改的时候才展开 ─────── */
.beh-params,
.beh-extra { border-top: 1px solid var(--surface-3); }
.beh-params > summary,
.beh-extra > summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 0 0;
  list-style: none;
  cursor: pointer;
}
.beh-params > summary::-webkit-details-marker,
.beh-extra > summary::-webkit-details-marker { display: none; }
.params-sum { color: var(--text-2); font-size: 12px; font-weight: 600; }
.beh-params > summary .grow,
.beh-extra > summary .grow { flex: 1; }
.params-caret { color: var(--faint); font-size: 12px; transition: transform .16s var(--ease); }
.beh-params[open] .params-caret,
.beh-extra[open] .params-caret { transform: rotate(90deg); }
.beh-params > summary:hover .params-sum,
.beh-extra > summary:hover .params-sum { color: var(--brand-strong); }
.params-body,
.extra-body { display: flex; flex-direction: column; gap: 12px; padding-top: 12px; }
.extra-body { gap: 4px; }

/* 开关行：文案在左、开关贴右，中间留白由 flex 撑开 */
.beh-toggle { display: flex; align-items: flex-start; gap: 16px; margin-top: 12px; border-top: 1px solid var(--surface-3); padding-top: 12px; }
.beh-toggle.is-tight { border-top: 0; margin-top: 0; padding-top: 0; }
.beh-copy { min-width: 0; flex: 1; }
.beh-copy b { display: block; color: var(--text-2); font-size: 14px; font-weight: 600; }
.beh-copy span { display: block; margin-top: 2px; color: var(--dim); font-size: 12px; line-height: 1.65; }
.beh-toggle :deep(.el-switch) { flex: none; margin-top: 2px; }

/* 折叠块：默认收起，只有想调参的人才展开 */
.beh-more { margin-top: 12px; border-top: 1px solid var(--surface-3); padding-top: 12px; }
.beh-more summary {
  display: flex;
  align-items: center;
  gap: 8px;
  list-style: none;
  cursor: pointer;
}
.beh-more summary::-webkit-details-marker { display: none; }
.beh-more summary b { color: var(--text-2); font-size: 14px; font-weight: 600; }
.beh-more .caret { display: inline-flex; color: var(--faint); font-size: 12px; transition: transform .14s var(--ease); }
.beh-more[open] .caret { transform: rotate(90deg); }

.beh-body { display: flex; flex-direction: column; gap: 12px; margin-top: 12px; }
.beh-lead { max-width: 68ch; margin: 0; color: var(--text-2); font-size: 12px; line-height: 1.75; }

.beh-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 20px; }
.beh-inline { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.beh-value { color: var(--text-2); font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.beh-field :deep(.el-slider) { width: 100%; }
.beh-quiet { display: flex; align-items: center; gap: 8px; }
.beh-quiet :deep(.el-select) { width: 120px; }
.beh-quiet-sep { color: var(--dim); font-size: 12px; }

/* 状态行：能不能发、今天发了几条，然后才是两个动作 */
.beh-state { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; border-radius: 8px; background: var(--surface-2); padding: 8px 10px; }
.beh-state .grow { flex: 1; }
.beh-meta { color: var(--dim); font-size: 12px; line-height: 1.6; }

.abtn {
  display: inline-flex;
  height: 28px;
  align-items: center;
  gap: 5px;
  border: 0;
  border-radius: 6px;
  background: none;
  padding: 0 9px;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  transition: background .14s var(--ease), color .14s var(--ease);
}
.abtn .el-icon { color: var(--faint); font-size: 13px; }
.abtn:hover:not(:disabled) { background: var(--surface-3); color: var(--brand-strong); }
.abtn:hover:not(:disabled) .el-icon { color: var(--brand); }
.abtn.is-lead { background: var(--brand-soft); color: var(--brand-strong); }
.abtn.is-lead:hover:not(:disabled) { background: var(--brand-line); }
.abtn:disabled { opacity: .5; cursor: not-allowed; }

.beh-hint { margin: 0; color: var(--dim); font-size: 12px; line-height: 1.7; }

.beh-recent { display: flex; flex-direction: column; gap: 4px; border-top: 1px solid var(--surface-3); padding-top: 8px; }
.beh-recent-row { display: flex; align-items: baseline; gap: 8px; font-size: 12px; line-height: 1.6; }
.beh-kind { flex: none; color: var(--dim); }
.beh-recent-text { min-width: 0; flex: 1; overflow: hidden; color: var(--text-2); text-overflow: ellipsis; white-space: nowrap; }
.beh-recent-status { flex: none; color: var(--dim); }

@media (max-width: 1100px) {
  /* 半宽卡片放不下四格并排，拆成两行两列 */
  .meters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media (max-width: 720px) {
  .beh-grid { grid-template-columns: minmax(0, 1fr); }
  .beh-state .grow { display: none; }

  /* 窄屏刻度改纵向列表：滑块会挡住文字，直接换成选中项白底 */
  .dial { grid-template-columns: minmax(0, 1fr); }
  .dial::before { display: none; }
  .dial-opt { border-radius: 6px; padding: 8px 10px; text-align: left; }
  .dial-opt[aria-checked="true"] { border: 1px solid var(--line); background: var(--surface); }
}
</style>
