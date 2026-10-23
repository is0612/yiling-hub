<script setup lang="ts">
import { ArrowLeft, Calendar, Files, Refresh, Search, MagicStick } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { initialCharacters, type Character, type Snapshot } from "~/utils/mock-data";

const route = useRoute();
const id = computed(() => String(route.params.id || ""));
const character = ref<Character>({ ...initialCharacters[0]!, id: "", name: "角色加载中" });
const items = ref<Snapshot[]>([]);
const query = ref("");
const statusFilter = ref("全部版本状态");
const detail = ref<Snapshot | null>(null);
const creating = ref(false);
const regeneratingId = ref<string | null>(null);

const filtered = computed(() => items.value.filter((item) => {
  const queryMatches = !query.value || `${item.summary} ${item.range} 第 ${item.number} 份`.toLowerCase().includes(query.value.toLowerCase());
  const statusMatches = statusFilter.value === "全部版本状态" || item.status === statusFilter.value;
  return queryMatches && statusMatches;
}));

async function loadCharacter() {
  try {
    character.value = await $fetch<Character>(`/api/characters/${encodeURIComponent(id.value)}`);
  } catch {
    character.value = { ...initialCharacters[0]!, id: id.value, name: "无法读取角色" };
    ElMessage.error("角色档案读取失败。");
  }
}

async function loadSnapshots(selectedId?: string) {
  try {
    const result = await $fetch<Snapshot[]>(`/api/characters/${encodeURIComponent(id.value)}/snapshots`);
    items.value = result;
    detail.value = (selectedId ? result.find((item) => item.id === selectedId) : undefined) || result[0] || null;
  } catch {
    items.value = [];
    detail.value = null;
    ElMessage.error("快照数据加载失败，请确认本地数据库已迁移。");
  }
}

function resetFilters() {
  query.value = "";
  statusFilter.value = "全部版本状态";
}
function statusTone(status: Snapshot["status"]) {
  return status === "当前版本" ? "pill-green" : "pill-gray";
}
function errorMessage(error: unknown) {
  return error && typeof error === "object" && "statusMessage" in error
    ? String(error.statusMessage)
    : "操作失败，请检查数据库连接。";
}
function evidenceLabel(ids: string[]) {
  return ids.map((sourceId) => sourceId.slice(0, 8)).join("、");
}
function memoryChangeLabel(action: string, result: string) {
  const actionLabel = action === "ADD" ? "新增" : action === "UPDATE" ? "更新" : action === "INVALIDATE" ? "标记失效" : action;
  const resultLabel = result === "CREATED" ? "已创建" : result === "REPLACED" ? "已替换旧记忆" : result === "INVALIDATED" ? "已失效" : result === "DUPLICATE_IGNORED" ? "忽略重复项" : result;
  return actionLabel + " · " + resultLabel;
}

async function createSnapshot() {
  try {
    await ElMessageBox.confirm(
      "生成一份手动快照，保存当前时间范围内的消息来源与长期记忆。手动快照不会调用模型；自动周期任务会在配置模型后执行 AI 提炼。是否继续？",
      "生成快照",
      { confirmButtonText: "保存快照", cancelButtonText: "取消", type: "info" },
    );
  } catch {
    return;
  }

  creating.value = true;
  try {
    const result = await $fetch<{ id: string }>(`/api/characters/${encodeURIComponent(id.value)}/snapshots`, { method: "POST" });
    await loadSnapshots(result.id);
    ElMessage.success("手动快照已保存到 PostgreSQL，并关联周期内可用的消息来源。");
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    creating.value = false;
  }
}

async function regenerate(snapshot: Snapshot) {
  try {
    await ElMessageBox.confirm(
      "为第 " + snapshot.number + " 份快照创建新版本？旧版本会保留，并标记为已被替代。",
      "重新生成快照",
      { confirmButtonText: "创建新版本", cancelButtonText: "取消", type: "info" },
    );
  } catch {
    return;
  }

  regeneratingId.value = snapshot.id;
  try {
    const result = await $fetch<{ id: string }>(`/api/characters/${encodeURIComponent(id.value)}/snapshots`, {
      method: "POST",
      body: { snapshotId: snapshot.id },
    });
    await loadSnapshots(result.id);
    ElMessage.success("新版本已写入数据库，旧版本仍保留。");
  } catch (error) {
    ElMessage.error(errorMessage(error));
  } finally {
    regeneratingId.value = null;
  }
}

onMounted(() => {
  void loadCharacter();
  void loadSnapshots();
});
watch(id, () => {
  items.value = [];
  detail.value = null;
  void loadCharacter();
  void loadSnapshots();
});
</script>

