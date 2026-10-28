<script setup lang="ts">
import { ArrowRight, ArrowDown, Collection, Files, Search, MagicStick, Delete } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { type Character, type Snapshot, type TimelineEntry, type TimelineType } from "~/utils/mock-data";

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

const characters = useCharacterList();
/** 角色列表与侧边栏共用同一份 SSR 数据，同 key 不会重复请求 */
await useCharacterListData();

/**
 * 这是一张菜单页而不是某个角色的二级页：当前角色由地址栏 ?c= 决定，
 * 没带参数时回退到上次选过的角色，再回退到列表第一个。
 * 选择和 /chat 共用一份（同一个 cookie），换页不会跳角色。
 */
const { id } = useCharacterSelection("/memory");

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
/**
 * 来源筛选，而不是「渠道」筛选：服务端 timeline 的 channel 里混了两个维度 ——
 * 真实渠道（连接名 / 本地会话）和长期记忆的范围（长期记忆 / 私人记忆）。
 * 挤在一个没有标签的下拉里，选「长期记忆」实际筛出的是「所有非私人记忆条目」。
 * 这里按维度分组；阶段总结的「全部渠道」是跨渠道汇总，仍按通配处理。
 */
const SOURCE_ALL = "全部来源";
const SOURCE_WILDCARD = "全部渠道";
const MEMORY_SCOPE_SOURCES = new Set(["长期记忆", "私人记忆"]);
const realChannelOptions = computed(() => [...new Set(timelineEntries.value
  .map((entry) => entry.channel)
  .filter((channel) => channel !== SOURCE_WILDCARD && !MEMORY_SCOPE_SOURCES.has(channel)))].sort());
const memoryScopeOptions = computed(() => [...new Set(timelineEntries.value
  .map((entry) => entry.channel)
  .filter((channel) => MEMORY_SCOPE_SOURCES.has(channel)))].sort());
/**
 * 角色档案还没到 / 读取失败时的占位。
 * 以前这里 spread 了 initialCharacters[0]，于是兜底会捎上示例角色的头像、色调和人设；
 * 现在只补页面上真正会读的字段。列表为空的情况交给模板里的 no-character 整块处理。
 */
const emptyCharacter = computed<Character>(() => ({
  id: id.value,
  name: "角色加载中",
  alias: "数据库档案",
  description: "",
  personality: "",
  avatar: "忆",
  avatarTone: "mint",
  status: "已暂停",
  channels: [],
  intervalDays: 8,
  nextSnapshot: "尚未计划",
  memoryCount: 0,
  latestSnapshot: "暂无总结",
}));
const character = computed<Character>(() => currentCharacter.value ?? emptyCharacter.value);
const activeFilter = ref("全部记录");
const channelFilter = ref(SOURCE_ALL);
const query = ref("");
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
    const sourceMatches = channelFilter.value === SOURCE_ALL
      || entry.channel === SOURCE_WILDCARD
      || entry.channel === channelFilter.value;
    const textMatches = !query.value || `${entry.title} ${entry.summary} ${entry.source}`.toLowerCase().includes(query.value.toLowerCase());
    return typeMatches && sourceMatches && textMatches;
  });
});

