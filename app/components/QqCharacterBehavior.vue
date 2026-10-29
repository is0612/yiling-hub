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
  groupBiliRunEnabled: boolean;
  emojiEnabled: boolean;
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
const draft = ref<ProactiveSettings>({ ...FALLBACK, ...(props.proactive ?? {}) });
const snapshot = ref<ProactiveSnapshot | null>(null);
const savingEmoji = ref(false);
const savingProactive = ref(false);
const trying = ref(false);

// ── 绑定级草稿 ─────────────────────────────────────────
const bind = reactive({
  routingKey: props.routingKey ?? "",
  replyWindowMinutes: props.replyWindowMinutes,
  replyLimitPerWindow: props.replyLimitPerWindow,
  replyOnlyWhenMentioned: props.replyOnlyWhenMentioned,
  groupBiliRunEnabled: props.groupBiliRunEnabled,
});
const savingBind = ref(false);

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
watch(() => props.proactive, (value) => {
  draft.value = { ...FALLBACK, ...(value ?? {}) };
}, { deep: true });
watch(
  () => [
    props.routingKey,
    props.replyWindowMinutes,
    props.replyLimitPerWindow,
    props.replyOnlyWhenMentioned,
    props.groupBiliRunEnabled,
  ],
  () => {
    bind.routingKey = props.routingKey ?? "";
    bind.replyWindowMinutes = props.replyWindowMinutes;
    bind.replyLimitPerWindow = props.replyLimitPerWindow;
    bind.replyOnlyWhenMentioned = props.replyOnlyWhenMentioned;
    bind.groupBiliRunEnabled = props.groupBiliRunEnabled;
  },
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
        replyOnlyWhenMentioned: bind.replyOnlyWhenMentioned,
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
        <b>群聊行为</b>
        <span class="beh-sum">只对这个号 / 群生效</span>
      </div>

      <div class="beh-field">
        <span class="beh-label">群号（可留空）</span>
        <el-input
          v-model="bind.routingKey"
          placeholder="留空 = 私聊 + 所有群"
        />
        <em>填了群号就只在这个群回复；想同时听多个群，给这个角色多绑几条。</em>
      </div>

      <div class="beh-field">
        <span class="beh-label">群聊里怎么回</span>
        <el-radio-group v-model="bind.replyOnlyWhenMentioned">
          <el-radio-button :value="true">
            仅被 @ 时回复
          </el-radio-button>
          <el-radio-button :value="false">
            所有消息都回复
          </el-radio-button>
        </el-radio-group>
        <em>私聊不受影响，永远是回的。</em>
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

      <div class="beh-bind-foot">
        <span class="beh-meta">保存后立刻生效，不用重启适配器</span>
        <span class="grow" />
        <button
          type="button"
          class="abtn is-lead"
          :disabled="savingBind"
          @click="saveBind"
        >
          {{ savingBind ? "保存中…" : "保存群聊行为" }}
        </button>
      </div>
    </div>

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

@media (max-width: 720px) {
  .beh-grid { grid-template-columns: minmax(0, 1fr); }
  .beh-state .grow { display: none; }
}
</style>
