import { createHmac } from "node:crypto";
import type { Prisma, Subscription } from "@prisma/client";
import { db } from "./db";
import { env } from "./env";
import { randomToken, safeEqual } from "./crypto";
import { audit } from "./audit";
import { PLAN_IDS, type PlanId } from "./constants";
import { PLANS, comparePlans, downgradeBlockers, entitlement, isLiveSubscription, planOrNull, type PlanLimits } from "./plans";
import { log, errMsg } from "./logger";
import { claimStripeEvent, completeStripeEvent, failStripeEvent } from "./stripe-events";

export class BillingError extends Error {}

export const stripeConfigured = () => !!env.stripeSecret;
export const planPriceId = (plan: string) => env.stripePriceId(plan);

/** Événements Stripe à déclarer sur le point de terminaison /api/stripe/webhook (les droits payants ne sont accordés que par eux). */
export const STRIPE_WEBHOOK_EVENTS = ["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "customer.subscription.paused", "customer.subscription.resumed", "checkout.session.expired", "invoice.paid", "invoice.payment_failed"] as const;

export type StripeSetup = {
  /** Variables serveur attendues et leur état (noms seulement : aucune valeur n'est jamais lue ici). */
  variables: { name: string; set: boolean }[];
  /** Incohérences de configuration (deux forfaits sur le même prix Stripe, par exemple). */
  issues: string[];
  /** Un forfait est souscriptible seulement si la clé, SON prix ET le secret de webhook sont définis et si les prix sont distincts. */
  ready: Record<PlanId, boolean>;
  /** Au moins un forfait peut être souscrit. */
  anyReady: boolean;
};

/** État de la configuration du paiement. Sans secret de webhook, un paiement ne serait jamais confirmé (le forfait ne changerait pas) : la souscription reste donc indisponible. */
export function stripeSetup(): StripeSetup {
  const secret = !!env.stripeSecret, hook = !!env.stripeWebhookSecret;
  const prices = Object.fromEntries(PLAN_IDS.map((p) => [p, planPriceId(p) ?? ""])) as Record<PlanId, string>;
  const issues: string[] = [];
  for (const id of PLAN_IDS) for (const other of PLAN_IDS) if (id < other && prices[id] && prices[id] === prices[other]) issues.push(`Les forfaits ${PLANS[id].name} et ${PLANS[other].name} utilisent le même prix Stripe (STRIPE_PRICE_${id.toUpperCase()} et STRIPE_PRICE_${other.toUpperCase()}) : le forfait ne pourrait pas être reconnu.`);
  if (secret && !hook) issues.push("STRIPE_WEBHOOK_SECRET manque : un paiement ne serait jamais confirmé, donc le forfait ne changerait pas. La souscription reste désactivée.");
  const duplicated = new Set(PLAN_IDS.filter((id) => prices[id] && PLAN_IDS.some((o) => o !== id && prices[o] === prices[id])));
  const ready = Object.fromEntries(PLAN_IDS.map((id) => [id, secret && hook && !!prices[id] && !duplicated.has(id)])) as Record<PlanId, boolean>;
  return {
    variables: [
      { name: "STRIPE_SECRET_KEY", set: secret },
      ...PLAN_IDS.map((id) => ({ name: `STRIPE_PRICE_${id.toUpperCase()}`, set: !!prices[id] })),
      { name: "STRIPE_WEBHOOK_SECRET", set: hook },
    ],
    issues, ready, anyReady: PLAN_IDS.some((id) => ready[id]),
  };
}
export const planCheckoutReady = (plan: string): boolean => (PLAN_IDS as readonly string[]).includes(plan) && stripeSetup().ready[plan as PlanId];

/** Erreur HTTP de l'API Stripe (le statut distingue « introuvable » d'une panne). */
export class StripeHttpError extends BillingError {
  constructor(message: string, readonly status: number) { super(message); }
}

async function stripe<T = Record<string, unknown>>(method: "GET" | "POST", path: string, body?: Record<string, string>, opts: { idempotencyKey?: string } = {}): Promise<T> {
  if (!env.stripeSecret) throw new BillingError("Stripe n'est pas configuré (STRIPE_SECRET_KEY manquant).");
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method, headers: { authorization: `Bearer ${env.stripeSecret}`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}), ...(opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {}) },
    body: body ? new URLSearchParams(body).toString() : undefined, signal: AbortSignal.timeout(25_000),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) { log.error("stripe.error", { path, status: res.status }); throw new StripeHttpError((j.error as { message?: string } | undefined)?.message ?? `Stripe : erreur HTTP ${res.status}`, res.status); }
  return j as T;
}

export type StripeSub = {
  id: string; customer?: string; status: string; cancel_at_period_end?: boolean; current_period_end?: number; trial_end?: number | null; canceled_at?: number | null;
  metadata?: Record<string, string>; items?: { data: { price?: { id?: string }; current_period_end?: number }[] };
};
export type StripeEvent = { id: string; type: string; data: { object: Record<string, unknown> } };

/**
 * Accès à l'API Stripe, injectable : l'état d'un abonnement est TOUJOURS relu chez Stripe (jamais déduit d'un événement qui peut être ancien),
 * et les sessions de paiement sont créées, relues et expirées par ce seul point d'entrée. Les tests fournissent une implémentation en mémoire.
 */
