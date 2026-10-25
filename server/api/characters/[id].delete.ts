import { createError } from "h3";
import { requireActorUserId } from "../../utils/auth";
import { requireUuid } from "../../utils/local-api";
import { getPrisma } from "../../utils/prisma";

/**
 * 删除一个角色及其全部关联数据。
 *
 * 级联关系（见 prisma/schema.prisma）：
 *   - CharacterChannelBinding → onDelete: Cascade（自动删绑定）
 *   - CharacterMemorySetting → onDelete: Cascade（自动删记忆设置）
 *   - AuditLog.characterId → onDelete: SetNull（自动置空）
 *   - Conversation → onDelete: Restrict（必须先删会话）
 *   - MemoryScope → onDelete: Restrict（必须先删记忆范围）
 *
 * 所以删除顺序必须是（事务内）：会话 → 记忆范围 → 角色。
 * 会话下的 Message 是 Cascade，记忆范围下的 MemoryItem/Snapshot/Job 是 Cascade，
 * 会随之自动删除。
 */
export default defineEventHandler(async (event) => {
  const ownerId = await requireActorUserId(event);
  const id = requireUuid(getRouterParam(event, "id") ?? "");
  const prisma = getPrisma();

  const existing = await prisma.character.findFirst({ where: { id, ownerId } });
  if (!existing) throw createError({ statusCode: 404, statusMessage: "角色不存在。" });

  await prisma.$transaction(async (tx) => {
    // 1. 删会话（Message 级联删）
    await tx.conversation.deleteMany({ where: { characterId: id } });
    // 2. 删记忆范围（MemoryItem / MemorySnapshot / MemoryJob 级联删）
    await tx.memoryScope.deleteMany({ where: { characterId: id } });
    // 3. 删角色（ChannelBinding / MemorySetting 级联删，AuditLog 置空）
    await tx.character.delete({ where: { id } });
  });

  return { ok: true, id, name: existing.name };
});