<template>
  <div class="page-wrap">
    <PageHeader :eyebrow="`角色管理 / ${character.name} / 周期快照`" title="周期快照档案" description="自动周期快照会调用配置的 AI 模型提炼对话、事实与偏好变化；手动快照保留当下记录。每份自动记忆变化都应能追溯到原始消息。">
      <template #actions><el-button @click="navigateTo('/characters/' + character.id)"><el-icon><ArrowLeft /></el-icon>返回驾驶舱</el-button><el-button type="primary" :loading="creating" @click="createSnapshot"><el-icon><MagicStick /></el-icon>生成快照</el-button></template>
    </PageHeader>

    <div class="stat-grid" style="grid-template-columns:repeat(3,minmax(0,1fr))">
      <StatCard label="历史快照" :value="String(items.length).padStart(2, '0')" note="历史版本保存在数据库" symbol="▤" tone="purple" />
      <StatCard label="覆盖消息" :value="String(items.reduce((sum, item) => sum + item.messages, 0))" note="接入消息后统计" symbol="☰" tone="blue" />
      <StatCard label="最近生成" :value="items[0]?.date.slice(0, 10) || '暂无'" note="按保存时间更新" symbol="◷" tone="green" />
    </div>

    <section class="surface panel" style="margin-top:20px">
      <div class="filter-row">
        <div class="filter-grow"><el-input v-model="query" clearable placeholder="搜索快照总结、时间段或编号……"><template #prefix><el-icon><Search /></el-icon></template></el-input></div>
        <el-select v-model="statusFilter" style="width:170px"><el-option label="全部版本状态" value="全部版本状态" /><el-option label="当前版本" value="当前版本" /><el-option label="已被替代" value="已被替代" /></el-select>
        <el-button @click="resetFilters">重置筛选</el-button>
      </div>
      <div class="filter-summary"><span>共 <strong>{{ filtered.length }}</strong> 份快照</span><span>历史版本不会被自动覆盖</span></div>
    </section>

    <div class="snapshot-grid">
      <section class="surface panel">
        <SectionTitle title="归档时间线" description="按生成时间倒序排列" />
        <div class="section-content">
          <button v-for="snapshot in filtered" :key="snapshot.id" class="snapshot-item" :class="{ selected: detail?.id === snapshot.id }" @click="detail = snapshot">
            <div class="snapshot-title"><span>第 {{ snapshot.number }} 份快照 <span style="color:#a2a9b9;font-weight:500">· v{{ snapshot.version }}</span></span><span class="pill" :class="statusTone(snapshot.status)">{{ snapshot.status }}</span></div>
            <div class="snapshot-summary">{{ snapshot.summary }}</div>
            <div class="snapshot-meta"><span><el-icon><Calendar /></el-icon>{{ snapshot.date }}</span><span>覆盖 {{ snapshot.messages }} 条消息</span><span>{{ snapshot.events }} 个事件</span></div>
          </button>
          <div v-if="!filtered.length" class="empty-state">没有找到符合条件的快照。</div>
        </div>
      </section>

      <aside class="surface panel">
        <template v-if="detail">
          <div class="detail-heading"><div><div class="eyebrow">快照详情 / VERSION {{ detail.version }}</div><h2 class="section-heading">第 {{ detail.number }} 份记忆快照</h2></div><span class="pill" :class="statusTone(detail.status)">{{ detail.status }}</span></div>
          <p class="detail-summary">{{ detail.summary }}</p>
          <div class="metric-row"><span>覆盖时间段</span><span class="metric-value">{{ detail.range }}</span></div>
          <div class="metric-row"><span>生成时间</span><span class="metric-value">{{ detail.date }}</span></div>
          <div class="metric-row"><span>来源消息</span><span class="metric-value">{{ detail.messages }} 条</span></div>
          <div class="metric-row"><span>提炼事件</span><span class="metric-value">{{ detail.events }} 项</span></div>
          <div v-if="detail.analysis" class="analysis-sections">
            <div class="analysis-heading">
              <div class="eyebrow">AI 提炼结果</div>
              <span v-if="detail.model?.name" class="pill pill-purple">{{ detail.model.name }}</span>
            </div>
            <section v-if="detail.analysis.importantEvents.length" class="analysis-block">
              <h3>重要事件</h3>
              <article v-for="(item, index) in detail.analysis.importantEvents" :key="'event-' + index" class="analysis-item">
                <strong>{{ item.title }}</strong><p>{{ item.detail }}</p>
                <small>来源消息：{{ evidenceLabel(item.evidenceMessageIds) }}</small>
              </article>
            </section>
            <section v-if="detail.analysis.factAndPreferenceChanges.length" class="analysis-block">
              <h3>事实与偏好变化</h3>
              <article v-for="(item, index) in detail.analysis.factAndPreferenceChanges" :key="'fact-' + index" class="analysis-item">
                <strong>{{ item.changeType }}</strong><p>{{ item.description }}</p>
                <small>来源消息：{{ evidenceLabel(item.evidenceMessageIds) }}</small>
              </article>
            </section>
            <section v-if="detail.analysis.relationshipChanges.length" class="analysis-block">
              <h3>关系变化</h3>
              <article v-for="(item, index) in detail.analysis.relationshipChanges" :key="'relation-' + index" class="analysis-item">
                <p>{{ item.description }}</p><small>来源消息：{{ evidenceLabel(item.evidenceMessageIds) }}</small>
              </article>
            </section>
            <section v-if="detail.analysis.goalsAndCommitments.length" class="analysis-block">
              <h3>目标与承诺</h3>
              <article v-for="(item, index) in detail.analysis.goalsAndCommitments" :key="'goal-' + index" class="analysis-item">
                <strong>{{ item.status }}</strong><p>{{ item.description }}</p>
                <small>来源消息：{{ evidenceLabel(item.evidenceMessageIds) }}</small>
              </article>
            </section>
            <section v-if="detail.analysis.unresolvedTopics.length" class="analysis-block">
              <h3>待跟进话题</h3>
              <article v-for="(item, index) in detail.analysis.unresolvedTopics" :key="'topic-' + index" class="analysis-item">
                <p>{{ item.description }}</p><small>来源消息：{{ evidenceLabel(item.evidenceMessageIds) }}</small>
              </article>
            </section>
            <section v-if="detail.analysis.differencesFromPrevious.length" class="analysis-block">
              <h3>相较上一快照</h3>
              <ul><li v-for="(item, index) in detail.analysis.differencesFromPrevious" :key="'diff-' + index">{{ item }}</li></ul>
            </section>
            <section v-if="detail.analysis.memoryChangesApplied.length" class="analysis-block">
              <h3>长期记忆维护</h3>
              <article v-for="(item, index) in detail.analysis.memoryChangesApplied" :key="'change-' + index" class="analysis-item">
                <strong>{{ memoryChangeLabel(item.action, item.result) }}</strong>
                <p>{{ item.content || '关联记忆 ' + (item.memoryItemId || item.supersededMemoryId || '—') }}</p>
                <small v-if="item.evidenceMessageIds?.length">依据消息：{{ evidenceLabel(item.evidenceMessageIds) }}</small>
              </article>
            </section>
          </div>
          <div v-else class="info-callout" style="margin-top:19px"><el-icon><Files /></el-icon><span>这是一份手动或旧版快照，当前保存的是结构化记录；自动周期快照的 AI 分析会显示在这里。</span></div>
          <div v-if="detail.kind === 'AUTOMATIC'" class="info-callout" style="margin-top:14px"><span>自动快照已保留模型分析与来源。自动快照的重新提炼入口尚未接入，避免误生成不含 AI 总结的替代版本。</span></div>
          <el-button v-else style="width:100%;margin-top:14px" type="primary" plain :loading="regeneratingId === detail.id" @click="regenerate(detail)"><el-icon><Refresh /></el-icon>重新生成此版本</el-button>
        </template>
        <div v-else class="empty-state">从左侧选择一份快照查看详情。</div>
      </aside>
    </div>
    <p class="footer-note">自动周期快照由独立 Worker 调用模型生成；模型输出中的消息来源会先校验再采纳。手动归档与旧版快照不代表 AI 总结。</p>
  </div>
