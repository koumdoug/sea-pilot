import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { UNKNOWN_PRICE_ACTION, UNKNOWN_PRICE_RESOLVED_ACTION, billingNeedsReview, handleStripeEvent, reconcileDueSubscriptions, reconcileSubscription, setStripeGateway, type StripeEvent } from "@/lib/billing";
import { UNKNOWN_PRICE_RETRY_MS } from "@/lib/stripe-events";
import { entitlement } from "@/lib/plans";
import { fake } from "./stripe-fake";
import { makeWorkspace, resetDb } from "./helpers";

// 2R — C1 à C6 : durabilité de la détection, abonnements non liés dans le cron, encadrement des renvois, clôture de la revue, checkout, déterminisme.
// Stripe est simulé en mémoire : aucun appel réseau, aucun paiement.

const DAY = 86_400_000;
const inDays = (n: number) => Math.floor((Date.now() + n * DAY) / 1000);
let seq = 0;
const event = (type: string, object: Record<string, unknown>): StripeEvent => ({ id: `evt_dur_${++seq}_${Math.random().toString(36).slice(2, 7)}`, type, data: { object } });
const payload = (workspaceId: string, over: Record<string, unknown> = {}) => ({ id: "sub_1", customer: "cus_1", status: "active", metadata: { workspaceId }, items: { data: [{ price: { id: "price_growth_test" } }] }, current_period_end: inDays(30), ...over });
const unknown = { items: { data: [{ price: { id: "price_old_growth" } }] } };
const sub = (w: string) => db.subscription.findUniqueOrThrow({ where: { workspaceId: w } });
const audits = (w: string, action: string) => db.auditLog.count({ where: { workspaceId: w, action } });
const ledger = (id: string) => db.stripeEvent.findUniqueOrThrow({ where: { id } });
async function setup(customer = "cus_1") {
  const w = await makeWorkspace();
  await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { stripeCustomerId: customer } });
  return w;
}
const send = (workspaceId: string, remote: Parameters<typeof fake.set>[1], id = "sub_1", customer = "cus_1") => {
  fake.set(id, { customer, ...remote });
  const ev = event("customer.subscription.updated", payload(workspaceId, { id, customer }));
  return handleStripeEvent(ev, fake).then(() => ev);
};
async function paidGrowth(workspaceId: string, id = "sub_1", customer = "cus_1") { await send(workspaceId, { status: "active" }, id, customer); expect(await sub(workspaceId)).toMatchObject({ status: "active", plan: "growth", stripeSubscriptionId: id }); }
/** Rend l'événement « ancien » : la fenêtre minimale de reprise est écoulée (ou non, selon `ms`). */
const processedAgo = (id: string, ms: number) => db.stripeEvent.update({ where: { id }, data: { processedAt: new Date(Date.now() - ms) } });
const STALE = UNKNOWN_PRICE_RETRY_MS + 60_000;
const readsSince = (n: number) => fake.calls.length - n;

/** Fait échouer l'écriture d'audit À L'INTÉRIEUR de la transaction (le reste de la transaction s'exécute réellement : on vérifie le retour en arrière). */
function failAuditInTransaction() {
  const real = db.$transaction.bind(db) as unknown as (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
  return vi.spyOn(db, "$transaction").mockImplementation(((fn: (tx: unknown) => Promise<unknown>) =>
    real((tx) => fn(new Proxy(tx as object, { get: (t, k, r) => (k === "auditLog" ? { create: async () => { throw new Error("audit indisponible"); } } : Reflect.get(t, k, r)) })))) as never);
}

beforeEach(resetDb);
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); setStripeGateway(null); });

