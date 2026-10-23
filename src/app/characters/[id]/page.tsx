"use client";

import Link from "next/link";
import { useMemo, useState, type FormEvent } from "react";
import { useParams } from "next/navigation";
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  AudioLines,
  BellRing,
  BookOpen,
  Bot,
  BrainCircuit,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Clock3,
  ExternalLink,
  FileClock,
  Filter,
  History,
  MessageCircle,
  MessageSquareText,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Tags,
  UserRound,
  X,
} from "lucide-react";
import { characters, snapshots, timelineEntries } from "@/lib/mock-data";
import type { TimelineEntry, TimelineType } from "@/lib/mock-data";
import { Badge, DemoLabel, PageHeader, SectionTitle } from "@/components/ui";

type FilterType = "全部记录" | "对话记录" | "重要事件" | "长期记忆" | "周期快照";
const filterOptions: { label: FilterType; type?: TimelineType }[] = [
  { label: "全部记录" },
  { label: "对话记录", type: "message" },
  { label: "重要事件", type: "event" },
  { label: "长期记忆", type: "memory" },
  { label: "周期快照", type: "snapshot" },
];

function TimelineGlyph({ type }: { type: TimelineType }) {
  const iconClass = "h-[15px] w-[15px]";
  if (type === "message") return <MessageCircle className={iconClass} />;
  if (type === "memory") return <BrainCircuit className={iconClass} />;
  if (type === "snapshot") return <FileClock className={iconClass} />;
  return <Sparkles className={iconClass} />;
}

function TimelineTone({ type }: { type: TimelineType }) {
  const tone = type === "message" ? "bg-[#e9f8f1] text-[#299677]" : type === "memory" ? "bg-[#f0eeff] text-[#7769e2]" : type === "snapshot" ? "bg-[#fff4e3] text-[#c18b36]" : "bg-[#edf5ff] text-[#5c88cc]";
  return tone;
}

