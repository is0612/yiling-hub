import { createError, readBody } from "h3";
import type { Prisma } from "../../../src/generated/prisma/client";
import { characterInclude, toCharacterDto } from "../../utils/character-dto";
import { readChatModelSettingsPatch } from "../../utils/chat-model-config";
import { encryptApiKey } from "../../utils/credential-encryption";
import { readTrimmedString, requireLocalDevOwner, requireUuid } from "../../utils/local-api";
import { getPrisma } from "../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = requireLocalDevOwner(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "");
  const body = await readBody<Record<string, unknown>>(event);
  const prisma = getPrisma();
  const existing = await prisma.character.findFirst({ where: { id, ownerId } });
  if (!existing) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  const config = existing.modelConfig && typeof existing.modelConfig === "object" && !Array.isArray(existing.modelConfig)
    ? existing.modelConfig as Record<string, unknown>
    : {};
  const data: Prisma.CharacterUpdateInput = {};

  if (body.name !== undefined) data.name = readTrimmedString(body.name, "角色名称", 100, { required: true });
  if (body.personality !== undefined) data.basePrompt = readTrimmedString(body.personality, "基础人设", 12000);

  if (body.status !== undefined) {
    const statusMap: Record<string, "ACTIVE" | "PAUSED" | "ARCHIVED"> = {
      "运行中": "ACTIVE", "已暂停": "PAUSED", "未连接": "ARCHIVED",
    };
    if (typeof body.status !== "string" || !statusMap[body.status]) {
      throw createError({ statusCode: 400, statusMessage: "无效的角色状态。" });
    }
    data.status = statusMap[body.status];
  }

  const modelConfigPatch: Record<string, unknown> = {};
  if (body.alias !== undefined) modelConfigPatch.alias = readTrimmedString(body.alias, "角色标签", 100);
  if (body.description !== undefined) modelConfigPatch.description = readTrimmedString(body.description, "角色简介", 2000);

  let settingsPatch;
  try {
    settingsPatch = readChatModelSettingsPatch(body);
  } catch (error) {
    throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : "角色模型参数无效。" });
  }
  const { chatApiKey, clearApiKey, ...safeSettingsPatch } = settingsPatch;
  Object.assign(modelConfigPatch, safeSettingsPatch);

  if (Object.keys(modelConfigPatch).length > 0 || chatApiKey || clearApiKey) {
    const nextConfig: Record<string, unknown> = { ...config, ...modelConfigPatch };
    if (clearApiKey) delete nextConfig.chatApiKeyEncrypted;
    if (chatApiKey) nextConfig.chatApiKeyEncrypted = await encryptApiKey(chatApiKey);
    data.modelConfig = nextConfig as Prisma.InputJsonObject;
  }

  const updated = await prisma.character.update({
    where: { id },
    data,
    include: characterInclude,
  });
  return toCharacterDto(updated);
});