export interface StripeGateway {
  getSubscription(id: string): Promise<StripeSub | null>;
  getCheckoutSession(id: string): Promise<{ status: string } | null>;
  expireCheckoutSession(id: string): Promise<void>;
  createCustomer(p: { email: string; workspaceId: string }): Promise<{ id: string }>;
  createCheckoutSession(body: Record<string, string>, idempotencyKey: string): Promise<{ id: string; url?: string }>;
}
const isNotFound = (e: unknown) => e instanceof StripeHttpError && e.status === 404;
export const liveStripeGateway: StripeGateway = {
  async getSubscription(id) { try { return await stripe<StripeSub>("GET", `/subscriptions/${encodeURIComponent(id)}`); } catch (e) { if (isNotFound(e)) return null; throw e; } },
  async getCheckoutSession(id) { try { return await stripe<{ status: string }>("GET", `/checkout/sessions/${encodeURIComponent(id)}`); } catch (e) { if (isNotFound(e)) return null; throw e; } },
  async expireCheckoutSession(id) { await stripe("POST", `/checkout/sessions/${encodeURIComponent(id)}/expire`, {}); },
  createCustomer: (p) => stripe<{ id: string }>("POST", "/customers", { email: p.email, "metadata[workspaceId]": p.workspaceId }, { idempotencyKey: `customer:${p.workspaceId}` }),
  createCheckoutSession: (body, idempotencyKey) => stripe<{ id: string; url?: string }>("POST", "/checkout/sessions", body, { idempotencyKey }),
};
let gateway: StripeGateway = liveStripeGateway;
/** Remplace la passerelle Stripe (tests uniquement) ; `null` rétablit la passerelle réelle. */
export const setStripeGateway = (g: StripeGateway | null) => { gateway = g ?? liveStripeGateway; };

