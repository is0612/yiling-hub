import { createHash } from "node:crypto";

export const MEMORY_CATEGORIES = [
  "FACT",
  "PREFERENCE",
  "RELATIONSHIP",
  "COMMITMENT",
  "GOAL",
  "EVENT",
  "SUMMARY",
  "OTHER",
] as const;

export type MemoryCategoryValue = (typeof MEMORY_CATEGORIES)[number];
export type MemoryChangeAction = "ADD" | "UPDATE" | "INVALIDATE";

export type MemoryAiMessage = {
  id: string;
  role: string;
  eventType: string;
  occurredAt: string;
  content: string;
};

export type MemoryAiExistingItem = {
  id: string;
  category: MemoryCategoryValue;
  content: string;
  confidence: number | null;
  validFrom: string | null;
  validTo: string | null;
  createdAt: string;
};

export type MemoryChange = {
  action: MemoryChangeAction;
  category: MemoryCategoryValue;
  content: string;
  confidence: number;
  evidenceMessageIds: string[];
  relatedMemoryId?: string;
  changeReason?: string;
};

export type MemoryAiAnalysis = {
  summary: string;
  importantEvents: Array<{ title: string; detail: string; evidenceMessageIds: string[] }>;
  factAndPreferenceChanges: Array<{ description: string; changeType: string; evidenceMessageIds: string[] }>;
  relationshipChanges: Array<{ description: string; evidenceMessageIds: string[] }>;
  goalsAndCommitments: Array<{ description: string; status: string; evidenceMessageIds: string[] }>;
  unresolvedTopics: Array<{ description: string; evidenceMessageIds: string[] }>;
  differencesFromPrevious: string[];
  memoryChanges: MemoryChange[];
};

export type MemoryAiInput = {
  periodStart: string;
  periodEnd: string;
  timezone: string;
  scopeType: string;
  characterName: string;
  messages: MemoryAiMessage[];
  totalMessageCount: number;
  omittedMessageCount: number;
  activeMemories: MemoryAiExistingItem[];
  previousSnapshotSummary: string | null;
};

const MAX_RESPONSE_BYTES = 1_000_000;
const TEMPLATE_VERSION = "memory-extraction-v1";

function asText(value: unknown, maxLength = 2000): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function evidenceIds(value: unknown, validIds: Set<string>): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string =>
    typeof id === "string" && validIds.has(id),
  ))].slice(0, 10);
}

function evidenceList<T extends { evidenceMessageIds: string[] }>(
  value: unknown,
  validIds: Set<string>,
  mapper: (entry: Record<string, unknown>, ids: string[]) => T | null,
  max = 30,
): T[] {
  if (!Array.isArray(value)) return [];
  const result: T[] = [];
  for (const raw of value.slice(0, max)) {
    const entry = asRecord(raw);
    if (!entry) continue;
    const ids = evidenceIds(entry.evidenceMessageIds, validIds);
    if (ids.length === 0) continue;
    const mapped = mapper(entry, ids);
    if (mapped) result.push(mapped);
  }
  return result;
}

