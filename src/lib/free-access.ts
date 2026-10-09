import { db } from "./db";
import { env } from "./env";
import { entitlement, exemptEntitlement, type Entitlement, type SubscriptionLike } from "./plans";

/**
 * Exception de facturation du propriétaire, strictement côté serveur :
 *  - la liste vient de la variable d'environnement FREE_ACCESS_USER_IDS (jamais du navigateur) ;
 *  - l'identité provient de la session signée (identifiant d'utilisateur relu en base) ;
 *  - seul le rôle « owner » de l'espace concerné est exempté (pas les membres invités) ;
 *  - liste vide (par défaut) = aucune exception.
 * Les protections d'authentification, d'autorisation par rôle et d'isolation restent inchangées.
 */
export function isFreeOwner(userId: string, role: string): boolean {
  return role === "owner" && env.freeAccessUserIds.includes(userId);
}

/** Droits d'un espace hors contexte de session (API par clé, quotas IA, campagnes) : exempté si un propriétaire listé le possède. */
export async function entitlementForWorkspace(workspaceId: string, sub: SubscriptionLike | null): Promise<Entitlement> {
  const ids = env.freeAccessUserIds;
  if (ids.length && (await db.membership.count({ where: { workspaceId, role: "owner", userId: { in: ids } } })) > 0) return exemptEntitlement();
  return entitlement(sub);
}
