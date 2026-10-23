<script setup lang="ts">
import { ArrowLeft, Calendar, Clock, Files, Refresh, Search, MagicStick } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { initialCharacters, initialSnapshots, type Character, type Snapshot } from "~/utils/mock-data";

const route = useRoute();
const id = computed(() => String(route.params.id || "big-fish"));
const characters = useState<Character[]>("characters", () => initialCharacters.map((item) => ({ ...item, channels: [...item.channels] })));
const character = computed(() => characters.value.find((item) => item.id === id.value) || { ...initialCharacters[0], id: id.value, name: "新建角色" });
const items = useState<Snapshot[]>("snapshots", () => initialSnapshots.map((item) => ({ ...item })));
const query = ref("");
const statusFilter = ref("全部版本状态");
const detail = ref<Snapshot | null>(items.value[0] || null);

const filtered = computed(() => items.value.filter((item) => {
  const queryMatches = !query.value || `${item.summary} ${item.range} 第 ${item.number} 份`.toLowerCase().includes(query.value.toLowerCase());
  const statusMatches = statusFilter.value === "全部版本状态" || item.status === statusFilter.value;
  return queryMatches && statusMatches;
}));
function resetFilters() { query.value = ""; statusFilter.value = "全部版本状态"; }
function statusTone(status: Snapshot["status"]) { return status === "当前版本" ? "pill-green" : "pill-gray"; }
async function regenerate(snapshot: Snapshot) {
  try {
    await ElMessageBox.confirm(`为第 ${snapshot.number} 份快照创建一个新版本？旧版本会保留。`, "重新生成快照", { confirmButtonText: "创建新版本", cancelButtonText: "取消", type: "info" });
  } catch { return; }
  const newVersion: Snapshot = {
    ...snapshot, id: `${snapshot.id}-v${snapshot.version + 1}-${Date.now()}`,
    version: snapshot.version + 1, date: "刚刚（演示）", status: "当前版本", statusTone: "green",
    summary: "这是重新生成的演示版本。真实实现将保留旧版本，并记录本次生成所使用的模型与来源。",
  };
  items.value = [newVersion, ...items.value.map((item) => item.id === snapshot.id ? { ...item, status: "已被替代" as const, statusTone: "gray" as const } : item)];
  detail.value = newVersion;
  ElMessage.success(`第 ${snapshot.number} 份快照已创建演示版本 v${newVersion.version}；旧版本保留。`);
}
</script>

<template>
  <div class="page-wrap">
    <PageHeader :eyebrow="`角色管理 / ${character.name} / 周期快照`" title="周期快照档案" description="每份快照都是一个时间段的记忆归档。重新生成会创建新版本，旧版本不会被覆盖。">
      <template #actions><DemoTag /><el-button @click="navigateTo('/characters/' + character.id)"><el-icon><ArrowLeft /></el-icon>返回驾驶舱</el-button><el-button type="primary" @click="ElMessage.info('已排入演示快照任务；真实生成器尚未接入。')"><el-icon><MagicStick /></el-icon>生成快照</el-button></template>
    </PageHeader>

    <div class="stat-grid" style="grid-template-columns:repeat(3,minmax(0,1fr))">
      <StatCard label="历史快照" :value="String(items.length).padStart(2, '0')" note="包含演示版本" symbol="▤" tone="purple" />
      <StatCard label="覆盖消息" :value="String(items.reduce((sum, item) => sum + item.messages, 0))" note="来源记录统计" symbol="☰" tone="blue" />
      <StatCard label="最近生成" :value="items[0]?.date.includes('刚刚') ? '刚刚' : '10/21'" note="仅当前演示状态" symbol="◷" tone="green" />
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
          <div class="info-callout" style="margin-top:19px"><el-icon><Files /></el-icon><span>重新生成会新增版本，旧版保留供审查与来源追溯。</span></div>
          <el-button style="width:100%;margin-top:14px" type="primary" plain @click="regenerate(detail)"><el-icon><Refresh /></el-icon>重新生成此版本</el-button>
        </template>
        <div v-else class="empty-state">从左侧选择一份快照查看详情。</div>
      </aside>
    </div>
    <p class="footer-note">重新生成和状态切换仅修改演示状态；真实模型调用和版本持久化尚未接入。</p>
  </div>
</template>

<style scoped>
.snapshot-grid{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(320px,.85fr);gap:18px;margin-top:19px;align-items:start}
.snapshot-meta{display:flex;flex-wrap:wrap;gap:14px;margin-top:12px;color:#9ca4b6;font-size:10px}.snapshot-meta span{display:flex;align-items:center;gap:5px}
.detail-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.detail-summary{margin:18px 0 22px;color:#6f7b94;font-size:12px;line-height:1.9}
@media(max-width:850px){.snapshot-grid{grid-template-columns:1fr}.stat-grid[style]{grid-template-columns:1fr!important}}
</style>
