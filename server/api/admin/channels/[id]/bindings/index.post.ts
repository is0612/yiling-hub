import { createError, getRouterParam, readBody } from "h3";
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

  const binding = await prisma.characterChannelBinding.upsert({
    where: { characterId_connectionId: { characterId, connectionId } },
    create: { characterId, connectionId, status: "ACTIVE", routingKey },
    update: { status: "ACTIVE", routingKey },
    select: { id: true, characterId: true, connectionId: true, routingKey: true },
  });

  return binding;
});