describe("C1 — la détection d'un prix inconnu est persistée de façon durable", () => {
  it("échec d'écriture de l'audit (webhook) : rien n'est enregistré, l'erreur remonte, Stripe réessaie, le réessai trace UNE fois", async () => {
    const { workspaceId } = await setup();
    await paidGrowth(workspaceId);
    const oldRead = new Date("2026-01-01T00:00:00Z");
    await db.subscription.update({ where: { workspaceId }, data: { stripeSyncedAt: oldRead } });
    fake.set("sub_1", { status: "active", ...unknown });
    const ev = event("customer.subscription.updated", payload(workspaceId));
    const spy = failAuditInTransaction();
    await expect(handleStripeEvent(ev, fake)).rejects.toThrow(/audit indisponible/); //  l'incident n'est pas masqué : l'erreur remonte (HTTP 500, Stripe réessaie)
    spy.mockRestore();
    expect(await ledger(ev.id)).toMatchObject({ status: "failed" });
    expect((await ledger(ev.id)).error).toMatch(/audit indisponible/);
    expect((await sub(workspaceId)).stripeSyncedAt!.getTime()).toBe(oldRead.getTime()); // transaction entièrement annulée : la lecture n'est pas enregistrée…
    expect(await audits(workspaceId, UNKNOWN_PRICE_ACTION)).toBe(0); //                  …et aucune trace partielle
    // Réessai de Stripe (même événement, état « failed » : jamais soumis à la fenêtre) : détection tracée, une seule fois.
    expect(await handleStripeEvent(ev, fake)).toMatchObject({ handled: true });
    expect(await ledger(ev.id)).toMatchObject({ status: "processed", outcome: "needs_review", attempts: 2 });
    expect((await sub(workspaceId)).stripeSyncedAt!.getTime()).toBeGreaterThan(oldRead.getTime());
    expect(await audits(workspaceId, UNKNOWN_PRICE_ACTION)).toBe(1);
    expect(await billingNeedsReview(workspaceId)).toBe(true);
    await processedAgo(ev.id, STALE);
    await handleStripeEvent(ev, fake);
    expect(await audits(workspaceId, UNKNOWN_PRICE_ACTION)).toBe(1); // pas de double audit
  });

  it("échec d'écriture de l'audit (cron) : compté comme échec, l'abonnement reste candidat (lecture non enregistrée), le passage suivant trace", async () => {
    const { workspaceId } = await setup();
    await paidGrowth(workspaceId);
    const oldRead = new Date(Date.now() - 2 * DAY);
    await db.subscription.update({ where: { workspaceId }, data: { stripeSyncedAt: oldRead } });
    fake.set("sub_1", { status: "active", ...unknown });
    const spy = failAuditInTransaction();
    const bad = await reconcileDueSubscriptions({ itemReserveMs: 0 }, fake);
    spy.mockRestore();
    expect(bad).toMatchObject({ checked: 1, failed: 1, unknownPrice: 0, complete: false });
    expect((await sub(workspaceId)).stripeSyncedAt!.getTime()).toBe(oldRead.getTime());
    expect(await audits(workspaceId, UNKNOWN_PRICE_ACTION)).toBe(0);
    const good = await reconcileDueSubscriptions({ itemReserveMs: 0 }, fake);
    expect(good).toMatchObject({ checked: 1, failed: 0, unknownPrice: 1, complete: false });
    expect(await audits(workspaceId, UNKNOWN_PRICE_ACTION)).toBe(1);
    expect(await billingNeedsReview(workspaceId)).toBe(true);
  });

  it("la trace persistée ne contient ni clé, ni secret, ni donnée personnelle", async () => {
    const { workspaceId } = await setup();
    await send(workspaceId, { status: "active", ...unknown });
    const a = await db.auditLog.findFirstOrThrow({ where: { workspaceId, action: UNKNOWN_PRICE_ACTION } });
    expect(Object.keys(a.meta as object).sort()).toEqual(["price", "source", "status", "subscriptionId"]);
    expect(a).toMatchObject({ entity: "Subscription" });
  });
});

