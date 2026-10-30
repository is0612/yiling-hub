import { generateConversationReply, type ConversationContextMessage, type ConversationGroupDecision } from "../chat-reply";
import { isEmojiEnabled, resolveChatModelSettings } from "../chat-model-config";
import { resolveCharacterApiKey, resolveCharacterVoiceApiKey } from "../credential-encryption";
import {
  rankMemoriesWithBudget, rankSnapshotsWithBudget,
  resolveMemoryItemLimit, resolveMemoryTokenBudget, resolveSnapshotTokenBudget,
} from "../memory-retrieval";
import { recordModelUsage, readDailyQuota, toUsageTokens } from "../model-usage";
import {
  applyImageDescriptions,
  describeImages,
  MAX_IMAGES_PER_TURN,
  resolveImageUnderstandingSettings,
  type ChannelImageRef,
} from "../image-understanding";
import { ensureExternalIdentityScope } from "../identity-scope";
import { isEmojiBudgetSpent, resolveEmojiFrequency } from "../emoji-frequency";
import { ensureOwnerPrivateScope } from "../memory-scope-access";
import { getPrisma } from "../prisma";
import { pickStickerCatalog, type StickerCatalogEntry } from "../stickers";
import {
  loadCatchphraseCatalog, markCatchphrasesUsed, pickCatchphraseCatalog, toCatchphrasePromptEntries,
} from "../catchphrases";
import { maybeAutoMineCatchphrases } from "../catchphrase-mine";
import { collectStickersFromTurn } from "../sticker-collect";
import {
  applyVoiceTranscripts,
  canSpeakReply,
  isVoiceRequested,
  MAX_VOICES_PER_TURN,
  planVoiceReply,
  resolveVoiceAsrSettings,
  resolveVoiceTtsSettings,
  transcribeVoices,
  type ChannelVoiceRef,
  type VoiceTtsSettings,
} from "../voice";

export type ChannelReplyOptions = {
  /** 表情 id。渠道自己保证 id 合法；不支持表情的渠道忽略即可。 */
  faces?: string[];
  /**
   * 她自己的表情包（贴图）。渠道把它单独发一条；与 faces 二选一，
   * 传了 sticker 就不再发内置表情。
   *
   * `qqEmojiId` 有值时渠道应该优先走「QQ 收藏表情」通道（原生表情段），
   * 拿不到或发失败再退回图片段 —— 具体取舍在渠道里，流水线只负责把 id 带下去。
   */
  sticker?: { id: string; filePath: string; qqEmojiId?: string | null };
  /** 引用回复的消息 id（本平台原始 id）。群聊里让她锚定「接的是哪一句」。 */
  replyToMessageId?: string;
  /**
   * 这一条用语音发。渠道自己决定能不能真发（要合成、要转 silk），
   * 发不出来就退回发文字 —— 语音是锦上添花，不能成为整轮沉默的原因。
   */
  voice?: boolean;
  /**
   * 语音合成参数。由流水线解析好后带下来（含角色自己的 API Key），
   * 这样渠道不必为了合成再查一次库、再解密一次凭据。
   */
  voiceSettings?: VoiceTtsSettings;
};

export type ChannelReplySender = (text: string, options?: ChannelReplyOptions) => Promise<void>;

/**
 * 渠道会话键 `g:<群号>` / `c:<账号>` 里取出群号。
 *
 * 只用于把「这是哪个群」写进会话标题和 metadata —— 路由仍以完整的 externalConversationId
 * 为准。群聊记录会进角色全局记忆，事后要能看出「这句话是在哪个群说的」，而标题原来
 * 取的是第一条消息的前 80 字，翻记录时根本认不出是哪个群。
 */
/**
 * 一轮回复回看多少条已落库的消息。
 *
 * 原来是 20 条。20 条是「消息」不是「轮」：热群里一轮就三五条，实际只覆盖三四轮，
 * 她接不上十分钟前的话，也记不住那句是谁说的。40 条约 8-10 轮，是这个场景的甜点 ——
 * 再往上收益递减，而每条历史都要占 prompt token（现在还带 speaker/isOwner）。
 *
 * 注意别指望它做「十分钟内发了几张表情」这种统计：40 条在热群依旧覆盖不到十分钟，
 * 那类判断必须按 occurredAt 回表数（见 `emoji-frequency.ts`）。
 */
const RECENT_MESSAGE_LIMIT = 40;

function readGroupIdFromConversationKey(key: string): string | null {
  const matched = /^g:(\d+)$/.exec(key);
  return matched?.[1] ?? null;
}

/** 一轮里的一个人说的话。群聊会把几秒内的几条消息合成一轮。 */
export type ChannelTurnMessage = {
  externalMessageId: string;
  authorOpenId: string;
  /** Stable per-platform author id (bili uid / qq openid). Used to upsert ExternalIdentity. */
  authorPlatformUid?: string;
  /** Optional author display name for identity metadata. */
  authorDisplayName?: string;
  content: string;
  /** 给模型看的正文（@ 已代号化）；不传就等于 content。落库仍用 content。 */
  promptContent?: string;
  /** 群聊里的成员代号；只有群聊会传。 */
  member?: string;
  /** 收到这条消息的时刻（不是模型返回的时刻）。 */
  occurredAt?: Date;
  /** 这条消息里带的图。只有接了「看图」旁路才会被读，没配视觉模型时完全忽略。 */
  images?: ChannelImageRef[];
  /** 这条消息里带的语音。只有接了「听懂语音」旁路才会被读，没配 ASR 时完全忽略。 */
  voices?: ChannelVoiceRef[];
  /** 当前说话人是不是主人；只用于提示词，不参与鉴权。 */
  speaker?: {
    displayName?: string;
    isOwner: boolean;
    ownerDisplayName?: string;
  };
};

