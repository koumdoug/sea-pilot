import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "./db";

/**
 * Registre des événements Stripe : la clé primaire (identifiant d'événement Stripe) rend la prise en charge ATOMIQUE, quel que soit le nombre de serveurs.
 *  - processing : réservé par un exécuteur, pour la durée du bail ;
 *  - processed  : effets appliqués et validés (jamais repris), SAUF un `needs_review` « prix inconnu » (UNKNOWN_PRICE_NOTE) : rien n'y a été appliqué, un renvoi
 *                 volontaire de l'événement (tableau de bord Stripe) après correction de la configuration le traite à nouveau, au plus une fois par UNKNOWN_PRICE_RETRY_MS (condition atomique) ;
 *  - failed     : traitement interrompu par une erreur (repris à la prochaine livraison de Stripe, qui réessaie sur erreur HTTP).
 * Un événement `processing` dont le bail a expiré (serveur interrompu en cours de traitement) est repris de la même façon.
 * Une écriture impossible dans ce registre fait échouer la requête AVANT tout effet : Stripe réessaiera.
 *
 * FENCING : chaque prise en charge (création ou reprise) reçoit un jeton de propriété unique (`leaseToken`), renvoyé à l'appelant et enregistré avec le bail. Seul l'exécuteur qui détient le jeton
 * actuellement enregistré peut finaliser (`completeStripeEvent`) ou faire échouer (`failStripeEvent`) l'événement : un exécuteur dont le bail a expiré et a été repris ne peut plus écraser l'état
 * du nouveau propriétaire. La finalisation n'exige PAS que le bail soit encore valide : tant que personne ne l'a repris, le jeton enregistré reste celui de l'ancien exécuteur, qui peut terminer.
 * Limite : le jeton protège le REGISTRE, pas les effets métier déjà exécutés avant la perte du bail (ils doivent rester idempotents, ce que garantit la relecture de l'état chez Stripe).
 * Les lignes historiques (`leaseToken` NULL, créées avant ce correctif) restent reprenables : leur reprise attribue un jeton.
 */
export const EVENT_LEASE_MS = 120_000;
/** Préfixe de la note d'un événement dont le prix Stripe n'est pas reconnu : seul cas où un événement `processed` est repris (rien n'avait été appliqué). */
export const UNKNOWN_PRICE_NOTE = "unknown_price:";
/** Délai minimal entre deux traitements d'un même événement « prix inconnu » : un renvoi plus rapide reste un doublon (aucune lecture Stripe ni écriture). */
export const UNKNOWN_PRICE_RETRY_MS = 5 * 60_000;

export type EventClaim = { kind: "claimed"; leaseToken: string } | { kind: "duplicate"; state: "processed" | "processing" };

/** Le jeton de bail n'est plus celui du registre : un autre exécuteur a repris l'événement (ou il est déjà finalisé). L'exécuteur ne doit RIEN écrire de plus dans le registre. */
export class StripeEventLeaseLostError extends Error {
  constructor(readonly eventId: string) {
    super(`Bail du registre Stripe perdu pour l'événement ${eventId} : repris par un autre exécuteur ou déjà finalisé.`);
    this.name = "StripeEventLeaseLostError";
  }
}

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

export async function claimStripeEvent(id: string, type: string, now = new Date()): Promise<EventClaim> {
  const lockedUntil = new Date(now.getTime() + EVENT_LEASE_MS);
  const leaseToken = randomUUID(); // nouveau jeton à CHAQUE prise en charge, jamais réutilisé
  try {
    await db.stripeEvent.create({ data: { id, type, status: "processing", lockedUntil, leaseToken } });
    return { kind: "claimed", leaseToken };
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
  }
  // L'événement existe déjà : seule une reprise conditionnelle (une seule requête SQL) peut le réserver à nouveau.
  const taken = await db.stripeEvent.updateMany({
    where: { id, OR: [{ status: "failed" }, { status: "processing", lockedUntil: { lt: now } }, { status: "processed", outcome: "needs_review", note: { startsWith: UNKNOWN_PRICE_NOTE }, processedAt: { lt: new Date(now.getTime() - UNKNOWN_PRICE_RETRY_MS) } }] },
    data: { status: "processing", lockedUntil, leaseToken, attempts: { increment: 1 }, error: null }, // le jeton de l'ancien exécuteur est remplacé dans la même requête atomique
  });
  if (taken.count === 1) return { kind: "claimed", leaseToken };
  const row = await db.stripeEvent.findUnique({ where: { id }, select: { status: true } });
  return { kind: "duplicate", state: row?.status === "processed" ? "processed" : "processing" };
}

/**
 * Finalise l'événement SI ET SEULEMENT SI l'appelant détient encore le jeton enregistré et que l'événement est `processing` (une seule requête conditionnelle).
 * Sinon (repris par un autre exécuteur, ou déjà finalisé) : `StripeEventLeaseLostError`, aucune écriture. L'expiration de `lockedUntil` n'est volontairement PAS testée.
 */
export async function completeStripeEvent(id: string, leaseToken: string, r: { workspaceId?: string | null; outcome: "handled" | "ignored" | "needs_review"; note?: string }) {
  const done = await db.stripeEvent.updateMany({
    where: { id, leaseToken, status: "processing" },
    data: { status: "processed", lockedUntil: null, leaseToken: null, processedAt: new Date(), workspaceId: r.workspaceId ?? null, outcome: r.outcome, note: r.note?.slice(0, 300) ?? null, error: null },
  });
  if (done.count !== 1) throw new StripeEventLeaseLostError(id);
}

/**
 * Rétention du registre. Stripe réessaie une livraison pendant 3 jours au plus et le tableau de bord permet de renvoyer un événement jusqu'à 30 jours :
 * un événement `processed` est donc conservé 90 jours (largement au-delà de toute rejouabilité) avant purge. Un événement `processing` n'est JAMAIS purgé
 * (bail en cours ou reprise à venir) ; un événement `failed` est conservé 180 jours pour diagnostic puisqu'il reste repris par les réessais de Stripe.
 */
export const PROCESSED_EVENT_RETENTION_MS = 90 * 86_400_000;
export const FAILED_EVENT_RETENTION_MS = 180 * 86_400_000;

export async function purgeStripeEvents(now = new Date()): Promise<{ processed: number; failed: number }> {
  const processed = await db.stripeEvent.deleteMany({ where: { status: "processed", processedAt: { lt: new Date(now.getTime() - PROCESSED_EVENT_RETENTION_MS) } } });
  const failed = await db.stripeEvent.deleteMany({ where: { status: "failed", updatedAt: { lt: new Date(now.getTime() - FAILED_EVENT_RETENTION_MS) } } });
  return { processed: processed.count, failed: failed.count };
}

/**
 * Marque l'événement `failed` SI ET SEULEMENT SI l'appelant détient encore le jeton. Ne lève JAMAIS pour une perte de bail : l'erreur d'origine du traitement ne doit pas être masquée.
 * Renvoie `true` si l'état a été écrit, `false` si l'événement appartient désormais à un autre exécuteur (ou est déjà finalisé) : il n'est alors pas touché.
 */
export async function failStripeEvent(id: string, leaseToken: string, error: string): Promise<boolean> {
  const r = await db.stripeEvent.updateMany({ where: { id, leaseToken, status: "processing" }, data: { status: "failed", lockedUntil: null, leaseToken: null, error: error.slice(0, 300) } });
  return r.count === 1;
}
