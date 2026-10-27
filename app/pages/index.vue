<script setup lang="ts">
import {
  ArrowRight,
  Calendar,
  ChatDotRound,
  Clock,
  Cpu,
  Files,
  Refresh,
  User,
} from "@element-plus/icons-vue";
import { characterUrgency, describeCountdown, type OverviewCharacter, type OverviewPayload } from "~/utils/overview";

const { isAdmin } = useAuthSession();

// SSR 阶段必须转发 cookie，否则总览会以匿名身份请求并触发 401。
const request = import.meta.server ? useRequestFetch() : $fetch;
const { data: overview, pending, refresh } = await useAsyncData(
  "overview",
  () => request<OverviewPayload>("/api/overview"),
);

const characters = computed(() => overview.value?.characters ?? []);
const primaryCharacter = computed(() => characters.value[0] ?? null);

/** 异常置顶：模型没配 / 任务失败 / 周期逾期 / 未连接，之后才是正常的。 */
const sortedCharacters = computed(() =>
  [...characters.value].sort((a, b) => {
    const byUrgency = characterUrgency(a) - characterUrgency(b);
    if (byUrgency !== 0) return byUrgency;
    const left = a.nextSnapshotAt ? Date.parse(a.nextSnapshotAt) : Number.MAX_SAFE_INTEGER;
    const right = b.nextSnapshotAt ? Date.parse(b.nextSnapshotAt) : Number.MAX_SAFE_INTEGER;
    return left - right;
  }),
);

const alerts = computed(() => {
  const data = overview.value;
  if (!data) return [] as string[];
  const list: string[] = [];
  if (data.tasks.failed > 0) list.push(`${data.tasks.failed} 个后台任务失败或等待重试`);
  const unconfigured = data.characters.filter((item) => !item.chatApiKeyConfigured).length;
  if (unconfigured > 0) list.push(`${unconfigured} 个角色未配置模型，归档任务会留在队列里不执行`);
  const missed = data.characters.filter((item) => item.cycle?.missed).length;
  if (missed > 0) list.push(`${missed} 个角色的归档已逾期`);
  const disconnected = data.characters.filter((item) => item.status === "未连接").length;
  if (disconnected > 0) list.push(`${disconnected} 个角色没有可用渠道`);
  return list;
});

// 倒计时每 60 秒按本地时间重算一次：首次渲染用服务端 remainingMs，避免 SSR 与浏览器时区差异导致闪烁。
const localNow = ref(0);
let ticker: ReturnType<typeof setInterval> | undefined;

const countdown = computed(() => {
  const next = overview.value?.nextSnapshot;
  if (!next) return null;
  const remaining = localNow.value ? Date.parse(next.atISO) - localNow.value : next.remainingMs;
  return { ...describeCountdown(remaining), characterName: next.characterName, atLabel: next.atLabel };
});

onMounted(() => {
  ticker = setInterval(() => {
    localNow.value = Date.now();
  }, 60_000);
});
onBeforeUnmount(() => {
  if (ticker) clearInterval(ticker);
});

function roleFacts(character: OverviewCharacter) {
  const lastText = `上次归档 ${character.latestSnapshotLabel}`;
  const nextText = character.nextSnapshotAt
    ? `下次 ${character.nextSnapshotLabel}`
    : character.autoSnapshotEnabled
      ? "尚未排期"
      : "自动归档已关闭";
  return [
    character.channels.length ? character.channels.join(" / ") : "未接渠道",
    `${character.intervalDays} 天周期`,
    lastText,
    nextText,
  ].join(" · ");
}

function cyclePercent(character: OverviewCharacter) {
  if (!character.cycle) return 0;
  return Math.round((character.cycle.dayIndex / character.cycle.totalDays) * 100);
}

function copyState() {
  if (alerts.value.length > 0) return `${alerts.value.length} 项需要处理`;
  if (countdown.value) return `一切正常 · ${countdown.value.characterName} 将在 ${countdown.value.atLabel} 归档`;
  return "一切正常 · 暂无归档计划";
}

async function handleRefresh() {
  await refresh();
}
</script>

