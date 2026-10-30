import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createCheckoutSession, handleStripeEvent, reconcileSubscription, STRIPE_WEBHOOK_EVENTS, type StripeEvent } from "@/lib/billing";
import { entitlement, isLiveSubscription, RENEWAL_GRACE_MS } from "@/lib/plans";
import { entitlementForWorkspace } from "@/lib/free-access";
import { manageActions } from "@/lib/billing-ui";
import { fake } from "./stripe-fake";
import { makeWorkspace, resetDb } from "./helpers";

// V3 — chaque statut Stripe a une règle explicite et testée (statut local, accès, gestion possible). `unpaid` ne conserve plus d'accès payant.

const DAY = 86_400_000;
const inDays = (n: number) => Math.floor((Date.now() + n * DAY) / 1000);
const sub = (workspaceId: string) => db.subscription.findUniqueOrThrow({ where: { workspaceId } });
let seq = 0;
const ev = (type: string, object: Record<string, unknown>): StripeEvent => ({ id: `evt_states_${++seq}`, type, data: { object } });

/** Abonnement payé, synchronisé, période en cours (forfait Growth). */
async function paid(over: Record<string, unknown> = {}) {
  const w = await makeWorkspace();
  await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { plan: "growth", status: "active", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1", currentPeriodEnd: new Date(Date.now() + 20 * DAY), stripeSyncedAt: new Date(), ...over } });
  fake.set("sub_1", { status: "active", current_period_end: inDays(20) });
  return w;
}

beforeEach(resetDb);
afterEach(() => { delete process.env.FREE_ACCESS_USER_IDS; delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_WEBHOOK_SECRET; });

describe("V3 — table des transitions : statut Stripe relu → statut local → accès", () => {
  const table: { stripe: string; local: string; active: boolean; state: string }[] = [
    { stripe: "active", local: "active", active: true, state: "paid" },
    { stripe: "trialing", local: "active", active: true, state: "paid" }, //             essai Stripe : carte enregistrée, accès
    { stripe: "past_due", local: "past_due", active: true, state: "past_due" }, //      échec temporaire : délai de grâce
    { stripe: "unpaid", local: "unpaid", active: false, state: "past_due" }, //          échec définitif : accès suspendu (et non plus conservé)
    { stripe: "paused", local: "unpaid", active: false, state: "past_due" }, //          en pause faute de moyen de paiement : suspendu, régularisable
    { stripe: "canceled", local: "canceled", active: false, state: "canceled" },
    { stripe: "incomplete", local: "incomplete", active: false, state: "incomplete" }, // aucun droit avant confirmation
    { stripe: "incomplete_expired", local: "expired", active: false, state: "canceled" },
  ];
  for (const t of table) {
    it(`Stripe « ${t.stripe} » : statut local « ${t.local} », accès ${t.active ? "ouvert" : "fermé"}`, async () => {
      const { workspaceId } = await paid();
      fake.set("sub_1", { status: t.stripe });
      await reconcileSubscription(workspaceId, fake);
      const s = await sub(workspaceId);
      expect(s.status).toBe(t.local);
      expect(entitlement(s)).toMatchObject({ active: t.active, state: t.state });
    });
  }

  it("unpaid : l'accès est suspendu même si la période n'est pas échue (la période en cours n'a pas été payée), mais l'abonnement reste gérable", async () => {
    const { workspaceId } = await paid();
    fake.set("sub_1", { status: "unpaid", current_period_end: inDays(25) });
    await reconcileSubscription(workspaceId, fake);
    const s = await sub(workspaceId);
    expect(entitlement(s).active).toBe(false);
    expect(entitlement(s).reason).toMatch(/impayé/);
    expect(isLiveSubscription(s)).toBe(true); // portail de paiement et résiliation restent possibles : le client peut régulariser
    expect(manageActions({ state: entitlement(s).state, owner: true, hasStripeSubscription: true }).portal).toBe(true);
  });

  it("unpaid puis paiement régularisé : Stripe repasse en actif, l'accès est rétabli par la synchronisation", async () => {
    const { workspaceId } = await paid();
    fake.set("sub_1", { status: "unpaid" });
    await reconcileSubscription(workspaceId, fake);
    expect(entitlement(await sub(workspaceId)).active).toBe(false);
    fake.set("sub_1", { status: "active" });
    await handleStripeEvent(ev("invoice.paid", { customer: "cus_1", subscription: "sub_1" }), fake);
    expect(entitlement(await sub(workspaceId))).toMatchObject({ active: true, state: "paid" });
  });

  it("past_due : accès pendant le délai de grâce de 7 jours après la fin de période, puis suspendu (règle existante conservée)", async () => {
    const end = new Date("2026-11-30T12:00:00Z");
    const s = { plan: "growth", status: "past_due", trialEndsAt: null, currentPeriodEnd: end, cancelAtPeriodEnd: false };
    expect(entitlement(s, new Date(end.getTime() + 6 * DAY))).toMatchObject({ active: true, state: "past_due" });
    expect(entitlement(s, new Date(end.getTime() + 7 * DAY + 1000))).toMatchObject({ active: false, state: "past_due" });
  });

  it("annulation programmée (statut Stripe encore actif) : la période déjà payée est respectée jusqu'à son terme exact, sans grâce ; annulation immédiate : fermé", async () => {
    const { workspaceId } = await paid();
    fake.set("sub_1", { status: "active", cancel_at_period_end: true, current_period_end: inDays(10) });
    await reconcileSubscription(workspaceId, fake);
    expect(entitlement(await sub(workspaceId))).toMatchObject({ active: true, state: "canceling" });
    const end = (await sub(workspaceId)).currentPeriodEnd!;
    expect(entitlement(await sub(workspaceId), new Date(end.getTime() + 1000))).toMatchObject({ active: false });
    fake.set("sub_1", { status: "canceled", cancel_at_period_end: false });
    await reconcileSubscription(workspaceId, fake);
    expect(entitlement(await sub(workspaceId))).toMatchObject({ active: false, state: "canceled" }); // annulation immédiate : plus d'accès
  });

  it("un essai gratuit local valide n'est pas retiré par un statut non abouti (incomplete / unpaid) d'un abonnement en cours de souscription", async () => {
    const w = await makeWorkspace();
    await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" } });
    for (const st of ["incomplete", "unpaid"]) {
      fake.set("sub_1", { status: st });
      await reconcileSubscription(w.workspaceId, fake);
      expect(entitlement(await sub(w.workspaceId))).toMatchObject({ active: true, state: "trial" }); // l'accès de l'essai, jamais un accès payant
      expect((await sub(w.workspaceId)).plan).toBe("starter");
    }
  });

  it("la grâce de renouvellement (3 jours) ne s'applique ni à unpaid ni à une résiliation programmée", () => {
    const end = new Date("2026-11-30T12:00:00Z");
    const after = new Date(end.getTime() + RENEWAL_GRACE_MS - 1000);
    expect(entitlement({ plan: "growth", status: "active", trialEndsAt: null, currentPeriodEnd: end, cancelAtPeriodEnd: true }, after).active).toBe(false);
    expect(entitlement({ plan: "growth", status: "unpaid", trialEndsAt: null, currentPeriodEnd: end, cancelAtPeriodEnd: false }, new Date(end.getTime() - DAY)).active).toBe(false);
  });
});

describe("V3 — événements de pause / reprise et nouvelle souscription pendant un impayé", () => {
  it("les événements `paused` et `resumed` sont déclarés et traités (état relu chez Stripe)", async () => {
    expect(STRIPE_WEBHOOK_EVENTS).toEqual(expect.arrayContaining(["customer.subscription.paused", "customer.subscription.resumed"]));
    const { workspaceId } = await paid();
    fake.set("sub_1", { status: "paused" });
    expect((await handleStripeEvent(ev("customer.subscription.paused", { id: "sub_1", customer: "cus_1", metadata: { workspaceId } }), fake)).handled).toBe(true);
    expect(await sub(workspaceId)).toMatchObject({ status: "unpaid" });
    fake.set("sub_1", { status: "active" });
    await handleStripeEvent(ev("customer.subscription.resumed", { id: "sub_1", customer: "cus_1", metadata: { workspaceId } }), fake);
    expect(entitlement(await sub(workspaceId))).toMatchObject({ active: true, state: "paid" });
  });

  it("souscrire à nouveau pendant un impayé est refusé avec un message de régularisation (pas « déjà actif »), sans appel Stripe", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_placeholder"; process.env.STRIPE_WEBHOOK_SECRET = "whsec_placeholder";
    const { workspaceId } = await paid({ status: "unpaid" });
    await expect(createCheckoutSession({ workspaceId, plan: "pro", email: "a@b.c" }, fake)).rejects.toThrow(/régularisez-le/);
    expect(fake.calls).toEqual([]);
  });

  it("propriétaire exempté : un abonnement local impayé ne change rien à son accès (Pro, gratuit)", async () => {
    const { workspaceId, userId } = await paid({ status: "unpaid" });
    process.env.FREE_ACCESS_USER_IDS = userId;
    const e = await entitlementForWorkspace(workspaceId, await sub(workspaceId));
    expect(e).toMatchObject({ active: true, state: "exempt" });
    expect(e.plan.id).toBe("pro");
  });
});
