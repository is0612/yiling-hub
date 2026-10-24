import { randomUUID } from "node:crypto";
import { readBody } from "h3";
import { characterInclude, toCharacterDto } from "../../utils/character-dto";
import { readTrimmedString, requireLocalDevOwner } from "../../utils/local-api";
import { getPrisma } from "../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = requireLocalDevOwner(event);
  const body = await readBody<Record<string, unknown>>(event);
  const name = readTrimmedString(body.name, "角色名称", 100, { required: true });
  const alias = readTrimmedString(body.alias, "角色标签", 100) || "新建角色";
  const description = readTrimmedString(body.description, "角色简介", 2000);
  const personality = readTrimmedString(body.personality, "基础人设", 12000);
  const avatarTone = body.avatarTone === "purple" || body.avatarTone === "peach" || body.avatarTone === "blue"
    ? body.avatarTone
    : "mint";
  const prisma = getPrisma();

  const characterId = randomUUID();
  const created = await prisma.character.create({
    data: {
      id: characterId,
      ownerId,
      name,
      avatar: name.slice(0, 1),
      basePrompt: personality || "请补充角色的人设与行为规则。",
      status: "PAUSED",
      modelConfig: { alias, description, avatarTone },
      memoryScopes: {
        create: {
          scopeType: "CHARACTER_GLOBAL",
          scopeKey: `character:${characterId}:global`,
        },
      },
      memorySetting: {
        create: {
          snapshotIntervalDays: 8,
          timezone: "Asia/Shanghai",
          anchorAt: new Date(),
          autoSnapshotEnabled: false,
          rawMessageRetentionDays: null,
          rawMessageCleanupEnabled: false,
        },
      },
    },
    include: characterInclude,
  });

  setResponseStatus(event, 201);
  return toCharacterDto(created);
});
