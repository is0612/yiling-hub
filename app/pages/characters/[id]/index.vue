<script setup lang="ts">
import { ArrowRight, Cpu, Calendar, Files, Search, Setting, MagicStick } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { initialCharacters, type Character, type Snapshot, type TimelineEntry, type TimelineType } from "~/utils/mock-data";

const route = useRoute();
const id = computed(() => String(route.params.id || ""));
const currentCharacter = ref<Character | null>(null);
const snapshots = ref<Snapshot[]>([]);
const snapshotCreating = ref(false);
const timelineEntries = ref<TimelineEntry[]>([]);
const timelineLoading = ref(false);
const recordedMessageCount = computed(() => timelineEntries.value.filter((entry) => entry.type === "message").length);
const recordedEventCount = computed(() => timelineEntries.value.filter((entry) => entry.type === "event").length);
const commitmentCount = computed(() => timelineEntries.value.filter((entry) => entry.type === "memory" && entry.tag === "承诺与约定").length);
const channelOptions = computed(() => [...new Set(timelineEntries.value.map((entry) => entry.channel).filter((channel) => channel !== "全部渠道"))].sort());
const character = computed(() => currentCharacter.value || {
  ...initialCharacters[0], id: id.value, name: "角色加载中", alias: "数据库档案",
  description: "正在读取角色数据。", status: "已暂停" as const,
  channels: [], intervalDays: 8, nextSnapshot: "尚未计划", memoryCount: 0, latestSnapshot: "暂无快照",
});
const activeFilter = ref("全部记录");
const channelFilter = ref("全部渠道");
const query = ref("");
const editOpen = ref(false);
const draftName = ref("");
const draftPersonality = ref("");
const filterOptions = [
  { label: "全部记录", type: undefined },
  { label: "对话记录", type: "message" as TimelineType },
  { label: "重要事件", type: "event" as TimelineType },
  { label: "长期记忆", type: "memory" as TimelineType },
  { label: "周期快照", type: "snapshot" as TimelineType },
];
const filteredEntries = computed(() => {
  const type = filterOptions.find((option) => option.label === activeFilter.value)?.type;
  return timelineEntries.value.filter((entry) => {
    const typeMatches = !type || entry.type === type;
    const channelMatches = channelFilter.value === "全部渠道" || entry.channel === channelFilter.value || entry.channel === "全部渠道";
    const textMatches = !query.value || `${entry.title} ${entry.summary} ${entry.source}`.toLowerCase().includes(query.value.toLowerCase());
    return typeMatches && channelMatches && textMatches;
  });
});

async function loadTimeline() {
  timelineLoading.value = true;
  try {
    timelineEntries.value = await $fetch<TimelineEntry[]>(`/api/characters/${encodeURIComponent(id.value)}/timeline`);
  } catch {
    timelineEntries.value = [];
    ElMessage.error("记忆时间线读取失败，请检查本地开发服务器日志。");
  } finally {
    timelineLoading.value = false;
  }
}

async function loadSnapshots() {
  try {
    snapshots.value = await $fetch<Snapshot[]>(`/api/characters/${encodeURIComponent(id.value)}/snapshots`);
  } catch {
    snapshots.value = [];
    ElMessage.error("快照数据加载失败，请确认本地数据库已迁移。");
  }
}

async function loadCharacter() {
  try {
    currentCharacter.value = await $fetch<Character>(`/api/characters/${encodeURIComponent(id.value)}`);
    await Promise.all([loadSnapshots(), loadTimeline()]);
  } catch {
    currentCharacter.value = null;
    snapshots.value = [];
    timelineEntries.value = [];
    ElMessage.error("加载角色失败，请确认角色仍存在且本地数据库已初始化。");
  }
}

watch([editOpen, character], ([open]) => {
  if (open) {
    draftName.value = character.value.name;
    draftPersonality.value = character.value.personality || "";
  }
});

async function saveProfile() {
  try {
    const updated = await $fetch<Character>(`/api/characters/${encodeURIComponent(id.value)}`, {
      method: "PATCH",
      body: {
        name: draftName.value.trim() || character.value.name,
        personality: draftPersonality.value.trim() || character.value.personality,
      },
    });
    currentCharacter.value = updated;
    editOpen.value = false;
    ElMessage.success("角色信息已保存到本地数据库。");
  } catch (error) {
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : "保存失败，请检查数据库连接。";
    ElMessage.error(message);
  }
}

