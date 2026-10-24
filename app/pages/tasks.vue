<script setup lang="ts">
import { Refresh, Search, Warning, MagicStick, Files, Cpu } from "@element-plus/icons-vue";
import { ElMessage, ElMessageBox } from "element-plus";

type MemoryTask = {
  id: string;
  type: "GENERATE_SNAPSHOT" | "REGENERATE_SNAPSHOT" | "UPDATE_LONG_TERM_MEMORY" | "CLEAN_EXPIRED_MESSAGES";
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "SKIPPED" | "RETRY_WAIT" | "CANCELLED";
  attemptCount: number;
  maxAttempts: number;
  runAt: string;
  periodStart: string | null;
  periodEnd: string | null;
  lastError: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  characterId: string;
  characterName: string;
  cleanupResult: { deletedMessageCount: number | null; cutoff: string | null; recordedAt: string } | null;
};
type TaskListResponse = {
  items: MemoryTask[];
  total: number;
  statusCounts: Record<MemoryTask["status"], number>;
};
type WorkerResult = {
  processed: boolean;
  jobId?: string;
  status?: "SUCCEEDED" | "SKIPPED" | "RETRY_WAIT" | "FAILED";
  snapshotId?: string;
  message: string;
};
type SchedulerReport = {
  settingsChecked: number;
  settingsAdvanced: number;
  jobsQueued: number;
  periodsConsidered: number;
  missingGlobalScope: number;
  settingsStillDue: number;
  note: string;
};

const tasks = ref<MemoryTask[]>([]);
const totalTasks = ref(0);
const statusCounts = ref<Record<MemoryTask["status"], number>>({
  QUEUED: 0, RUNNING: 0, SUCCEEDED: 0, FAILED: 0, SKIPPED: 0, RETRY_WAIT: 0, CANCELLED: 0,
});
const query = ref("");
const statusFilter = ref("ALL");
const loading = ref(false);
const schedulerRunning = ref(false);
const workerRunning = ref(false);
const loadError = ref("");
const detailsOpen = ref(false);
const selectedTask = ref<MemoryTask | null>(null);
const taskActionLoading = ref(false);

const statuses = [
  { label: "全部状态", value: "ALL" },
  { label: "等待执行", value: "QUEUED" },
  { label: "运行中", value: "RUNNING" },
  { label: "执行成功", value: "SUCCEEDED" },
  { label: "执行失败", value: "FAILED" },
  { label: "等待重试", value: "RETRY_WAIT" },
  { label: "已跳过", value: "SKIPPED" },
  { label: "已取消", value: "CANCELLED" },
];

const queuedCount = computed(() => statusCounts.value.QUEUED);
const runningCount = computed(() => statusCounts.value.RUNNING);
const succeededCount = computed(() => statusCounts.value.SUCCEEDED);
const failedCount = computed(() => statusCounts.value.FAILED + statusCounts.value.RETRY_WAIT);

const filtered = computed(() => tasks.value.filter((task) => {
  const text = [task.id, task.characterName, task.characterId, taskTypeText(task.type)].join(" ").toLowerCase();
  const queryMatches = !query.value || text.includes(query.value.toLowerCase());
  const statusMatches = statusFilter.value === "ALL" || task.status === statusFilter.value;
  return queryMatches && statusMatches;
}));

function taskTypeText(type: MemoryTask["type"]) {
  const names: Record<MemoryTask["type"], string> = {
    GENERATE_SNAPSHOT: "周期快照生成",
    REGENERATE_SNAPSHOT: "快照重新生成",
    UPDATE_LONG_TERM_MEMORY: "长期记忆更新",
    CLEAN_EXPIRED_MESSAGES: "清理过期消息",
  };
  return names[type] || type;
}

function statusText(status: MemoryTask["status"]) {
  const labels: Record<MemoryTask["status"], string> = {
    QUEUED: "等待执行",
    RUNNING: "运行中",
    SUCCEEDED: "执行成功",
    FAILED: "执行失败",
    SKIPPED: "已跳过",
    RETRY_WAIT: "等待重试",
    CANCELLED: "已取消",
  };
  return labels[status];
}