</template>

<style scoped>
.snapshot-grid{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(320px,.85fr);gap:18px;margin-top:19px;align-items:start}
.snapshot-meta{display:flex;flex-wrap:wrap;gap:14px;margin-top:12px;color:#9ca4b6;font-size:10px}.snapshot-meta span{display:flex;align-items:center;gap:5px}
.detail-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.detail-summary{margin:18px 0 22px;color:#6f7b94;font-size:12px;line-height:1.9}
.analysis-sections{margin-top:22px;padding-top:18px;border-top:1px solid #edf0f6}
.analysis-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}
.analysis-block{margin-top:16px}.analysis-block h3{margin:0 0 9px;color:#47526d;font-size:12px;font-weight:750}
.analysis-item{padding:10px 11px;margin-top:7px;background:#f8f9fd;border:1px solid #edf0f7;border-radius:9px}
.analysis-item strong{color:#566184;font-size:11px}.analysis-item p{margin:5px 0 0;color:#68758e;font-size:12px;line-height:1.8;white-space:pre-wrap;overflow-wrap:anywhere}
.analysis-item small{display:block;margin-top:7px;color:#9ba4b6;font-size:10px}.analysis-block ul{padding-left:18px;color:#68758e;font-size:12px;line-height:1.9}
@media(max-width:850px){.snapshot-grid{grid-template-columns:1fr}.stat-grid[style]{grid-template-columns:1fr!important}}
</style>
