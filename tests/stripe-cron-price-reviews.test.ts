import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { ReviewTraceError, UNKNOWN_PRICE_ACTION, billingNeedsReview, handleStripeEvent, reconcileDueSubscriptions, reconcileSubscription, setStripeGateway, type StripeEvent } from "@/lib/billing";
import { POST as cron } from "@/app/api/cron/followups/route";
import { log } from "@/lib/logger";
import { fake } from "./stripe-fake";
import { makeWorkspace, resetDb } from "./helpers";

// 2U-B — (1) route du cron : compteurs de revues « prix inconnu » dans la réponse ; (2) perte du bail pendant la détection (chemin `if (!marked) continue`).
// Stripe est simulé en mémoire (tests/stripe-fake.ts) : aucun appel réseau, aucun paiement, aucun envoi.

const DAY = 86_400_000;
const SECRET = "cron-secret-for-tests-only";
const inDays = (n: number) => Math.floor((Date.now() + n * DAY) / 1000);
let seq = 0;
const event = (type: string, object: Record<string, unknown>): StripeEvent => ({ id: `evt_cr_${++seq}_${Math.random().toString(36).slice(2, 7)}`, type, data: { object } });
const payload = (workspaceId: string, over: Record<string, unknown> = {}) => ({ id: "sub_1", customer: "cus_1", status: "active", metadata: { workspaceId }, items: { data: [{ price: { id: "price_growth_test" } }] }, current_period_end: inDays(30), ...over });
const unknown = { items: { data: [{ price: { id: "price_old_growth" } }] } };
const sub = (w: string) => db.subscription.findUniqueOrThrow({ where: { workspaceId: w } });
const audits = (w: string, action: string) => db.auditLog.count({ where: { workspaceId: w, action } });
/** Appel SANS `sync=0` implicite (les tests de `disabledStages` maîtrisent les paramètres). */
const call = (q = "") => cron(new Request(`http://x/api/cron/followups${q}`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } }));
const post = (q = "") => cron(new Request(`http://x/api/cron/followups?sync=0${q}`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } }));
const stale = (id: string) => db.stripeEvent.update({ where: { id }, data: { processedAt: new Date(Date.now() - 10 * 60_000) } });
const readAt = (workspaceId: string, daysAgo: number) => db.subscription.update({ where: { workspaceId }, data: { stripeSyncedAt: new Date(Date.now() - daysAgo * DAY) } });

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
const configureCron = () => { process.env.CRON_SECRET = SECRET; process.env.STRIPE_SECRET_KEY = "sk_test_placeholder"; setStripeGateway(fake); };

/** Simule un autre serveur qui reprend le bail JUSTE AVANT l'écriture transactionnelle de la revue (après la vérification du bail en tête de boucle) : la première transaction est précédée d'un SQL direct. */
function stealLeaseBeforeReviewWrite(workspaceId: string) {
  const real = db.$transaction.bind(db) as unknown as (...a: unknown[]) => Promise<unknown>;
  const state = { stolen: false };
  const spy = vi.spyOn(db, "$transaction").mockImplementation((async (...args: unknown[]) => {
    if (!state.stolen) { state.stolen = true; await db.$executeRaw`UPDATE "Subscription" SET "stripeSyncLeaseId" = 'autre_serveur' WHERE "workspaceId" = ${workspaceId}`; }
    return real(...args);
  }) as never);
  return { spy, state };
}

/** Fait échouer l'écriture d'audit À L'INTÉRIEUR de la transaction (le reste s'exécute réellement : retour en arrière vérifiable). */
function failAuditInTransaction() {
  const real = db.$transaction.bind(db) as unknown as (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
  return vi.spyOn(db, "$transaction").mockImplementation(((fn: (tx: unknown) => Promise<unknown>) =>
    real((tx) => fn(new Proxy(tx as object, { get: (t, k, r) => (k === "auditLog" ? { create: async () => { throw new Error("audit indisponible"); } } : Reflect.get(t, k, r)) })))) as never);
}
const unknownPriceLogs = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((c) => c[0] === "billing.unknown_price");

beforeEach(resetDb);
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); setStripeGateway(null); delete process.env.CRON_SECRET; delete process.env.STRIPE_SECRET_KEY; });

