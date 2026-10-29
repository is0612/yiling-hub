/**
 * QQ 群聊的短期上下文与「话题参与」状态。
 *
 * 这里只放**不落库、有界、可过期**的东西：
 *   - 最近几分钟的群聊，给模型当背景（被闸门丢掉的消息也从这里进）；
 *   - QQ → 成员代号的映射，保证入模时不出现真实账号；
 *   - 她实际参与过的话题，用来判断「这轮是不是接着刚才那个话题」。
 *
 * 全部按「连接内的绑定 + 群会话」隔离；连接由调用方保证（一个 handler 一个实例）。
 * 纯内存：进程重启后她变回「没参与过任何话题」，这是可接受的降级。
 */

export type GroupMentionTarget = "self" | "other" | "all";

/** 一条群消息里与判定有关的事实。正文保持原样，@ 的代号化在 formatText 里做。 */
export type GroupMessageFacts = {
  messageId: string;
  /** 收到时刻（ms）。 */
  at: number;
  senderQq: string;
  displayName: string;
  text: string;
  mentionTargets: GroupMentionTarget[];
  replyToMessageId: string;
};

export type GroupBackgroundLine = {
  id: string;
  at: number;
  /** 成员代号，如 member_2；她自己是 self。 */
  member: string;
  speaker: string;
  text: string;
};

export type GroupTopicAnchor = { id: string; label: string };

export type GroupRelation = "direct" | "followup" | "shared_topic" | "ambient" | "unrelated";

export type GroupDecision = {
  relation: GroupRelation;
  topicAnchorMessageId?: string;
  evidenceMessageIds: string[];
};

type StoredMessage = GroupMessageFacts;

type Topic = {
  anchorMessageId: string;
  participants: string[];
  triggerMessageId: string;
  lastEvidenceAt: number;
  createdAt: number;
  expiresAt: number;
  source: "mention" | "ambient";
};

type ConversationState = {
  messages: StoredMessage[];
  topics: Topic[];
  memberCodes: Map<string, string>;
  nextMember: number;
};

export type GroupContextOptions = {
  /** 这个小号自己的 QQ；@ 她会被写成 @self。 */
  selfQq?: string;
  now?: () => number;
  /** 背景只保留最近这么久。 */
  windowMs?: number;
  maxMessages?: number;
  maxChars?: number;
  /** 单条正文进提示词前的截断。 */
  maxTextPerMessage?: number;
  maxMembers?: number;
  maxTopics?: number;
  /** 无相关互动多久失效。 */
  topicTtlMs?: number;
  /** 一个话题从建立起最多活多久，防止被无限续命。 */
  topicMaxLifeMs?: number;
};

const DEFAULTS = {
  windowMs: 5 * 60 * 1000,
  maxMessages: 40,
  maxChars: 6000,
  maxTextPerMessage: 600,
  maxMembers: 200,
  maxTopics: 3,
  topicTtlMs: 3 * 60 * 1000,
  topicMaxLifeMs: 15 * 60 * 1000,
} as const;

export class GroupContext {
  private readonly now: () => number;
  private readonly selfQq: string;
  private readonly windowMs: number;
  private readonly maxMessages: number;
  private readonly maxChars: number;
  private readonly maxTextPerMessage: number;
  private readonly maxMembers: number;
  private readonly maxTopics: number;
  private readonly topicTtlMs: number;
  private readonly topicMaxLifeMs: number;
  private readonly states = new Map<string, ConversationState>();

  constructor(options: GroupContextOptions = {}) {
    this.now = options.now ?? Date.now;
    this.selfQq = options.selfQq ?? "";
    this.windowMs = options.windowMs ?? DEFAULTS.windowMs;
    this.maxMessages = options.maxMessages ?? DEFAULTS.maxMessages;
    this.maxChars = options.maxChars ?? DEFAULTS.maxChars;
    this.maxTextPerMessage = options.maxTextPerMessage ?? DEFAULTS.maxTextPerMessage;
    this.maxMembers = options.maxMembers ?? DEFAULTS.maxMembers;
    this.maxTopics = options.maxTopics ?? DEFAULTS.maxTopics;
    this.topicTtlMs = options.topicTtlMs ?? DEFAULTS.topicTtlMs;
    this.topicMaxLifeMs = options.topicMaxLifeMs ?? DEFAULTS.topicMaxLifeMs;
  }

