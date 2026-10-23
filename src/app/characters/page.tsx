"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowUpRight, Bot, Check, ChevronDown, CirclePlus, MoreHorizontal, Plus, Search, Sparkles, UsersRound, X } from "lucide-react";
import { characters as initialCharacters, type Character } from "@/lib/mock-data";
import { Badge, DemoLabel, PageHeader, StatCard } from "@/components/ui";

const toneClass = {
  purple: "",
  peach: "avatar-peach",
  mint: "avatar-mint",
  blue: "avatar-blue",
} as const;

export default function CharactersPage() {
  const [items, setItems] = useState<Character[]>(initialCharacters);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("全部状态");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");

  const filtered = useMemo(() => items.filter((character) => {
    const matchesQuery = !query || `${character.name} ${character.description} ${character.alias}`.toLowerCase().includes(query.toLowerCase());
    const matchesStatus = statusFilter === "全部状态" || character.status === statusFilter;
    return matchesQuery && matchesStatus;
  }), [items, query, statusFilter]);

  function createCharacter(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const created: Character = {
      id: `demo-${Date.now()}`,
      name: trimmed,
      alias: "新建角色",
      description: description.trim() || "还没有填写角色简介。",
      avatar: trimmed.slice(0, 1),
      avatarTone: "mint",
      status: "已暂停",
      channels: [],
      intervalDays: 8,
      nextSnapshot: "尚未启用",
      memoryCount: 0,
      latestSnapshot: "暂无快照",
      personality: prompt.trim() || "请补充角色的人设与行为规则。",
    };
    setItems((current) => [created, ...current]);
    setDialogOpen(false);
    setName("");
    setDescription("");
    setPrompt("");
    setToast("角色已添加到当前演示列表；刷新页面后会恢复示例数据。");
    window.setTimeout(() => setToast(""), 4200);
  }

  return (
    <div className="page-wrap">
      <PageHeader
        eyebrow="工作空间 / 角色管理"
        title="你的角色档案"
        description="集中管理不同的人设、模型配置与记忆周期。每个角色都拥有独立的经历和记忆。"
        actions={<><DemoLabel /><button className="btn btn-primary" onClick={() => setDialogOpen(true)}><Plus size={15} /> 创建角色</button></>}
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="全部角色" value={String(items.length).padStart(2, "0")} note="包含已暂停角色" icon={<UsersRound size={17} />} tone="purple" />
        <StatCard label="正在运行" value={String(items.filter((x) => x.status === "运行中").length).padStart(2, "0")} note="已配置活动渠道" icon={<Sparkles size={17} />} tone="green" />
        <StatCard label="已保存记忆" value={String(items.reduce((sum, x) => sum + x.memoryCount, 0))} note="示例条目统计" icon={<Bot size={17} />} tone="blue" />
      </div>

      <div className="surface mt-5 p-4 sm:p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <div className="relative min-w-0 flex-1">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#a0a8b8]" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} className="field pl-9" placeholder="搜索角色名称、简介或标签……" aria-label="搜索角色" />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <select className="field min-w-[136px] appearance-none pr-9" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="筛选角色状态">
                <option>全部状态</option><option>运行中</option><option>已暂停</option><option>未连接</option>
              </select>
              <ChevronDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#9ca4b6]" />
            </div>
            <button className="btn" onClick={() => { setQuery(""); setStatusFilter("全部状态"); }}>重置筛选</button>
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between text-[10px] text-[#9ca4b6]">
          <span>找到 <strong className="text-[#5d6881]">{filtered.length}</strong> 个角色</span>
          <span>角色数据仅保存在当前页面状态</span>
        </div>
      </div>

      {filtered.length > 0 ? (
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {filtered.map((character) => (
            <article key={character.id} className="surface surface-hover group relative p-5">
              <div className="flex items-start gap-3.5">
                <div className={`avatar h-14 w-14 text-[18px] ${toneClass[character.avatarTone]}`}>{character.avatar}</div>
                <div className="min-w-0 flex-1 pt-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-[15px] font-extrabold tracking-[-.035em] text-[#37415c]">{character.name}</h2>
                    <Badge tone={character.status === "运行中" ? "green" : "gray"} dot>{character.status}</Badge>
                  </div>
                  <p className="mt-1.5 text-[10px] text-[#959eb1]">{character.alias}</p>
                </div>
                <button className="icon-btn h-8 w-8" title="更多操作" aria-label={`更多操作：${character.name}`} onClick={() => setToast("更多角色操作将在接入真实数据后开放。")}><MoreHorizontal size={17} /></button>
              </div>
              <p className="mt-4 min-h-[40px] text-[11px] leading-5 text-[#7f8aa2]">{character.description}</p>
              <div className="mt-4 flex flex-wrap gap-1.5">
                {character.channels.length > 0 ? character.channels.map((channel) => <Badge key={channel} tone={channel === "B站" ? "blue" : "gray"}>{channel}</Badge>) : <Badge tone="gray">暂无渠道</Badge>}
                <Badge tone="purple">{character.intervalDays} 天快照周期</Badge>
              </div>
              <div className="mt-5 grid grid-cols-2 gap-3 rounded-xl bg-[#fafaff] p-3.5">
                <div>
                  <div className="text-[10px] text-[#a0a8b8]">长期记忆</div>
                  <div className="mt-1.5 text-[18px] font-extrabold tracking-[-.04em] text-[#46516c]">{character.memoryCount}<span className="ml-1 text-[10px] font-medium text-[#9aa3b6]">条</span></div>
                </div>
                <div className="border-l border-[#e9ebf4] pl-3">
                  <div className="text-[10px] text-[#a0a8b8]">下一次归档</div>
                  <div className="mt-2 text-[11px] font-bold text-[#69748e]">{character.nextSnapshot}</div>
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between gap-2">
                <span className="text-[10px] text-[#a0a8b8]">最近快照 · {character.latestSnapshot}</span>
                <Link href={`/characters/${character.id}`} className="btn btn-sm border-[#e6e2ff] bg-[#f8f7ff] text-[#7568df]">打开档案 <ArrowUpRight size={13} /></Link>
              </div>
            </article>
          ))}
          <button onClick={() => setDialogOpen(true)} className="flex min-h-[290px] flex-col items-center justify-center rounded-[17px] border border-dashed border-[#dcdcf0] bg-white/55 p-5 text-center transition hover:border-[#a8a1f3] hover:bg-[#fbfaff]">
            <span className="flex h-12 w-12 items-center justify-center rounded-[15px] bg-[#f1efff] text-[#786be5]"><CirclePlus size={21} /></span>
            <span className="mt-4 text-[12px] font-bold text-[#59647c]">创建一个新角色</span>
            <span className="mt-1.5 max-w-[190px] text-[10px] leading-5 text-[#a0a8b8]">为 TA 填写人设、设定记忆周期，逐步建立专属档案。</span>
          </button>
        </div>
      ) : (
        <div className="surface mt-4 flex flex-col items-center px-6 py-16 text-center">
          <Search size={22} className="text-[#a4a9bd]" />
          <div className="mt-3 text-[13px] font-bold text-[#56617b]">没有找到匹配的角色</div>
          <div className="mt-1 text-[11px] text-[#9ba4b6]">尝试更换关键词或清除筛选条件。</div>
          <button className="btn mt-4" onClick={() => { setQuery(""); setStatusFilter("全部状态"); }}>清除筛选</button>
        </div>
      )}

      {toast && <div role="status" className="fixed bottom-5 right-5 z-50 max-w-[360px] rounded-xl border border-[#e7e4ff] bg-white px-4 py-3 text-[12px] leading-5 text-[#6257be] shadow-xl">{toast}</div>}

      {dialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#29324b]/30 p-4 backdrop-blur-[3px]" onMouseDown={(e) => { if (e.target === e.currentTarget) setDialogOpen(false); }}>
          <div role="dialog" aria-modal="true" aria-labelledby="create-character-title" className="w-full max-w-[540px] rounded-[20px] border border-white/70 bg-white p-5 shadow-[0_24px_80px_rgba(32,39,78,.2)] sm:p-7">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="eyebrow">新角色</div>
                <h2 id="create-character-title" className="mt-2 text-[22px] font-extrabold tracking-[-.04em] text-[#34405b]">创建角色档案</h2>
                <p className="mt-2 text-[11px] leading-5 text-[#929bb0]">先建立基础身份，模型与渠道配置可以稍后补充。</p>
              </div>
              <button className="icon-btn" onClick={() => setDialogOpen(false)} aria-label="关闭"><X size={17} /></button>
            </div>
            <form onSubmit={createCharacter} className="mt-6 space-y-4">
              <div>
                <label className="field-label" htmlFor="character-name">角色名称 <span className="text-[#c45e76]">*</span></label>
                <input id="character-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} className="field" placeholder="例如：月光旅人" autoFocus />
              </div>
              <div>
                <label className="field-label" htmlFor="character-description">一句话简介</label>
                <input id="character-description" value={description} onChange={(e) => setDescription(e.target.value)} className="field" placeholder="TA 是什么样的角色？" />
              </div>
              <div>
                <label className="field-label" htmlFor="character-prompt">基础人设</label>
                <textarea id="character-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} className="field min-h-[100px] resize-y" placeholder="性格、说话方式、背景和行为规则……" />
              </div>
              <div className="rounded-xl bg-[#f8f7ff] p-3 text-[10px] leading-5 text-[#8279c8]">演示模式：点击创建只会将角色添加到当前页面状态，刷新后不会保留。</div>
              <div className="flex justify-end gap-2 border-t border-[#eef0f6] pt-4">
                <button type="button" className="btn" onClick={() => setDialogOpen(false)}>取消</button>
                <button type="submit" className="btn btn-primary"><Check size={14} /> 创建角色</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
