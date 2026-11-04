import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { BillingError, UNKNOWN_PRICE_ACTION, UNKNOWN_PRICE_RESOLVED_ACTION, billingNeedsReview, createCheckoutSession, handleStripeEvent, reconcileDueSubscriptions, reconcileSubscription, setStripeGateway, type StripeEvent } from "@/lib/billing";
import { entitlement } from "@/lib/plans";
import { fake } from "./stripe-fake";
import { makeWorkspace, resetDb } from "./helpers";

// 2T — visibilité durable des revues ouvertes (openPriceReviews), clôture selon le statut, refus d'un nouveau checkout, classification des échecs du cron.
// Stripe est simulé en mémoire : aucun appel réseau, aucun paiement.

const DAY = 86_400_000;
const inDays = (n: number) => Math.floor((Date.now() + n * DAY) / 1000);
let seq = 0;
const event = (type: string, object: Record<string, unknown>): StripeEvent => ({ id: `evt_vis_${++seq}_${Math.random().toString(36).slice(2, 7)}`, type, data: { object } });
const payload = (workspaceId: string, over: Record<string, unknown> = {}) => ({ id: "sub_1", customer: "cus_1", status: "active", metadata: { workspaceId }, items: { data: [{ price: { id: "price_growth_test" } }] }, current_period_end: inDays(30), ...over });
const unknown = { items: { data: [{ price: { id: "price_old_growth" } }] } };
const sub = (w: string) => db.subscription.findUniqueOrThrow({ where: { workspaceId: w } });
const audits = (w: string, action: string) => db.auditLog.count({ where: { workspaceId: w, action } });
async function setup(customer: string) {
  const w = await makeWorkspace();
  await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { stripeCustomerId: customer } });
  return w;
}
const send = async (workspaceId: string, remote: Parameters<typeof fake.set>[1], id: string, customer: string) => {
  fake.set(id, { customer, ...remote });
  const ev = event("customer.subscription.updated", payload(workspaceId, { id, customer }));
  await handleStripeEvent(ev, fake);
  return ev;
};
const paidGrowth = async (workspaceId: string, id: string, customer: string) => { await send(workspaceId, { status: "active" }, id, customer); expect(await sub(workspaceId)).toMatchObject({ status: "active", plan: "growth", stripeSubscriptionId: id }); };
const ageRead = (workspaceId: string) => db.subscription.update({ where: { workspaceId }, data: { stripeSyncedAt: new Date(Date.now() - 2 * DAY) } });
const stale = (id: string) => db.stripeEvent.update({ where: { id }, data: { processedAt: new Date(Date.now() - 10 * 60_000) } });
const later = (days: number) => new Date(Date.now() + days * DAY);
const configureStripe = () => { process.env.STRIPE_SECRET_KEY = "sk_test_placeholder"; process.env.STRIPE_WEBHOOK_SECRET = "whsec_placeholder"; };

function failAuditInTransaction() {
  const real = db.$transaction.bind(db) as unknown as (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
  return vi.spyOn(db, "$transaction").mockImplementation(((fn: (tx: unknown) => Promise<unknown>) =>
    real((tx) => fn(new Proxy(tx as object, { get: (t, k, r) => (k === "auditLog" ? { create: async () => { throw new Error("audit indisponible"); } } : Reflect.get(t, k, r)) })))) as never);
}

beforeEach(resetDb);
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); setStripeGateway(null); delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_WEBHOOK_SECRET; });