  /** 记一条群消息（无论后面会不会回）。重复 messageId 只留第一次。 */
  remember(key: string, message: GroupMessageFacts): void {
    const state = this.state(key);
    if (state.messages.some((item) => item.messageId === message.messageId)) return;
    state.messages.push({ ...message });
    this.prune(state);
  }

  /** 给模型看的正文：@ 她 → @self，@ 已知成员 → @member_n，@全体保留。 */
  formatText(key: string, text: string, selfQq = this.selfQq): string {
    if (!text) return "";
    const mapTarget = (raw: string) => {
      if (raw === "all") return "@all";
      if (selfQq && raw === selfQq) return "@self";
      return `@${this.memberCode(key, raw)}`;
    };
    return text
      // 字符串消息可能还带着 CQ 码，先换掉再处理拍平后的 @QQ。
      .replace(/\[CQ:at,qq=(\d+|all)\]/g, (_match, raw: string) => mapTarget(raw))
      .replace(/@(\d+|all)\b/g, (_match, raw: string) => mapTarget(raw));
  }

  memberCode(key: string, qq: string): string {
    if (!qq) return "member_unknown";
    const state = this.state(key);
    const existing = state.memberCodes.get(qq);
    if (existing) return existing;
    state.nextMember += 1;
    const code = `member_${state.nextMember}`;
    state.memberCodes.set(qq, code);
    while (state.memberCodes.size > this.maxMembers) {
      const oldest = state.memberCodes.keys().next().value;
      if (oldest === undefined) break;
      state.memberCodes.delete(oldest);
    }
    return code;
  }

  /** 本轮之外、仍在窗口内的背景，按时间正序；超预算时从最旧的开始丢。 */
  background(key: string, excludeIds: readonly string[]): GroupBackgroundLine[] {
    const state = this.state(key);
    const now = this.now();
    const excluded = new Set(excludeIds);
    const lines: GroupBackgroundLine[] = [];
    for (const message of state.messages) {
      if (excluded.has(message.messageId)) continue;
      if (now - message.at > this.windowMs) continue;
      lines.push({
        id: message.messageId,
        at: message.at,
        member: this.memberCode(key, message.senderQq),
        speaker: message.displayName,
        text: this.truncate(this.formatText(key, message.text)),
      });
    }
    // 从最旧的开始丢，直到总量进预算；至少保留最后一条。
    let total = lines.reduce((sum, line) => sum + line.text.length, 0);
    while (total > this.maxChars && lines.length > 1) {
      const dropped = lines.shift();
      total -= dropped?.text.length ?? 0;
    }
    return lines;
  }

  /** 有活跃话题、且这轮里有人是参与者（或引用锚点）时，值得看一眼。 */
  topicCandidate(key: string, facts: readonly GroupMessageFacts[]): boolean {
    const state = this.state(key);
    const now = this.now();
    const active = state.topics.filter((topic) => now < topic.expiresAt);
    if (!active.length) return false;
    const senders = new Set(facts.map((fact) => this.memberCode(key, fact.senderQq)));
    const replies = new Set(facts.map((fact) => fact.replyToMessageId).filter(Boolean));
    return active.some((topic) =>
      topic.participants.some((member) => senders.has(member))
      || (topic.anchorMessageId && replies.has(topic.anchorMessageId)),
    );
  }

  /** 给模型的参与锚点：只给还活着的，最多 maxTopics。 */
  anchors(key: string): GroupTopicAnchor[] {
    const now = this.now();
    return this.state(key).topics
      .filter((topic) => now < topic.expiresAt)
      .sort((a, b) => b.lastEvidenceAt - a.lastEvidenceAt)
      .slice(0, this.maxTopics)
      .map((topic) => ({ id: topic.anchorMessageId, label: this.labelOf(key, topic.anchorMessageId) }));
  }

