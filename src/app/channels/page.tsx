"use client";

import { useState } from "react";
import { ArrowUpRight, Cable, CheckCircle2, CircleDashed, ExternalLink, Info, Link2, MessageCircle, Radio, ShieldCheck, Tv2, Unplug, Wifi, X } from "lucide-react";
import { Badge, DemoLabel, PageHeader, SectionTitle, StatCard } from "@/components/ui";

const initialChannels = [
  { id: "bilibili", name: "哔哩哔哩", short: "B", kind: "内容与活动渠道", description: "接收授权范围内的内容摘要、视频事件与互动数据。", tone: "bg-[#fff0f2] text-[#df6682]", state: "占位待接入", stateTone: "amber" as const, features: ["内容摘要", "事件记录", "按来源追溯"], detail: "后续通过独立 Adapter 接入现有内容处理程序。" },
  { id: "qq", name: "QQ", short: "Q", kind: "即时消息渠道", description: "接收私聊消息、检索角色记忆并将回复发回。", tone: "bg-[#eef5ff] text-[#4c8bd5]", state: "占位待接入", stateTone: "amber" as const, features: ["私聊消息", "记忆检索", "回复发送"], detail: "需先确定支持的接入程序、协议与账号类型。" },
  { id: "wechat", name: "微信", short: "微", kind: "即时消息渠道", description: "为后续消息接入预留连接入口和状态展示。", tone: "bg-[#eaf8f0] text-[#34a36f]", state: "未配置", stateTone: "gray" as const, features: ["消息事件", "身份关联", "状态监控"], detail: "实际接入方式必须遵守平台允许的接口与授权规则。" },
  { id: "webhook", name: "自定义 Webhook", short: "↗", kind: "通用事件渠道", description: "为未来其他内容源和自建程序提供标准化入口。", tone: "bg-[#f1efff] text-[#7668e5]", state: "未配置", stateTone: "gray" as const, features: ["标准事件", "接口密钥", "来源去重"], detail: "只有在需要接入新的外部系统时才启用。" },
];

export default function ChannelsPage() {
  const [channels, setChannels] = useState(initialChannels);
  const [toast, setToast] = useState("");
  function notify(text: string) { setToast(text); window.setTimeout(() => setToast(""), 4000); }

  return (
    <div className="page-wrap">
      <PageHeader eyebrow="系统管理 / 渠道管理" title="连接你的角色世界" description="渠道负责接入外部平台；角色与记忆逻辑保持独立，不会因为新增平台而重写核心系统。" actions={<><DemoLabel /><button className="btn btn-primary" onClick={() => notify("连接向导将在真实渠道适配器实现后开放。")}><Cable size={14} /> 添加连接</button></>} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard label="渠道类型" value="04" note="包含一个通用入口" icon={<Cable size={17} />} tone="purple" />
        <StatCard label="已连接" value="00" note="真实连接尚未配置" icon={<Wifi size={17} />} tone="green" />
        <StatCard label="待接入" value="03" note="按阶段逐一验证" icon={<CircleDashed size={17} />} tone="amber" />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        {channels.map((channel) => (
          <article key={channel.id} className="surface surface-hover p-5 sm:p-6">
            <div className="flex items-start gap-3.5">
              <div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-[15px] text-[19px] font-extrabold ${channel.tone}`}>{channel.short}</div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2"><h2 className="text-[14px] font-extrabold text-[#3d4963]">{channel.name}</h2><Badge tone={channel.stateTone} dot>{channel.state}</Badge></div>
                <p className="mt-1.5 text-[10px] text-[#9ba3b5]">{channel.kind}</p>
              </div>
              <button className="icon-btn h-8 w-8" title="查看接入说明" onClick={() => notify(channel.detail)}><ExternalLink size={14} /></button>
            </div>
            <p className="mt-5 min-h-[42px] text-[11px] leading-5 text-[#7f8aa2]">{channel.description}</p>
            <div className="mt-4 flex flex-wrap gap-1.5">{channel.features.map((feature) => <Badge key={feature} tone="gray">{feature}</Badge>)}</div>
            <div className="mt-5 flex items-center gap-2 rounded-xl border border-[#eff1f6] bg-[#fbfbfe] p-3">
              <Info size={14} className="shrink-0 text-[#8b82e7]" />
              <span className="text-[10px] leading-5 text-[#939db1]">{channel.detail}</span>
            </div>
            <div className="mt-4 flex items-center justify-between gap-2">
              <span className="text-[10px] text-[#a2aabb]">绑定角色：暂无真实绑定</span>
              <button className="btn btn-sm" onClick={() => notify(`${channel.name} 当前仅为界面占位，未创建真实连接。`)}><Link2 size={12} /> 配置接入</button>
            </div>
          </article>
        ))}
      </div>

      <section className="surface mt-5 p-5 sm:p-6">
        <SectionTitle title="接入原则" description="让渠道负责转换消息，让核心服务负责记忆和角色行为。" />
        <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-3">
          <div className="rounded-xl bg-[#fafaff] p-4"><div className="flex h-9 w-9 items-center justify-center rounded-[11px] bg-[#f0eeff] text-[#7769e3]"><Radio size={16} /></div><h3 className="mt-3 text-[11px] font-bold text-[#56617b]">统一事件格式</h3><p className="mt-1.5 text-[10px] leading-5 text-[#98a1b4]">不同渠道消息先转换成统一结构，再进入记忆服务。</p></div>
          <div className="rounded-xl bg-[#fafaff] p-4"><div className="flex h-9 w-9 items-center justify-center rounded-[11px] bg-[#eaf8f0] text-[#36a17b]"><ShieldCheck size={16} /></div><h3 className="mt-3 text-[11px] font-bold text-[#56617b]">凭据与授权</h3><p className="mt-1.5 text-[10px] leading-5 text-[#98a1b4]">平台权限、连接凭据与用户身份都需要显式管理。</p></div>
          <div className="rounded-xl bg-[#fafaff] p-4"><div className="flex h-9 w-9 items-center justify-center rounded-[11px] bg-[#edf5ff] text-[#5d8ace]"><CheckCircle2 size={16} /></div><h3 className="mt-3 text-[11px] font-bold text-[#56617b]">逐个渠道验收</h3><p className="mt-1.5 text-[10px] leading-5 text-[#98a1b4]">先跑通一个真实渠道，再复用相同的角色和记忆能力。</p></div>
        </div>
      </section>

      {toast && <div role="status" className="fixed bottom-5 right-5 z-50 max-w-[360px] rounded-xl border border-[#e7e4ff] bg-white px-4 py-3 text-[12px] leading-5 text-[#6257be] shadow-xl">{toast}</div>}
    </div>
  );
}