function tone(status: MemoryTask["status"]): "success" | "warning" | "danger" | "info" {
  if (status === "SUCCEEDED") return "success";
  if (status === "FAILED") return "danger";
  if (status === "QUEUED" || status === "RETRY_WAIT") return "warning";
  return "info";
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function periodText(task: MemoryTask) {
  if (!task.periodStart || !task.periodEnd) return "未指定周期范围";
  return `${formatDate(task.periodStart)} — ${formatDate(task.periodEnd)}`;
}

async function loadTasks() {
  loading.value = true;
  loadError.value = "";
  try {
    const result = await $fetch<TaskListResponse>("/api/tasks?limit=100");
    tasks.value = result.items;
    totalTasks.value = result.total;
    statusCounts.value = result.statusCounts;
  } catch (error) {
    tasks.value = [];
    totalTasks.value = 0;
    statusCounts.value = { QUEUED: 0, RUNNING: 0, SUCCEEDED: 0, FAILED: 0, SKIPPED: 0, RETRY_WAIT: 0, CANCELLED: 0 };
    loadError.value = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : error instanceof Error ? error.message : "任务列表读取失败。";
    ElMessage.error("真实任务列表读取失败，请确认开发 API 已启用。");
  } finally {
    loading.value = false;
  }
}

async function runScheduler() {
  if (schedulerRunning.value) return;
  schedulerRunning.value = true;
  try {
    const report = await $fetch<SchedulerReport>("/api/tasks/scheduler/run", { method: "POST" });
    await loadTasks();
    if (report.jobsQueued > 0) {
      ElMessage.success(`扫描完成：排入 ${report.jobsQueued} 个周期任务，处理 ${report.periodsConsidered} 个到期周期。`);
    } else {
      ElMessage.info("扫描完成，目前没有新的到期周期任务。");
    }
  } catch (error) {
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : error instanceof Error ? error.message : "扫描周期失败。";
    ElMessage.error(message);
  } finally {
    schedulerRunning.value = false;
  }
}

async function runWorker() {
  if (workerRunning.value) return;
  workerRunning.value = true;
  try {
    const result = await $fetch<WorkerResult>("/api/tasks/worker/run", { method: "POST" });
    await loadTasks();
    if (!result.processed) {
      ElMessage.info(result.message);
    } else if (result.status === "SUCCEEDED") {
      ElMessage.success(result.message || "任务执行完成。");
    } else if (result.status === "SKIPPED") {
      ElMessage.info("该周期没有已保存活动，任务已跳过。");
    } else {
      ElMessage.warning(result.message);
    }
  } catch (error) {
    const message = error && typeof error === "object" && "statusMessage" in error
      ? String(error.statusMessage)
      : error instanceof Error ? error.message : "执行任务失败。";
    ElMessage.error(message);
  } finally {
    workerRunning.value = false;
  }
}

function openDetails(task: MemoryTask) {
  selectedTask.value = task;
  detailsOpen.value = true;
}

function getErrorMessage(error: unknown, fallback: string) {
  return error && typeof error === "object" && "statusMessage" in error
    ? String(error.statusMessage)
    : error instanceof Error ? error.message : fallback;
}

async function retrySelectedTask() {
  const task = selectedTask.value;
  if (!task || taskActionLoading.value) return;
  try {
    await ElMessageBox.confirm(
      "系统会清除本次任务的错误状态和尝试计数，并立即重新排队。历史审计记录会保留。",
      "重新入队任务",
      { confirmButtonText: "重新入队", cancelButtonText: "取消", type: "warning" },
    );
  } catch {
    return;
  }

  taskActionLoading.value = true;
  try {
    await $fetch(`/api/tasks/${encodeURIComponent(task.id)}/retry`, { method: "POST" });
    await loadTasks();
    selectedTask.value = tasks.value.find((item) => item.id === task.id) ?? null;
    ElMessage.success("任务已重新排队。");
  } catch (error) {
    ElMessage.error(getErrorMessage(error, "任务重新入队失败。"));
  } finally {
    taskActionLoading.value = false;
  }
}

async function cancelSelectedTask() {
  const task = selectedTask.value;
  if (!task || taskActionLoading.value) return;
  try {
    await ElMessageBox.confirm(
      "这会取消尚未开始执行的任务。运行中的任务不能被强制终止，已完成的历史记录不会删除。",
      "取消任务",
      { confirmButtonText: "确认取消", cancelButtonText: "保留任务", type: "warning" },
    );
  } catch {
    return;
  }

  taskActionLoading.value = true;
  try {
    await $fetch(`/api/tasks/${encodeURIComponent(task.id)}/cancel`, { method: "POST" });
    await loadTasks();
    selectedTask.value = tasks.value.find((item) => item.id === task.id) ?? null;
    ElMessage.success("任务已取消，审计记录已保留。");
  } catch (error) {
    ElMessage.error(getErrorMessage(error, "取消任务失败。"));
  } finally {
    taskActionLoading.value = false;
  }
}

onMounted(() => void loadTasks());
</script>

<template>
  <div class="page-wrap">
    <PageHeader eyebrow="系统管理 / 任务监控" title="后台任务" description="查看持久化任务、扫描到期周期、手动运行 Worker，并管理失败、待重试和等待执行的任务。">
      <template #actions>
        <el-button :loading="loading" @click="loadTasks"><el-icon><Refresh /></el-icon>刷新列表</el-button>
        <el-button :loading="workerRunning" @click="runWorker"><el-icon><Cpu /></el-icon>运行一次 Worker</el-button>
        <el-button type="primary" :loading="schedulerRunning" @click="runScheduler"><el-icon><MagicStick /></el-icon>扫描到期周期</el-button>
      </template>
    </PageHeader>

    <div class="stat-grid" style="grid-template-columns:repeat(4,minmax(0,1fr))">
      <StatCard label="全部任务" :value="totalTasks" note="数据库持久化记录" symbol="▤" tone="purple" />
      <StatCard label="等待执行" :value="queuedCount" note="已入队，等待 Worker" symbol="◷" tone="amber" />
      <StatCard label="执行成功" :value="succeededCount" note="已完成任务" symbol="✓" tone="green" />
      <StatCard label="失败 / 待重试" :value="failedCount" note="需要排查或重试" symbol="!" tone="blue" />
    </div>

    <section class="surface panel" style="margin-top:20px">
      <div class="filter-row">
        <div class="filter-grow"><el-input v-model="query" clearable placeholder="搜索任务名称、编号或角色……"><template #prefix><el-icon><Search /></el-icon></template></el-input></div>
        <el-select v-model="statusFilter" style="width:160px"><el-option v-for="status in statuses" :key="status.value" :label="status.label" :value="status.value" /></el-select>
      </div>
      <div class="filter-summary"><span>显示 <strong>{{ filtered.length }}</strong> 项 · 共 <strong>{{ totalTasks }}</strong> 项任务</span><span>列表最多加载最近 100 条</span></div>
      <el-table v-loading="loading" :data="filtered" style="width:100%;margin-top:15px" row-key="id">
        <el-table-column label="任务编号" width="120">
          <template #default="{ row }"><span :title="row.id">{{ row.id.slice(0, 8) }}</span></template>
        </el-table-column>
        <el-table-column label="任务" min-width="175">
          <template #default="{ row }"><div class="table-main">{{ taskTypeText(row.type) }}</div><div class="table-sub">{{ row.characterName }}</div></template>
        </el-table-column>
        <el-table-column label="处理范围" min-width="240">
          <template #default="{ row }">{{ periodText(row as MemoryTask) }}</template>
        </el-table-column>
        <el-table-column label="状态" width="125">
          <template #default="{ row }"><el-tag :type="tone(row.status)" effect="light" round>{{ statusText(row.status) }}</el-tag></template>
        </el-table-column>
        <el-table-column label="执行结果" min-width="135">
          <template #default="{ row }">
            <span v-if="row.type === 'CLEAN_EXPIRED_MESSAGES' && row.cleanupResult">
              已删除 {{ row.cleanupResult.deletedMessageCount ?? '未知' }} 条
            </span>
            <span v-else-if="row.type === 'CLEAN_EXPIRED_MESSAGES' && row.status === 'SUCCEEDED'">审计记录暂不可用</span>
            <span v-else>—</span>
          </template>
        </el-table-column>
        <el-table-column label="尝试次数" width="105" align="center">
          <template #default="{ row }">{{ row.attemptCount }} / {{ row.maxAttempts }}</template>
        </el-table-column>
        <el-table-column label="最近活动" min-width="155">
          <template #default="{ row }">{{ formatDate(row.updatedAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }"><el-button text type="primary" @click="openDetails(row as MemoryTask)">详情</el-button></template>
        </el-table-column>
        <template #empty><div class="empty-state">{{ loadError || "暂无数据库任务。启用角色的自动归档并到达周期边界后，可以扫描到期任务。" }}</div></template>
      </el-table>
    </section>

    <div class="info-callout" style="margin-top:18px">
      <el-icon><Warning /></el-icon>
      <span>任务由独立 Worker 消费。周期生成与 AI 重新提炼会调用服务端配置的模型；过期消息清理任务也可在失败后手动重新入队。重新入队与清理结果均会保留审计记录。</span>
    </div>

    <el-dialog v-model="detailsOpen" title="任务详情" width="min(620px, 94vw)">
      <template v-if="selectedTask">
        <div class="detail-row"><span>任务编号</span><code>{{ selectedTask.id }}</code></div>
        <div class="detail-row"><span>任务类型</span><strong>{{ taskTypeText(selectedTask.type) }}</strong></div>
        <div class="detail-row"><span>所属角色</span><strong>{{ selectedTask.characterName }}</strong></div>
        <div class="detail-row"><span>状态</span><el-tag :type="tone(selectedTask.status)" effect="light" round>{{ statusText(selectedTask.status) }}</el-tag></div>
        <div class="detail-row"><span>处理周期</span><strong>{{ periodText(selectedTask) }}</strong></div>
        <div class="detail-row"><span>尝试次数</span><strong>{{ selectedTask.attemptCount }} / {{ selectedTask.maxAttempts }}</strong></div>
        <div class="detail-row"><span>计划执行时间</span><strong>{{ formatDate(selectedTask.runAt) }}</strong></div>
        <div class="detail-row"><span>开始时间</span><strong>{{ formatDate(selectedTask.startedAt) }}</strong></div>\n        <div class="detail-row"><span>完成时间</span><strong>{{ formatDate(selectedTask.completedAt) }}</strong></div>\n        <div class="detail-row"><span>创建时间</span><strong>{{ formatDate(selectedTask.createdAt) }}</strong></div>
        <template v-if="selectedTask.type === 'CLEAN_EXPIRED_MESSAGES'">
          <div class="detail-row"><span>清理结果</span><strong>{{ selectedTask.cleanupResult ? `已删除 ${selectedTask.cleanupResult.deletedMessageCount ?? "未知"} 条原始消息` : selectedTask.status === 'SUCCEEDED' ? "未找到对应审计记录" : "尚无成功清理记录" }}</strong></div>
          <div v-if="selectedTask.cleanupResult?.cutoff" class="detail-row"><span>清理截止时间</span><strong>{{ formatDate(selectedTask.cleanupResult.cutoff) }} 之前</strong></div>
          <div v-if="selectedTask.cleanupResult" class="detail-row"><span>审计记录时间</span><strong>{{ formatDate(selectedTask.cleanupResult.recordedAt) }}</strong></div>
        </template>
        <div v-if="selectedTask.lastError" class="task-error"><strong>最近错误</strong><p>{{ selectedTask.lastError }}</p></div>
        <div v-else class="info-callout" style="margin-top:14px"><el-icon><Files /></el-icon><span>当前为持久化排队记录；还没有 Worker 执行日志。</span></div>
      </template>
      <template #footer>
        <el-button v-if="selectedTask && ['FAILED', 'RETRY_WAIT', 'CANCELLED'].includes(selectedTask.status) && ['GENERATE_SNAPSHOT', 'REGENERATE_SNAPSHOT', 'CLEAN_EXPIRED_MESSAGES'].includes(selectedTask.type)" :loading="taskActionLoading" @click="retrySelectedTask"><el-icon><Refresh /></el-icon>重新入队</el-button>
        <el-button v-if="selectedTask && ['QUEUED', 'RETRY_WAIT'].includes(selectedTask.status)" :loading="taskActionLoading" @click="cancelSelectedTask"><el-icon><Warning /></el-icon>取消任务</el-button>
        <el-button @click="detailsOpen = false">关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.table-main{color:#46516b;font-size:11px;font-weight:750}.table-sub{margin-top:5px;color:#9ba3b5;font-size:10px}
.detail-row{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:10px 0;border-bottom:1px solid #f0f1f6;font-size:12px}.detail-row>span{color:#8b95aa;flex:0 0 110px}.detail-row>strong,.detail-row>code{color:#48536c;overflow-wrap:anywhere;text-align:right}.task-error{margin-top:14px;padding:13px;border-radius:10px;background:#fff1f0;color:#a53c37;font-size:12px}.task-error p{margin:7px 0 0;line-height:1.7;white-space:pre-wrap}
@media(max-width:650px){.stat-grid[style]{grid-template-columns:repeat(2,minmax(0,1fr))!important}.detail-row{flex-direction:column;gap:5px}.detail-row>strong,.detail-row>code{text-align:left}}
</style>
