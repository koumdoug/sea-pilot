import { db } from "./db";
import { env } from "./env";
import { entitlement, exemptEntitlement, type Entitlement, type SubscriptionLike } from "./plans";

/**
 * Exception de facturation du propriétaire, strictement côté serveur :
 *  - la liste vient de la variable d'environnement FREE_ACCESS_USER_IDS (jamais du navigateur) ;
 *  - l'identité provient de la session signée (identifiant d'utilisateur relu en base) ;
 *  - RÈGLE UNIQUE, portée par l'ESPACE : un espace est exempté si un utilisateur listé en est « owner » (voir isExemptWorkspace).
 *    Elle s'applique de la même façon à l'interface, aux actions, aux API par clé et aux quotas ; les membres invités par ce propriétaire
 *    travaillent donc dans un espace exempté. Un utilisateur listé qui n'est que membre ou administrateur de l'espace d'un autre n'exempte PAS cet espace ;
 *  - liste vide (par défaut) = aucune exception.
 * Les protections d'authentification, d'autorisation par rôle et d'isolation restent inchangées.
 */
export function isFreeOwner(userId: string, role: string): boolean {
  return role === "owner" && env.freeAccessUserIds.includes(userId);
}

/** Vrai si un propriétaire listé possède l'espace. Aucune requête quand la liste est vide (cas par défaut). */
export async function isExemptWorkspace(workspaceId: string): Promise<boolean> {
  const ids = env.freeAccessUserIds;
  return ids.length > 0 && (await db.membership.count({ where: { workspaceId, role: "owner", userId: { in: ids } } })) > 0;
}

/** Droits d'un espace, avec ou sans session (interface, API par clé, quotas IA, campagnes) : même règle partout. */
export async function entitlementForWorkspace(workspaceId: string, sub: SubscriptionLike | null): Promise<Entitlement> {
  return (await isExemptWorkspace(workspaceId)) ? exemptEntitlement() : entitlement(sub);
}