describe("route du cron — compteurs de revues « prix inconnu »", () => {
  const COUNTERS = ["checked", "updated", "failed", "busy", "needsReview", "unknownPrice", "openPriceReviews", "unlinkedPriceReviews", "reviewCountersAvailable", "deferred", "remaining", "complete", "stoppedBy"];

  it("réponse : les compteurs sont présents, cohérents (ouvertes = liées + non liées), durables entre deux passages, et la complétion reste fausse", async () => {
    configureCron();
    const A = await setup("cus_A"), B = await setup("cus_B"), C = await setup("cus_C");
    const evA = await send(A.workspaceId, { status: "active", ...unknown }, "sub_A", "cus_A"); //          A : jamais lié, revue ouverte
    await paidGrowth(B.workspaceId, "sub_B", "cus_B"); //                                                  B : lié, prix devenu inconnu
    await paidGrowth(C.workspaceId, "sub_C", "cus_C"); //                                                  C : lié, sain
    fake.set("sub_B", { status: "active", customer: "cus_B", ...unknown });
    await readAt(B.workspaceId, 2); await readAt(C.workspaceId, 2);

    const res = await post();
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const k of COUNTERS) expect(body.billing, `champ ${k}`).toHaveProperty(k);
    expect(body.billing).toMatchObject({ checked: 2, failed: 0, busy: 0, needsReview: 1, unknownPrice: 1, openPriceReviews: 2, unlinkedPriceReviews: 1, complete: false, stoppedBy: null });
    for (const k of ["checked", "updated", "needsReview", "unknownPrice", "openPriceReviews", "unlinkedPriceReviews"]) expect(Number.isInteger(body.billing[k]) && body.billing[k] >= 0, k).toBe(true);
    expect(body.billing.unlinkedPriceReviews).toBeLessThanOrEqual(body.billing.openPriceReviews);
    expect(body.billing.openPriceReviews - body.billing.unlinkedPriceReviews).toBe(1); // les ouvertes se décomposent : B (liée) + A (non liée)
    expect(body.billing.reviewCountersAvailable).toBe(true); // compteurs fiables
    expect(body.complete).toBe(false);

    // Passage suivant : rien n'est relu (lectures récentes), mais les revues restent comptées et la complétion reste fausse.
    const next = await (await post()).json();
    expect(next.billing).toMatchObject({ checked: 0, unknownPrice: 0, needsReview: 0, openPriceReviews: 2, unlinkedPriceReviews: 1, complete: false });
    expect(next.complete).toBe(false);
    for (const w of [A, B]) expect(await billingNeedsReview(w.workspaceId)).toBe(true);
    expect(await billingNeedsReview(C.workspaceId)).toBe(false);

    // Résolution : configuration corrigée ; A par renvoi de son événement, B par sa propre relecture : la réponse redevient complète.
    vi.stubEnv("STRIPE_PRICE_GROWTH_LEGACY", "price_old_growth");
    await stale(evA.id);
    expect(await handleStripeEvent(evA, fake)).toMatchObject({ handled: true });
    await readAt(B.workspaceId, 2);
    const done = await (await post()).json();
    expect(done.billing).toMatchObject({ openPriceReviews: 0, unlinkedPriceReviews: 0, unknownPrice: 0, needsReview: 0, complete: true });
    expect(done.complete).toBe(true);
  });

  it("réconciliation désactivée VOLONTAIREMENT (`reconcile=0`) : la réponse le dit, sans compteurs, et la tâche n'est PAS complète", async () => {
    configureCron();
    const A = await setup("cus_A");
    await send(A.workspaceId, { status: "active", ...unknown }, "sub_A", "cus_A");
    const body = await (await post("&reconcile=0")).json();
    expect(body.billing).toEqual({ skipped: true, reason: "désactivée par paramètre" });
    for (const k of ["openPriceReviews", "unlinkedPriceReviews", "unknownPrice"]) expect(body.billing).not.toHaveProperty(k);
    expect(body.complete).toBe(false); // une désactivation volontaire n'est pas une réconciliation complète (≠ Stripe non configuré : sans objet)
    expect(await billingNeedsReview(A.workspaceId)).toBe(true);
  });

  it("Stripe non configuré : réconciliation ignorée explicitement, aucun compteur, aucun appel Stripe", async () => {
    process.env.CRON_SECRET = SECRET;
    const A = await setup("cus_A");
    await send(A.workspaceId, { status: "active", ...unknown }, "sub_A", "cus_A");
    const callsBefore = fake.calls.length;
    const body = await (await post()).json();
    expect(body.billing).toEqual({ skipped: true, reason: "Stripe non configuré" });
    expect(body.complete).toBe(true); //          réconciliation sans objet : n'empêche pas la complétion (distinct de reconcile=0)
    expect(fake.calls.length).toBe(callsBefore);
  });

  it("Stripe indisponible avec une revue non liée ouverte : le compteur durable reste exact (il vient de l'audit), le passage est incomplet", async () => {
    configureCron();
    const A = await setup("cus_A"), B = await setup("cus_B");
    await send(A.workspaceId, { status: "active", ...unknown }, "sub_A", "cus_A");
    await paidGrowth(B.workspaceId, "sub_B", "cus_B");
    await readAt(B.workspaceId, 2);
    fake.unavailable = true;
    const res = await post();
    fake.unavailable = false;
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.billing).toMatchObject({ checked: 1, failed: 1, unknownPrice: 0, openPriceReviews: 1, unlinkedPriceReviews: 1, complete: false });
    expect(body.complete).toBe(false);
    expect((await sub(B.workspaceId)).status).toBe("active"); // aucun droit modifié par la panne
  });

  it("échec du calcul des revues ouvertes : le compte rendu du passage est conservé, les compteurs durables sont INCONNUS (null, jamais 0), la tâche n'est pas complète", async () => {
    configureCron();
    const B = await setup("cus_B");
    await paidGrowth(B.workspaceId, "sub_B", "cus_B");
    await readAt(B.workspaceId, 2);
    const real = db.auditLog.findMany.bind(db.auditLog);
    vi.spyOn(db.auditLog, "findMany").mockImplementation(((args: { where?: { action?: { in?: string[] } } }) => {
      if (args?.where?.action?.in?.includes(UNKNOWN_PRICE_ACTION)) return Promise.reject(new Error("audit illisible"));
      return real(args as never);
    }) as never);
    const res = await post();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.billing).toMatchObject({ checked: 1, failed: 0, openPriceReviews: null, unlinkedPriceReviews: null, reviewCountersAvailable: false, complete: false }); // le passage a bien eu lieu : checked conservé
    expect(body.complete).toBe(false);
    expect((await sub(B.workspaceId)).stripeSyncedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000); // l'abonnement a été relu normalement
  });

  it("échec complet de la réconciliation : compte rendu de repli, compteurs durables inconnus (null) et disponibilité fausse, sans modifier aucun état", async () => {
    configureCron();
    const B = await setup("cus_B");
    await paidGrowth(B.workspaceId, "sub_B", "cus_B");
    await readAt(B.workspaceId, 2);
    const before = await sub(B.workspaceId);
    const real = db.subscription.count.bind(db.subscription);
    vi.spyOn(db.subscription, "count").mockImplementation(((args: { where?: { stripeSubscriptionId?: unknown } }) => {
      if (args?.where?.stripeSubscriptionId) return Promise.reject(new Error("base illisible"));
      return real(args as never);
    }) as never);
    const res = await post();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.billing).toEqual({ checked: 0, updated: 0, failed: 1, busy: 0, needsReview: 0, unknownPrice: 0, openPriceReviews: null, unlinkedPriceReviews: null, reviewCountersAvailable: false, deferred: 0, remaining: 0, complete: false, stoppedBy: null });
    expect(body.complete).toBe(false);
    const after = await sub(B.workspaceId);
    expect([after.status, after.plan, after.currentPeriodEnd, after.stripeSyncedAt]).toEqual([before.status, before.plan, before.currentPeriodEnd, before.stripeSyncedAt]);
  });
});

