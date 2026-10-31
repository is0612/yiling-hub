import { requireAdminActor } from "../../../utils/auth";
import { getPrisma } from "../../../utils/prisma";

/**
 * 「她的朋友」：某个角色认识的某个人。
 *
 * **一行 = 一条关系**，不是一个账号。同一个 QQ 号跟两个角色都聊过就有两行 ——
 * 「聊过几次」「从哪认识的」本来就按角色算（关系落在各自的 `EXTERNAL_IDENTITY`
 * 记忆范围上，scopeKey 里带 characterId）。
 *
 * 只返回关系的元信息，不返回任何对话或记忆正文：这里要看的是「谁」，不是「说了什么」。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);

  const prisma = getPrisma();
  const [scopes, characters] = await Promise.all([
    prisma.memoryScope.findMany({
      // `interactionCount > 0` 是硬条件：0 次的行是「在群里出现过但没被搭理」的残留，
      // 不是朋友。旧版群聊会给他们建身份，这些行留着也不该出现在这张页面上。
      where: { scopeType: "EXTERNAL_IDENTITY", externalIdentityId: { not: null }, interactionCount: { gt: 0 } },
      orderBy: [{ lastInteractedAt: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        characterId: true,
        createdAt: true,
        firstSource: true,
        interactionCount: true,
        lastInteractedAt: true,
        character: { select: { name: true } },
        externalIdentity: {
          select: { id: true, platform: true, platformUid: true, displayName: true, status: true, linkedUserId: true },
        },
        _count: { select: { conversations: true } },
      },
    }),
    prisma.character.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, status: true },
    }),
  ]);

  return {
    characters,
    friends: scopes.flatMap((scope) => {
      const identity = scope.externalIdentity;
      if (!identity) return [];
      return [{
        scopeId: scope.id,
        characterId: scope.characterId,
        characterName: scope.character.name,
        identityId: identity.id,
        platform: identity.platform,
        platformUid: identity.platformUid,
        displayName: identity.displayName,
        status: identity.status,
        linkedUserId: identity.linkedUserId,
        interactionCount: scope.interactionCount,
        lastInteractedAt: scope.lastInteractedAt?.toISOString() ?? null,
        // 认识的时间＝这条关系建立的时间，也就是第一次遇到这个人。
        knownSince: scope.createdAt.toISOString(),
        firstSource: scope.firstSource,
        conversationCount: scope._count.conversations,
      }];
    }),
  };
});