/** Début du mois calendaire UTC (1er à 00:00:00.000 UTC) : période de comptage des leads, sans lien avec la période de facturation Stripe. */
export function currentMonthStartUtc(now = new Date()): Date {
  const d = new Date(now); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Usage courant. Leads : mois calendaire UTC, hors prospects effacés (`deletedAt`), comme tous les autres compteurs de leads ; leur seuil est informatif. */
export async function workspaceUsage(workspaceId: string, client: Prisma.TransactionClient = db): Promise<Record<keyof PlanLimits, number>> {
  const monthStart = currentMonthStartUtc();
  const [members, activeCampaigns, landingPages, leadsPerMonth, sequences, integrations, apiKeys] = await Promise.all([
    client.membership.count({ where: { workspaceId } }),
    client.campaign.count({ where: { workspaceId, status: "active" } }),
    client.landingPage.count({ where: { workspaceId, status: { not: "archived" } } }),
    client.lead.count({ where: { workspaceId, deletedAt: null, createdAt: { gte: monthStart } } }),
    client.followUpSequence.count({ where: { workspaceId } }),
    client.integration.count({ where: { workspaceId, status: { not: "disconnected" } } }),
    client.apiKey.count({ where: { workspaceId, revokedAt: null } }),
  ]);
  return { members, activeCampaigns, landingPages, leadsPerMonth, aiGenerationsPerDay: 0, sequences, integrations, apiKeys };
}

/** Essai : le plan peut être changé librement tant qu'aucun abonnement Stripe n'existe. */
export async function selectTrialPlan(workspaceId: string, plan: string, actorId?: string | null) {
  if (!(PLAN_IDS as readonly string[]).includes(plan)) throw new BillingError("Plan inconnu.");
  const sub = await db.subscription.findUnique({ where: { workspaceId } });
  if (!sub) throw new BillingError("Aucun abonnement.");
  if (sub.stripeSubscriptionId) throw new BillingError("Un abonnement payant est en cours : utilisez le changement de plan.");
  if (sub.status !== "trialing") throw new BillingError("Le changement de plan sans paiement n'est possible que pendant l'essai.");
  if (!sub.trialEndsAt || sub.trialEndsAt.getTime() <= Date.now()) throw new BillingError("Votre essai gratuit est terminé : choisissez un plan payant pour continuer.");
  const blockers = comparePlans(sub.plan, plan) === "downgrade" ? downgradeBlockers(PLANS[plan as PlanId], await workspaceUsage(workspaceId)) : [];
  if (blockers.length) throw new BillingError(`Impossible : votre usage dépasse les limites du plan (${blockers.join(" ; ")}).`);
  await db.subscription.update({ where: { workspaceId }, data: { plan } });
  await audit({ workspaceId, userId: actorId, action: "billing.trial_plan_selected", meta: { plan } });
}

/** Une session de paiement ouverte vit un peu plus de 30 minutes (minimum imposé par Stripe), puis expire d'elle-même. */
export const CHECKOUT_SESSION_TTL_MS = 31 * 60_000;
/** Bail de la réservation tant que la session n'est pas encore créée chez Stripe. */
export const CHECKOUT_PENDING_LEASE_MS = 120_000;

/** Statuts Stripe qui ouvrent des droits (actif, essai Stripe, impayé en délai de grâce). */
const isEntitledStripeStatus = (s: string) => ["active", "past_due"].includes(STATUS_MAP[s] ?? "");

/**
 * Réservation ATOMIQUE d'une tentative de souscription (une seule requête SQL conditionnelle, valable entre plusieurs serveurs) :
 * une seule session de paiement ouverte par espace. Une session déjà ouverte est expirée chez Stripe avant d'être remplacée ;
 * une session déjà payée (confirmation en attente) interdit toute nouvelle tentative.
 */
async function reserveCheckout(subscriptionId: string, gw: StripeGateway): Promise<string> {
  const id = randomToken(16), now = new Date(), until = new Date(now.getTime() + CHECKOUT_PENDING_LEASE_MS);
  const claimed = await db.subscription.updateMany({ where: { id: subscriptionId, OR: [{ checkoutReservedUntil: null }, { checkoutReservedUntil: { lt: now } }] }, data: { checkoutReservationId: id, checkoutReservedUntil: until, checkoutSessionId: null } });
  if (claimed.count === 1) return id;
  const cur = await db.subscription.findUnique({ where: { id: subscriptionId }, select: { checkoutSessionId: true } });
  if (!cur?.checkoutSessionId) throw new BillingError("Une demande de paiement est déjà en cours de préparation : réessayez dans un instant.");
  const sessionId = cur.checkoutSessionId;
  let st: { status: string } | null;
  try { st = await gw.getCheckoutSession(sessionId); } catch { throw new BillingError("Vérification de votre session de paiement impossible auprès de Stripe : réessayez dans un instant."); }
  if (st?.status === "complete") throw new BillingError("Un paiement vient d'être effectué pour cet espace : la confirmation de Stripe est attendue (quelques secondes). Actualisez la page.");
  if (st?.status === "open") { try { await gw.expireCheckoutSession(sessionId); } catch { throw new BillingError("Une session de paiement est déjà ouverte : terminez-la ou attendez son expiration (environ 30 minutes)."); } }
  // Reprise conditionnelle sur la session précédente : si deux demandes arrivent ensemble, une seule la remplace.
  const retaken = await db.subscription.updateMany({ where: { id: subscriptionId, checkoutSessionId: sessionId }, data: { checkoutReservationId: id, checkoutReservedUntil: until, checkoutSessionId: null } });
  if (retaken.count !== 1) throw new BillingError("Une autre demande de paiement vient d'être lancée : réessayez dans un instant.");
  return id;
}
const releaseCheckout = (subscriptionId: string, reservationId: string) =>
  db.subscription.updateMany({ where: { id: subscriptionId, checkoutReservationId: reservationId }, data: { checkoutReservationId: null, checkoutReservedUntil: null, checkoutSessionId: null } });

export async function createCheckoutSession(p: { workspaceId: string; plan: string; email: string }, gw: StripeGateway = gateway): Promise<string> {
  if (!planOrNull(p.plan)) throw new BillingError("Plan inconnu.");
  const price = planPriceId(p.plan);
  if (!stripeConfigured() || !price) throw new BillingError(`Paiement indisponible : configurez STRIPE_SECRET_KEY et STRIPE_PRICE_${p.plan.toUpperCase()}.`);
  if (!planCheckoutReady(p.plan)) throw new BillingError("Paiement indisponible : la configuration Stripe est incomplète (secret de webhook manquant ou prix identiques pour deux forfaits).");
  const sub = await db.subscription.findUnique({ where: { workspaceId: p.workspaceId } });
  if (!sub) throw new BillingError("Aucun abonnement.");
  // Serveur : le masquage du bouton ne suffit pas. Un abonnement vivant se modifie par « changement de forfait » ; une seconde session de paiement le doublerait.
  if (isLiveSubscription(sub)) throw new BillingError(entitlement(sub).active ? "Un abonnement payant est déjà actif : utilisez le changement de forfait." : "Un abonnement existe mais son paiement n'est plus à jour : régularisez-le avec « Moyen de paiement et factures » (ou résiliez-le) avant de souscrire à nouveau.");
  // Un identifiant Stripe local ancien ne prouve pas que l'abonnement est terminé (événements perdus) : l'état réel est relu AVANT toute nouvelle souscription.
  if (sub.stripeSubscriptionId) {
    let remote: StripeSub | null;
    try { remote = await gw.getSubscription(sub.stripeSubscriptionId); } catch { throw new BillingError("Vérification de votre abonnement impossible auprès de Stripe : réessayez dans un instant."); }
    if (remote && isEntitledStripeStatus(remote.status)) {
      await syncFromStripe(sub, sub.stripeSubscriptionId, gw, "checkout_precheck", { missingIsCanceled: true }).catch((e) => log.warn("billing.precheck_sync_failed", { error: errMsg(e) })); // répare l'état local ; la souscription reste refusée dans tous les cas
      throw new BillingError("Un abonnement payant est déjà actif chez Stripe : utilisez le changement de forfait.");
    }
  }
  const usage = await workspaceUsage(p.workspaceId);
  const blockers = comparePlans(sub.plan, p.plan) === "downgrade" ? downgradeBlockers(PLANS[p.plan as PlanId], usage) : [];
  if (blockers.length) throw new BillingError(`Impossible : votre usage dépasse les limites du plan (${blockers.join(" ; ")}).`);

  const reservation = await reserveCheckout(sub.id, gw);
  try {
    let customer = sub.stripeCustomerId;
    if (!customer) {
      customer = (await gw.createCustomer({ email: p.email, workspaceId: p.workspaceId })).id;
      await db.subscription.update({ where: { workspaceId: p.workspaceId }, data: { stripeCustomerId: customer } });
    }
    const expiresAt = Date.now() + CHECKOUT_SESSION_TTL_MS;
    const body: Record<string, string> = {
      mode: "subscription", customer, "line_items[0][price]": price, "line_items[0][quantity]": "1",
      success_url: `${env.appUrl}/billing?success=1`, cancel_url: `${env.appUrl}/billing?canceled=1`, expires_at: String(Math.floor(expiresAt / 1000)),
      client_reference_id: p.workspaceId, "metadata[workspaceId]": p.workspaceId, "metadata[plan]": p.plan,
      "subscription_data[metadata][workspaceId]": p.workspaceId, "subscription_data[metadata][plan]": p.plan,
    };
    // L'essai restant est honoré (Stripe exige au moins 48 h).
    if (sub.status === "trialing" && sub.trialEndsAt && sub.trialEndsAt.getTime() > Date.now() + 49 * 3_600_000) body["subscription_data[trial_end]"] = String(Math.floor(sub.trialEndsAt.getTime() / 1000));
    const s = await gw.createCheckoutSession(body, `checkout:${reservation}`);
    if (!s.url) throw new BillingError("Stripe n'a pas renvoyé d'URL de paiement.");
    // Sans identifiant de session, la tentative ne peut pas être suivie (Stripe en renvoie toujours un) : elle est libérée plutôt que bloquante.
    if (s.id) await db.subscription.updateMany({ where: { id: sub.id, checkoutReservationId: reservation }, data: { checkoutSessionId: s.id, checkoutReservedUntil: new Date(expiresAt) } });
    else await releaseCheckout(sub.id, reservation);
    return s.url;
  } catch (e) {
    await releaseCheckout(sub.id, reservation).catch((err) => log.error("billing.checkout_release_failed", { error: errMsg(err) }));
    throw e;
  }
}

export async function createPortalSession(workspaceId: string): Promise<string> {
  const sub = await db.subscription.findUnique({ where: { workspaceId } });
  if (!sub?.stripeCustomerId) throw new BillingError("Aucun client Stripe : souscrivez d'abord à un plan.");
  if (!isLiveSubscription(sub)) throw new BillingError("Aucun abonnement actif : la gestion du moyen de paiement n'est pas disponible. Souscrivez à un forfait pour reprendre.");
  const s = await stripe<{ url?: string }>("POST", "/billing_portal/sessions", { customer: sub.stripeCustomerId, return_url: `${env.appUrl}/billing` });
  if (!s.url) throw new BillingError("Stripe n'a pas renvoyé d'URL.");
  return s.url;
}

/** Changement de plan d'un abonnement payant (upgrade immédiat avec prorata, downgrade refusé si l'usage dépasse). */
export async function changePaidPlan(workspaceId: string, plan: string, actorId?: string | null) {
  const sub = await db.subscription.findUnique({ where: { workspaceId } });
  const price = planPriceId(plan);
  if (!sub?.stripeSubscriptionId) throw new BillingError("Aucun abonnement payant à modifier.");
  if (!isLiveSubscription(sub)) throw new BillingError("Cet abonnement n'est plus actif : souscrivez à un forfait pour le reprendre.");
  if (!price) throw new BillingError(`STRIPE_PRICE_${plan.toUpperCase()} non configuré.`);
  if (!planOrNull(plan)) throw new BillingError("Plan inconnu.");
  const dir = comparePlans(sub.plan, plan);
  if (dir === "same") throw new BillingError("Vous êtes déjà sur ce plan.");
  if (dir === "downgrade") {
    const b = downgradeBlockers(PLANS[plan as PlanId], await workspaceUsage(workspaceId));
    if (b.length) throw new BillingError(`Impossible : votre usage dépasse les limites du plan (${b.join(" ; ")}).`);
  }
  const s = await stripe<{ items: { data: { id: string }[] } }>("GET", `/subscriptions/${sub.stripeSubscriptionId}`);
  await stripe("POST", `/subscriptions/${sub.stripeSubscriptionId}`, {
    "items[0][id]": s.items.data[0].id, "items[0][price]": price, proration_behavior: dir === "upgrade" ? "create_prorations" : "none", "metadata[plan]": plan, cancel_at_period_end: "false",
  });
  // Le forfait local n'est PAS modifié ici : il change à la réception de l'événement Stripe correspondant (customer.subscription.updated), jamais sur la seule demande.
  await audit({ workspaceId, userId: actorId, action: `billing.${dir}_requested`, meta: { from: sub.plan, to: plan } });
}

export async function setCancelAtPeriodEnd(workspaceId: string, cancel: boolean, actorId?: string | null) {
  const sub = await db.subscription.findUnique({ where: { workspaceId } });
  if (!sub) throw new BillingError("Aucun abonnement.");
  if (sub.stripeSubscriptionId) {
    // Un identifiant Stripe ne prouve pas qu'un abonnement existe encore : seul l'état réel autorise la demande (sinon Stripe la refuserait).
    const state = entitlement(sub).state;
    if (!isLiveSubscription(sub)) throw new BillingError("Cet abonnement est terminé : aucune résiliation ni reprise n'est possible. Souscrivez à un forfait pour le réactiver.");
    if (cancel && state === "canceling") throw new BillingError("La résiliation est déjà programmée.");
    if (!cancel && state !== "canceling") throw new BillingError("Aucune résiliation n'est programmée : rien à reprendre.");
    await stripe("POST", `/subscriptions/${sub.stripeSubscriptionId}`, { cancel_at_period_end: String(cancel) });
  } else if (sub.status !== "trialing") throw new BillingError("Aucun abonnement payant à résilier.");
  // Essai sans Stripe : résilier = terminer l'essai immédiatement.
  await db.subscription.update({ where: { workspaceId }, data: sub.stripeSubscriptionId ? { cancelAtPeriodEnd: cancel } : { status: "canceled", canceledAt: new Date() } });
  await audit({ workspaceId, userId: actorId, action: cancel ? "billing.cancel" : "billing.resume" });
}

// ───────────── Webhook Stripe ─────────────

export function verifyStripeSignature(payload: string, header: string | null, secret: string, toleranceSec = 300, now = Date.now()): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=") as [string, string]));
  const t = parts.t, v1 = header.split(",").filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!t || !v1.length) return false;
  if (Math.abs(now / 1000 - Number(t)) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  return v1.some((s) => safeEqual(s, expected));
}