export function validateMemoryAiOutput(
  raw: unknown,
  validSourceMessageIds: Iterable<string>,
  existingMemoryIds: Iterable<string>,
): MemoryAiAnalysis {
  const root = asRecord(raw);
  if (!root) throw new Error("LLM_INVALID_JSON: 模型输出必须是 JSON 对象。");

  const validIds = new Set(validSourceMessageIds);
  const existingIds = new Set(existingMemoryIds);
  const summary = asText(root.summary, 8000);
  if (!summary) throw new Error("LLM_INVALID_RESPONSE: 模型没有返回有效的周期总结。");

  const importantEvents = evidenceList(root.importantEvents, validIds, (entry, ids) => {
    const title = asText(entry.title, 300);
    const detail = asText(entry.detail, 2000);
    return title && detail ? { title, detail, evidenceMessageIds: ids } : null;
  });

  const factAndPreferenceChanges = evidenceList(root.factAndPreferenceChanges, validIds, (entry, ids) => {
    const description = asText(entry.description, 2000);
    const changeType = asText(entry.changeType, 80) || "观察";
    return description ? { description, changeType, evidenceMessageIds: ids } : null;
  });

  const relationshipChanges = evidenceList(root.relationshipChanges, validIds, (entry, ids) => {
    const description = asText(entry.description, 2000);
    return description ? { description, evidenceMessageIds: ids } : null;
  });

  const goalsAndCommitments = evidenceList(root.goalsAndCommitments, validIds, (entry, ids) => {
    const description = asText(entry.description, 2000);
    const status = asText(entry.status, 80) || "未明确";
    return description ? { description, status, evidenceMessageIds: ids } : null;
  });

  const unresolvedTopics = evidenceList(root.unresolvedTopics, validIds, (entry, ids) => {
    const description = asText(entry.description, 2000);
    return description ? { description, evidenceMessageIds: ids } : null;
  });

  const differencesFromPrevious = Array.isArray(root.differencesFromPrevious)
    ? root.differencesFromPrevious
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().slice(0, 1000))
        .filter(Boolean)
        .slice(0, 30)
    : [];

  const memoryChanges: MemoryChange[] = [];
  if (Array.isArray(root.memoryChanges)) {
    for (const rawChange of root.memoryChanges.slice(0, 80)) {
      const entry = asRecord(rawChange);
      if (!entry) continue;
      const action = entry.action;
      const category = entry.category;
      const content = asText(entry.content, 2000);
      const confidence = entry.confidence;
      const ids = evidenceIds(entry.evidenceMessageIds, validIds);
      if (
        (action !== "ADD" && action !== "UPDATE" && action !== "INVALIDATE") ||
        typeof category !== "string" ||
        !(MEMORY_CATEGORIES as readonly string[]).includes(category) ||
        !content ||
        typeof confidence !== "number" ||
        !Number.isFinite(confidence) ||
        confidence < 0 ||
        confidence > 1 ||
        ids.length === 0
      ) continue;

      const relatedMemoryId = asText(entry.relatedMemoryId, 100);
      if ((action === "UPDATE" || action === "INVALIDATE") && !existingIds.has(relatedMemoryId)) continue;
      memoryChanges.push({
        action,
        category: category as MemoryCategoryValue,
        content,
        confidence,
        evidenceMessageIds: ids,
        ...(action !== "ADD" ? { relatedMemoryId } : {}),
        ...(asText(entry.changeReason, 500) ? { changeReason: asText(entry.changeReason, 500) } : {}),
      });
    }
  }

  return {
    summary,
    importantEvents,
    factAndPreferenceChanges,
    relationshipChanges,
    goalsAndCommitments,
    unresolvedTopics,
    differencesFromPrevious,
    memoryChanges,
  };
}

function systemPrompt(): string {
  return [
    "你是严格的长期记忆提炼器，不是角色扮演者。",
    "仅根据输入的原始消息和现有记忆提炼事实。绝不补造未出现的细节；区分用户明确陈述、助手建议和不确定推断。",
    "只把对后续互动有长期价值的个人事实、稳定偏好、关系、目标、承诺写入 memoryChanges；一次性闲聊不要写成长记忆。",
    "偏好或事实发生变化时，优先 UPDATE 已提供的相关 active memory；明确不再成立时使用 INVALIDATE；确实新增时使用 ADD。",
    "UPDATE/INVALIDATE 的 relatedMemoryId 必须来自输入的 activeMemories。每条 memoryChanges 必须至少引用一个输入中的 evidenceMessageIds，且来源必须真正支持该结论。",
    "只输出 JSON，不要 Markdown 代码围栏。所有列表字段必须存在，即使为空。",
    "JSON 格式：",
    JSON.stringify({
      summary: "周期摘要",
      importantEvents: [{ title: "事件标题", detail: "客观事件", evidenceMessageIds: ["原始消息ID"] }],
      factAndPreferenceChanges: [{ description: "事实/偏好变化", changeType: "新增|更新|失效|确认", evidenceMessageIds: ["原始消息ID"] }],
      relationshipChanges: [{ description: "关系变化", evidenceMessageIds: ["原始消息ID"] }],
      goalsAndCommitments: [{ description: "目标或承诺", status: "进行中|已完成|取消|未明确", evidenceMessageIds: ["原始消息ID"] }],
      unresolvedTopics: [{ description: "未解决话题", evidenceMessageIds: ["原始消息ID"] }],
      differencesFromPrevious: ["相较上一快照的变化"],
      memoryChanges: [{
        action: "ADD|UPDATE|INVALIDATE",
        category: "FACT|PREFERENCE|RELATIONSHIP|COMMITMENT|GOAL|EVENT|SUMMARY|OTHER",
        content: "简明、可独立理解的记忆",
        confidence: 0.0,
        evidenceMessageIds: ["原始消息ID"],
        relatedMemoryId: "UPDATE/INVALIDATE 必填，ADD 省略",
        changeReason: "变化依据"
      }]
    }, null, 2),
    "注意：JSON 示例中的原始消息ID只是占位符。只能返回输入中真实出现的 ID。",
  ].join("\n");
}

