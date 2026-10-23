<script setup lang="ts">
import { Refresh, Search, Warning } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { initialTasks, type DemoTask } from "~/utils/mock-data";

const tasks = useState<DemoTask[]>("demo-tasks", () => initialTasks.map((item) => ({ ...item })));
const query = ref("");
const statusFilter = ref("全部状态");
const filtered = computed(() => tasks.value.filter((task) => {
  const queryMatches = !query.value || (task.id + " " + task.name + " " + task.character).toLowerCase().includes(query.value.toLowerCase());
  const statusMatches = statusFilter.value === "全部状态" || task.status === statusFilter.value;
  return queryMatches && statusMatches;
}));
function retry(task: DemoTask) {
  task.status = "等待执行";
  task.tone = "amber";
  task.tries += 1;
  task.time = "刚刚加入演示队列";
  ElMessage.info("已更改为演示等待状态；当前没有真实 Worker 执行任务。");
}
function tone(status: string) {
  const values: Record<string, "success" | "warning" | "danger" | "info"> = {
    成功: "success", 等待执行: "warning", 失败待重试: "danger", 跳过: "info", 运行中: "info",
  };
  return values[status] || "info";
}
</script>

<template>
  <div class="page-wrap">
    <PageHeader eyebrow="系统管理 / 任务监控" title="后台任务" description="查看记忆快照、长期记忆整理与渠道同步任务。正式任务将由可恢复的独立 Worker 执行。">
      <template #actions><DemoTag /><el-button @click="ElMessage.info('演示数据刷新完成。')"><el-icon><Refresh /></el-icon>刷新列表</el-button></template>
    </PageHeader>

    <div class="stat-grid" style="grid-template-columns:repeat(4,minmax(0,1fr))">
      <StatCard label="全部任务" :value="tasks.length" note="当前演示列表" symbol="▤" tone="purple" />
      <StatCard label="等待执行" :value="tasks.filter(t => t.status === '等待执行').length" note="等待队列" symbol="◷" tone="amber" />
      <StatCard label="执行成功" :value="tasks.filter(t => t.status === '成功').length" note="当前列表统计" symbol="✓" tone="green" />
      <StatCard label="需要重试" :value="tasks.filter(t => t.status === '失败待重试').length" note="等待人工留意" symbol="!" tone="blue" />
    </div>

    <section class="surface panel" style="margin-top:20px">
      <div class="filter-row">
        <div class="filter-grow"><el-input v-model="query" clearable placeholder="搜索任务名称、编号或角色……"><template #prefix><el-icon><Search /></el-icon></template></el-input></div>
        <el-select v-model="statusFilter" style="width:160px"><el-option v-for="status in ['全部状态','等待执行','运行中','成功','失败待重试','跳过']" :key="status" :label="status" :value="status" /></el-select>
      </div>
      <div class="filter-summary"><span>显示 <strong>{{ filtered.length }}</strong> 项任务</span><span>任务重试为演示操作，不会触发后台作业</span></div>
      <el-table :data="filtered" style="width:100%;margin-top:15px" row-key="id">
        <el-table-column prop="id" label="任务编号" width="100" />
        <el-table-column label="任务" min-width="180">
          <template #default="{ row }"><div class="table-main">{{ row.name }}</div><div class="table-sub">{{ row.character }}</div></template>
        </el-table-column>
        <el-table-column prop="range" label="处理范围" min-width="180" />
        <el-table-column label="状态" width="130">
          <template #default="{ row }"><el-tag :type="tone(row.status)" effect="light" round>{{ row.status }}</el-tag></template>
        </el-table-column>
        <el-table-column label="重试次数" width="100" align="center"><template #default="{ row }">{{ row.tries }}</template></el-table-column>
        <el-table-column prop="time" label="最近活动" min-width="150" />
        <el-table-column label="操作" width="100" fixed="right">
          <template #default="{ row }"><el-button v-if="row.status === '失败待重试'" text type="primary" @click="retry(row)">重试</el-button><el-button v-else text @click="ElMessage.info('任务详情接口尚未实现。')">详情</el-button></template>
        </el-table-column>
        <template #empty><div class="empty-state">没有符合条件的任务。</div></template>
      </el-table>
    </section>
    <div class="info-callout" style="margin-top:18px"><el-icon><Warning /></el-icon><span>生产任务需要持久化任务状态、幂等键、失败重试与补处理能力。此页面仍然使用内存中的 Mock 数据。</span></div>
  </div>
</template>

<style scoped>
.table-main{color:#46516b;font-size:11px;font-weight:750}.table-sub{margin-top:5px;color:#9ba3b5;font-size:10px}
@media(max-width:650px){.stat-grid[style]{grid-template-columns:repeat(2,minmax(0,1fr))!important}}
</style>
