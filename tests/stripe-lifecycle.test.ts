import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { POST as webhook } from "@/app/api/stripe/webhook/route";
import { createHmac } from "node:crypto";
import { BillingError, createCheckoutSession, handleStripeEvent, reconcileDueSubscriptions, reconcileSubscription, setStripeGateway, type StripeEvent } from "@/lib/billing";
import { EVENT_LEASE_MS } from "@/lib/stripe-events";
import { entitlement, RENEWAL_GRACE_MS } from "@/lib/plans";
import { entitlementForWorkspace } from "@/lib/free-access";
import { fake } from "./stripe-fake";
import { makeWorkspace, resetDb } from "./helpers";

// Cycle de vie Stripe : désordre, rejeux, concurrence, reprise, doubles abonnements, réconciliation. Stripe est simulé en mémoire (tests/stripe-fake.ts) :
// aucun appel réseau, aucun paiement. « Chez Stripe » = l'état détenu par le faux Stripe, indépendant du contenu des événements livrés.

const DAY = 86_400_000;
const inDays = (n: number) => Math.floor((Date.now() + n * DAY) / 1000);
let seq = 0;
const event = (type: string, object: Record<string, unknown>, id = `evt_${++seq}_${Math.random().toString(36).slice(2, 7)}`): StripeEvent => ({ id, type, data: { object } });
const subPayload = (workspaceId: string, over: Record<string, unknown> = {}) => ({ id: "sub_1", customer: "cus_1", status: "active", metadata: { workspaceId, plan: "growth" }, items: { data: [{ price: { id: "price_growth_test" } }] }, current_period_end: inDays(30), ...over });
const sub = (workspaceId: string) => db.subscription.findUniqueOrThrow({ where: { workspaceId } });
const send = (ev: StripeEvent) => handleStripeEvent(ev, fake);
/** Chien de garde : fait échouer clairement une attente qui n'aboutit pas (jamais utilisé comme garantie de chevauchement). */
const bounded = <T>(p: Promise<T>, what: string, ms = 10_000) => new Promise<T>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`délai dépassé : ${what}`)), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});
/** Vrai si toutes les promesses sont réglées (réussies ou rejetées) dans le délai. */
const settledWithin = async (ps: Promise<unknown>[], ms: number) => {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => { t = setTimeout(() => resolve(false), ms); });
  try { return await Promise.race([Promise.allSettled(ps).then(() => true), timeout]); } finally { clearTimeout(t); }
};

async function setup() {
  const w = await makeWorkspace();
  await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { stripeCustomerId: "cus_1" } });
  return w;
}
/** Abonnement payé et synchronisé (Stripe : actif ; base : actif, sub_1). */
async function paid(workspaceId: string) {
  fake.set("sub_1", { status: "active" });
  await send(event("customer.subscription.updated", subPayload(workspaceId)));
  expect(await sub(workspaceId)).toMatchObject({ status: "active", plan: "growth", stripeSubscriptionId: "sub_1" });
}
const configureStripe = () => { process.env.STRIPE_SECRET_KEY = "sk_test_placeholder"; process.env.STRIPE_WEBHOOK_SECRET = "whsec_placeholder"; };

beforeEach(resetDb);
afterEach(() => { delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_WEBHOOK_SECRET; delete process.env.FREE_ACCESS_USER_IDS; vi.restoreAllMocks(); setStripeGateway(null); });

