import type { Prisma } from "@prisma/client";
import { db } from "./db";

/**
 * Politique des clés API : une clé appartient à l'ESPACE, pas à la personne qui l'a créée (`createdById` n'est qu'une indication, sans clé étrangère).
 * Retirer un membre ne révoque donc JAMAIS ses clés (aucune intégration du client n'est interrompue automatiquement) : on les DÉTECTE pour que le propriétaire
 * ou un administrateur les voie, les journalise au retrait, et laisse la révocation manuelle (Paramètres → Clés API) à leur décision.
 */
export type KeyOfRemovedMember = { id: string; name: string; prefix: string; createdAt: Date; lastUsedAt: Date | null };

type Client = Pick<Prisma.TransactionClient, "apiKey" | "membership">;

/** Clés actives de l'espace créées par quelqu'un qui n'en est plus membre (retiré, ou compte supprimé). Les clés sans créateur connu ne sont pas concernées. */
export async function activeKeysOfRemovedMembers(workspaceId: string, client: Client = db): Promise<KeyOfRemovedMember[]> {
  const keys = await client.apiKey.findMany({
    where: { workspaceId, revokedAt: null, createdById: { not: null } }, orderBy: { createdAt: "asc" },
    select: { id: true, name: true, prefix: true, createdAt: true, lastUsedAt: true, createdById: true },
  });
  if (!keys.length) return [];
  const creators = [...new Set(keys.map((k) => k.createdById as string))];
  const still = new Set((await client.membership.findMany({ where: { workspaceId, userId: { in: creators } }, select: { userId: true } })).map((m) => m.userId));
  return keys.filter((k) => !still.has(k.createdById as string)).map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt }));
}

/** Clés actives créées par un membre donné (avant son retrait) : nom et préfixe seulement, jamais le secret. */
export function activeKeysCreatedBy(workspaceId: string, userId: string, client: Client = db) {
  return client.apiKey.findMany({ where: { workspaceId, createdById: userId, revokedAt: null }, orderBy: { createdAt: "asc" }, select: { id: true, name: true, prefix: true } });
}