function toneFor(tagTone: string) {
  return ({ green: "pill-green", purple: "pill-purple", blue: "pill-blue", amber: "pill-amber", gray: "pill-gray" } as Record<string, string>)[tagTone] || "pill-gray";
}
function markerFor(type: TimelineType) {
  return type === "message" ? "对" : type === "memory" ? "忆" : type === "snapshot" ? "档" : "事";
}
async function manualSnapshot() {
  if (snapshotCreating.value) return;
  snapshotCreating.value = true;
  try {
    await $fetch(`/api/characters/${encodeURIComponent(id.value)}/snapshots`, { method: "POST" });
    await Promise.all([loadSnapshots(), loadTimeline()]);
    ElMessage.success("快照已保存到数据库。当前仅归档已保存的长期记忆条目，尚未调用大模型。");
  } catch (error) {
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : "快照保存失败，请检查数据库连接。";
    ElMessage.error(message);
  } finally {
    snapshotCreating.value = false;
  }
}

onMounted(() => void loadCharacter());
watch(id, () => void loadCharacter());
</script>

<template>
  <div class="page-wrap">
    <PageHeader eyebrow="工作空间 / 角色管理 / 记忆驾驶舱" title="记忆驾驶舱" description="查看角色档案与已保存的记忆活动。时间线读取数据库中的对话消息、长期记忆与快照；聊天渠道导入和模型生成仍在后续阶段接入。">
      <template #actions><el-button @click="editOpen = true"><el-icon><Setting /></el-icon>编辑角色</el-button><el-button type="primary" :loading="snapshotCreating" @click="manualSnapshot"><el-icon><MagicStick /></el-icon>手动归档</el-button></template>
    </PageHeader>

    <div class="info-callout" style="margin-bottom:20px">
      <div class="avatar" style="width:34px;height:34px;border-radius:10px">{{ character.avatar }}</div>
      <div style="flex:1"><strong style="color:#5f5b99">正在查看角色：{{ character.name }}</strong><div>快照周期 {{ character.intervalDays }} 天 · 记忆条目 {{ character.memoryCount }} 条</div></div>
      <span class="pill pill-gray"><i class="env-dot" />仅展示已保存的数据库记录</span>
    </div>

    <div class="cockpit-grid">
      <aside class="surface panel">
        <div style="display:flex;align-items:center;gap:12px">
          <div class="avatar" :class="'avatar-' + character.avatarTone" style="width:56px;height:56px;font-size:20px">{{ character.avatar }}</div>
          <div class="character-info"><div class="character-name">{{ character.name }}</div><div class="character-alias">{{ character.alias }}</div><span class="pill" :class="character.status === '运行中' ? 'pill-green' : 'pill-amber'" style="margin-top:7px">{{ character.status }}</span></div>
        </div>
        <p class="profile-description">{{ character.description }}</p>
        <el-divider />
        <div class="metric-row"><span>长期记忆</span><span class="metric-value">{{ character.memoryCount }} 条</span></div>
        <div class="metric-row"><span>归档周期</span><span class="metric-value">{{ character.intervalDays }} 天</span></div>
        <div class="metric-row"><span>最近快照</span><span class="metric-value">{{ character.latestSnapshot }}</span></div>
        <div class="metric-row"><span>绑定渠道</span><span class="metric-value">{{ character.channels.length || 0 }} 个</span></div>
        <div class="section-content"><SectionTitle title="快捷操作" description="角色档案、快照与时间线已读取数据库中存在的记录" /></div>
        <div class="quick-actions">
          <el-button style="width:100%" plain @click="navigateTo('/characters/' + character.id + '/settings/memory')"><el-icon><Calendar /></el-icon>记忆周期设置</el-button>
          <el-button style="width:100%" plain @click="navigateTo('/characters/' + character.id + '/snapshots')"><el-icon><Files /></el-icon>查看全部快照</el-button>
        </div>
      </aside>

      <section class="surface panel timeline-panel">
        <SectionTitle title="角色记忆时间线" description="显示数据库中已保存的对话、长期记忆、事件与快照记录" />
        <div class="timeline-filters">
          <el-input v-model="query" clearable placeholder="搜索时间线内容……" style="min-width:170px;flex:1"><template #prefix><el-icon><Search /></el-icon></template></el-input>
          <el-select v-model="channelFilter" style="width:136px"><el-option label="全部渠道" value="全部渠道" /><el-option v-for="channel in channelOptions" :key="channel" :label="channel" :value="channel" /></el-select>
        </div>
        <el-tabs v-model="activeFilter" class="memory-tabs">
          <el-tab-pane v-for="option in filterOptions" :key="option.label" :label="option.label" :name="option.label" />
        </el-tabs>
        <div class="timeline">
          <div v-if="timelineLoading" class="empty-state">正在加载已保存的时间线记录……</div>
          <template v-else>
            <article v-for="entry in filteredEntries" :key="entry.id" class="timeline-item">
              <div class="timeline-marker" :class="toneFor(entry.tagTone)">{{ markerFor(entry.type) }}</div>
              <div class="timeline-content">
                <div class="timeline-heading"><span class="timeline-title">{{ entry.title }}</span><span class="muted-note">{{ entry.time }}</span></div>
                <p class="timeline-summary">{{ entry.summary }}</p>
                <div class="timeline-meta"><span class="pill" :class="toneFor(entry.tagTone)">{{ entry.tag }}</span><span>{{ entry.channel }}</span><span>{{ entry.source }}</span></div>
              </div>
            </article>
            <div v-if="!filteredEntries.length" class="empty-state">{{ timelineEntries.length ? "没有匹配的时间线记录，试试修改筛选条件。" : "暂无已保存的时间线记录。接入聊天消息或保存长期记忆后，这里会显示对应记录；生成的快照也会显示在这里。" }}</div>
          </template>
        </div>
      </section>

      <aside class="surface panel snapshot-side">
        <SectionTitle title="记忆状态" description="当前角色的阶段归档概况" />
        <div class="memory-score"><div class="memory-score-ring"><span>—</span></div><div><strong>自动归档状态</strong><p>自动周期调度将在后续阶段接入</p></div></div>
        <el-divider />
        <div class="metric-row"><span>已记录对话消息</span><span class="metric-value">{{ recordedMessageCount }} 条</span></div>
        <div class="metric-row"><span>已记录平台事件</span><span class="metric-value">{{ recordedEventCount }} 项</span></div>
        <div class="metric-row"><span>承诺与约定</span><span class="metric-value">{{ commitmentCount }} 项</span></div>
        <div class="section-content"><SectionTitle title="最近快照" description="保留版本以便回溯" /></div>
        <div v-for="snapshot in snapshots.slice(0,2)" :key="snapshot.id" class="recent-snapshot">
          <div class="recent-snapshot-top"><span>第 {{ snapshot.number }} 份快照</span><span class="muted-note">v{{ snapshot.version }}</span></div>
          <p>{{ snapshot.summary }}</p>
          <el-button link type="primary" @click="navigateTo('/characters/' + character.id + '/snapshots')">打开归档 <el-icon class="el-icon--right"><ArrowRight /></el-icon></el-button>
        </div>
        <div v-if="!snapshots.length" class="empty-state">还没有保存的快照。</div>
      </aside>
    </div>

    <el-dialog v-model="editOpen" title="编辑角色" width="min(560px, 94vw)">
      <el-form label-position="top">
        <el-form-item label="角色名称"><el-input v-model="draftName" maxlength="40" /></el-form-item>
        <el-form-item label="基础人设"><el-input v-model="draftPersonality" type="textarea" :rows="5" /></el-form-item>
        <div class="info-callout"><el-icon><Cpu /></el-icon><span>角色资料会写入本地数据库。聊天渠道导入和真实模型生成仍未接入，时间线只展示已经保存的记录。</span></div>
      </el-form>
      <template #footer><el-button @click="editOpen = false">取消</el-button><el-button type="primary" @click="saveProfile">保存修改</el-button></template>
    </el-dialog>
  </div>