/** 时间线一屏只放一页，避免 20+ 条把页面拉成 2700px 的长卷 */
const PAGE_SIZE = 10;
const visibleCount = ref(PAGE_SIZE);
const pagedEntries = computed(() => filteredEntries.value.slice(0, visibleCount.value));
watch([activeFilter, channelFilter, query], () => {
  visibleCount.value = PAGE_SIZE;
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
  // 角色列表为空 / 还没解析出 id 时不要发请求，否则会打出无意义的 404 提示
  if (!id.value) {
    currentCharacter.value = null;
    snapshots.value = [];
    timelineEntries.value = [];
    return;
  }
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

/** 行内「更多」菜单：状态类操作收进菜单，一行只留「编辑」+ 一个入口 */
async function runMemoryCommand(entry: TimelineEntry, command: string) {
  if (command === "trash") {
    await moveMemoryToTrash(entry);
    return;
  }
  await setMemoryStatus(entry, command as "active" | "archived" | "invalidated");
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
/**
 * 和阶段总结页的「生成阶段总结」是同一个动作（同一个 POST），所以名词、确认文案保持一致。
 * 以前这里叫「手动归档」且没有二次确认 —— 误点一次就多一份归档版本。
 */
async function manualSnapshot() {
  if (snapshotCreating.value) return;
  try {
    await ElMessageBox.confirm(
      "生成一份手动归档，保存当前时间范围内的消息来源与长期记忆。手动归档不会调用模型；自动周期任务会在配置模型后执行 AI 提炼。是否继续？",
      "生成阶段总结",
      { confirmButtonText: "确认归档", cancelButtonText: "取消", type: "info" },
    );
  } catch {
    return;
  }

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
      eyebrow="工作空间 / 角色记忆"
      title="角色记忆"
      description="先在上面选一个角色，下面是它的对话、阶段总结与长期记忆。启用自动归档后，周期任务会自动提炼事实与偏好。"
    >
      <template #actions>
        <button
          type="button"
          class="btn"
          @click="conversationDialogOpen = true"
        >
          录入对话
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
          class="btn primary"
          :disabled="snapshotCreating"
          @click="manualSnapshot"
        >
          <el-icon><MagicStick /></el-icon>{{ snapshotCreating ? "生成中…" : "生成阶段总结" }}
        </button>
      </template>
    </PageHeader>

    <!-- 角色切换：菜单页的入口，放在内容最上方、贴着标题，不塞进右上角按钮堆里 -->
    <CharacterBar
      path="/memory"
      empty-text="还没有角色。先创建一个角色，再回来整理它的记忆。"
    />

    <template v-if="characters.length">
      <!-- 一组数字只讲一遍：原来 KPI 四格 + 右栏「记忆状态」卡是同一组数据。
         这里收成一条静音统计带，字号 18px，比记忆正文更弱。 -->
      <div class="card stat-band">
        <div class="sb-cell">
          <span class="sb-k">长期记忆</span>
          <span class="sb-v">{{ character.memoryCount }}<small>条</small></span>
          <span class="sb-f">承诺与约定 {{ commitmentCount }} 项</span>
        </div>
        <div class="sb-cell">
          <span class="sb-k">归档周期</span>
          <span class="sb-v">{{ character.intervalDays }}<small>天</small></span>
          <span class="sb-f">
            下一次 {{ character.nextSnapshot }} ·
            <button
              type="button"
              class="ms-link"
              :disabled="!character.id"
              @click="navigateTo('/characters/' + character.id + '/settings/memory')"
            >调整</button>
          </span>
        </div>
        <div class="sb-cell">
          <span class="sb-k">已记录对话</span>
          <span class="sb-v">{{ timelineLoading ? "—" : recordedMessageCount }}<small>条</small></span>
          <span class="sb-f">平台事件 {{ timelineLoading ? "—" : recordedEventCount }} 项</span>
        </div>
        <div class="sb-cell">
          <span class="sb-k">绑定渠道</span>
          <span class="sb-v">{{ character.channels.length || 0 }}<small>个</small></span>
          <span class="sb-f">{{ character.channels.length ? character.channels.join(" / ") : "尚未绑定渠道" }}</span>
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
                v-if="realChannelOptions.length || memoryScopeOptions.length"
                v-model="channelFilter"
                class="tl-select"
                aria-label="按来源筛选时间线"
              >
                <el-option
                  :label="SOURCE_ALL"
                  :value="SOURCE_ALL"
                />
                <el-option-group
                  v-if="realChannelOptions.length"
                  label="渠道"
                >
                  <el-option
                    v-for="channel in realChannelOptions"
                    :key="channel"
                    :label="channel"
                    :value="channel"
                  />
                </el-option-group>
                <el-option-group
                  v-if="memoryScopeOptions.length"
                  label="记忆范围"
                >
                  <el-option
                    v-for="channel in memoryScopeOptions"
                    :key="channel"
                    :label="channel"
                    :value="channel"
                  />
                </el-option-group>
              </el-select>
              <button
                type="button"
                class="tool-link"
                @click="openRecycleBin"
              >
                <el-icon><Delete /></el-icon>回收站
              </button>
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
                  v-for="entry in pagedEntries"
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
                      >{{ entry.tag }}</span><span v-if="entry.channel !== entry.tag">{{ entry.channel }}</span><span>{{ entry.source }}</span>
                    </div>
                    <!-- 行内只留「编辑 + 更多」：原来 4 个链接常显，其中 2 个破坏性，
                       每行都在喊。状态类操作收进菜单，默认不占视线。 -->
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
                      <el-dropdown
                        trigger="click"
                        placement="bottom-end"
                        @command="runMemoryCommand(entry, String($event))"
                      >
                        <button
                          type="button"
                          class="row-more"
                        >
                          更多<el-icon><ArrowDown /></el-icon>
                        </button>
                        <template #dropdown>
                          <el-dropdown-menu>
                            <template v-if="entry.tag === '长期记忆'">
                              <el-dropdown-item command="archived">
                                归档
                              </el-dropdown-item>
                              <el-dropdown-item command="invalidated">
                                标记失效
                              </el-dropdown-item>
                            </template>
                            <el-dropdown-item
                              v-else
                              command="active"
                            >
                              恢复有效
                            </el-dropdown-item>
                            <el-dropdown-item
                              command="trash"
                              divided
                              style="color:var(--red)"
                            >
                              移入回收站
                            </el-dropdown-item>
                          </el-dropdown-menu>
                        </template>
                      </el-dropdown>
                    </div>
                  </div>
                </article>
                <button
                  v-if="filteredEntries.length > visibleCount"
                  type="button"
                  class="load-more"
                  @click="visibleCount += PAGE_SIZE"
                >
                  加载更多（还有 {{ filteredEntries.length - visibleCount }} 条）
                </button>
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
            <h2>最近归档</h2>
            <span class="sub">{{ snapshots.length }} 份</span>
            <button
              type="button"
              class="more"
              @click="navigateTo('/snapshots?c=' + character.id)"
            >
              全部<el-icon><ArrowRight /></el-icon>
            </button>
          </div>
          <div class="card snap-card">
            <NuxtLink
              v-for="snapshot in snapshots.slice(0, 2)"
              :key="snapshot.id"
              :to="'/snapshots?c=' + character.id"
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
              <span>生成一份阶段总结，或等周期 Worker 跑完，这里会出现版本记录</span>
            </div>
          </div>
        </aside>
      </div>
    </template>

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
  </div>
</template>

<style scoped>
/* ══════════════════════════════════════════════════════════════
   沿用总览页 / 角色管理页 A 套「色块平铺」：一张白台面，零描边零阴影，
   层次只靠明度差 + 间距，颜色只给状态。
   L0 画布(--bg) → L1 白砖 #fff → L2 卡内分节靠留白 → L3 状态药丸上色
   选择器带 scoped 属性后是 (0,2,0)，压过 main.css 里 .card / .pill 的
   (0,1,0)，所以不必写 .page-wrap 前缀，也不动全局样式。
   ══════════════════════════════════════════════════════════════ */

/* 白砖：去掉 1px #e6e9ef 描边 + 0 1px 2px 阴影 */
.card{border:0;border-radius:10px;box-shadow:none}

/* 「调整」：挂在归档周期格里的行内按钮，跟 sb-f 同字号，不抢视觉（统计带本身在 main.css 的 .stat-band） */
.ms-link{padding:0;border:0;background:none;color:var(--brand-strong);font:inherit;font-weight:600;cursor:pointer}
.ms-link:hover{text-decoration:underline}
.ms-link:disabled{color:var(--faint);cursor:not-allowed}

/* 时间线下面两栏：左时间线 + 右角色栏，比例与概览页一致 */
.panel-grid{margin-top:0}

/* ── 时间线卡片 ─────────────────────────────────────── */
.tl-card{padding:14px 18px 10px}
.tl-tools{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.tl-search{min-width:170px;flex:1}
.tl-select{width:132px;flex:none}
/* 回收站是「管这批记忆」的工具，排在搜索/渠道后面，不做成第三个控件的样子 */
.tool-link{display:inline-flex;flex:none;align-items:center;gap:4px;height:32px;padding:0 6px;border:0;background:none;color:var(--dim);font-size:12px;font-weight:600;cursor:pointer}
.tool-link:hover{color:var(--brand-strong)}
.tool-link .el-icon{font-size:14px}
.tl-loading{padding:34px 0;color:var(--dim);font-size:12px;text-align:center}
.timeline-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:9px}
/* 时间是信息，不能落在 --faint(2.55:1) 上 */
.timeline-heading .muted-note{color:var(--dim)}
/* 去横线：行间 2px 缝 + hover 铺底，跟总览页同一套分块语言 */
.timeline{gap:2px}
.timeline-item{margin:0 -12px;border-bottom:0;border-radius:8px;padding:12px;transition:background .14s var(--ease)}
.timeline-item:hover{background:var(--surface-2)}
/* 记忆正文是全页要读的东西，12px 太紧了；跟标题同为 14px，靠字重和明度分层 */
.timeline-summary{font-size:14px;line-height:1.7}
.timeline-meta{color:var(--dim)}

.load-more{width:100%;margin-top:4px;border:0;border-radius:8px;background:none;padding:12px 0;color:var(--dim);font-size:12px;font-weight:600;cursor:pointer;transition:background .14s var(--ease),color .14s var(--ease)}
.load-more:hover{background:var(--surface-2);color:var(--brand-strong)}

/* 行内动作：只剩「编辑」+「更多」两个入口 */
.memory-actions{display:flex;align-items:center;gap:10px;margin-top:4px}
.memory-actions .el-button{margin-left:0;font-size:12px}
.memory-actions .el-button + .el-button{margin-left:0}
/* Element 默认 primary 是 #d94a76=4.05:1，换成本项目的深一档（5.25:1） */
.memory-actions :deep(.el-button.is-link.el-button--primary){color:var(--brand-strong)}
.memory-actions :deep(.el-button.is-link.el-button--primary:hover){color:#a8305a}
.row-more{display:inline-flex;align-items:center;gap:2px;border:0;border-radius:var(--radius-xs);background:none;padding:0 4px;color:var(--text-2);font-size:12px;font-weight:400;cursor:pointer;transition:color .14s var(--ease)}
.row-more:hover{color:var(--text)}
.row-more .el-icon{font-size:12px}

/* 记录类型标记：单字 + 软底深字（原来借用 pill-* 的底色，这里补齐前景色） */
.timeline-marker{font-size:12px;font-weight:700}
.timeline-marker.pill-green{background:var(--green-soft);color:#0b7a54}
.timeline-marker.pill-purple{background:var(--brand-soft);color:var(--brand-strong)}
.timeline-marker.pill-blue{background:var(--blue-soft);color:#3d4dab}
.timeline-marker.pill-amber{background:var(--amber-soft);color:#8f5c05}
.timeline-marker.pill-gray{background:var(--surface-3);color:var(--text-2)}

/* ── 右栏 ──────────────────────────────────────────── */
/* 右栏现在只剩「最近归档」一块，跟着滚，别在下面留一大片空白 */
.side-col{position:sticky;top:72px;align-self:start}

/* ── 最近归档 ──────────────────────────────────────── */
.snap-card{padding:6px}
.snap-row{display:block;border-radius:8px;padding:10px 12px;transition:background .14s var(--ease)}
.snap-row + .snap-row{margin-top:2px}
.snap-row:hover{background:var(--surface-2)}
.snap-top{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--text-2);font-size:12px;font-weight:600}
.snap-sum{display:-webkit-box;overflow:hidden;margin-top:5px;color:var(--dim);font-size:12px;line-height:1.7;-webkit-box-orient:vertical;-webkit-line-clamp:2}

/* ── 回收站弹窗 ─────────────────────────────────────── */
.recycle-intro{margin:0 0 14px;color:var(--dim);font-size:12px;line-height:1.8}
.recycle-list{display:flex;flex-direction:column;gap:10px;max-height:55vh;overflow:auto}
.recycle-card{padding:14px 16px;border:1px solid var(--line);border-radius:var(--radius);background:var(--surface)}
.recycle-card-head{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:12px}
.recycle-card-title{color:var(--text-2);font-size:14px;font-weight:700}
.recycle-card-meta{margin-top:5px;color:var(--dim);font-size:12px}
.recycle-card-body{margin:10px 0;color:var(--dim);font-size:12px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere}
.recycle-card-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}

/* 单列时右栏不再吸顶，否则会跟着页面滚到内容之外 */
@media(max-width:1150px){.side-col{position:static}}
@media(max-width:640px){
  .tl-card{padding:12px 14px 8px}
  .tl-select{width:100%}
  .stat-band{padding:14px}
}
</style>
