<script setup lang="ts">
import { Calendar, Clock, DataAnalysis, Files, MagicStick, User, ChatDotRound, ArrowRight } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { initialTimeline } from "~/utils/mock-data";

const characters = useCharacterList();
const primaryCharacter = computed(() => characters.value[0] ?? null);
const timeline = initialTimeline;
const weeks = [
  { day: "周一", value: 44 }, { day: "周二", value: 62 }, { day: "周三", value: 51 },
  { day: "周四", value: 76 }, { day: "周五", value: 58 }, { day: "周六", value: 86 }, { day: "周日", value: 68 },
];
const weekMax = Math.max(...weeks.map((w) => w.value));
const weekAvg = Math.round(weeks.reduce((sum, w) => sum + w.value, 0) / weeks.length);
const weekPeak = weeks.reduce((a, b) => (a.value >= b.value ? a : b));
const weekTotal = weeks.reduce((sum, w) => sum + w.value, 0);
// 当前周期第 8 段（7 天已过，今天为第 8 天）
const periodProgress = 87.5;

// 后台任务：首页接入真实任务数据，失败/等待重试时在顶部告警。
type RealTask = { id: string; type: string; status: string; characterName: string; createdAt: string };
const taskTypeNames: Record<string, string> = {
  GENERATE_SNAPSHOT: "周期快照生成",
  REGENERATE_SNAPSHOT: "快照重新生成",
  UPDATE_LONG_TERM_MEMORY: "长期记忆更新",
  CLEAN_EXPIRED_MESSAGES: "清理过期消息",
};
const taskStatusLabels: Record<string, string> = {
  QUEUED: "等待执行", RUNNING: "运行中", SUCCEEDED: "执行成功", FAILED: "执行失败",
  SKIPPED: "已跳过", RETRY_WAIT: "等待重试", CANCELLED: "已取消",
};
const realTasks = ref<RealTask[]>([]);
const failedCount = ref(0);
const pendingCount = ref(0);

function taskTone(status: string) {
  if (status === "SUCCEEDED") return "ok";
  if (status === "FAILED") return "err";
  if (status === "QUEUED" || status === "RETRY_WAIT") return "wait";
  if (status === "RUNNING") return "run";
  return "mute";
}
function taskStatusLabel(status: string) {
  return taskStatusLabels[status] ?? status;
}
function taskTypeLabel(type: string) {
  return taskTypeNames[type] ?? type;
}
function formatTaskTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (input: number) => String(input).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
async function loadTasks() {
  try {
    const data = await $fetch<{ items: RealTask[]; statusCounts: Record<string, number> }>("/api/tasks?limit=5");
    realTasks.value = data.items;
    failedCount.value = (data.statusCounts.FAILED ?? 0) + (data.statusCounts.RETRY_WAIT ?? 0);
    pendingCount.value = (data.statusCounts.QUEUED ?? 0) + (data.statusCounts.RUNNING ?? 0);
  } catch {
    // 保持空值，首页不因任务接口失败而报错。
  }
}

// 与布局共用同一份角色数据，首屏直接渲染真实角色。
await useCharacterListData();

onMounted(() => {
  if (!characters.value.length) {
    ElMessage.warning("角色数据暂不可用；请完成本地数据库初始化后刷新页面。");
  }
  loadTasks();
});

const memoryIcon = (type: string) =>
  type === "snapshot" ? Files : type === "memory" ? MagicStick : type === "message" ? ChatDotRound : Clock;
</script>

