import { requireAdminActor } from "../../../utils/auth";
import { getPrisma } from "../../../utils/prisma";

export default defineEventHandler(async (event) => {
  await requireAdminActor(event);
  const prisma = getPrisma();

  const connections = await prisma.platformConnection.findMany({
    orderBy: [{ createdAt: "asc" }],
    select: {
      id: true,
      platform: true,
      displayName: true,
      platformAccountKey: true,
      status: true,
      lastEventAt: true,
      createdAt: true,
      metadata: true,
      characterBindings: {
        where: { status: "ACTIVE" },
        select: { id: true, characterId: true, routingKey: true, character: { select: { name: true } } },
      },
    },
  });

  return {
    connections: connections.map((connection) => ({
      id: connection.id,
      platform: connection.platform,
      displayName: connection.displayName,
      appId: connection.platformAccountKey,
      status: connection.status,
      lastEventAt: connection.lastEventAt?.toISOString() ?? null,
      createdAt: connection.createdAt.toISOString(),
      metadata: connection.metadata,
      bindings: connection.characterBindings.map((binding) => ({
        id: binding.id,
        characterId: binding.characterId,
        characterName: binding.character.name,
        routingKey: binding.routingKey,
      })),
    })),
  };
});