export function planFromPriceId(priceId: string | undefined): string | null {
  if (!priceId) return null;
  return PLAN_IDS.find((p) => env.stripePriceId(p) === priceId) ?? null;
}

/**
 * Statut Stripe → statut local → accès (voir docs/stripe-hardening.md pour la table complète) :
 *  active → active (accès) ; trialing → active (essai Stripe, carte enregistrée) ; past_due → past_due (accès pendant le délai de grâce de 7 jours) ;
 *  unpaid → unpaid (accès suspendu : plus aucun prélèvement ne sera tenté) ; paused → unpaid (en pause faute de moyen de paiement : suspendu, régularisable) ;
 *  canceled → canceled ; incomplete → incomplete (aucun droit avant confirmation) ; incomplete_expired → expired.
 * Une annulation PROGRAMMÉE n'est pas un statut : l'abonnement reste `active` avec cancel_at_period_end et garde l'accès jusqu'à la fin de la période payée.
 */
const STATUS_MAP: Record<string, string> = { active: "active", trialing: "active", past_due: "past_due", unpaid: "unpaid", canceled: "canceled", incomplete: "incomplete", incomplete_expired: "expired", paused: "unpaid" };

async function findSubscription(s: { customer?: string; workspaceId?: string; subscriptionId?: string }): Promise<Subscription | null> {
  if (s.workspaceId) { const x = await db.subscription.findUnique({ where: { workspaceId: s.workspaceId } }); if (x) return x; }
  if (s.subscriptionId) { const x = await db.subscription.findUnique({ where: { stripeSubscriptionId: s.subscriptionId } }); if (x) return x; }
  if (s.customer) return db.subscription.findUnique({ where: { stripeCustomerId: s.customer } });
  return null;
}