describe("C2 — abonnements non liés dans le résumé du cron", () => {
  it("un épisode = un espace : compté une fois malgré plusieurs détections ; distinct de `unknownPrice` ; disparaît à la résolution", async () => {
    const a = await setup("cus_A"), b = await setup("cus_B");
    // B : abonnement lié (payé puis prix inconnu, lecture ancienne : candidat du cron). A : jamais lié.
    await paidGrowth(b.workspaceId, "sub_B", "cus_B");
    await db.subscription.update({ where: { workspaceId: b.workspaceId }, data: { stripeSyncedAt: new Date(Date.now() - 2 * DAY) } });
    fake.set("sub_B", { status: "active", customer: "cus_B", ...unknown });
    const evA = await send(a.workspaceId, { status: "active", ...unknown }, "sub_A", "cus_A");
    await send(a.workspaceId, { status: "active", ...unknown }, "sub_A", "cus_A"); //                            2e détection (autre événement) : même épisode
    expect(await audits(a.workspaceId, UNKNOWN_PRICE_ACTION)).toBe(1);
    expect((await sub(a.workspaceId)).stripeSubscriptionId).toBeNull(); //                                     aucun rattachement automatique
    const first = await reconcileDueSubscriptions({ itemReserveMs: 0 }, fake);
    expect(first).toMatchObject({ checked: 1, unknownPrice: 1, unlinkedPriceReviews: 1, complete: false }); //  B (lié) vu par la boucle ; A (non lié) compté à part
    const second = await reconcileDueSubscriptions({ now: new Date(Date.now() + 2 * DAY), itemReserveMs: 0 }, fake);
    expect(second).toMatchObject({ unlinkedPriceReviews: 1, complete: false }); //                              toujours ouvert : l'écriture de stripeSyncedAt ne le résout pas
    expect(await billingNeedsReview(a.workspaceId)).toBe(true); //                                             visible aussi côté espace
    // Résolution de A : configuration corrigée, renvoi de l'événement après la fenêtre.
    vi.stubEnv("STRIPE_PRICE_GROWTH_LEGACY", "price_old_growth");
    await processedAgo(evA.id, STALE);
    expect(await handleStripeEvent(evA, fake)).toMatchObject({ handled: true });
    expect((await sub(a.workspaceId)).stripeSubscriptionId).toBe("sub_A");
    expect(await billingNeedsReview(a.workspaceId)).toBe(false);
    const done = await reconcileDueSubscriptions({ now: new Date(Date.now() + 4 * DAY), itemReserveMs: 0 }, fake);
    expect(done.unlinkedPriceReviews).toBe(0);
    expect(done).toMatchObject({ unknownPrice: 0, complete: true });
  });

  it("un abonnement lié n'est jamais compté parmi les « non liés » ; sans revue, le compteur est nul", async () => {
    const { workspaceId } = await setup();
    await paidGrowth(workspaceId);
    expect(await reconcileDueSubscriptions({ itemReserveMs: 0 }, fake)).toMatchObject({ unlinkedPriceReviews: 0, complete: true });
    fake.set("sub_1", { status: "active", ...unknown });
    await reconcileSubscription(workspaceId, fake);
    expect(await billingNeedsReview(workspaceId)).toBe(true);
    expect((await reconcileDueSubscriptions({ now: new Date(Date.now() + 2 * DAY), itemReserveMs: 0 }, fake)).unlinkedPriceReviews).toBe(0);
  });
});

