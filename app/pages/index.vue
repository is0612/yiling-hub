<script setup lang="ts">
import { DataAnalysis, ArrowDown, ArrowRight, TopRight, Calendar, Clock, Files, MagicStick, User } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus";
import { initialTasks, initialTimeline } from "~/utils/mock-data";

const characters = useCharacterList();
const primaryCharacter = computed(() => characters.value[0] ?? null);
const timeline = initialTimeline;
const tasks = useState("demo-tasks", () => initialTasks.map((item) => ({ ...item })));
const weeks = [
  { day: "周一", value: 44 }, { day: "周二", value: 62 }, { day: "周三", value: 51 },
  { day: "周四", value: 76 }, { day: "周五", value: 58 }, { day: "周六", value: 86 }, { day: "周日", value: 68 },
];
const taskTone: Record<string, string> = { 成功: "green", 等待执行: "amber", 失败待重试: "rose", 跳过: "gray", 运行中: "blue" };

// 与布局共用同一份角色数据，首屏直接渲染真实角色。
await useCharacterListData();

onMounted(() => {
  if (!characters.value.length) {
    ElMessage.warning("角色数据暂不可用；请完成本地数据库初始化后刷新页面。");
  }
});
</script>

<template>
  <div class="page-wrap">
    <PageHeader eyebrow="工作空间 / 总览" title="早上好，欢迎回来" description="这里是你的 AI 角色工作台。角色近期活动、记忆归档与后台任务都可以在这里查看。">
      <template #actions><DemoTag /><el-button type="primary" @click="navigateTo('/characters')"><el-icon><User /></el-icon>新建角色</el-button></template>
    </PageHeader>

    <div class="stat-grid">
      <StatCard label="管理中的角色" :value="String(characters.length).padStart(2, '0')" note="2 个正在运行" symbol="♙" tone="purple" />
      <StatCard label="长期记忆条目" value="238" note="较上周期 +12" symbol="◈" tone="blue" />
      <StatCard label="已生成的快照" value="27" note="覆盖全部角色" symbol="▤" tone="green" />
      <StatCard label="待处理任务" :value="String(tasks.filter(t => t.status === '等待执行' || t.status === '失败待重试').length).padStart(2, '0')" note="1 项需要留意" symbol="◷" tone="amber" />
    </div>

    <div class="panel-grid">
      <section class="surface panel">
        <div class="panel-title-row">
          <SectionTitle title="记忆活动概览" description="近 7 天被记录的消息与事件" />
          <span class="pill pill-purple"><el-icon><DataAnalysis /></el-icon>本周</span>
        </div>
        <div style="display:flex;align-items:flex-end;gap:11px;margin-top:24px">
          <strong style="font-size:35px;line-height:1;letter-spacing:-.06em;color:#303a55">376</strong>
          <span style="display:flex;align-items:center;gap:4px;margin-bottom:3px;color:#279877;font-size:10px;font-weight:800"><el-icon><ArrowDown /></el-icon>12.8%</span>
          <span style="margin-bottom:3px;color:#a0a8b8;font-size:10px">较上周</span>
        </div>
        <div class="week-chart">
          <div v-for="(item, index) in weeks" :key="item.day" class="week-column">
            <div class="week-bar-area"><div class="week-bar" :class="{ featured: index === 5 }" :style="{ height: item.value + '%' }" /></div>
            <span :class="{ featured: index === 5 }">{{ item.day }}</span>
          </div>
        </div>
        <div class="chart-legend"><span><i class="legend-dot purple" />消息与事件</span><span><i class="legend-dot pale" />已纳入记忆处理</span><span class="legend-note">演示数据，仅用于页面预览</span></div>
      </section>

      <section class="surface panel">
        <SectionTitle title="下一次记忆归档" description="接下来即将生成的周期快照">
          <template #action><el-icon style="font-size:19px;color:#8b82e9"><Calendar /></el-icon></template>
        </SectionTitle>
        <div class="next-snapshot">
          <div class="character-card-head">
            <div class="avatar" :class="primaryCharacter ? 'avatar-' + primaryCharacter.avatarTone : ''" style="width:44px;height:44px;font-size:18px">{{ primaryCharacter?.avatar || '—' }}</div>
            <div class="character-info">
              <div class="character-name-row"><span class="character-name" style="font-size:13px">{{ primaryCharacter?.name || '暂无角色' }}</span><span class="pill" :class="primaryCharacter?.status === '已暂停' ? 'pill-gray' : 'pill-green'">{{ primaryCharacter?.status || '待创建' }}</span></div>
              <div class="character-alias">当前周期 · 第 13 份快照</div>
            </div>
            <el-icon style="font-size:18px;color:#948af0"><MagicStick /></el-icon>
          </div>
          <div class="next-snapshot-stats">
            <div><div class="muted-note">预计归档时间</div><strong>明天 09:00</strong></div>
            <div style="text-align:right"><div class="muted-note">周期进度</div><strong style="color:#7769e2">87.5%</strong></div>
          </div>
          <el-progress :percentage="87.5" :show-text="false" :stroke-width="6" color="#8172ed" />
          <div class="period-label"><span>10 月 21 日 09:00</span><span>10 月 29 日 09:00</span></div>
        </div>
        <div v-for="character in characters.slice(1, 3)" :key="character.id" class="mini-character">
          <div class="avatar" :class="'avatar-' + character.avatarTone" style="width:36px;height:36px;font-size:12px">{{ character.avatar }}</div>
          <div class="character-info"><div class="character-name" style="font-size:11px">{{ character.name }}</div><div class="character-alias">{{ character.intervalDays }} 天周期 · {{ character.nextSnapshot }}</div></div>
          <span class="pill" :class="character.status === '已暂停' ? 'pill-gray' : 'pill-blue'">{{ character.status === '已暂停' ? '已暂停' : '计划中' }}</span>
        </div>
        <el-button plain style="width:100%;margin-top:12px" :disabled="!primaryCharacter" @click="primaryCharacter && navigateTo(`/characters/${primaryCharacter.id}/settings/memory`)">管理归档计划<el-icon class="el-icon--right"><ArrowRight /></el-icon></el-button>
      </section>
    </div>

    <div class="panel-grid equal">
      <section class="surface panel">
        <div class="panel-title-row"><SectionTitle title="角色最近动态" description="各角色近期的记忆活动" /><el-button text type="primary" @click="navigateTo('/characters')">全部角色<el-icon class="el-icon--right"><TopRight /></el-icon></el-button></div>
        <div class="section-content">
          <NuxtLink v-for="(character, index) in characters" :key="character.id" :to="'/characters/' + character.id" class="activity-row">
            <div class="avatar" :class="'avatar-' + character.avatarTone" style="width:40px;height:40px;font-size:13px">{{ character.avatar }}</div>
            <div class="character-info"><div class="character-name-row"><span class="character-name" style="font-size:12px">{{ character.name }}</span><span class="character-alias">{{ character.alias }}</span></div><div class="character-alias activity-snippet">{{ timeline[index % timeline.length]?.title }}</div></div>
            <div class="activity-count"><strong>{{ character.memoryCount }}</strong><span>记忆条目</span></div>
            <el-icon class="activity-chevron"><TopRight /></el-icon>
          </NuxtLink>
        </div>
      </section>

      <section class="surface panel">
        <div class="panel-title-row"><SectionTitle title="后台任务" description="近期记忆任务与系统事件" /><el-button text type="primary" @click="navigateTo('/tasks')">查看任务<el-icon class="el-icon--right"><TopRight /></el-icon></el-button></div>
        <div class="section-content">
          <div v-for="task in tasks.slice(0, 4)" :key="task.id" class="task-row">
            <div class="task-symbol" :class="task.tone"><el-icon><component :is="task.status === '成功' ? Files : task.status === '失败待重试' ? DataAnalysis : Clock" /></el-icon></div>
            <div class="character-info"><div class="character-name" style="font-size:11px">{{ task.name }}</div><div class="character-alias">{{ task.character }} · {{ task.time }}</div></div>
            <span class="pill" :class="'pill-' + taskTone[task.status]">{{ task.status }}</span>
          </div>
        </div>
      </section>
    </div>
    <p class="footer-note">角色档案已接入本地数据库；活动时间线、快照与任务列表仍为演示数据。</p>
  </div>