describe("D1 — événements dans le désordre : l'état appliqué est celui de Stripe, jamais celui d'un événement ancien", () => {
  it("1. `deleted` puis un ancien `updated` (actif) : l'abonnement terminé n'est pas rétabli", async () => {
    const { workspaceId } = await setup(); await paid(workspaceId);
    fake.set("sub_1", { status: "canceled" });
    await send(event("customer.subscription.deleted", subPayload(workspaceId, { status: "canceled" })));
    expect(entitlement(await sub(workspaceId)).active).toBe(false);
    // L'ancien événement (actif, émis avant la résiliation) arrive en retard, sous un nouvel identifiant d'événement.
    await send(event("customer.subscription.updated", subPayload(workspaceId, { status: "active" })));
    const s = await sub(workspaceId);
    expect(s.status).toBe("canceled");
    expect(entitlement(s)).toMatchObject({ active: false, state: "canceled" });
  });

  it("2. `invoice.paid` puis un ancien `invoice.payment_failed` : l'abonnement payé n'est pas dégradé", async () => {
    const { workspaceId } = await setup(); await paid(workspaceId);
    await send(event("invoice.paid", { customer: "cus_1", subscription: "sub_1" }));
    await send(event("invoice.payment_failed", { customer: "cus_1", subscription: "sub_1" })); // émis avant le paiement, livré après
    expect((await sub(workspaceId)).status).toBe("active");
    expect(entitlement(await sub(workspaceId)).state).toBe("paid");
  });

  it("10. abonnement terminé suivi d'un ancien `invoice.paid` ou `updated` : aucun droit rétabli", async () => {
    const { workspaceId } = await setup(); await paid(workspaceId);
    fake.set("sub_1", { status: "canceled" });
    await send(event("customer.subscription.updated", subPayload(workspaceId, { status: "canceled" })));
    await send(event("invoice.paid", { customer: "cus_1", subscription: "sub_1" }));
    await send(event("customer.subscription.updated", subPayload(workspaceId, { status: "active", items: { data: [{ price: { id: "price_pro_test" } }] } })));
    expect(await sub(workspaceId)).toMatchObject({ status: "canceled", plan: "growth" }); // ni statut, ni forfait supérieur d'un événement ancien
    expect(entitlement(await sub(workspaceId)).active).toBe(false);
  });

  it("un droit payant n'est jamais accordé sur la seule foi d'un événement : Stripe répond « incomplet » → ni forfait, ni statut payé", async () => {
    const { workspaceId } = await setup();
    fake.set("sub_1", { status: "incomplete" });
    await send(event("customer.subscription.updated", subPayload(workspaceId, { status: "active", items: { data: [{ price: { id: "price_pro_test" } }] } })));
    expect(await sub(workspaceId)).toMatchObject({ plan: "starter", status: "trialing" });
    expect(entitlement(await sub(workspaceId)).state).toBe("trial");
  });

  it("l'événement d'un ancien abonnement terminé ne touche pas l'abonnement courant", async () => {
    const { workspaceId } = await setup(); await paid(workspaceId);
    fake.set("sub_old", { status: "canceled" });
    await send(event("customer.subscription.updated", subPayload(workspaceId, { id: "sub_old", status: "active" })));
    expect(await sub(workspaceId)).toMatchObject({ status: "active", stripeSubscriptionId: "sub_1" });
  });
});

