import { decryptApiKey } from "../credential-encryption";
import { getPrisma } from "../prisma";
import { QQ_PLATFORM } from "./types";

export type QqBindingRecord = { id: string; characterId: string; routingKey: string | null };

export type QqConnectionRecord = {
  id: string;
  platform: string;
  appId: string;
  appSecret: string;
  bindings: QqBindingRecord[];
};

/**
 * Loads every QQ connection the adapter should service, decrypting its stored AppSecret and
 * attaching the active character bindings. A connection with undecryptable or incomplete
 * credentials is skipped rather than crashing the adapter loop.
 */
export async function loadQqConnections(platform: string = QQ_PLATFORM): Promise<QqConnectionRecord[]> {
  const prisma = getPrisma();
  const connections = await prisma.platformConnection.findMany({
    where: { platform, status: { not: "DISABLED" } },
    select: {
      id: true,
      platform: true,
      platformAccountKey: true,
      credentialsCiphertext: true,
      characterBindings: { where: { status: "ACTIVE" }, select: { id: true, characterId: true, routingKey: true } },
    },
  });

  const records: QqConnectionRecord[] = [];
  for (const connection of connections) {
    if (!connection.credentialsCiphertext) continue;
    let appId = "";
    let appSecret = "";
    try {
      const plain = await decryptApiKey(Buffer.from(connection.credentialsCiphertext).toString("utf8"));
      const parsed = JSON.parse(plain) as { appId?: unknown; appSecret?: unknown };
      if (typeof parsed.appId === "string") appId = parsed.appId.trim();
      if (typeof parsed.appSecret === "string") appSecret = parsed.appSecret.trim();
    } catch (error) {
      console.error("[channel] 解密 QQ 凭据失败：", error instanceof Error ? error.message : String(error));
      continue;
    }
    appId = appId || (connection.platformAccountKey ?? "");
    if (!appId || !appSecret) continue;

    records.push({
      id: connection.id,
      platform: connection.platform,
      appId,
      appSecret,
      bindings: connection.characterBindings.map((binding) => ({
        id: binding.id,
        characterId: binding.characterId,
        routingKey: binding.routingKey,
      })),
    });
  }
  return records;
}
