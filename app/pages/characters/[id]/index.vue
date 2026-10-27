<script setup lang="ts">
import { ArrowRight, Calendar, Collection, Files, Search, Edit, Cpu, MagicStick, Delete } from "@element-plus/icons-vue";
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
  channels: [], intervalDays: 8, nextSnapshot: "尚未计划", memoryCount: 0, latestSnapshot: "暂无总结",
});
const activeFilter = ref("全部记录");
const channelFilter = ref("全部渠道");
const query = ref("");
const editOpen = ref(false);
const filterOptions = [
  { label: "全部记录", type: undefined },
  { label: "对话记录", type: "message" as TimelineType },
  { label: "重要事件", type: "event" as TimelineType },
  { label: "长期记忆", type: "memory" as TimelineType },
  { label: "阶段总结", type: "snapshot" as TimelineType },
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

/** 筛选 chip 后面跟随的条数（不受搜索框影响，方便一眼看出各类型有多少存量） */
function countFor(label: string) {
  const type = filterOptions.find((option) => option.label === label)?.type;
  return type ? timelineEntries.value.filter((entry) => entry.type === type).length : timelineEntries.value.length;
}

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
    ElMessage.error("阶段总结加载失败，请确认本地数据库已迁移。");
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

/** 资料弹窗自己提交，这里只接结果刷新页面数据 */
function onProfileSaved(updated: Character) {
  currentCharacter.value = updated;
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
    ElMessage.success("长期记忆已更新。已有阶段总结会保留生成时的历史内容。");
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
      `确定将这条记忆“${actionLabel}”吗？此操作会保留历史记录，不会删除已有阶段总结。`,
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
      "这条记忆将从主时间线和当前长期记忆集合中移出，但不会被立即永久删除。你可以在回收站中恢复。已有阶段总结会保留生成时的历史副本。",
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
      "这会永久删除当前长期记忆条目，且无法从回收站恢复。为保护历史追溯，已有阶段总结中的生成时副本和来源记录仍会保留；因此历史归档里仍可能出现这段内容。",
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
    ElMessage.success(`当前记忆条目已永久删除；保留了 ${result.preservedSnapshotReferences} 条历史来源记录，既有阶段总结未被改写。`);
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
    ElMessage.success("已归档。已关联周期内的消息/事件与长期记忆来源；尚未调用大模型生成总结。");
  } catch (error) {
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : "归档保存失败，请检查数据库连接。";
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
    <PageHeader
      eyebrow="工作空间 / AI 角色管理 / 记忆驾驶舱"
      title="记忆驾驶舱"
      description="查看角色对话、阶段总结与长期记忆。启用自动归档后，周期 Worker 会提炼事实与偏好变化，并保留原始消息来源。"
    >
      <template #actions>
        <button
          type="button"
          class="btn"
          @click="editOpen = true"
        >
          <el-icon><Edit /></el-icon>编辑资料
        </button>
        <button
          type="button"
          class="btn"
          @click="navigateTo('/characters/' + character.id + '/settings/model')"
        >
          <el-icon><Cpu /></el-icon>模型设置
        </button>
        <button
          type="button"
          class="btn"
          @click="memoryDialogOpen = true"
        >
          新增长期记忆
        </button>
        <button
          type="button"
          class="btn"
          @click="conversationDialogOpen = true"
        >
          录入对话
        </button>
        <button
          type="button"
          class="btn primary"
          :disabled="snapshotCreating"
          @click="manualSnapshot"
        >
          <el-icon><MagicStick /></el-icon>{{ snapshotCreating ? "归档中…" : "手动归档" }}
        </button>
      </template>
    </PageHeader>

    <div class="kpi-row">
      <div class="kpi">
        <div class="k">
          长期记忆
        </div>
        <div class="v">
          {{ character.memoryCount }}<small>条</small>
        </div>
        <div class="foot">
          承诺与约定 {{ commitmentCount }} 项
        </div>
      </div>
      <div class="kpi">
        <div class="k">
          归档周期
        </div>
        <div class="v">
          {{ character.intervalDays }}<small>天</small>
        </div>
        <div class="foot">
          下一次 {{ character.nextSnapshot }}
        </div>
      </div>
      <div class="kpi">
        <div class="k">
          已记录对话
        </div>
        <div class="v">
          {{ recordedMessageCount }}<small>条</small>
        </div>
        <div class="foot">
          平台事件 {{ recordedEventCount }} 项
        </div>
      </div>
      <div class="kpi">
        <div class="k">
          绑定渠道
        </div>
        <div class="v">
          {{ character.channels.length || 0 }}<small>个</small>
        </div>
        <div class="foot">
          {{ character.channels.length ? character.channels.join(" / ") : "尚未绑定渠道" }}
        </div>
      </div>
    </div>

    <div class="panel-grid">
      <section>
        <div class="sec-h">
          <h2>角色记忆时间线</h2>
          <span class="sub">{{ filteredEntries.length }}/{{ timelineEntries.length }} 条</span>
        </div>
        <div class="card tl-card">
          <div class="filters">
            <button
              v-for="option in filterOptions"
              :key="option.label"
              type="button"
              class="chip"
              :class="{ on: activeFilter === option.label }"
              @click="activeFilter = option.label"
            >
              {{ option.label }}<span class="n">{{ countFor(option.label) }}</span>
            </button>
          </div>
          <div class="tl-tools">
            <el-input
              v-model="query"
              clearable
              placeholder="搜索时间线内容……"
              class="tl-search"
            >
              <template #prefix>
                <el-icon><Search /></el-icon>
              </template>
            </el-input>
            <el-select
              v-model="channelFilter"
              class="tl-select"
            >
              <el-option
                label="全部渠道"
                value="全部渠道"
              /><el-option
                v-for="channel in channelOptions"
                :key="channel"
                :label="channel"
                :value="channel"
              />
            </el-select>
          </div>
          <div class="timeline">
            <div
              v-if="timelineLoading"
              class="tl-loading"
            >
              正在加载已保存的时间线记录……
            </div>
            <template v-else>
              <article
                v-for="entry in filteredEntries"
                :key="entry.id"
                class="timeline-item"
              >
                <div
                  class="timeline-marker"
                  :class="toneFor(entry.tagTone)"
                >
                  {{ markerFor(entry.type) }}
                </div>
                <div class="timeline-content">
                  <div class="timeline-heading">
                    <span class="timeline-title">{{ entry.title }}</span><span class="muted-note">{{ entry.time }}</span>
                  </div>
                  <p class="timeline-summary">
                    {{ entry.summary }}
                  </p>
                  <div class="timeline-meta">
                    <span
                      class="pill"
                      :class="toneFor(entry.tagTone)"
                    >{{ entry.tag }}</span><span>{{ entry.channel }}</span><span>{{ entry.source }}</span>
                  </div>
                  <div
                    v-if="entry.type === 'memory'"
                    class="memory-actions"
                  >
                    <el-button
                      link
                      type="primary"
                      size="small"
                      @click="openMemoryEditor(entry)"
                    >
                      编辑
                    </el-button>
                    <template v-if="entry.tag === '长期记忆'">
                      <el-button
                        link
                        size="small"
                        @click="setMemoryStatus(entry, 'archived')"
                      >
                        归档
                      </el-button>
                      <el-button
                        link
                        type="danger"
                        size="small"
                        @click="setMemoryStatus(entry, 'invalidated')"
                      >
                        标记失效
                      </el-button>
                    </template>
                    <el-button
                      v-else
                      link
                      type="success"
                      size="small"
                      @click="setMemoryStatus(entry, 'active')"
                    >
                      恢复有效
                    </el-button>
                    <el-button
                      link
                      type="danger"
                      size="small"
                      @click="moveMemoryToTrash(entry)"
                    >
                      移入回收站
                    </el-button>
                  </div>
                </div>
              </article>
              <div
                v-if="!filteredEntries.length"
                class="card-empty"
              >
                <el-icon><Collection /></el-icon>
                <span>{{ timelineEntries.length ? "没有匹配的记录" : "还没有已保存的记录" }}</span>
                <span>{{ timelineEntries.length ? "换个筛选条件或清空搜索词再试一次" : "接入聊天消息、保存长期记忆之后，这里会按时间顺序出现对应条目" }}</span>
              </div>
            </template>
          </div>
        </div>
      </section>

      <aside class="side-col">
        <div class="sec-h">
          <h2>角色档案</h2>
        </div>
        <div class="card char-box">
          <div class="char-head">
            <div
              class="avatar character-avatar"
              :class="'avatar-' + character.avatarTone"
            >
              {{ character.avatar }}
            </div>
            <div class="char-id">
              <div class="character-name">
                {{ character.name }}
              </div>
              <div class="character-alias">
                {{ character.alias }}
              </div>
              <span
                class="pill"
                :class="character.status === '运行中' ? 'pill-green' : 'pill-amber'"
              >{{ character.status }}</span>
            </div>
          </div>
          <p class="char-desc">
            {{ character.description }}
          </p>
          <div class="quick-actions">
            <button
              type="button"
              class="btn"
              @click="navigateTo('/characters/' + character.id + '/settings/memory')"
            >
              <el-icon><Calendar /></el-icon>记忆周期设置
            </button>
            <button
              type="button"
              class="btn"
              @click="navigateTo('/characters/' + character.id + '/snapshots')"
            >
              <el-icon><Files /></el-icon>查看全部阶段总结
            </button>
            <button
              type="button"
              class="btn"
              @click="openRecycleBin"
            >
              <el-icon><Delete /></el-icon>记忆回收站
            </button>
          </div>
        </div>

        <div class="sec-h">
          <h2>记忆状态</h2>
          <span class="sub">{{ character.status === "已暂停" ? "已暂停" : "已计划" }}</span>
        </div>
        <div class="card stat-box">
          <p class="stat-note">
            启用自动归档并配置模型后，周期 Worker 会自动总结对话并维护长期记忆。
          </p>
          <div class="metric-row">
            <span>已记录对话消息</span><span class="metric-value">{{ recordedMessageCount }} 条</span>
          </div>
          <div class="metric-row">
            <span>已记录平台事件</span><span class="metric-value">{{ recordedEventCount }} 项</span>
          </div>
          <div class="metric-row">
            <span>承诺与约定</span><span class="metric-value">{{ commitmentCount }} 项</span>
          </div>
          <div class="metric-row">
            <span>归档周期</span><span class="metric-value">{{ character.intervalDays }} 天</span>
          </div>
        </div>

        <div class="sec-h">
          <h2>最近归档</h2>
          <span class="sub">{{ snapshots.length }} 份</span>
          <button
            type="button"
            class="more"
            @click="navigateTo('/characters/' + character.id + '/snapshots')"
          >
            全部<el-icon><ArrowRight /></el-icon>
          </button>
        </div>
        <div class="card">
          <NuxtLink
            v-for="snapshot in snapshots.slice(0, 2)"
            :key="snapshot.id"
            :to="'/characters/' + character.id + '/snapshots'"
            class="snap-row"
          >
            <span class="snap-top">
              <span>第 {{ snapshot.number }} 份阶段总结</span>
              <span class="muted-note">v{{ snapshot.version }}</span>
            </span>
            <span class="snap-sum">{{ snapshot.summary }}</span>
          </NuxtLink>
          <div
            v-if="!snapshots.length"
            class="card-empty"
          >
            <el-icon><Files /></el-icon>
            <span>还没有保存的总结</span>
            <span>手动归档一次或等周期 Worker 跑完，这里会出现版本记录</span>
          </div>
        </div>
      </aside>
    </div>

    <el-dialog
      v-model="memoryDialogOpen"
      title="新增长期记忆"
      width="min(560px, 94vw)"
    >
      <el-form label-position="top">
        <el-form-item label="记忆分类">
          <el-select
            v-model="draftMemoryCategory"
            style="width:100%"
          >
            <el-option
              v-for="option in memoryCategoryOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="记忆范围">
          <el-radio-group v-model="draftMemoryScope">
            <el-radio-button value="character">
              角色全局
            </el-radio-button>
            <el-radio-button value="private">
              我的私人
            </el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="记忆内容">
          <el-input
            v-model="draftMemoryContent"
            type="textarea"
            :rows="5"
            maxlength="12000"
            show-word-limit
            placeholder="例如：用户更喜欢简洁、直接的解释。"
          />
        </el-form-item>
        <div class="info-callout">
          <span>保存后会写入 PostgreSQL，并立即出现在角色记忆时间线中。角色全局记忆在本角色所有对话中都可检索；私人记忆只在你自己和这个角色对话时使用，不会混入其他用户。</span>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="memoryDialogOpen = false">
          取消
        </el-button>
        <el-button
          type="primary"
          :loading="memorySaving"
          @click="saveMemory"
        >
          保存记忆
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="memoryEditDialogOpen"
      title="编辑长期记忆"
      width="min(560px, 94vw)"
      :close-on-click-modal="!memoryEditSaving"
    >
      <div
        v-if="memoryEditLoading"
        class="empty-state"
      >
        正在加载记忆详情……
      </div>
      <el-form
        v-else
        label-position="top"
      >
        <el-form-item label="记忆分类">
          <el-select
            v-model="draftEditMemoryCategory"
            style="width:100%"
          >
            <el-option
              v-for="option in memoryCategoryOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="记忆内容">
          <el-input
            v-model="draftEditMemoryContent"
            type="textarea"
            :rows="5"
            maxlength="12000"
            show-word-limit
          />
        </el-form-item>
        <div class="info-callout">
          <span>修改只更新当前长期记忆。已经生成的阶段总结会保留生成时的历史副本。</span>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="memoryEditDialogOpen = false">
          取消
        </el-button>
        <el-button
          type="primary"
          :loading="memoryEditSaving"
          :disabled="memoryEditLoading"
          @click="saveEditedMemory"
        >
          保存修改
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="conversationDialogOpen"
      title="录入对话记录"
      width="min(640px, 94vw)"
    >
      <el-form label-position="top">
        <el-form-item label="会话标题（可选）">
          <el-input
            v-model="draftConversationTitle"
            maxlength="255"
            placeholder="例如：第一次讨论角色设定"
          />
        </el-form-item>
        <el-form-item label="对话内容">
          <el-input
            v-model="draftTranscript"
            type="textarea"
            :rows="10"
            maxlength="24000"
            show-word-limit
            placeholder="用户：你好&#10;角色：你好呀！&#10;用户：下一句"
          />
        </el-form-item>
        <div class="info-callout">
          <span>每行一条消息，按发生顺序填写。支持“用户：”“我：”“user:”“角色：”“助手：”“assistant:”。纯文本录入没有原始时间戳，系统会按行顺序设置导入时间。</span>
        </div>
      </el-form>
      <template #footer>
        <el-button @click="conversationDialogOpen = false">
          取消
        </el-button>
        <el-button
          type="primary"
          :loading="conversationSaving"
          @click="saveConversation"
        >
          保存对话
        </el-button>
      </template>
    </el-dialog>

    <el-dialog
      v-model="recycleBinOpen"
      title="记忆回收站"
      width="min(760px, 94vw)"
      :close-on-click-modal="false"
    >
      <p class="recycle-intro">
        已移出当前记忆集合的条目。恢复会回到移入回收站前的状态；永久删除仅移除当前长期记忆条目，历史归档仍保留生成时的副本。
      </p>
      <div
        v-if="recycleBinLoading"
        class="empty-state"
      >
        正在读取回收站……
      </div>
      <div
        v-else-if="!recycleBinEntries.length"
        class="empty-state"
      >
        回收站是空的。移入回收站的长期记忆会显示在这里。
      </div>
      <div
        v-else
        class="recycle-list"
      >
        <article
          v-for="memory in recycleBinEntries"
          :key="memory.id"
          class="recycle-card"
        >
          <div class="recycle-card-head">
            <div>
              <strong class="recycle-card-title">{{ memoryCategoryOptions.find((option) => option.value === memory.category)?.label || "长期记忆" }}</strong>
              <div class="recycle-card-meta">
                移入前状态：{{ memoryStatusText(memory.statusBeforeTrash) }} · {{ formatRecycleDate(memory.deletedAt) }}
              </div>
            </div>
            <span class="pill pill-gray">回收站</span>
          </div>
          <p class="recycle-card-body">
            {{ memory.content }}
          </p>
          <div class="recycle-card-actions">
            <el-button
              size="small"
              :loading="recycleBinBusyIds.includes(memory.id)"
              @click="restoreTrashedMemory(memory)"
            >
              恢复
            </el-button>
            <el-button
              size="small"
              type="danger"
              plain
              :loading="recycleBinBusyIds.includes(memory.id)"
              @click="permanentlyDeleteMemory(memory)"
            >
              永久删除条目
            </el-button>
          </div>
        </article>
      </div>
      <template #footer>
        <el-button @click="recycleBinOpen = false">
          关闭
        </el-button>
      </template>
    </el-dialog>

    <CharacterProfileDialog
      v-model="editOpen"
      :character="character"
      @saved="onProfileSaved"
    />
  </div>
</template>

<style scoped>
/* KPI 行下面两栏：左时间线 + 右角色/状态栏，比例与概览页一致 */
.panel-grid{margin-top:0}

/* ── 时间线卡片 ─────────────────────────────────────── */
.tl-card{padding:14px 18px 6px}
.tl-tools{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.tl-search{min-width:170px;flex:1}
.tl-select{width:132px;flex:none}
.tl-loading{padding:34px 0;color:var(--faint);font-size:12px;text-align:center}
.timeline-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:9px}
.memory-actions{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-top:2px}
/* link 按钮：清掉 Element Plus 相邻边距，保持均匀间隔 */
.memory-actions .el-button{margin-left:0;font-size:12px}
.memory-actions .el-button + .el-button{margin-left:0}
/* 图标按记录类型上色（原来借用 pill-* 的底色，这里补齐前景色） */
.timeline-marker{font-size:12px;font-weight:700}
.timeline-marker.pill-green{background:var(--green-soft);color:var(--green)}
.timeline-marker.pill-purple{background:var(--brand-soft);color:var(--brand-strong)}
.timeline-marker.pill-blue{background:var(--blue-soft);color:#3d4dab}
.timeline-marker.pill-amber{background:var(--amber-soft);color:var(--amber)}
.timeline-marker.pill-gray{background:var(--surface-3);color:var(--dim)}

/* ── 右栏：角色卡 ───────────────────────────────────── */
.char-box{padding:16px 18px 18px}
.char-head{display:flex;align-items:flex-start;gap:12px}
.char-id{display:flex;min-width:0;flex:1;flex-direction:column;align-items:flex-start;gap:4px}
.char-id .character-name{font-size:16px;line-height:1.3}
.char-id .character-alias{margin-top:0}
.char-desc{margin:12px 0 14px;color:var(--dim);font-size:12px;line-height:1.8}
/* 快捷操作：三行等宽、左对齐 */
.quick-actions{display:flex;flex-direction:column;gap:6px}
.quick-actions .btn{width:100%;justify-content:flex-start;font-size:12px}
.quick-actions .btn .el-icon{color:var(--faint)}

/* ── 右栏：记忆状态卡 ───────────────────────────────── */
.stat-box{padding:0 18px 6px}
.stat-note{margin:12px 0 0;padding-bottom:10px;border-bottom:1px solid var(--line);color:var(--dim);font-size:12px;line-height:1.75;text-wrap:pretty}

/* ── 右栏：最近归档 ────────────────────────────────── */
.snap-row{display:block;padding:12px 18px;border-bottom:1px solid var(--line);transition:background .14s var(--ease)}
.snap-row:last-child{border-bottom:0}
.snap-row:hover{background:var(--surface-2)}
.snap-top{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--text-2);font-size:12px;font-weight:600}
.snap-sum{display:-webkit-box;overflow:hidden;margin-top:5px;color:var(--dim);font-size:12px;line-height:1.7;-webkit-box-orient:vertical;-webkit-line-clamp:2}

/* ── 回收站弹窗 ─────────────────────────────────────── */
.recycle-intro{margin:0 0 14px;color:var(--dim);font-size:12px;line-height:1.8}
.recycle-list{display:flex;flex-direction:column;gap:10px;max-height:55vh;overflow:auto}
.recycle-card{padding:14px 16px;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface)}
.recycle-card-head{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:12px}
.recycle-card-title{color:var(--text-2);font-size:14px;font-weight:700}
.recycle-card-meta{margin-top:5px;color:var(--faint);font-size:12px}
.recycle-card-body{margin:10px 0;color:var(--dim);font-size:12px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere}
.recycle-card-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}

@media(max-width:640px){.tl-card{padding:12px 14px 4px}.tl-select{width:100%}}
</style>