export type ChannelMessageInput = {
  platform: string;
  characterId: string;
  bindingId: string;
  /** Platform-specific message event type (e.g. QQ group message, bili dm). */
  eventType: string;
  /** Stable key for the conversation: "g:<group_openid>", "c:<user_openid>", "dm:<id>", etc. */
  externalConversationId: string;
  externalMessageId: string;
  authorOpenId: string;
  /** Stable per-platform author id (bili uid / qq openid). Used to upsert ExternalIdentity. */
  authorPlatformUid?: string;
  /** Optional author display name for identity metadata. */
  authorDisplayName?: string;
  /** 当前说话人是不是主人；只用于提示词，不参与鉴权。 */
  speaker?: {
    displayName?: string;
    isOwner: boolean;
    ownerDisplayName?: string;
  };
  content: string;
  /** 这条消息带的图。渠道不传就等于「这个渠道没有图」，不影响其他行为。 */
  images?: ChannelImageRef[];
  /** 这条消息带的语音。渠道不传就等于「这个渠道没有语音」。 */
  voices?: ChannelVoiceRef[];
  /**
   * 这个渠道能发的表情清单。**传了就等于声明「本渠道支持表情」**——B站 私信没有表情段，
   * 不传；流水线不认平台名，只认这份清单在不在。
   */
  faceCatalog?: ReadonlyArray<{ id: string; name: string }>;
  /**
   * 这个角色的表情包清单。**传了就等于声明「本渠道能发图片」**，并且优先于内置表情：
   * 有清单时模型从里面挑一张，内置表情不再进提示词。
   */
  stickerCatalog?: ReadonlyArray<StickerCatalogEntry>;
  /**
   * 这个渠道能不能发语音条。**传了就等于声明「本渠道支持语音」**——不传就永远发文字。
   * 与 faceCatalog 同理：流水线不认平台名，只认这份能力声明在不在。
   */
  voiceCapable?: boolean;
  sendReply: ChannelReplySender;
};

/** 群聊这一轮的上下文：本轮是否 @ 她、之前几句、她参与过的话题。 */
export type ChannelGroupTurnContext = {
  direct: boolean;
  background: Array<{ id: string; at: number; member: string; speaker: string; text: string }>;
  anchors: Array<{ id: string; label: string }>;
};

/** 群聊一轮：几秒内几个人说的话，一次看、最多回一次。 */
export type ChannelBatchInput = {
  platform: string;
  characterId: string;
  bindingId: string;
  eventType: string;
  externalConversationId: string;
  messages: ChannelTurnMessage[];
  faceCatalog?: ReadonlyArray<{ id: string; name: string }>;
  stickerCatalog?: ReadonlyArray<StickerCatalogEntry>;
  /** 允许模型说「这轮不插嘴」。被 @ 时传 false —— 点名了还不回比乱回更糟。 */
  allowSilent?: boolean;
  /** 见 `ChannelMessageInput.voiceCapable`。 */
  voiceCapable?: boolean;
  /** 群聊上下文；私聊不传。 */
  group?: ChannelGroupTurnContext;
  sendReply: ChannelReplySender;
};

export type ChannelMessageResult =
  | { status: "replied"; conversationId: string; groupDecision?: ConversationGroupDecision }
  | { status: "silent"; conversationId: string; groupDecision?: ConversationGroupDecision }
  | { status: "duplicate" }
  | { status: "ignored"; reason: string };

/** 从已存消息的 metadata 里取表情包 id。没有（或不是字符串）返回 null。 */
function readStoredStickerId(metadata: unknown): string | null {
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  return typeof record.stickerId === "string" && record.stickerId ? record.stickerId : null;
}

/**
 * 上一条回复是不是语音条。存的是个标记而不是音频本身（音频发完就没了），
 * 只用来算冷却 —— 不要拿它判断「她刚才说了什么」，那是 content 的事。
 */
function readStoredVoiceFlag(metadata: unknown): boolean {
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  return record.voice === true;
}

/**
 * 落库时记下的发言人。
 *
 * 群聊历史全是 `role: "USER"`，谁说的只有 metadata 知道。不把它读出来，
 * 20 条历史在提示词里就是 20 句没有主人的话 —— 模型只好按「谁口吻像谁」猜，
 * 于是把 A 说的安到 B 头上（`recentMessages` 原来只映射 role/content/occurredAt）。
 */
function readStoredSpeaker(metadata: unknown): { speaker?: string; isOwner: boolean } {
  const record = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  const name = typeof record.authorDisplayName === "string" ? record.authorDisplayName.trim().slice(0, 80) : "";
  return {
    ...(name ? { speaker: name } : {}),
    isOwner: record.isOwner === true,
  };
}

/**
 * 把附件的转写结果写回这条消息。
 *
 * **必须同时改 `content` 和 `promptContent`**：落库看 `content`，进提示词看 `promptContent`
 * （群聊里它是 @ 代号化后的正文）。只改一个的话，群聊这一路等于没接 ——
 * 私聊测着是好的，群里却一直只看到 `[图片]` / `[语音]`。
 */
function patchMessageText(
  message: ChannelTurnMessage,
  transform: (text: string) => string,
): ChannelTurnMessage {
  const content = transform(message.content);
  if (!message.promptContent) return { ...message, content };
  return { ...message, content, promptContent: transform(message.promptContent) };
}

