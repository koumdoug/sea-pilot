// Lot 6 : forfaits Starter / Growth / Pro, essai, abonnement Stripe confirmé par webhook, paiement indisponible, accès propriétaire gratuit,
// restrictions réellement appliquées, cohérence entre forfait affiché et limites appliquées, isolation entre organisations.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state: { ws: string; role: string } = { ws: "", role: "owner" };
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (u: string) => { throw new Error("NEXT_REDIRECT:" + u); },
  unstable_rethrow: (e: unknown) => { if (e instanceof Error && e.message.startsWith("NEXT_REDIRECT")) throw e; },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));
vi.mock("@/lib/tenant", async (orig) => {
  const actual = await orig<typeof import("@/lib/tenant")>();
  return {
    ...actual,
    requireCtx: async (opts: { action?: import("@/lib/permissions").Action } = {}) => {
      const { db } = await import("@/lib/db");
      const { assertCan, can } = await import("@/lib/permissions");
      const { entitlementForWorkspace } = await import("@/lib/free-access");
      const ws = await db.workspace.findUniqueOrThrow({ where: { id: state.ws }, include: { subscription: true } });
      const m = await db.membership.findFirstOrThrow({ where: { workspaceId: state.ws }, include: { user: true } });
      if (opts.action) assertCan(state.role, opts.action);
      return { user: { id: m.userId, email: m.user.email, name: m.user.name }, workspace: ws, workspaceId: ws.id, role: state.role, subscription: ws.subscription, ent: await entitlementForWorkspace(ws.id, ws.subscription), can: (a: import("@/lib/permissions").Action) => can(state.role, a) } as never;
    },
  };
});

import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { PLAN_IDS } from "@/lib/constants";
import { LIVE_SUBSCRIPTION_STATES, PLANS, UNLIMITED, describePlan, entitlement, isLiveSubscription, limitReached, limitText, type Entitlement } from "@/lib/plans";
import { entitlementForWorkspace } from "@/lib/free-access";
import { BillingError, changePaidPlan, createCheckoutSession, createPortalSession, planCheckoutReady, selectTrialPlan, setStripeGateway, setCancelAtPeriodEnd, stripeSetup, workspaceUsage, type StripeEvent } from "@/lib/billing";
import { billingStatus, manageActions, planActions } from "@/lib/billing-ui";
import { transitionCampaign } from "@/lib/campaigns";
import { POST as webhook } from "@/app/api/stripe/webhook/route";
import { cancelAction, changePlanAction, checkoutAction, portalAction, selectTrialPlanAction } from "../src/app/(app)/billing/actions";
import { makeWorkspace, resetDb } from "./helpers";
import { deliver, fake } from "./stripe-fake";

const DAY = 86_400_000;
const SAVED = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "FREE_ACCESS_USER_IDS", "STRIPE_PRICE_STARTER", "STRIPE_PRICE_GROWTH", "STRIPE_PRICE_PRO"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(async () => { for (const k of SAVED) saved[k] = process.env[k]; await resetDb(); });
afterEach(() => { for (const k of SAVED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } vi.restoreAllMocks(); });