<template>
  <div class="page-wrap">
    <PageHeader
      eyebrow="工作空间 / 总览"
      title="今天的工作台"
      description="角色近期活动、记忆归档与后台任务，一屏看完。"
    >
      <template #actions>
        <DemoTag />
        <button
          class="btn"
          type="button"
          :disabled="!primaryCharacter"
          @click="primaryCharacter && navigateTo(`/characters/${primaryCharacter.id}/chat`)"
        >
          开始对话
        </button>
        <button
          class="btn primary"
          type="button"
          @click="navigateTo('/characters')"
        >
          <el-icon><User /></el-icon>新建角色
        </button>
      </template>
    </PageHeader>

    <div
      v-if="failedCount > 0"
      class="task-alert"
    >
      <el-icon><Clock /></el-icon>
      <span>有 {{ failedCount }} 个后台任务失败或等待重试。</span>
      <button
        class="card-link"
        type="button"
        @click="navigateTo('/tasks')"
      >
        去任务监控处理
      </button>
    </div>

    <!-- KPI 四格：今天怎么样 -->
    <div class="kpi-row">
      <div class="kpi">
        <div class="k">
          <el-icon><Calendar /></el-icon>当前周期
        </div>
        <div class="v">
          {{ periodProgress }}<small>%</small>
        </div>
        <div class="bar">
          <i :style="{ width: periodProgress + '%' }" />
        </div>
        <div class="foot">
          周期进度 · 10 月 21 日 — 10 月 29 日
        </div>
      </div>

      <div class="kpi">
        <div class="k">
          <el-icon><MagicStick /></el-icon>长期记忆
        </div>
        <div class="v">
          238<small>条</small>
        </div>
        <div class="foot">
          较上周期 <em>+12</em>
        </div>
      </div>

      <div class="kpi">
        <div class="k">
          <el-icon><Files /></el-icon>周期快照
        </div>
        <div class="v">
          13<small>份</small>
        </div>
        <div class="foot">
          覆盖全部角色 · 第 13 份正在生成
        </div>
      </div>

      <button
        class="kpi is-action"
        type="button"
        title="打开任务监控"
        @click="navigateTo('/tasks')"
      >
        <div class="k">
          <el-icon><Clock /></el-icon>待处理任务
        </div>
        <div class="v">
          {{ pendingCount }}<small>项</small>
        </div>
        <div class="foot">
          <span v-if="failedCount > 0">{{ failedCount }} 个失败待处理</span>
          <span v-else>暂无异常</span>
        </div>
      </button>
    </div>

    <!-- 左：记忆活动 / 最近记忆　右：最近任务 -->
    <div class="home-cols">
      <div>
        <div class="sec-h">
          <h2>记忆活动</h2>
          <span class="sub">近 7 天被记录的消息与事件</span>
        </div>
        <div class="card">
          <div class="chart-in">
            <div class="chart-head">
              <strong>{{ weekTotal }}</strong>
              <span class="chart-delta"><el-icon><DataAnalysis /></el-icon>本周合计</span>
              <span class="chart-vs">日均 {{ weekAvg }} 条 · 峰值 {{ weekPeak.day }} {{ weekPeak.value }} 条</span>
            </div>
            <div class="week-chart">
              <div
                v-for="(item, index) in weeks"
                :key="item.day"
                class="week-column"
              >
                <div class="week-bar-area">
                  <div
                    class="week-bar"
                    :class="{ featured: index === 5 }"
                    :style="{ height: (item.value / weekMax) * 100 + '%' }"
                    :title="`${item.day} ${item.value} 条`"
                  />
                </div>
                <span :class="{ featured: index === 5 }">{{ item.day }}</span>
              </div>
            </div>
          </div>
        </div>

        <div class="sec-h">
          <h2>最近记忆</h2>
          <span class="sub">刚刚发生的记录</span>
          <button
            class="more"
            type="button"
            @click="navigateTo('/characters')"
          >
            全部<el-icon><ArrowRight /></el-icon>
          </button>
        </div>
        <div class="card">
          <NuxtLink
            v-for="entry in timeline.slice(0, 4)"
            :key="entry.id"
            :to="'/characters/' + (characters[0]?.id || '')"
            class="mem-row"
          >
            <span class="mem-icon">
              <el-icon><component :is="memoryIcon(entry.type)" /></el-icon>
            </span>
            <span class="mem-body">
              <span class="mem-title">{{ entry.title }}</span>
              <span class="mem-meta">{{ entry.channel }} · {{ entry.time }}</span>
            </span>
            <el-icon class="arw">
              <ArrowRight />
            </el-icon>
          </NuxtLink>
        </div>
      </div>

      <div>
        <div class="sec-h">
          <h2>最近任务</h2>
          <span class="sub">{{ pendingCount + failedCount }} 项待处理</span>
          <button
            class="more"
            type="button"
            @click="navigateTo('/tasks')"
          >
            全部<el-icon><ArrowRight /></el-icon>
          </button>
        </div>
        <div class="card">
          <div
            v-for="task in realTasks.slice(0, 5)"
            :key="task.id"
            class="task-row"
          >
            <span
              class="task-dot"
              :class="taskTone(task.status)"
            />
            <div class="task-body">
              <div class="task-title">
                {{ taskTypeLabel(task.type) }}
              </div>
              <div class="task-meta">
                {{ task.characterName }} · {{ taskStatusLabel(task.status) }}
              </div>
            </div>
            <span class="task-time">{{ formatTaskTime(task.createdAt) }}</span>
          </div>
          <div
            v-if="!realTasks.length"
            class="card-empty"
          >
            <el-icon><Clock /></el-icon>
            <span>还没有后台任务</span>
            <span>跑一次周期快照或记忆更新，这里就会出现执行记录</span>
          </div>
        </div>

        <div class="sec-h">
          <h2>角色进度</h2>
        </div>
        <div class="card">
          <div
            v-for="character in characters.slice(0, 3)"
            :key="character.id"
            class="role-line"
          >
            <div
              class="avatar"
              :class="'avatar-' + character.avatarTone"
            >
              {{ character.avatar }}
            </div>
            <div class="role-line-body">
              <div class="role-line-head">
                <span class="role-line-name">{{ character.name }}</span>
                <span
                  class="pill"
                  :class="character.status === '已暂停' ? 'pill-gray' : 'pill-green'"
                >{{ character.status }}</span>
              </div>
              <div class="role-line-track">
                <div
                  class="role-line-fill"
                  :class="{ paused: character.status === '已暂停' }"
                  :style="{ width: character.status === '已暂停' ? '100%' : (character.memoryCount % 2 ? '87.5%' : '25%') }"
                />
              </div>
              <div class="role-line-meta">
                {{ character.memoryCount }} 条记忆 · 下次归档 {{ character.nextSnapshot }}
              </div>
            </div>
          </div>
          <div
            v-if="!characters.length"
            class="card-empty"
          >
            <el-icon><User /></el-icon>
            <span>还没有角色</span>
            <span>先从「角色管理」建一个，再回来看看</span>
          </div>
        </div>
      </div>
    </div>

    <p class="footer-note">
      角色档案与后台任务已接入本地数据库；记忆活动周概览与最近记忆时间线仍为演示数据。
    </p>
  </div>
