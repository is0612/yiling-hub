import { requireAdminActor } from "../../../utils/auth";
import { getPrisma } from "../../../utils/prisma";

/**
 * 外部身份列表。管理员用它查看"哪些平台的外部用户跟角色互动过"，并决定是否
 * 把某个外部身份绑定到站内用户（跨平台身份打通）。只展示身份元信息，不展示对话/记忆正文。
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);

  const prisma = getPrisma();
  const identities = await prisma.externalIdentity.findMany({
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      platform: true,
      platformUid: true,
      displayName: true,
      status: true,
      linkedUserId: true,
      connectionId: true,
      verifiedAt: true,
      createdAt: true,
      updatedAt: true,
      linkedUser: { select: { id: true, username: true, email: true } },
      memoryScopes: {
        select: {
          id: true,
          characterId: true,
          character: { select: { name: true } },
        },
      },
    },
  });

  return {
    identities: identities.map((identity) => ({
      id: identity.id,
      platform: identity.platform,
      platformUid: identity.platformUid,
      displayName: identity.displayName,
      status: identity.status,
      linkedUserId: identity.linkedUserId,
      linkedUsername: identity.linkedUser?.username ?? null,
      linkedEmail: identity.linkedUser?.email ?? null,
      verifiedAt: identity.verifiedAt?.toISOString() ?? null,
      createdAt: identity.createdAt.toISOString(),
      updatedAt: identity.updatedAt.toISOString(),
      characters: identity.memoryScopes.map((scope) => ({
        characterId: scope.characterId,
        characterName: scope.character.name,
      })),
    })),
  };
});