describe("D3 — déduplication atomique et registre des événements", () => {
  it("3. même événement livré deux fois : un seul traitement, la seconde livraison est reconnue comme doublon", async () => {
    const { workspaceId } = await setup(); fake.set("sub_1", { status: "active" });
    const ev = event("customer.subscription.updated", subPayload(workspaceId), "evt_dup");
    expect(await send(ev)).toEqual({ handled: true });
    expect(await send(ev)).toEqual({ handled: false, duplicate: true });
    expect(await db.stripeEvent.findUniqueOrThrow({ where: { id: "evt_dup" } })).toMatchObject({ status: "processed", attempts: 1, outcome: "handled" });
    expect(await db.auditLog.count({ where: { action: "billing.stripe_sync", workspaceId } })).toBe(1);
  });

  it("4. même événement livré SIMULTANÉMENT : un seul exécuteur, l'autre est écarté (409 : Stripe réessaiera)", async () => {
    const { workspaceId } = await setup(); fake.set("sub_1", { status: "active" });
    const ev = event("customer.subscription.updated", subPayload(workspaceId), "evt_race");
    // Chevauchement CONTRÔLÉ, sans latence simulée : l'unique exécuteur qui obtient la réservation est suspendu chez Stripe (après avoir lu l'état) jusqu'à `release()`.
    // Tant qu'il l'est, l'événement est « processing » : les trois autres livraisons ne peuvent être que des doublons « en cours », quelle que soit la vitesse de la base.
    const hold = fake.holdNextRead();
    const losers: Awaited<ReturnType<typeof send>>[] = [];
    let threeLosers!: () => void;
    const threeAnswered = new Promise<void>((resolve) => { threeLosers = resolve; });
    const deliveries = [1, 2, 3, 4].map(() => send(ev).then((r) => { if (r.duplicate) { losers.push(r); if (losers.length === 3) threeLosers(); } return r; })); // quatre livraisons au même instant
    deliveries.forEach((d) => d.catch(() => undefined)); // un rejet est observé dès sa survenue (jamais d'« unhandled rejection ») ; il reste visible via Promise.all ci-dessous
    let drained = true;
    try {
      await bounded(hold.entered, "aucun exécuteur n'a atteint Stripe"); //  exactement un exécuteur a réservé l'événement et attend la réponse de Stripe
      await bounded(threeAnswered, "les trois autres livraisons n'ont pas répondu"); // elles ont répondu alors que l'exécuteur est encore suspendu
      expect(losers).toEqual([{ handled: false, duplicate: true, inProgress: true }, { handled: false, duplicate: true, inProgress: true }, { handled: false, duplicate: true, inProgress: true }]);
      expect(await db.stripeEvent.findUniqueOrThrow({ where: { id: "evt_race" } })).toMatchObject({ status: "processing" }); // pas encore traité : le chevauchement est réel
    } finally {
      hold.release(); //                               libération GARANTIE : même si une assertion échoue ou si `hold.entered` n'aboutit pas, aucune lecture ne reste suspendue
      drained = await settledWithin(deliveries, 10_000); // et aucune livraison encore active ne peut écrire en base pendant le test suivant
    }
    expect(drained, "des livraisons sont restées actives après la libération").toBe(true);
    const results = await Promise.all(deliveries);
    expect(results.filter((r) => r.handled)).toHaveLength(1);
    expect(results.filter((r) => r.duplicate && r.inProgress)).toHaveLength(3);
    expect(await db.stripeEvent.count({ where: { id: "evt_race" } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: "billing.stripe_sync", workspaceId } })).toBe(1);
    expect(fake.calls.filter((c) => c.startsWith("getSubscription"))).toHaveLength(1); // un seul appel à Stripe pour quatre livraisons
  });

  it("route webhook : un événement en cours de traitement ailleurs répond 409 ; un événement traité répond 200 (doublon)", async () => {
    const { workspaceId } = await setup(); fake.set("sub_1", { status: "active" }); setStripeGateway(fake);
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_route";
    const ev = event("customer.subscription.updated", subPayload(workspaceId), "evt_route_409");
    const payload = JSON.stringify(ev);
    const t = Math.floor(Date.now() / 1000), sig = `t=${t},v1=${createHmac("sha256", "whsec_route").update(`${t}.${payload}`).digest("hex")}`;
    const post = () => webhook(new Request("http://x/api/stripe/webhook", { method: "POST", headers: { "stripe-signature": sig }, body: payload }));
    await db.stripeEvent.create({ data: { id: "evt_route_409", type: ev.type, status: "processing", lockedUntil: new Date(Date.now() + EVENT_LEASE_MS) } });
    expect((await post()).status).toBe(409);
    await db.stripeEvent.update({ where: { id: "evt_route_409" }, data: { status: "processed", lockedUntil: null } });
    const r = await post();
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ received: true, handled: false, duplicate: true });
  });

  it("5. écriture impossible dans le registre : la requête échoue AVANT tout effet (Stripe réessaiera)", async () => {
    const { workspaceId } = await setup(); fake.set("sub_1", { status: "active" });
    vi.spyOn(db.stripeEvent, "create").mockRejectedValueOnce(new Error("base indisponible"));
    await expect(send(event("customer.subscription.updated", subPayload(workspaceId), "evt_ledger_down"))).rejects.toThrow(/base indisponible/);
    expect(await sub(workspaceId)).toMatchObject({ status: "trialing", plan: "starter", stripeSubscriptionId: null }); // aucun effet
    expect(fake.calls).toEqual([]);
    // La livraison suivante (rejeu de Stripe) aboutit.
    await send(event("customer.subscription.updated", subPayload(workspaceId), "evt_ledger_down"));
    expect((await sub(workspaceId)).status).toBe("active");
  });

  it("l'échec de l'audit n'affecte ni le traitement ni la déduplication (le registre en est indépendant)", async () => {
    const { workspaceId } = await setup(); fake.set("sub_1", { status: "active" });
    vi.spyOn(db.auditLog, "create").mockRejectedValue(new Error("audit en panne"));
    const ev = event("customer.subscription.updated", subPayload(workspaceId), "evt_audit_down");
    expect(await send(ev)).toEqual({ handled: true });
    expect(await send(ev)).toEqual({ handled: false, duplicate: true });
    expect((await sub(workspaceId)).status).toBe("active");
  });

  it("6. traitement échoué (Stripe indisponible) : événement `failed`, effets absents, puis repris à la livraison suivante", async () => {
    const { workspaceId } = await setup(); fake.set("sub_1", { status: "active" }); fake.unavailable = true;
    const ev = event("customer.subscription.updated", subPayload(workspaceId), "evt_retry");
    await expect(send(ev)).rejects.toThrow(/indisponible/);
    expect(await db.stripeEvent.findUniqueOrThrow({ where: { id: "evt_retry" } })).toMatchObject({ status: "failed", attempts: 1 });
    expect((await sub(workspaceId)).status).toBe("trialing"); // ni droit accordé, ni état modifié
    fake.unavailable = false;
    expect(await send(ev)).toEqual({ handled: true });
    expect(await db.stripeEvent.findUniqueOrThrow({ where: { id: "evt_retry" } })).toMatchObject({ status: "processed", attempts: 2, error: null });
    expect((await sub(workspaceId)).status).toBe("active");
  });

  it("6 bis. interruption pendant le traitement : bail non expiré = doublon en cours ; bail expiré = reprise", async () => {
    const { workspaceId } = await setup(); fake.set("sub_1", { status: "active" });
    const ev = event("customer.subscription.updated", subPayload(workspaceId), "evt_crash");
    await db.stripeEvent.create({ data: { id: "evt_crash", type: ev.type, status: "processing", lockedUntil: new Date(Date.now() + EVENT_LEASE_MS) } }); // serveur interrompu en cours de route
    expect(await send(ev)).toEqual({ handled: false, duplicate: true, inProgress: true });
    expect((await sub(workspaceId)).status).toBe("trialing");
    await db.stripeEvent.update({ where: { id: "evt_crash" }, data: { lockedUntil: new Date(Date.now() - 1000) } }); // le bail expire
    expect(await send(ev)).toEqual({ handled: true });
    expect(await db.stripeEvent.findUniqueOrThrow({ where: { id: "evt_crash" } })).toMatchObject({ status: "processed", attempts: 2 });
    expect((await sub(workspaceId)).status).toBe("active");
  });

  it("un événement sans effet (client inconnu) est enregistré comme traité et ignoré, sans erreur", async () => {
    expect(await send(event("invoice.paid", { customer: "cus_inconnu", subscription: "sub_x" }, "evt_unknown"))).toEqual({ handled: false });
    expect(await db.stripeEvent.findUniqueOrThrow({ where: { id: "evt_unknown" } })).toMatchObject({ status: "processed", outcome: "ignored" });
  });
});

