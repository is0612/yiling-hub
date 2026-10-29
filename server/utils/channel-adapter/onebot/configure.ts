/**
 * QQ 小号（OneBot v11）渠道的连接加载 —— 对应官方 QQ 的 configure.ts。
 *
 * 连接凭据（wsUrl / httpUrl / accessToken / httpToken / replyOnlyWhenMentioned）加密存于
 * PlatformConnection.credentialsCiphertext，与官方 QQ 一致。SnowLuma 的 WS token 与 HTTP
 * token 是不同值，故分开存。
 */

import { decryptApiKey } from "../../credential-encryption";
import { getPrisma } from "../../prisma";
import type { OnebotConnectionConfig } from "./client";
import { ONEBOT_PLATFORM } from "./types";

export type OnebotBindingRecord = {
  id: string;
  characterId: string;
  routingKey: string | null;
  /** 群聊限流：每 replyWindowMinutes 分钟最多 replyLimitPerWindow 条；0 条 = 不限。 */
  replyWindowMinutes: number;
  replyLimitPerWindow: number;
  /** 群聊是否仅当被 @ 时才回复（已回退到连接默认值，私聊总是回复）。 */
  replyOnlyWhenMentioned: boolean;
  /** 主人能否在群里触发她刷一轮 B站（已回退到连接默认值）。 */
  groupBiliRunEnabled: boolean;
};

export type OnebotConnectionRecord = {
  id: string;
  platform: string;
  config: OnebotConnectionConfig;
  /** 群聊回复策略的连接级默认值：各 binding 未单独覆盖时生效（私聊总是回复）。 */
  replyOnlyWhenMentioned: boolean;
  /** 是否允许群主/管理员让她拟群公告草稿。连接级，默认关闭。 */
  groupAnnouncementEnabled: boolean;
  /** 「刷一轮 B站」的连接级默认值：各 binding 未单独覆盖时生效。 */
  groupBiliRunEnabled: boolean;
  /** 主人 QQ 号；空 = 未设置，群里 B站 指令不生效。连接级。 */
  ownerQq: string;
  /** 主人称呼（可留空）；留空时回退到外部身份/群名片。 */
  ownerName: string;
  bindings: OnebotBindingRecord[];
  reloadRequestedAt?: string;
};

/**
 * HTTP 默认 3002 不是笔误：协议端默认都在 3000，而 3000 正是本站 dev server 的端口，
 * 撞上就一条消息也发不出去。
 */
export const ONEBOT_DEFAULT_WS_URL = process.env.ONEBOT_WS_URL || "ws://127.0.0.1:3001";
export const ONEBOT_DEFAULT_HTTP_URL = process.env.ONEBOT_HTTP_URL || "http://127.0.0.1:3002";

const ONEBOT_CREDENTIAL_DEFAULTS = {
  wsUrl: ONEBOT_DEFAULT_WS_URL,
  httpUrl: ONEBOT_DEFAULT_HTTP_URL,
};

function readConfig(credentials: string | null, accountKey: string | null): OnebotConnectionConfig {
  let wsUrl = ONEBOT_CREDENTIAL_DEFAULTS.wsUrl;
  let httpUrl = ONEBOT_CREDENTIAL_DEFAULTS.httpUrl;
  let accessToken = process.env.ONEBOT_TOKEN || "";
  let httpToken = process.env.ONEBOT_HTTP_TOKEN || "";

  if (credentials) {
    try {
      const parsed = JSON.parse(credentials) as Record<string, unknown>;
      if (typeof parsed.wsUrl === "string" && parsed.wsUrl.trim()) wsUrl = parsed.wsUrl.trim();
      if (typeof parsed.httpUrl === "string" && parsed.httpUrl.trim()) httpUrl = parsed.httpUrl.trim();
      if (typeof parsed.accessToken === "string") accessToken = parsed.accessToken;
      if (typeof parsed.httpToken === "string") httpToken = parsed.httpToken;
    } catch {
      // Unparsable credentials are ignored; env / defaults apply.
    }
  }

  // Account key can carry the QQ number; not used as a token but kept for reference.
  void accountKey;

  return {
    wsUrl,
    httpUrl,
    ...(accessToken ? { accessToken } : {}),
    ...(httpToken ? { httpToken } : {}),
  };
}