describe("A1 — openPriceReviews : état durable, liés et non liés, un espace compté une fois", () => {
  it("plusieurs espaces non liés + un espace lié : comptage unique, le lié reste compté entre deux relectures, une résolution ne ferme que son espace", async () => {
    const A = await setup("cus_A"), B = await setup("cus_B"), C = await setup("cus_C"), D = await setup("cus_D");
    const evA = await send(A.workspaceId, { status: "active", ...unknown }, "sub_A", "cus_A");
    await send(A.workspaceId, { status: "active", ...unknown }, "sub_A", "cus_A"); //                      2e détection du même espace (autre événement)
    await send(A.workspaceId, { status: "active", ...unknown }, "sub_A", "cus_A"); //                      3e : toujours un seul épisode
    const evB = await send(B.workspaceId, { status: "active", ...unknown }, "sub_B", "cus_B");
    const evC = await send(C.workspaceId, { status: "active", ...unknown }, "sub_C", "cus_C");
    await paidGrowth(D.workspaceId, "sub_D", "cus_D"); //                                                  D : lié, payé, puis prix inconnu relu par le cron
    fake.set("sub_D", { status: "active", customer: "cus_D", ...unknown });
    await ageRead(D.workspaceId);
    for (const w of [A, B, C]) expect((await sub(w.workspaceId)).stripeSubscriptionId).toBeNull(); //      aucun rattachement automatique
    expect(await audits(A.workspaceId, UNKNOWN_PRICE_ACTION)).toBe(1);

    const p1 = await reconcileDueSubscriptions({ itemReserveMs: 0 }, fake);
    expect(p1).toMatchObject({ checked: 1, unknownPrice: 1, openPriceReviews: 4, unlinkedPriceReviews: 3, complete: false }); // détections du passage (1) ≠ revues ouvertes (4) ⊃ non liées (3)
    // Passage suivant, D n'est pas relu (lecture récente) : `unknownPrice` retombe à 0 mais la revue reste ouverte et `complete` reste faux.
    const p2 = await reconcileDueSubscriptions({ itemReserveMs: 0 }, fake);
    expect(p2).toMatchObject({ checked: 0, unknownPrice: 0, openPriceReviews: 4, unlinkedPriceReviews: 3, complete: false });
    for (const w of [A, B, C, D]) expect(await billingNeedsReview(w.workspaceId), "indicateur de l'espace").toBe(true); // même source que le compteur

    // Résolution de A seulement (configuration corrigée, renvoi de SON événement) : B, C et D restent ouverts.
    vi.stubEnv("STRIPE_PRICE_GROWTH_LEGACY", "price_old_growth");
    await stale(evA.id);
    expect(await handleStripeEvent(evA, fake)).toMatchObject({ handled: true });
    expect(await audits(A.workspaceId, UNKNOWN_PRICE_RESOLVED_ACTION)).toBe(1);
    for (const w of [B, C, D]) expect(await audits(w.workspaceId, UNKNOWN_PRICE_RESOLVED_ACTION)).toBe(0);
    expect(await billingNeedsReview(A.workspaceId)).toBe(false);
    for (const w of [B, C, D]) expect(await billingNeedsReview(w.workspaceId)).toBe(true);
    const p3 = await reconcileDueSubscriptions({ itemReserveMs: 0 }, fake); // lectures récentes : rien n'est relu
    expect(p3).toMatchObject({ checked: 0, openPriceReviews: 3, unlinkedPriceReviews: 2, complete: false }); // A (désormais lié, résolu) sort des deux comptes ; D reste ouvert tant qu'il n'est pas relu
    // D relu après la correction : clos par sa propre synchronisation (prix désormais reconnu).
    const p4 = await reconcileDueSubscriptions({ now: later(2), itemReserveMs: 0 }, fake);
    expect(p4).toMatchObject({ unknownPrice: 0, openPriceReviews: 2, unlinkedPriceReviews: 2, complete: false });
    expect(await billingNeedsReview(D.workspaceId)).toBe(false);
    // B puis C résolus à leur tour : plus aucune revue ouverte, le passage est enfin complet.
    for (const ev of [evB, evC]) { await stale(ev.id); expect(await handleStripeEvent(ev, fake)).toMatchObject({ handled: true }); }
    const done = await reconcileDueSubscriptions({ now: later(4), itemReserveMs: 0 }, fake);
    expect(done).toMatchObject({ openPriceReviews: 0, unlinkedPriceReviews: 0, unknownPrice: 0, complete: true });
  });

  it("une revue rouverte après clôture est de nouveau comptée une seule fois", async () => {
    const A = await setup("cus_A");
    const ev = await send(A.workspaceId, { status: "active", ...unknown }, "sub_A", "cus_A");
    vi.stubEnv("STRIPE_PRICE_GROWTH_LEGACY", "price_old_growth");
    await stale(ev.id); await handleStripeEvent(ev, fake);
    expect((await reconcileDueSubscriptions({ now: later(2), itemReserveMs: 0 }, fake)).openPriceReviews).toBe(0);
    vi.stubEnv("STRIPE_PRICE_GROWTH_LEGACY", "");
    fake.set("sub_A", { status: "active", customer: "cus_A", ...unknown });
    await reconcileSubscription(A.workspaceId, fake);
    expect(await audits(A.workspaceId, UNKNOWN_PRICE_ACTION)).toBe(2);
    expect(await reconcileDueSubscriptions({ now: later(4), itemReserveMs: 0 }, fake)).toMatchObject({ openPriceReviews: 1, unlinkedPriceReviews: 0, unknownPrice: 1, complete: false }); // lié, relu
  });

  it("stripeSyncedAt n'est jamais une preuve de résolution : relectures répétées, revue toujours comptée", async () => {
    const D = await setup("cus_D");
    await paidGrowth(D.workspaceId, "sub_D", "cus_D");
    fake.set("sub_D", { status: "active", customer: "cus_D", ...unknown });
    for (let i = 0; i < 3; i++) { await ageRead(D.workspaceId); await reconcileDueSubscriptions({ itemReserveMs: 0 }, fake); }
    expect((await sub(D.workspaceId)).stripeSyncedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000); // la lecture est bien enregistrée…
    expect(await reconcileDueSubscriptions({ itemReserveMs: 0 }, fake)).toMatchObject({ openPriceReviews: 1, complete: false }); // …sans fermer la revue
    expect(await audits(D.workspaceId, UNKNOWN_PRICE_RESOLVED_ACTION)).toBe(0);
  });
});