export default function MemoryCockpitPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id || "big-fish";
  const character = characters.find((item) => item.id === id) || characters[0];
  const [activeFilter, setActiveFilter] = useState<FilterType>("全部记录");
  const [channelFilter, setChannelFilter] = useState("全部渠道");
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [characterName, setCharacterName] = useState(character.name);
  const [personality, setPersonality] = useState(character.personality);

  const filteredEntries = useMemo(() => {
    const type = filterOptions.find((option) => option.label === activeFilter)?.type;
    return timelineEntries.filter((entry) => {
      const typeMatches = !type || entry.type === type;
      const channelMatches = channelFilter === "全部渠道" || entry.channel === channelFilter || entry.channel === "全部渠道";
      const queryMatches = !query || `${entry.title} ${entry.summary} ${entry.source}`.toLowerCase().includes(query.toLowerCase());
      return typeMatches && channelMatches && queryMatches;
    });
  }, [activeFilter, channelFilter, query]);

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 3800);
  }

  function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setEditOpen(false);
    notify("已保存到当前页面的演示状态；接入数据库后才会永久保存。");
  }

  return (
    <div className="page-wrap">
      <PageHeader
        eyebrow="工作空间 / 角色管理 / 记忆驾驶舱"
        title="记忆驾驶舱"
        description="查看角色最近经历、长期记忆变化与周期快照。需要回忆什么，就从这里找到线索。"
        actions={<><DemoLabel /><button className="btn" onClick={() => setEditOpen(true)}><Settings2 size={14} /> 编辑角色</button><button className="btn btn-primary" onClick={() => notify("演示任务已排入预览队列；当前没有真实 Worker 执行。")}><Plus size={14} /> 手动归档</button></>}
      />

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#eae8fb] bg-gradient-to-r from-[#f8f7ff] to-[#fbfcff] px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-white text-[#7769e3] shadow-sm"><Sparkles size={15} /></div>
          <div>
            <div className="text-[11px] font-bold text-[#5f5b99]">正在查看角色：{character.name}</div>
            <div className="mt-0.5 text-[10px] text-[#9c9fbd]">快照周期 {character.intervalDays} 天 · 记忆条目 {character.memoryCount} 条</div>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-[#8b92ad]"><span className="h-1.5 w-1.5 rounded-full bg-[#32b58b]" /> 页面数据为演示数据</div>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 2xl:grid-cols-[250px_minmax(370px,1fr)_290px] xl:grid-cols-[250px_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <section className="surface overflow-hidden">
            <div className="h-[76px] bg-gradient-to-r from-[#e9e6ff] via-[#efefff] to-[#e3f0ff] soft-dots" />
            <div className="px-4 pb-4">
              <div className="-mt-8 flex items-end justify-between">
                <div className={`avatar h-[62px] w-[62px] border-[4px] border-white text-[21px] shadow-sm ${character.avatarTone === "peach" ? "avatar-peach" : character.avatarTone === "mint" ? "avatar-mint" : character.avatarTone === "blue" ? "avatar-blue" : ""}`}>{character.avatar}</div>
                <Badge tone={character.status === "运行中" ? "green" : "gray"} dot>{character.status}</Badge>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <h2 className="text-[17px] font-extrabold tracking-[-.045em] text-[#34405b]">{character.name}</h2>
                <button className="icon-btn h-6 w-6" onClick={() => setEditOpen(true)} aria-label="编辑角色名称"><Settings2 size={13} /></button>
              </div>
              <div className="mt-1.5 text-[10px] text-[#929bb0]">{character.alias}</div>
              <p className="mt-3 text-[11px] leading-5 text-[#7f8aa2]">{character.description}</p>
              <div className="mt-4 flex flex-wrap gap-1.5">
                {character.channels.length ? character.channels.map((channel) => <Badge key={channel} tone={channel === "B站" ? "blue" : "gray"}>{channel}</Badge>) : <Badge tone="gray">暂无渠道</Badge>}
              </div>
              <div className="mt-4 border-t border-[#eef0f6] pt-4">
                <div className="mb-2.5 flex items-center justify-between text-[10px]"><span className="text-[#9da5b7]">角色人设</span><span className="text-[#b1b7c5]">{personality.length} 字</span></div>
                <p className="line-clamp-4 text-[11px] leading-5 text-[#64708a]">{personality}</p>
                <button onClick={() => setEditOpen(true)} className="btn btn-sm mt-3 w-full justify-center">编辑基础人设</button>
              </div>
            </div>
          </section>

          <section className="surface p-4">
            <SectionTitle title="当前记忆状态" action={<BrainCircuit size={16} className="text-[#8b82e9]" />} />
            <div className="mt-4 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-[#98a1b4]">长期记忆条目</span>
                <span className="text-[14px] font-extrabold text-[#46516b]">{character.memoryCount}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-[#98a1b4]">已生成快照</span>
                <span className="text-[14px] font-extrabold text-[#46516b]">{character.id === "big-fish" ? "12" : character.id === "dragon-girl" ? "5" : "3"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-[#98a1b4]">最近一次归档</span>
                <span className="text-[10px] font-semibold text-[#68748e]">{character.latestSnapshot}</span>
              </div>
              <div className="rounded-xl bg-[#f8f7ff] p-3">
                <div className="flex items-center gap-2 text-[10px] font-bold text-[#7c70dd]"><ShieldIcon /> 记忆来源可追溯</div>
                <div className="mt-1.5 text-[10px] leading-4 text-[#999fbb]">快照会关联来源记录，方便查看总结依据。</div>
              </div>
            </div>
          </section>

          <section className="surface p-4">
            <SectionTitle title="记忆范围" description="当前选择的内容隔离范围" />
            <div className="mt-3 space-y-2">
              <button className="flex w-full items-center gap-2.5 rounded-xl border border-[#dedbff] bg-[#f7f6ff] p-3 text-left">
                <div className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-white text-[#7b6fe3]"><Sparkles size={14} /></div>
                <div className="min-w-0 flex-1"><div className="text-[11px] font-bold text-[#62609b]">角色全局记忆</div><div className="mt-1 text-[9px] text-[#a1a5c0]">公共经历与角色状态</div></div>
                <CheckCircle2 size={14} className="text-[#8a7ef0]" />
              </button>
              <button onClick={() => notify("用户私人记忆范围将在完成身份与权限流程后开放。")} className="flex w-full items-center gap-2.5 rounded-xl border border-[#eef0f6] bg-white p-3 text-left hover:bg-[#fbfbff]">
                <div className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[#f3f5fa] text-[#8893aa]"><UserRound size={14} /></div>
                <div className="min-w-0 flex-1"><div className="text-[11px] font-bold text-[#66718a]">用户私人记忆</div><div className="mt-1 text-[9px] text-[#a3aabc]">按用户隔离 · 待接入</div></div>
                <ArrowUpRight size={13} className="text-[#b3bac9]" />
              </button>
            </div>
          </section>
        </div>

        <div className="surface min-w-0 p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <SectionTitle title="记忆时间线" description="按照发生时间，浏览角色在不同渠道的经历" />
            <button onClick={() => notify("已刷新演示数据。")} className="icon-btn h-8 w-8" title="刷新时间线"><RefreshCw size={14} /></button>
          </div>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <div className="relative min-w-0 flex-1">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#a2aabc]" />
              <input className="field h-9 min-h-9 pl-9 text-[11px]" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索这段经历……" aria-label="搜索记忆" />
            </div>
            <div className="relative">
              <select className="field h-9 min-h-9 appearance-none pr-8 text-[11px]" value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)} aria-label="按渠道筛选">
                <option>全部渠道</option><option>QQ</option><option>B站</option>
              </select>
              <ChevronDown size={13} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[#9aa3b5]" />
            </div>
          </div>
          <div className="mt-3 flex gap-1 overflow-x-auto border-b border-[#eff1f7] pb-2">
            {filterOptions.map((item) => (
              <button key={item.label} onClick={() => setActiveFilter(item.label)} className={`shrink-0 rounded-lg px-3 py-2 text-[10px] font-bold transition ${activeFilter === item.label ? "bg-[#f0eeff] text-[#7568e3]" : "text-[#9aa2b4] hover:bg-[#fafaff] hover:text-[#65708a]"}`}>{item.label}</button>
            ))}
          </div>

          <div className="mt-4">
            {filteredEntries.length ? filteredEntries.map((entry, index) => (
              <TimelineCard key={entry.id} entry={entry} last={index === filteredEntries.length - 1} />
            )) : (
              <div className="py-16 text-center">
                <Search size={22} className="mx-auto text-[#b0b6c5]" />
                <div className="mt-3 text-[12px] font-bold text-[#66718a]">没有找到相关记忆</div>
                <div className="mt-1 text-[10px] text-[#a3aabc]">试试其他关键词或渠道。</div>
                <button className="btn btn-sm mt-3" onClick={() => { setQuery(""); setChannelFilter("全部渠道"); setActiveFilter("全部记录"); }}>清除筛选</button>
              </div>
            )}
          </div>
          <button onClick={() => notify("演示时间线已到末尾；真实数据接入后会支持分页加载。")} className="btn mt-1 w-full justify-center border-dashed bg-[#fcfcff] text-[#8993a9]">加载更多记录 <ArrowRight size={13} /></button>
        </div>

        <div className="flex flex-col gap-4 xl:col-span-2 2xl:col-span-1">
          <section className="surface overflow-hidden">
            <div className="border-b border-[#edf0f6] px-4 py-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2"><h2 className="text-[13px] font-extrabold text-[#3f4a65]">周期归档</h2><Badge tone="purple">自动运行</Badge></div>
                  <p className="mt-1.5 text-[10px] text-[#9aa3b6]">按设定的间隔生成阶段记忆</p>
                </div>
                <Link href={`/characters/${character.id}/settings/memory`} className="icon-btn h-8 w-8" title="周期设置"><Settings2 size={15} /></Link>
              </div>
            </div>
            <div className="p-4">
              <div className="rounded-[14px] bg-gradient-to-br from-[#f1efff] via-[#f7f6ff] to-[#f1f7ff] p-4">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold text-[#8177d9]">距离下一次快照</span>
                  <CalendarClock size={16} className="text-[#8d84e9]" />
                </div>
                <div className="mt-3 flex items-baseline gap-2">
                  <span className="text-[30px] font-extrabold leading-none tracking-[-.06em] text-[#453f8a]">{character.id === "big-fish" ? "1" : character.id === "dragon-girl" ? "11" : "—"}</span>
                  <span className="text-[11px] font-semibold text-[#827bc4]">{character.id === "big-fish" ? "天" : character.id === "dragon-girl" ? "天" : "已暂停"}</span>
                </div>
                <div className="mt-3 text-[10px] font-semibold text-[#7773b2]">{character.nextSnapshot}</div>
                {character.status !== "已暂停" && <>
                  <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/80"><div className={`h-full rounded-full bg-gradient-to-r from-[#a59bf8] to-[#7567e5] ${character.intervalDays === 8 ? "w-[87.5%]" : "w-[21%]"}`} /></div>
                  <div className="mt-2 flex justify-between text-[9px] text-[#a09dc9]"><span>当前周期</span><span>{character.intervalDays} 天周期</span></div>
                </>}
              </div>
              <div className="mt-4 space-y-3">
                <div className="flex items-center justify-between"><span className="text-[10px] text-[#98a1b4]">当前周期消息</span><span className="text-[11px] font-bold text-[#59657e]">46 条</span></div>
                <div className="flex items-center justify-between"><span className="text-[10px] text-[#98a1b4]">待整理的重要事件</span><span className="text-[11px] font-bold text-[#59657e]">5 个</span></div>
                <div className="flex items-center justify-between"><span className="text-[10px] text-[#98a1b4]">自动归档</span><Badge tone={character.status === "已暂停" ? "gray" : "green"} dot>{character.status === "已暂停" ? "已暂停" : "已开启"}</Badge></div>
              </div>
              <Link href={`/characters/${character.id}/settings/memory`} className="btn mt-4 w-full justify-center">管理周期设置 <ArrowRight size={13} /></Link>
            </div>
          </section>

          <section className="surface p-4">
            <div className="flex items-center justify-between gap-2">
              <SectionTitle title="最近的快照" description="保留每次归档的历史版本" />
              <Link href={`/characters/${character.id}/snapshots`} className="text-[10px] font-bold text-[#786be4]">全部</Link>
            </div>
            <div className="mt-4 space-y-3">
              {snapshots.slice(0, 3).map((snapshot) => (
                <Link key={snapshot.id} href={`/characters/${character.id}/snapshots`} className="group flex gap-3 rounded-xl p-2 transition hover:bg-[#fafaff]">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] bg-[#f4f2ff] text-[#7d70e7]"><FileClock size={15} /></div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5"><span className="text-[11px] font-bold text-[#606b83]">第 {snapshot.number} 份快照</span><Badge tone={snapshot.statusTone}>{snapshot.status}</Badge></div>
                    <p className="mt-1.5 line-clamp-2 text-[10px] leading-4 text-[#969fb2]">{snapshot.summary}</p>
                    <div className="mt-2 text-[9px] text-[#b0b6c4]">{snapshot.range}</div>
                  </div>
                </Link>
              ))}
            </div>
            <Link href={`/characters/${character.id}/snapshots`} className="btn mt-3 w-full justify-center">查看全部历史快照 <History size={13} /></Link>
          </section>

          <section className="rounded-[16px] border border-[#e8e7fa] bg-[#fbfaff] p-4">
            <div className="flex items-start gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-white text-[#8074e5] shadow-sm"><BookOpen size={15} /></div>
              <div><div className="text-[11px] font-bold text-[#67619f]">记忆小贴士</div><p className="mt-1.5 text-[10px] leading-5 text-[#9696b9]">快照是阶段性归档，并不是删除期限。重要经历会留在历史档案中，回答时再按需检索。</p></div>
            </div>
          </section>
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-2 text-[10px] text-[#a5adbc]">
        <span>角色数据与记忆内容均为示例</span>
        <span>真实数据库接入后将持久保存每次修改</span>
      </div>

      {toast && <div role="status" className="fixed bottom-5 right-5 z-50 max-w-[360px] rounded-xl border border-[#e7e4ff] bg-white px-4 py-3 text-[12px] leading-5 text-[#6257be] shadow-xl">{toast}</div>}

      {editOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#29324b]/30 p-4 backdrop-blur-[3px]" onMouseDown={(e) => { if (e.target === e.currentTarget) setEditOpen(false); }}>
          <div role="dialog" aria-modal="true" aria-labelledby="edit-character-title" className="w-full max-w-[520px] rounded-[20px] bg-white p-5 shadow-2xl sm:p-7">
            <div className="flex items-start justify-between gap-4"><div><div className="eyebrow">角色设定</div><h2 id="edit-character-title" className="mt-2 text-[21px] font-extrabold text-[#34405b]">编辑角色信息</h2><p className="mt-1.5 text-[11px] text-[#929bb0]">当前修改仅保存在页面演示状态中。</p></div><button className="icon-btn" onClick={() => setEditOpen(false)} aria-label="关闭"><X size={17} /></button></div>
            <form onSubmit={saveProfile} className="mt-5 space-y-4">
              <div><label className="field-label" htmlFor="cockpit-name">角色名称</label><input id="cockpit-name" className="field" value={characterName} onChange={(e) => setCharacterName(e.target.value)} required /></div>
              <div><label className="field-label" htmlFor="cockpit-personality">基础人设</label><textarea id="cockpit-personality" className="field min-h-[130px] resize-y" value={personality} onChange={(e) => setPersonality(e.target.value)} required /></div>
              <div className="flex justify-end gap-2 border-t border-[#eef0f6] pt-4"><button type="button" className="btn" onClick={() => setEditOpen(false)}>取消</button><button type="submit" className="btn btn-primary">保存修改</button></div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function TimelineCard({ entry, last }: { entry: TimelineEntry; last: boolean }) {
  return (
    <div className={`relative flex gap-3 pb-5 ${last ? "timeline-last" : ""}`}>
      <div className="relative z-10 flex w-[31px] shrink-0 justify-center">
        <div className={`flex h-[31px] w-[31px] items-center justify-center rounded-[10px] ${TimelineTone({ type: entry.type })}`}><TimelineGlyph type={entry.type} /></div>
        <span className="timeline-line" />
      </div>
      <div className="min-w-0 flex-1 rounded-xl border border-[#eff1f7] bg-white px-3.5 py-3 transition hover:border-[#e0ddff] hover:bg-[#fdfcff] sm:px-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <h3 className="text-[11px] font-bold leading-5 text-[#4c5872]">{entry.title}</h3>
          <span className="shrink-0 text-[9px] text-[#a5adbd]">{entry.time}</span>
        </div>
        <p className="mt-1.5 text-[10px] leading-5 text-[#8590a7]">{entry.summary}</p>
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Badge tone={entry.tagTone}>{entry.tag}</Badge>
          <Badge tone="gray">{entry.channel}</Badge>
          <button className="ml-auto inline-flex items-center gap-1 text-[9px] font-semibold text-[#9ca4b6] hover:text-[#7568df]" title={entry.source}><ExternalLink size={11} /> 来源</button>
        </div>
      </div>
    </div>
  );
}

function ShieldIcon() {
  return <CheckCircle2 size={14} />;
}