describe("C3 — renvois encadrés : au plus un traitement par fenêtre", () => {
  it("renvoi trop rapide : doublon, aucune lecture Stripe, aucune écriture ; renvoi tardif : repris puis de nouveau protégé", async () => {
    const { workspaceId } = await setup();
    const ev = await send(workspaceId, { status: "active", ...unknown });
    const reads = fake.calls.length;
    const syncedAt = (await sub(workspaceId)).stripeSyncedAt!.getTime();
    expect(await handleStripeEvent(ev, fake)).toMatchObject({ handled: false, duplicate: true });
    expect(readsSince(reads)).toBe(0);
    expect(await ledger(ev.id)).toMatchObject({ attempts: 1, outcome: "needs_review" });
    expect((await sub(workspaceId)).stripeSyncedAt!.getTime()).toBe(syncedAt);
    // Juste AVANT la limite : toujours un doublon. Juste APRÈS : repris (configuration non corrigée : toujours à revoir, fenêtre rouverte).
    await processedAgo(ev.id, UNKNOWN_PRICE_RETRY_MS - 5_000);
    expect(await handleStripeEvent(ev, fake)).toMatchObject({ duplicate: true });
    await processedAgo(ev.id, UNKNOWN_PRICE_RETRY_MS + 5_000);
    expect(await handleStripeEvent(ev, fake)).toMatchObject({ handled: true });
    expect(readsSince(reads)).toBe(1);
    expect(await ledger(ev.id)).toMatchObject({ attempts: 2, outcome: "needs_review" });
    expect(await handleStripeEvent(ev, fake)).toMatchObject({ duplicate: true }); // `processedAt` rafraîchi : fenêtre rouverte
    expect(readsSince(reads)).toBe(1);
    expect(await audits(workspaceId, UNKNOWN_PRICE_ACTION)).toBe(1);
  });

  it("huit renvois simultanés après la fenêtre : un seul traitement, une seule lecture Stripe", async () => {
    const { workspaceId } = await setup();
    const ev = await send(workspaceId, { status: "active", ...unknown });
    await processedAgo(ev.id, STALE);
    const reads = fake.calls.length;
    const rs = await Promise.all(Array.from({ length: 8 }, () => handleStripeEvent(ev, fake)));
    expect(rs.filter((r) => r.handled)).toHaveLength(1);
    expect(rs.filter((r) => r.duplicate)).toHaveLength(7);
    expect(readsSince(reads)).toBe(1);
    expect(await ledger(ev.id)).toMatchObject({ status: "processed", attempts: 2 });
  });

  it("reprise possible après correction de la configuration, puis l'événement n'est plus jamais repris", async () => {
    const { workspaceId } = await setup();
    const ev = await send(workspaceId, { status: "active", ...unknown });
    vi.stubEnv("STRIPE_PRICE_GROWTH_LEGACY", "price_old_growth");
    expect(await handleStripeEvent(ev, fake)).toMatchObject({ duplicate: true }); // la correction seule ne contourne pas la fenêtre
    await processedAgo(ev.id, STALE);
    expect(await handleStripeEvent(ev, fake)).toMatchObject({ handled: true });
    expect(await sub(workspaceId)).toMatchObject({ status: "active", plan: "growth", stripeSubscriptionId: "sub_1" });
    expect(await ledger(ev.id)).toMatchObject({ outcome: "handled" });
    await processedAgo(ev.id, 30 * DAY);
    expect(await handleStripeEvent(ev, fake)).toMatchObject({ duplicate: true });
  });

  it("un autre `needs_review` (client inattendu) n'est jamais repris, même ancien", async () => {
    const { workspaceId } = await setup();
    await paidGrowth(workspaceId);
    const ev = await send(workspaceId, { status: "active" }, "sub_1", "cus_other");
    expect(await ledger(ev.id)).toMatchObject({ outcome: "needs_review" });
    await processedAgo(ev.id, 30 * DAY);
    expect(await handleStripeEvent(ev, fake)).toMatchObject({ handled: false, duplicate: true });
  });

  it("Stripe indisponible pendant la reprise : « failed », puis récupérable immédiatement par le réessai de Stripe", async () => {
    const { workspaceId } = await setup();
    const ev = await send(workspaceId, { status: "active", ...unknown });
    await processedAgo(ev.id, STALE);
    fake.unavailable = true;
    await expect(handleStripeEvent(ev, fake)).rejects.toThrow();
    fake.unavailable = false;
    expect(await ledger(ev.id)).toMatchObject({ status: "failed" });
    expect(await handleStripeEvent(ev, fake)).toMatchObject({ handled: true }); // l'état « failed » n'est jamais soumis à la fenêtre
    expect(await ledger(ev.id)).toMatchObject({ status: "processed", outcome: "needs_review" });
    expect(await audits(workspaceId, UNKNOWN_PRICE_ACTION)).toBe(1);
  });
});

