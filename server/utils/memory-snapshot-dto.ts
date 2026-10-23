export type MemorySnapshotDto = {
  id: string;
  number: number;
  version: number;
  date: string;
  range: string;
  summary: string;
  events: number;
  messages: number;
  status: "当前版本" | "已被替代";
  statusTone: "green" | "gray";
};

type SnapshotRecord = {
  id: string;
  snapshotKey: string;
  version: number;
  periodStart: Date;
  periodEnd: Date;
  summary: string;
  structuredContent: unknown;
  status: string;
  createdAt: Date;
  sources: Array<{ sourceType: string }>;
};

function formatDate(value: Date, timeZone: string, includeTime = false): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" as const } : {}),
  };
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-CA", options).formatToParts(value);
  } catch {
    parts = new Intl.DateTimeFormat("en-CA", { ...options, timeZone: "UTC" }).formatToParts(value);
  }
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const date = [values.year, values.month, values.day].join("-");
  return includeTime ? date + " " + values.hour + ":" + values.minute : date;
}

function readEventCount(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const record = value as Record<string, unknown>;
  if (typeof record.eventCount === "number" && Number.isFinite(record.eventCount)) {
    return Math.max(0, record.eventCount);
  }
  return Array.isArray(record.events) ? record.events.length : 0;
}

export function toMemorySnapshotDtos(
  records: SnapshotRecord[],
  timeZone = "Asia/Shanghai",
): MemorySnapshotDto[] {
  const chronological = [...records].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const sequenceByKey = new Map<string, number>();
  for (const record of chronological) {
    if (!sequenceByKey.has(record.snapshotKey)) {
      sequenceByKey.set(record.snapshotKey, sequenceByKey.size + 1);
    }
  }

  return [...records]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.version - a.version)
    .map((record) => {
      const current = record.status === "CURRENT";
      return {
        id: record.id,
        number: sequenceByKey.get(record.snapshotKey) ?? 1,
        version: record.version,
        date: formatDate(record.createdAt, timeZone, true),
        range: formatDate(record.periodStart, timeZone) + " — " + formatDate(record.periodEnd, timeZone),
        summary: record.summary,
        events: readEventCount(record.structuredContent),
        messages: record.sources.filter((source) => source.sourceType === "MESSAGE").length,
        status: current ? "当前版本" : "已被替代",
        statusTone: current ? "green" : "gray",
      };
    });
}
