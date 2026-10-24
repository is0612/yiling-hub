import { createError, getRouterParam } from "h3";
import { requireAdminActor } from "../../../../../utils/auth";
import { requireUuid } from "../../../../../utils/local-api";
import { getPrisma } from "../../../../../utils/prisma";

export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const bindingId = requireUuid(getRouterParam(event, "bindingId") ?? "", "绑定");

  const prisma = getPrisma();
  const binding = await prisma.characterChannelBinding.findUnique({
    where: { id: bindingId },
    select: { id: true },
  });
  if (!binding) throw createError({ statusCode: 404, statusMessage: "绑定不存在。" });

  await prisma.characterChannelBinding.delete({ where: { id: bindingId } });
  return { deleted: true };
});