/** Statuts locaux pour lesquels un abonnement payant existe réellement (droits du plan acquis). */
const PAID_STATUSES = ["active", "past_due", "unpaid"];

export type SyncOutcome = { outcome: "handled" | "ignored" | "needs_review"; note?: string; workspaceId: string };

/** Une synchronisation de cet abonnement est déjà en cours ailleurs (bail non expiré) : réessayer plus tard, rien n'est modifié. */
export class SyncBusyError extends BillingError {}

/**
 * Bail d'exclusion des synchronisations (lecture Stripe + écriture) d'UN abonnement, valable entre serveurs.
 * Pourquoi un bail et pas un horodatage : l'ordre de FIN des lectures n'est pas l'ordre des états lus (une lecture ancienne et lente peut finir
 * après une lecture récente), et l'ordre de DÉBUT ne l'est pas non plus si Stripe traite deux requêtes voisines dans l'ordre inverse.
 * Avec un bail, deux lectures du même abonnement ne se chevauchent JAMAIS : la lecture d'une synchronisation commence après la validation de
 * la précédente, donc l'état lu est au moins aussi récent. L'identifiant de bail sert de jeton de clôture : un détenteur dont le bail a expiré
 * (processus suspendu, très lent) puis a été repris ne peut plus écrire. L'horloge locale ne décide que QUAND un bail abandonné peut être repris ;
 * la sûreté, elle, vient de l'écriture conditionnelle sur l'identifiant de bail.
 */
export const SYNC_LEASE_MS = 90_000;
export const SYNC_WAIT_MS = 10_000;

async function acquireSyncLease(subscriptionId: string, waitMs = SYNC_WAIT_MS): Promise<string> {
  const lease = randomToken(12), deadline = Date.now() + waitMs;
  for (;;) {
    const now = new Date();
    const r = await db.subscription.updateMany({
      where: { id: subscriptionId, OR: [{ stripeSyncLeaseUntil: null }, { stripeSyncLeaseUntil: { lt: now } }] },
      data: { stripeSyncLeaseId: lease, stripeSyncLeaseUntil: new Date(now.getTime() + SYNC_LEASE_MS) },
    });
    if (r.count === 1) return lease;
    if (Date.now() >= deadline) throw new SyncBusyError("Une synchronisation de cet abonnement est déjà en cours : réessayez dans un instant.");
    await new Promise((res) => setTimeout(res, 100));
  }
}
const releaseSyncLease = (subscriptionId: string, lease: string) =>
  db.subscription.updateMany({ where: { id: subscriptionId, stripeSyncLeaseId: lease }, data: { stripeSyncLeaseId: null, stripeSyncLeaseUntil: null } });

