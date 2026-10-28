import { createError, readBody } from "h3";
import type { Prisma } from "../../../src/generated/prisma/client";
import { characterInclude, toCharacterDto } from "../../utils/character-dto";
import { readChatModelSettingsPatch } from "../../utils/chat-model-config";
import { encryptApiKey } from "../../utils/credential-encryption";
import { requireActorUserId } from "../../utils/auth";
import { readTrimmedString, requireUuid } from "../../utils/local-api";
import { getPrisma } from "../../utils/prisma";
import { readProactivePatch, resolveProactiveSettings } from "../../utils/proactive-settings";

export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
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
  if (body.examples !== undefined) data.styleExamples = readTrimmedString(body.examples, "对话示例", 8000);
  // 空字符串是合法值：表示这个角色不特意称呼用户，不要回填默认的「主人」。
  if (body.userAddress !== undefined) data.userAddress = readTrimmedString(body.userAddress, "她对你的称呼", 40);

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

  // 额度与预算都是 0 = 不限（预算则回落到默认值），所以允许 0。
  const numericLimits: Array<[string, string, number]> = [
    ["dailyTokenLimit", "每日 token 额度", 100_000_000],
    ["memoryTokenBudget", "记忆 token 预算", 20_000],
    ["snapshotTokenBudget", "快照 token 预算", 20_000],
  ];
  for (const [key, label, max] of numericLimits) {
    const raw = body[key];
    if (raw === undefined) continue;
    const value = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > max) {
      throw createError({ statusCode: 400, statusMessage: `${label}必须是 0 到 ${max} 之间的数字。` });
    }
    modelConfigPatch[key] = Math.round(value);
  }

  if (body.emojiEnabled !== undefined) {
    if (typeof body.emojiEnabled !== "boolean") {
      throw createError({ statusCode: 400, statusMessage: "表情开关必须是布尔值。" });
    }
    modelConfigPatch.emojiEnabled = body.emojiEnabled;
  }

  // 主动找话的设置也挂在 modelConfig 上，但走独立的校验：写入侧宁可报错也不夹取。
  if (body.proactive !== undefined) {
    const current = config.proactive && typeof config.proactive === "object" && !Array.isArray(config.proactive)
      ? config.proactive as Record<string, unknown>
      : {};
    try {
      const patch = readProactivePatch(body.proactive);
      // 存归一化后的完整对象：读的时候就有确定值可对照，不必再猜「这个字段到底存没存过」。
      modelConfigPatch.proactive = resolveProactiveSettings({ proactive: { ...current, ...patch } });
    } catch (error) {
      throw createError({ statusCode: 400, statusMessage: error instanceof Error ? error.message : "主动找话设置无效。" });
    }
  }

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
