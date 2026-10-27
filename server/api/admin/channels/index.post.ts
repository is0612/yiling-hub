import { createError, readBody } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { encryptApiKey } from "../../../utils/credential-encryption";
import { readTrimmedString } from "../../../utils/local-api";
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
  const wsUrl = readTrimmedString(body?.wsUrl, "WS 地址", 500) || "ws://127.0.0.1:3001";
  const httpUrl = readTrimmedString(body?.httpUrl, "HTTP API 地址", 500) || "http://127.0.0.1:3000";
  const accessToken = readTrimmedString(body?.accessToken, "WS Token", 500);
  const httpToken = readTrimmedString(body?.httpToken, "HTTP Token", 500);
  const qqNumber = readTrimmedString(body?.qqNumber, "QQ 号", 100, { required: true });
  const displayName = readTrimmedString(body?.displayName, "显示名", 120) || `QQ 小号 ${qqNumber}`;
  const replyOnlyWhenMentioned = typeof body?.replyOnlyWhenMentioned === "boolean" ? body.replyOnlyWhenMentioned : false;

  const prisma = getPrisma();
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

  // 值班设置（可选，缺省用 BILI_DUTY_DEFAULTS）
  const dutyRaw = (body?.duty && typeof body.duty === "object" ? body.duty : {}) as Record<string, unknown>;
  const duty = {
    perDay: readDutyNumber(dutyRaw.perDay, 5, 0, 50),
    peakValley: typeof dutyRaw.peakValley === "boolean" ? dutyRaw.peakValley : true,
    noon: typeof dutyRaw.noon === "boolean" ? dutyRaw.noon : true,
    night: typeof dutyRaw.night === "boolean" ? dutyRaw.night : true,
    keywords: Array.isArray(dutyRaw.keywords)
      ? dutyRaw.keywords.filter((k): k is string => typeof k === "string" && k.trim().length > 0).map((k) => k.trim()).slice(0, 20)
      : [],
    zone: readTrimmedString(dutyRaw.zone, "分区", 50) || "all",
    frames: readDutyNumber(dutyRaw.frames, 0, 0, 30),
    autoComment: typeof dutyRaw.autoComment === "boolean" ? dutyRaw.autoComment : false,
    commentPerRound: readDutyNumber(dutyRaw.commentPerRound, 1, 0, 20),
    mentionName: readTrimmedString(dutyRaw.mentionName, "提及", 100),
    dmMode: dutyRaw.dmMode === "both" || dutyRaw.dmMode === "off" ? dutyRaw.dmMode : "only",
  };

  const prisma = getPrisma();
  // B站连接没有唯一的 platformAccountKey 来源，用 dataHome 或生成稳定键。
  // 用 displayName 作为账号键容易重复，改用 dataHome（若提供）否则用固定单例键。
  const accountKey = dataHome || "bili-default";

  const connection = await prisma.platformConnection.upsert({
    where: { platform_platformAccountKey: { platform: "bili", platformAccountKey: accountKey } },
    create: {
      platform: "bili",
      platformAccountKey: accountKey,
      displayName,
      status: "DISCONNECTED",
      metadata: { dataHome, biliBin, duty },
    },
    update: {
      displayName,
      metadata: { dataHome, biliBin, duty },
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

function readDutyNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, Math.min(max, n));
}
