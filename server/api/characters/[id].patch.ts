import { createError, readBody } from "h3";
import type { Prisma } from "../../../src/generated/prisma/client";
import { characterInclude, toCharacterDto } from "../../utils/character-dto";
import { readTrimmedString, requireLocalDevOwner, requireUuid } from "../../utils/local-api";
import { getPrisma } from "../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = requireLocalDevOwner(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "");
  const body = await readBody<Record<string, unknown>>(event);
  const prisma = getPrisma();
  const existing = await prisma.character.findFirst({ where: { id, ownerId } });

  if (!existing) {
    throw createError({ statusCode: 404, statusMessage: "角色不存在。" });
  }

  const config = existing.modelConfig && typeof existing.modelConfig === "object" && !Array.isArray(existing.modelConfig)
    ? existing.modelConfig as Prisma.InputJsonObject
    : {};
  const data: Prisma.CharacterUpdateInput = {};

  if (body.name !== undefined) {
    data.name = readTrimmedString(body.name, "角色名称", 100, { required: true });
  }
  if (body.personality !== undefined) {
    data.basePrompt = readTrimmedString(body.personality, "基础人设", 12000);
  }

  if (body.status !== undefined) {
    const statusMap: Record<string, "ACTIVE" | "PAUSED" | "ARCHIVED"> = {
      "运行中": "ACTIVE", "已暂停": "PAUSED", "未连接": "ARCHIVED",
    };
    if (typeof body.status !== "string" || !statusMap[body.status]) {
      throw createError({ statusCode: 400, statusMessage: "无效的角色状态。" });
    }
    data.status = statusMap[body.status];
  }

  if (body.alias !== undefined || body.description !== undefined) {
    data.modelConfig = {
      ...config,
      ...(body.alias !== undefined ? { alias: readTrimmedString(body.alias, "角色标签", 100) } : {}),
      ...(body.description !== undefined ? { description: readTrimmedString(body.description, "角色简介", 2000) } : {}),
    };
  }

  const updated = await prisma.character.update({
    where: { id },
    data,
    include: characterInclude,
  });

  return toCharacterDto(updated);
});