</template>

<style scoped>
.task-alert {
  display: flex;
  align-items: center;
  gap: 9px;
  margin-bottom: 14px;
  border: 1px solid var(--red-soft);
  border-radius: var(--radius);
  background: var(--red-soft);
  padding: 10px 14px;
  color: #8e2739;
  font-size: 12px;
}
.task-alert .card-link { margin-left: auto; }

/* 两栏 */
.home-cols { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr); gap: 22px; align-items: start; }

/* 记忆活动 */
.chart-in { padding: 14px 16px 16px; }
.chart-head { display: flex; align-items: baseline; gap: 10px; }
.chart-head strong { color: var(--text); font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -.02em; line-height: 1.15; }
.chart-delta { display: inline-flex; align-items: center; gap: 3px; color: var(--brand-strong); font-size: 12px; font-weight: 600; }
.chart-vs { margin-left: auto; color: var(--faint); font-size: 12px; }
.week-chart {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 12px;
  height: 150px;
  margin-top: 16px;
  border-bottom: 1px solid var(--line);
  padding-bottom: 4px;
}
.week-column { display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 7px; color: var(--faint); font-size: 12px; }
.week-bar-area { display: flex; width: 100%; height: 100%; align-items: flex-end; justify-content: center; }
.week-bar { width: 100%; max-width: 32px; border-radius: 5px 5px 2px 2px; background: var(--brand-soft); transition: opacity .15s var(--ease); }
.week-bar:hover { opacity: .72; }
.week-bar.featured { background: var(--brand); }
.week-column span.featured { color: var(--brand-strong); font-weight: 600; }

/* 最近记忆 */
.mem-row { display: flex; align-items: center; gap: 11px; border-bottom: 1px solid var(--line); padding: 11px 14px; transition: background .13s var(--ease); }
.mem-row:last-child { border-bottom: 0; }
.mem-row:hover { background: var(--surface-2); }
.mem-icon { display: grid; width: 28px; height: 28px; flex: none; place-items: center; border-radius: var(--radius-xs); background: var(--surface-3); color: var(--dim); }
.mem-body { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 2px; }
.mem-title { overflow: hidden; color: var(--text-2); font-size: 14px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.mem-meta { color: var(--faint); font-size: 12px; }
.mem-row .arw { flex: none; color: #cbd1db; font-size: 12px; }

/* 最近任务 */
.task-row { display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--line); padding: 11px 14px; }
.task-row:last-child { border-bottom: 0; }
.task-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--faint); }
.task-dot.ok { background: var(--green); }
.task-dot.err { background: var(--red); }
.task-dot.wait { background: var(--amber); }
.task-dot.run { background: var(--blue); }
.task-body { min-width: 0; flex: 1; }
.task-title { overflow: hidden; color: var(--text-2); font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
.task-meta { margin-top: 2px; color: var(--faint); font-size: 12px; }
.task-time { flex: none; color: var(--faint); font-size: 12px; font-variant-numeric: tabular-nums; }

/* 角色进度行 */
.role-line { display: flex; align-items: center; gap: 11px; border-bottom: 1px solid var(--line); padding: 11px 14px; }
.role-line:last-child { border-bottom: 0; }
.role-line .avatar { width: 30px; height: 30px; font-size: 12px; }
.role-line-body { min-width: 0; flex: 1; }
.role-line-head { display: flex; align-items: center; gap: 8px; }
.role-line-name { color: var(--text-2); font-size: 14px; font-weight: 600; }
.role-line-track { height: 5px; margin-top: 6px; overflow: hidden; border-radius: 3px; background: var(--surface-3); }
.role-line-fill { height: 100%; border-radius: 3px; background: linear-gradient(90deg, #e86b92, var(--brand)); }
.role-line-fill.paused { background: #d5d9df; }
.role-line-meta { margin-top: 5px; color: var(--faint); font-size: 12px; }

@media (max-width: 1150px) {
  .home-cols { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 640px) {
  .week-chart { gap: 5px; height: 120px; }
}
</style>