describe("D2 — une seule tentative de souscription à la fois, jamais de double abonnement", () => {
  const checkout = (workspaceId: string, plan = "growth") => createCheckoutSession({ workspaceId, plan, email: "a@b.c" }, fake);

  it("7. deux sessions Checkout simultanées : une seule est créée chez Stripe, l'autre est refusée", async () => {
    const { workspaceId } = await makeWorkspace(); configureStripe(); fake.lagMs = 20;
    const r = await Promise.allSettled([checkout(workspaceId), checkout(workspaceId), checkout(workspaceId)]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    for (const x of r.filter((x) => x.status === "rejected")) expect((x as PromiseRejectedResult).reason).toBeInstanceOf(BillingError);
    expect(fake.sessionsCreated).toBe(1);
    expect(fake.customersCreated).toBe(1);
    const s = await sub(workspaceId);
    expect(s.checkoutSessionId).toBe("cs_fake_1");
    expect(s.checkoutReservedUntil!.getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);
  });

  it("8. deux confirmations Checkout pour un même client : l'abonnement vivant est conservé, le second est signalé (jamais substitué)", async () => {
    const { workspaceId } = await setup();
    fake.set("sub_A", { status: "active" }); fake.set("sub_B", { status: "active" });
    await send(event("checkout.session.completed", { id: "cs_A", mode: "subscription", client_reference_id: workspaceId, customer: "cus_1", subscription: "sub_A" }));
    expect(await sub(workspaceId)).toMatchObject({ stripeSubscriptionId: "sub_A", status: "active" });
    await send(event("checkout.session.completed", { id: "cs_B", mode: "subscription", client_reference_id: workspaceId, customer: "cus_1", subscription: "sub_B" }, "evt_B"));
    expect(await sub(workspaceId)).toMatchObject({ stripeSubscriptionId: "sub_A", status: "active" });
    expect(await db.stripeEvent.findUniqueOrThrow({ where: { id: "evt_B" } })).toMatchObject({ status: "processed", outcome: "needs_review" });
    expect(await db.auditLog.count({ where: { action: "billing.duplicate_subscription", workspaceId } })).toBe(1);
  });

  it("deux confirmations pour des clients différents : aucune substitution du client Stripe", async () => {
    const { workspaceId } = await setup(); await paid(workspaceId);
    fake.set("sub_X", { status: "active", customer: "cus_autre" });
    await send(event("customer.subscription.updated", subPayload(workspaceId, { id: "sub_X", customer: "cus_autre" }), "evt_X"));
    expect(await sub(workspaceId)).toMatchObject({ stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" });
  });

  it("9. session abandonnée puis nouvelle tentative : l'ancienne session est expirée chez Stripe, la nouvelle est créée", async () => {
    const { workspaceId } = await makeWorkspace(); configureStripe();
    expect(await checkout(workspaceId)).toBe("https://checkout.example/cs_fake_1");
    await expect(checkout(workspaceId, "pro")).resolves.toBe("https://checkout.example/cs_fake_2");
    expect(fake.expired).toEqual(["cs_fake_1"]);
    expect((await sub(workspaceId)).checkoutSessionId).toBe("cs_fake_2");
  });

  it("9 bis. `checkout.session.expired` libère la réservation ; une session déjà payée interdit toute nouvelle tentative", async () => {
    const { workspaceId } = await makeWorkspace(); configureStripe();
    await checkout(workspaceId);
    fake.sessions.get("cs_fake_1")!.status = "expired";
    await send(event("checkout.session.expired", { id: "cs_fake_1", client_reference_id: workspaceId }));
    expect(await sub(workspaceId)).toMatchObject({ checkoutSessionId: null, checkoutReservedUntil: null });
    await expect(checkout(workspaceId)).resolves.toBe("https://checkout.example/cs_fake_2");
    fake.sessions.get("cs_fake_2")!.status = "complete"; // payé, confirmation en attente
    await expect(checkout(workspaceId)).rejects.toThrow(/paiement vient d'être effectué/);
    expect(fake.sessionsCreated).toBe(2);
  });

  it("échec de création de session : la réservation est libérée (aucun blocage)", async () => {
    const { workspaceId } = await makeWorkspace(); configureStripe();
    fake.unavailable = true;
    await expect(checkout(workspaceId)).rejects.toThrow(/indisponible/);
    expect(await sub(workspaceId)).toMatchObject({ checkoutReservationId: null, checkoutSessionId: null });
    fake.unavailable = false;
    await expect(checkout(workspaceId)).resolves.toMatch(/checkout\.example/);
  });

  it("abonnement local ancien (événements perdus) mais vivant chez Stripe : aucune seconde session, l'état local est corrigé", async () => {
    const { workspaceId } = await setup(); configureStripe(); await paid(workspaceId);
    await db.subscription.update({ where: { workspaceId }, data: { status: "canceled", canceledAt: new Date() } }); // la base croit l'abonnement terminé
    await expect(checkout(workspaceId, "pro")).rejects.toThrow(/déjà actif chez Stripe/);
    expect(fake.sessionsCreated).toBe(0);
    expect((await sub(workspaceId)).status).toBe("active");
  });

  it("13 bis. Stripe indisponible lors de la vérification : aucune session n'est créée (jamais de souscription à l'aveugle)", async () => {
    const { workspaceId } = await setup(); configureStripe(); await paid(workspaceId);
    await db.subscription.update({ where: { workspaceId }, data: { status: "canceled", canceledAt: new Date() } });
    fake.unavailable = true;
    await expect(checkout(workspaceId, "pro")).rejects.toThrow(/Vérification de votre abonnement impossible/);
    expect(fake.sessionsCreated).toBe(0);
  });

  it("un abonnement vivant refuse toute nouvelle session sans appel à Stripe", async () => {
    const { workspaceId } = await setup(); configureStripe(); await paid(workspaceId); fake.calls.length = 0;
    await expect(checkout(workspaceId, "pro")).rejects.toThrow(/déjà actif/);
    expect(fake.calls).toEqual([]);
  });
});

describe("D4 — expiration locale et réconciliation avec Stripe", () => {
  const base = (over: Record<string, unknown> = {}) => ({ plan: "growth", status: "active", trialEndsAt: null, currentPeriodEnd: new Date(Date.now() + 10 * DAY), cancelAtPeriodEnd: false, ...over }) as Parameters<typeof entitlement>[0];

  it("11. période payée respectée malgré une résiliation programmée, jusqu'à son terme exact", () => {
    const end = new Date("2026-11-30T12:00:00Z");
    const s = base({ cancelAtPeriodEnd: true, currentPeriodEnd: end });
    expect(entitlement(s, new Date(end.getTime() - 1000))).toMatchObject({ active: true, state: "canceling" });
    expect(entitlement(s, new Date(end.getTime() + 1000))).toMatchObject({ active: false, state: "canceled" });
  });

  it("un abonnement actif non confirmé n'est jamais illimité : période payée respectée, puis délai de renouvellement, puis accès fermé", () => {
    const end = new Date("2026-11-30T12:00:00Z");
    const s = base({ currentPeriodEnd: end });
    expect(entitlement(s, new Date(end.getTime() - DAY))).toMatchObject({ active: true, state: "paid" });
    expect(entitlement(s, new Date(end.getTime() + RENEWAL_GRACE_MS - 1000))).toMatchObject({ active: true, state: "paid" }); // renouvellement en cours de confirmation
    expect(entitlement(s, new Date(end.getTime() + RENEWAL_GRACE_MS))).toMatchObject({ active: false, state: "canceled" });
    expect(entitlement(base({ currentPeriodEnd: null }), new Date()).active).toBe(true); // sans date connue : pas de coupure arbitraire (la réconciliation tranche)
  });

  it("l'expiration d'un essai et celle d'une période payée sont distinctes", () => {
    const now = new Date();
    expect(entitlement(base({ status: "trialing", trialEndsAt: new Date(now.getTime() - 1000), currentPeriodEnd: null }), now).state).toBe("trial_expired");
    expect(entitlement(base({ currentPeriodEnd: new Date(now.getTime() - 10 * DAY) }), now).state).toBe("canceled");
    expect(entitlement(base({ status: "past_due", currentPeriodEnd: new Date(now.getTime() - 2 * DAY) }), now)).toMatchObject({ active: true, state: "past_due" }); // grâce d'impayé inchangée (7 jours)
  });

  it("12. événement de résiliation perdu : la base garde « actif », la réconciliation lit Stripe et ferme l'abonnement", async () => {
    const { workspaceId } = await setup(); await paid(workspaceId);
    await db.subscription.update({ where: { workspaceId }, data: { currentPeriodEnd: new Date(Date.now() - 5 * DAY), stripeSyncedAt: new Date(Date.now() - 6 * DAY) } });
    expect(entitlement(await sub(workspaceId)).active).toBe(false); // plus d'accès illimité sur un statut local périmé
    fake.set("sub_1", { status: "canceled" });
    expect(await reconcileDueSubscriptions({}, fake)).toMatchObject({ checked: 1, updated: 1, failed: 0 });
    expect(await sub(workspaceId)).toMatchObject({ status: "canceled" });
  });

  it("12 bis. renouvellement dont l'événement a été perdu : la réconciliation rétablit l'accès payé (période mise à jour)", async () => {
    const { workspaceId } = await setup(); await paid(workspaceId);
    await db.subscription.update({ where: { workspaceId }, data: { currentPeriodEnd: new Date(Date.now() - 5 * DAY), stripeSyncedAt: new Date(Date.now() - 6 * DAY) } });
    fake.set("sub_1", { status: "active", current_period_end: inDays(25) });
    expect((await reconcileSubscription(workspaceId, fake))?.outcome).toBe("handled");
    const s = await sub(workspaceId);
    expect(entitlement(s)).toMatchObject({ active: true, state: "paid" });
    expect(s.currentPeriodEnd!.getTime()).toBeGreaterThan(Date.now() + 20 * DAY);
  });

  it("13. Stripe indisponible : la réconciliation échoue proprement, aucun droit n'est retiré ni accordé", async () => {
    const { workspaceId } = await setup(); await paid(workspaceId);
    await db.subscription.update({ where: { workspaceId }, data: { stripeSyncedAt: new Date(Date.now() - 2 * DAY) } });
    const before = await sub(workspaceId);
    fake.unavailable = true;
    expect(await reconcileDueSubscriptions({}, fake)).toMatchObject({ checked: 1, updated: 0, failed: 1 });
    await expect(reconcileSubscription(workspaceId, fake)).rejects.toThrow(/indisponible/);
    const after = await sub(workspaceId);
    expect([after.status, after.plan, after.currentPeriodEnd, after.stripeSyncedAt]).toEqual([before.status, before.plan, before.currentPeriodEnd, before.stripeSyncedAt]);
    expect(entitlement(after).active).toBe(true); // période payée encore en cours : droit conservé
  });

  it("un abonnement introuvable chez Stripe est un abonnement terminé", async () => {
    const { workspaceId } = await setup(); await paid(workspaceId);
    fake.subs.delete("sub_1");
    expect((await reconcileSubscription(workspaceId, fake))?.outcome).toBe("handled");
    expect((await sub(workspaceId)).status).toBe("canceled");
  });

  it("la réconciliation ignore les essais, les espaces sans abonnement Stripe et les abonnements récemment synchronisés", async () => {
    const trial = await makeWorkspace();
    const recent = await setup(); await paid(recent.workspaceId);
    expect(await reconcileSubscription(trial.workspaceId, fake)).toBeNull();
    expect(await reconcileDueSubscriptions({}, fake)).toMatchObject({ checked: 0, updated: 0, failed: 0 });
  });

  it("14. accès propriétaire gratuit : inchangé, quel que soit l'état (périmé, terminé) de l'abonnement local", async () => {
    const { workspaceId, userId } = await setup();
    process.env.FREE_ACCESS_USER_IDS = userId;
    await db.subscription.update({ where: { workspaceId }, data: { plan: "starter", status: "active", currentPeriodEnd: new Date(Date.now() - 30 * DAY), stripeSubscriptionId: "sub_1" } });
    expect(await entitlementForWorkspace(workspaceId, await sub(workspaceId))).toMatchObject({ active: true, state: "exempt" });
    await db.subscription.update({ where: { workspaceId }, data: { status: "canceled" } });
    const e = await entitlementForWorkspace(workspaceId, await sub(workspaceId));
    expect(e).toMatchObject({ active: true, state: "exempt" });
    expect(e.plan.id).toBe("pro");
    delete process.env.FREE_ACCESS_USER_IDS;
    expect((await entitlementForWorkspace(workspaceId, await sub(workspaceId))).active).toBe(false); // sans exemption : suspendu
  });
});