/**
 * 把这一轮里的图先变成文字，再交给聊天模型。
 *
 * 聊天模型（deepseek-flash 这类）在聊天这条路上走的是文本 body，图没法直接混进去，
 * 所以"看图"只能发生在进提示词之前：视觉模型出 2-4 句描述，正文里的 `[图片]` 换成
 * `[图片：描述]`。角色没打开 `imageUnderstanding` 时这里原样返回 —— 行为与接入前一致。
 *
 * 放在额度检查之后：额度已经超了就别再为看图多花一次调用。
 * 失败一律吞掉：少一句描述不该让整轮回复变成错误事件。
 */
async function attachImageDescriptions(
  messages: ChannelTurnMessage[],
  context: {
    modelConfig: unknown;
    chatModel: string;
    apiBaseUrl: string;
    apiKey: string;
    characterId: string;
    bindingId: string;
  },
): Promise<ChannelTurnMessage[]> {
  if (!messages.some((message) => (message.images?.length ?? 0) > 0)) return messages;
  const settings = resolveImageUnderstandingSettings({
    modelConfig: context.modelConfig,
    chatModel: context.chatModel,
    chatApiBaseUrl: context.apiBaseUrl,
    chatApiKey: context.apiKey,
  });
  if (!settings) return messages;

  let remaining = MAX_IMAGES_PER_TURN;
  const descriptionsByMessage = new Map<string, Array<string | null>>();
  for (const message of messages) {
    if (remaining <= 0) break;
    const refs = (message.images ?? []).filter((image) => Boolean(image.url));
    if (!refs.length) continue;
    const batch = refs.slice(0, remaining);
    remaining -= batch.length;
    try {
      descriptionsByMessage.set(
        message.externalMessageId,
        await describeImages(batch, settings, {
          characterId: context.characterId,
          channelBindingId: context.bindingId,
        }),
      );
    } catch {
      // 看图失败只是少一句描述，`[图片]` 原样保留。
    }
  }
  if (!descriptionsByMessage.size) return messages;

  return messages.map((message) => {
    const descriptions = descriptionsByMessage.get(message.externalMessageId);
    if (!descriptions?.length) return message;
    return patchMessageText(message, (text) => applyImageDescriptions(text, descriptions));
  });
}

/**
 * 把这一轮里的语音先转成文字，再交给聊天模型。
 *
 * 与看图同构，理由也一样：聊天模型读不懂音频，语音必须在进提示词之前变成文字。
 * 角色没打开 `voiceTranscribe`（或没配 ASR 模型）时这里原样返回 —— 行为与接入前一致，
 * 群里的语音仍然只是 `[语音]`。
 *
 * 放在额度检查之后：额度已经超了就别再为听语音多花一次调用。
 * 失败一律吞掉：少一句转写不该让整轮回复变成错误事件。
 */
async function attachVoiceTranscripts(
  messages: ChannelTurnMessage[],
  context: {
    modelConfig: unknown;
    chatModel: string;
    apiBaseUrl: string;
    apiKey: string;
    voiceApiKey: string;
  },
): Promise<ChannelTurnMessage[]> {
  if (!messages.some((message) => (message.voices?.length ?? 0) > 0)) return messages;
  const settings = resolveVoiceAsrSettings({
    modelConfig: context.modelConfig,
    chatModel: context.chatModel,
    chatApiBaseUrl: context.apiBaseUrl,
    chatApiKey: context.apiKey,
    voiceApiKey: context.voiceApiKey,
  });
  if (!settings) return messages;

  let remaining = MAX_VOICES_PER_TURN;
  const transcriptsByMessage = new Map<string, Array<string | null>>();
  for (const message of messages) {
    if (remaining <= 0) break;
    const refs = (message.voices ?? []).filter((voice) => Boolean(voice.url));
    if (!refs.length) continue;
    const batch = refs.slice(0, remaining);
    remaining -= batch.length;
    try {
      transcriptsByMessage.set(message.externalMessageId, await transcribeVoices(batch, settings));
    } catch {
      // 转写失败只是少一句文字，`[语音]` 原样保留。
    }
  }
  if (!transcriptsByMessage.size) return messages;

  return messages.map((message) => {
    const transcripts = transcriptsByMessage.get(message.externalMessageId);
    if (!transcripts?.length) return message;
    return patchMessageText(message, (text) => applyVoiceTranscripts(text, transcripts));
  });
}

/**
 * The reusable channel event pipeline: idempotent ingest → character binding → character-global
 * memory retrieval → model reply → persistence → send back. This is platform-agnostic apart from
 * the QQ message-event type used for the conversation key.
 *
 * 群聊（`GROUP_MESSAGE`）只读角色全局记忆：一个群里说话的是不同的人，
 * 把某一个人的私人记忆端到另一个人面前，等于当面念别人的悄悄话。
 * 私聊仍然带上这个人的 identity scope。
 */
