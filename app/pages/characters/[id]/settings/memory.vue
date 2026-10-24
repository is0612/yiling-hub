<script setup lang="ts">
import { ArrowLeft, Calendar, InfoFilled, RefreshLeft, Lock, Select } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { initialCharacters, type Character } from "~/utils/mock-data";

type MemorySettings = {
  snapshotIntervalDays: number;
  timezone: string;
  anchorAt: string;
  rawMessageRetentionDays: number;
  autoSnapshotEnabled: boolean;
  changePolicy: "NEXT_CYCLE" | "IMMEDIATE_RECALC";
  nextSnapshotAt: string | null;
  updatedAt: string;
};

const route = useRoute();
const id = computed(() => String(route.params.id || ""));
const character = ref<Character>({ ...initialCharacters[0]!, id: "", name: "角色加载中" });
const interval = ref(8);
const timezone = ref("Asia/Shanghai");
const anchor = ref("2026-10-21T09:00:00");
const retention = ref(90);
const autoSnapshot = ref(false);
const nextSnapshotAt = ref<string | null>(null);
const effectivePolicy = ref("下一个周期生效");
const loading = ref(false);
const saving = ref(false);
const safeInterval = computed(() => Math.min(365, Math.max(1, Number(interval.value) || 8)));

function formatAnchor(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}`;
}

function zonedInputToIso(value: string, timeZone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) throw new Error("周期启用锚点无效。");
  const targetUtc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] || 0));
  let candidate = targetUtc;
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(candidate));
    const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
    const displayedAsUtc = Date.UTC(
      values.year ?? Number(match[1]),
      (values.month ?? Number(match[2])) - 1,
      values.day ?? Number(match[3]),
      values.hour ?? Number(match[4]),
      values.minute ?? Number(match[5]),
      values.second ?? Number(match[6] || 0),
    );
    const difference = targetUtc - displayedAsUtc;
    candidate += difference;
    if (difference === 0) break;
  }
  return new Date(candidate).toISOString();
}

async function loadSettings() {
  loading.value = true;
  try {
    const [loadedCharacter, settings] = await Promise.all([
      $fetch<Character>(`/api/characters/${encodeURIComponent(id.value)}`),
      $fetch<MemorySettings>(`/api/characters/${encodeURIComponent(id.value)}/memory-settings`),
    ]);
    character.value = loadedCharacter;
    interval.value = settings.snapshotIntervalDays;
    timezone.value = settings.timezone;
    anchor.value = formatAnchor(settings.anchorAt, settings.timezone);
    retention.value = settings.rawMessageRetentionDays;
    autoSnapshot.value = settings.autoSnapshotEnabled;
    nextSnapshotAt.value = settings.nextSnapshotAt;
    effectivePolicy.value = settings.changePolicy === "IMMEDIATE_RECALC" ? "立即重算" : "下一个周期生效";
  } catch (error) {
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : "无法读取记忆设置，请确认数据库已初始化。";
    ElMessage.error(message);
  } finally {
    loading.value = false;
  }
}

async function saveSettings() {
  saving.value = true;
  try {
    const anchorAt = zonedInputToIso(anchor.value, timezone.value);
    const saved = await $fetch<MemorySettings>(`/api/characters/${encodeURIComponent(id.value)}/memory-settings`, {
      method: "PATCH",
      body: {
        snapshotIntervalDays: safeInterval.value,
        timezone: timezone.value,
        anchorAt,
        rawMessageRetentionDays: retention.value,
        autoSnapshotEnabled: autoSnapshot.value,
        changePolicy: effectivePolicy.value === "立即重算" ? "IMMEDIATE_RECALC" : "NEXT_CYCLE",
      },
    });
    interval.value = saved.snapshotIntervalDays;
    nextSnapshotAt.value = saved.nextSnapshotAt;
    autoSnapshot.value = saved.autoSnapshotEnabled;
    anchor.value = formatAnchor(saved.anchorAt, saved.timezone);
    effectivePolicy.value = saved.changePolicy === "IMMEDIATE_RECALC" ? "立即重算" : "下一个周期生效";
    ElMessage.success("记忆周期设置已保存到本地数据库。");
  } catch (error) {
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : error instanceof Error ? error.message : "保存失败，请检查数据库连接。";
    ElMessage.error(message);
  } finally {
    saving.value = false;
  }
}

function resetSettings() {
  interval.value = 8;
  timezone.value = "Asia/Shanghai";
  const now = new Date();
  anchor.value = formatAnchor(now.toISOString(), timezone.value);
  retention.value = 90;
  autoSnapshot.value = false;
  nextSnapshotAt.value = null;
  effectivePolicy.value = "下一个周期生效";
  ElMessage.info("已将表单恢复为默认值；点击“保存设置”后才会写入数据库。");
}

const nextSnapshotPreview = computed(() => {
  if (!autoSnapshot.value) return "未启用";
  try {
    const firstBoundary = zonedInputToIso(anchor.value, timezone.value);
    const next = new Date(new Date(firstBoundary).getTime() + safeInterval.value * 24 * 60 * 60 * 1000);
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone.value,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    }).format(next);
  } catch {
    return "保存后计算";
  }
});

const savedNextSnapshotLabel = computed(() => {
  if (!nextSnapshotAt.value) return "尚未安排";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone.value,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit",
    }).format(new Date(nextSnapshotAt.value));
  } catch {
    return nextSnapshotAt.value;
  }
});

onMounted(() => void loadSettings());
watch(id, () => void loadSettings());
</script>

<template>
  <div class="page-wrap">
    <PageHeader :eyebrow="'角色管理 / ' + character.name + ' / 记忆设置'" title="记忆周期设置" description="控制角色多久归档一次阶段记忆。设置保存到 PostgreSQL，由 Scheduler 生成到期任务，再由 Worker 调用角色模型完成 AI 提炼。">
      <template #actions><el-button @click="navigateTo('/characters/' + character.id)"><el-icon><ArrowLeft /></el-icon>返回驾驶舱</el-button></template>
    </PageHeader>

    <div class="settings-grid">
      <div>
        <section v-loading="loading" class="surface form-section">
          <div class="settings-section-head"><div><div class="form-title">自动归档规则 <span class="pill pill-purple">核心设置</span></div><p class="section-description">每完成一个周期，就为这个记忆范围生成阶段总结。</p></div><el-icon class="section-icon"><Calendar /></el-icon></div>
          <div class="interval-box">
            <div class="interval-top"><div><div class="interval-label">快照生成间隔</div><p class="form-help">周期可设为 1–365 天；默认值为 8 天。</p></div><div class="interval-input"><el-input-number v-model="interval" :min="1" :max="365" :controls="true" size="large" /><span>天 / 次</span></div></div>
            <el-slider v-model="interval" :min="1" :max="30" :show-tooltip="true" />
            <div class="slider-labels"><span>1 天</span><span>15 天</span><span>30 天</span></div>
            <div class="quick-days"><el-button v-for="day in [1,3,7,8,14,30]" :key="day" :type="safeInterval === day ? 'primary' : 'default'" plain @click="interval = day">{{ day }} 天</el-button></div>
          </div>
          <el-form label-position="top" style="margin-top:24px">
            <div class="form-grid">
              <el-form-item label="记忆时区"><el-select v-model="timezone" style="width:100%"><el-option label="中国标准时间（Asia/Shanghai）" value="Asia/Shanghai" /><el-option label="协调世界时（UTC）" value="UTC" /><el-option label="美国太平洋时间（America/Los_Angeles）" value="America/Los_Angeles" /></el-select></el-form-item>
              <el-form-item label="周期启用锚点"><el-date-picker v-model="anchor" type="datetime" value-format="YYYY-MM-DDTHH:mm:ss" placeholder="选择周期起始时间" style="width:100%" /></el-form-item>
              <el-form-item label="原始消息保留期限"><el-select v-model="retention" style="width:100%"><el-option label="30 天" :value="30" /><el-option label="90 天" :value="90" /><el-option label="180 天" :value="180" /><el-option label="永久保留" :value="0" /></el-select><div class="form-help">该期限独立于快照周期；清理任务尚未接入 Worker。</div></el-form-item>
              <el-form-item label="修改何时生效"><el-radio-group v-model="effectivePolicy"><el-radio value="下一个周期生效">下一个周期</el-radio><el-radio value="立即重算">立即重算</el-radio></el-radio-group></el-form-item>
            </div>
          </el-form>
          <el-divider />
          <div class="toggle-row"><div><strong>自动生成周期快照</strong><p class="form-help">关闭后保留历史归档，停止自动创建新的周期快照。</p></div><el-switch v-model="autoSnapshot" /></div>
          <div class="form-actions"><el-button @click="resetSettings"><el-icon><RefreshLeft /></el-icon>恢复默认</el-button><el-button type="primary" :loading="saving" @click="saveSettings"><el-icon><Select /></el-icon>保存设置</el-button></div>
        </section>
      </div>

      <aside class="settings-side">
        <section class="surface panel">
          <div class="side-icon"><el-icon><Lock /></el-icon></div>
          <h2 class="section-heading">记忆与归档说明</h2>
          <p class="section-description" style="margin-top:9px">这些规则影响角色如何归档阶段经历，不会自动清理历史快照。</p>
          <div class="rule-item"><span class="rule-number">01</span><div><strong>快照是阶段记录</strong><p>每隔 N 天生成一份总结，不代表只保留最近 N 天的消息。</p></div></div>
          <div class="rule-item"><span class="rule-number">02</span><div><strong>历史版本不会覆盖</strong><p>手动重新生成会产生新版本，旧版本仍可查看与追溯。</p></div></div>
          <div class="rule-item"><span class="rule-number">03</span><div><strong>时区影响计划时间</strong><p>计划会基于角色设定的时区和启用锚点计算。</p></div></div>
        </section>
        <section class="surface panel" style="margin-top:16px">
          <SectionTitle title="当前计划预览" description="保存后写入本地数据库" />
          <div class="metric-row"><span>归档间隔</span><span class="metric-value">{{ safeInterval }} 天</span></div>
          <div class="metric-row"><span>执行状态</span><span class="pill" :class="autoSnapshot ? 'pill-green' : 'pill-gray'">{{ autoSnapshot ? '自动归档开启' : '自动归档已暂停' }}</span></div>
          <div class="metric-row"><span>生效策略</span><span class="metric-value">{{ effectivePolicy }}</span></div>
          <div class="metric-row"><span>下次归档（按当前表单）</span><span class="metric-value">{{ nextSnapshotPreview }}</span></div>
          <div class="metric-row"><span>数据库中的计划时间</span><span class="metric-value">{{ savedNextSnapshotLabel }}</span></div>
          <div class="info-callout" style="margin-top:15px"><el-icon><InfoFilled /></el-icon><span>计划时间以角色时区计算。要自动执行，请保持 Scheduler 与 Worker 进程运行；如果没有配置角色模型 API，任务会保留在队列中，不会消耗掉。</span></div>
        </section>
      </aside>
    </div>
    <p class="footer-note">记忆周期、时区、锚点与原始消息保留期限已写入数据库。周期快照由 Scheduler 排队、Worker 执行；原始消息自动清理尚未接入。</p>
  </div>
</template>

<style scoped>
.settings-grid{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:18px;align-items:start}
.settings-section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:15px}.form-title{display:flex;align-items:center;gap:9px;color:#3e4963;font-size:14px;font-weight:800}.section-icon{font-size:22px;color:#8176e7}
.interval-box{margin-top:24px;padding:19px;border:1px solid #e8e5ff;border-radius:15px;background:linear-gradient(90deg,#f8f7ff,#f7faff)}
.interval-top{display:flex;align-items:center;justify-content:space-between;gap:15px}.interval-label{color:#7168c7;font-size:11px;font-weight:800}.interval-input{display:flex;align-items:center;gap:10px}.interval-input span{color:#8982ca;font-size:11px;font-weight:700}
.slider-labels{display:flex;justify-content:space-between;margin-top:-6px;color:#a5a8c2;font-size:9px}.quick-days{display:flex;flex-wrap:wrap;gap:8px;margin-top:17px}
.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 18px}.toggle-row{display:flex;align-items:center;justify-content:space-between;gap:15px;padding:8px 0}.toggle-row strong{color:#47526d;font-size:12px}.form-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}
.settings-side .panel{padding:20px}.side-icon{display:flex;width:42px;height:42px;align-items:center;justify-content:center;border-radius:13px;background:#f0eeff;color:#786be4;font-size:20px;margin-bottom:15px}
.rule-item{display:flex;gap:10px;margin-top:20px}.rule-number{display:flex;width:26px;height:26px;flex:0 0 auto;align-items:center;justify-content:center;border-radius:8px;background:#f1efff;color:#7769e2;font-size:10px;font-weight:850}
.rule-item strong{color:#4a5570;font-size:11px}.rule-item p{margin-top:5px;color:#929cb0;font-size:10px;line-height:1.8}
@media(max-width:1050px){.settings-grid{grid-template-columns:1fr}.settings-side{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:15px}.settings-side>.surface{margin-top:0!important}}
@media(max-width:640px){.form-grid{grid-template-columns:1fr}.settings-side{grid-template-columns:1fr}.interval-top{align-items:flex-start;flex-direction:column}}
</style>
