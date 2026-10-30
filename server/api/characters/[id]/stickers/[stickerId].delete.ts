import { createError, getRouterParam } from "h3";
import { requireActorUserId } from "../../../../utils/auth";
import { requireUuid } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";
import { deleteStickerFile, invalidateStickerCache } from "../../../../utils/stickers";

/** 删一张表情包：库记录与磁盘文件一起删，顺序是先删记录——留孤儿文件比留孤儿记录好排查。 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const stickerId = requireUuid(getRouterParam(event, "stickerId") ?? "", "表情包");
  const prisma = getPrisma();

  const existing = await prisma.characterSticker.findFirst({
    where: { id: stickerId, character: { id, ownerId } },
    select: { id: true, fileName: true },
  });
  if (!existing) throw createError({ statusCode: 404, statusMessage: "表情包不存在。" });

  await prisma.characterSticker.delete({ where: { id: stickerId } });
  await deleteStickerFile(id, existing.fileName);
  invalidateStickerCache(id);
  return { ok: true };
});
