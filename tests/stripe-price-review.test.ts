import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { UNKNOWN_PRICE_ACTION, UNKNOWN_PRICE_RESOLVED_ACTION, billingNeedsReview, handleStripeEvent, planFromPriceId, planPriceId, reconcileDueSubscriptions, reconcileSubscription, setStripeGateway, stripeSetup, type StripeEvent } from "@/lib/billing";
import { fake } from "./stripe-fake";
import { makeWorkspace, resetDb } from "./helpers";

// Prix Stripe inconnus : détection, visibilité, traçabilité, reprise. Stripe est simulé en mémoire : aucun appel réseau, aucun paiement.

const DAY = 86_400_000;
const inDays = (n: number) => Math.floor((Date.now() + n * DAY) / 1000);
let seq = 0;
const event = (type: string, object: Record<string, unknown>): StripeEvent => ({ id: `evt_price_${++seq}_${Math.random().toString(36).slice(2, 7)}`, type, data: { object } });
const subPayload = (workspaceId: string, over: Record<string, unknown> = {}) => ({ id: "sub_1", customer: "cus_1", status: "active", metadata: { workspaceId, plan: "growth" }, items: { data: [{ price: { id: "price_growth_test" } }] }, current_period_end: inDays(30), ...over });
const sub = (workspaceId: string) => db.subscription.findUniqueOrThrow({ where: { workspaceId } });
const unknownItems = (id = "price_old_growth") => ({ items: { data: [{ price: { id } }] } });
const audits = (workspaceId: string, action: string) => db.auditLog.count({ where: { workspaceId, action } });
async function setup() {
  const w = await makeWorkspace();
  await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { stripeCustomerId: "cus_1" } });
  return w;
}
/** Livre l'événement `updated` ; Stripe détient `remote` ; retourne la ligne du registre. */
async function deliver(workspaceId: string, remote: Parameters<typeof fake.set>[1], id = "sub_1") {
  fake.set(id, remote);
  const ev = event("customer.subscription.updated", subPayload(workspaceId, { id }));
  await handleStripeEvent(ev, fake);
  return db.stripeEvent.findUniqueOrThrow({ where: { id: ev.id } });
}
/** Abonnement growth payé et lié (sub_1), prix actuel. */
async function paidGrowth(workspaceId: string) { await deliver(workspaceId, { status: "active" }); expect(await sub(workspaceId)).toMatchObject({ status: "active", plan: "growth", stripeSubscriptionId: "sub_1" }); }
/** Vieillit la dernière lecture : l'abonnement devient candidat à la réconciliation périodique. */
/** Précondition 2R : un renvoi du même événement « prix inconnu » n'est repris qu'après la fenêtre minimale (UNKNOWN_PRICE_RETRY_MS) ; ce helper la fait écouler. */
const staleEvent = (id: string) => db.stripeEvent.update({ where: { id }, data: { processedAt: new Date(Date.now() - 10 * 60_000) } });
const age = (workspaceId: string) => db.subscription.update({ where: { workspaceId }, data: { stripeSyncedAt: new Date(Date.now() - 2 * DAY) } });

beforeEach(resetDb);
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); setStripeGateway(null); });

