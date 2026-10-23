import { characterInclude, toCharacterDto } from "../../utils/character-dto";
import { requireLocalDevOwner } from "../../utils/local-api";
import { getPrisma } from "../../utils/prisma";

export default defineEventHandler(async (event) => {
  const ownerId = requireLocalDevOwner(event);
  const characters = await getPrisma().character.findMany({
    where: { ownerId },
    include: characterInclude,
    orderBy: { updatedAt: "desc" },
  });

  return characters.map(toCharacterDto);
});
