"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { ArrowLeft, ArrowUpRight, CalendarDays, Check, ChevronDown, Clock3, FileClock, History, MessageSquare, MoreHorizontal, RefreshCw, Search, Sparkles, X } from "lucide-react";
import { characters, snapshots, type Snapshot } from "@/lib/mock-data";
import { Badge, DemoLabel, PageHeader, SectionTitle, StatCard } from "@/components/ui";

export default function SnapshotsPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id || "big-fish";
  const character = characters.find((item) => item.id === id) || characters[0];
  const [items, setItems] = useState<Snapshot[]>(snapshots);
  const [query, setQuery] = useState("");
  const [versionFilter, setVersionFilter] = useState("全部版本状态");
  const [detail, setDetail] = useState<Snapshot | null>(null);
  const [toast, setToast] = useState("");

  const filtered = useMemo(() => items.filter((item) => {
    const queryMatch = !query || `${item.summary} ${item.range} 第 ${item.number} 份`.toLowerCase().includes(query.toLowerCase());
    const statusMatch = versionFilter === "全部版本状态" || item.status === versionFilter;
    return queryMatch && statusMatch;
  }), [items, query, versionFilter]);

  function notify(text: string) {
    setToast(text);
    window.setTimeout(() => setToast(""), 4200);
  }

  function regenerate(snapshot: Snapshot) {
    const newVersion: Snapshot = {
      ...snapshot,
      id: `${snapshot.id}-v${snapshot.version + 1}-${Date.now()}`,
      version: snapshot.version + 1,
      date: "刚刚（演示）",
      status: "当前版本",
      statusTone: "green",
      summary: "这是重新生成的演示版本。真实实现将保留旧版本，并记录本次生成所使用的模型与来源。",
    };
    setItems((current) => [newVersion, ...current.map((item) => item.id === snapshot.id ? { ...item, status: "已被替代" as const, statusTone: "gray" as const } : item)]);
    setDetail(newVersion);
    notify(`第 ${snapshot.number} 份快照已创建演示版本 v${newVersion.version}；旧版本保留。`);
  }

  return (
    <div className="page-wrap">
      <PageHeader
        eyebrow={`角色管理 / ${character.name} / 周期快照`}
        title="周期快照档案"
        description="每份快照都是一个时间段的记忆归档。重新生成会创建新版本，旧版本不会被覆盖。"
        actions={<><DemoLabel /><Link href={`/characters/${character.id}`} className="btn"><ArrowLeft size={14} /> 返回驾驶舱</Link><button className="btn btn-primary" onClick={() => notify("已排入演示快照任务；真实生成器尚未接入。")}><Sparkles size={14} /> 生成快照</button></>}
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="历史快照" value={String(items.length).padStart(2, "0")} note="包含演示版本" icon={<FileClock size={17} />} tone="purple" />
        <StatCard label="覆盖消息" value={items.reduce((s, x) => s + x.messages, 0).toString()} note="来源记录统计" icon={<MessageSquare size={17} />} tone="blue" />
        <StatCard label="最近生成" value={items[0]?.date.includes("刚刚") ? "刚刚" : "10/21"} note="仅当前演示状态" icon={<Clock3 size={17} />} tone="green" />
      </div>

      <div className="surface mt-5 p-4 sm:p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <div className="relative min-w-0 flex-1"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#a0a8b8]" /><input className="field pl-9" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索快照总结、时间段或编号……" aria-label="搜索快照" /></div>
          <div className="relative"><select className="field min-w-[150px] appearance-none pr-9" value={versionFilter} onChange={(e) => setVersionFilter(e.target.value)} aria-label="筛选快照状态"><option>全部版本状态</option><option>当前版本</option><option>已被替代</option></select><ChevronDown size={13} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#9ca4b6]" /></div>
          <button className="btn" onClick={() => { setQuery(""); setVersionFilter("全部版本状态"); }}>重置筛选</button>
        </div>
        <div className="mt-4 flex items-center justify-between text-[10px] text-[#9ca4b6]"><span>共 <strong className="text-[#5d6881]">{filtered.length}</strong> 份快照</span><span>历史版本不会被自动覆盖</span></div>
      </div>

      <div className="mt-5 grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(300px,.8fr)]">
        <section className="surface p-4 sm:p-5">
          <SectionTitle title="归档时间线" description="按生成时间倒序排列" />
          <div className="mt-5 space-y-3">
            {filtered.map((snapshot, index) => (
              <button key={snapshot.id} onClick={() => setDetail(snapshot)} className={`w-full rounded-[15px] border p-4 text-left transition ${detail?.id === snapshot.id ? "border-[#cfc9ff] bg-[#fbfaff]" : "border-[#eef0f6] bg-white hover:border-[#dedbff] hover:bg-[#fdfcff]"}`}>
                <div className="flex items-start gap-3.5">
                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] ${index === 0 ? "bg-[#f0eeff] text-[#7869e5]" : "bg-[#f6f7fb] text-[#8d97ad]"}`}><FileClock size={17} /></div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[12px] font-extrabold text-[#45516b]">第 {snapshot.number} 份快照</span>
                      <span className="rounded-md border border-[#edeef5] bg-white px-1.5 py-0.5 text-[9px] font-bold text-[#8f98ad]">v{snapshot.version}</span>
                      <Badge tone={snapshot.statusTone}>{snapshot.status}</Badge>
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[#9ca4b6]"><span className="inline-flex items-center gap-1"><CalendarDays size={11} />{snapshot.range}</span><span>生成于 {snapshot.date}</span></div>
                    <p className="mt-3 text-[11px] leading-5 text-[#78849c]">{snapshot.summary}</p>
                    <div className="mt-3 flex flex-wrap items-center gap-3 text-[10px] text-[#a1a9b8]"><span>{snapshot.messages} 条消息</span><span>{snapshot.events} 个重要事件</span><span className="ml-auto inline-flex items-center gap-1 text-[#8074df]">查看详情 <ArrowUpRight size={12} /></span></div>
                  </div>
                </div>
              </button>
            ))}
            {!filtered.length && <div className="py-12 text-center text-[12px] text-[#929bb0]">没有符合条件的快照。</div>}
          </div>
        </section>

        <aside className="flex flex-col gap-4">
          <section className="surface p-5">
            <div className="flex items-center justify-between gap-2"><SectionTitle title="快照详情" description={detail ? `第 ${detail.number} 份 · 版本 v${detail.version}` : "选择一份快照查看内容"} /><History size={17} className="text-[#8b82e9]" /></div>
            {detail ? (
              <>
                <div className="mt-4 rounded-xl bg-[#f9f8ff] p-4"><div className="flex flex-wrap items-center gap-2"><Badge tone={detail.statusTone}>{detail.status}</Badge><span className="text-[10px] text-[#9ba3b6]">{detail.range}</span></div><p className="mt-3 text-[12px] leading-6 text-[#64708a]">{detail.summary}</p></div>
                <div className="mt-4 grid grid-cols-2 gap-3"><div className="rounded-xl border border-[#eef0f6] p-3"><div className="text-[10px] text-[#9ca4b6]">覆盖消息</div><div className="mt-2 text-[20px] font-extrabold text-[#46516b]">{detail.messages}</div></div><div className="rounded-xl border border-[#eef0f6] p-3"><div className="text-[10px] text-[#9ca4b6]">重要事件</div><div className="mt-2 text-[20px] font-extrabold text-[#46516b]">{detail.events}</div></div></div>
                <div className="mt-4 space-y-3">
                  <div><div className="text-[10px] font-bold text-[#707b94]">本阶段重要变化</div><p className="mt-1.5 text-[10px] leading-5 text-[#969fb2]">角色记录了用户偏好和互动习惯的变化，并保留需要继续跟进的约定。</p></div>
                  <div><div className="text-[10px] font-bold text-[#707b94]">来源可追溯</div><p className="mt-1.5 text-[10px] leading-5 text-[#969fb2]">正式版本将展示来源消息 ID、事件时间和模型生成信息。</p></div>
                </div>
                <div className="mt-5 flex flex-wrap gap-2"><button className="btn flex-1 justify-center" onClick={() => notify("版本列表会在真实快照 API 接入后展示。")}><History size={13} /> 历史版本</button><button className="btn btn-primary flex-1 justify-center" onClick={() => regenerate(detail)}><RefreshCw size={13} /> 重新生成</button></div>
              </>
            ) : (
              <div className="mt-4 rounded-xl border border-dashed border-[#e4e7f0] px-4 py-10 text-center"><div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-[#f2f0ff] text-[#7769e4]"><FileClock size={17} /></div><div className="mt-3 text-[11px] font-bold text-[#606b84]">还没有选择快照</div><p className="mt-1.5 text-[10px] leading-5 text-[#9aa3b5]">从左侧选择一个归档，查看覆盖范围和摘要。</p></div>
            )}
          </section>
          <section className="rounded-[16px] border border-[#e8e7fa] bg-[#fbfaff] p-4">
            <div className="flex items-start gap-2.5"><div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-white text-[#8074e5] shadow-sm"><Sparkles size={15} /></div><div><div className="text-[11px] font-bold text-[#67619f]">关于快照版本</div><p className="mt-1.5 text-[10px] leading-5 text-[#9696b9]">重新生成应创建新版本，旧版本保留为历史记录，方便比较模型总结的变化。</p></div></div>
          </section>
        </aside>
      </div>

      {toast && <div role="status" className="fixed bottom-5 right-5 z-50 max-w-[360px] rounded-xl border border-[#e7e4ff] bg-white px-4 py-3 text-[12px] leading-5 text-[#6257be] shadow-xl">{toast}</div>}
    </div>
  );
}
