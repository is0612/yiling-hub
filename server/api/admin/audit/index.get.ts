import { getQuery } from "h3";
import { requireAdminActor } from "../../../utils/auth";
import { getPrisma } from "../../../utils/prisma";

/**
 * Recent audit activity for the administrator. Defaults to authentication events (login, logout,
 * registration, password change, session revocation); an exact `action` may be supplied to filter.
 */
export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const query = getQuery(event);
  const limitRaw = typeof query.limit === "string" ? Number(query.limit) : 50;
  const limit = Number.isInteger(limitRaw) && limitRaw >= 1 && limitRaw <= 200 ? limitRaw : 50;
  const action = typeof query.action === "string" && query.action ? query.action : "";

  const prisma = getPrisma();
  const logs = await prisma.auditLog.findMany({
    where: action ? { action } : { action: { startsWith: "auth." } },
    orderBy: [{ createdAt: "desc" }],
    take: limit,
    select: {
      id: true,
      action: true,
      entityType: true,
      entityId: true,
      details: true,
      createdAt: true,
      actor: { select: { username: true, displayName: true } },
    },
  });

  return {
    items: logs.map((log) => ({
      id: log.id,
      action: log.action,
      entityType: log.entityType,
      entityId: log.entityId,
      details: log.details,
      createdAt: log.createdAt.toISOString(),
      actor: log.actor ? (log.actor.displayName || log.actor.username) : null,
    })),
  };
});
