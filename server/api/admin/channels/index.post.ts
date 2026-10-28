import { createError, readBody } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { decryptApiKey, encryptApiKey } from "../../../utils/credential-encryption";
import { readTrimmedString } from "../../../utils/local-api";
import { parseDutyInput } from "../../../utils/channel-adapter/bili/configure";
import { getPrisma } from "../../../utils/prisma";

/**
 * Creates or updates a channel connection.
 *
 * - QQ OneBot：WS/HTTP 地址与 Token 用 AES-256-GCM 加密入库，QQ 号兼作唯一账号键。
 * - B站：无 AppID/AppSecret，值班设置（dataHome / biliBin / duty）写入 metadata；
 *        登录凭证沿用 bili-cli 自己的 credential.json，不随代码、不入库。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const body = await readBody<Record<string, unknown>>(event);
  const platform = readTrimmedString(body?.platform, "平台", 50);

  if (platform === "qq-onebot") {
    return createOnebotConnection(body);
  }
  if (platform === "bili") {
    return createBiliConnection(body);
  }
  throw createError({ statusCode: 400, statusMessage: "不支持该平台，目前支持 qq-onebot / bili。" });
});

async function createOnebotConnection(body: Record<string, unknown>) {
  const qqNumber = readTrimmedString(body?.qqNumber, "QQ 号", 100, { required: true });
  const displayName = readTrimmedString(body?.displayName, "显示名", 120) || `QQ 小号 ${qqNumber}`;
  const replyOnlyWhenMentioned = typeof body?.replyOnlyWhenMentioned === "boolean" ? body.replyOnlyWhenMentioned : false;
  const submittedWsUrl = readTrimmedString(body?.wsUrl, "WS 地址", 500);
  const submittedHttpUrl = readTrimmedString(body?.httpUrl, "HTTP API 地址", 500);
  const submittedAccessToken = readTrimmedString(body?.accessToken, "WS Token", 500);
  const submittedHttpToken = readTrimmedString(body?.httpToken, "HTTP Token", 500);

  const prisma = getPrisma();

  // 凭据加密入库，接口不回显，所以编辑时填不出旧值。
  // 约定：地址/Token 留空 = 沿用已保存的值，否则改一次显示名就把 Token 清空了。
  let oldCredentials: Record<string, unknown> = {};
  const existing = await prisma.platformConnection.findUnique({
    where: { platform_platformAccountKey: { platform: "qq-onebot", platformAccountKey: qqNumber } },
    select: { credentialsCiphertext: true },
  });
  if (existing?.credentialsCiphertext) {
    try {
      const plain = await decryptApiKey(Buffer.from(existing.credentialsCiphertext).toString("utf8"));
      oldCredentials = JSON.parse(plain) as Record<string, unknown>;
    } catch {
      // 解不开就按「没有旧值」处理，让用户重新填。
    }
  }
  const reuse = (submitted: string, key: string) => {
    if (submitted) return submitted;
    return typeof oldCredentials[key] === "string" ? (oldCredentials[key] as string) : "";
  };

  const wsUrl = reuse(submittedWsUrl, "wsUrl") || "ws://127.0.0.1:3001";
  const httpUrl = reuse(submittedHttpUrl, "httpUrl") || "http://127.0.0.1:3000";
  const accessToken = reuse(submittedAccessToken, "accessToken");
  const httpToken = reuse(submittedHttpToken, "httpToken");

  const credentialsCiphertext = Buffer.from(await encryptApiKey(JSON.stringify({
    wsUrl,
    httpUrl,
    accessToken,
    httpToken,
  })), "utf8");

  const connection = await prisma.platformConnection.upsert({
    where: { platform_platformAccountKey: { platform: "qq-onebot", platformAccountKey: qqNumber } },
    create: {
      platform: "qq-onebot",
      platformAccountKey: qqNumber,
      displayName,
      status: "DISCONNECTED",
      credentialsCiphertext,
      metadata: { qqNumber, replyOnlyWhenMentioned },
    },
    update: {
      displayName,
      credentialsCiphertext,
      metadata: { qqNumber, replyOnlyWhenMentioned },
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
}

async function createBiliConnection(body: Record<string, unknown>) {
  const dataHome = readTrimmedString(body?.dataHome, "数据目录", 500);
  const biliBin = readTrimmedString(body?.biliBin, "bili 可执行文件路径", 500);
  const displayName = readTrimmedString(body?.displayName, "显示名", 120) || "B站 账号";

  const prisma = getPrisma();
  // B站连接没有唯一的 platformAccountKey 来源，用 dataHome 或生成稳定键。
  // 用 displayName 作为账号键容易重复，改用 dataHome（若提供）否则用固定单例键。
  const accountKey = dataHome || "bili-default";

  // 值班设置（可选，缺省用 BILI_DUTY_DEFAULTS）：
  // 这个接口同时承担「改连接信息」，所以必须和库里已有的 duty 合并后再规范化。
  // 早期这里是照着表单重新拼一份 duty，把没在表单里的字段（frames / taste /
  // 私信收件人）直接冲成了默认值 —— 从渠道管理点一次保存，值班台上填过的东西就没了。
  const existing = await prisma.platformConnection.findUnique({
    where: { platform_platformAccountKey: { platform: "bili", platformAccountKey: accountKey } },
    select: { metadata: true },
  });
  const oldMetadata = (existing?.metadata && typeof existing.metadata === "object" ? existing.metadata : {}) as Record<string, unknown>;
  const oldDuty = (oldMetadata.duty && typeof oldMetadata.duty === "object" ? oldMetadata.duty : {}) as Record<string, unknown>;
  const dutyRaw = (body?.duty && typeof body.duty === "object" ? body.duty : {}) as Record<string, unknown>;
  const duty = parseDutyInput({ ...oldDuty, ...dutyRaw });

  const connection = await prisma.platformConnection.upsert({
    where: { platform_platformAccountKey: { platform: "bili", platformAccountKey: accountKey } },
    create: {
      platform: "bili",
      platformAccountKey: accountKey,
      displayName,
      status: "DISCONNECTED",
      metadata: { ...oldMetadata, dataHome, biliBin, duty },
    },
    update: {
      displayName,
      metadata: { ...oldMetadata, dataHome, biliBin, duty },
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
}