/**
 * Applique à la base l'état d'un abonnement RELU chez Stripe, sous un bail de synchronisation détenu par l'appelant.
 *  - L'état local est RELU juste avant l'écriture et le résultat est calculé à partir de lui (jamais d'un instantané ancien) ; l'écriture est
 *    conditionnelle sur la version lue (`updatedAt`) ET sur le bail : une modification locale concurrente (résiliation, essai, réservation de
 *    paiement) fait recommencer le calcul au lieu d'être écrasée, et un bail perdu interrompt l'écriture.
 *  - Un abonnement vivant n'est JAMAIS remplacé par un autre identifiant : si les deux sont actifs chez Stripe, l'écart est signalé (`needs_review`)
 *    et l'état courant est conservé. Un abonnement non actif d'un autre identifiant (ancien, annulé) est ignoré.
 *  - Le forfait n'est appliqué que pour un abonnement actif ou en cours de règlement ; « incomplete » ne change ni le forfait ni un essai valide.
 */
async function applyRemoteSubscription(subscriptionRowId: string, remote: StripeSub, gw: StripeGateway, source: string, lease: string, now = new Date()): Promise<SyncOutcome> {
  const mapped = STATUS_MAP[remote.status] ?? "incomplete";
  const entitled = mapped === "active" || mapped === "past_due";
  for (let attempt = 0; attempt < 4; attempt++) {
    const local = await db.subscription.findUnique({ where: { id: subscriptionRowId } });
    if (!local) throw new BillingError("Abonnement local introuvable.");
    const workspaceId = local.workspaceId;
    if (local.stripeSyncLeaseId !== lease) return { outcome: "ignored", workspaceId, note: "Synchronisation devenue obsolète (bail repris par une autre) : rien n'est écrit." };
    if (local.stripeCustomerId && remote.customer && local.stripeCustomerId !== remote.customer)
      return { outcome: "needs_review", workspaceId, note: "Le client Stripe de l'abonnement diffère de celui de l'espace : aucune modification." };
    if (local.stripeSubscriptionId && local.stripeSubscriptionId !== remote.id) {
      if (!entitled) return { outcome: "ignored", workspaceId, note: "Abonnement non actif d'un autre identifiant : état courant inchangé." };
      if (PAID_STATUSES.includes(local.status)) {
        const current = await gw.getSubscription(local.stripeSubscriptionId); // une erreur Stripe interrompt le traitement : l'événement sera repris
        if (current && isEntitledStripeStatus(current.status)) {
          log.error("billing.duplicate_subscription", { workspaceId, kept: local.stripeSubscriptionId, duplicate: remote.id });
          await audit({ workspaceId, action: "billing.duplicate_subscription", meta: { kept: local.stripeSubscriptionId, duplicate: remote.id, source } });
          return { outcome: "needs_review", workspaceId, note: `Deux abonnements actifs chez Stripe (${local.stripeSubscriptionId} conservé, ${remote.id} à examiner) : aucun remplacement automatique.` };
        }
      }
    }
    const plan = entitled ? (planFromPriceId(remote.items?.data[0]?.price?.id) ?? remote.metadata?.plan ?? local.plan) : local.plan;
    const periodEnd = remote.current_period_end ?? remote.items?.data[0]?.current_period_end;
    // Paiement non abouti (incomplete / expired) : ni forfait, ni statut ne changent si un essai valide est en cours ; sinon seul le statut est enregistré.
    const localTrialValid = local.status === "trialing" && !!local.trialEndsAt && local.trialEndsAt.getTime() > now.getTime();
    const status = !entitled && mapped !== "canceled" && localTrialValid ? local.status : mapped;
    const data = {
      stripeSubscriptionId: remote.id, stripeCustomerId: remote.customer ?? local.stripeCustomerId,
      plan: planOrNull(plan) ? plan : local.plan, status,
      currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : local.currentPeriodEnd, cancelAtPeriodEnd: !!remote.cancel_at_period_end,
      canceledAt: status === "canceled" ? (local.canceledAt ?? (remote.canceled_at ? new Date(remote.canceled_at * 1000) : now)) : null,
      trialEndsAt: remote.status === "trialing" && remote.trial_end ? new Date(remote.trial_end * 1000) : local.trialEndsAt,
      stripeSyncedAt: now,
      // L'abonnement est confirmé : la tentative de souscription en cours est terminée.
      ...(entitled ? { checkoutReservationId: null, checkoutReservedUntil: null, checkoutSessionId: null } : {}),
    };
    const written = await db.subscription.updateMany({ where: { id: local.id, updatedAt: local.updatedAt, stripeSyncLeaseId: lease }, data });
    if (written.count === 0) continue; // modifié entre la lecture et l'écriture : on relit l'état local et on recalcule (le bail est revérifié en tête de boucle)
    const time = (d: Date | null) => d?.getTime() ?? null;
    const unchanged = local.stripeSubscriptionId === data.stripeSubscriptionId && local.stripeCustomerId === data.stripeCustomerId && local.plan === data.plan && local.status === data.status
      && time(local.currentPeriodEnd) === time(data.currentPeriodEnd) && local.cancelAtPeriodEnd === data.cancelAtPeriodEnd && time(local.canceledAt) === time(data.canceledAt) && time(local.trialEndsAt) === time(data.trialEndsAt)
      && !(entitled && (local.checkoutReservationId || local.checkoutReservedUntil || local.checkoutSessionId));
    if (unchanged) return { outcome: "ignored", workspaceId, note: "L'état local correspond déjà à celui de Stripe." };
    await audit({ workspaceId, action: "billing.stripe_sync", meta: { source, status } });
    return { outcome: "handled", workspaceId };
  }
  throw new BillingError("Modifications locales concurrentes persistantes : la synchronisation sera reprise.");
}

