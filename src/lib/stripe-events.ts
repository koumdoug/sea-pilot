import { Prisma } from "@prisma/client";
import { db } from "./db";

/**
 * Registre des événements Stripe : la clé primaire (identifiant d'événement Stripe) rend la prise en charge ATOMIQUE, quel que soit le nombre de serveurs.
 *  - processing : réservé par un exécuteur, pour la durée du bail ;
 *  - processed  : effets appliqués et validés (jamais repris) ;
 *  - failed     : traitement interrompu par une erreur (repris à la prochaine livraison de Stripe, qui réessaie sur erreur HTTP).
 * Un événement `processing` dont le bail a expiré (serveur interrompu en cours de traitement) est repris de la même façon.
 * Une écriture impossible dans ce registre fait échouer la requête AVANT tout effet : Stripe réessaiera.
 */
export const EVENT_LEASE_MS = 120_000;

export type EventClaim = { kind: "claimed" } | { kind: "duplicate"; state: "processed" | "processing" };

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

export async function claimStripeEvent(id: string, type: string, now = new Date()): Promise<EventClaim> {
  const lockedUntil = new Date(now.getTime() + EVENT_LEASE_MS);
  try {
    await db.stripeEvent.create({ data: { id, type, status: "processing", lockedUntil } });
    return { kind: "claimed" };
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
  }
  // L'événement existe déjà : seule une reprise conditionnelle (une seule requête SQL) peut le réserver à nouveau.
  const taken = await db.stripeEvent.updateMany({
    where: { id, OR: [{ status: "failed" }, { status: "processing", lockedUntil: { lt: now } }] },
    data: { status: "processing", lockedUntil, attempts: { increment: 1 }, error: null },
  });
  if (taken.count === 1) return { kind: "claimed" };
  const row = await db.stripeEvent.findUnique({ where: { id }, select: { status: true } });
  return { kind: "duplicate", state: row?.status === "processed" ? "processed" : "processing" };
}

export async function completeStripeEvent(id: string, r: { workspaceId?: string | null; outcome: "handled" | "ignored" | "needs_review"; note?: string }) {
  await db.stripeEvent.update({ where: { id }, data: { status: "processed", lockedUntil: null, processedAt: new Date(), workspaceId: r.workspaceId ?? null, outcome: r.outcome, note: r.note?.slice(0, 300) ?? null, error: null } });
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

export async function failStripeEvent(id: string, error: string) {
  await db.stripeEvent.update({ where: { id }, data: { status: "failed", lockedUntil: null, error: error.slice(0, 300) } });
}
