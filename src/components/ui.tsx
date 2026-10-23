import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight, CircleHelp } from "lucide-react";

type Tone = "green" | "purple" | "blue" | "amber" | "rose" | "gray";

const toneClass: Record<Tone, string> = {
  green: "badge-green",
  purple: "badge-purple",
  blue: "badge-blue",
  amber: "badge-amber",
  rose: "badge-rose",
  gray: "badge-gray",
};

export function Badge({
  children,
  tone = "gray",
  dot = false,
}: {
  children: ReactNode;
  tone?: Tone;
  dot?: boolean;
}) {
  return (
    <span className={`badge ${toneClass[tone]}`}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />}
      {children}
    </span>
  );
}

export function DemoLabel({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border border-[#edeafb] bg-[#f6f4ff] px-2.5 py-1.5 text-[10px] font-semibold text-[#786be1] ${className}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-[#8b7df0]" />
      演示数据
    </span>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-7 flex flex-col justify-between gap-4 md:flex-row md:items-end">
      <div className="min-w-0">
        {eyebrow && <div className="eyebrow mb-2.5">{eyebrow}</div>}
        <h1 className="page-title">{title}</h1>
        {description && <p className="page-subtitle max-w-2xl">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function SectionTitle({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <h2 className="text-[14px] font-bold tracking-[-.02em] text-[#36415c]">{title}</h2>
        {description && <p className="mt-1.5 text-[11px] leading-5 text-[#949db0]">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function StatCard({
  label,
  value,
  note,
  icon,
  tone = "purple",
}: {
  label: string;
  value: string;
  note: string;
  icon: ReactNode;
  tone?: "purple" | "blue" | "green" | "amber";
}) {
  const colors = {
    purple: "bg-[#f0eeff] text-[#786be4]",
    blue: "bg-[#edf5ff] text-[#6894df]",
    green: "bg-[#e9f8f1] text-[#38a383]",
    amber: "bg-[#fff4e3] text-[#d3a04f]",
  };
  return (
    <div className="surface surface-hover p-4 sm:p-5">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[11px] font-semibold text-[#8a94aa]">{label}</div>
        <div className={`flex h-9 w-9 items-center justify-center rounded-[12px] ${colors[tone]}`}>{icon}</div>
      </div>
      <div className="mt-4 flex items-end justify-between gap-2">
        <span className="text-[27px] font-extrabold leading-none tracking-[-.055em] text-[#303a55]">{value}</span>
        <span className="text-right text-[10px] leading-4 text-[#98a1b4]">{note}</span>
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-[#f3f1ff] text-[#786be4]">
        <CircleHelp size={20} />
      </div>
      <h3 className="mt-4 text-[13px] font-bold text-[#46516b]">{title}</h3>
      <p className="mt-2 max-w-sm text-[11px] leading-5 text-[#97a0b2]">{description}</p>
    </div>
  );
}

export function ViewAllLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#786be4] transition hover:text-[#5c4ed6]">
      {children} <ArrowUpRight size={13} />
    </a>
  );
}
