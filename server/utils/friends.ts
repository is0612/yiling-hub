/**
 * 「她的朋友」：某个角色认识的某个人。
 *
 * 关系直接落在 `EXTERNAL_IDENTITY` 记忆范围上（`scopeKey` 里带 characterId），所以这里只做
 * 三件事：认人（upsert 外部身份）、开范围、记一次互动。**不新建关系表** —— 新建就得跟记忆
 * 范围两头同步，而这张范围本来就唯一对应「某角色 × 某个人」。
 *
 * 计数口径（和产品对齐过）：
 * - 私聊：对方发来消息就 +1。
 * - 群聊：只有她真的回了谁才 +1（`pipeline.ts` 用 `replyToMessageId`/`atMessageId` 反查作者）。
 *   群里没被搭理的发言不算认识，否则一个活跃群几天就攒出几百个"朋友"。
 *
 * 注意：这里只解决「谁」，不解决「她记得什么」。外部身份范围目前不排记忆提炼
 * （`memory-scheduler.ts` 只给全局和主人私人排），所以这些行是关系记录，不是记忆。
 */

import { getPrisma } from "./prisma";
import { ensureExternalIdentityScope } from "./identity-scope";

export type FriendSource = "PRIVATE" | "GROUP";

export type FriendTouch = {
  identityId: string;
  scopeId: string;
};

/**
 * 记一次互动。调用方一律 `catch` 掉 —— 记朋友这件事绝不能挡住她已生成的那句话。
 */
export async function recordFriendInteraction(input: {
  characterId: string;
  platform: string;
  platformUid: string;
  displayName?: string | null;
  source: FriendSource;
  at?: Date;
}): Promise<FriendTouch | null> {
  const platformUid = (input.platformUid ?? "").trim();
  if (!platformUid) return null;

  const prisma = getPrisma();
  const at = input.at ?? new Date();

  const identity = await prisma.externalIdentity.upsert({
    where: { platform_platformUid: { platform: input.platform, platformUid } },
    create: {
      platform: input.platform,
      platformUid,
      displayName: input.displayName?.slice(0, 255) || null,
      status: "UNVERIFIED",
    },
    // 昵称会改（改一次群名片就变一次），每次遇到都刷成最新的。
    update: {
      ...(input.displayName ? { displayName: input.displayName.slice(0, 255) } : {}),
    },
    select: { id: true },
  });

  const scope = await ensureExternalIdentityScope(input.characterId, input.platform, platformUid, identity.id);

  await prisma.$transaction([
    // 只在还没记过时写来源：群里认识、后来私聊的人，来源仍然是 GROUP。
    prisma.memoryScope.updateMany({
      where: { id: scope.scopeId, firstSource: null },
      data: { firstSource: input.source },
    }),
    prisma.memoryScope.update({
      where: { id: scope.scopeId },
      data: {
        interactionCount: { increment: 1 },
        lastInteractedAt: at,
      },
    }),
  ]);

  return { identityId: identity.id, scopeId: scope.scopeId };
}

/**
 * 单个周期最多给多少个朋友排快照。
 *
 * 与主人私人范围不同，这些范围的数量随朋友数增长，每一个都要单独调一次模型提炼。
 * 宁可让排在后面的晚一轮总结，也不能让一个几百人的群把账单顶上去。
 */
export const MAX_FRIEND_SCOPES_PER_CYCLE = 50;

/**
 * 本周期内需要补排快照的朋友范围。
 *
 * 只挑「这段时间真的说过话」的：没聊过的范围排了也会被 worker 判成 SKIPPED，白占队列。
 * 排序按最近互动倒序 —— 名额有限时先给还在来往的人。
 */
export async function listFriendScopesWithActivity(input: {
  characterId: string;
  since: Date;
  until: Date;
}): Promise<string[]> {
  const prisma = getPrisma();
  const scopes = await prisma.memoryScope.findMany({
    where: {
      characterId: input.characterId,
      scopeType: "EXTERNAL_IDENTITY",
      interactionCount: { gt: 0 },
      conversations: {
        some: {
          OR: [
            { lastMessageAt: { gte: input.since, lte: input.until } },
            { lastMessageAt: null, updatedAt: { gte: input.since, lte: input.until } },
          ],
        },
      },
    },
    orderBy: { lastInteractedAt: "desc" },
    take: MAX_FRIEND_SCOPES_PER_CYCLE,
    select: { id: true },
  });
  return scopes.map((scope) => scope.id);
}
