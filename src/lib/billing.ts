import { createHmac } from "node:crypto";
import type { Subscription } from "@prisma/client";
import { db } from "./db";
import { env } from "./env";
import { safeEqual } from "./crypto";
import { audit } from "./audit";
import { PLAN_IDS, type PlanId } from "./constants";
import { PLANS, comparePlans, downgradeBlockers, entitlement, isLiveSubscription, planOrNull, type PlanLimits } from "./plans";
import { log, errMsg } from "./logger";

export class BillingError extends Error {}

export const stripeConfigured = () => !!env.stripeSecret;
export const planPriceId = (plan: string) => env.stripePriceId(plan);

/** Événements Stripe à déclarer sur le point de terminaison /api/stripe/webhook (les droits payants ne sont accordés que par eux). */
export const STRIPE_WEBHOOK_EVENTS = ["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "invoice.paid", "invoice.payment_failed"] as const;

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

async function stripe<T = Record<string, unknown>>(method: "GET" | "POST", path: string, body?: Record<string, string>): Promise<T> {
  if (!env.stripeSecret) throw new BillingError("Stripe n'est pas configuré (STRIPE_SECRET_KEY manquant).");
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method, headers: { authorization: `Bearer ${env.stripeSecret}`, ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
    body: body ? new URLSearchParams(body).toString() : undefined, signal: AbortSignal.timeout(25_000),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) { log.error("stripe.error", { path, status: res.status }); throw new BillingError((j.error as { message?: string } | undefined)?.message ?? `Stripe : erreur HTTP ${res.status}`); }
  return j as T;
}

/** Début du mois calendaire UTC (1er à 00:00:00.000 UTC) : période de comptage des leads, sans lien avec la période de facturation Stripe. */
export function currentMonthStartUtc(now = new Date()): Date {
  const d = new Date(now); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Usage courant. Leads : mois calendaire UTC, hors prospects effacés (`deletedAt`), comme tous les autres compteurs de leads ; leur seuil est informatif. */
export async function workspaceUsage(workspaceId: string): Promise<Record<keyof PlanLimits, number>> {
  const monthStart = currentMonthStartUtc();
  const [members, activeCampaigns, landingPages, leadsPerMonth, sequences, integrations, apiKeys] = await Promise.all([
    db.membership.count({ where: { workspaceId } }),
    db.campaign.count({ where: { workspaceId, status: "active" } }),
    db.landingPage.count({ where: { workspaceId, status: { not: "archived" } } }),
    db.lead.count({ where: { workspaceId, deletedAt: null, createdAt: { gte: monthStart } } }),
    db.followUpSequence.count({ where: { workspaceId } }),
    db.integration.count({ where: { workspaceId, status: { not: "disconnected" } } }),
    db.apiKey.count({ where: { workspaceId, revokedAt: null } }),
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

export async function createCheckoutSession(p: { workspaceId: string; plan: string; email: string }): Promise<string> {
  if (!planOrNull(p.plan)) throw new BillingError("Plan inconnu.");
  const price = planPriceId(p.plan);
  if (!stripeConfigured() || !price) throw new BillingError(`Paiement indisponible : configurez STRIPE_SECRET_KEY et STRIPE_PRICE_${p.plan.toUpperCase()}.`);
  if (!planCheckoutReady(p.plan)) throw new BillingError("Paiement indisponible : la configuration Stripe est incomplète (secret de webhook manquant ou prix identiques pour deux forfaits).");
  const sub = await db.subscription.findUnique({ where: { workspaceId: p.workspaceId } });
  if (!sub) throw new BillingError("Aucun abonnement.");
  // Serveur : le masquage du bouton ne suffit pas. Un abonnement vivant se modifie par « changement de forfait » ; une seconde session de paiement le doublerait.
  if (isLiveSubscription(sub)) throw new BillingError("Un abonnement payant est déjà actif : utilisez le changement de forfait.");
  const usage = await workspaceUsage(p.workspaceId);
  const blockers = comparePlans(sub.plan, p.plan) === "downgrade" ? downgradeBlockers(PLANS[p.plan as PlanId], usage) : [];
  if (blockers.length) throw new BillingError(`Impossible : votre usage dépasse les limites du plan (${blockers.join(" ; ")}).`);

  let customer = sub.stripeCustomerId;
  if (!customer) {
    const c = await stripe<{ id: string }>("POST", "/customers", { email: p.email, "metadata[workspaceId]": p.workspaceId });
    customer = c.id;
    await db.subscription.update({ where: { workspaceId: p.workspaceId }, data: { stripeCustomerId: customer } });
  }
  const body: Record<string, string> = {
    mode: "subscription", customer, "line_items[0][price]": price, "line_items[0][quantity]": "1",
    success_url: `${env.appUrl}/billing?success=1`, cancel_url: `${env.appUrl}/billing?canceled=1`,
    client_reference_id: p.workspaceId, "metadata[workspaceId]": p.workspaceId, "metadata[plan]": p.plan,
    "subscription_data[metadata][workspaceId]": p.workspaceId, "subscription_data[metadata][plan]": p.plan,
  };
  // L'essai restant est honoré (Stripe exige au moins 48 h).
  if (sub.status === "trialing" && sub.trialEndsAt && sub.trialEndsAt.getTime() > Date.now() + 49 * 3_600_000) body["subscription_data[trial_end]"] = String(Math.floor(sub.trialEndsAt.getTime() / 1000));
  const s = await stripe<{ url?: string }>("POST", "/checkout/sessions", body);
  if (!s.url) throw new BillingError("Stripe n'a pas renvoyé d'URL de paiement.");
  return s.url;
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

type StripeSub = {
  id: string; customer: string; status: string; cancel_at_period_end?: boolean; current_period_end?: number; trial_end?: number | null;
  metadata?: Record<string, string>; items?: { data: { price?: { id?: string }; current_period_end?: number }[] };
};
export type StripeEvent = { id: string; type: string; data: { object: Record<string, unknown> } };

export function planFromPriceId(priceId: string | undefined): string | null {
  if (!priceId) return null;
  return PLAN_IDS.find((p) => env.stripePriceId(p) === priceId) ?? null;
}

const STATUS_MAP: Record<string, string> = { active: "active", trialing: "active", past_due: "past_due", unpaid: "past_due", canceled: "canceled", incomplete: "incomplete", incomplete_expired: "expired", paused: "canceled" };

async function findSubscription(s: { customer?: string; workspaceId?: string; subscriptionId?: string }): Promise<Subscription | null> {
  if (s.workspaceId) { const x = await db.subscription.findUnique({ where: { workspaceId: s.workspaceId } }); if (x) return x; }
  if (s.subscriptionId) { const x = await db.subscription.findUnique({ where: { stripeSubscriptionId: s.subscriptionId } }); if (x) return x; }
  if (s.customer) return db.subscription.findUnique({ where: { stripeCustomerId: s.customer } });
  return null;
}

/** Statuts locaux pour lesquels un abonnement payant existe réellement (droits du plan acquis). */
const PAID_STATUSES = ["active", "past_due"];

/**
 * Traitement des événements Stripe, seul chemin par lequel un forfait payant est attribué.
 *  - Idempotent : un identifiant d'événement déjà traité est ignoré (rejeu), et réécrire les mêmes données donne le même état.
 *  - Un événement d'un AUTRE abonnement que celui du client (ancien abonnement résilié, par exemple) n'écrase jamais l'abonnement courant.
 *  - Le forfait n'est appliqué que si Stripe confirme un abonnement actif ou en cours de règlement : « incomplete » (paiement non abouti) ne change ni le forfait ni l'essai en cours.
 *  - Un échec de paiement ne dégrade que les abonnements déjà payants ; il ne retire pas un essai valide ni n'accorde d'accès.
 */
export async function handleStripeEvent(ev: StripeEvent): Promise<{ handled: boolean; duplicate?: boolean }> {
  const o = ev.data.object;
  try {
    if (ev.id && (await db.auditLog.findFirst({ where: { action: "billing.stripe_event", entityId: ev.id }, select: { id: true } }))) return { handled: false, duplicate: true };
    const done = async (workspaceId: string) => { if (ev.id) await audit({ workspaceId, action: "billing.stripe_event", entity: "StripeEvent", entityId: ev.id, meta: { type: ev.type } }); return { handled: true }; };

    if (ev.type === "checkout.session.completed") {
      const sub = await findSubscription({ workspaceId: (o.client_reference_id as string) ?? (o.metadata as Record<string, string> | undefined)?.workspaceId, customer: o.customer as string });
      if (!sub) return { handled: false };
      // Relie seulement le client et l'abonnement ; le forfait est attribué par customer.subscription.* (jamais ici).
      await db.subscription.update({ where: { id: sub.id }, data: { stripeCustomerId: (o.customer as string) ?? sub.stripeCustomerId, stripeSubscriptionId: (o.subscription as string) ?? sub.stripeSubscriptionId } });
      return done(sub.workspaceId);
    }
    if (ev.type === "customer.subscription.created" || ev.type === "customer.subscription.updated" || ev.type === "customer.subscription.deleted") {
      const s = o as unknown as StripeSub;
      const sub = await findSubscription({ workspaceId: s.metadata?.workspaceId, subscriptionId: s.id, customer: s.customer });
      if (!sub) return { handled: false };
      // Événement d'un ancien abonnement du même client : ignoré tant que l'abonnement courant n'est pas terminé.
      if (sub.stripeSubscriptionId && sub.stripeSubscriptionId !== s.id && !["canceled", "expired"].includes(sub.status)) return { handled: false };
      const mapped = ev.type === "customer.subscription.deleted" ? "canceled" : STATUS_MAP[s.status] ?? "incomplete";
      const plan = planFromPriceId(s.items?.data[0]?.price?.id) ?? s.metadata?.plan ?? sub.plan;
      const periodEnd = s.current_period_end ?? s.items?.data[0]?.current_period_end;
      const entitled = mapped === "active" || mapped === "past_due";
      // Paiement non abouti (incomplete / expired) : ni forfait, ni statut ne changent si un essai valide est en cours ; sinon seul le statut est enregistré.
      const localTrialValid = sub.status === "trialing" && !!sub.trialEndsAt && sub.trialEndsAt.getTime() > Date.now();
      const status = !entitled && mapped !== "canceled" && localTrialValid ? sub.status : mapped;
      await db.subscription.update({
        where: { id: sub.id },
        data: {
          stripeSubscriptionId: s.id, stripeCustomerId: s.customer,
          plan: entitled && planOrNull(plan) ? plan : sub.plan, status,
          currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : sub.currentPeriodEnd, cancelAtPeriodEnd: !!s.cancel_at_period_end,
          canceledAt: status === "canceled" ? new Date() : null, trialEndsAt: s.status === "trialing" && s.trial_end ? new Date(s.trial_end * 1000) : sub.trialEndsAt,
        },
      });
      await audit({ workspaceId: sub.workspaceId, action: "billing.stripe_sync", meta: { event: ev.type, status } });
      return done(sub.workspaceId);
    }
    if (ev.type === "invoice.payment_failed" || ev.type === "invoice.paid") {
      const sub = await findSubscription({ customer: o.customer as string, subscriptionId: o.subscription as string });
      if (!sub) return { handled: false };
      if (o.subscription && sub.stripeSubscriptionId && sub.stripeSubscriptionId !== o.subscription) return { handled: false };
      if (ev.type === "invoice.payment_failed") {
        // Sans abonnement déjà payant (essai, premier paiement refusé) : rien à dégrader et aucun accès à accorder.
        if (!PAID_STATUSES.includes(sub.status)) return { handled: false };
        await db.subscription.update({ where: { id: sub.id }, data: { status: "past_due" } });
      } else {
        // Une facture payée ne réactive pas un abonnement terminé : seul customer.subscription.updated peut le faire.
        if (["canceled", "expired"].includes(sub.status)) return { handled: false };
        await db.subscription.update({ where: { id: sub.id }, data: { status: "active" } });
      }
      return done(sub.workspaceId);
    }
    return { handled: false };
  } catch (e) {
    log.error("stripe.webhook_failed", { type: ev.type, error: errMsg(e) });
    throw e;
  }
}