</template>

<style scoped>
.cockpit-grid{display:grid;grid-template-columns:250px minmax(0,1fr) 280px;gap:15px;align-items:start}
.profile-description{margin:16px 0;color:#728098;font-size:11px;line-height:1.8}
.timeline-filters{display:flex;gap:9px;margin-top:17px}
.memory-tabs{margin-top:9px}.timeline-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:9px}
.timeline-marker.pill-green{background:#e8f8f1}.timeline-marker.pill-purple{background:#f0eeff}.timeline-marker.pill-blue{background:#eef5ff}.timeline-marker.pill-amber{background:#fff5e4}.timeline-marker.pill-gray{background:#f1f3f8}
.memory-score{display:flex;align-items:center;gap:13px;margin-top:22px}.memory-score-ring{display:flex;width:65px;height:65px;flex:0 0 auto;align-items:center;justify-content:center;border:6px solid #e4e0ff;border-right-color:#8678ed;border-top-color:#8678ed;border-radius:50%;color:#7062df;font-size:16px;font-weight:850}
.memory-score strong{color:#47526d;font-size:12px}.memory-score p{margin-top:6px;color:#969fb2;font-size:10px}
.recent-snapshot{margin-top:12px;padding:12px;border:1px solid #eceef5;border-radius:12px}.recent-snapshot-top{display:flex;justify-content:space-between;color:#58637d;font-size:11px;font-weight:800}.recent-snapshot p{margin:8px 0;color:#7d889f;font-size:10px;line-height:1.8}
@media(max-width:1350px){.cockpit-grid{grid-template-columns:230px minmax(0,1fr)}.snapshot-side{grid-column:1/-1;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.snapshot-side>.section-title{grid-column:1/-1}}
@media(max-width:800px){.cockpit-grid{grid-template-columns:1fr}.snapshot-side{grid-column:auto;display:block}.timeline-filters{flex-wrap:wrap}.timeline-filters .el-select{width:100%!important}}
</style>