<template>
  <div class="page-wrap">
    <PageHeader
      eyebrow="工作空间 / 总览"
      title="今天的工作台"
      description="异常、进度和最近发生的事，一屏看完。"
    >
      <template #actions>
        <button
          class="btn"
          type="button"
          :disabled="pending"
          @click="handleRefresh"
        >
          <el-icon><Refresh /></el-icon>{{ pending ? "刷新中" : "刷新" }}
        </button>
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
      v-if="alerts.length"
      class="alert-bar"
    >
      <span class="alert-dot" />
      <div class="alert-body">
        <span
          v-for="alert in alerts"
          :key="alert"
          class="alert-item"
        >{{ alert }}</span>
      </div>
      <button
        class="card-link"
        type="button"
        @click="navigateTo(isAdmin ? '/tasks' : '/characters')"
      >
        去处理<el-icon><ArrowRight /></el-icon>
      </button>
    </div>
    <div
      v-else-if="characters.length"
      class="alert-bar is-quiet"
    >
      <span class="alert-dot is-ok" />
      <span>{{ copyState() }}</span>
    </div>

    <!-- 空状态：还没建角色时，总览应该告诉人第一步做什么 -->
    <div
      v-if="overview && !characters.length"
      class="guide"
    >
      <div class="guide-icon">
        <el-icon><User /></el-icon>
      </div>
      <h3>还没有角色</h3>
      <p class="guide-note">
        忆灵小窝把「对话 → 阶段总结 → 长期记忆」串成一条线。建一个角色，配好模型，就能开始积累记忆。
      </p>
      <ol class="guide-steps">
        <li><span>1</span>新建角色，填人设</li>
        <li><span>2</span>在角色设置里填模型 API</li>
        <li><span>3</span>开始对话，8 天后自动归档</li>
      </ol>
      <button
        class="btn primary lg"
        type="button"
        @click="navigateTo('/characters')"
      >
        去建第一个角色
      </button>
    </div>

    <template v-else-if="overview">
      <!-- 四格：都是「时点」，不是累计总量 -->
      <div class="kpi-row">
        <button
          class="kpi is-action"
          type="button"
          :disabled="!overview.nextSnapshot"
          @click="overview.nextSnapshot && navigateTo(`/characters/${overview.nextSnapshot.characterId}/snapshots`)"
        >
          <div class="k">
            <el-icon><Calendar /></el-icon>距下次归档
          </div>
          <div
            class="v"
            :class="{ 'is-overdue': countdown?.tone === 'overdue', 'is-warn': countdown?.tone === 'warn' }"
          >
            <template v-if="countdown">
              {{ countdown.value }}<small v-if="countdown.unit">{{ countdown.unit }}</small>
            </template>
            <span
              v-else
              class="na"
            >—</span>
          </div>
          <div class="foot">
            <template v-if="countdown">
              {{ countdown.atLabel }} · {{ countdown.characterName }}
            </template>
            <template v-else>
              没有开启自动归档的角色
            </template>
          </div>
        </button>

        <div class="kpi">
          <div class="k">
            <el-icon><ChatDotRound /></el-icon>本周期消息
          </div>
          <div class="v">
            {{ overview.cycle?.messageCount ?? 0 }}<small>条</small>
          </div>
          <div class="foot">
            <template v-if="overview.cycle">
              第 {{ overview.cycle.dayIndex }} / {{ overview.cycle.totalDays }} 天 · {{ overview.cycle.endISOLabel }} 归档
            </template>
            <template v-else>
              暂无进行中的周期
            </template>
          </div>
        </div>

        <button
          class="kpi is-action"
          type="button"
          :disabled="!overview.latestSnapshot"
          @click="overview.latestSnapshot && navigateTo(`/characters/${overview.latestSnapshot.characterId}/snapshots`)"
        >
          <div class="k">
            <el-icon><Files /></el-icon>最近一次归档
          </div>
          <div class="v">
            <template v-if="overview.latestSnapshot">
              {{ overview.latestSnapshot.dateLabel }}<small>v{{ overview.latestSnapshot.version }}</small>
            </template>
            <span
              v-else
              class="na"
            >—</span>
          </div>
          <div class="foot">
            <template v-if="overview.latestSnapshot">
              {{ overview.latestSnapshot.characterName }} · {{ overview.latestSnapshot.atLabel }} 生成
            </template>
            <template v-else>
              还没有归档过
            </template>
          </div>
        </button>

        <button
          class="kpi is-action"
          type="button"
          @click="navigateTo(isAdmin ? '/tasks' : '/characters')"
        >
          <div class="k">
            <el-icon><Clock /></el-icon>待处理任务
          </div>
          <div class="v">
            {{ overview.tasks.pending }}<small>项</small>
          </div>
          <div class="foot">
            <span v-if="overview.tasks.failed > 0">{{ overview.tasks.failed }} 个失败待处理</span>
            <span v-else>暂无异常</span>
          </div>
        </button>
      </div>

      <div class="home-cols">
        <!-- 左：角色，异常置顶 -->
        <div>
          <div class="sec-h">
            <h2>角色</h2>
            <span class="sub">异常优先，其余按归档时间</span>
            <button
              class="more"
              type="button"
              @click="navigateTo('/characters')"
            >
              全部<el-icon><ArrowRight /></el-icon>
            </button>
          </div>
          <div class="card">
            <div
              v-for="character in sortedCharacters"
              :key="character.id"
              class="role-card"
            >
              <div
                class="avatar"
                :class="'avatar-' + character.avatarTone"
              >
                {{ character.avatar }}
              </div>
              <div class="role-body">
                <div class="role-head">
                  <NuxtLink
                    class="role-name"
                    :to="`/characters/${character.id}`"
                  >
                    {{ character.name }}
                  </NuxtLink>
                  <span
                    v-if="!character.chatApiKeyConfigured"
                    class="pill pill-rose"
                  >模型未配置</span>
                  <span
                    v-else-if="character.failedTaskCount > 0"
                    class="pill pill-rose"
                  >{{ character.failedTaskCount }} 个任务失败</span>
                  <span
                    v-else-if="character.cycle?.missed"
                    class="pill pill-amber"
                  >归档逾期</span>
                  <span
                    class="pill"
                    :class="character.status === '运行中' ? 'pill-green' : 'pill-gray'"
                  >{{ character.status }}</span>
                </div>
                <div class="role-facts">
                  {{ roleFacts(character) }}
                </div>
                <div class="role-cycle">
                  <div
                    v-if="character.cycle"
                    class="role-track"
                  >
                    <i
                      :class="{ paused: character.status === '已暂停', overdue: character.cycle?.missed }"
                      :style="{ width: cyclePercent(character) + '%' }"
                    />
                  </div>
                  <span class="role-cycle-text">
                    <template v-if="character.cycle">
                      第 {{ character.cycle.dayIndex }}/{{ character.cycle.totalDays }} 天 · 本周期 {{ character.cycleMessageCount }} 条消息
                    </template>
                    <template v-else>
                      共 {{ character.memoryCount }} 条长期记忆
                    </template>
                  </span>
                </div>
              </div>
              <div class="role-links">
                <NuxtLink :to="`/characters/${character.id}/chat`">
                  <el-icon><ChatDotRound /></el-icon>对话
                </NuxtLink>
                <NuxtLink :to="`/characters/${character.id}`">
                  <el-icon><Cpu /></el-icon>记忆
                </NuxtLink>
                <NuxtLink :to="`/characters/${character.id}/snapshots`">
                  <el-icon><Calendar /></el-icon>归档
                </NuxtLink>
              </div>
            </div>
          </div>
        </div>

        <!-- 右：最近发生 + 最近任务 -->
        <div>
          <div class="sec-h">
            <h2>最近发生</h2>
            <span class="sub">任务与归档</span>
            <button
              v-if="isAdmin"
              class="more"
              type="button"
              @click="navigateTo('/tasks')"
            >
              任务监控<el-icon><ArrowRight /></el-icon>
            </button>
          </div>
          <div class="card">
            <div
              v-for="event in overview.events"
              :key="event.id"
              class="event-row"
            >
              <span
                class="event-dot"
                :class="event.tone"
              />
              <div class="event-body">
                <div class="event-title">
                  {{ event.title }}
                </div>
                <div class="event-meta">
                  {{ event.meta }}
                </div>
              </div>
              <span class="event-time">{{ event.atLabel }}</span>
            </div>
            <div
              v-if="!overview.events.length"
              class="card-empty"
            >
              <el-icon><Clock /></el-icon>
              <span>还没有执行记录</span>
              <span>跑一次阶段总结或记忆更新，这里就会出现</span>
            </div>
          </div>

          <div class="sec-h">
            <h2>最近任务</h2>
            <span class="sub">{{ overview.tasks.pending + overview.tasks.failed }} 项未结束</span>
          </div>
          <div class="card">
            <div
              v-for="task in overview.tasks.items.slice(0, 4)"
              :key="task.id"
              class="task-row"
            >
              <span
                class="task-dot"
                :class="{
                  ok: task.status === 'SUCCEEDED',
                  err: task.status === 'FAILED',
                  wait: task.status === 'QUEUED' || task.status === 'RETRY_WAIT',
                  run: task.status === 'RUNNING',
                }"
              />
              <div class="task-body">
                <div class="task-title">
                  {{ task.typeLabel }}
                </div>
                <div class="task-meta">
                  {{ task.characterName }} · {{ task.statusLabel }}
                </div>
              </div>
            </div>
            <div
              v-if="!overview.tasks.items.length"
              class="card-empty"
            >
              <el-icon><Clock /></el-icon>
              <span>还没有后台任务</span>
              <span>开启自动归档后，到点会自动排进队列</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 仅管理员：数据库、队列与渠道的即时状态 -->
      <div
        v-if="isAdmin && overview.admin"
        class="admin-wrap"
      >
        <div class="sec-h">
          <h2>系统状况</h2>
          <span class="sub">仅管理员可见</span>
        </div>
        <div class="card">
          <div class="admin-grid">
            <div class="admin-cell">
              <span class="admin-label">数据库</span>
              <b :class="overview.admin.database === 'up' ? 'is-ok' : 'is-err'">
                {{ overview.admin.database === "up" ? "正常" : "连接异常" }}
              </b>
            </div>
            <div class="admin-cell">
              <span class="admin-label">任务队列</span>
              <b>{{ overview.admin.jobs.queued }} 等待 / {{ overview.admin.jobs.running }} 运行 / {{ overview.admin.jobs.failed }} 失败</b>
            </div>
            <div class="admin-cell">
              <span class="admin-label">渠道</span>
              <b>{{ overview.admin.channels.online }} / {{ overview.admin.channels.total }} 在线</b>
            </div>
          </div>
          <div
            v-if="overview.admin.recentAudits.length"
            class="audit-list"
          >
            <div class="audit-caption">
              最近操作
            </div>
            <div
              v-for="audit in overview.admin.recentAudits"
              :key="audit.id"
              class="audit-row"
            >
              <span class="audit-action">{{ audit.action }}</span>
              <span class="audit-entity">{{ audit.entityType }}</span>
              <span class="audit-time">{{ audit.atLabel }}</span>
            </div>
          </div>
        </div>
      </div>
    </template>

    <div
      v-else
      class="loading-hint"
    >
      <template v-if="pending">
        正在读取工作台数据…
      </template>
      <template v-else>
        工作台数据暂时读不到，<button
          class="card-link"
          type="button"
          @click="handleRefresh"
        >
          重试
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 异常条：有问题时整条醒目，没问题时退成一行浅色文字 */
.alert-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
  border: 1px solid var(--red-soft);
  border-radius: var(--radius);
  background: var(--red-soft);
  padding: 10px 14px;
  color: #8e2739;
  font-size: 12px;
}
.alert-bar.is-quiet {
  border-color: var(--line);
  background: var(--surface);
  color: var(--dim);
}
.alert-dot {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--red);
}
.alert-dot.is-ok {
  background: var(--green);
}
.alert-body {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 14px;
  min-width: 0;
  flex: 1;
}
.alert-item {
  white-space: nowrap;
}
.alert-bar .card-link {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex: none;
}
.alert-bar .card-link .el-icon {
  font-size: 12px;
}

