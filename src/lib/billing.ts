import { createHmac } from "node:crypto";
import type { Subscription } from "@prisma/client";
import { db } from "./db";
import { env } from "./env";
import { safeEqual } from "./crypto";
import { audit } from "./audit";
import { PLAN_IDS, type PlanId } from "./constants";
import { PLANS, comparePlans, downgradeBlockers, planOrNull, type PlanLimits } from "./plans";
import { log, errMsg } from "./logger";

export class BillingError extends Error {}

export const stripeConfigured = () => !!env.stripeSecret;
export const planPriceId = (plan: string) => env.stripePriceId(plan);
export const planCheckoutReady = (plan: string) => stripeConfigured() && !!planPriceId(plan);

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

export async function workspaceUsage(workspaceId: string): Promise<Record<keyof PlanLimits, number>> {
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const [members, activeCampaigns, landingPages, leadsPerMonth, sequences, integrations, apiKeys] = await Promise.all([
    db.membership.count({ where: { workspaceId } }),
    db.campaign.count({ where: { workspaceId, status: "active" } }),
    db.landingPage.count({ where: { workspaceId, status: { not: "archived" } } }),
    db.lead.count({ where: { workspaceId, createdAt: { gte: monthStart } } }),
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
  const blockers = comparePlans(sub.plan, plan) === "downgrade" ? downgradeBlockers(PLANS[plan as PlanId], await workspaceUsage(workspaceId)) : [];
  if (blockers.length) throw new BillingError(`Impossible : votre usage dépasse les limites du plan (${blockers.join(" ; ")}).`);
  await db.subscription.update({ where: { workspaceId }, data: { plan } });
  await audit({ workspaceId, userId: actorId, action: "billing.trial_plan_selected", meta: { plan } });
}

export async function createCheckoutSession(p: { workspaceId: string; plan: string; email: string }): Promise<string> {
  if (!planOrNull(p.plan)) throw new BillingError("Plan inconnu.");
  const price = planPriceId(p.plan);
  if (!stripeConfigured() || !price) throw new BillingError(`Paiement indisponible : configurez STRIPE_SECRET_KEY et STRIPE_PRICE_${p.plan.toUpperCase()}.`);
  const sub = await db.subscription.findUnique({ where: { workspaceId: p.workspaceId } });
  if (!sub) throw new BillingError("Aucun abonnement.");
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
  const s = await stripe<{ url?: string }>("POST", "/billing_portal/sessions", { customer: sub.stripeCustomerId, return_url: `${env.appUrl}/billing` });
  if (!s.url) throw new BillingError("Stripe n'a pas renvoyé d'URL.");
  return s.url;
}

/** Changement de plan d'un abonnement payant (upgrade immédiat avec prorata, downgrade refusé si l'usage dépasse). */
export async function changePaidPlan(workspaceId: string, plan: string, actorId?: string | null) {
  const sub = await db.subscription.findUnique({ where: { workspaceId } });
  const price = planPriceId(plan);
  if (!sub?.stripeSubscriptionId) throw new BillingError("Aucun abonnement payant à modifier.");
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
  await db.subscription.update({ where: { workspaceId }, data: { plan, cancelAtPeriodEnd: false } });
  await audit({ workspaceId, userId: actorId, action: `billing.${dir}`, meta: { from: sub.plan, to: plan } });
}

export async function setCancelAtPeriodEnd(workspaceId: string, cancel: boolean, actorId?: string | null) {
  const sub = await db.subscription.findUnique({ where: { workspaceId } });
  if (!sub) throw new BillingError("Aucun abonnement.");
  if (sub.stripeSubscriptionId) await stripe("POST", `/subscriptions/${sub.stripeSubscriptionId}`, { cancel_at_period_end: String(cancel) });
  else if (sub.status !== "trialing") throw new BillingError("Aucun abonnement payant à résilier.");
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

/** Traitement idempotent des événements Stripe (les mêmes données écrites deux fois donnent le même état). */
export async function handleStripeEvent(ev: StripeEvent): Promise<{ handled: boolean }> {
  const o = ev.data.object;
  try {
    if (ev.type === "checkout.session.completed") {
      const sub = await findSubscription({ workspaceId: (o.client_reference_id as string) ?? (o.metadata as Record<string, string> | undefined)?.workspaceId, customer: o.customer as string });
      if (!sub) return { handled: false };
      await db.subscription.update({ where: { id: sub.id }, data: { stripeCustomerId: (o.customer as string) ?? sub.stripeCustomerId, stripeSubscriptionId: (o.subscription as string) ?? sub.stripeSubscriptionId } });
      return { handled: true };
    }
    if (ev.type === "customer.subscription.created" || ev.type === "customer.subscription.updated" || ev.type === "customer.subscription.deleted") {
      const s = o as unknown as StripeSub;
      const sub = await findSubscription({ workspaceId: s.metadata?.workspaceId, subscriptionId: s.id, customer: s.customer });
      if (!sub) return { handled: false };
      const plan = planFromPriceId(s.items?.data[0]?.price?.id) ?? s.metadata?.plan ?? sub.plan;
      const periodEnd = s.current_period_end ?? s.items?.data[0]?.current_period_end;
      const status = ev.type === "customer.subscription.deleted" ? "canceled" : STATUS_MAP[s.status] ?? "incomplete";
      await db.subscription.update({
        where: { id: sub.id },
        data: {
          stripeSubscriptionId: s.id, stripeCustomerId: s.customer, plan: planOrNull(plan) ? plan : sub.plan, status,
          currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : sub.currentPeriodEnd, cancelAtPeriodEnd: !!s.cancel_at_period_end,
          canceledAt: status === "canceled" ? new Date() : null, trialEndsAt: s.status === "trialing" && s.trial_end ? new Date(s.trial_end * 1000) : sub.trialEndsAt,
        },
      });
      await audit({ workspaceId: sub.workspaceId, action: "billing.stripe_sync", meta: { event: ev.type, status } });
      return { handled: true };
    }
    if (ev.type === "invoice.payment_failed" || ev.type === "invoice.paid") {
      const sub = await findSubscription({ customer: o.customer as string, subscriptionId: o.subscription as string });
      if (!sub) return { handled: false };
      await db.subscription.update({ where: { id: sub.id }, data: { status: ev.type === "invoice.paid" ? "active" : "past_due" } });
      return { handled: true };
    }
    return { handled: false };
  } catch (e) {
    log.error("stripe.webhook_failed", { type: ev.type, error: errMsg(e) });
    throw e;
  }
}
