"use client";

import { useState, type FormEvent } from "react";
import { Check, Database, HardDrive, KeyRound, RefreshCw, Save, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { DemoLabel, PageHeader, SectionTitle } from "@/components/ui";

export default function SystemSettingsPage() {
  const [timezone, setTimezone] = useState("Asia/Shanghai");
  const [retention, setRetention] = useState("90");
  const [defaultInterval, setDefaultInterval] = useState("8");
  const [toast, setToast] = useState("");

  function notify(message: string) { setToast(message); window.setTimeout(() => setToast(""), 4000); }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    notify("系统默认值已保存到页面演示状态；当前没有真实系统配置 API。");
  }

  return (
    <div className="page-wrap">
      <PageHeader eyebrow="系统管理 / 系统设置" title="系统设置" description="管理平台默认行为和本地开发提示。与角色单独覆盖的设置相互独立。" actions={<DemoLabel />} />
      <form onSubmit={save} className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="space-y-5">
          <section className="surface p-5 sm:p-6"><div className="flex items-start justify-between gap-3"><SectionTitle title="记忆默认值" description="新建角色时继承的初始设置" /><SlidersHorizontal size={17} className="text-[#8277e6]" /></div><div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2"><div><label className="field-label" htmlFor="default-interval">默认快照周期</label><div className="flex gap-2"><input id="default-interval" className="field" type="number" min="1" max="365" value={defaultInterval} onChange={(e) => setDefaultInterval(e.target.value)} /><span className="flex shrink-0 items-center rounded-lg border border-[#e9ebf3] bg-[#fbfbfe] px-3 text-[11px] text-[#8f98ac]">天</span></div><p className="mt-1.5 text-[10px] text-[#a0a8b8]">默认每 8 天生成一份快照。</p></div><div><label className="field-label" htmlFor="default-timezone">默认时区</label><select id="default-timezone" className="field" value={timezone} onChange={(e) => setTimezone(e.target.value)}><option value="Asia/Shanghai">Asia/Shanghai</option><option value="America/Los_Angeles">America/Los_Angeles</option><option value="UTC">UTC</option><option value="Asia/Tokyo">Asia/Tokyo</option></select><p className="mt-1.5 text-[10px] text-[#a0a8b8]">新角色可以在自己的记忆设置中覆盖。</p></div><div><label className="field-label" htmlFor="default-retention">默认原始消息保留期限</label><div className="flex gap-2"><input id="default-retention" className="field" type="number" min="1" max="3650" value={retention} onChange={(e) => setRetention(e.target.value)} /><span className="flex shrink-0 items-center rounded-lg border border-[#e9ebf3] bg-[#fbfbfe] px-3 text-[11px] text-[#8f98ac]">天</span></div><p className="mt-1.5 text-[10px] text-[#a0a8b8]">这不是快照保存期限。</p></div></div><div className="mt-5 flex items-center justify-end"><button className="btn btn-primary" type="submit"><Save size={14} /> 保存默认设置</button></div></section>
          <section className="surface p-5 sm:p-6"><SectionTitle title="运行环境" description="当前仓库所处的开发阶段" /><div className="mt-4 divide-y divide-[#eef0f6]">{[{icon:Database,title:"本地数据库",desc:"PostgreSQL · 通过 Docker Compose 运行",tone:"bg-[#f0eeff] text-[#7769e4]"},{icon:HardDrive,title:"数据备份",desc:"计划使用 pg_dump / pg_restore 迁移",tone:"bg-[#edf5ff] text-[#5a8ad0]"},{icon:KeyRound,title:"管理员认证",desc:"接口契约已定义，登录实现尚未开发",tone:"bg-[#e9f8f1] text-[#34a17b]"}].map((item)=>{const Icon=item.icon;return <div key={item.title} className="flex items-center gap-3 py-3.5"><div className={`flex h-9 w-9 items-center justify-center rounded-[11px] ${item.tone}`}><Icon size={16} /></div><div className="min-w-0 flex-1"><div className="text-[11px] font-bold text-[#58647e]">{item.title}</div><div className="mt-1 text-[10px] text-[#9aa3b5]">{item.desc}</div></div><span className="rounded-full bg-[#f5f6fa] px-2 py-1 text-[9px] font-bold text-[#969fb1]">规划中</span></div>})}</div></section>
        </div>
        <aside className="space-y-4"><section className="surface p-5"><div className="flex items-center gap-2"><ShieldCheck size={17} className="text-[#43a486]" /><h2 className="text-[13px] font-extrabold text-[#3e4963]">安全提示</h2></div><div className="mt-4 space-y-3 text-[10px] leading-5 text-[#8994aa]"><p>真实 API 密钥、数据库密码和会话密钥只放在服务端环境变量中。</p><p>不要将真实的 .env 文件或包含角色记忆的数据库备份提交到 Git。</p><p>对外公开后台之前，必须完成登录、服务端鉴权与数据范围校验。</p></div></section><section className="rounded-[16px] border border-[#e8e7fa] bg-[#fbfaff] p-4"><div className="flex items-center gap-2 text-[#7769e2]"><RefreshCw size={14} /><span className="text-[11px] font-bold">后续扩展</span></div><p className="mt-2 text-[10px] leading-5 text-[#9696b9]">模型供应商、向量检索和队列系统先不在此页配置。等对应能力实现后，再增加有效的设置项。</p></section></aside>
      </form>
      {toast && <div role="status" className="fixed bottom-5 right-5 z-50 max-w-[360px] rounded-xl border border-[#e7e4ff] bg-white px-4 py-3 text-[12px] leading-5 text-[#6257be] shadow-xl">{toast}</div>}
    </div>
  );
}