describe("perte du bail pendant la détection d'un prix inconnu (`if (!marked) continue`)", () => {
  it("réconciliation unitaire : issue « ignored » (bail obsolète), aucune trace, aucune lecture enregistrée, aucun état modifié, bail de l'autre serveur intact", async () => {
    const { workspaceId } = await setup("cus_1");
    await paidGrowth(workspaceId, "sub_1", "cus_1");
    const oldRead = new Date("2026-01-01T00:00:00Z");
    await db.subscription.update({ where: { workspaceId }, data: { stripeSyncedAt: oldRead } });
    const before = await sub(workspaceId);
    fake.set("sub_1", { status: "active", ...unknown });
    const { spy, state } = stealLeaseBeforeReviewWrite(workspaceId);
    const r = await reconcileSubscription(workspaceId, fake);
    spy.mockRestore();
    expect(state.stolen).toBe(true);
    expect(r).toMatchObject({ outcome: "ignored" });
    expect(r?.note).toMatch(/obsolète/);
    expect(r?.reason).toBeUndefined(); //                                           pas présenté comme une détection de prix inconnu
    const after = await sub(workspaceId);
    expect(after.stripeSyncedAt!.getTime()).toBe(oldRead.getTime()); //             lecture non enregistrée : transaction non validée…
    expect(await audits(workspaceId, UNKNOWN_PRICE_ACTION)).toBe(0); //             …et aucune trace
    expect([after.status, after.plan, after.currentPeriodEnd, after.stripeSubscriptionId]).toEqual([before.status, before.plan, before.currentPeriodEnd, before.stripeSubscriptionId]);
    expect(after.stripeSyncLeaseId).toBe("autre_serveur"); //                       le bail du nouveau détenteur n'est jamais libéré par le détenteur dépossédé
    expect(await billingNeedsReview(workspaceId)).toBe(false); //                   aucune revue ouverte à tort
  });

  it("événement Stripe : « processed » avec l'issue « ignored » (aucun effet), pas d'erreur ; une reprise ultérieure trace normalement", async () => {
    const { workspaceId } = await setup("cus_1");
    await paidGrowth(workspaceId, "sub_1", "cus_1");
    fake.set("sub_1", { status: "active", ...unknown });
    const ev = event("customer.subscription.updated", payload(workspaceId));
    const { spy } = stealLeaseBeforeReviewWrite(workspaceId);
    expect(await handleStripeEvent(ev, fake)).toEqual({ handled: false }); //       « ignoré » : ni traité ni en erreur
    spy.mockRestore();
    expect(await db.stripeEvent.findUniqueOrThrow({ where: { id: ev.id } })).toMatchObject({ status: "processed", outcome: "ignored" });
    expect(await audits(workspaceId, UNKNOWN_PRICE_ACTION)).toBe(0);
    // Le bail de l'« autre serveur » est échu : une nouvelle livraison (autre événement) détecte et trace une fois.
    await db.subscription.update({ where: { workspaceId }, data: { stripeSyncLeaseId: null, stripeSyncLeaseUntil: null } });
    await send(workspaceId, { status: "active", ...unknown }, "sub_1", "cus_1");
    expect(await audits(workspaceId, UNKNOWN_PRICE_ACTION)).toBe(1);
    expect(await billingNeedsReview(workspaceId)).toBe(true);
  });

  it("passage du cron : l'abonnement dépossédé est ignoré sans échec ni compte erroné, les autres sont traités normalement", async () => {
    const A = await setup("cus_A"), B = await setup("cus_B"), C = await setup("cus_C");
    for (const [w, id, c] of [[A, "sub_A", "cus_A"], [B, "sub_B", "cus_B"], [C, "sub_C", "cus_C"]] as const) await paidGrowth(w.workspaceId, id, c);
    fake.set("sub_A", { status: "active", customer: "cus_A", ...unknown }); //   A : prix inconnu, bail repris pendant la détection
    fake.set("sub_B", { status: "active", customer: "cus_B", ...unknown }); //   B : prix inconnu, traité normalement
    fake.set("sub_C", { status: "canceled", customer: "cus_C" }); //             C : résilié chez Stripe, appliqué normalement
    await readAt(A.workspaceId, 4); await readAt(B.workspaceId, 3); await readAt(C.workspaceId, 2); // A est lu en premier
    const aRead = (await sub(A.workspaceId)).stripeSyncedAt!.getTime();
    const { spy, state } = stealLeaseBeforeReviewWrite(A.workspaceId);
    const r = await reconcileDueSubscriptions({ itemReserveMs: 0 }, fake);
    spy.mockRestore();
    expect(state.stolen).toBe(true);
    expect(r).toMatchObject({ checked: 3, updated: 1, needsReview: 1, unknownPrice: 1, failed: 0, busy: 0, openPriceReviews: 1, unlinkedPriceReviews: 0, stoppedBy: null, complete: false });
    // A : rien d'enregistré, bail de l'autre serveur intact.
    const a = await sub(A.workspaceId);
    expect(a.stripeSyncedAt!.getTime()).toBe(aRead);
    expect(a.stripeSyncLeaseId).toBe("autre_serveur");
    expect(await audits(A.workspaceId, UNKNOWN_PRICE_ACTION)).toBe(0);
    expect(await billingNeedsReview(A.workspaceId)).toBe(false);
    // B : détection tracée normalement, bail libéré. C : résiliation appliquée.
    expect(await audits(B.workspaceId, UNKNOWN_PRICE_ACTION)).toBe(1);
    expect((await sub(B.workspaceId)).stripeSyncLeaseId).toBeNull();
    expect(await sub(C.workspaceId)).toMatchObject({ status: "canceled", stripeSyncLeaseId: null });
  });
});

