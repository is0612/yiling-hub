import { resolveChatModelSettings } from "./chat-model-config";

export type CharacterDto = {
  id: string;
  name: string;
  alias: string;
  description: string;
  avatar: string;
  avatarTone: "purple" | "peach" | "mint" | "blue";
  status: "运行中" | "已暂停" | "未连接";
  channels: string[];
  intervalDays: number;
  nextSnapshot: string;
  memoryCount: number;
  latestSnapshot: string;
  personality: string;
  chatModel: string;
  chatTemperature: number;
  chatMaxTokens: number;
  chatApiBaseUrl: string;
  chatApiKeyConfigured: boolean;
  chatApiKeySource: "character" | "environment" | "missing";
};

type CharacterRecord = {
  id: string;
  name: string;
  avatar: string | null;
  basePrompt: string;
  status: "ACTIVE" | "PAUSED" | "ARCHIVED";
  modelConfig: unknown;
  memorySetting: {
    snapshotIntervalDays: number;
    timezone: string;
    nextSnapshotAt: Date | null;
    autoSnapshotEnabled: boolean;
  } | null;
  channelBindings: Array<{ connection: { displayName: string } }>;
  memoryScopes: Array<{
    memoryItems: Array<{ id: string }>;
    snapshots: Array<{ createdAt: Date }>;
  }>;
};

export const characterInclude = {
  memorySetting: true,
  channelBindings: { include: { connection: { select: { displayName: true } } } },
  memoryScopes: {
    include: {
      memoryItems: { where: { status: "ACTIVE" as const }, select: { id: true } },
      snapshots: {
        where: { status: "CURRENT" as const },
        orderBy: { createdAt: "desc" as const },
        take: 1,
        select: { createdAt: true },
      },
    },
  },
} as const;

function asConfig(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function formatDate(value: Date, timeZone = "Asia/Shanghai"): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      month: "2-digit",
      day: "2-digit",
    }).format(value).replace("/", " 月 ").replace("/", " 日");
  } catch {
    return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(value);
  }
}

const AVATAR_TONES = ["purple", "peach", "mint", "blue"] as const;

/** 头像配色：优先用角色配置，没有就按名字首字稳定派生，保证同一角色每次颜色一致。 */
export function resolveAvatarTone(name: string, config: Record<string, unknown>): CharacterDto["avatarTone"] {
  const configuredTone = config.avatarTone;
  return AVATAR_TONES.includes(configuredTone as (typeof AVATAR_TONES)[number])
    ? (configuredTone as CharacterDto["avatarTone"])
    : (AVATAR_TONES[name.codePointAt(0)! % AVATAR_TONES.length] ?? "purple");
}

export function toCharacterDto(input: unknown): CharacterDto {
  const character = input as CharacterRecord;
  const config = asConfig(character.modelConfig);
  const chatSettings = resolveChatModelSettings(config);
  const avatarTone = resolveAvatarTone(character.name, config);
  const setting = character.memorySetting;
  const snapshots = character.memoryScopes.flatMap((scope) => scope.snapshots.map((snapshot) => snapshot.createdAt));
  const latestSnapshot = snapshots.sort((a, b) => b.getTime() - a.getTime())[0];

  let nextSnapshot = "尚未计划";
  if (setting && !setting.autoSnapshotEnabled) {
    nextSnapshot = "已暂停";
  } else if (setting?.nextSnapshotAt) {
    try {
      nextSnapshot = new Intl.DateTimeFormat("zh-CN", {
        timeZone: setting.timezone,
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(setting.nextSnapshotAt);
    } catch {
      nextSnapshot = setting.nextSnapshotAt.toISOString();
    }
  }

  return {
    id: character.id,
    name: character.name,
    alias: typeof config.alias === "string" ? config.alias : "自定义角色",
    description: typeof config.description === "string" ? config.description : "",
    avatar: character.avatar || character.name.slice(0, 1),
    avatarTone,
    status: character.status === "ACTIVE" ? "运行中" : character.status === "PAUSED" ? "已暂停" : "未连接",
    channels: character.channelBindings.map((binding) => binding.connection.displayName),
    intervalDays: setting?.snapshotIntervalDays ?? 8,
    nextSnapshot,
    memoryCount: character.memoryScopes.reduce((total, scope) => total + scope.memoryItems.length, 0),
    latestSnapshot: latestSnapshot ? formatDate(latestSnapshot, setting?.timezone) : "暂无总结",
    personality: character.basePrompt,
    chatModel: chatSettings.model,
    chatTemperature: chatSettings.temperature,
    chatMaxTokens: chatSettings.maxTokens,
    chatApiBaseUrl: chatSettings.apiBaseUrl,
    chatApiKeyConfigured: chatSettings.apiKeyConfigured,
    chatApiKeySource: chatSettings.apiKeySource,
  };
}