describe("B — clôture selon le statut : revue close, statut réel et droits inchangés", () => {
  const CASES = [
    { status: "past_due", closedStatus: "past_due", active: true, whileUnknownStatus: "active" },
    { status: "incomplete", closedStatus: "incomplete", active: false, whileUnknownStatus: "incomplete" },
    { status: "paused", closedStatus: "unpaid", active: false, whileUnknownStatus: "unpaid" },
  ];
  for (const c of CASES) {
    it(`${c.status} : revue maintenue tant que le prix est inconnu, close dès qu'il est reconnu ; statut réel conservé, aucun droit accordé`, async () => {
      const { workspaceId } = await setup("cus_1");
      await paidGrowth(workspaceId, "sub_1", "cus_1");
      fake.set("sub_1", { status: "active", ...unknown });
      await reconcileSubscription(workspaceId, fake); //                                  ouverture de la revue (prix inconnu)
      expect(await billingNeedsReview(workspaceId)).toBe(true);
      // 1) Prix toujours inconnu, statut X : la revue reste ouverte.
      fake.set("sub_1", { status: c.status, ...unknown });
      await reconcileSubscription(workspaceId, fake);
      expect(await audits(workspaceId, UNKNOWN_PRICE_RESOLVED_ACTION)).toBe(0);
      expect(await billingNeedsReview(workspaceId)).toBe(true);
      expect(await sub(workspaceId)).toMatchObject({ status: c.whileUnknownStatus, plan: "growth" });
      // 2) Prix reconnu (configuration corrigée), même statut X : revue close, statut réel conservé.
      vi.stubEnv("STRIPE_PRICE_GROWTH_LEGACY", "price_old_growth");
      fake.set("sub_1", { status: c.status, ...unknown });
      await reconcileSubscription(workspaceId, fake);
      const s = await sub(workspaceId);
      expect(await audits(workspaceId, UNKNOWN_PRICE_RESOLVED_ACTION)).toBe(1);
      expect(await billingNeedsReview(workspaceId)).toBe(false);
      expect(s).toMatchObject({ status: c.closedStatus, plan: "growth" });
      // Les droits suivent les règles d'accès existantes pour ce statut : la clôture n'accorde rien de plus.
      const e = entitlement(s);
      expect(e.active).toBe(c.active);
      if (!c.active) expect(["paid", "trial", "canceling"]).not.toContain(e.state);
      else expect(e.state).toBe("past_due"); // grâce de paiement, pas un abonnement « payé » réactivé
    });
  }
});