  /**
   * 回复发送成功后登记参与。
   *
   * direct（被 @）用触发消息当锚点；水群用这一轮第一条。更新的是「参与者有交集」的
   * 旧话题，而不是「同一个邀请者」—— 同一个人可以同时聊几件事。
   */
  recordReply(
    key: string,
    facts: readonly GroupMessageFacts[],
    options: { source: "mention" | "ambient"; anchorMessageId?: string },
  ): void {
    if (!facts.length) return;
    const anchor = options.anchorMessageId
      || (options.source === "mention"
        ? facts.find((fact) => fact.mentionTargets.includes("self"))?.messageId
        : facts[0]!.messageId)
      || facts[0]!.messageId;
    const participants = [...new Set(facts.map((fact) => this.memberCode(key, fact.senderQq)))];
    const now = this.now();
    const state = this.state(key);
    const existing = state.topics.find((topic) =>
      now < topic.expiresAt && topic.participants.some((member) => participants.includes(member)),
    );
    if (existing) {
      existing.lastEvidenceAt = now;
      existing.expiresAt = this.expiry(existing, now);
      existing.participants = [...new Set([...existing.participants, ...participants])];
      return;
    }
    state.topics.push({
      anchorMessageId: anchor,
      participants,
      triggerMessageId: facts[0]!.messageId,
      lastEvidenceAt: now,
      createdAt: now,
      expiresAt: Math.min(now + this.topicTtlMs, now + this.topicMaxLifeMs),
      source: options.source,
    });
    this.pruneTopics(state);
  }

  /**
   * 模型判了「这还是在跟我聊」但选择沉默时，允许有界地续一下已有话题。
   * 只续已存在的锚点，不新建；返回是否真的续了。
   */
  refreshFromDecision(key: string, decision: GroupDecision | null): boolean {
    if (!decision) return false;
    if (decision.relation !== "followup" && decision.relation !== "shared_topic") return false;
    const anchorId = decision.topicAnchorMessageId;
    if (!anchorId) return false;
    const now = this.now();
    const topic = this.state(key).topics.find(
      (item) => item.anchorMessageId === anchorId && now < item.expiresAt,
    );
    if (!topic) return false;
    topic.lastEvidenceAt = now;
    topic.expiresAt = this.expiry(topic, now);
    return true;
  }

  /** 测试用：直接数还活着的话题。 */
  activeTopicCount(key: string): number {
    const now = this.now();
    return this.state(key).topics.filter((topic) => now < topic.expiresAt).length;
  }

  clear(key: string): void {
    this.states.delete(key);
  }

  private state(key: string): ConversationState {
    let state = this.states.get(key);
    if (!state) {
      state = { messages: [], topics: [], memberCodes: new Map(), nextMember: 0 };
      this.states.set(key, state);
    }
    return state;
  }

  private expiry(topic: Topic, now: number): number {
    return Math.min(now + this.topicTtlMs, topic.createdAt + this.topicMaxLifeMs);
  }

  private prune(state: ConversationState): void {
    const now = this.now();
    state.messages = state.messages.filter((message) => now - message.at <= this.windowMs);
    if (state.messages.length > this.maxMessages) {
      state.messages.splice(0, state.messages.length - this.maxMessages);
    }
  }

  private pruneTopics(state: ConversationState): void {
    const now = this.now();
    state.topics = state.topics.filter((topic) => now < topic.expiresAt);
    if (state.topics.length <= this.maxTopics) return;
    state.topics.sort((a, b) => b.lastEvidenceAt - a.lastEvidenceAt);
    state.topics.splice(this.maxTopics);
  }

  private labelOf(key: string, messageId: string): string {
    const message = this.state(key).messages.find((item) => item.messageId === messageId);
    if (!message) return "";
    const text = this.truncate(this.formatText(key, message.text));
    return text.length > 40 ? `${text.slice(0, 40)}…` : text;
  }

  private truncate(text: string): string {
    return text.length > this.maxTextPerMessage ? `${text.slice(0, this.maxTextPerMessage)}…` : text;
  }
}

export function createGroupContext(options?: GroupContextOptions): GroupContext {
  return new GroupContext(options);
}