async function runChannelTurn(input: {
  platform: string;
  characterId: string;
  bindingId: string;
  eventType: string;
  externalConversationId: string;
  messages: ChannelTurnMessage[];
  faceCatalog?: ReadonlyArray<{ id: string; name: string }>;
  stickerCatalog?: ReadonlyArray<StickerCatalogEntry>;
  /** 允许模型说「这轮我不插嘴」。只有群聊批处理会传。 */
  allowSilent?: boolean;
  /** 群聊上下文；私聊不传。 */
  group?: ChannelGroupTurnContext;
  voiceCapable?: boolean;
  sendReply: ChannelReplySender;
}): Promise<ChannelMessageResult> {
  const prisma = getPrisma();
  const isGroup = input.eventType === "GROUP_MESSAGE";
  let messages = input.messages
    .filter((message) => message.externalMessageId && message.content)
    .slice(-10);
  if (!messages.length) return { status: "ignored", reason: "missing_fields" };

  // Character lookup comes first: a paused or archived character must not answer channel
  // messages, and rejecting early also avoids creating an external identity for a dead character.
  const character = await prisma.character.findUnique({
    where: { id: input.characterId },
    select: {
      id: true,
      name: true,
      ownerId: true,
      basePrompt: true,
      styleExamples: true,
      status: true,
      modelConfig: true,
      memoryScopes: { where: { scopeType: "CHARACTER_GLOBAL" }, select: { id: true } },
    },
  });
  if (!character) return { status: "ignored", reason: "character_missing" };
  if (character.status !== "ACTIVE") return { status: "ignored", reason: "character_inactive" };
  const globalScope = character.memoryScopes[0];
  if (!globalScope) return { status: "ignored", reason: "no_global_scope" };

  // Idempotency: a QQ message id is unique for the application, so a re-delivered event is dropped
  // regardless of whether its conversation has been created yet. 群聊一轮里有几条，全查一遍。
  const seen = await prisma.message.findMany({
    where: { externalMessageId: { in: messages.map((message) => message.externalMessageId) } },
    select: { externalMessageId: true },
  });
  if (seen.length) {
    const seenIds = new Set(seen.map((row) => row.externalMessageId));
    const fresh = messages.filter((message) => !seenIds.has(message.externalMessageId));
    if (!fresh.length) return { status: "duplicate" };
    messages = fresh;
  }

  // Upsert the external identities for the people in this turn. 群聊一轮里可能有好几个人，
  // 每个人各自一行；同一轮里同一个人说两句就只 upsert 一次。
  let primaryIdentityScopeId: string | null = null;
  const identityScopeByAuthor = new Map<string, string | null>();
  for (const message of messages) {
    const platformUid = (message.authorPlatformUid || message.authorOpenId || "").trim();
    if (!platformUid || identityScopeByAuthor.has(platformUid)) continue;
    const identity = await prisma.externalIdentity.upsert({
      where: { platform_platformUid: { platform: input.platform, platformUid } },
      create: {
        platform: input.platform,
        platformUid,
        displayName: message.authorDisplayName?.slice(0, 255) || null,
        status: "UNVERIFIED",
      },
      update: {
        ...(message.authorDisplayName ? { displayName: message.authorDisplayName.slice(0, 255) } : {}),
      },
      select: { id: true },
    });
    // Establish the identity's dedicated memory scope so its private memory can be
    // isolated per platform (and later linked via admin verification). Best-effort:
    // a scope that already exists is reused; failure must not block the message.
    const scope = await ensureExternalIdentityScope(
      input.characterId, input.platform, platformUid, identity.id,
    ).catch(() => null);
    identityScopeByAuthor.set(platformUid, scope?.scopeId ?? null);
  }
  {
    const first = messages[0]!;
    const firstUid = (first.authorPlatformUid || first.authorOpenId || "").trim();
    primaryIdentityScopeId = firstUid ? identityScopeByAuthor.get(firstUid) ?? null : null;
  }

  // 主人专属私人范围：说话人明确是主人（私聊里渠道传 isOwner）时，会话挂到角色主人的
  // USER_PRIVATE 范围，而不是该账号的外部身份范围。这样主人的私聊走「角色主人私人记忆」，
  // 由调度器单独排快照，且只在主人自己的对话里可读 —— 不会混进全局、也不会串给群友。
  const isOwnerTurn = !isGroup && messages[0]?.speaker?.isOwner === true;
  let ownerPrivateScopeId: string | null = null;
  if (isOwnerTurn) {
    ownerPrivateScopeId = await ensureOwnerPrivateScope(input.characterId, character.ownerId);
  }

  const chatSettings = resolveChatModelSettings(character.modelConfig);
  let apiKey = "";
  try {
    apiKey = await resolveCharacterApiKey(character.modelConfig, chatSettings.apiBaseUrl);
  } catch {
    return { status: "ignored", reason: "api_key_decrypt_failed" };
  }
  if (!apiKey || !chatSettings.model) return { status: "ignored", reason: "model_not_configured" };

  /**
   * 语音 Key 与聊天 Key 是**两把**：语音几乎总是另一家服务商
   * （DeepSeek / 通义这类纯文本服务商的 /audio/speech 直接 404），
   * 而它常常是页面上单独填的。解密失败按没配处理，不影响聊天。
   */
  const voiceApiKey = await resolveCharacterVoiceApiKey(character.modelConfig).catch(() => "");

  // 额度用完就静默不回：渠道里抛错会把一条普通聊天变成失败事件，还会触发重试。
  const quota = await readDailyQuota(input.characterId, character.modelConfig);
  if (quota.exceeded) return { status: "ignored", reason: "daily_quota_exceeded" };

  // 图先变成文字再进提示词；角色没开看图开关时这一步什么都不做。
  messages = await attachImageDescriptions(messages, {
    modelConfig: character.modelConfig,
    chatModel: chatSettings.model,
    apiBaseUrl: chatSettings.apiBaseUrl,
    apiKey,
    characterId: input.characterId,
    bindingId: input.bindingId,
  });

  // 语音同理：先转写成文字再进提示词，没开「听懂语音」时原样保留 `[语音]`。
  messages = await attachVoiceTranscripts(messages, {
    modelConfig: character.modelConfig,
    chatModel: chatSettings.model,
    apiBaseUrl: chatSettings.apiBaseUrl,
    apiKey,
    voiceApiKey,
  });

  // 「偷表情包」：群里的图值得收就存进她的表情库。只收群聊、不看她自己发的图，
  // 由开关 `modelConfig.stickerAutoCollect` 控制（默认关）。失败静默，不影响这轮回复。
  if (isGroup) {
    const collectCandidates = messages.flatMap((message) =>
      (message.images ?? []).filter((img) => img.url).map((img) => ({
        url: img.url,
        ...(img.summary ? { summary: img.summary } : {}),
      })),
    );
    if (collectCandidates.length) {
      await collectStickersFromTurn(collectCandidates, {
        characterId: input.characterId,
        ...(input.bindingId ? { bindingId: input.bindingId } : {}),
        modelConfig: character.modelConfig,
        chatModel: chatSettings.model,
        chatApiBaseUrl: chatSettings.apiBaseUrl,
        chatApiKey: apiKey,
      }).catch(() => undefined);
    }
  }

  const existingConversation = await prisma.conversation.findFirst({
    where: { channelBindingId: input.bindingId, externalConversationId: input.externalConversationId },
    select: { id: true, title: true },
  });

  const recentStoredMessages = existingConversation
    ? await prisma.message.findMany({
        where: { conversationId: existingConversation.id },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
        take: RECENT_MESSAGE_LIMIT,
        select: { role: true, content: true, occurredAt: true, metadata: true, externalMessageId: true },
      })
    : [];

  // 表情要看三件事：渠道收不收（清单）、角色开没开开关、这个会话的额度用没用完。
  // 只看前两个的话，一个爱发表情的角色会在每句后面都挂一张。
  const lastAssistant = recentStoredMessages.find((item) => item.role === "ASSISTANT");
  const lastStickerId = lastAssistant ? readStoredStickerId(lastAssistant.metadata) : null;
  /**
   * 上一条语音是什么时候发的。语音冷却看它：连着两条都在「说话」像在读稿。
   * recentStoredMessages 是按时间倒序取的，所以第一条命中的就是最近一条。
   */
  const lastVoiceAt = recentStoredMessages.find(
    (item) => item.role === "ASSISTANT" && readStoredVoiceFlag(item.metadata),
  )?.occurredAt ?? null;

  /**
   * 语音必须在**生成之前**决定 —— 关键是模型得知道自己在说话。
   *
   * 生成后再判定的话，提示词里压根没提语音，她会回「我只有打字和嘴硬」
   * 「我这打字声你当语音听吧」：内容解释得通，但暴露了她根本不知道这条要被念出来。
   * 所以这里先定「这一轮说不说」，把结果放进提示词，再让它写；
   * 生成后只用 `canSpeakReply` 复核长度，超长就降级发文字。
   *
   * 判定只看开关、冷却、概率（用户明确要语音时跳过冷却与概率，但不跳过开关）。
   */
  const voiceRequested = input.voiceCapable === true
    && messages.some((message) => isVoiceRequested(message.promptContent ?? message.content));
  const voiceSettings = input.voiceCapable === true
    ? resolveVoiceTtsSettings({
        modelConfig: character.modelConfig,
        chatModel: chatSettings.model,
        chatApiBaseUrl: chatSettings.apiBaseUrl,
        chatApiKey: apiKey,
        voiceApiKey,
      })
    : null;
  const voicePlanned = Boolean(voiceSettings) && planVoiceReply({
    modelConfig: character.modelConfig,
    lastVoiceAt,
    force: voiceRequested,
  });

  /**
   * 额度：「每 N 分钟最多 N 张」，按**这个会话**算（A 群贴过三张不该让 B 群闭嘴）。
   *
   * 只取窗口内的助手消息，不看全部：`recentStoredMessages` 只有 20 条，热聊时
   * 二十条可能还没覆盖十分钟，用它数会少算。
   */
  const emojiFrequency = resolveEmojiFrequency(character.modelConfig);
  const emojiHistory = existingConversation
    ? await prisma.message.findMany({
        where: {
          conversationId: existingConversation.id,
          role: "ASSISTANT",
          occurredAt: { gte: new Date(Date.now() - emojiFrequency.windowMinutes * 60_000) },
        },
        select: { occurredAt: true, metadata: true },
      })
    : [];
  const emojiBudgetSpent = isEmojiBudgetSpent(emojiHistory, new Date(), emojiFrequency);
  // 表情包优先于内置表情：有素材库就只给素材库（并剔除上一张，避免她一直贴同一张）。
  // 这一条要走语音时一律不给：语音条后面再挂一张图，等于把两种表达叠在一起说同一件事。
  const stickerCatalog = input.stickerCatalog?.length
    && isEmojiEnabled(character.modelConfig)
    && !emojiBudgetSpent
    && !voicePlanned
    ? pickStickerCatalog(input.stickerCatalog, lastStickerId)
    : undefined;
  const emojiFaces = !stickerCatalog?.length
    && input.faceCatalog?.length
    && isEmojiEnabled(character.modelConfig)
    && !emojiBudgetSpent
    && !voicePlanned
    ? input.faceCatalog
    : undefined;

  /**
   * 梗语录：和表情包不同，**不从调用方传**，流水线自己查。
   *
   * 表情包要按渠道能力决定（B站私信发不了图），梗是纯文字、哪个渠道都能说；
   * 交给每个 adapter 各自去查，只会有一边忘了接。角色级的文字习惯应该在角色级生效。
   */
  const catchphrasePrompt = toCatchphrasePromptEntries(
    pickCatchphraseCatalog(await loadCatchphraseCatalog(character.id)),
  );

  const recentMessages: ConversationContextMessage[] = recentStoredMessages
    .reverse()
    .filter((item) => item.role === "USER" || item.role === "ASSISTANT")
    .map((item) => ({
      role: item.role as "USER" | "ASSISTANT",
      content: item.content.slice(0, 1800),
      occurredAt: item.occurredAt.toISOString(),
      // 只有她自己的话不需要发言人；USER 的话一律带上，否则群里几条历史分不清是谁说的。
      ...(item.role === "USER" ? readStoredSpeaker(item.metadata) : {}),
    }));

  const modelText = (message: ChannelTurnMessage) => message.promptContent ?? message.content;
  const currentMessage = messages.length === 1
    ? modelText(messages[0]!)
    : messages.map((message) => `${message.authorDisplayName || "群友"}：${modelText(message)}`).join("\n");

  const retrievalQuery = [
    currentMessage,
    ...recentMessages.filter((item) => item.role === "USER").slice(-2).map((item) => item.content),
  ].join("\n");

  // Retrieval scope: character-global (shared persona) plus the author's own identity scope
  // (per-platform private memory). 群聊只用全局：一轮里好几个人，谁的私人记忆都不该端出来。
  // 主人私聊用 owner 的 USER_PRIVATE 范围（而不是外部身份范围）。
  const readableScopeIds = isGroup
    ? [globalScope.id]
    : (isOwnerTurn && ownerPrivateScopeId
      ? [globalScope.id, ownerPrivateScopeId]
      : (primaryIdentityScopeId ? [globalScope.id, primaryIdentityScopeId] : [globalScope.id]));

  const memoryCandidates = await prisma.memoryItem.findMany({
    where: { memoryScopeId: { in: readableScopeIds }, status: "ACTIVE", deletedAt: null },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: 300,
    select: {
      id: true, category: true, content: true, confidence: true, updatedAt: true, createdAt: true,
      memoryScopeId: true, importance: true, lastRecalledAt: true, recallCount: true,
    },
  });
  const memoryRank = rankMemoriesWithBudget(retrievalQuery, memoryCandidates, {
    limit: resolveMemoryItemLimit(character.modelConfig),
    tokenBudget: resolveMemoryTokenBudget(character.modelConfig),
  });
  const memories = memoryRank.items.map((memory) => ({
    id: memory.id,
    category: memory.category,
    content: memory.content.slice(0, 1200),
    confidence: memory.confidence,
    relevanceScore: memory.relevanceScore,
    scope: memory.memoryScopeId === globalScope.id ? ("character" as const) : ("private" as const),
  }));

  const snapshotCandidates = await prisma.memorySnapshot.findMany({
    where: { memoryScopeId: { in: readableScopeIds }, status: "CURRENT" },
    orderBy: [{ createdAt: "desc" }, { version: "desc" }],
    take: 80,
    select: { id: true, summary: true, periodStart: true, periodEnd: true, version: true, createdAt: true, memoryScopeId: true },
  });
  const snapshotRank = rankSnapshotsWithBudget(retrievalQuery, snapshotCandidates, {
    limit: 4,
    tokenBudget: resolveSnapshotTokenBudget(character.modelConfig),
  });
  const snapshots = snapshotRank.items.map((snapshot) => ({
    id: snapshot.id,
    summary: snapshot.summary.slice(0, 3000),
    periodStart: snapshot.periodStart.toISOString(),
    periodEnd: snapshot.periodEnd.toISOString(),
    version: snapshot.version,
    relevanceScore: snapshot.relevanceScore,
    scope: snapshot.memoryScopeId === globalScope.id ? ("character" as const) : ("private" as const),
  }));

  // 群聊一轮是「几个人在聊」，不是「某个人在对我说话」：交给 transcript。
  // 进了群聊管道就一律用群聊语境 —— 被 @ 时虽然不允许沉默，但同样需要上下文。
  const allowSilent = input.allowSilent === true && isGroup;
  const useTranscript = Boolean(input.group) || isGroup || messages.length > 1;

  // 群聊背景里可能混着已经落库的历史（recentMessages 里也有一份），按消息 id 去重，
  // 免得同一句在提示词里出现两遍。
  const storedMessageIds = new Set(
    recentStoredMessages
      .map((item) => item.externalMessageId)
      .filter((id): id is string => Boolean(id)),
  );
  const backgroundLines = (input.group?.background ?? []).filter((line) => !storedMessageIds.has(line.id));

  let generated;
  try {
    generated = await generateConversationReply({
      characterName: character.name,
      characterPrompt: character.basePrompt.slice(0, 12_000),
      ...(!useTranscript && messages[0]!.speaker ? { speaker: messages[0]!.speaker } : {}),
      styleExamples: (character.styleExamples ?? "").slice(0, 8000),
      model: chatSettings.model,
      apiKey,
      apiBaseUrl: chatSettings.apiBaseUrl,
      temperature: chatSettings.temperature,
      maxTokens: chatSettings.maxTokens,
      currentMessage,
      ...(useTranscript
        ? {
            transcript: messages.map((message) => ({
              id: message.externalMessageId,
              ...(message.member ? { member: message.member } : {}),
              speaker: message.authorDisplayName ?? "",
              content: message.promptContent ?? message.content,
              // 谁是主人必须逐行带：顶层 speaker 在群聊路径下不会传（一轮里好几个人说话），
              // 漏掉这一行，模型只能从「谁说话口吻像主人」里猜，结果就是对谁都喊主人。
              isOwner: message.speaker?.isOwner === true,
              ...(message.occurredAt ? { occurredAt: message.occurredAt.toISOString() } : {}),
            })),
          }
        : {}),
      ...(input.group
        ? {
            groupChat: true,
            direct: input.group.direct,
            ...(backgroundLines.length
              ? {
                  groupBackground: backgroundLines.map((line) => ({
                    id: line.id,
                    member: line.member,
                    speaker: line.speaker,
                    content: line.text,
                    occurredAt: new Date(line.at).toISOString(),
                  })),
                }
              : {}),
            ...(input.group.anchors.length ? { groupAnchors: input.group.anchors } : {}),
          }
        : {}),
      ...(allowSilent ? { allowSilent } : {}),
      recentMessages,
      memories,
      snapshots,
      ...(emojiFaces ? { emojiFaces } : {}),
      ...(stickerCatalog?.length ? { emojiStickers: stickerCatalog } : {}),
      // 告诉她「这一条会被念出来」：语气、长度、不要表情符号都靠这一段。
      ...(voicePlanned ? { voiceReply: true } : {}),
      ...(catchphrasePrompt.length ? { catchphrases: catchphrasePrompt } : {}),
    });
  } catch (error) {
    return { status: "ignored", reason: (error instanceof Error ? error.message : "model_error").slice(0, 200) };
  }

  const now = new Date();
  const assistantAt = new Date(now.getTime() + 1);
  const groupId = isGroup ? readGroupIdFromConversationKey(input.externalConversationId) : null;
  // 群会话标题用群号：原来的「第一条消息前 80 字」在记忆页翻记录时完全认不出是哪个群。
  const title = existingConversation?.title
    || (groupId ? `QQ群 ${groupId}` : currentMessage.slice(0, 80));
  const replyFaces = generated.action === "silent" ? [] : generated.faceIds;
  // 贴纸只认本次给的清单：模型返回了 id 但图不在清单里（比如刚被删掉），就当没选。
  const replySticker = generated.action === "silent" || !generated.stickerId
    ? null
    : input.stickerCatalog?.find((entry) => entry.id === generated.stickerId) ?? null;
  /**
   * 这一条真的用语音发吗。
   *
   * `voicePlanned` 是在生成之前定下的（模型据此按说话的方式写），这里只复核一次长度：
   * 说太长就该用文字，而不是截一段读 —— 截断的话术在语音条里听起来像被掐断。
   * 发不出去怎么办由渠道兜底（合成失败退回发文字，见 serve.ts）。
   */
  const replyVoice = generated.action === "reply"
    && voicePlanned
    && canSpeakReply(generated.reply);
  const conversationScopeId = isGroup
    ? globalScope.id
    : (isOwnerTurn && ownerPrivateScopeId ? ownerPrivateScopeId : (primaryIdentityScopeId ?? globalScope.id));
  const conversationId = await prisma.$transaction(async (tx) => {
    const conversation = existingConversation ?? await tx.conversation.create({
      data: {
        characterId: input.characterId,
        // 群聊挂在角色全局 scope 下：它属于一群人，不属于某一个外部身份。
        memoryScopeId: conversationScopeId,
        channelBindingId: input.bindingId,
        externalConversationId: input.externalConversationId,
        title,
        status: "ACTIVE",
        // kind/groupId 让「这段记录属于哪个群」可查；记忆页的群聊记录按它分组。
        metadata: {
          platform: input.platform,
          kind: isGroup ? "group" : "private",
          ...(groupId ? { groupId } : {}),
        },
      },
      select: { id: true, title: true },
    });
    for (const [index, message] of messages.entries()) {
      await tx.message.create({
        data: {
          conversationId: conversation.id,
          externalMessageId: message.externalMessageId,
          role: "USER",
          content: message.content,
          // 一条一轮时保持原来的「处理时刻」，多条时用各自的收到时刻，别让并发把顺序搅乱。
          occurredAt: messages.length === 1 ? now : (message.occurredAt ?? new Date(now.getTime() - (messages.length - index))),
          metadata: {
            source: "channel",
            platform: input.platform,
            authorOpenId: message.authorOpenId,
            ...(message.authorDisplayName ? { authorDisplayName: message.authorDisplayName } : {}),
            // 群聊的成员代号（member_n）：昵称可能缺失或被改，代号在同一个群里稳定。
            ...(message.member ? { member: message.member } : {}),
            // 主人发的消息：群聊提炼时也要认得出「这是主人」，不能跟群友混。
            ...(message.speaker?.isOwner ? { isOwner: true } : {}),
            // 这条原本是语音条；落库的 content 是转写后的文字（没配 ASR 就还是 `[语音]`）。
            ...(message.voices?.length ? { hasVoice: true } : {}),
          },
        },
        select: { id: true },
      });
    }
    if (generated.action === "reply") {
      await tx.message.create({
        data: {
          conversationId: conversation.id,
          role: "ASSISTANT",
          content: generated.reply,
          occurredAt: assistantAt,
          metadata: {
            source: "channel",
            platform: input.platform,
            generatedBy: "llm",
            model: generated.model,
            provider: generated.provider,
            promptTemplateVersion: generated.promptTemplateVersion,
            usedMemoryIds: generated.usedMemoryIds,
            usedSnapshotIds: generated.usedSnapshotIds,
            ...(generated.usedCatchphraseIds.length ? { usedCatchphraseIds: generated.usedCatchphraseIds } : {}),
            // 表情段不进 content：正文要能原样重放给下一轮模型，混进 [face] 会被当成用户打的字。
            ...(replyFaces.length ? { faceIds: replyFaces } : {}),
            ...(replySticker ? { stickerId: replySticker.id } : {}),
            // 只记「这一条是语音」，不存音频：音频发完就没了，存下来也没法重放给模型。
            ...(replyVoice ? { voice: true } : {}),
          },
        },
        select: { id: true },
      });
      await tx.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: assistantAt } });
    } else {
      await tx.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: messages[messages.length - 1]!.occurredAt ?? now } });
    }
    return conversation.id;
  });

  if (generated.action === "reply") {
    const replyOptions = replyFaces.length || replySticker || replyVoice || generated.groupDecision?.replyToMessageId
      ? {
          ...(replyFaces.length ? { faces: replyFaces } : {}),
          ...(replySticker
            ? {
                sticker: {
                  id: replySticker.id,
                  filePath: replySticker.filePath,
                  qqEmojiId: replySticker.qqEmojiId ?? null,
                },
              }
            : {}),
          ...(replyVoice && voiceSettings ? { voice: true, voiceSettings } : {}),
          ...(generated.groupDecision?.replyToMessageId ? { replyToMessageId: generated.groupDecision.replyToMessageId } : {}),
        }
      : undefined;
    await input.sendReply(generated.reply, replyOptions);
    // 记一次使用：页面要能看出「哪几张她根本没用过」。写失败不影响已经发出去的回复。
    if (replySticker) {
      await prisma.characterSticker.update({
        where: { id: replySticker.id },
        data: { useCount: { increment: 1 }, lastUsedAt: new Date() },
      }).catch(() => undefined);
    }
    // 梗的记账同理：漏记就等于没有冷却，那句「不烧心吗」会连着刷。
    await markCatchphrasesUsed(character.id, generated.usedCatchphraseIds);
    // 顺手扫一遍群里的梗（开关默认关、6 小时最多一次、不 await）。
    // 放在回复发完之后：扫梗绝不能挡住她说这一句话。
    maybeAutoMineCatchphrases(character.modelConfig, character.id);
  }
  if (generated.usedMemoryIds.length) {
    await prisma.memoryItem.updateMany({
      where: { id: { in: generated.usedMemoryIds } },
      data: { lastRecalledAt: new Date(), recallCount: { increment: 1 } },
    }).catch(() => undefined);
  }
  await recordModelUsage({
    kind: "channel",
    model: chatSettings.model,
    usage: toUsageTokens(generated.usage),
    characterId: input.characterId,
    channelBindingId: input.bindingId,
    conversationId,
  });
  const decision = generated.groupDecision ? { groupDecision: generated.groupDecision } : {};
  return generated.action === "silent"
    ? { status: "silent", conversationId, ...decision }
    : { status: "replied", conversationId, ...decision };
}

