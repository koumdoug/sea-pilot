import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { BillingError, changePaidPlan, createCheckoutSession, handleStripeEvent, planFromPriceId, selectTrialPlan, setCancelAtPeriodEnd, stripeConfigured, verifyStripeSignature, workspaceUsage } from "@/lib/billing";
import { entitlement } from "@/lib/plans";
import { POST as webhook } from "@/app/api/stripe/webhook/route";
import { makeWorkspace, resetDb } from "./helpers";

beforeEach(resetDb);
afterEach(() => { delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_WEBHOOK_SECRET; vi.restoreAllMocks(); });

const sign = (payload: string, secret: string, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;

describe("signature Stripe", () => {
  const body = '{"id":"evt_1"}';
  it("accepte une signature valide, refuse falsifiée, expirée ou absente", () => {
    expect(verifyStripeSignature(body, sign(body, "whsec"), "whsec")).toBe(true);
    expect(verifyStripeSignature(body + "x", sign(body, "whsec"), "whsec")).toBe(false);
    expect(verifyStripeSignature(body, sign(body, "autre"), "whsec")).toBe(false);
    expect(verifyStripeSignature(body, sign(body, "whsec", Math.floor(Date.now() / 1000) - 3600), "whsec")).toBe(false);
    expect(verifyStripeSignature(body, null, "whsec")).toBe(false);
  });
});

describe("essai sans Stripe : pas de faux paiement", () => {
  it("Stripe non configuré : aucune session de paiement ne peut être créée", async () => {
    const { workspaceId } = await makeWorkspace();
    expect(stripeConfigured()).toBe(false);
    await expect(createCheckoutSession({ workspaceId, plan: "growth", email: "a@b.c" })).rejects.toThrow(/STRIPE_SECRET_KEY/);
  });

  it("changement de plan pendant l'essai, avec blocage du downgrade si l'usage dépasse", async () => {
    const { workspaceId } = await makeWorkspace();
    await selectTrialPlan(workspaceId, "growth");
    expect((await db.subscription.findUniqueOrThrow({ where: { workspaceId } })).plan).toBe("growth");
    for (let i = 0; i < 4; i++) await db.landingPage.create({ data: { workspaceId, name: `P${i}`, slug: `p${i}`, sections: [] } });
    await expect(selectTrialPlan(workspaceId, "starter")).rejects.toThrow(/dépasse les limites/); // 4 pages > 3
    await expect(selectTrialPlan(workspaceId, "inconnu")).rejects.toThrow(BillingError);
  });

  it("résilier un essai le termine : l'accès est bloqué", async () => {
    const { workspaceId } = await makeWorkspace();
    await setCancelAtPeriodEnd(workspaceId, true);
    const sub = await db.subscription.findUniqueOrThrow({ where: { workspaceId } });
    expect(sub.status).toBe("canceled");
    expect(entitlement(sub).active).toBe(false);
  });

  it("l'usage reflète les données réelles de l'espace", async () => {
    const { workspaceId } = await makeWorkspace();
    await db.campaign.create({ data: { workspaceId, name: "C", status: "active" } });
    await createLeadRaw(workspaceId);
    const u = await workspaceUsage(workspaceId);
    expect(u).toMatchObject({ members: 1, activeCampaigns: 1, leadsPerMonth: 1, landingPages: 0 });
  });
});

async function createLeadRaw(workspaceId: string) { await db.lead.create({ data: { workspaceId, name: "L" } }); }

describe("webhook Stripe → état de l'abonnement (idempotent)", () => {
  async function setup() {
    const w = await makeWorkspace();
    await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { stripeCustomerId: "cus_1" } });
    return w;
  }
  const subEvent = (workspaceId: string, over: Record<string, unknown> = {}, type = "customer.subscription.updated") => ({
    id: "evt_x", type, data: { object: { id: "sub_1", customer: "cus_1", status: "active", cancel_at_period_end: false, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86_400, metadata: { workspaceId, plan: "growth" }, items: { data: [{ price: { id: "price_growth_test" } }] }, ...over } },
  });

  it("subscription.updated : plan déduit du prix, statut actif, fin de période", async () => {
    const { workspaceId } = await setup();
    expect(planFromPriceId("price_pro_test")).toBe("pro");
    expect((await handleStripeEvent(subEvent(workspaceId))).handled).toBe(true);
    const s = await db.subscription.findUniqueOrThrow({ where: { workspaceId } });
    expect([s.plan, s.status, s.stripeSubscriptionId, s.cancelAtPeriodEnd]).toEqual(["growth", "active", "sub_1", false]);
    expect(entitlement(s).state).toBe("paid");
    await handleStripeEvent(subEvent(workspaceId)); // rejouer le même événement ne change rien
    expect((await db.subscription.findUniqueOrThrow({ where: { workspaceId } })).plan).toBe("growth");
  });

  it("résiliation programmée, échec de paiement, suppression", async () => {
    const { workspaceId } = await setup();
    await handleStripeEvent(subEvent(workspaceId, { cancel_at_period_end: true }));
    expect(entitlement(await db.subscription.findUniqueOrThrow({ where: { workspaceId } })).state).toBe("canceling");
    await handleStripeEvent({ id: "e2", type: "invoice.payment_failed", data: { object: { customer: "cus_1", subscription: "sub_1" } } });
    expect((await db.subscription.findUniqueOrThrow({ where: { workspaceId } })).status).toBe("past_due");
    await handleStripeEvent({ id: "e3", type: "invoice.paid", data: { object: { customer: "cus_1", subscription: "sub_1" } } });
    expect((await db.subscription.findUniqueOrThrow({ where: { workspaceId } })).status).toBe("active");
    await handleStripeEvent(subEvent(workspaceId, { status: "canceled" }, "customer.subscription.deleted"));
    const s = await db.subscription.findUniqueOrThrow({ where: { workspaceId } });
    expect(s.status).toBe("canceled");
    expect(entitlement(s).active).toBe(false);
  });

  it("checkout.session.completed relie client et abonnement ; événement d'un client inconnu ignoré", async () => {
    const { workspaceId } = await makeWorkspace();
    await handleStripeEvent({ id: "e", type: "checkout.session.completed", data: { object: { client_reference_id: workspaceId, customer: "cus_9", subscription: "sub_9" } } });
    const s = await db.subscription.findUniqueOrThrow({ where: { workspaceId } });
    expect([s.stripeCustomerId, s.stripeSubscriptionId]).toEqual(["cus_9", "sub_9"]);
    expect((await handleStripeEvent({ id: "e", type: "invoice.paid", data: { object: { customer: "inconnu" } } })).handled).toBe(false);
    expect((await handleStripeEvent({ id: "e", type: "type.inconnu", data: { object: {} } })).handled).toBe(false);
  });

  it("route webhook : 503 sans secret, 400 signature invalide, 200 valide", async () => {
    const { workspaceId } = await setup();
    const payload = JSON.stringify(subEvent(workspaceId));
    const req = (sig: string | null) => new Request("http://x/api/stripe/webhook", { method: "POST", headers: sig ? { "stripe-signature": sig } : {}, body: payload });
    expect((await webhook(req(null))).status).toBe(503);
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    expect((await webhook(req("t=1,v1=bad"))).status).toBe(400);
    const ok = await webhook(req(sign(payload, "whsec_test")));
    expect(ok.status).toBe(200);
    expect((await ok.json()).handled).toBe(true);
    expect((await db.subscription.findUniqueOrThrow({ where: { workspaceId } })).status).toBe("active");
  });

  it("changement de plan payant : appels Stripe attendus (mock), downgrade bloqué si usage trop élevé", async () => {
    const { workspaceId } = await setup();
    await handleStripeEvent(subEvent(workspaceId));
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    const calls: { url: string; body?: string }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      calls.push({ url: String(input), body: init?.body as string | undefined });
      return new Response(JSON.stringify({ items: { data: [{ id: "si_1" }] } }), { status: 200 });
    });
    await changePaidPlan(workspaceId, "pro");
    expect(calls[0].url).toContain("/subscriptions/sub_1");
    expect(calls[1].body).toContain("items%5B0%5D%5Bprice%5D=price_pro_test");
    expect((await db.subscription.findUniqueOrThrow({ where: { workspaceId } })).plan).toBe("pro");
    for (let i = 0; i < 5; i++) await db.landingPage.create({ data: { workspaceId, name: `P${i}`, slug: `p${i}`, sections: [] } });
    await expect(changePaidPlan(workspaceId, "starter")).rejects.toThrow(/dépasse les limites/);
    await expect(changePaidPlan(workspaceId, "pro")).rejects.toThrow(/déjà sur ce plan/);
  });
});