describe("journalisation « billing.unknown_price » : uniquement pour une détection validée ou une vraie erreur d'écriture", () => {
  it("bail perdu pendant la détection : AUCUN journal « billing.unknown_price » (pas de faux incident) ni trace", async () => {
    const { workspaceId } = await setup("cus_1");
    await paidGrowth(workspaceId, "sub_1", "cus_1");
    fake.set("sub_1", { status: "active", ...unknown });
    const spyLog = vi.spyOn(log, "error");
    const { spy, state } = stealLeaseBeforeReviewWrite(workspaceId);
    const r = await reconcileSubscription(workspaceId, fake);
    spy.mockRestore();
    expect(state.stolen).toBe(true);
    expect(r).toMatchObject({ outcome: "ignored" });
    expect(unknownPriceLogs(spyLog)).toHaveLength(0);
    expect(await audits(workspaceId, UNKNOWN_PRICE_ACTION)).toBe(0);
  });

  it("détection validée : un seul journal, après l'écriture (sans drapeau d'erreur), avec l'abonnement et le prix", async () => {
    const { workspaceId } = await setup("cus_1");
    await paidGrowth(workspaceId, "sub_1", "cus_1");
    fake.set("sub_1", { status: "active", ...unknown });
    const spyLog = vi.spyOn(log, "error");
    expect(await reconcileSubscription(workspaceId, fake)).toMatchObject({ outcome: "needs_review", reason: "unknown_price" });
    const calls = unknownPriceLogs(spyLog);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({ workspaceId, subscriptionId: "sub_1", priceId: "price_old_growth" });
    expect(calls[0][1]).not.toHaveProperty("traceWriteFailed");
    expect(await audits(workspaceId, UNKNOWN_PRICE_ACTION)).toBe(1);
  });

  it("véritable erreur d'écriture : l'incident est journalisé avec traceWriteFailed et sa cause, l'erreur remonte (ReviewTraceError), rien n'est enregistré", async () => {
    const { workspaceId } = await setup("cus_1");
    await paidGrowth(workspaceId, "sub_1", "cus_1");
    const oldRead = new Date("2026-01-01T00:00:00Z");
    await db.subscription.update({ where: { workspaceId }, data: { stripeSyncedAt: oldRead } });
    fake.set("sub_1", { status: "active", ...unknown });
    const spyLog = vi.spyOn(log, "error");
    const spy = failAuditInTransaction();
    await expect(reconcileSubscription(workspaceId, fake)).rejects.toBeInstanceOf(ReviewTraceError);
    spy.mockRestore();
    const calls = unknownPriceLogs(spyLog);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({ subscriptionId: "sub_1", priceId: "price_old_growth", traceWriteFailed: true });
    expect(String((calls[0][1] as { error: string }).error)).toMatch(/audit indisponible/);
    expect(await audits(workspaceId, UNKNOWN_PRICE_ACTION)).toBe(0);
    expect((await sub(workspaceId)).stripeSyncedAt!.getTime()).toBe(oldRead.getTime());
  });
});

