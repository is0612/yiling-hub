"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useParams } from "next/navigation";
import { ArrowLeft, CalendarClock, Check, Clock3, Info, RotateCcw, Save, Settings2, ShieldCheck, Sparkles } from "lucide-react";
import { characters } from "@/lib/mock-data";
import { Badge, DemoLabel, PageHeader } from "@/components/ui";

export default function MemorySettingsPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id || "big-fish";
  const character = characters.find((item) => item.id === id) || characters[0];
  const [interval, setInterval] = useState(String(character.intervalDays));
  const [timezone, setTimezone] = useState("Asia/Shanghai");
  const [anchor, setAnchor] = useState("2026-10-21T09:00");
  const [retention, setRetention] = useState("90");
  const [autoSnapshot, setAutoSnapshot] = useState(character.status !== "已暂停");
  const [effectivePolicy, setEffectivePolicy] = useState("下一个周期生效");
  const [toast, setToast] = useState("");

  const intervalNumber = Math.min(365, Math.max(1, Number(interval) || 8));

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 4000);
  }

  function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    notify(`已保存演示设置：每 ${intervalNumber} 天归档；真实数据库接入后才会持久保存。`);
  }

  function resetSettings() {
    setInterval(String(character.intervalDays));
    setTimezone("Asia/Shanghai");
    setAnchor("2026-10-21T09:00");
    setRetention("90");
    setAutoSnapshot(character.status !== "已暂停");
    setEffectivePolicy("下一个周期生效");
    notify("已恢复为示例配置。");
  }

  return (
    <div className="page-wrap">
      <PageHeader
        eyebrow={`角色管理 / ${character.name} / 记忆设置`}
        title="记忆周期设置"
        description="控制角色多久归档一次阶段记忆。快照生成周期与原始消息保留期限是两套独立规则。"
        actions={<><DemoLabel /><Link href={`/characters/${character.id}`} className="btn"><ArrowLeft size={14} /> 返回驾驶舱</Link></>}
      />

      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <form onSubmit={saveSettings} className="space-y-5">
          <section className="surface p-5 sm:p-6">
            <div className="flex items-start justify-between gap-3">
              <div><div className="flex items-center gap-2"><h2 className="text-[14px] font-extrabold text-[#3e4963]">自动归档规则</h2><Badge tone="purple">核心设置</Badge></div><p className="mt-1.5 text-[11px] leading-5 text-[#969fb2]">每完成一个周期，就为这个记忆范围生成阶段总结。</p></div>
              <CalendarClock size={18} className="text-[#8176e7]" />
            </div>

            <div className="mt-6 rounded-[15px] border border-[#e8e5ff] bg-gradient-to-r from-[#f8f7ff] to-[#f7faff] p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div><div className="text-[11px] font-bold text-[#7168c7]">快照生成间隔</div><p className="mt-1.5 text-[10px] leading-5 text-[#9b9dc0]">周期可设为 1–365 天；默认值为 8 天。</p></div>
                <div className="flex items-center gap-2 rounded-xl border border-[#e7e3ff] bg-white p-2">
                  <input type="number" min="1" max="365" value={interval} onChange={(e) => setInterval(e.target.value)} aria-label="快照周期天数" className="w-[70px] bg-transparent text-center text-[25px] font-extrabold tracking-[-.05em] text-[#5a4fbe] outline-none" />
                  <span className="pr-2 text-[11px] font-semibold text-[#8982ca]">天 / 次</span>
                </div>
              </div>
              <input type="range" min="1" max="30" value={Math.min(30, intervalNumber)} onChange={(e) => setInterval(e.target.value)} aria-label="快速调整 1 到 30 天周期" className="mt-5 w-full accent-[#786be5]" />
              <div className="mt-1 flex justify-between text-[9px] text-[#a5a8c2]"><span>1 天</span><span>15 天</span><span>30 天</span></div>
              <div className="mt-4 flex flex-wrap gap-2">
                {[1, 3, 7, 8, 14, 30].map((day) => <button key={day} type="button" onClick={() => setInterval(String(day))} className={`rounded-lg border px-3 py-2 text-[10px] font-bold transition ${intervalNumber === day ? "border-[#c9c2ff] bg-white text-[#7466e0] shadow-sm" : "border-[#e9e9f7] bg-white/60 text-[#929bb1] hover:border-[#d8d3ff]"}`}>{day} 天</button>)}
              </div>
            </div>

            <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div><label htmlFor="timezone" className="field-label">记忆时区</label><select id="timezone" className="field" value={timezone} onChange={(e) => setTimezone(e.target.value)}><option value="Asia/Shanghai">中国标准时间（Asia/Shanghai）</option><option value="America/Los_Angeles">美国太平洋时间（America/Los_Angeles）</option><option value="UTC">协调世界时（UTC）</option><option value="Asia/Tokyo">日本标准时间（Asia/Tokyo）</option></select><p className="mt-1.5 text-[10px] leading-4 text-[#a0a8b8]">周期边界按这个时区显示和计算。</p></div>
              <div><label htmlFor="anchor" className="field-label">周期启用时间</label><input id="anchor" type="datetime-local" className="field" value={anchor} onChange={(e) => setAnchor(e.target.value)} /><p className="mt-1.5 text-[10px] leading-4 text-[#a0a8b8]">决定周期从哪个时间点开始累计。</p></div>
            </div>

            <div className="mt-5 flex items-start gap-3 rounded-xl border border-[#e9e8f6] bg-[#fbfbff] p-3.5">
              <Info size={16} className="mt-0.5 shrink-0 text-[#8278df]" />
              <div className="text-[10px] leading-5 text-[#8b94aa]"><strong className="text-[#6a6e9a]">周期修改规则：</strong>默认在当前周期完成后使用新设置，不会修改或删除已经生成的历史快照。手动生成快照也不会重置自动归档时间。</div>
            </div>
          </section>

          <section className="surface p-5 sm:p-6">
            <div className="flex items-start justify-between gap-3"><div><h2 className="text-[14px] font-extrabold text-[#3e4963]">原始消息保留</h2><p className="mt-1.5 text-[11px] leading-5 text-[#969fb2]">此期限与上面的快照周期完全独立。</p></div><ShieldCheck size={18} className="text-[#43a486]" /></div>
            <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div><label htmlFor="retention" className="field-label">原始消息保留期限</label><div className="flex gap-2"><input id="retention" type="number" min="1" max="3650" value={retention} onChange={(e) => setRetention(e.target.value)} className="field" /><span className="flex shrink-0 items-center rounded-lg border border-[#e9ebf3] bg-[#fbfbfe] px-3 text-[11px] text-[#8f98ac]">天</span></div><p className="mt-1.5 text-[10px] leading-4 text-[#a0a8b8]">示例为保留 90 天，正式规则可再调整。</p></div>
              <div><label className="field-label">过期数据处理</label><div className="rounded-xl border border-[#eef0f6] bg-[#fbfbfe] px-3.5 py-3 text-[11px] text-[#7e89a1]"><div className="flex items-center gap-2 font-bold"><Clock3 size={14} className="text-[#8b82e9]" /> 定时清理原始记录</div><p className="mt-1.5 text-[10px] leading-4 text-[#a4acbd]">不会自动删除来源快照或长期记忆；真实清理任务尚未实现。</p></div></div>
            </div>
          </section>

          <section className="surface p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-[14px] font-extrabold text-[#3e4963]">自动归档开关</h2><p className="mt-1.5 text-[11px] leading-5 text-[#969fb2]">关闭后暂停创建新的自动快照，历史记录仍然保留。</p></div><button type="button" onClick={() => setAutoSnapshot((value) => !value)} aria-pressed={autoSnapshot} className={`relative h-7 w-[49px] rounded-full p-1 transition ${autoSnapshot ? "bg-[#786be5]" : "bg-[#d8dce7]"}`}><span className={`block h-5 w-5 rounded-full bg-white shadow-sm transition ${autoSnapshot ? "translate-x-[21px]" : "translate-x-0"}`} /></button></div>
            <div className="mt-5 rounded-xl border border-[#eff0f6] p-3.5"><div className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${autoSnapshot ? "bg-[#37b28b]" : "bg-[#abb2c0]"}`} /><span className="text-[11px] font-bold text-[#66718a]">{autoSnapshot ? "自动归档已开启" : "自动归档已暂停"}</span></div><p className="mt-1.5 pl-4 text-[10px] leading-5 text-[#9aa3b6]">{autoSnapshot ? "系统会按设置周期生成快照；任务调度接入后此开关才会控制真实任务。" : "不会创建新的自动快照，已有的记忆数据和历史档案不受影响。"}</p></div>
          </section>

          <div className="flex flex-wrap items-center justify-between gap-3"><button type="button" className="btn" onClick={resetSettings}><RotateCcw size={13} /> 恢复示例配置</button><button type="submit" className="btn btn-primary"><Save size={14} /> 保存设置</button></div>
        </form>

        <aside className="space-y-4">
          <section className="surface overflow-hidden">
            <div className="border-b border-[#edf0f6] px-4 py-4"><div className="flex items-center gap-2"><CalendarClock size={16} className="text-[#8074e6]" /><h2 className="text-[13px] font-extrabold text-[#3f4a65]">归档计划预览</h2></div><p className="mt-1.5 text-[10px] text-[#9aa3b6]">根据当前表单临时计算</p></div>
            <div className="p-4">
              <div className="rounded-[14px] bg-gradient-to-br from-[#f1efff] to-[#f3f8ff] p-4">
                <div className="text-[10px] font-semibold text-[#8177d9]">快照间隔</div><div className="mt-2 text-[29px] font-extrabold tracking-[-.06em] text-[#4c468c]">{intervalNumber}<span className="ml-1.5 text-[12px] font-bold">天</span></div>
                <div className="mt-2 text-[10px] leading-5 text-[#8d8ac1]">时区：{timezone}</div>
              </div>
              <div className="mt-4 space-y-3">
                <div><div className="text-[10px] text-[#9ca4b6]">周期起点</div><div className="mt-1.5 text-[11px] font-semibold text-[#68738c]">{anchor.replace("T", " ") || "未设置"}</div></div>
                <div><div className="text-[10px] text-[#9ca4b6]">原始消息期限</div><div className="mt-1.5 text-[11px] font-semibold text-[#68738c]">保留 {retention || "—"} 天</div></div>
                <div><div className="text-[10px] text-[#9ca4b6]">下一周期策略</div><div className="mt-1.5"><select className="field text-[10px]" value={effectivePolicy} onChange={(e) => setEffectivePolicy(e.target.value)}><option>下一个周期生效</option><option>立即重置周期（演示）</option></select></div></div>
              </div>
            </div>
          </section>
          <section className="rounded-[16px] border border-[#e8e7fa] bg-[#fbfaff] p-4"><div className="flex items-start gap-2.5"><div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-white text-[#8074e5] shadow-sm"><Sparkles size={15} /></div><div><div className="text-[11px] font-bold text-[#67619f]">设计原则</div><p className="mt-1.5 text-[10px] leading-5 text-[#9696b9]">快照留存、原始消息清理和长期记忆维护是不同的策略，不要因为一个周期到了就删除其他数据。</p></div></div></section>
        </aside>
      </div>

      {toast && <div role="status" className="fixed bottom-5 right-5 z-50 max-w-[360px] rounded-xl border border-[#e7e4ff] bg-white px-4 py-3 text-[12px] leading-5 text-[#6257be] shadow-xl">{toast}</div>}
    </div>
  );
}
