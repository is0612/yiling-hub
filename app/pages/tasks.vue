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
  status?: "SUCCEEDED" | "SKIPPED" | "RETRY_WAIT" | "FAILED" | "CANCELLED";
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
const loading = ref(true);
const schedulerRunning = ref(false);
const workerRunning = ref(false);
const loadError = ref("");
const detailsOpen = ref(false);
const selectedTask = ref<MemoryTask | null>(null);
const taskActionLoading = ref(false);

const statuses = [
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
const hasFilters = computed(() => Boolean(query.value) || statusFilter.value !== "ALL");

const filtered = computed(() => tasks.value.filter((task) => {
  const text = [task.id, task.characterName, task.characterId, taskTypeText(task.type)].join(" ").toLowerCase();
  const queryMatches = !query.value || text.includes(query.value.toLowerCase());
  const statusMatches = statusFilter.value === "ALL"
    ? true
    : statusFilter.value === "ISSUES"
      ? task.status === "FAILED" || task.status === "RETRY_WAIT"
      : task.status === statusFilter.value;
  return queryMatches && statusMatches;
}));

function resetFilters() {
  query.value = "";
  statusFilter.value = "ALL";
}

function taskTypeText(type: MemoryTask["type"]) {
  const names: Record<MemoryTask["type"], string> = {
    GENERATE_SNAPSHOT: "生成阶段总结",
    REGENERATE_SNAPSHOT: "重新生成总结",
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

function tone(status: MemoryTask["status"]) {
  if (status === "SUCCEEDED") return "pill-green";
  if (status === "FAILED") return "pill-rose";
  if (status === "QUEUED" || status === "RETRY_WAIT") return "pill-amber";
  if (status === "RUNNING") return "pill-blue";
  return "pill-gray";
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function periodText(task: MemoryTask) {
  if (task.type === "CLEAN_EXPIRED_MESSAGES") {
    return task.periodEnd ? `清理 ${formatDate(task.periodEnd)} 之前的原始消息` : "未指定清理截止时间";
  }
  if (!task.periodStart || !task.periodEnd) return "未指定周期范围";
  return `${formatDate(task.periodStart)} — ${formatDate(task.periodEnd)}`;
}

function taskIssueTitle(task: MemoryTask) {
  if (task.status === "SKIPPED") return "跳过原因";
  if (task.status === "RETRY_WAIT") return "最近失败原因";
  if (task.status === "FAILED") return "失败原因";
  return "任务信息";
}

function taskStatusHint(task: MemoryTask) {
  if (task.status === "QUEUED") return "任务已进入持久化队列，等待 Worker 执行。";
  if (task.status === "RUNNING") return "Worker 正在执行该任务。";
  if (task.status === "SUCCEEDED") return "任务已完成，没有记录错误。";
  if (task.status === "SKIPPED") return "该任务没有需要处理的活动，已按规则跳过。";
  if (task.status === "RETRY_WAIT") return "任务执行未成功，系统会在计划时间再次尝试。";
  if (task.status === "CANCELLED") return "任务已取消，历史记录与审计信息会保留。";
  return "该任务已失败，请查看失败原因并在必要时重新入队。";
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
      ElMessage.info(result.message || "该周期没有已保存活动，任务已跳过。");
    } else if (result.status === "CANCELLED") {
      ElMessage.info(result.message || "任务已取消。");
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
    <PageHeader
      eyebrow="系统管理 / 任务监控"
      title="后台任务"
      description="查看持久化任务、扫描到期周期、手动运行 Worker，并管理失败、待重试和等待执行的任务。"
    >
      <template #actions>
        <button
          type="button"
          class="btn"
          :disabled="loading"
          @click="loadTasks"
        >
          <el-icon><Refresh /></el-icon>刷新列表
        </button>
        <button
          type="button"
          class="btn"
          :disabled="workerRunning"
          @click="runWorker"
        >
          <el-icon><Cpu /></el-icon>运行一次 Worker
        </button>
        <button
          type="button"
          class="btn primary"
          :disabled="schedulerRunning"
          @click="runScheduler"
        >
          <el-icon><MagicStick /></el-icon>扫描到期周期
        </button>
      </template>
    </PageHeader>

    <!-- 状态概况同时承担筛选入口：看清分布后直接点进去 -->
    <div class="kpi-row">
      <button
        type="button"
        class="kpi is-action"
        :class="{ 'is-on': statusFilter === 'ALL' }"
        @click="statusFilter = 'ALL'"
      >
        <span class="k">全部任务</span>
        <span class="v">{{ totalTasks }}<small>项</small></span>
        <span class="foot">列表加载最近 100 条</span>
      </button>
      <button
        type="button"
        class="kpi is-action"
        :class="{ 'is-on': statusFilter === 'QUEUED' }"
        @click="statusFilter = 'QUEUED'"
      >
        <span class="k">等待执行</span>
        <span class="v">{{ queuedCount }}<small>项</small></span>
        <span class="foot">已排队，等 Worker 领取</span>
      </button>
      <button
        type="button"
        class="kpi is-action"
        :class="{ 'is-on': statusFilter === 'SUCCEEDED' }"
        @click="statusFilter = 'SUCCEEDED'"
      >
        <span class="k">执行成功</span>
        <span class="v">{{ succeededCount }}<small>项</small></span>
        <span class="foot">运行中 {{ runningCount }} 项</span>
      </button>
      <button
        type="button"
        class="kpi is-action"
        :class="{ 'is-on': statusFilter === 'ISSUES', 'is-alert': failedCount > 0 }"
        @click="statusFilter = 'ISSUES'"
      >
        <span class="k">失败 / 待重试</span>
        <span class="v">{{ failedCount }}<small>项</small></span>
        <span class="foot">{{ failedCount ? "需要处理，点开看错误原因" : "全部正常" }}</span>
      </button>
    </div>

    <div class="sec-h">
      <h2>任务列表</h2>
      <span class="sub">{{ filtered.length }}/{{ totalTasks }} 项</span>
      <button
        v-if="hasFilters"
        type="button"
        class="more"
        @click="resetFilters"
      >
        重置筛选
      </button>
    </div>
    <div class="card table-card">
      <div class="filter-row">
        <div class="filter-grow">
          <el-input
            v-model="query"
            clearable
            placeholder="搜索任务名称、编号或角色……"
          >
            <template #prefix>
              <el-icon><Search /></el-icon>
            </template>
          </el-input>
        </div>
        <el-select
          v-model="statusFilter"
          style="width:170px"
        >
          <el-option
            label="全部状态"
            value="ALL"
          />
          <el-option
            v-for="status in statuses"
            :key="status.value"
            :label="status.label"
            :value="status.value"
          />
        </el-select>
      </div>
      <el-table
        v-loading="loading"
        :data="filtered"
        style="width:100%"
        row-key="id"
      >
        <el-table-column
          label="任务编号"
          width="120"
        >
          <template #default="{ row }">
            <span :title="row.id">{{ row.id.slice(0, 8) }}</span>
          </template>
        </el-table-column>
        <el-table-column
          label="任务"
          min-width="175"
        >
          <template #default="{ row }">
            <div class="table-main">
              {{ taskTypeText(row.type) }}
            </div><div class="table-sub">
              {{ row.characterName }}
            </div>
          </template>
        </el-table-column>
        <el-table-column
          label="处理范围"
          min-width="240"
        >
          <template #default="{ row }">
            {{ periodText(row as MemoryTask) }}
          </template>
        </el-table-column>
        <el-table-column
          label="状态"
          width="125"
        >
          <template #default="{ row }">
            <span
              class="pill"
              :class="tone(row.status)"
            >{{ statusText(row.status) }}</span>
          </template>
        </el-table-column>
        <el-table-column
          label="执行结果"
          min-width="135"
        >
          <template #default="{ row }">
            <span v-if="row.type === 'CLEAN_EXPIRED_MESSAGES' && row.cleanupResult">
              已删除 {{ row.cleanupResult.deletedMessageCount ?? '未知' }} 条
            </span>
            <span v-else-if="row.type === 'CLEAN_EXPIRED_MESSAGES' && row.status === 'SUCCEEDED'">审计记录暂不可用</span>
            <span v-else>—</span>
          </template>
        </el-table-column>
        <el-table-column
          label="尝试次数"
          width="105"
          align="center"
        >
          <template #default="{ row }">
            {{ row.attemptCount }} / {{ row.maxAttempts }}
          </template>
        </el-table-column>
        <el-table-column
          label="最近活动"
          min-width="155"
        >
          <template #default="{ row }">
            {{ formatDate(row.updatedAt) }}
          </template>
        </el-table-column>
        <el-table-column
          label="操作"
          width="90"
          fixed="right"
        >
          <template #default="{ row }">
            <el-button
              text
              type="primary"
              @click="openDetails(row as MemoryTask)"
            >
              详情
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <div class="card-empty">
            <el-icon><Files /></el-icon>
            <span>{{ loadError ? "任务列表读取失败" : "暂无数据库任务" }}</span>
            <span>{{ loadError || "启用角色的自动归档并到达周期边界后，可以扫描到期任务" }}</span>
          </div>
        </template>
      </el-table>
    </div>

    <p class="footer-note">
      任务由独立 Worker 消费。周期生成与 AI 重新提炼会调用服务端配置的模型；重新入队与清理结果都会保留审计记录。
    </p>

    <el-dialog
      v-model="detailsOpen"
      title="任务详情"
      width="min(620px, 94vw)"
    >
      <template v-if="selectedTask">
        <div class="detail-row">
          <span>任务编号</span><code>{{ selectedTask.id }}</code>
        </div>
        <div class="detail-row">
          <span>任务类型</span><strong>{{ taskTypeText(selectedTask.type) }}</strong>
        </div>
        <div class="detail-row">
          <span>所属角色</span><strong>{{ selectedTask.characterName }}</strong>
        </div>
        <div class="detail-row">
          <span>状态</span><span
            class="pill"
            :class="tone(selectedTask.status)"
          >{{ statusText(selectedTask.status) }}</span>
        </div>
        <div class="detail-row">
          <span>处理周期</span><strong>{{ periodText(selectedTask) }}</strong>
        </div>
        <div class="detail-row">
          <span>尝试次数</span><strong>{{ selectedTask.attemptCount }} / {{ selectedTask.maxAttempts }}</strong>
        </div>
        <div class="detail-row">
          <span>计划执行时间</span><strong>{{ formatDate(selectedTask.runAt) }}</strong>
        </div>
        <div class="detail-row">
          <span>开始时间</span><strong>{{ formatDate(selectedTask.startedAt) }}</strong>
        </div>
        <div class="detail-row">
          <span>完成时间</span><strong>{{ formatDate(selectedTask.completedAt) }}</strong>
        </div>
        <div class="detail-row">
          <span>创建时间</span><strong>{{ formatDate(selectedTask.createdAt) }}</strong>
        </div>
        <template v-if="selectedTask.type === 'CLEAN_EXPIRED_MESSAGES'">
          <div class="detail-row">
            <span>清理结果</span><strong>{{ selectedTask.cleanupResult ? `已删除 ${selectedTask.cleanupResult.deletedMessageCount ?? "未知"} 条原始消息` : selectedTask.status === 'SUCCEEDED' ? "未找到对应审计记录" : "尚无成功清理记录" }}</strong>
          </div>
          <div
            v-if="selectedTask.cleanupResult?.cutoff"
            class="detail-row"
          >
            <span>清理截止时间</span><strong>{{ formatDate(selectedTask.cleanupResult.cutoff) }} 之前</strong>
          </div>
          <div
            v-if="selectedTask.cleanupResult"
            class="detail-row"
          >
            <span>审计记录时间</span><strong>{{ formatDate(selectedTask.cleanupResult.recordedAt) }}</strong>
          </div>
        </template>
        <div
          v-if="selectedTask.lastError"
          class="task-error"
        >
          <strong>{{ taskIssueTitle(selectedTask) }}</strong>
          <p>{{ selectedTask.lastError }}</p>
        </div>
        <div
          v-else
          class="info-callout detail-callout"
        >
          <el-icon><Files /></el-icon>
          <span>{{ taskStatusHint(selectedTask) }}</span>
        </div>
      </template>
      <template #footer>
        <el-button
          v-if="selectedTask && ['FAILED', 'RETRY_WAIT', 'CANCELLED'].includes(selectedTask.status) && ['GENERATE_SNAPSHOT', 'REGENERATE_SNAPSHOT', 'CLEAN_EXPIRED_MESSAGES'].includes(selectedTask.type)"
          :loading="taskActionLoading"
          @click="retrySelectedTask"
        >
          <el-icon><Refresh /></el-icon>重新入队
        </el-button>
        <el-button
          v-if="selectedTask && ['QUEUED', 'RETRY_WAIT'].includes(selectedTask.status)"
          :loading="taskActionLoading"
          @click="cancelSelectedTask"
        >
          <el-icon><Warning /></el-icon>取消任务
        </el-button>
        <el-button @click="detailsOpen = false">
          关闭
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
/* KPI 兼作筛选入口：选中态用品牌浅底，失败格数值转红 */
.kpi{width:100%;font:inherit;cursor:pointer;transition:border-color .14s var(--ease),background .14s var(--ease)}
.kpi.is-on{border-color:var(--brand-line);background:#fffafb}
.kpi.is-on .k{color:var(--brand-strong);font-weight:600}
.kpi.is-alert .v{color:var(--red)}

.table-card{padding:14px 16px 6px}
.table-card .filter-row{margin-bottom:12px}
.table-main{color:var(--text-2);font-size:14px;font-weight:600}
.table-sub{margin-top:3px;color:var(--faint);font-size:12px}

.detail-row{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;border-bottom:1px solid var(--line);padding:10px 0;font-size:12px}
.detail-row>span{flex:0 0 110px;color:var(--dim)}
.detail-row>strong,.detail-row>code{color:var(--text-2);overflow-wrap:anywhere;text-align:right}
.detail-row>code{font-size:12px}
.task-error{margin-top:14px;border-radius:var(--radius-sm);background:var(--red-soft);padding:12px 14px;color:var(--red);font-size:12px}
.task-error p{margin:7px 0 0;line-height:1.7;white-space:pre-wrap}
.detail-callout{margin-top:14px}

@media(max-width:650px){
  .detail-row{flex-direction:column;gap:5px}
  .detail-row>strong,.detail-row>code{text-align:left}
}
</style>
