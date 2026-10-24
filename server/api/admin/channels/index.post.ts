import { createError, readBody } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { encryptApiKey } from "../../../utils/credential-encryption";
import { readTrimmedString } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";

const PLATFORM = "qq";

/**
 * Creates or updates a QQ bot connection. The AppSecret is AES-256-GCM encrypted before it is
 * stored, and the AppID doubles as the unique account key. Only the adapter ever decrypts it.
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const body = await readBody<Record<string, unknown>>(event);

  const appId = readTrimmedString(body?.appId, "AppID", 100, { required: true });
  const appSecret = readTrimmedString(body?.appSecret, "AppSecret", 500, { required: true });
  const displayName = readTrimmedString(body?.displayName, "显示名", 120) || `QQ 机器人 ${appId}`;

  const prisma = getPrisma();
  const credentialsCiphertext = Buffer.from(await encryptApiKey(JSON.stringify({ appId, appSecret })), "utf8");

  const connection = await prisma.platformConnection.upsert({
    where: { platform_platformAccountKey: { platform: PLATFORM, platformAccountKey: appId } },
    create: {
      platform: PLATFORM,
      platformAccountKey: appId,
      displayName,
      status: "DISCONNECTED",
      credentialsCiphertext,
      metadata: { appId },
    },
    update: {
      displayName,
      credentialsCiphertext,
      metadata: { appId },
    },
    select: { id: true, platform: true, displayName: true, platformAccountKey: true, status: true },
  });

  return {
    id: connection.id,
    platform: connection.platform,
    displayName: connection.displayName,
    appId: connection.platformAccountKey,
    status: connection.status,
  };
});