let n = 0;
const ev = (type: string, object: Record<string, unknown>, id = `evt_${++n}`): StripeEvent => ({ id, type, data: { object } });
const subObj = (workspaceId: string, plan: "starter" | "growth" | "pro", over: Record<string, unknown> = {}, subId = "sub_1", customer = "cus_1") => ({
  id: subId, customer, status: "active", cancel_at_period_end: false, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86_400,
  metadata: { workspaceId, plan }, items: { data: [{ price: { id: `price_${plan}_test` } }] }, ...over,
});
const sub = (workspaceId: string) => db.subscription.findUniqueOrThrow({ where: { workspaceId } });
const entOf = async (workspaceId: string): Promise<Entitlement> => entitlementForWorkspace(workspaceId, await sub(workspaceId));
const sign = async (payload: string, secret: string) => { const { createHmac } = await import("node:crypto"); const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`; };
const configureStripe = () => { process.env.STRIPE_SECRET_KEY = "sk_test_x"; process.env.STRIPE_WEBHOOK_SECRET = "whsec_x"; };
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

describe("1-6. forfaits : attribution initiale, limites affichées et limites appliquées (source unique)", () => {
  it("1. nouvelle organisation : essai de Starter, durée d'essai configurée, aucun abonnement Stripe", async () => {
    const { workspaceId } = await makeWorkspace();
    const s = await sub(workspaceId);
    expect(s).toMatchObject({ plan: "starter", status: "trialing", stripeSubscriptionId: null, stripeCustomerId: null });
    expect(Math.round((s.trialEndsAt!.getTime() - Date.now()) / DAY)).toBe(env.trialDays);
    const e = await entOf(workspaceId);
    expect(e).toMatchObject({ active: true, state: "trial" });
    expect(e.plan.id).toBe("starter");
  });
  it("2-3-4-5-6. limites de chaque forfait conformes à l'offre commerciale (source centrale PLANS)", () => {
    expect(PLANS.starter.limits).toMatchObject({ members: 1, activeCampaigns: 3, landingPages: 3, leadsPerMonth: 300 });
    expect(PLANS.growth.limits).toMatchObject({ members: 5, activeCampaigns: 15, landingPages: 15, leadsPerMonth: 2000 });
    expect(PLANS.pro.limits).toMatchObject({ members: 25, activeCampaigns: UNLIMITED, landingPages: UNLIMITED, leadsPerMonth: UNLIMITED, sequences: UNLIMITED });
    expect(PLANS.starter.features).toEqual(expect.arrayContaining(["Qualification des leads", "Analytics et recommandations"]));
    expect(PLANS.growth.features).toEqual(expect.arrayContaining(["Séquences de relance"]));
    expect(PLANS.pro.features).toEqual(expect.arrayContaining(["Accès API", "Séquences illimitées", "Leads illimités"]));
    expect([limitText(UNLIMITED), limitText(15), limitText(2000)]).toEqual(["∞", "15", "2 000"]);
  });
  it("18. les avantages affichés sont dérivés des limites : aucune divergence possible entre affiché et appliqué", () => {
    for (const id of PLAN_IDS) {
      const p = PLANS[id];
      const text = p.features.join(" | ").replace(/\s/g, " ");
      expect(text, id).toContain(`${p.limits.members} utilisateur`);
      if (p.limits.activeCampaigns !== UNLIMITED) expect(text, id).toContain(`${p.limits.activeCampaigns} campagnes actives`);
      if (p.limits.landingPages !== UNLIMITED) expect(text, id).toContain(`${p.limits.landingPages} landing pages`);
      if (p.limits.leadsPerMonth !== UNLIMITED) expect(text, id).toMatch(new RegExp(`${limitText(p.limits.leadsPerMonth)} leads / mois \\(seuil indicatif\\)`));
      expect(p.features.slice(0, describePlan(p.limits, []).length), id).toEqual(describePlan(p.limits, []));
    }
  });
  it("18. le forfait attribué à l'organisation détermine exactement les limites appliquées, pour chaque forfait et chaque statut actif", async () => {
    for (const plan of PLAN_IDS) {
      const { workspaceId } = await makeWorkspace();
      await db.subscription.update({ where: { workspaceId }, data: { plan } }); // essai de ce forfait
      expect((await entOf(workspaceId)).plan.limits, plan).toEqual(PLANS[plan].limits);
      await db.subscription.update({ where: { workspaceId }, data: { status: "active", currentPeriodEnd: new Date(Date.now() + 20 * DAY), stripeSubscriptionId: `sub_${plan}_${workspaceId}` } }); // abonnement payant
      const e = await entOf(workspaceId);
      expect([e.state, e.plan.id, e.plan.limits]).toEqual(["paid", plan, PLANS[plan].limits]);
    }
  });
});

describe("17. restrictions d'accès réellement appliquées selon le forfait", () => {
  async function fill(workspaceId: string, o: { pages?: number; activeCampaigns?: number; keys?: number; sequences?: number }) {
    for (let i = 0; i < (o.pages ?? 0); i++) await db.landingPage.create({ data: { workspaceId, name: `P${i}`, slug: `p${++n}-${workspaceId}`, sections: [] } });
    for (let i = 0; i < (o.activeCampaigns ?? 0); i++) await db.campaign.create({ data: { workspaceId, name: `C${i}`, status: "active" } });
    for (let i = 0; i < (o.keys ?? 0); i++) await db.apiKey.create({ data: { workspaceId, name: `K${i}`, prefix: `k${i}${workspaceId.slice(-4)}`, hash: `h${i}${workspaceId}` } as never });
    for (let i = 0; i < (o.sequences ?? 0); i++) await db.followUpSequence.create({ data: { workspaceId, name: `S${i}`, steps: [] } as never });
  }
  it("Starter : 3 pages et 3 campagnes actives maximum, 1 utilisateur", async () => {
    const { workspaceId } = await makeWorkspace();
    await fill(workspaceId, { pages: 3, activeCampaigns: 3 });
    const e = await entOf(workspaceId), u = await workspaceUsage(workspaceId);
    expect(limitReached(e.plan, "landingPages", u.landingPages)).toBe(true);
    expect(limitReached(e.plan, "activeCampaigns", u.activeCampaigns)).toBe(true);
    expect(limitReached(e.plan, "members", u.members)).toBe(true); // 1 utilisateur déjà présent
  });
  it("Growth : mêmes volumes acceptés, limites de 15 ; Pro : illimité", async () => {
    const g = await makeWorkspace(); await db.subscription.update({ where: { workspaceId: g.workspaceId }, data: { plan: "growth" } });
    await fill(g.workspaceId, { pages: 14, activeCampaigns: 14 });
    let e = await entOf(g.workspaceId), u = await workspaceUsage(g.workspaceId);
    expect([limitReached(e.plan, "landingPages", u.landingPages), limitReached(e.plan, "activeCampaigns", u.activeCampaigns)]).toEqual([false, false]);
    await fill(g.workspaceId, { pages: 1, activeCampaigns: 1 });
    u = await workspaceUsage(g.workspaceId);
    expect([limitReached(e.plan, "landingPages", u.landingPages), limitReached(e.plan, "activeCampaigns", u.activeCampaigns)]).toEqual([true, true]);
    const p = await makeWorkspace(); await db.subscription.update({ where: { workspaceId: p.workspaceId }, data: { plan: "pro" } });
    await fill(p.workspaceId, { pages: 30, activeCampaigns: 30 });
    e = await entOf(p.workspaceId); u = await workspaceUsage(p.workspaceId);
    expect([limitReached(e.plan, "landingPages", u.landingPages), limitReached(e.plan, "activeCampaigns", u.activeCampaigns), limitReached(e.plan, "sequences", 10_000)]).toEqual([false, false, false]);
  });
  it("l'activation d'une campagne applique la limite du forfait réellement attribué (Starter refuse la 4e, Growth l'accepte)", async () => {
    const mk = async (plan: "starter" | "growth") => {
      const { workspaceId } = await makeWorkspace(); await db.subscription.update({ where: { workspaceId }, data: { plan } });
      const lp = await db.landingPage.create({ data: { workspaceId, name: "L", slug: `l-${workspaceId}`, status: "published", sections: [] } });
      const offer = await db.offer.create({ data: { workspaceId, name: "O" } }); const aud = await db.audience.create({ data: { workspaceId, name: "A" } });
      await fill(workspaceId, { activeCampaigns: 3 });
      const c = await db.campaign.create({ data: { workspaceId, name: "Quatrième", status: "ready", platform: "google_ads", budget: 100, objective: "leads", offerId: offer.id, audienceId: aud.id, landingPageId: lp.id } });
      return { workspaceId, id: c.id };
    };
    const s = await mk("starter");
    await expect(transitionCampaign({ workspaceId: s.workspaceId, campaignId: s.id, to: "active" })).rejects.toThrow(/Limite de campagnes actives/);
    const g = await mk("growth");
    await expect(transitionCampaign({ workspaceId: g.workspaceId, campaignId: g.id, to: "active" })).resolves.toMatchObject({ status: "active" });
  });
  it("accès suspendu à la fin de l'essai : plus aucun droit, quel que soit le forfait d'essai", async () => {
    const { workspaceId } = await makeWorkspace();
    await db.subscription.update({ where: { workspaceId }, data: { plan: "pro", trialEndsAt: new Date(Date.now() - DAY) } });
    expect(await entOf(workspaceId)).toMatchObject({ active: false, state: "trial_expired" });
  });
});

describe("7-9. changements de forfait : appliqués uniquement à la confirmation de Stripe", () => {
  const link = async (workspaceId: string, customer = "cus_1") => { await db.subscription.update({ where: { workspaceId }, data: { stripeCustomerId: customer } }); };
  const confirm = (workspaceId: string, plan: "starter" | "growth" | "pro", subId = "sub_1", customer = "cus_1") => deliver(ev("customer.subscription.updated", subObj(workspaceId, plan, {}, subId, customer)));

  it("7. Starter → Growth : le paiement confirmé par Stripe attribue Growth ; avant, rien ne change", async () => {
    const { workspaceId } = await makeWorkspace(); await link(workspaceId);
    await deliver(ev("checkout.session.completed", { client_reference_id: workspaceId, customer: "cus_1", subscription: "sub_1" }));
    expect(await sub(workspaceId)).toMatchObject({ plan: "starter", status: "trialing", stripeSubscriptionId: "sub_1" }); // lien seulement : aucun droit payant
    expect((await entOf(workspaceId)).state).toBe("trial");
    await confirm(workspaceId, "growth");
    expect(await entOf(workspaceId)).toMatchObject({ active: true, state: "paid" });
    expect((await entOf(workspaceId)).plan.id).toBe("growth");
  });
  it("8. Growth → Pro, 9. Pro → Starter (usage compatible), et tous les autres sens : le forfait suit l'événement Stripe", async () => {
    const { workspaceId } = await makeWorkspace(); await link(workspaceId);
    for (const plan of ["growth", "pro", "starter", "pro", "growth", "starter"] as const) {
      await confirm(workspaceId, plan);
      const e = await entOf(workspaceId);
      expect([e.plan.id, e.state, e.plan.limits]).toEqual([plan, "paid", PLANS[plan].limits]);
    }
  });
  it("une demande de changement n'attribue rien avant l'événement ; une rétrogradation est refusée si l'usage dépasse", async () => {
    const { workspaceId } = await makeWorkspace(); await link(workspaceId); configureStripe();
    await confirm(workspaceId, "pro");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ items: { data: [{ id: "si_1" }] } }), { status: 200 }));
    await changePaidPlan(workspaceId, "growth");
    expect((await sub(workspaceId)).plan).toBe("pro"); // inchangé jusqu'à la confirmation
    await confirm(workspaceId, "growth");
    expect((await sub(workspaceId)).plan).toBe("growth");
    for (let i = 0; i < 4; i++) await db.landingPage.create({ data: { workspaceId, name: `P${i}`, slug: `x${i}`, sections: [] } });
    await expect(changePaidPlan(workspaceId, "starter")).rejects.toThrow(/Landing pages : 4 utilisé\(s\) pour une limite de 3/);
    expect((await sub(workspaceId)).plan).toBe("growth");
  });
  it("6. fin d'abonnement : aucun repli automatique vers un Starter gratuit — l'accès est suspendu (règle commerciale existante)", async () => {
    const { workspaceId } = await makeWorkspace(); await link(workspaceId);
    await confirm(workspaceId, "pro");
    await deliver(ev("customer.subscription.deleted", subObj(workspaceId, "pro", { status: "canceled" })));
    const e = await entOf(workspaceId);
    expect(e).toMatchObject({ active: false, state: "canceled" });
    expect((await sub(workspaceId)).plan).toBe("pro"); // conservé pour mémoire, sans aucun droit
  });
  it("réabonnement après résiliation : le nouvel abonnement Stripe remplace l'ancien", async () => {
    const { workspaceId } = await makeWorkspace(); await link(workspaceId);
    await confirm(workspaceId, "growth", "sub_old");
    await deliver(ev("customer.subscription.deleted", subObj(workspaceId, "growth", { status: "canceled" }, "sub_old")));
    await confirm(workspaceId, "pro", "sub_new");
    expect(await sub(workspaceId)).toMatchObject({ plan: "pro", status: "active", stripeSubscriptionId: "sub_new" });
  });
  it("un événement d'un ancien abonnement n'écrase jamais l'abonnement courant", async () => {
    const { workspaceId } = await makeWorkspace(); await link(workspaceId);
    await confirm(workspaceId, "pro", "sub_new");
    expect((await deliver(ev("customer.subscription.deleted", subObj(workspaceId, "growth", { status: "canceled" }, "sub_old")))).handled).toBe(false);
    expect(await sub(workspaceId)).toMatchObject({ plan: "pro", status: "active", stripeSubscriptionId: "sub_new" });
    expect((await deliver(ev("invoice.payment_failed", { customer: "cus_1", subscription: "sub_old" }))).handled).toBe(false);
    expect((await sub(workspaceId)).status).toBe("active");
  });
});

describe("10-11. essai gratuit : actif, expiré, et distinct d'un abonnement payé", () => {
  it("10. essai actif : forfait d'essai modifiable sans paiement, limites du forfait choisi, aucun abonnement Stripe créé", async () => {
    const { workspaceId } = await makeWorkspace();
    await selectTrialPlan(workspaceId, "growth");
    const s = await sub(workspaceId), e = await entOf(workspaceId);
    expect(s).toMatchObject({ plan: "growth", status: "trialing", stripeSubscriptionId: null });
    expect([e.state, e.plan.limits]).toEqual(["trial", PLANS.growth.limits]);
    expect(e.state).not.toBe("paid"); // un essai n'est jamais un abonnement payé
  });
  it("11. essai expiré : le changement de forfait d'essai est refusé côté serveur, l'accès est suspendu", async () => {
    const { workspaceId } = await makeWorkspace();
    await db.subscription.update({ where: { workspaceId }, data: { trialEndsAt: new Date(Date.now() - 1000) } });
    await expect(selectTrialPlan(workspaceId, "pro")).rejects.toThrow(/essai gratuit est terminé/);
    expect((await sub(workspaceId)).plan).toBe("starter");
    expect(await entOf(workspaceId)).toMatchObject({ active: false, state: "trial_expired" });
  });
  it("aucune facturation automatique : l'essai ne crée ni client ni abonnement Stripe", async () => {
    const { workspaceId } = await makeWorkspace();
    await selectTrialPlan(workspaceId, "pro");
    expect(await sub(workspaceId)).toMatchObject({ stripeCustomerId: null, stripeSubscriptionId: null });
  });
});

describe("12-14. paiement Stripe : confirmé, refusé, webhook reçu plusieurs fois", () => {
  const link = (workspaceId: string) => db.subscription.update({ where: { workspaceId }, data: { stripeCustomerId: "cus_1" } });
  it("12. paiement confirmé : abonnement actif au forfait du prix Stripe, période de facturation enregistrée", async () => {
    const { workspaceId } = await makeWorkspace(); await link(workspaceId);
    await deliver(ev("customer.subscription.created", subObj(workspaceId, "growth")));
    await deliver(ev("invoice.paid", { customer: "cus_1", subscription: "sub_1" }));
    const s = await sub(workspaceId);
    expect([s.plan, s.status]).toEqual(["growth", "active"]);
    expect(s.currentPeriodEnd!.getTime()).toBeGreaterThan(Date.now());
  });
  it("13. paiement refusé : un premier paiement non abouti n'attribue aucun forfait et ne retire pas l'essai valide", async () => {
    const { workspaceId } = await makeWorkspace(); await link(workspaceId);
    await deliver(ev("customer.subscription.created", subObj(workspaceId, "pro", { status: "incomplete" })));
    expect(await sub(workspaceId)).toMatchObject({ plan: "starter", status: "trialing" });
    expect((await deliver(ev("invoice.payment_failed", { customer: "cus_1", subscription: "sub_1" }))).handled).toBe(false);
    expect(await sub(workspaceId)).toMatchObject({ plan: "starter", status: "trialing" });
    expect(await entOf(workspaceId)).toMatchObject({ active: true, state: "trial" });
  });
  it("13 bis. paiement refusé sur un abonnement payant : « paiement en échec » (grâce de 7 jours), le forfait est conservé ; reprise à la facture payée", async () => {
    const { workspaceId } = await makeWorkspace(); await link(workspaceId);
    await deliver(ev("customer.subscription.updated", subObj(workspaceId, "growth")));
    await deliver(ev("invoice.payment_failed", { customer: "cus_1", subscription: "sub_1" }));
    expect(await sub(workspaceId)).toMatchObject({ plan: "growth", status: "past_due" });
    expect(await entOf(workspaceId)).toMatchObject({ active: true, state: "past_due" });
    await deliver(ev("invoice.paid", { customer: "cus_1", subscription: "sub_1" }));
    expect((await sub(workspaceId)).status).toBe("active");
  });
  it("une facture payée ne réactive pas un abonnement terminé", async () => {
    const { workspaceId } = await makeWorkspace(); await link(workspaceId);
    await deliver(ev("customer.subscription.updated", subObj(workspaceId, "pro")));
    await deliver(ev("customer.subscription.deleted", subObj(workspaceId, "pro", { status: "canceled" })));
    expect((await deliver(ev("invoice.paid", { customer: "cus_1", subscription: "sub_1" }))).handled).toBe(false);
    expect((await sub(workspaceId)).status).toBe("canceled");
  });
  it("14. webhook reçu plusieurs fois : traité une seule fois ; un ancien événement rejoué n'annule pas un changement plus récent", async () => {
    const { workspaceId } = await makeWorkspace(); await link(workspaceId);
    const a = ev("customer.subscription.updated", subObj(workspaceId, "growth"), "evt_A");
    const b = ev("customer.subscription.updated", subObj(workspaceId, "pro"), "evt_B");
    expect(await deliver(a)).toEqual({ handled: true });
    expect(await deliver(a)).toEqual({ handled: false, duplicate: true });
    expect(await deliver(a)).toEqual({ handled: false, duplicate: true });
    await deliver(b);
    await deliver(a); // rejeu tardif de l'ancien événement
    expect((await sub(workspaceId)).plan).toBe("pro");
    expect(await db.auditLog.count({ where: { action: "billing.stripe_event", entityId: "evt_A" } })).toBe(1);
  });
  it("route webhook : le même événement envoyé deux fois répond 200 les deux fois, sans second effet", async () => {
    const { workspaceId } = await makeWorkspace(); await link(workspaceId);
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_x";
    const routeEvent = ev("customer.subscription.updated", subObj(workspaceId, "growth"), "evt_route");
    const payload = JSON.stringify(routeEvent);
    setStripeGateway(fake); fake.mirror(routeEvent); // état réel chez Stripe : celui de l'événement
    const send = async () => webhook(new Request("http://x/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": await sign(payload, "whsec_x") }, body: payload }));
    const r1 = await (await send()).json(), r2 = await (await send()).json();
    expect(r1).toMatchObject({ received: true, handled: true });
    expect(r2).toMatchObject({ received: true, handled: false, duplicate: true });
    expect((await sub(workspaceId)).plan).toBe("growth");
  });
});

describe("15. Stripe non configuré ou partiellement configuré : souscription indisponible, rien n'est simulé", () => {
  it("aucune variable : aucun forfait souscriptible, création de session refusée, forfait et données conservés", async () => {
    delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_WEBHOOK_SECRET;
    const { workspaceId } = await makeWorkspace();
    const setup = stripeSetup();
    expect(setup.anyReady).toBe(false);
    expect(setup.variables.map((v) => v.name)).toEqual(["STRIPE_SECRET_KEY", "STRIPE_PRICE_STARTER", "STRIPE_PRICE_GROWTH", "STRIPE_PRICE_PRO", "STRIPE_WEBHOOK_SECRET"]);
    expect(setup.variables.find((v) => v.name === "STRIPE_SECRET_KEY")!.set).toBe(false);
    for (const id of PLAN_IDS) expect(planCheckoutReady(id)).toBe(false);
    await expect(createCheckoutSession({ workspaceId, plan: "growth", email: "a@b.c" })).rejects.toThrow(BillingError);
    expect(await sub(workspaceId)).toMatchObject({ plan: "starter", status: "trialing", stripeCustomerId: null });
  });
  it("clé et prix présents mais secret de webhook manquant : souscription désactivée (un paiement ne serait jamais confirmé)", () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_x"; delete process.env.STRIPE_WEBHOOK_SECRET;
    const s = stripeSetup();
    expect(s.anyReady).toBe(false);
    expect(s.issues.join(" ")).toMatch(/STRIPE_WEBHOOK_SECRET manque/);
    expect(planCheckoutReady("growth")).toBe(false);
  });
  it("deux forfaits sur le même prix Stripe : signalé, ces deux forfaits ne sont pas souscriptibles", () => {
    configureStripe(); process.env.STRIPE_PRICE_GROWTH = process.env.STRIPE_PRICE_PRO!;
    const s = stripeSetup();
    expect(s.issues.join(" ")).toMatch(/Growth et Pro utilisent le même prix Stripe/);
    expect(s.ready).toEqual({ starter: true, growth: false, pro: false });
  });
  it("configuration complète et prix distincts : chaque forfait est associé à son propre prix", () => {
    configureStripe();
    const s = stripeSetup();
    expect(s.ready).toEqual({ starter: true, growth: true, pro: true });
    expect(s.issues).toEqual([]);
    expect(new Set(PLAN_IDS.map((id) => env.stripePriceId(id))).size).toBe(3);
  });
  it("les boutons ne proposent aucun achat sans configuration : « indisponible » à la place (jamais un bouton qui ne fait rien)", () => {
    for (const planId of PLAN_IDS) {
      const acts = planActions({ planId, currentPlanId: "starter", state: "trial", owner: true, hasStripeSubscription: false, checkoutReady: false });
      expect(acts.some((a) => a.kind === "checkout" || a.kind === "change")).toBe(false);
      expect(acts.some((a) => a.kind === "unavailable")).toBe(true);
    }
  });
});

describe("billingStatus et planActions : statut réel et actions réellement disponibles", () => {
  const fmtD = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : "—");
  const now = new Date("2026-10-29T12:00:00Z");
  const e = (s: object) => entitlement({ plan: "starter", status: "trialing", trialEndsAt: null, currentPeriodEnd: null, ...s } as never, now);

  it("essai gratuit : explicitement un essai, sans paiement, avec la date de fin", () => {
    const st = billingStatus(e({ trialEndsAt: new Date(now.getTime() + 14 * DAY) }), { trialEndsAt: new Date(now.getTime() + 14 * DAY), currentPeriodEnd: null, hasStripeCustomer: false }, fmtD);
    expect(st.label).toBe("Essai gratuit");
    expect(st.summary).toMatch(/Essai gratuit du plan Starter : aucun paiement n'a été effectué\. Il reste 14 jours \(jusqu'au 2026-11-12\)/);
  });
  it("abonnement actif, paiement en attente, expiré, terminé, propriétaire gratuit : libellés distincts", () => {
    expect(billingStatus(e({ status: "active", currentPeriodEnd: new Date(now.getTime() + 20 * DAY) }), null, fmtD)).toMatchObject({ label: "Abonnement actif", tone: "green" });
    expect(billingStatus(e({ status: "incomplete" }), { trialEndsAt: null, currentPeriodEnd: null, hasStripeCustomer: true }, fmtD).label).toBe("Paiement en attente");
    expect(billingStatus(e({ status: "incomplete" }), { trialEndsAt: null, currentPeriodEnd: null, hasStripeCustomer: false }, fmtD).label).toBe("Aucun abonnement actif");
    expect(billingStatus(e({ trialEndsAt: new Date(now.getTime() - DAY) }), null, fmtD).label).toBe("Essai expiré");
    expect(billingStatus(e({ status: "canceled" }), null, fmtD).label).toBe("Abonnement terminé");
    const ex = billingStatus({ active: true, state: "exempt", plan: PLANS.pro, daysLeft: null }, null, fmtD);
    expect(ex.label).toBe("Accès propriétaire gratuit");
    expect(ex.summary).toMatch(/sans abonnement ni paiement/);
  });
  const act = (o: Partial<Parameters<typeof planActions>[0]>) => planActions({ planId: "growth", currentPlanId: "starter", state: "trial", owner: true, hasStripeSubscription: false, checkoutReady: true, ...o });
  it("essai : plan d'essai actuel, « Essayer ce plan » et souscription Stripe pour les autres", () => {
    expect(act({ planId: "starter" }).map((a) => a.kind)).toEqual(["current", "checkout"]);
    expect(act({}).map((a) => a.kind)).toEqual(["try", "checkout"]);
  });
  it("abonnement payant : plan actuel, « Passer à » (hausse), « Rétrograder vers » avec confirmation (baisse) ; indisponible sans configuration", () => {
    const paid = { state: "paid" as const, hasStripeSubscription: true };
    expect(act({ ...paid, planId: "growth", currentPlanId: "growth" })).toEqual([{ kind: "current", label: "Plan actuel" }]);
    expect(act({ ...paid, planId: "pro", currentPlanId: "growth" })).toEqual([{ kind: "change", label: "Passer à Pro" }]);
    const down = act({ ...paid, planId: "starter", currentPlanId: "growth" })[0];
    expect(down).toMatchObject({ kind: "change", label: "Rétrograder vers Starter" });
    expect((down as { confirm?: string }).confirm).toMatch(/limites/);
    expect(act({ ...paid, planId: "pro", currentPlanId: "growth", checkoutReady: false })[0].kind).toBe("unavailable");
  });
  it("essai expiré ou abonnement terminé : souscrire est proposé pour tous les forfaits, y compris le dernier", () => {
    for (const state of ["trial_expired", "canceled", "incomplete"] as const) {
      expect(act({ state, planId: "starter" }).map((a) => a.kind), state).toEqual(["current", "checkout"]);
      expect(act({ state, planId: "pro" }).map((a) => a.kind), state).toEqual(["checkout"]);
    }
  });
  it("propriétaire gratuit : aucun achat, essai ni changement n'est proposé", () => {
    for (const planId of PLAN_IDS) {
      const acts = act({ state: "exempt", currentPlanId: "pro", planId });
      expect(acts.every((a) => a.kind === "current" || a.kind === "note"), planId).toBe(true);
    }
  });
  it("un membre non propriétaire ne voit aucune action de modification", () => {
    expect(act({ owner: false, planId: "pro" })).toEqual([]);
    expect(act({ owner: false, planId: "starter" }).map((a) => a.kind)).toEqual(["current"]);
  });
});

describe("16. accès propriétaire gratuit : jamais bloqué, rétrogradé ni facturé", () => {
  it("espace exempté : plan Pro, actif même si l'essai est expiré ou l'abonnement résilié ; aucune souscription n'est acceptée", async () => {
    const w = await makeWorkspace();
    process.env.FREE_ACCESS_USER_IDS = w.userId;
    state.ws = w.workspaceId; state.role = "owner";
    await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { status: "canceled", trialEndsAt: new Date(Date.now() - 30 * DAY) } });
    const e = await entOf(w.workspaceId);
    expect(e).toMatchObject({ active: true, state: "exempt" });
    expect([e.plan.id, e.plan.limits]).toEqual(["pro", PLANS.pro.limits]);
    configureStripe();
    for (const r of [await checkoutAction({}, fd({ plan: "growth" })), await selectTrialPlanAction({}, fd({ plan: "starter" })), await changePlanAction({}, fd({ plan: "starter" })), await cancelAction({}, fd({ cancel: "1" }))]) {
      expect(r.ok).toBeFalsy();
      expect(r.error).toMatch(/accès propriétaire gratuit/);
    }
    expect((await sub(w.workspaceId)).stripeCustomerId).toBeNull(); // rien n'a été facturé ni créé chez Stripe
  });
  it("sans liste d'exception, la même organisation est soumise à l'abonnement (aucune exemption implicite)", async () => {
    const w = await makeWorkspace(); delete process.env.FREE_ACCESS_USER_IDS;
    await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { trialEndsAt: new Date(Date.now() - DAY) } });
    expect((await entOf(w.workspaceId)).state).toBe("trial_expired");
  });
  it("un propriétaire listé qui n'est que membre d'un autre espace n'exempte pas cet espace", async () => {
    const owner = await makeWorkspace(); const other = await makeWorkspace();
    await db.membership.create({ data: { userId: other.userId, workspaceId: owner.workspaceId, role: "member" } });
    process.env.FREE_ACCESS_USER_IDS = other.userId;
    expect((await entOf(owner.workspaceId)).state).not.toBe("exempt");
    expect((await entOf(other.workspaceId)).state).toBe("exempt");
  });
});

describe("isolation : un changement de forfait chez un client ne modifie jamais le forfait d'un autre", () => {
  it("événements Stripe, essai et résiliation d'une organisation n'altèrent pas les autres", async () => {
    const a = await makeWorkspace(), b = await makeWorkspace(), c = await makeWorkspace();
    await db.subscription.update({ where: { workspaceId: a.workspaceId }, data: { stripeCustomerId: "cus_a" } });
    await db.subscription.update({ where: { workspaceId: b.workspaceId }, data: { stripeCustomerId: "cus_b" } });
    const before = { b: await sub(b.workspaceId), c: await sub(c.workspaceId) };
    await deliver(ev("customer.subscription.updated", subObj(a.workspaceId, "pro", {}, "sub_a", "cus_a")));
    await deliver(ev("invoice.payment_failed", { customer: "cus_a", subscription: "sub_a" }));
    await selectTrialPlan(c.workspaceId, "growth");
    expect((await sub(a.workspaceId))).toMatchObject({ plan: "pro", status: "past_due" });
    expect(await sub(b.workspaceId)).toEqual(before.b);
    expect({ ...(await sub(c.workspaceId)), plan: "x", updatedAt: null }).toEqual({ ...before.c, plan: "x", updatedAt: null });
    expect((await sub(c.workspaceId)).plan).toBe("growth");
    await deliver(ev("customer.subscription.deleted", subObj(a.workspaceId, "pro", { status: "canceled" }, "sub_a", "cus_a")));
    expect(await sub(b.workspaceId)).toEqual(before.b);
  });
  it("un événement d'un client inconnu ou d'un autre abonnement ne touche aucune organisation", async () => {
    const a = await makeWorkspace(); await db.subscription.update({ where: { workspaceId: a.workspaceId }, data: { stripeCustomerId: "cus_a" } });
    const before = await sub(a.workspaceId);
    expect((await deliver(ev("customer.subscription.updated", { id: "sub_x", customer: "cus_inconnu", status: "active", metadata: {}, items: { data: [{ price: { id: "price_pro_test" } }] } }))).handled).toBe(false);
    expect(await sub(a.workspaceId)).toEqual(before);
  });
});

describe("D1 : un abonnement Stripe terminé ne propose ni n'accepte aucune action de gestion (interface ET serveur)", () => {
  const NOW = new Date("2026-10-29T12:00:00Z");
  const row = (o: Record<string, unknown>) => ({ plan: "growth", status: "active", trialEndsAt: null, currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY), cancelAtPeriodEnd: false, stripeSubscriptionId: "sub_1", ...o }) as never;

  it("règle partagée : un identifiant Stripe seul ne prouve rien ; seuls payé, résiliation programmée et paiement en échec sont vivants", () => {
    expect([...LIVE_SUBSCRIPTION_STATES]).toEqual(["paid", "canceling", "past_due"]);
    expect(isLiveSubscription(row({}), NOW)).toBe(true);
    expect(isLiveSubscription(row({ cancelAtPeriodEnd: true }), NOW)).toBe(true);
    expect(isLiveSubscription(row({ status: "past_due", currentPeriodEnd: new Date(NOW.getTime() - 2 * DAY) }), NOW)).toBe(true);
    for (const over of [{ status: "canceled" }, { status: "expired" }, { status: "incomplete" }, { stripeSubscriptionId: null }, { status: "trialing", trialEndsAt: new Date(NOW.getTime() - DAY) },
      { cancelAtPeriodEnd: true, currentPeriodEnd: new Date(NOW.getTime() - DAY) }]) expect(isLiveSubscription(row(over), NOW), JSON.stringify(over)).toBe(false);
    expect(isLiveSubscription(null, NOW)).toBe(false);
  });

  it("boutons : abonnement actif, résiliation programmée, paiement en échec conservent leurs actions ; terminé n'en a plus et l'explique", () => {
    const m = (state: Parameters<typeof manageActions>[0]["state"], hasStripeSubscription = true, owner = true) => manageActions({ state, owner, hasStripeSubscription });
    expect(m("paid")).toEqual({ portal: true, cancel: "cancel", endTrial: false, note: null });
    expect(m("canceling")).toEqual({ portal: true, cancel: "resume", endTrial: false, note: null });
    expect(m("past_due")).toEqual({ portal: true, cancel: "cancel", endTrial: false, note: null });
    for (const state of ["canceled", "trial_expired"] as const) {
      const r = m(state);
      expect([r.portal, r.cancel, r.endTrial], state).toEqual([false, null, false]);
      expect(r.note, state).toMatch(/abonnement est terminé : aucune action de gestion n'est possible/);
    }
    expect(m("incomplete")).toEqual({ portal: false, cancel: null, endTrial: false, note: null }); // paiement en attente : rien à gérer, pas de bouton trompeur
  });
  it("essai sans Stripe : « Terminer l'essai » conservé ; accès propriétaire gratuit et non-propriétaire : aucune action", () => {
    expect(manageActions({ state: "trial", owner: true, hasStripeSubscription: false })).toEqual({ portal: false, cancel: null, endTrial: true, note: null });
    expect(manageActions({ state: "exempt", owner: true, hasStripeSubscription: false })).toEqual({ portal: false, cancel: null, endTrial: false, note: null });
    for (const state of ["paid", "canceling", "canceled", "trial"] as const) expect(manageActions({ state, owner: false, hasStripeSubscription: state !== "trial" }), state).toEqual({ portal: false, cancel: null, endTrial: false, note: null });
  });
  it("abonnement terminé : le parcours de souscription existant reste proposé pour chaque forfait (aucune impasse)", () => {
    for (const state of ["canceled", "trial_expired"] as const) for (const planId of PLAN_IDS) {
      const kinds = planActions({ planId, currentPlanId: "growth", state, owner: true, hasStripeSubscription: true, checkoutReady: true }).map((a) => a.kind);
      expect(kinds, `${state}/${planId}`).toContain("checkout");
      expect(kinds).not.toContain("change");
    }
  });

  describe("serveur : une demande invalide ne contourne pas la règle (aucun appel à Stripe)", () => {
    const calls: string[] = [];
    beforeEach(() => {
      calls.length = 0; configureStripe();
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => { calls.push(String(input)); return new Response(JSON.stringify({ id: "cus_1", url: "https://stripe.example/x", items: { data: [{ id: "si_1" }] } }), { status: 200 }); });
    });
    const withSub = async (data: Record<string, unknown>) => {
      const w = await makeWorkspace(); state.ws = w.workspaceId; state.role = "owner";
      await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { plan: "growth", stripeCustomerId: `cus_${w.workspaceId}`, stripeSubscriptionId: `sub_${w.workspaceId}`, currentPeriodEnd: new Date(Date.now() + 20 * DAY), status: "active", cancelAtPeriodEnd: false, ...data } });
      return w;
    };
    for (const [label, data] of [["terminé (canceled)", { status: "canceled" }], ["expiré (expired)", { status: "expired" }], ["paiement incomplet", { status: "incomplete" }], ["résiliation arrivée à échéance", { cancelAtPeriodEnd: true, currentPeriodEnd: new Date(Date.now() - DAY) }]] as const) {
      it(`abonnement ${label} : résiliation, reprise, portail et changement de forfait refusés sans appeler Stripe`, async () => {
        const w = await withSub(data as Record<string, unknown>);
        await expect(setCancelAtPeriodEnd(w.workspaceId, true)).rejects.toThrow(/terminé/);
        await expect(setCancelAtPeriodEnd(w.workspaceId, false)).rejects.toThrow(/terminé/);
        await expect(createPortalSession(w.workspaceId)).rejects.toThrow(/Aucun abonnement actif/);
        await expect(changePaidPlan(w.workspaceId, "pro")).rejects.toThrow(/plus actif/);
        for (const r of [await cancelAction({}, fd({ cancel: "1" })), await cancelAction({}, fd({ cancel: "0" })), await portalAction(), await changePlanAction({}, fd({ plan: "pro" }))]) { expect(r.ok).toBeFalsy(); expect(r.error).toBeTruthy(); }
        expect(calls).toEqual([]); // aucune requête vers Stripe
        expect((await sub(w.workspaceId)).cancelAtPeriodEnd).toBe(((data as Record<string, unknown>).cancelAtPeriodEnd as boolean | undefined) ?? false); // rien n'a été modifié localement
      });
    }
    it("abonnement terminé : une nouvelle souscription reste possible par le parcours existant", async () => {
      const w = await withSub({ status: "canceled" });
      await expect(createCheckoutSession({ workspaceId: w.workspaceId, plan: "pro", email: "a@b.c" })).resolves.toBe("https://stripe.example/x");
      expect(calls.some((c) => c.endsWith("/checkout/sessions"))).toBe(true);
    });
    it("abonnement actif : résiliation, reprise et portail fonctionnent ; changements incohérents refusés ; pas de second abonnement par le checkout", async () => {
      const w = await withSub({});
      await expect(setCancelAtPeriodEnd(w.workspaceId, false)).rejects.toThrow(/Aucune résiliation n'est programmée/);
      await setCancelAtPeriodEnd(w.workspaceId, true);
      expect(calls.some((c) => c.includes("/subscriptions/sub_"))).toBe(true);
      expect((await sub(w.workspaceId)).cancelAtPeriodEnd).toBe(true);
      await expect(setCancelAtPeriodEnd(w.workspaceId, true)).rejects.toThrow(/déjà programmée/);
      await setCancelAtPeriodEnd(w.workspaceId, false);
      expect((await sub(w.workspaceId)).cancelAtPeriodEnd).toBe(false);
      await expect(createPortalSession(w.workspaceId)).resolves.toBe("https://stripe.example/x");
      calls.length = 0;
      await expect(createCheckoutSession({ workspaceId: w.workspaceId, plan: "pro", email: "a@b.c" })).rejects.toThrow(/déjà actif/);
      expect((await checkoutAction({}, fd({ plan: "pro" }))).error).toMatch(/déjà actif/);
      expect(calls).toEqual([]);
    });
    it("paiement en échec : portail et résiliation restent possibles (le client doit pouvoir corriger sa carte)", async () => {
      const w = await withSub({ status: "past_due" });
      await expect(createPortalSession(w.workspaceId)).resolves.toBe("https://stripe.example/x");
      await expect(setCancelAtPeriodEnd(w.workspaceId, true)).resolves.toBeUndefined();
    });
    it("essai sans Stripe : « terminer l'essai » conserve son fonctionnement ; accès propriétaire gratuit : portail refusé côté serveur", async () => {
      const w = await makeWorkspace(); state.ws = w.workspaceId; state.role = "owner";
      expect((await cancelAction({}, fd({ cancel: "1" }))).ok).toBe(true);
      expect((await sub(w.workspaceId)).status).toBe("canceled");
      const x = await makeWorkspace(); state.ws = x.workspaceId; process.env.FREE_ACCESS_USER_IDS = x.userId;
      expect((await portalAction()).error).toMatch(/accès propriétaire gratuit/);
      expect(calls).toEqual([]);
    });
    it("autres organisations : les refus d'une organisation dont l'abonnement est terminé n'affectent pas une organisation active", async () => {
      const ended = await withSub({ status: "canceled" });
      const live = await withSub({});
      const before = await sub(live.workspaceId);
      state.ws = ended.workspaceId;
      expect((await cancelAction({}, fd({ cancel: "1" }))).ok).toBeFalsy();
      expect(await sub(live.workspaceId)).toEqual(before);
      state.ws = live.workspaceId;
      expect((await cancelAction({}, fd({ cancel: "1" }))).ok).toBe(true);
      expect((await sub(live.workspaceId)).cancelAtPeriodEnd).toBe(true);
      expect((await sub(ended.workspaceId)).cancelAtPeriodEnd).toBe(false);
    });
  });
});