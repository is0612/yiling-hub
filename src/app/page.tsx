import Link from "next/link";
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  BrainCircuit,
  CalendarClock,
  CheckCircle2,
  Clock3,
  FileClock,
  MessageSquare,
  Plus,
  Sparkles,
  UsersRound,
} from "lucide-react";
import { characters, demoTasks, snapshots, timelineEntries } from "@/lib/mock-data";
import { Badge, DemoLabel, PageHeader, SectionTitle, StatCard, ViewAllLink } from "@/components/ui";

const weeks = [
  { day: "周一", value: 44 },
  { day: "周二", value: 62 },
  { day: "周三", value: 51 },
  { day: "周四", value: 76 },
  { day: "周五", value: 58 },
  { day: "周六", value: 86 },
  { day: "周日", value: 68 },
];

const taskTone: Record<string, "green" | "amber" | "rose" | "gray"> = {
  成功: "green",
  等待执行: "amber",
  失败待重试: "rose",
  跳过: "gray",
};

export default function OverviewPage() {
  return (
    <div className="page-wrap">
      <PageHeader
        eyebrow="工作空间 / 总览"
        title="早上好，欢迎回来"
        description="这里是你的 AI 角色工作台。角色的近期活动、记忆归档与后台任务都可以在这里查看。"
        actions={
          <>
            <DemoLabel />
            <Link href="/characters" className="btn btn-primary"><Plus size={15} /> 新建角色</Link>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="管理中的角色" value="03" note="2 个正在运行" icon={<UsersRound size={17} />} tone="purple" />
        <StatCard label="长期记忆条目" value="238" note="较上周期 +12" icon={<BrainCircuit size={17} />} tone="blue" />
        <StatCard label="已生成的快照" value="27" note="覆盖全部角色" icon={<FileClock size={17} />} tone="green" />
        <StatCard label="待处理任务" value="02" note="1 项需要留意" icon={<Activity size={17} />} tone="amber" />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,.95fr)]">
        <div className="surface p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <SectionTitle title="记忆活动概览" description="近 7 天被记录的消息与事件" />
            <span className="inline-flex items-center gap-1.5 rounded-lg bg-[#f6f5ff] px-2.5 py-2 text-[10px] font-semibold text-[#7769e2]">
              <Activity size={13} /> 本周
            </span>
          </div>
          <div className="mt-7 flex items-end gap-3">
            <div className="text-[35px] font-extrabold leading-none tracking-[-.06em] text-[#303a55]">376</div>
            <div className="mb-1 inline-flex items-center gap-1 text-[10px] font-bold text-[#279877]"><ArrowDownRight size={13} /> 12.8%</div>
            <div className="mb-1 text-[10px] text-[#a0a8b8]">较上周</div>
          </div>
          <div className="mt-6 grid h-[142px] grid-cols-7 items-end gap-3 border-b border-[#eef0f6] pb-3 sm:gap-5">
            {weeks.map((item, index) => (
              <div key={item.day} className="flex h-full flex-col items-center justify-end gap-2">
                <div className="flex h-full w-full items-end justify-center">
                  <div className={`w-full max-w-[30px] rounded-t-[7px] transition-all hover:opacity-75 ${index === 5 ? "bg-gradient-to-t from-[#7668e4] to-[#b6aefb]" : "bg-[#e5e2ff]"}`} style={{ height: `${item.value}%` }} />
                </div>
                <span className={`text-[10px] ${index === 5 ? "font-bold text-[#7062df]" : "text-[#a1a9ba]"}`}>{item.day}</span>
              </div>
            ))}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[10px] text-[#969fb2]">
            <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-[#9d93f4]" />消息与事件</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-[#e5e2ff]" />已纳入记忆处理</span>
            <span className="ml-auto">演示数据，仅用于页面预览</span>
          </div>
        </div>

        <div className="surface p-5 sm:p-6">
          <SectionTitle
            title="下一次记忆归档"
            description="接下来即将生成的周期快照"
            action={<CalendarClock size={17} className="text-[#8b82e9]" />}
          />
          <div className="mt-5 rounded-[14px] border border-[#eae7ff] bg-gradient-to-br from-[#faf9ff] to-[#f6f5ff] p-4">
            <div className="flex items-start gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-[13px] bg-white text-[18px] font-extrabold text-[#7467e7] shadow-sm">鱼</div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="text-[13px] font-bold text-[#37415b]">大肥鱼</div>
                  <Badge tone="green" dot>运行中</Badge>
                </div>
                <p className="mt-1.5 text-[11px] text-[#8e98ad]">当前周期 · 第 13 份快照</p>
              </div>
              <Sparkles size={17} className="text-[#948af0]" />
            </div>
            <div className="mt-5 flex items-end justify-between gap-3">
              <div>
                <div className="text-[10px] text-[#969fb2]">预计归档时间</div>
                <div className="mt-1.5 text-[18px] font-extrabold tracking-[-.04em] text-[#3c4562]">明天 09:00</div>
              </div>
              <div className="text-right">
                <div className="text-[10px] text-[#969fb2]">周期进度</div>
                <div className="mt-1.5 text-[13px] font-bold text-[#7769e2]">87.5%</div>
              </div>
            </div>
            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[#e9e6ff]">
              <div className="h-full w-[87.5%] rounded-full bg-gradient-to-r from-[#9c91f4] to-[#7465e5]" />
            </div>
            <div className="mt-2.5 flex justify-between text-[9px] text-[#a2a9b9]"><span>10 月 21 日 09:00</span><span>10 月 29 日 09:00</span></div>
          </div>
          <div className="mt-4 space-y-3">
            {characters.filter((character) => character.id !== "big-fish").slice(0, 2).map((character) => (
              <div key={character.id} className="flex items-center gap-3">
                <div className={`avatar h-9 w-9 text-[12px] ${character.avatarTone === "peach" ? "avatar-peach" : "avatar-blue"}`}>{character.avatar}</div>
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-bold text-[#59647c]">{character.name}</div>
                  <div className="mt-1 text-[10px] text-[#a0a8b8]">{character.intervalDays} 天周期 · {character.nextSnapshot}</div>
                </div>
                {character.status === "已暂停" ? <Badge tone="gray">已暂停</Badge> : <Badge tone="blue">计划中</Badge>}
              </div>
            ))}
          </div>
          <Link href="/characters/big-fish/settings/memory" className="btn mt-5 w-full justify-center">管理归档计划 <ArrowRight size={14} /></Link>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div className="surface p-5 sm:p-6">
          <div className="flex items-center justify-between gap-3">
            <SectionTitle title="角色最近动态" description="各角色近期的记忆活动" />
            <ViewAllLink href="/characters">全部角色</ViewAllLink>
          </div>
          <div className="mt-4 space-y-1">
            {characters.map((character, index) => (
              <Link href={`/characters/${character.id}`} key={character.id} className="group flex items-center gap-3 rounded-xl px-2 py-3 transition hover:bg-[#fbfbff]">
                <div className={`avatar h-10 w-10 text-[13px] ${character.avatarTone === "peach" ? "avatar-peach" : character.avatarTone === "mint" ? "avatar-mint" : character.avatarTone === "blue" ? "avatar-blue" : ""}`}>{character.avatar}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12px] font-bold text-[#46516b]">{character.name}</span>
                    <span className="text-[10px] text-[#a3aabb]">{character.alias}</span>
                  </div>
                  <p className="mt-1 truncate text-[10px] text-[#939cb0]">{index === 0 ? timelineEntries[0].title : index === 1 ? "最近更新了角色人设与关系记忆" : "记忆已暂停，历史档案仍可查看"}</p>
                </div>
                <div className="hidden text-right sm:block">
                  <div className="text-[11px] font-bold text-[#5f6a83]">{character.memoryCount}</div>
                  <div className="mt-1 text-[9px] text-[#a3aabb]">记忆条目</div>
                </div>
                <ArrowUpRight size={14} className="text-[#c4c9d7] transition group-hover:text-[#786be4]" />
              </Link>
            ))}
          </div>
        </div>

        <div className="surface p-5 sm:p-6">
          <div className="flex items-center justify-between gap-3">
            <SectionTitle title="后台任务" description="近期记忆任务与系统事件" />
            <ViewAllLink href="/tasks">查看任务</ViewAllLink>
          </div>
          <div className="mt-4 space-y-1">
            {demoTasks.slice(0, 4).map((task) => (
              <div key={task.id} className="flex items-start gap-3 rounded-xl px-2 py-3">
                <div className={`mt-0.5 flex h-8 w-8 items-center justify-center rounded-[10px] ${task.tone === "green" ? "bg-[#e8f8f1] text-[#3aa181]" : task.tone === "rose" ? "bg-[#fff0f3] text-[#c45e76]" : task.tone === "amber" ? "bg-[#fff5e4] text-[#b77d25]" : "bg-[#f1f3f8] text-[#8d97aa]"}`}>
                  {task.tone === "green" ? <CheckCircle2 size={15} /> : task.tone === "rose" ? <Activity size={15} /> : <Clock3 size={15} />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] font-bold text-[#515d77]">{task.name}</span>
                    <Badge tone={taskTone[task.status]}>{task.status}</Badge>
                  </div>
                  <div className="mt-1.5 text-[10px] text-[#a0a8b8]">{task.character} · {task.time}</div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2 rounded-xl bg-[#fff9ef] px-3 py-2.5 text-[10px] leading-5 text-[#a77937]">
            <Activity size={14} className="shrink-0" />
            当前为界面演示，任务状态尚未连接真实 Worker。
          </div>
        </div>
      </div>

      <div className="mt-5 flex flex-col justify-between gap-3 rounded-2xl border border-[#e9e8fb] bg-gradient-to-r from-[#f7f6ff] to-[#f9fbff] p-5 sm:flex-row sm:items-center sm:px-6">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[13px] bg-white text-[#776ae7] shadow-sm"><BrainCircuit size={18} /></div>
          <div>
            <div className="text-[12px] font-bold text-[#4e5874]">给角色一点时间，让记忆慢慢生长</div>
            <p className="mt-1.5 text-[10px] leading-5 text-[#8b96ab]">检查周期设置、回顾历史快照，让重要经历留在角色的长期记忆里。</p>
          </div>
        </div>
        <Link href="/characters/big-fish" className="btn shrink-0 border-[#dedbff] bg-white text-[#7467e4]">打开记忆驾驶舱 <ArrowRight size={14} /></Link>
      </div>

      <div className="mt-7 flex flex-wrap items-center justify-between gap-2 text-[10px] text-[#a5adbc]">
        <span>羚枢 · 多角色 AI 养成中枢</span>
        <span>当前页面使用本地模拟数据</span>
      </div>
    </div>
  );
}