describe("A — prix historiques : association explicite et non ambiguë", () => {
  it("1. un prix historique configuré est reconnu pour SON forfait ; le prix actuel reste utilisé pour tout nouveau paiement", async () => {
    vi.stubEnv("STRIPE_PRICE_STARTER_LEGACY", "price_old_starter, price_older_starter");
    vi.stubEnv("STRIPE_PRICE_GROWTH_LEGACY", "price_old_growth");
    expect([planFromPriceId("price_old_starter"), planFromPriceId("price_older_starter"), planFromPriceId("price_old_growth"), planFromPriceId("price_growth_test")]).toEqual(["starter", "starter", "growth", "growth"]);
    expect(planPriceId("growth")).toBe("price_growth_test"); // les prix historiques ne servent jamais à créer un paiement
    const { workspaceId } = await setup();
    const ledger = await deliver(workspaceId, { status: "active", ...unknownItems("price_old_starter"), metadata: { plan: "pro" } });
    expect(await sub(workspaceId)).toMatchObject({ status: "active", plan: "starter", stripeSubscriptionId: "sub_1" });
    expect(ledger.outcome).toBe("handled");
    expect(await audits(workspaceId, UNKNOWN_PRICE_ACTION)).toBe(0);
  });

  it("un prix non listé reste inconnu même si d'autres prix historiques existent ; un prix associé à deux forfaits n'est jamais reconnu", async () => {
    vi.stubEnv("STRIPE_PRICE_GROWTH_LEGACY", "price_old_growth,price_shared");
    vi.stubEnv("STRIPE_PRICE_PRO_LEGACY", "price_shared");
    expect(planFromPriceId("price_unlisted")).toBeNull();
    expect(planFromPriceId("price_shared")).toBeNull();
    expect(planFromPriceId("price_old_growth")).toBe("growth");
    expect(stripeSetup().issues.join(" ")).toMatch(/price_shared.*plusieurs forfaits/);
    const { workspaceId } = await setup();
    const ledger = await deliver(workspaceId, { status: "active", ...unknownItems("price_shared") });
    expect(ledger.outcome).toBe("needs_review");
    expect((await sub(workspaceId)).status).not.toBe("active");
  });

  it("un prix historique qui reprend le prix ACTUEL d'un autre forfait rend ce forfait non souscriptible (aucune attribution arbitraire)", () => {
    vi.stubEnv("STRIPE_PRICE_STARTER_LEGACY", "price_growth_test");
    expect(planFromPriceId("price_growth_test")).toBeNull();
    expect(stripeSetup().ready.growth).toBe(false);
  });

  it("format invalide signalé, valeurs historiques visibles dans le diagnostic seulement si définies", () => {
    expect(stripeSetup().variables.some((v) => v.name.endsWith("_LEGACY"))).toBe(false);
    vi.stubEnv("STRIPE_PRICE_PRO_LEGACY", "pas_un_prix");
    expect(stripeSetup().issues.join(" ")).toMatch(/STRIPE_PRICE_PRO_LEGACY.*format/);
    expect(stripeSetup().variables.find((v) => v.name === "STRIPE_PRICE_PRO_LEGACY")).toMatchObject({ set: true, valid: false });
  });
});

