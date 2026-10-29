import { createError, getRouterParam, readBody } from "h3";
import type { Prisma } from "../../../../../../src/generated/prisma/client";
import { requireAdminActor } from "../../../../../utils/auth";
import { readTrimmedString, requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";

/**
 * Binds a character to a QQ connection. An optional routingKey limits the binding to a single
 * group openid; when omitted the binding is the connection's default (receives any group event).
 */
export default defineEventHandler(async (event) => {
  const admin = await requireAdminActor(event);
  const connectionId = requireUuid(getRouterParam(event, "id") ?? "", "渠道连接");
  const body = await readBody<Record<string, unknown>>(event);

  const characterId = requireUuid(readTrimmedString(body?.characterId, "角色", 100, { required: true }), "角色");
  const routingKey = readTrimmedString(body?.routingKey, "路由键", 255) || null;

  let replyWindowMinutes: number | undefined;
  if (body?.replyWindowMinutes !== undefined) {
    const value = body.replyWindowMinutes;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1440) {
      throw createError({ statusCode: 400, statusMessage: "限流窗口必须是 1 到 1440 分钟的整数。" });
    }
    replyWindowMinutes = value;
  }
  let replyLimitPerWindow: number | undefined;
  if (body?.replyLimitPerWindow !== undefined) {
    const value = body.replyLimitPerWindow;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
      throw createError({ statusCode: 400, statusMessage: "窗口内回复上限必须是 0 到 100 的整数。" });
    }
    replyLimitPerWindow = value;
  }
  // 兼容旧客户端：replyLimitPer10Min 等价于窗口 10 分钟。
  if (body?.replyLimitPer10Min !== undefined) {
    const value = body.replyLimitPer10Min;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
      throw createError({ statusCode: 400, statusMessage: "每 10 分钟回复上限必须是 0 到 100 的整数。" });
    }
    replyLimitPerWindow = value;
    replyWindowMinutes = 10;
  }
  // 群聊回复策略 + 刷 B站：都是可选的 boolean，未提交 = 保留原值（或沿用连接默认值）。
  let replyOnlyWhenMentioned: boolean | undefined;
  if (body?.replyOnlyWhenMentioned !== undefined) {
    if (typeof body.replyOnlyWhenMentioned !== "boolean") {
      throw createError({ statusCode: 400, statusMessage: "「仅被 @ 时回复」必须是布尔值。" });
    }
    replyOnlyWhenMentioned = body.replyOnlyWhenMentioned;
  }
  let groupBiliRunEnabled: boolean | undefined;
  if (body?.groupBiliRunEnabled !== undefined) {
    if (typeof body.groupBiliRunEnabled !== "boolean") {
      throw createError({ statusCode: 400, statusMessage: "「刷一轮 B站」必须是布尔值。" });
    }
    groupBiliRunEnabled = body.groupBiliRunEnabled;
  }

  const prisma = getPrisma();
  const connection = await prisma.platformConnection.findUnique({
    where: { id: connectionId },
    select: { id: true },
  });
  if (!connection) throw createError({ statusCode: 404, statusMessage: "渠道连接不存在。" });

  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId: admin.user.id },
    select: { id: true },
  });
  if (!character) throw createError({ statusCode: 404, statusMessage: "角色不存在或不属于当前账号。" });

  const existing = await prisma.characterChannelBinding.findUnique({
    where: { characterId_connectionId: { characterId, connectionId } },
    select: { config: true },
  });
  const baseConfig = (existing?.config && typeof existing.config === "object" && !Array.isArray(existing.config))
    ? existing.config as Record<string, unknown>
    : {};
  // 未提交任何行为字段时保留原配置：重新绑定时不能把已有群规悄悄清掉。
  const patch: Record<string, unknown> = {};
  if (replyWindowMinutes !== undefined) patch.replyWindowMinutes = replyWindowMinutes;
  if (replyLimitPerWindow !== undefined) patch.replyLimitPerWindow = replyLimitPerWindow;
  if (replyOnlyWhenMentioned !== undefined) patch.replyOnlyWhenMentioned = replyOnlyWhenMentioned;
  if (groupBiliRunEnabled !== undefined) patch.groupBiliRunEnabled = groupBiliRunEnabled;
  const hasUpdate = Object.keys(patch).length > 0;
  const config = hasUpdate ? { ...baseConfig, ...patch } : (existing?.config ?? undefined);
  const configForWrite = config as Prisma.InputJsonObject | undefined;
  const binding = await prisma.characterChannelBinding.upsert({
    where: { characterId_connectionId: { characterId, connectionId } },
    create: { characterId, connectionId, status: "ACTIVE", routingKey, ...(configForWrite ? { config: configForWrite } : {}) },
    update: {
      status: "ACTIVE",
      routingKey,
      ...(hasUpdate && configForWrite ? { config: configForWrite } : {}),
    },
    select: { id: true, characterId: true, connectionId: true, routingKey: true, config: true },
  });

  return binding;
});
