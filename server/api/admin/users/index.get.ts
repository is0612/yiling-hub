import { requireAdminActor } from "../../../utils/auth";
import { getPrisma } from "../../../utils/prisma";

/**
 * Account list for the administrator. Returns identity and activity counts only — never any
 * character, conversation or memory content. Admins manage who can log in, not what those users
 * talk about.
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);

  const prisma = getPrisma();
  const [users, activity] = await Promise.all([
    prisma.user.findMany({
      orderBy: [{ createdAt: "asc" }],
      select: {
        id: true,
        username: true,
        email: true,
        displayName: true,
        role: true,
        status: true,
        createdAt: true,
        _count: { select: { ownedCharacters: true } },
      },
    }),
    prisma.session.groupBy({ by: ["userId"], _max: { lastUsedAt: true } }),
  ]);

  const lastActiveByUser = new Map(activity.map((entry) => [entry.userId, entry._max.lastUsedAt]));

  return {
    users: users.map((user) => ({
      id: user.id,
      username: user.username,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt.toISOString(),
      characterCount: user._count.ownedCharacters,
      lastActiveAt: lastActiveByUser.get(user.id)?.toISOString() ?? null,
    })),
  };
});
