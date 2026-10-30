import { buildChatCompletionsEndpoint, isChatModelConfigured } from "./chat-model-config";
import { readModelUsage, type ModelUsageTokens } from "./model-usage";
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
  /** 这条消息来自哪种对话（`QQ群 12345678` / `私聊` / `本地对话`）。老数据没有这个字段。 */
  origin?: string;
  /** 这条是主人发的。主人私聊必真；群聊里主人发言也标出来，让提炼时认得主人。 */
  isOwner?: boolean;
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
  apiKey: string;
  apiBaseUrl: string;
  model: string;
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
const TEMPLATE_VERSION = "memory-extraction-v2";

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
  if (!summary) throw new Error("LLM_INVALID_RESPONSE: 模型没有返回有效的阶段总结。");

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
    "同一周期可能同时包含私聊与群聊，每条消息的 origin 标明来源（例如「QQ群 12345678」「私聊」）。群聊里只有与她本人相关的内容才写成长期记忆：她说过的话、答应过的事、有人点名找她、她参与过的群内话题、群里的人怎么称呼她、她跟谁熟。",
    "群友之间与她无关的闲聊只概括进 summary，不要写成她的记忆；群友的隐私（病情、住址、感情、财务、工作内幕）一律不写入 memoryChanges。需要区分场合时在记忆内容里带上群号，不要凭昵称推断同一个人在不同群或私聊里的身份。",
    "标了 isOwner 的消息是主人说的。主人与她相关的发言要优先记住，并在关系记忆里体现「主人」这个身份；群聊里也要把主人的话和群友的话分开，不要把主人的话记成「某个群友说的」。",
    "当你判断某个对话对象值得她长期记住时，写一条 category=RELATIONSHIP 的记忆，内容包含对方称呼、来源（哪个群或私聊）和这段关系的要点；不要为记不住的泛泛之交写关系记忆。",
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
      differencesFromPrevious: ["相较上一份总结的变化"],
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

export function isMemoryModelConfigured(configValue?: unknown): boolean {
  return isChatModelConfigured(configValue);
}

export async function analyzeMemoryPeriod(input: MemoryAiInput): Promise<{
  analysis: MemoryAiAnalysis;
  model: string;
  provider: string;
  promptTemplateVersion: string;
  usage?: ModelUsageTokens;
}> {
  // Credentials must be resolved by the caller for the selected provider. Never silently
  // substitute the global environment key for a request targeting another provider.
  const apiKey = input.apiKey.trim();
  const model = input.model.trim();
  const baseUrl = input.apiBaseUrl.trim();
  if (!apiKey || !model || !baseUrl) {
    throw new Error("LLM_NOT_CONFIGURED: 当前模型请求缺少已解析的 API Key、API Base URL 或模型名称；请检查角色模型配置和服务端默认配置。");
  }
  let endpoint: URL;
  try {
    endpoint = buildChatCompletionsEndpoint(baseUrl);
  } catch (error) {
    throw new Error("LLM_INVALID_BASE_URL: " + (error instanceof Error ? error.message : String(error)));
  }

  const timeoutRaw = Number(process.env.LLM_TIMEOUT_MS ?? 60_000);
  const timeoutMs = Number.isInteger(timeoutRaw) && timeoutRaw >= 5_000 && timeoutRaw <= 180_000
    ? timeoutRaw
    : 60_000;
  // Keep connection settings out of the user prompt. Project fields explicitly so
  // extra runtime properties on nested objects cannot accidentally be serialized.
  const promptInput = {
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    timezone: input.timezone,
    scopeType: input.scopeType,
    characterName: input.characterName,
    messages: input.messages.map(({ id, role, eventType, occurredAt, content, origin, isOwner }) => ({
      id, role, eventType, occurredAt, content, ...(origin ? { origin } : {}), ...(isOwner ? { isOwner } : {}),
    })),
    totalMessageCount: input.totalMessageCount,
    omittedMessageCount: input.omittedMessageCount,
    activeMemories: input.activeMemories.map(({
      id, category, content, confidence, validFrom, validTo, createdAt,
    }) => ({ id, category, content, confidence, validFrom, validTo, createdAt })),
    previousSnapshotSummary: input.previousSnapshotSummary,
  };

  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    headers: {
      authorization: "Bearer " + apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 6000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt() },
        { role: "user", content: JSON.stringify(promptInput) },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const responseText = await response.text();
  if (Buffer.byteLength(responseText, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("LLM_RESPONSE_TOO_LARGE: 模型响应超过大小限制。");
  }
  if (!response.ok) {
    // Provider error bodies may echo request fragments. Keep raw response text out of task logs.
    throw new Error("LLM_HTTP_ERROR: 模型服务返回 HTTP " + response.status + "。请检查服务端模型配置和供应商控制台。");
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
  // 用量统一走 model-usage 的解析，才能带上缓存命中明细（命中价只有未命中价的几十分之一）。
  const usage = readModelUsage(payload);

  return {
    analysis,
    model,
    provider: endpoint.origin,
    promptTemplateVersion: TEMPLATE_VERSION,
    ...(usage ? { usage } : {}),
  };
}

export function makeMemoryDedupeKey(category: MemoryCategoryValue, content: string): string {
  const normalized = content.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, " ").trim();
  return "ai:" + createHash("sha256").update(category + ":" + normalized).digest("hex").slice(0, 48);
}