describe("B/C — détection, visibilité, traçabilité", () => {
  it("2. prix inconnu malgré des métadonnées contradictoires : aucun forfait attribué (même avec des prix historiques configurés pour d'autres prix)", async () => {
    vi.stubEnv("STRIPE_PRICE_PRO_LEGACY", "price_old_pro");
    const { workspaceId } = await setup();
    await db.subscription.update({ where: { workspaceId }, data: { plan: "starter" } });
    const ledger = await deliver(workspaceId, { status: "active", ...unknownItems("price_mystery"), metadata: { plan: "pro" } });
    expect(ledger.outcome).toBe("needs_review");
    expect(await sub(workspaceId)).toMatchObject({ plan: "starter" });
    expect((await sub(workspaceId)).status).not.toBe("active");
  });

  it("4. visible dans billingNeedsReview ; le registre et l'audit portent l'abonnement et le prix", async () => {
    const { workspaceId } = await setup();
    expect(await billingNeedsReview(workspaceId)).toBe(false);
    const ledger = await deliver(workspaceId, { status: "active", ...unknownItems("price_old_growth") });
    expect(await billingNeedsReview(workspaceId)).toBe(true);
    expect(ledger).toMatchObject({ outcome: "needs_review", workspaceId });
    expect(ledger.note).toMatch(/^unknown_price:.*sub_1.*price_old_growth/);
    const a = await db.auditLog.findFirstOrThrow({ where: { workspaceId, action: UNKNOWN_PRICE_ACTION } });
    expect(a.meta).toMatchObject({ subscriptionId: "sub_1", price: "price_old_growth", status: "active", source: "customer.subscription.updated" });
    expect(JSON.stringify(a.meta)).not.toMatch(/sk_|whsec_|@/); // aucune donnée sensible
    expect(await billingNeedsReview((await makeWorkspace()).workspaceId)).toBe(false); // les autres espaces ne sont pas concernés
  });

  it("3. détecté par le cron : compté dans le résumé, passage non « complete », une seule trace d'audit par épisode", async () => {
    const { workspaceId } = await setup();
    await paidGrowth(workspaceId);
    fake.set("sub_1", { status: "active", ...unknownItems("price_old_growth") });
    await age(workspaceId);
    const before = await sub(workspaceId);
    const first = await reconcileDueSubscriptions({ itemReserveMs: 0 }, fake);
    expect(first).toMatchObject({ checked: 1, updated: 0, failed: 0, needsReview: 1, unknownPrice: 1, complete: false });
    const after = await sub(workspaceId);
    expect([after.plan, after.status, after.stripeSubscriptionId, after.currentPeriodEnd]).toEqual([before.plan, before.status, before.stripeSubscriptionId, before.currentPeriodEnd]);
    expect(after.stripeSyncedAt!.getTime()).toBeGreaterThan(before.stripeSyncedAt!.getTime()); // lecture enregistrée…
    expect(await billingNeedsReview(workspaceId)).toBe(true); //                                   …mais jamais assimilée à une résolution
    // Deuxième passage (24 h plus tard) : toujours signalé, sans doublon artificiel d'audit.
    const second = await reconcileDueSubscriptions({ now: new Date(Date.now() + 2 * DAY), itemReserveMs: 0 }, fake);
    expect(second).toMatchObject({ needsReview: 1, unknownPrice: 1, complete: false });
    expect(await audits(workspaceId, UNKNOWN_PRICE_ACTION)).toBe(1);
    expect(await audits(workspaceId, UNKNOWN_PRICE_RESOLVED_ACTION)).toBe(0);
  });

  it("5. needs_review préserve annulation programmée, essai, client et réservation de paiement", async () => {
    const { workspaceId } = await setup();
    const trialEndsAt = new Date(Date.now() + 5 * DAY), reservedUntil = new Date(Date.now() + 40 * 60_000);
    await db.subscription.update({ where: { workspaceId }, data: { status: "trialing", plan: "starter", trialEndsAt, cancelAtPeriodEnd: true, checkoutReservationId: "res_1", checkoutReservedUntil: reservedUntil, checkoutSessionId: "cs_1" } });
    const before = await sub(workspaceId);
    await deliver(workspaceId, { status: "active", ...unknownItems("price_old_growth"), cancel_at_period_end: false, trial_end: inDays(60) });
    const after = await sub(workspaceId);
    const keep = (s: typeof after) => [s.plan, s.status, s.currentPeriodEnd, s.cancelAtPeriodEnd, s.trialEndsAt, s.stripeCustomerId, s.checkoutReservationId, s.checkoutReservedUntil, s.checkoutSessionId, s.canceledAt];
    expect(keep(after)).toEqual(keep(before));
    expect(after.cancelAtPeriodEnd).toBe(true);
    expect(after.checkoutSessionId).toBe("cs_1");
  });

  it("6a. prix inconnu avec un identifiant différent de l'identifiant local (l'ancien est terminé) : jamais remplacé", async () => {
    const { workspaceId } = await setup();
    await paidGrowth(workspaceId);
    await db.subscription.update({ where: { workspaceId }, data: { status: "canceled", canceledAt: new Date() } });
    const ledger = await deliver(workspaceId, { status: "active", ...unknownItems("price_old_growth") }, "sub_2");
    expect(ledger.outcome).toBe("needs_review");
    expect(await sub(workspaceId)).toMatchObject({ stripeSubscriptionId: "sub_1", status: "canceled", plan: "growth" });
    expect(await billingNeedsReview(workspaceId)).toBe(true);
  });

  it("6b. prix inconnu avec un autre identifiant alors que l'abonnement local est vivant : doublon signalé, état conservé", async () => {
    const { workspaceId } = await setup();
    await paidGrowth(workspaceId);
    const before = await sub(workspaceId);
    const ledger = await deliver(workspaceId, { status: "active", ...unknownItems("price_old_growth") }, "sub_2");
    expect(ledger.outcome).toBe("needs_review");
    expect(ledger.note).toMatch(/Deux abonnements actifs/);
    const after = await sub(workspaceId);
    expect([after.stripeSubscriptionId, after.status, after.plan, after.currentPeriodEnd]).toEqual([before.stripeSubscriptionId, before.status, before.plan, before.currentPeriodEnd]);
    expect(await billingNeedsReview(workspaceId)).toBe(true); // via le suivi des doublons existant
  });
});

