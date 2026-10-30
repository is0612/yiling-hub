import { createError, getRouterParam, readBody } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { readTrimmedString, requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { invalidateStickerCache, toStickerDto } from "../../../../utils/stickers";

/** 改名字、使用场景，或临时停用一张（图留着）。 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const stickerId = requireUuid(getRouterParam(event, "stickerId") ?? "", "表情包");
  const body = await readBody<Record<string, unknown>>(event);
  const prisma = getPrisma();

  const existing = await prisma.characterSticker.findFirst({
    where: { id: stickerId, character: { id, ownerId } },
  });
  if (!existing) throw createError({ statusCode: 404, statusMessage: "表情包不存在。" });

  const data: { name?: string; usage?: string; enabled?: boolean } = {};
  if (body.name !== undefined) data.name = readTrimmedString(body.name, "表情包名字", 60, { required: true });
  if (body.usage !== undefined) data.usage = readTrimmedString(body.usage, "使用场景", 200);
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") throw createError({ statusCode: 400, statusMessage: "enabled 必须是布尔值。" });
    data.enabled = body.enabled;
  }
  if (!Object.keys(data).length) throw createError({ statusCode: 400, statusMessage: "没有要更新的字段。" });

  const row = await prisma.characterSticker.update({ where: { id: stickerId }, data });
  invalidateStickerCache(id);
  return toStickerDto(row);
});
