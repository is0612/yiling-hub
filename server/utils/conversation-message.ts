/**
 * 消息与会话的公共读法。记忆提炼、忆泡、手账三条链路都要用：
 * 「这条消息来自哪个会话」「是不是主人说的」「@ 的是谁」。
 *
 * 抽出来不是为了少写几行，而是防止三条链路各判各的 —— 群聊里「主人」和
 * 「@ 别人」这两件事一旦有一条链读错，写进记忆/手账的事实就反了。
 */

export type ConversationOriginRef = {
  /** `g:<群号>` / `c:<QQ号>` / null（桌面端本地对话）。 */
  externalConversationId: string | null;
};

/** 会话在提示词里的来源标签。群聊必须带群号，否则模型分不清是哪段关系在说话。 */
export function conversationOriginLabel(conversation: ConversationOriginRef): string {
  const key = conversation.externalConversationId ?? "";
  const group = /^g:(\d+)$/.exec(key);
  if (group?.[1]) return `QQ群 ${group[1]}`;
  if (key.startsWith("c:")) return "私聊";
  return "本地对话";
}

/** 这条是主人发的。群聊里主人和群友混在一起，要靠它让提炼/手账认得出主人。 */
export function readMessageIsOwner(metadata: unknown): boolean {
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  return record.isOwner === true;
}

/** 这条消息 @ 了谁（self / other / all）。没标就是非群聊或没 @ 任何人。 */
export function readMessageMentionTargets(metadata: unknown): string[] {
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  const value = record.mentionTargets;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