describe("D — reprise après correction de la configuration", () => {
  it("7. abonnement lié : après ajout du prix historique, la réconciliation applique l'abonnement, clôt la revue et l'indicateur disparaît", async () => {
    const { workspaceId } = await setup();
    await paidGrowth(workspaceId);
    const renewed = inDays(60);
    fake.set("sub_1", { status: "active", ...unknownItems("price_old_growth"), current_period_end: renewed });
    expect(await reconcileSubscription(workspaceId, fake)).toMatchObject({ outcome: "needs_review", reason: "unknown_price" });
    expect(await billingNeedsReview(workspaceId)).toBe(true);
    expect((await sub(workspaceId)).currentPeriodEnd!.getTime()).toBeLessThan(renewed * 1000); // la période renouvelée n'est PAS appliquée tant que le prix est inconnu
    // Correction de configuration, puis reprise.
    vi.stubEnv("STRIPE_PRICE_GROWTH_LEGACY", "price_old_growth");
    expect(await reconcileSubscription(workspaceId, fake)).toMatchObject({ outcome: "handled" });
    expect(await sub(workspaceId)).toMatchObject({ status: "active", plan: "growth", currentPeriodEnd: new Date(renewed * 1000) });
    expect(await audits(workspaceId, UNKNOWN_PRICE_RESOLVED_ACTION)).toBe(1);
    expect(await billingNeedsReview(workspaceId)).toBe(false);
    await reconcileSubscription(workspaceId, fake); // une relecture ultérieure n'ajoute aucune clôture
    expect(await audits(workspaceId, UNKNOWN_PRICE_RESOLVED_ACTION)).toBe(1);
  });

  it("7 bis. reprise par le cron (lecture de plus de 24 h) : le résumé redevient complet", async () => {
    const { workspaceId } = await setup();
    await paidGrowth(workspaceId);
    fake.set("sub_1", { status: "active", ...unknownItems("price_old_growth") });
    await age(workspaceId);
    expect(await reconcileDueSubscriptions({ itemReserveMs: 0 }, fake)).toMatchObject({ unknownPrice: 1, complete: false });
    vi.stubEnv("STRIPE_PRICE_GROWTH_LEGACY", "price_old_growth");
    expect(await reconcileDueSubscriptions({ now: new Date(Date.now() + 2 * DAY), itemReserveMs: 0 }, fake)).toMatchObject({ checked: 1, unknownPrice: 0, needsReview: 0, complete: true });
    expect(await billingNeedsReview(workspaceId)).toBe(false);
  });

  it("8. abonnement non lié localement : rien n'est rattaché ni attribué ; ni le cron ni la reprise unitaire ne le voient ; le renvoi de l'événement après correction l'applique", async () => {
    const { workspaceId } = await setup();
    const before = await sub(workspaceId);
    expect(before.stripeSubscriptionId).toBeNull();
    const ev = event("customer.subscription.updated", subPayload(workspaceId));
    fake.set("sub_1", { status: "active", ...unknownItems("price_old_growth") });
    await handleStripeEvent(ev, fake);
    expect(await db.stripeEvent.findUniqueOrThrow({ where: { id: ev.id } })).toMatchObject({ status: "processed", outcome: "needs_review" });
    const kept = await sub(workspaceId);
    expect(kept.stripeSubscriptionId).toBeNull(); // jamais de rattachement sur un prix inconnu
    expect([kept.plan, kept.status, kept.currentPeriodEnd, kept.cancelAtPeriodEnd, kept.trialEndsAt, kept.stripeCustomerId]).toEqual([before.plan, before.status, before.currentPeriodEnd, before.cancelAtPeriodEnd, before.trialEndsAt, before.stripeCustomerId]);
    expect(await billingNeedsReview(workspaceId)).toBe(true);
    expect(await reconcileSubscription(workspaceId, fake)).toBeNull(); // sans identifiant : pas de reprise unitaire
    await age(workspaceId);
    expect(await reconcileDueSubscriptions({ itemReserveMs: 0 }, fake)).toMatchObject({ checked: 0 }); // ni de réconciliation périodique
    expect(await billingNeedsReview(workspaceId)).toBe(true); // et la revue reste ouverte
    // Correction de configuration, puis renvoi VOLONTAIRE du même événement (tableau de bord Stripe) : il est repris.
    vi.stubEnv("STRIPE_PRICE_GROWTH_LEGACY", "price_old_growth");
    await staleEvent(ev.id);
    expect(await handleStripeEvent(ev, fake)).toMatchObject({ handled: true });
    expect(await sub(workspaceId)).toMatchObject({ status: "active", plan: "growth", stripeSubscriptionId: "sub_1" });
    expect(await db.stripeEvent.findUniqueOrThrow({ where: { id: ev.id } })).toMatchObject({ status: "processed", outcome: "handled", attempts: 2 }); // 1re réservation + reprise du renvoi
    expect(await billingNeedsReview(workspaceId)).toBe(false);
    expect(await handleStripeEvent(ev, fake)).toMatchObject({ handled: false, duplicate: true }); // désormais traité : plus jamais repris
  });

  it("8 bis. un autre needs_review (client inattendu) n'est JAMAIS repris par un renvoi", async () => {
    const { workspaceId } = await setup();
    await paidGrowth(workspaceId);
    const ev = event("customer.subscription.updated", subPayload(workspaceId, { customer: "cus_other" }));
    fake.set("sub_1", { status: "active", customer: "cus_other" });
    await handleStripeEvent(ev, fake);
    expect(await db.stripeEvent.findUniqueOrThrow({ where: { id: ev.id } })).toMatchObject({ outcome: "needs_review" });
    expect(await handleStripeEvent(ev, fake)).toMatchObject({ handled: false, duplicate: true });
  });

  it("9. annulation avec prix inconnu : appliquée, et elle clôt la revue ouverte", async () => {
    const { workspaceId } = await setup();
    await paidGrowth(workspaceId);
    await deliver(workspaceId, { status: "active", ...unknownItems("price_old_growth") });
    expect(await billingNeedsReview(workspaceId)).toBe(true);
    const ledger = await deliver(workspaceId, { status: "canceled", ...unknownItems("price_old_growth") });
    expect(ledger.outcome).toBe("handled");
    expect(await sub(workspaceId)).toMatchObject({ status: "canceled", plan: "growth" });
    expect(await audits(workspaceId, UNKNOWN_PRICE_RESOLVED_ACTION)).toBe(1);
    expect(await billingNeedsReview(workspaceId)).toBe(false);
  });

  it("10. aucun faux « résolu » : relectures répétées, événement renvoyé sans correction et impayé non entitled ne ferment pas la revue", async () => {
    const { workspaceId } = await setup();
    await paidGrowth(workspaceId);
    const ledger = await deliver(workspaceId, { status: "active", ...unknownItems("price_old_growth") });
    for (let i = 0; i < 3; i++) await reconcileSubscription(workspaceId, fake); // lectures répétées : stripeSyncedAt avance, rien d'autre
    expect(await audits(workspaceId, UNKNOWN_PRICE_RESOLVED_ACTION)).toBe(0);
    expect(await audits(workspaceId, UNKNOWN_PRICE_ACTION)).toBe(1);
    expect(await billingNeedsReview(workspaceId)).toBe(true);
    // Le même événement renvoyé alors que la configuration n'est pas corrigée : repris, mais toujours inconnu — aucune clôture, aucun nouvel audit.
    await staleEvent(ledger.id);
    const replay = await handleStripeEvent({ id: ledger.id, type: "customer.subscription.updated", data: { object: subPayload(workspaceId) } }, fake);
    expect(replay.handled).toBe(true);
    expect(await db.stripeEvent.findUniqueOrThrow({ where: { id: ledger.id } })).toMatchObject({ outcome: "needs_review" });
    expect(await audits(workspaceId, UNKNOWN_PRICE_ACTION)).toBe(1);
    expect(await audits(workspaceId, UNKNOWN_PRICE_RESOLVED_ACTION)).toBe(0);
    // Un statut impayé (non entitled) avec ce prix n'applique pas le prix : la revue reste ouverte.
    fake.set("sub_1", { status: "unpaid", ...unknownItems("price_old_growth") });
    await reconcileSubscription(workspaceId, fake);
    expect(await audits(workspaceId, UNKNOWN_PRICE_RESOLVED_ACTION)).toBe(0);
    expect(await billingNeedsReview(workspaceId)).toBe(true);
  });
});
