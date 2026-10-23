"use client";

import { useMemo, useState } from "react";
import { Activity, AlertTriangle, ArrowRight, CheckCircle2, Clock3, Filter, MoreHorizontal, RefreshCw, Search, Settings2 } from "lucide-react";
import { demoTasks as initialTasks } from "@/lib/mock-data";
import { Badge, DemoLabel, PageHeader, SectionTitle, StatCard } from "@/components/ui";

type TaskStatus = "等待执行" | "成功" | "失败待重试" | "跳过" | "执行中";
type Task = {
  id: string;
  name: string;
  character: string;
  range: string;
  status: TaskStatus;
  tone: string;
  tries: number;
  time: string;
};

const statusTone: Record<TaskStatus, "green" | "amber" | "rose" | "gray" | "blue"> = {
  "成功": "green",
  "等待执行": "amber",
  "失败待重试": "rose",
  "跳过": "gray",
  "执行中": "blue",
};

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>(initialTasks as Task[]);
  const [filter, setFilter] = useState("全部状态");
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState("");

  function notify(text: string) { setToast(text); window.setTimeout(() => setToast(""), 4200); }

  const filtered = useMemo(() => tasks.filter((task) => {
    const statusMatch = filter === "全部状态" || task.status === filter;
    const queryMatch = !query || `${task.name} ${task.character} ${task.id}`.toLowerCase().includes(query.toLowerCase());
    return statusMatch && queryMatch;
  }), [tasks, filter, query]);

  function retry(id: string) {
    setTasks((current) => current.map((task) => task.id === id ? { ...task, status: "等待执行", tone: "amber", tries: task.tries + 1, time: "已加入演示重试队列" } : task));
    notify("已更新演示任务状态；当前没有真实 Worker 执行重试。");
  }

  return (
    <div className="page-wrap">
      <PageHeader eyebrow="系统管理 / 任务监控" title="后台任务监控" description="查看周期快照、记忆整理与渠道事件的执行状态。这里先用模拟任务验证界面，真实任务系统将在后续阶段接入。" actions={<><DemoLabel /><button className="btn" onClick={() => notify("任务列表已刷新演示状态。")}><RefreshCw size={13} /> 刷新状态</button></>} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="全部任务" value={String(tasks.length).padStart(2, "0")} note="当前演示列表" icon={<Activity size={17} />} tone="purple" />
        <StatCard label="等待执行" value={String(tasks.filter((task) => task.status === "等待执行").length).padStart(2, "0")} note="尚未运行" icon={<Clock3 size={17} />} tone="blue" />
        <StatCard label="执行成功" value={String(tasks.filter((task) => task.status === "成功").length).padStart(2, "0")} note="示例状态" icon={<CheckCircle2 size={17} />} tone="green" />
        <StatCard label="需要留意" value={String(tasks.filter((task) => task.status === "失败待重试").length).padStart(2, "0")} note="模拟的失败任务" icon={<AlertTriangle size={17} />} tone="amber" />
      </div>

      <section className="surface mt-5 overflow-hidden">
        <div className="border-b border-[#edf0f6] p-4 sm:p-5">
          <div className="flex flex-col justify-between gap-4 xl:flex-row xl:items-center">
            <SectionTitle title="任务列表" description="查看执行时间、重试次数与最近状态" />
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative min-w-[210px] flex-1"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#a0a8b8]" /><input className="field pl-9" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索任务或角色……" aria-label="搜索任务" /></div>
              <select className="field min-w-[138px]" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="筛选任务状态"><option>全部状态</option><option>等待执行</option><option>执行中</option><option>成功</option><option>失败待重试</option><option>跳过</option></select>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left">
            <thead className="table-head"><tr><th className="px-5 py-3.5">任务</th><th className="px-4 py-3.5">所属角色</th><th className="px-4 py-3.5">覆盖范围</th><th className="px-4 py-3.5">状态</th><th className="px-4 py-3.5">重试次数</th><th className="px-4 py-3.5">最近更新</th><th className="px-5 py-3.5 text-right">操作</th></tr></thead>
            <tbody>
              {filtered.map((task) => (
                <tr key={task.id} className="table-row">
                  <td className="px-5 py-4"><div className="text-[11px] font-bold text-[#546079]">{task.name}</div><div className="mt-1 text-[9px] text-[#a2aabb]">{task.id}</div></td>
                  <td className="px-4 py-4"><span className="text-[11px] font-semibold text-[#69748c]">{task.character}</span></td>
                  <td className="max-w-[220px] px-4 py-4"><span className="line-clamp-2 text-[10px] leading-5 text-[#929cb0]">{task.range}</span></td>
                  <td className="px-4 py-4"><Badge tone={statusTone[task.status]} dot>{task.status}</Badge></td>
                  <td className="px-4 py-4 text-[11px] text-[#7d889f]">{task.tries} 次</td>
                  <td className="px-4 py-4 text-[10px] text-[#9ba4b6]">{task.time}</td>
                  <td className="px-5 py-4 text-right">
                    {task.status === "失败待重试" ? <button className="btn btn-sm" onClick={() => retry(task.id)}><RefreshCw size={12} /> 重试</button> : <button className="icon-btn h-7 w-7" title="查看任务详情" onClick={() => notify(`${task.id}：${task.name}。当前为模拟状态，详细日志尚未接入。`)}><MoreHorizontal size={15} /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!filtered.length && <div className="px-5 py-12 text-center text-[11px] text-[#9ba4b6]">没有符合条件的任务。</div>}
        </div>
        <div className="flex flex-col justify-between gap-2 border-t border-[#eef0f6] bg-[#fcfcfe] px-5 py-3 text-[10px] text-[#a1a9b9] sm:flex-row sm:items-center"><span>显示 {filtered.length} 条任务</span><span>演示状态仅存在于当前页面，不会写入数据库</span></div>
      </section>

      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="surface p-5"><SectionTitle title="任务可靠性要求" description="进入真实 Worker 阶段后需要满足的原则" /><div className="mt-4 space-y-3">{["任务状态保存在 PostgreSQL，服务重启后不丢失。","同一周期任务必须幂等，避免重复生成当前快照。","失败任务需要记录原因、尝试次数与下次重试时间。","服务停机期间错过的周期应在恢复后补处理。"].map((text,index)=><div key={text} className="flex items-start gap-2.5"><div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#f0eeff] text-[9px] font-bold text-[#786be4]">{index+1}</div><p className="text-[10px] leading-5 text-[#8792a8]">{text}</p></div>)}</div></section>
        <section className="rounded-[16px] border border-[#f2e8d9] bg-[#fffbf4] p-5"><div className="flex items-start gap-3"><div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] bg-white text-[#c38a36] shadow-sm"><AlertTriangle size={17} /></div><div><h2 className="text-[12px] font-extrabold text-[#8d6c3a]">当前页面是交互原型</h2><p className="mt-2 text-[10px] leading-5 text-[#a28f72]">“重试”操作只会修改浏览器里的模拟状态；真实任务执行、日志与重试队列要等 Phase 3 才会接入。请不要将这里的状态用于生产运维判断。</p></div></div></section>
      </div>

      {toast && <div role="status" className="fixed bottom-5 right-5 z-50 max-w-[360px] rounded-xl border border-[#e7e4ff] bg-white px-4 py-3 text-[12px] leading-5 text-[#6257be] shadow-xl">{toast}</div>}
    </div>
  );
}