/* 空状态引导 */
.guide {
  border: 1px dashed var(--line-strong);
  border-radius: var(--radius);
  background: var(--surface);
  padding: 34px 24px 30px;
  text-align: center;
}
.guide-icon {
  display: grid;
  width: 44px;
  height: 44px;
  margin: 0 auto 12px;
  place-items: center;
  border-radius: 50%;
  background: var(--brand-soft);
  color: var(--brand);
  font-size: 20px;
}
.guide h3 {
  margin: 0;
  color: var(--text);
  font-size: 18px;
  font-weight: 600;
}
.guide-note {
  max-width: 460px;
  margin: 8px auto 0;
  color: var(--dim);
  font-size: 13px;
  line-height: 1.7;
}
.guide-steps {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 10px;
  margin: 18px 0 20px;
  padding: 0;
  list-style: none;
}
.guide-steps li {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 6px 13px 6px 7px;
  color: var(--text-2);
  font-size: 12px;
}
.guide-steps li span {
  display: grid;
  width: 18px;
  height: 18px;
  place-items: center;
  border-radius: 50%;
  background: var(--surface-3);
  color: var(--dim);
  font-size: 12px;
  font-weight: 600;
}

/* KPI */
.kpi .v.is-overdue { color: var(--red); font-size: 18px; }
.kpi .v.is-warn { color: var(--amber); }

