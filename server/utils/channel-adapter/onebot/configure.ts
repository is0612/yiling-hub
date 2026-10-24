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

export type OnebotBindingRecord = { id: string; characterId: string; routingKey: string | null };

export type OnebotConnectionRecord = {
  id: string;
  platform: string;
  config: OnebotConnectionConfig;
  /** 群聊中是否仅当被 @ 时才回复（私聊总是回复）。 */
  replyOnlyWhenMentioned: boolean;
  bindings: OnebotBindingRecord[];
};

const ONEBOT_CREDENTIAL_DEFAULTS = {
  wsUrl: process.env.ONEBOT_WS_URL || "ws://127.0.0.1:3001",
  httpUrl: process.env.ONEBOT_HTTP_URL || "http://127.0.0.1:3000",
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
export async function loadOnebotConnections(platform: string = ONEBOT_PLATFORM): Promise<OnebotConnectionRecord[]> {
  const prisma = getPrisma();
  const connections = await prisma.platformConnection.findMany({
    where: { platform, status: { not: "DISABLED" } },
    select: {
      id: true,
      platform: true,
      platformAccountKey: true,
      credentialsCiphertext: true,
      metadata: true,
      characterBindings: { where: { status: "ACTIVE" }, select: { id: true, characterId: true, routingKey: true } },
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
    const replyOnlyWhenMentioned =
      typeof metadata.replyOnlyWhenMentioned === "boolean" ? metadata.replyOnlyWhenMentioned : false;

    records.push({
      id: connection.id,
      platform: connection.platform,
      config: readConfig(credentials, connection.platformAccountKey),
      replyOnlyWhenMentioned,
      bindings: connection.characterBindings.map((binding) => ({
        id: binding.id,
        characterId: binding.characterId,
        routingKey: binding.routingKey,
      })),
    });
  }
  return records;
}