describe("C — un abonnement à prix inconnu n'ouvre pas la voie à un second checkout", () => {
  const checkout = (workspaceId: string, plan = "growth") => createCheckoutSession({ workspaceId, plan, email: "a@b.c" }, fake);

  it("abonnement lié, payé localement, prix devenu inconnu : refus (« déjà actif »), aucune session créée", async () => {
    configureStripe();
    const { workspaceId } = await setup("cus_1");
    await paidGrowth(workspaceId, "sub_1", "cus_1");
    fake.set("sub_1", { status: "active", ...unknown });
    await reconcileSubscription(workspaceId, fake);
    await expect(checkout(workspaceId, "pro")).rejects.toThrow(/déjà actif/);
    expect(fake.sessionsCreated).toBe(0);
    expect(await sub(workspaceId)).toMatchObject({ status: "active", plan: "growth", stripeSubscriptionId: "sub_1" });
  });

  it("abonnement NON lié localement (essai) mais actif chez Stripe avec un prix inconnu : refus par la vérification Stripe, revue ouverte, aucun rattachement, réservation libérée", async () => {
    configureStripe();
    const { workspaceId } = await setup("cus_1");
    const before = await sub(workspaceId);
    fake.set("sub_x", { status: "active", customer: "cus_1", ...unknown });
    await expect(checkout(workspaceId)).rejects.toThrow(/déjà actif chez Stripe/);
    expect(fake.sessionsCreated).toBe(0);
    const after = await sub(workspaceId);
    expect(after.stripeSubscriptionId).toBeNull();
    expect([after.status, after.plan, after.currentPeriodEnd]).toEqual([before.status, before.plan, before.currentPeriodEnd]);
    expect([after.checkoutReservationId, after.checkoutReservedUntil, after.checkoutSessionId]).toEqual([null, null, null]);
    expect(await billingNeedsReview(workspaceId)).toBe(true); // la réparation d'état lancée par la vérification a tracé la revue
    expect(await audits(workspaceId, UNKNOWN_PRICE_ACTION)).toBe(1);
    await expect(checkout(workspaceId)).rejects.toBeInstanceOf(BillingError); // et le second essai reste refusé
    expect(fake.sessionsCreated).toBe(0);
  });
});

describe("A7 — classification des échecs du cron", () => {
  async function linkedWithUnknownPrice(n: number) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const w = await setup(`cus_L${i}`);
      await paidGrowth(w.workspaceId, `sub_L${i}`, `cus_L${i}`);
      fake.set(`sub_L${i}`, { status: "active", customer: `cus_L${i}`, ...unknown });
      await ageRead(w.workspaceId);
      ids.push(w.workspaceId);
    }
    return ids;
  }

  it("échec d'écriture de la revue (base) sur quatre abonnements : le passage les examine TOUS, aucun « stripe_unavailable », aucun état modifié, repris au passage suivant", async () => {
    const ids = await linkedWithUnknownPrice(4);
    const reads = await Promise.all(ids.map(async (w) => (await sub(w)).stripeSyncedAt!.getTime()));
    const spy = failAuditInTransaction();
    const bad = await reconcileDueSubscriptions({ itemReserveMs: 0 }, fake);
    spy.mockRestore();
    expect(bad).toMatchObject({ checked: 4, failed: 4, deferred: 0, stoppedBy: null, complete: false });
    expect(await Promise.all(ids.map(async (w) => (await sub(w)).stripeSyncedAt!.getTime()))).toEqual(reads); // aucune lecture enregistrée
    for (const w of ids) expect(await audits(w, UNKNOWN_PRICE_ACTION)).toBe(0);
    const good = await reconcileDueSubscriptions({ itemReserveMs: 0 }, fake);
    expect(good).toMatchObject({ checked: 4, failed: 0, unknownPrice: 4, openPriceReviews: 4, stoppedBy: null, complete: false });
  });

  it("témoin : Stripe indisponible sur quatre abonnements : le disjoncteur s'arrête après trois échecs avec « stripe_unavailable » (comportement inchangé)", async () => {
    await linkedWithUnknownPrice(4);
    fake.unavailable = true;
    const r = await reconcileDueSubscriptions({ itemReserveMs: 0 }, fake);
    fake.unavailable = false;
    expect(r).toMatchObject({ checked: 3, failed: 3, deferred: 1, stoppedBy: "stripe_unavailable", complete: false });
  });
});