/**
 * 加载所有应服务的 OneBot 连接及其活动角色绑定。凭据残缺（无法解密）的连接被跳过而不崩溃。
 */
export async function loadOnebotConnections(
  platform: string = ONEBOT_PLATFORM,
  /** 仅测试用：读取 DISABLED 连接，避免本机正在运行的适配器把测试连接当成真实连接。 */
  options: { includeDisabled?: boolean } = {},
): Promise<OnebotConnectionRecord[]> {
  const prisma = getPrisma();
  const connections = await prisma.platformConnection.findMany({
    where: options.includeDisabled ? { platform } : { platform, status: { not: "DISABLED" } },
    select: {
      id: true,
      platform: true,
      platformAccountKey: true,
      credentialsCiphertext: true,
      metadata: true,
      characterBindings: {
        where: { status: "ACTIVE" },
        select: { id: true, characterId: true, routingKey: true, config: true },
      },
    },
  });

  const records: OnebotConnectionRecord[] = [];
  for (const connection of connections) {
    let credentials: string | null = null;
    if (connection.credentialsCiphertext) {
      try {
        credentials = await decryptApiKey(Buffer.from(connection.credentialsCiphertext).toString("utf8"));
      } catch (error) {
        console.error("[channel] 解密 OneBot 凭据失败：", error instanceof Error ? error.message : String(error));
        continue;
      }
    }

    const metadata = (connection.metadata ?? {}) as Record<string, unknown>;
    // 连接级默认「仅被 @ 时才回复」：见啥回啥会接走别人的聊天，还容易触发风控。
    const replyOnlyWhenMentioned =
      typeof metadata.replyOnlyWhenMentioned === "boolean" ? metadata.replyOnlyWhenMentioned : true;
    const groupAnnouncementEnabled = metadata.groupAnnouncementEnabled === true;
    const groupBiliRunEnabled = metadata.groupBiliRunEnabled === true;
    const ownerQq = typeof metadata.ownerQq === "string" ? metadata.ownerQq.trim() : "";
    const ownerName = typeof metadata.ownerName === "string" ? metadata.ownerName.trim() : "";

    records.push({
      id: connection.id,
      platform: connection.platform,
      config: readConfig(credentials, connection.platformAccountKey),
      replyOnlyWhenMentioned,
      groupAnnouncementEnabled,
      groupBiliRunEnabled,
      ownerQq,
      ownerName,
      reloadRequestedAt: typeof metadata.onebotReloadRequestedAt === "string"
        ? metadata.onebotReloadRequestedAt : undefined,
      bindings: connection.characterBindings.map((binding) => {
        const config = (binding.config && typeof binding.config === "object" && !Array.isArray(binding.config))
          ? binding.config as Record<string, unknown>
          : {};
        const rawWindow = config.replyWindowMinutes;
        // 老字段 replyLimitPer10Min 迁移：窗口固定 10 分钟、条数原样带过来。
        const rawLimit = config.replyLimitPerWindow ?? config.replyLimitPer10Min;
        return {
          id: binding.id,
          characterId: binding.characterId,
          routingKey: binding.routingKey,
          replyWindowMinutes: typeof rawWindow === "number" && Number.isFinite(rawWindow) && rawWindow >= 1
            ? Math.min(Math.round(rawWindow), 1440)
            : 10,
          replyLimitPerWindow: typeof rawLimit === "number" && Number.isFinite(rawLimit) && rawLimit > 0
            ? Math.min(Math.round(rawLimit), 100)
            : 0,
          // binding 没写就沿用连接默认值，这样老数据不丢、新绑定也有个起点。
          replyOnlyWhenMentioned: typeof config.replyOnlyWhenMentioned === "boolean"
            ? config.replyOnlyWhenMentioned
            : replyOnlyWhenMentioned,
          groupBiliRunEnabled: typeof config.groupBiliRunEnabled === "boolean"
            ? config.groupBiliRunEnabled
            : groupBiliRunEnabled,
        };
      }),
    });
  }
  return records;
}