/**
 * Relit l'abonnement chez Stripe PUIS l'applique, le tout sous le bail de synchronisation de l'abonnement local : lectures et écritures d'un même
 * abonnement sont strictement ordonnées. Un abonnement introuvable chez Stripe est un abonnement terminé (sauf `missingIsCanceled: false` : erreur).
 */
async function syncFromStripe(localHint: Subscription, subscriptionId: string, gw: StripeGateway, source: string, opts: { missingIsCanceled: boolean; waitMs?: number }): Promise<SyncOutcome> {
  const lease = await acquireSyncLease(localHint.id, opts.waitMs);
  try {
    const remote = await gw.getSubscription(subscriptionId); // lecture APRÈS l'obtention du bail
    if (!remote && !opts.missingIsCanceled) throw new BillingError(`Abonnement ${subscriptionId} introuvable chez Stripe.`);
    return await applyRemoteSubscription(localHint.id, remote ?? { id: subscriptionId, customer: localHint.stripeCustomerId ?? undefined, status: "canceled" }, gw, source, lease);
  } finally {
    await releaseSyncLease(localHint.id, lease).catch((e) => log.error("billing.sync_lease_release_failed", { error: errMsg(e) }));
  }
}

/** Réconciliation d'un espace avec Stripe (abonnement relu et appliqué). Une indisponibilité de Stripe lève l'erreur : l'état local n'est alors JAMAIS modifié. */
export async function reconcileSubscription(workspaceId: string, gw: StripeGateway = gateway, opts: { waitMs?: number } = {}): Promise<SyncOutcome | null> {
  const local = await db.subscription.findUnique({ where: { workspaceId } });
  if (!local?.stripeSubscriptionId) return null;
  return syncFromStripe(local, local.stripeSubscriptionId, gw, "reconcile", { missingIsCanceled: true, waitMs: opts.waitMs });
}

/** Statuts locaux d'un abonnement lié à Stripe qui peuvent encore changer chez Stripe (réconciliés dès que la période est échue). */
const RECONCILE_OPEN_STATUSES = ["trialing", "active", "past_due", "unpaid", "incomplete"];
/** Un abonnement terminé (canceled / expired) reste vérifié une fois par jour pendant cette fenêtre, puis n'est plus lu : il peut avoir été terminé à tort. */
export const RECONCILE_TERMINAL_WINDOW_MS = 90 * 86_400_000;
export const RECONCILE_INTERVAL_MS = 24 * 3_600_000;

function reconcileWhere(now: Date, extra?: Record<string, unknown>) {
  return {
    stripeSubscriptionId: { not: null },
    AND: [
      { OR: [{ stripeSyncedAt: null }, { stripeSyncedAt: { lt: new Date(now.getTime() - RECONCILE_INTERVAL_MS) } }, { status: { in: RECONCILE_OPEN_STATUSES }, currentPeriodEnd: { lt: now } }] },
      { OR: [{ status: { notIn: ["canceled", "expired"] } }, { canceledAt: null }, { canceledAt: { gte: new Date(now.getTime() - RECONCILE_TERMINAL_WINDOW_MS) } }] },
      ...(extra ? [extra] : []),
    ],
  };
}

/**
 * Réconciliation périodique (tâche planifiée) des abonnements liés à Stripe dont l'état local peut être périmé : jamais synchronisés, période échue,
 * ou plus de 24 h sans synchronisation — y compris les abonnements localement terminés (canceled / expired, 90 jours) qui seraient encore actifs chez Stripe.
 * La décision d'accès vient TOUJOURS de l'état relu chez Stripe : aucun abonnement n'est réactivé « à l'aveugle ».
 * Stripe indisponible : l'abonnement est compté en échec et laissé tel quel (aucun droit retiré ni accordé sur une simple panne).
 * PostgreSQL trie les NULL en dernier et SQLite en premier : les jamais-synchronisés sont donc lus d'abord, explicitement.
 */
export async function reconcileDueSubscriptions(opts: { now?: Date; limit?: number } = {}, gw: StripeGateway = gateway): Promise<{ checked: number; updated: number; failed: number; busy: number }> {
  const now = opts.now ?? new Date(), limit = opts.limit ?? 50;
  const never = await db.subscription.findMany({ where: reconcileWhere(now, { stripeSyncedAt: null }), orderBy: { createdAt: "asc" }, take: limit });
  const rest = never.length < limit ? await db.subscription.findMany({ where: reconcileWhere(now, { stripeSyncedAt: { not: null } }), orderBy: { stripeSyncedAt: "asc" }, take: limit - never.length }) : [];
  const sum = { checked: 0, updated: 0, failed: 0, busy: 0 };
  for (const s of [...never, ...rest]) {
    sum.checked++;
    try { const r = await syncFromStripe(s, s.stripeSubscriptionId!, gw, "reconcile", { missingIsCanceled: true, waitMs: 2_000 }); if (r.outcome === "handled") sum.updated++; }
    catch (e) { if (e instanceof SyncBusyError) sum.busy++; else { sum.failed++; log.warn("billing.reconcile_failed", { workspaceId: s.workspaceId, error: errMsg(e) }); } }
  }
  return sum;
}

const idOf = (v: unknown): string | undefined => (typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : undefined);

