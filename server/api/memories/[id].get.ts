import { createError, getRouterParam } from "h3";
import { requireLocalDevOwner, requireUuid } from "../../../utils/local-api";
import { getPrisma } from "../../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = requireLocalDevOwner(event);
  const memoryId = requireUuid(getRouterParam(event, "id") ?? "", "记忆");
  const prisma = getPrisma();
  const memory = await prisma.memoryItem.findFirst({
    where: {
      id: memoryId,
      memoryScope: { is: { character: { is: { ownerId } } } },
    },
    select: {
      id: true,
      category: true,
      content: true,
      status: true,
      confidence: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!memory) {
    throw createError({ statusCode: 404, statusMessage: "长期记忆不存在。" });
  }
  return memory;
});
