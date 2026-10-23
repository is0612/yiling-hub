"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  Bell,
  BrainCircuit,
  Cable,
  ChevronDown,
  CircleHelp,
  Command,
  FileClock,
  LayoutDashboard,
  Search,
  Settings2,
  Sparkles,
  UsersRound,
} from "lucide-react";
import type { ReactNode } from "react";

const navigation = [
  { label: "总览", href: "/", icon: LayoutDashboard, section: "工作空间" },
  { label: "角色管理", href: "/characters", icon: UsersRound },
  { label: "记忆驾驶舱", href: "/characters/big-fish", icon: BrainCircuit },
  { label: "周期快照", href: "/characters/big-fish/snapshots", icon: FileClock },
  { label: "渠道管理", href: "/channels", icon: Cable, section: "系统管理" },
  { label: "任务监控", href: "/tasks", icon: Activity },
  { label: "系统设置", href: "/settings", icon: Settings2 },
];

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    if (href === "/characters") return pathname === "/characters";
    if (href === "/characters/big-fish") {
      return pathname === href || pathname.startsWith("/characters/") && !pathname.includes("/snapshots") && !pathname.includes("/settings/");
    }
    if (href === "/characters/big-fish/snapshots") return pathname.includes("/snapshots");
    if (href === "/channels") return pathname.startsWith("/channels");
    if (href === "/tasks") return pathname.startsWith("/tasks");
    if (href === "/settings") return pathname.startsWith("/settings");
    return pathname.startsWith(href);
  };

  return (
    <div className="app-grid">
      <aside className="sidebar">
        <div className="sidebar-top">
          <Link href="/" className="flex items-center gap-3 px-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-[14px] bg-gradient-to-br from-[#887cf4] to-[#6558dc] text-white shadow-[0_6px_14px_rgba(113,100,232,.26)]">
              <BrainCircuit size={21} strokeWidth={2.1} />
            </div>
            <div className="brand-wordmark leading-tight">
              <div className="text-[15px] font-extrabold tracking-[-.05em] text-[#29324b]">羚枢 <span className="font-medium tracking-normal text-[#9ca3b5]">Yiling</span></div>
              <div className="mt-1 text-[10px] tracking-[.12em] text-[#9ba3b5]">AI CHARACTER HUB</div>
            </div>
          </Link>
          <div className="mt-7 rounded-[12px] border border-[#edeffc] bg-[#fafaff] p-2.5">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-white text-[#7568e8] shadow-sm">
                <Sparkles size={16} />
              </div>
              <div className="sidebar-label min-w-0 flex-1">
                <div className="truncate text-[11px] font-bold text-[#59627b]">个人工作空间</div>
                <div className="mt-0.5 text-[10px] text-[#9ba3b5]">本地演示环境</div>
              </div>
              <ChevronDown size={13} className="sidebar-label text-[#a0a8b8]" />
            </div>
          </div>
        </div>

        <nav className="sidebar-nav mt-7 flex flex-1 flex-col gap-1">
          {navigation.map((item) => {
            const Icon = item.icon;
            const active = isActive(item.href);
            return (
              <div key={item.href}>
                {item.section && (
                  <div className="sidebar-section-label mb-2 mt-2 px-3 text-[10px] font-bold tracking-[.12em] text-[#a1a8b9]">
                    {item.section}
                  </div>
                )}
                <Link
                  href={item.href}
                  className={`sidebar-nav-link group relative flex h-10 items-center gap-3 rounded-[10px] px-3 text-[12px] font-semibold transition-all ${active ? "bg-[#f0eeff] text-[#695cdd]" : "text-[#78839b] hover:bg-[#f8f8fd] hover:text-[#434e69]"}`}
                >
                  {active && <span className="absolute bottom-2 left-0 top-2 w-[3px] rounded-r-full bg-[#7568e8]" />}
                  <Icon size={17} strokeWidth={active ? 2.2 : 1.8} className={active ? "text-[#7568e8]" : "text-[#99a2b6] group-hover:text-[#7568e8]"} />
                  <span className="sidebar-label">{item.label}</span>
                  {item.href === "/tasks" && (
                    <span className="sidebar-label ml-auto rounded-full bg-[#fff1df] px-1.5 py-0.5 text-[9px] font-bold text-[#b47d29]">2</span>
                  )}
                </Link>
              </div>
            );
          })}
        </nav>

        <div className="sidebar-bottom mt-5 border-t border-[#eef0f6] pt-4">
          <div className="flex items-center gap-3 rounded-xl p-2.5">
            <div className="avatar avatar-round h-9 w-9 text-[12px]">你</div>
            <div className="sidebar-bottom-copy min-w-0 flex-1">
              <div className="truncate text-[12px] font-bold text-[#4d5872]">本地管理员</div>
              <div className="mt-1 text-[10px] text-[#9ba3b5]">开发预览</div>
            </div>
            <button className="icon-btn h-7 w-7" aria-label="打开帮助" title="帮助">
              <CircleHelp size={15} />
            </button>
          </div>
          <div className="mt-3 flex items-center justify-between px-3 text-[9px] text-[#abb2c1]">
            <span>Yiling Hub · 预览版</span>
            <span>v0.1</span>
          </div>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div className="topbar-search flex w-full max-w-[440px] items-center gap-2.5 rounded-[11px] border border-[#ebedf5] bg-[#fbfbfe] px-3.5">
            <Search size={15} className="shrink-0 text-[#a0a8bb]" />
            <input
              className="h-10 min-w-0 flex-1 bg-transparent text-[12px] text-[#43506b] outline-none placeholder:text-[#a5adbd]"
              aria-label="搜索"
              placeholder="搜索角色、记忆、快照……"
              onKeyDown={(event) => {
                if (event.key === "Enter") window.location.href = "/characters";
              }}
            />
            <span className="flex items-center gap-1 rounded-md border border-[#e9ebf3] bg-white px-1.5 py-1 text-[9px] font-semibold text-[#a1a8b8]">
              <Command size={10} /> K
            </span>
          </div>
          <div className="flex items-center gap-3 sm:gap-4">
            <span className="hidden items-center gap-1.5 rounded-full border border-[#eeeefa] bg-white px-2.5 py-1.5 text-[10px] font-semibold text-[#7b859c] md:flex">
              <span className="h-1.5 w-1.5 rounded-full bg-[#32b88a]" /> 本地环境
            </span>
            <button className="icon-btn relative" aria-label="通知" title="通知">
              <Bell size={17} />
              <span className="absolute right-[7px] top-[7px] h-1.5 w-1.5 rounded-full border border-white bg-[#ef9c73]" />
            </button>
            <div className="hidden h-7 w-px bg-[#eceef5] sm:block" />
            <button className="flex items-center gap-2 rounded-xl py-1 pl-1 pr-1.5 hover:bg-white">
              <div className="avatar avatar-round h-8 w-8 text-[11px]">你</div>
              <span className="hidden text-[11px] font-semibold text-[#59647c] sm:block">管理员</span>
              <ChevronDown size={13} className="hidden text-[#9ca4b5] sm:block" />
            </button>
          </div>
        </header>
        <main>{children}</main>
      </div>
    </div>
  );
}