async function processStripeEvent(ev: StripeEvent, gw: StripeGateway): Promise<{ outcome: "handled" | "ignored" | "needs_review"; workspaceId?: string; note?: string }> {
  const o = ev.data.object;
  const ignored = { outcome: "ignored" as const };

  if (ev.type === "checkout.session.completed") {
    if (o.mode && o.mode !== "subscription") return ignored;
    const sub = await findSubscription({ workspaceId: (o.client_reference_id as string) ?? (o.metadata as Record<string, string> | undefined)?.workspaceId, customer: o.customer as string });
    if (!sub) return ignored;
    // La session est terminée : la réservation est libérée (seulement si c'est la sienne), puis l'abonnement créé est relu chez Stripe et appliqué.
    if (typeof o.id === "string") await db.subscription.updateMany({ where: { id: sub.id, checkoutSessionId: o.id }, data: { checkoutReservationId: null, checkoutReservedUntil: null, checkoutSessionId: null } });
    const customer = idOf(o.customer);
    // Premier rattachement du client Stripe seulement ; un client différent n'est jamais substitué.
    if (customer && !sub.stripeCustomerId) await db.subscription.updateMany({ where: { id: sub.id, stripeCustomerId: null }, data: { stripeCustomerId: customer } });
    const subscriptionId = idOf(o.subscription);
    if (!subscriptionId) return { outcome: "handled", workspaceId: sub.workspaceId };
    const fresh = (await db.subscription.findUnique({ where: { id: sub.id } })) ?? sub;
    return syncFromStripe(fresh, subscriptionId, gw, ev.type, { missingIsCanceled: false });
  }
  if (ev.type === "checkout.session.expired") {
    const sub = await findSubscription({ workspaceId: (o.client_reference_id as string) ?? (o.metadata as Record<string, string> | undefined)?.workspaceId });
    if (!sub || typeof o.id !== "string") return ignored;
    await db.subscription.updateMany({ where: { id: sub.id, checkoutSessionId: o.id }, data: { checkoutReservationId: null, checkoutReservedUntil: null, checkoutSessionId: null } });
    return { outcome: "handled", workspaceId: sub.workspaceId };
  }
  if (["created", "updated", "deleted", "paused", "resumed"].some((k) => ev.type === `customer.subscription.${k}`)) {
    const s = o as unknown as StripeSub;
    const sub = await findSubscription({ workspaceId: s.metadata?.workspaceId, subscriptionId: s.id, customer: idOf(s.customer) });
    if (!sub) return ignored;
    return syncFromStripe(sub, s.id, gw, ev.type, { missingIsCanceled: true });
  }
  if (ev.type === "invoice.payment_failed" || ev.type === "invoice.paid") {
    const parent = (o.parent as { subscription_details?: { subscription?: unknown } } | undefined)?.subscription_details?.subscription;
    const sub = await findSubscription({ customer: idOf(o.customer), subscriptionId: idOf(o.subscription) ?? idOf(parent) });
    if (!sub) return ignored;
    const subscriptionId = idOf(o.subscription) ?? idOf(parent) ?? sub.stripeSubscriptionId;
    if (!subscriptionId) return ignored;
    // L'événement ne dit rien de l'état courant : seul l'état relu chez Stripe est appliqué (un ancien « impayé » ne dégrade pas un abonnement payé depuis).
    return syncFromStripe(sub, subscriptionId, gw, ev.type, { missingIsCanceled: true });
  }
  return ignored;
}

/**
 * Traitement des événements Stripe, seul chemin par lequel un forfait payant est attribué.
 *  - Prise en charge atomique par le registre `StripeEvent` (clé primaire = identifiant d'événement) : livraisons simultanées et rejeux ne produisent
 *    qu'un traitement ; un événement en échec ou interrompu (bail expiré) est repris ; un événement `processed` n'est jamais rejoué.
 *  - L'état appliqué est celui relu chez Stripe (voir applyRemoteSubscription), jamais le contenu de l'événement.
 *  - Toute erreur (Stripe indisponible, base) remonte : l'événement est marqué `failed` et Stripe réessaiera.
 */
export async function handleStripeEvent(ev: StripeEvent, gw: StripeGateway = gateway): Promise<{ handled: boolean; duplicate?: boolean; inProgress?: boolean }> {
  if (!ev.id) throw new BillingError("Événement Stripe sans identifiant.");
  const claim = await claimStripeEvent(ev.id, ev.type);
  if (claim.kind === "duplicate") return { handled: false, duplicate: true, ...(claim.state === "processing" ? { inProgress: true } : {}) };
  try {
    const r = await processStripeEvent(ev, gw);
    await completeStripeEvent(ev.id, { workspaceId: r.workspaceId, outcome: r.outcome, note: r.note });
    // Trace d'audit informative (la déduplication, elle, repose sur le registre StripeEvent).
    if (r.workspaceId && r.outcome !== "ignored") await audit({ workspaceId: r.workspaceId, action: "billing.stripe_event", entity: "StripeEvent", entityId: ev.id, meta: { type: ev.type, outcome: r.outcome } });
    return { handled: r.outcome !== "ignored" };
  } catch (e) {
    log.error("stripe.webhook_failed", { type: ev.type, error: errMsg(e) });
    await failStripeEvent(ev.id, errMsg(e)).catch((err) => log.error("stripe.event_ledger_failed", { error: errMsg(err) }));
    throw e;
  }
}
