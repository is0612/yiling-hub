<script setup lang="ts">
import { ArrowRight, Cpu, Calendar, Files, Search, Setting, MagicStick, Delete } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { initialCharacters, type Character, type Snapshot, type TimelineEntry, type TimelineType } from "~/utils/mock-data";

type MemoryCategory = "FACT" | "PREFERENCE" | "RELATIONSHIP" | "COMMITMENT" | "GOAL" | "EVENT" | "SUMMARY" | "OTHER";
type MemoryDetail = {
  id: string;
  category: MemoryCategory;
  content: string;
  sourceMessageId: string | null;
  sourceSnapshotId: string | null;
  sourceMessage: {
    id: string;
    role: string;
    eventType: string;
    content: string;
    occurredAt: string;
    conversation: { id: string; title: string | null };
  } | null;
  sourceSnapshot: {
    id: string;
    summary: string;
    periodStart: string;
    periodEnd: string;
    version: number;
    status: string;
  } | null;
};
type RecycleBinEntry = {
  id: string;
  category: MemoryCategory;
  content: string;
  statusBeforeTrash: "ACTIVE" | "SUPERSEDED" | "ARCHIVED" | "INVALIDATED" | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
const memoryCategoryOptions: Array<{ label: string; value: MemoryCategory }> = [
  { label: "事实记忆", value: "FACT" },
  { label: "偏好记忆", value: "PREFERENCE" },
  { label: "关系记忆", value: "RELATIONSHIP" },
  { label: "承诺与约定", value: "COMMITMENT" },
  { label: "目标记忆", value: "GOAL" },
  { label: "事件记忆", value: "EVENT" },
  { label: "记忆摘要", value: "SUMMARY" },
  { label: "其他", value: "OTHER" },
];

const route = useRoute();
const id = computed(() => String(route.params.id || ""));
const currentCharacter = ref<Character | null>(null);
const snapshots = ref<Snapshot[]>([]);
const snapshotCreating = ref(false);
const memoryDialogOpen = ref(false);
const memorySaving = ref(false);
const draftMemoryCategory = ref<MemoryCategory>("FACT");
const draftMemoryContent = ref("");
const draftMemoryScope = ref<"character" | "private">("character");
const memoryEditDialogOpen = ref(false);
const memoryEditLoading = ref(false);
const memoryEditSaving = ref(false);
const editingMemoryId = ref("");
const draftEditMemoryCategory = ref<MemoryCategory>("FACT");
const draftEditMemoryContent = ref("");
const editingMemorySource = ref<MemoryDetail["sourceMessage"]>(null);
const editingMemorySnapshot = ref<MemoryDetail["sourceSnapshot"]>(null);
const conversationDialogOpen = ref(false);
const conversationSaving = ref(false);
const draftConversationTitle = ref("");
const draftTranscript = ref("");
const timelineEntries = ref<TimelineEntry[]>([]);
const timelineLoading = ref(false);
const recycleBinOpen = ref(false);
const recycleBinLoading = ref(false);
const recycleBinEntries = ref<RecycleBinEntry[]>([]);
const recycleBinBusyIds = ref<string[]>([]);
const recordedMessageCount = computed(() => timelineEntries.value.filter((entry) => entry.type === "message").length);
const recordedEventCount = computed(() => timelineEntries.value.filter((entry) => entry.type === "event").length);
const commitmentCount = computed(() => timelineEntries.value.filter((entry) => entry.type === "memory" && entry.title === "承诺与约定" && entry.tag === "长期记忆").length);
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

async function saveMemory() {
  if (memorySaving.value) return;
  if (!draftMemoryContent.value.trim()) {
    ElMessage.warning("请先填写记忆内容。");
    return;
  }

  memorySaving.value = true;
  try {
    await $fetch(`/api/characters/${encodeURIComponent(id.value)}/memories`, {
      method: "POST",
      body: {
        category: draftMemoryCategory.value,
        content: draftMemoryContent.value.trim(),
        scope: draftMemoryScope.value,
      },
    });
    memoryDialogOpen.value = false;
    draftMemoryContent.value = "";
    draftMemoryCategory.value = "FACT";
    draftMemoryScope.value = "character";
    await loadCharacter();
    ElMessage.success("长期记忆已保存到数据库，并加入时间线。");
  } catch (error) {
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : error instanceof Error ? error.message : "保存记忆失败，请检查数据库连接。";
    ElMessage.error(message);
  } finally {
    memorySaving.value = false;
  }
}

async function openMemoryEditor(entry: TimelineEntry) {
  const memoryId = entry.id.startsWith("memory:") ? entry.id.slice("memory:".length) : "";
  if (!memoryId) return;

  editingMemoryId.value = memoryId;
  editingMemorySource.value = null;
  editingMemorySnapshot.value = null;
  memoryEditDialogOpen.value = true;
  memoryEditLoading.value = true;
  try {
    const memory = await $fetch<MemoryDetail>(`/api/memories/${encodeURIComponent(memoryId)}`);
    draftEditMemoryCategory.value = memory.category;
    draftEditMemoryContent.value = memory.content;
    editingMemorySource.value = memory.sourceMessage;
    editingMemorySnapshot.value = memory.sourceSnapshot;
  } catch (error) {
    memoryEditDialogOpen.value = false;
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : error instanceof Error ? error.message : "读取长期记忆失败。";
    ElMessage.error(message);
  } finally {
    memoryEditLoading.value = false;
  }
}

async function saveEditedMemory() {
  if (memoryEditSaving.value || !editingMemoryId.value) return;
  if (!draftEditMemoryContent.value.trim()) {
    ElMessage.warning("记忆内容不能为空。");
    return;
  }

  memoryEditSaving.value = true;
  try {
    await $fetch(`/api/memories/${encodeURIComponent(editingMemoryId.value)}`, {
      method: "PATCH",
      body: {
        category: draftEditMemoryCategory.value,
        content: draftEditMemoryContent.value.trim(),
      },
    });
    memoryEditDialogOpen.value = false;
    await loadCharacter();
    ElMessage.success("长期记忆已更新。已有快照会保留生成时的历史内容。");
  } catch (error) {
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : error instanceof Error ? error.message : "更新长期记忆失败。";
    ElMessage.error(message);
  } finally {
    memoryEditSaving.value = false;
  }
}

async function setMemoryStatus(entry: TimelineEntry, status: "active" | "archived" | "invalidated") {
  const memoryId = entry.id.startsWith("memory:") ? entry.id.slice("memory:".length) : "";
  if (!memoryId) return;

  const actionLabel = status === "archived" ? "归档" : status === "invalidated" ? "标记失效" : "恢复为有效";
  try {
    await ElMessageBox.confirm(
      `确定将这条记忆“${actionLabel}”吗？此操作会保留历史记录，不会删除已有快照。`,
      "维护长期记忆",
      { confirmButtonText: "确认", cancelButtonText: "取消", type: "warning" },
    );
  } catch {
    return;
  }

  try {
    await $fetch(`/api/memories/${encodeURIComponent(memoryId)}`, {
      method: "PATCH",
      body: { status },
    });
    await loadCharacter();
    ElMessage.success(`记忆已${actionLabel}。`);
  } catch (error) {
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : error instanceof Error ? error.message : "更新记忆状态失败。";
    ElMessage.error(message);
  }
}

function memoryStatusText(status: string | null | undefined) {
  const labels: Record<string, string> = {
    ACTIVE: "有效", SUPERSEDED: "已被替代", ARCHIVED: "已归档", INVALIDATED: "已失效", TRASHED: "回收站",
  };
  return labels[status || "ACTIVE"] || "有效";
}

function formatRecycleDate(value: string | null) {
  if (!value) return "时间未知";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "时间未知"
    : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

async function loadRecycleBin() {
  recycleBinLoading.value = true;
  try {
    recycleBinEntries.value = await $fetch<RecycleBinEntry[]>(
      `/api/characters/${encodeURIComponent(id.value)}/memories/trash`,
    );
  } catch {
    recycleBinEntries.value = [];
    ElMessage.error("回收站加载失败，请检查本地开发服务器日志。");
  } finally {
    recycleBinLoading.value = false;
  }
}

async function openRecycleBin() {
  recycleBinOpen.value = true;
  await loadRecycleBin();
}

async function moveMemoryToTrash(entry: TimelineEntry) {
  const memoryId = entry.id.startsWith("memory:") ? entry.id.slice("memory:".length) : "";
  if (!memoryId) return;
  try {
    await ElMessageBox.confirm(
      "这条记忆将从主时间线和当前长期记忆集合中移出，但不会被立即永久删除。你可以在回收站中恢复。已有快照会保留生成时的历史副本。",
      "移入记忆回收站",
      { confirmButtonText: "移入回收站", cancelButtonText: "取消", type: "warning" },
    );
  } catch { return; }
  try {
    await $fetch(`/api/memories/${encodeURIComponent(memoryId)}/trash`, { method: "POST" });
    await loadCharacter();
    if (recycleBinOpen.value) await loadRecycleBin();
    ElMessage.success("记忆已移入回收站，可随时恢复。");
  } catch (error) {
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : error instanceof Error ? error.message : "移入回收站失败。";
    ElMessage.error(message);
  }
}

async function restoreTrashedMemory(memory: RecycleBinEntry) {
  if (recycleBinBusyIds.value.includes(memory.id)) return;
  recycleBinBusyIds.value.push(memory.id);
  try {
    await $fetch(`/api/memories/${encodeURIComponent(memory.id)}/restore`, { method: "POST" });
    await Promise.all([loadRecycleBin(), loadCharacter()]);
    ElMessage.success(`记忆已恢复为“${memoryStatusText(memory.statusBeforeTrash)}”状态。`);
  } catch (error) {
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : error instanceof Error ? error.message : "恢复记忆失败。";
    ElMessage.error(message);
  } finally {
    recycleBinBusyIds.value = recycleBinBusyIds.value.filter((id) => id !== memory.id);
  }
}

async function permanentlyDeleteMemory(memory: RecycleBinEntry) {
  if (recycleBinBusyIds.value.includes(memory.id)) return;
  try {
    await ElMessageBox.confirm(
      "这会永久删除当前长期记忆条目，且无法从回收站恢复。为保护历史追溯，已有快照中的生成时副本和来源记录仍会保留；因此历史快照里仍可能出现这段内容。",
      "永久删除记忆条目",
      { confirmButtonText: "永久删除条目", cancelButtonText: "取消", type: "error" },
    );
  } catch { return; }
  recycleBinBusyIds.value.push(memory.id);
  try {
    const result = await $fetch<{ preservedSnapshotReferences: number }>(
      `/api/memories/${encodeURIComponent(memory.id)}`,
      { method: "DELETE" },
    );
    await Promise.all([loadRecycleBin(), loadCharacter()]);
    ElMessage.success(`当前记忆条目已永久删除；保留了 ${result.preservedSnapshotReferences} 条历史来源记录，既有快照未被改写。`);
  } catch (error) {
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : error instanceof Error ? error.message : "永久删除失败。";
    ElMessage.error(message);
  } finally {
    recycleBinBusyIds.value = recycleBinBusyIds.value.filter((id) => id !== memory.id);
  }
}

async function saveConversation() {
  if (conversationSaving.value) return;

  const lines = draftTranscript.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) {
    ElMessage.warning("请至少输入一条对话消息。");
    return;
  }
  if (lines.length > 200) {
    ElMessage.warning("一次最多录入 200 条消息。");
    return;
  }

  let messages: Array<{ role: "USER" | "ASSISTANT"; content: string }>;
  try {
    messages = lines.map((line, index) => {
      const match = line.match(/^(用户|我|user|角色|助手|assistant|character)\s*[:：]\s*(.*)$/i);
      if (!match) {
        throw new Error(`第 ${index + 1} 行格式不正确，请使用“用户：内容”或“角色：内容”。`);
      }
      const content = match[2]?.trim() ?? "";
      if (!content) throw new Error(`第 ${index + 1} 行消息内容不能为空。`);
      const speaker = (match[1] ?? "").toLowerCase();
      const role = ["用户", "我", "user"].includes(speaker) ? "USER" : "ASSISTANT";
      return { role, content };
    });
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "对话格式不正确。");
    return;
  }

  conversationSaving.value = true;
  try {
    const result = await $fetch<{ messageCount: number; timestampsEstimated: boolean }>(
      `/api/characters/${encodeURIComponent(id.value)}/conversations/import`,
      {
        method: "POST",
        body: { title: draftConversationTitle.value.trim(), messages },
      },
    );
    conversationDialogOpen.value = false;
    draftConversationTitle.value = "";
    draftTranscript.value = "";
    await loadCharacter();
    ElMessage.success(`已保存 ${result.messageCount} 条对话消息并刷新时间线。${result.timestampsEstimated ? "消息时间按录入顺序估算。" : ""}`);
  } catch (error) {
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : error instanceof Error ? error.message : "录入对话失败，请检查数据库连接。";
    ElMessage.error(message);
  } finally {
    conversationSaving.value = false;
  }
}

