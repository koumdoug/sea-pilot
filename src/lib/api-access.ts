import type { ApiKey } from "@prisma/client";
import { db } from "./db";
import { sha256 } from "./crypto";
import { rateLimit } from "./rate-limit";
import { entitlementForWorkspace } from "./free-access";
import { planAllowsApi } from "./plans";

export type ApiAuth = { ok: true; key: ApiKey } | { ok: false; response: Response };

const json = (data: unknown, status: number) => Response.json(data, { status });

/**
 * Authentification ET autorisation uniques de l'API publique par clé (`/api/v1/*`). Le serveur est l'autorité sur les droits :
 *  - clé inconnue, révoquée ou espace supprimé : 401 ;
 *  - débit dépassé : 429 ;
 *  - abonnement inactif (essai expiré, terminé, impayé hors délai) : 402 ;
 *  - forfait sans accès API : 403. Le droit est relu À CHAQUE APPEL : une clé créée sous un forfait supérieur cesse de fonctionner à la
 *    rétrogradation (sans être supprimée) et refonctionne au retour sur un forfait qui l'inclut.
 * L'espace propriétaire exempté dispose des droits du forfait le plus élevé (accès API compris).
 */
export async function authenticateApiRequest(req: Request): Promise<ApiAuth> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token.startsWith("sp_")) return { ok: false, response: json({ error: "Clé API manquante ou invalide." }, 401) };
  const key = await db.apiKey.findUnique({ where: { keyHash: sha256(token) }, include: { workspace: { include: { subscription: true } } } });
  if (!key || key.revokedAt || key.workspace.deletedAt) return { ok: false, response: json({ error: "Clé API manquante ou invalide." }, 401) };
  if (!rateLimit(`apikey:${key.id}`, 60, 60_000).ok) return { ok: false, response: json({ error: "Limite de débit atteinte (60 requêtes/minute)." }, 429) };
  const ent = await entitlementForWorkspace(key.workspaceId, key.workspace.subscription);
  if (!ent.active) return { ok: false, response: json({ error: "Abonnement inactif." }, 402) };
  if (!planAllowsApi(ent.plan)) return { ok: false, response: json({ error: "L'accès API est réservé au forfait Pro." }, 403) };
  return { ok: true, key };
}