export function isMemoryModelConfigured(): boolean {
  return Boolean(process.env.LLM_API_KEY?.trim() && process.env.LLM_MODEL?.trim());
}

export async function analyzeMemoryPeriod(input: MemoryAiInput): Promise<{
  analysis: MemoryAiAnalysis;
  model: string;
  provider: string;
  promptTemplateVersion: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}> {
  const apiKey = process.env.LLM_API_KEY?.trim();
  const model = process.env.LLM_MODEL?.trim();
  if (!apiKey || !model) {
    throw new Error("LLM_NOT_CONFIGURED: 请在服务端 .env 配置 LLM_API_KEY 和 LLM_MODEL；任务会保留在队列中等待配置。");
  }

  const baseUrl = (process.env.LLM_BASE_URL?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "");
  let endpoint: URL;
  try {
    endpoint = new URL(baseUrl + "/chat/completions");
    if (endpoint.protocol !== "https:" && endpoint.hostname !== "localhost" && endpoint.hostname !== "127.0.0.1") {
      throw new Error("模型 API 必须使用 HTTPS（本机 localhost 除外）。");
    }
  } catch (error) {
    throw new Error("LLM_INVALID_BASE_URL: " + (error instanceof Error ? error.message : String(error)));
  }

  const timeoutRaw = Number(process.env.LLM_TIMEOUT_MS ?? 60_000);
  const timeoutMs = Number.isInteger(timeoutRaw) && timeoutRaw >= 5_000 && timeoutRaw <= 180_000
    ? timeoutRaw
    : 60_000;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: "Bearer " + apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt() },
        { role: "user", content: JSON.stringify(input) },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const responseText = await response.text();
  if (Buffer.byteLength(responseText, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("LLM_RESPONSE_TOO_LARGE: 模型响应超过大小限制。");
  }
  if (!response.ok) {
    const safeDetail = responseText.replace(/\s+/g, " ").slice(0, 600);
    throw new Error("LLM_HTTP_ERROR: 模型服务返回 HTTP " + response.status + "：" + safeDetail);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(responseText) as Record<string, unknown>;
  } catch {
    throw new Error("LLM_INVALID_ENVELOPE: 模型服务没有返回有效 JSON。");
  }
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const firstChoice = asRecord(choices[0]);
  const message = asRecord(firstChoice?.message);
  const content = message?.content;
  let parsed: unknown;
  try {
    if (typeof content !== "string") throw new Error("content is not a string");
    const cleaned = content.trim().replace(/^\x60{3}(?:json)?\s*/i, "").replace(/\s*\x60{3}$/, "");
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("LLM_INVALID_JSON: 模型输出不是有效 JSON。");
  }

  const sourceIds = input.messages.map((message) => message.id);
  const existingIds = input.activeMemories.map((memory) => memory.id);
  const analysis = validateMemoryAiOutput(parsed, sourceIds, existingIds);
  const usageRecord = asRecord(payload.usage);
  const numberField = (key: string) => {
    const value = usageRecord?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };

  return {
    analysis,
    model,
    provider: endpoint.origin,
    promptTemplateVersion: TEMPLATE_VERSION,
    ...(usageRecord ? {
      usage: {
        ...(numberField("prompt_tokens") !== undefined ? { promptTokens: numberField("prompt_tokens") } : {}),
        ...(numberField("completion_tokens") !== undefined ? { completionTokens: numberField("completion_tokens") } : {}),
        ...(numberField("total_tokens") !== undefined ? { totalTokens: numberField("total_tokens") } : {}),
      },
    } : {}),
  };
}

export function makeMemoryDedupeKey(category: MemoryCategoryValue, content: string): string {
  const normalized = content.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, " ").trim();
  return "ai:" + createHash("sha256").update(category + ":" + normalized).digest("hex").slice(0, 48);
}