/** 单条路径的结果：不传 allowSilent，所以永远不会是 silent。 */
export type ChannelSingleMessageResult =
  | { status: "replied"; conversationId: string }
  | { status: "duplicate" }
  | { status: "ignored"; reason: string };

/** 单条消息（私聊、B站、以及群聊里 @ 她的那一条）。行为与此前一致。 */
export async function handleChannelMessage(input: ChannelMessageInput): Promise<ChannelSingleMessageResult> {
  const result = await runChannelTurn({
    platform: input.platform,
    characterId: input.characterId,
    bindingId: input.bindingId,
    eventType: input.eventType,
    externalConversationId: input.externalConversationId,
    messages: [{
      externalMessageId: input.externalMessageId,
      authorOpenId: input.authorOpenId,
      ...(input.authorPlatformUid ? { authorPlatformUid: input.authorPlatformUid } : {}),
      ...(input.authorDisplayName ? { authorDisplayName: input.authorDisplayName } : {}),
      content: input.content,
      ...(input.images?.length ? { images: input.images } : {}),
      ...(input.voices?.length ? { voices: input.voices } : {}),
      ...(input.speaker ? { speaker: input.speaker } : {}),
    }],
    ...(input.faceCatalog ? { faceCatalog: input.faceCatalog } : {}),
    ...(input.stickerCatalog?.length ? { stickerCatalog: input.stickerCatalog } : {}),
    ...(input.voiceCapable ? { voiceCapable: true } : {}),
    sendReply: input.sendReply,
  });
  // 单条路径不该出现 silent；真出现了就当作没说，别让调用方去处理一个它不可能遇到的状态。
  return result.status === "silent" ? { status: "ignored", reason: "silent" } : result;
}

/** 群聊一轮：几条消息一起看，模型可以决定不说（silent）。 */
export async function handleChannelBatch(input: ChannelBatchInput): Promise<ChannelMessageResult> {
  return runChannelTurn({
    platform: input.platform,
    characterId: input.characterId,
    bindingId: input.bindingId,
    eventType: input.eventType,
    externalConversationId: input.externalConversationId,
    messages: input.messages,
    ...(input.faceCatalog ? { faceCatalog: input.faceCatalog } : {}),
    ...(input.stickerCatalog?.length ? { stickerCatalog: input.stickerCatalog } : {}),
    ...(input.group ? { group: input.group } : {}),
    ...(input.voiceCapable ? { voiceCapable: true } : {}),
    allowSilent: input.allowSilent !== false,
    sendReply: input.sendReply,
  });
}