describe("paramètres du cron : disabledStages, asymétrie de complete, Stripe absent", () => {
  /** Appels à `db.subscription.count` qui sont CE contrôle (filtre unique sur stripeSubscriptionId), et non le comptage de la réconciliation. */
  const linkedChecks = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((c) => { const w = (c[0] as { where?: Record<string, unknown> } | undefined)?.where; return !!w && Object.keys(w).length === 1 && "stripeSubscriptionId" in w; });
  const link = async (n: number) => { for (let i = 0; i < n; i++) { const w = await setup(`cus_X${i}`); await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { stripeSubscriptionId: `sub_X${i}` } }); } };

  it("aucune désactivation : disabledStages est une liste vide", async () => {
    configureCron();
    const body = await (await call()).json();
    expect(body.disabledStages).toEqual([]);
    expect(body.complete).toBe(true);
  });

  it("sync=0 : disabledStages = [sync], complete conserve son comportement (vrai)", async () => {
    configureCron();
    const body = await (await call("?sync=0")).json();
    expect(body.disabledStages).toEqual(["sync"]);
    expect(body.complete).toBe(true);
    expect(body).toHaveProperty("syncSkipped"); // clé existante intacte, distincte de disabledStages
  });

  it("reconcile=0 : disabledStages = [reconcile], complete FAUX", async () => {
    configureCron();
    const body = await (await call("?reconcile=0")).json();
    expect(body.disabledStages).toEqual(["reconcile"]);
    expect(body.billing).toEqual({ skipped: true, reason: "désactivée par paramètre" });
    expect(body.complete).toBe(false);
  });

  it("purge=0 : disabledStages = [purge], complete conserve son comportement (vrai)", async () => {
    configureCron();
    const body = await (await call("?purge=0")).json();
    expect(body.disabledStages).toEqual(["purge"]);
    expect(body.ledgerPurged).toEqual({ skipped: true });
    expect(body.complete).toBe(true);
  });

  it("les trois désactivées, dans un ordre quelconque de la requête : liste dans l'ordre fixe, complete faux ; la valeur du paramètre compte (autre que 0 : actif)", async () => {
    configureCron();
    const all = await (await call("?purge=0&reconcile=0&sync=0")).json();
    expect(all.disabledStages).toEqual(["sync", "reconcile", "purge"]);
    expect(all.complete).toBe(false);
    expect((await (await call("?sync=1&purge=oui")).json()).disabledStages).toEqual([]);
  });

  it("Stripe absent SANS abonnement lié : mode essai normal, billing inchangé, complete vrai, aucun journal d'erreur", async () => {
    process.env.CRON_SECRET = SECRET;
    await setup("cus_trial"); //                                   client Stripe connu mais aucun abonnement lié
    const spyLog = vi.spyOn(log, "error");
    const body = await (await call("?sync=0")).json();
    expect(body.billing).toEqual({ skipped: true, reason: "Stripe non configuré" });
    expect(body.complete).toBe(true);
    expect(spyLog.mock.calls.filter((c) => String(c[0]).startsWith("cron.stripe_not_configured"))).toHaveLength(0);
  });

  it("Stripe absent AVEC abonnements liés : complete faux, compte exact dans billing.linkedSubscriptions, journal d'erreur avec le nombre", async () => {
    process.env.CRON_SECRET = SECRET;
    await link(2); await setup("cus_unlinked"); //                  2 liés, 1 non lié : seuls les liés comptent
    const spyLog = vi.spyOn(log, "error");
    const body = await (await call("?sync=0")).json();
    expect(body.billing).toEqual({ skipped: true, reason: "Stripe non configuré", linkedSubscriptions: 2 });
    expect(body.complete).toBe(false);
    const logs = spyLog.mock.calls.filter((c) => c[0] === "cron.stripe_not_configured_with_subscriptions");
    expect(logs).toHaveLength(1);
    expect(logs[0][1]).toEqual({ count: 2 });
  });

  it("Stripe absent avec reconcile=0 : la désactivation volontaire garde la priorité, aucun contrôle des abonnements, complete faux, aucun journal Stripe absent", async () => {
    process.env.CRON_SECRET = SECRET;
    await link(2);
    const count = vi.spyOn(db.subscription, "count");
    const spyLog = vi.spyOn(log, "error");
    const body = await (await call("?sync=0&reconcile=0")).json();
    expect(linkedChecks(count)).toHaveLength(0);
    expect(body.billing).toEqual({ skipped: true, reason: "désactivée par paramètre" });
    expect(body.disabledStages).toEqual(["sync", "reconcile"]);
    expect(body.complete).toBe(false);
    expect(spyLog.mock.calls.filter((c) => String(c[0]).startsWith("cron.stripe_not_configured"))).toHaveLength(0);
  });

  it("Stripe configuré : aucun contrôle des abonnements liés (pas de requête inutile)", async () => {
    configureCron();
    await link(1);
    const count = vi.spyOn(db.subscription, "count");
    const body = await (await call("?sync=0")).json();
    expect(linkedChecks(count)).toHaveLength(0);
    expect(body.billing).not.toHaveProperty("linkedSubscriptions");
  });

  it("échec du comptage des abonnements liés (Stripe absent) : complete faux, linkedSubscriptions inconnu (null), journal explicite sans donnée sensible, jamais de succès affiché", async () => {
    process.env.CRON_SECRET = SECRET;
    await link(1);
    const real = db.subscription.count.bind(db.subscription);
    vi.spyOn(db.subscription, "count").mockImplementation(((args: { where?: Record<string, unknown> }) => {
      if (args?.where && Object.keys(args.where).length === 1 && "stripeSubscriptionId" in args.where) return Promise.reject(new Error("base illisible"));
      return real(args as never);
    }) as never);
    const spyLog = vi.spyOn(log, "error");
    const res = await call("?sync=0");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.billing).toEqual({ skipped: true, reason: "Stripe non configuré", linkedSubscriptions: null });
    expect(body.complete).toBe(false);
    const logs = spyLog.mock.calls.filter((c) => c[0] === "cron.stripe_not_configured_check_failed");
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs[0][1])).toMatch(/base illisible/);
    expect(JSON.stringify(logs[0][1])).not.toMatch(new RegExp(SECRET));
  });
});
