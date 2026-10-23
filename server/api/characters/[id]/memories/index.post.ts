import { createError, getRouterParam, readBody } from "h3";
import { requireLocalDevOwner, requireUuid, readTrimmedString } from "../../../../utils/local-api";
import { getPrisma } from "../../../../utils/prisma";

const memoryCategories = [
  "FACT",
  "PREFERENCE",
  "RELATIONSHIP",
  "COMMITMENT",
  "GOAL",
  "EVENT",
  "SUMMARY",
  "OTHER",
] as const;

type MemoryCategory = (typeof memoryCategories)[number];

export default defineEventHandler(async (event) => {
  const ownerId = requireLocalDevOwner(event);
  const characterId = requireUuid(getRouterParam(event, "id") ?? "", "角色");
  const body = await readBody<Record<string, unknown>>(event);
  const content = readTrimmedString(body?.content, "记忆内容", 12000, { required: true });
  const categoryInput = body?.category;
  if (typeof categoryInput !== "string" || !(memoryCategories as readonly string[]).includes(categoryInput)) {
    throw createError({ statusCode: 400, statusMessage: "记忆分类无效。" });
  }
  const category = categoryInput as MemoryCategory;
  const prisma = getPrisma();

  const character = await prisma.character.findFirst({
    where: { id: characterId, ownerId },
    select: {
      id: true,
      memoryScopes: {
        where: { scopeType: "CHARACTER_GLOBAL" },
        select: { id: true },
        take: 1,
      },
    },
  });
  if (!character) {
    throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  }

  const memoryScopeId = character.memoryScopes[0]?.id;
  if (!memoryScopeId) {
    throw createError({ statusCode: 409, statusMessage: "该角色还没有全局记忆范围，请先重新保存角色档案。" });
  }

  const memory = await prisma.memoryItem.create({
    data: { memoryScopeId, category, content, status: "ACTIVE" },
    select: { id: true, category: true, content: true, status: true, createdAt: true, updatedAt: true },
  });
  setResponseStatus(event, 201);
  return memory;
});