/* 两栏 */
.home-cols {
  display: grid;
  grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr);
  gap: 22px;
  align-items: start;
}

/* 角色卡 */
.role-card {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  gap: 11px;
  align-items: start;
  border-bottom: 1px solid var(--line);
  padding: 13px 14px;
}
.role-card:last-child { border-bottom: 0; }
.role-card .avatar { width: 34px; height: 34px; font-size: 14px; }
.role-body { min-width: 0; }
.role-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.role-name { color: var(--text); font-size: 14px; font-weight: 600; }
.role-name:hover { color: var(--brand-strong); }
.role-facts { margin-top: 4px; color: var(--faint); font-size: 12px; line-height: 1.5; }
.role-cycle { display: flex; align-items: center; gap: 9px; margin-top: 7px; }
.role-track { height: 5px; width: 96px; flex: none; overflow: hidden; border-radius: 3px; background: var(--surface-3); }
.role-track i { display: block; height: 100%; border-radius: 3px; background: linear-gradient(90deg, #e86b92, var(--brand)); }
.role-track i.paused { background: #d5d9df; }
.role-track i.overdue { background: var(--amber); }
.role-cycle-text { color: var(--faint); font-size: 12px; }
.role-links { display: flex; gap: 2px; flex: none; }
.role-links a {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border-radius: var(--radius-xs);
  padding: 5px 7px;
  color: var(--dim);
  font-size: 12px;
  white-space: nowrap;
}
.role-links a:hover { background: var(--surface-2); color: var(--brand-strong); }
.role-links .el-icon { font-size: 12px; }

/* 事件流 */
.event-row { display: flex; align-items: flex-start; gap: 9px; border-bottom: 1px solid var(--line); padding: 10px 14px; }
.event-row:last-child { border-bottom: 0; }
.event-dot { width: 6px; height: 6px; margin-top: 6px; flex: none; border-radius: 50%; background: var(--faint); }
.event-dot.ok { background: var(--green); }
.event-dot.err { background: var(--red); }
.event-dot.wait { background: var(--amber); }
.event-dot.run { background: var(--blue); }
.event-body { min-width: 0; flex: 1; }
.event-title { overflow: hidden; color: var(--text-2); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.event-meta { overflow: hidden; margin-top: 2px; color: var(--faint); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.event-time { flex: none; color: var(--faint); font-size: 12px; font-variant-numeric: tabular-nums; }

/* 最近任务 */
.task-row { display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--line); padding: 10px 14px; }
.task-row:last-child { border-bottom: 0; }
.task-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--faint); }
.task-dot.ok { background: var(--green); }
.task-dot.err { background: var(--red); }
.task-dot.wait { background: var(--amber); }
.task-dot.run { background: var(--blue); }
.task-body { min-width: 0; flex: 1; }
.task-title { overflow: hidden; color: var(--text-2); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.task-meta { margin-top: 2px; color: var(--faint); font-size: 12px; }

/* 管理员块 */
.admin-wrap { margin-top: 8px; }
.admin-grid { display: flex; flex-wrap: wrap; gap: 10px 26px; border-bottom: 1px solid var(--line); padding: 13px 14px; }
.admin-cell { display: flex; align-items: center; gap: 7px; font-size: 12px; }
.admin-label { color: var(--faint); }
.admin-cell b { color: var(--text-2); font-weight: 600; font-variant-numeric: tabular-nums; }
.admin-cell b.is-ok { color: var(--green); }
.admin-cell b.is-err { color: var(--red); }
.audit-list { padding: 8px 14px 12px; }
.audit-caption { margin-bottom: 3px; color: var(--faint); font-size: 12px; }
.audit-row { display: flex; align-items: center; gap: 10px; padding: 4px 0; font-size: 12px; }
.audit-action { color: var(--text-2); font-family: Consolas, monospace; }
.audit-entity { color: var(--faint); }
.audit-time { margin-left: auto; color: var(--faint); font-variant-numeric: tabular-nums; }

.loading-hint { padding: 40px 0; color: var(--faint); font-size: 13px; text-align: center; }

@media (max-width: 1150px) {
  .home-cols { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 720px) {
  .role-card { grid-template-columns: 34px minmax(0, 1fr); }
  .role-links { grid-column: 2; margin-top: 2px; }
  .kpi-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