function toneFor(tagTone: string) {
  return ({ green: "pill-green", purple: "pill-purple", blue: "pill-blue", amber: "pill-amber", gray: "pill-gray" } as Record<string, string>)[tagTone] || "pill-gray";
}
function markerFor(type: TimelineType) {
  return type === "message" ? "对" : type === "memory" ? "忆" : type === "snapshot" ? "档" : "事";
}
function formatSourceTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date)
    : value;
}
async function manualSnapshot() {
  if (snapshotCreating.value) return;
  snapshotCreating.value = true;
  try {
    await $fetch(`/api/characters/${encodeURIComponent(id.value)}/snapshots`, { method: "POST" });
    await Promise.all([loadSnapshots(), loadTimeline()]);
    ElMessage.success("快照已保存。已关联周期内的消息/事件与长期记忆来源；尚未调用大模型生成总结。");
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
    <PageHeader eyebrow="工作空间 / 角色管理 / 记忆驾驶舱" title="记忆驾驶舱" description="查看角色对话、AI 周期总结与长期记忆。配置服务端模型并启用自动归档后，周期 Worker 会提炼事实与偏好变化，并保留原始消息来源。">
      <template #actions><el-button @click="editOpen = true"><el-icon><Setting /></el-icon>编辑角色</el-button><el-button @click="memoryDialogOpen = true">新增长期记忆</el-button><el-button @click="conversationDialogOpen = true">录入对话</el-button><el-button type="primary" :loading="snapshotCreating" @click="manualSnapshot"><el-icon><MagicStick /></el-icon>手动归档</el-button></template>
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
          <el-button style="width:100%" plain @click="openRecycleBin"><el-icon><Delete /></el-icon>记忆回收站</el-button>
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
                <div v-if="entry.type === 'memory'" class="memory-actions">
                  <el-button link type="primary" size="small" @click="openMemoryEditor(entry)">编辑</el-button>
                  <template v-if="entry.tag === '长期记忆'">
                    <el-button link size="small" @click="setMemoryStatus(entry, 'archived')">归档</el-button>
                    <el-button link type="danger" size="small" @click="setMemoryStatus(entry, 'invalidated')">标记失效</el-button>
                  </template>
                  <el-button v-else link type="success" size="small" @click="setMemoryStatus(entry, 'active')">恢复有效</el-button>
                  <el-button link type="danger" size="small" @click="moveMemoryToTrash(entry)">移入回收站</el-button>
                </div>
              </div>
            </article>
            <div v-if="!filteredEntries.length" class="empty-state">{{ timelineEntries.length ? "没有匹配的时间线记录，试试修改筛选条件。" : "暂无已保存的时间线记录。接入聊天消息或保存长期记忆后，这里会显示对应记录；生成的快照也会显示在这里。" }}</div>
          </template>
        </div>
      </section>

      <aside class="surface panel snapshot-side">
        <SectionTitle title="记忆状态" description="当前角色的阶段归档概况" />
        <div class="memory-score"><div class="memory-score-ring"><span>—</span></div><div><strong>自动归档状态</strong><p>启用自动快照并配置模型后，将自动总结周期对话并维护长期记忆</p></div></div>
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

    <el-dialog v-model="memoryDialogOpen" title="新增长期记忆" width="min(560px, 94vw)">
      <el-form label-position="top">
        <el-form-item label="记忆分类">
          <el-select v-model="draftMemoryCategory" style="width:100%">
            <el-option v-for="option in memoryCategoryOptions" :key="option.value" :label="option.label" :value="option.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="记忆范围">
          <el-radio-group v-model="draftMemoryScope">
            <el-radio-button value="character">角色全局</el-radio-button>
            <el-radio-button value="private">我的私人</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="记忆内容">
          <el-input v-model="draftMemoryContent" type="textarea" :rows="5" maxlength="12000" show-word-limit placeholder="例如：用户更喜欢简洁、直接的解释。" />
        </el-form-item>
        <div class="info-callout"><span>保存后会写入 PostgreSQL，并立即出现在角色记忆时间线中。角色全局记忆在本角色所有对话中都可检索；私人记忆只在你自己和这个角色对话时使用，不会混入其他用户。</span></div>
      </el-form>
      <template #footer>
        <el-button @click="memoryDialogOpen = false">取消</el-button>
        <el-button type="primary" :loading="memorySaving" @click="saveMemory">保存记忆</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="memoryEditDialogOpen" title="编辑长期记忆" width="min(560px, 94vw)" :close-on-click-modal="!memoryEditSaving">
      <div v-if="memoryEditLoading" class="empty-state">正在加载记忆详情……</div>
      <el-form v-else label-position="top">
        <el-form-item label="记忆分类">
          <el-select v-model="draftEditMemoryCategory" style="width:100%">
            <el-option v-for="option in memoryCategoryOptions" :key="option.value" :label="option.label" :value="option.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="记忆内容">
          <el-input v-model="draftEditMemoryContent" type="textarea" :rows="5" maxlength="12000" show-word-limit />
        </el-form-item>
        <div class="info-callout"><span>修改只更新当前长期记忆。已经生成的快照会保留生成时的历史副本。</span></div>
      </el-form>
      <template #footer>
        <el-button @click="memoryEditDialogOpen = false">取消</el-button>
        <el-button type="primary" :loading="memoryEditSaving" :disabled="memoryEditLoading" @click="saveEditedMemory">保存修改</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="conversationDialogOpen" title="录入对话记录" width="min(640px, 94vw)">
      <el-form label-position="top">
        <el-form-item label="会话标题（可选）">
          <el-input v-model="draftConversationTitle" maxlength="255" placeholder="例如：第一次讨论角色设定" />
        </el-form-item>
        <el-form-item label="对话内容">
          <el-input v-model="draftTranscript" type="textarea" :rows="10" maxlength="24000" show-word-limit placeholder="用户：你好&#10;角色：你好呀！&#10;用户：下一句" />
        </el-form-item>
        <div class="info-callout"><span>每行一条消息，按发生顺序填写。支持“用户：”“我：”“user:”“角色：”“助手：”“assistant:”。纯文本录入没有原始时间戳，系统会按行顺序设置导入时间。</span></div>
      </el-form>
      <template #footer>
        <el-button @click="conversationDialogOpen = false">取消</el-button>
        <el-button type="primary" :loading="conversationSaving" @click="saveConversation">保存对话</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="recycleBinOpen" title="记忆回收站" width="min(760px, 94vw)" :close-on-click-modal="false">
      <p style="margin:0 0 14px;color:#7d889f;font-size:12px;line-height:1.8">已移出当前记忆集合的条目。恢复会回到移入回收站前的状态；永久删除仅移除当前长期记忆条目，历史快照仍保留生成时的副本。</p>
      <div v-if="recycleBinLoading" class="empty-state">正在读取回收站……</div>
      <div v-else-if="!recycleBinEntries.length" class="empty-state">回收站是空的。移入回收站的长期记忆会显示在这里。</div>
      <div v-else style="display:flex;flex-direction:column;gap:12px;max-height:55vh;overflow:auto">
        <article v-for="memory in recycleBinEntries" :key="memory.id" style="padding:14px;border:1px solid #eceef5;border-radius:12px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
            <div>
              <strong style="color:#47526d;font-size:12px">{{ memoryCategoryOptions.find((option) => option.value === memory.category)?.label || "长期记忆" }}</strong>
              <div style="margin-top:5px;color:#969fb2;font-size:11px">移入前状态：{{ memoryStatusText(memory.statusBeforeTrash) }} · {{ formatRecycleDate(memory.deletedAt) }}</div>
            </div>
            <span class="pill pill-gray">回收站</span>
          </div>
          <p style="margin:10px 0;color:#65718b;font-size:12px;line-height:1.8;white-space:pre-wrap">{{ memory.content }}</p>
          <div style="display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap">
            <el-button size="small" :loading="recycleBinBusyIds.includes(memory.id)" @click="restoreTrashedMemory(memory)">恢复</el-button>
            <el-button size="small" type="danger" plain :loading="recycleBinBusyIds.includes(memory.id)" @click="permanentlyDeleteMemory(memory)">永久删除条目</el-button>
          </div>
        </article>
      </div>
      <template #footer><el-button @click="recycleBinOpen = false">关闭</el-button></template>
    </el-dialog>

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
.memory-actions{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-top:7px}
.memory-source{margin-top:14px;padding:13px;border:1px solid #dce7f7;border-radius:12px;background:#f8fbff}
.memory-source-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;color:#47526d;font-size:12px}
.memory-source-meta{margin-top:7px;color:#7f8ba3;font-size:11px;line-height:1.7}
.memory-source-content{max-height:190px;overflow:auto;margin:9px 0 0;padding-top:9px;border-top:1px solid #e5edf8;color:#596781;font-size:12px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere}\n.timeline-marker.pill-green{background:#e8f8f1}.timeline-marker.pill-purple{background:#f0eeff}.timeline-marker.pill-blue{background:#eef5ff}.timeline-marker.pill-amber{background:#fff5e4}.timeline-marker.pill-gray{background:#f1f3f8}
.memory-score{display:flex;align-items:center;gap:13px;margin-top:22px}.memory-score-ring{display:flex;width:65px;height:65px;flex:0 0 auto;align-items:center;justify-content:center;border:6px solid #e4e0ff;border-right-color:#8678ed;border-top-color:#8678ed;border-radius:50%;color:#7062df;font-size:16px;font-weight:850}
.memory-score strong{color:#47526d;font-size:12px}.memory-score p{margin-top:6px;color:#969fb2;font-size:10px}
.recent-snapshot{margin-top:12px;padding:12px;border:1px solid #eceef5;border-radius:12px}.recent-snapshot-top{display:flex;justify-content:space-between;color:#58637d;font-size:11px;font-weight:800}.recent-snapshot p{margin:8px 0;color:#7d889f;font-size:10px;line-height:1.8}
@media(max-width:1350px){.cockpit-grid{grid-template-columns:230px minmax(0,1fr)}.snapshot-side{grid-column:1/-1;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.snapshot-side>.section-title{grid-column:1/-1}}
@media(max-width:800px){.cockpit-grid{grid-template-columns:1fr}.snapshot-side{grid-column:auto;display:block}.timeline-filters{flex-wrap:wrap}.timeline-filters .el-select{width:100%!important}}
</style>