describe("C4 — la revue est close dès que le prix est reconnu, sans accorder d'accès", () => {
  it("prix reconnu après correction, abonnement impayé : revue close, statut et forfait réels conservés, accès toujours suspendu", async () => {
    const { workspaceId } = await setup();
    await paidGrowth(workspaceId);
    fake.set("sub_1", { status: "active", ...unknown });
    await reconcileSubscription(workspaceId, fake);
    expect(await billingNeedsReview(workspaceId)).toBe(true);
    vi.stubEnv("STRIPE_PRICE_GROWTH_LEGACY", "price_old_growth");
    fake.set("sub_1", { status: "unpaid", ...unknown });
    await reconcileSubscription(workspaceId, fake);
    const s = await sub(workspaceId);
    expect(s).toMatchObject({ status: "unpaid", plan: "growth" });
    expect(entitlement(s)).toMatchObject({ active: false });
    expect(await audits(workspaceId, UNKNOWN_PRICE_RESOLVED_ACTION)).toBe(1);
    expect(await billingNeedsReview(workspaceId)).toBe(false);
  });

  it("le forfait n'est jamais déduit d'un prix reconnu pour un statut non payant (autre forfait local conservé)", async () => {
    vi.stubEnv("STRIPE_PRICE_PRO_LEGACY", "price_old_pro");
    const { workspaceId } = await setup();
    await paidGrowth(workspaceId);
    fake.set("sub_1", { status: "active", ...unknown });
    await reconcileSubscription(workspaceId, fake); //                          prix inconnu : revue ouverte
    fake.set("sub_1", { status: "unpaid", items: { data: [{ price: { id: "price_old_pro" } }] } }); // prix reconnu (pro), impayé
    await reconcileSubscription(workspaceId, fake);
    expect(await sub(workspaceId)).toMatchObject({ status: "unpaid", plan: "growth" }); // pas de forfait « pro » accordé
    expect(await billingNeedsReview(workspaceId)).toBe(false);
  });

  it("un prix toujours inconnu avec un statut impayé laisse la revue ouverte", async () => {
    const { workspaceId } = await setup();
    await paidGrowth(workspaceId);
    fake.set("sub_1", { status: "active", ...unknown });
    await reconcileSubscription(workspaceId, fake);
    fake.set("sub_1", { status: "unpaid", ...unknown });
    await reconcileSubscription(workspaceId, fake);
    expect(await audits(workspaceId, UNKNOWN_PRICE_RESOLVED_ACTION)).toBe(0);
    expect(await billingNeedsReview(workspaceId)).toBe(true);
  });
});

describe("C5 — checkout.session.completed avec un prix inconnu", () => {
  it("client rattaché et réservation effacée (flux checkout), mais abonnement non lié, statut et forfait conservés, résultat needs_review", async () => {
    const { workspaceId } = await makeWorkspace();
    await db.subscription.update({ where: { workspaceId }, data: { checkoutReservationId: "res_1", checkoutReservedUntil: new Date(Date.now() + 600_000), checkoutSessionId: "cs_1" } });
    const before = await sub(workspaceId);
    expect(before.stripeCustomerId).toBeNull();
    fake.set("sub_1", { status: "active", customer: "cus_9", ...unknown });
    const ev = event("checkout.session.completed", { id: "cs_1", mode: "subscription", client_reference_id: workspaceId, customer: "cus_9", subscription: "sub_1" });
    await handleStripeEvent(ev, fake);
    const s = await sub(workspaceId);
    expect(await ledger(ev.id)).toMatchObject({ outcome: "needs_review", status: "processed" });
    expect(s.stripeCustomerId).toBe("cus_9"); //                                                         écrit par le traitement du checkout, avant toute lecture de prix
    expect([s.checkoutReservationId, s.checkoutReservedUntil, s.checkoutSessionId]).toEqual([null, null, null]); // réservation terminée
    expect(s.stripeSubscriptionId).toBeNull(); //                                                        jamais rattaché sur un prix inconnu
    expect([s.status, s.plan, s.currentPeriodEnd, s.cancelAtPeriodEnd, s.trialEndsAt]).toEqual([before.status, before.plan, before.currentPeriodEnd, before.cancelAtPeriodEnd, before.trialEndsAt]);
    expect(entitlement(s).state).not.toBe("paid");
    expect(await billingNeedsReview(workspaceId)).toBe(true);
  });
});

describe("C6 — le tri des audits reste déterministe (détections et clôtures rapprochées)", () => {
  it("douze cycles détection → clôture enchaînés sans pause : l'indicateur suit toujours la dernière entrée", async () => {
    const { workspaceId } = await setup();
    await paidGrowth(workspaceId);
    for (let i = 0; i < 12; i++) {
      vi.stubEnv("STRIPE_PRICE_GROWTH_LEGACY", "");
      fake.set("sub_1", { status: "active", ...unknown });
      await reconcileSubscription(workspaceId, fake);
      expect(await billingNeedsReview(workspaceId), `cycle ${i} : ouverte`).toBe(true);
      vi.stubEnv("STRIPE_PRICE_GROWTH_LEGACY", "price_old_growth");
      await reconcileSubscription(workspaceId, fake);
      expect(await billingNeedsReview(workspaceId), `cycle ${i} : close`).toBe(false);
    }
    expect(await audits(workspaceId, UNKNOWN_PRICE_ACTION)).toBe(12);
    expect(await audits(workspaceId, UNKNOWN_PRICE_RESOLVED_ACTION)).toBe(12);
  });
});