</template>

<style scoped>
.week-chart{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:12px;height:160px;margin-top:25px;padding-bottom:12px;border-bottom:1px solid #eef0f6}
.week-column{display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:9px;color:#a1a9ba;font-size:10px}
.week-bar-area{display:flex;width:100%;height:100%;align-items:flex-end;justify-content:center}
.week-bar{width:100%;max-width:30px;border-radius:7px 7px 2px 2px;background:#e5e2ff;transition:opacity .15s}
.week-bar:hover{opacity:.72}.week-bar.featured{background:linear-gradient(0deg,#7668e4,#b6aefb)}
.week-column span.featured{color:#7062df;font-weight:800}
.chart-legend{display:flex;flex-wrap:wrap;align-items:center;gap:14px;margin-top:14px;color:#969fb2;font-size:10px}
.chart-legend span{display:flex;align-items:center;gap:6px}.legend-dot{width:8px;height:8px;border-radius:2px}.legend-dot.purple{background:#9d93f4}.legend-dot.pale{background:#e5e2ff}.legend-note{margin-left:auto}
.next-snapshot{margin-top:17px;padding:15px;border:1px solid #eae7ff;border-radius:14px;background:linear-gradient(135deg,#faf9ff,#f6f5ff)}
.next-snapshot-stats{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;margin:19px 0 11px}.next-snapshot-stats strong{display:block;margin-top:5px;color:#3c4562;font-size:17px;letter-spacing:-.04em}
.period-label{display:flex;justify-content:space-between;margin-top:8px;color:#a2a9b9;font-size:9px}
.mini-character{display:flex;align-items:center;gap:10px;margin-top:15px}.activity-row{display:flex;align-items:center;gap:12px;border-radius:12px;padding:11px 7px;transition:background .15s}.activity-row:hover{background:#fbfbff}.activity-count{min-width:55px;text-align:right}.activity-count strong,.activity-count span{display:block}.activity-count strong{color:#5f6a83;font-size:11px}.activity-count span{margin-top:4px;color:#a3aabb;font-size:9px}.activity-chevron{color:#c4c9d7}.activity-row:hover .activity-chevron{color:#786be4}.activity-snippet{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.task-row{display:flex;align-items:center;gap:10px;border-bottom:1px solid #f0f2f7;padding:12px 0}.task-row:last-child{border:0}.task-symbol{display:flex;width:34px;height:34px;align-items:center;justify-content:center;border-radius:11px;background:#f1f3f8;color:#78839a}.task-symbol.green{background:#e8f8f1;color:#249b77}.task-symbol.rose{background:#fff0f3;color:#c45e76}.task-symbol.amber{background:#fff5e4;color:#b77922}.task-symbol.blue{background:#eef5ff;color:#4f7ac0}
.footer-note{margin-top:24px;color:#a3aabb;font-size:10px;text-align:center}
@media(max-width:480px){.week-chart{gap:5px}.chart-legend{gap:8px}.legend-note{width:100%;margin-left:0}}
</style>
