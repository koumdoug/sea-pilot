import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { reconcileDueSubscriptions, reconcileSubscription } from "@/lib/billing";
import { entitlement } from "@/lib/plans";
import { entitlementForWorkspace } from "@/lib/free-access";
import { fake } from "./stripe-fake";
import { makeWorkspace, resetDb } from "./helpers";

// V1 — la réconciliation répare les divergences dans les DEUX sens, sans jamais créer de droit sans que l'état relu chez Stripe le justifie.

const DAY = 86_400_000;
const inDays = (n: number) => Math.floor((Date.now() + n * DAY) / 1000);
const sub = (workspaceId: string) => db.subscription.findUniqueOrThrow({ where: { workspaceId } });
const stale = () => new Date(Date.now() - 2 * DAY); // dernière synchronisation il y a plus de 24 h

async function linked(local: Record<string, unknown>) {
  const w = await makeWorkspace();
  await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { plan: "growth", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1", currentPeriodEnd: new Date(Date.now() + 20 * DAY), stripeSyncedAt: stale(), ...local } });
  return w;
}

beforeEach(resetDb);
afterEach(() => { delete process.env.FREE_ACCESS_USER_IDS; });

describe("V1 — matrice local / Stripe (la décision vient de l'état relu chez Stripe)", () => {
  it("1. local canceled / Stripe active : l'abonnement est rétabli (client payant faussement bloqué), forfait relu chez Stripe", async () => {
    const { workspaceId } = await linked({ status: "canceled", canceledAt: new Date(Date.now() - DAY) });
    fake.set("sub_1", { status: "active", current_period_end: inDays(20) });
    expect(entitlement(await sub(workspaceId)).active).toBe(false);
    expect(await reconcileDueSubscriptions({}, fake)).toMatchObject({ checked: 1, updated: 1, failed: 0 });
    const s = await sub(workspaceId);
    expect(s).toMatchObject({ status: "active", plan: "growth", canceledAt: null });
    expect(entitlement(s)).toMatchObject({ active: true, state: "paid" });
  });

  it("2. local expired / Stripe active : rétabli de la même façon", async () => {
    const { workspaceId } = await linked({ status: "expired", canceledAt: null });
    fake.set("sub_1", { status: "active" });
    expect((await reconcileDueSubscriptions({}, fake)).updated).toBe(1);
    expect(entitlement(await sub(workspaceId)).active).toBe(true);
  });

  it("3. local active / Stripe canceled : fermé", async () => {
    const { workspaceId } = await linked({ status: "active" });
    fake.set("sub_1", { status: "canceled" });
    expect((await reconcileDueSubscriptions({}, fake)).updated).toBe(1);
    expect(entitlement(await sub(workspaceId)).active).toBe(false);
  });

  it("4. local past_due / Stripe active : repasse en actif", async () => {
    const { workspaceId } = await linked({ status: "past_due" });
    fake.set("sub_1", { status: "active" });
    expect((await reconcileDueSubscriptions({}, fake)).updated).toBe(1);
    expect(entitlement(await sub(workspaceId))).toMatchObject({ active: true, state: "paid" });
  });

  it("6. abonnement supprimé chez Stripe (introuvable) : localement terminé, même s'il était actif", async () => {
    const { workspaceId } = await linked({ status: "active" });
    expect((await reconcileDueSubscriptions({}, fake)).updated).toBe(1);
    expect(await sub(workspaceId)).toMatchObject({ status: "canceled" });
  });

  it("7. abonnement sans identifiant Stripe (essai, jamais souscrit) : jamais candidat, jamais lu", async () => {
    const w = await makeWorkspace();
    expect(await reconcileSubscription(w.workspaceId, fake)).toBeNull();
    expect(await reconcileDueSubscriptions({}, fake)).toMatchObject({ checked: 0 });
    expect(fake.calls).toEqual([]);
  });

  it("8. propriétaire exempté : la ligne d'abonnement suit Stripe, mais ses droits (Pro, accès gratuit) ne changent pas", async () => {
    const { workspaceId, userId } = await linked({ status: "canceled", canceledAt: new Date() });
    process.env.FREE_ACCESS_USER_IDS = userId;
    fake.set("sub_1", { status: "canceled" });
    await reconcileSubscription(workspaceId, fake);
    const e = await entitlementForWorkspace(workspaceId, await sub(workspaceId));
    expect(e).toMatchObject({ active: true, state: "exempt" });
    expect(e.plan.id).toBe("pro");
    fake.set("sub_1", { status: "active" });
    await reconcileSubscription(workspaceId, fake);
    expect(await entitlementForWorkspace(workspaceId, await sub(workspaceId))).toMatchObject({ active: true, state: "exempt" });
  });

  it("pas de droit artificiel : un abonnement terminé chez Stripe reste fermé, un paiement incomplet n'ouvre aucun accès", async () => {
    const a = await linked({ status: "canceled", canceledAt: new Date(Date.now() - DAY) });
    fake.set("sub_1", { status: "canceled" });
    await reconcileSubscription(a.workspaceId, fake);
    expect(entitlement(await sub(a.workspaceId)).active).toBe(false);
    fake.set("sub_1", { status: "incomplete" });
    await reconcileSubscription(a.workspaceId, fake);
    expect(entitlement(await sub(a.workspaceId)).active).toBe(false);
  });

  it("Stripe indisponible : un abonnement localement terminé n'est ni rétabli ni modifié", async () => {
    const { workspaceId } = await linked({ status: "canceled", canceledAt: new Date(Date.now() - DAY) });
    fake.set("sub_1", { status: "active" }); fake.unavailable = true;
    expect(await reconcileDueSubscriptions({}, fake)).toMatchObject({ checked: 1, updated: 0, failed: 1 });
    expect((await sub(workspaceId)).status).toBe("canceled");
  });
});

describe("V1 — sélection des candidats", () => {
  it("un abonnement terminé est relu une fois par jour pendant 90 jours, jamais s'il vient d'être synchronisé, plus après 90 jours", async () => {
    const recent = await linked({ status: "canceled", canceledAt: new Date(Date.now() - DAY), stripeSyncedAt: new Date(Date.now() - 3_600_000) });
    const old = await linked({ status: "canceled", canceledAt: new Date(Date.now() - 100 * DAY), stripeSyncedAt: stale(), stripeSubscriptionId: "sub_old", stripeCustomerId: "cus_old" });
    const due = await linked({ status: "canceled", canceledAt: new Date(Date.now() - 10 * DAY), stripeSyncedAt: stale(), stripeSubscriptionId: "sub_due", stripeCustomerId: "cus_due" });
    fake.set("sub_1", { status: "active", customer: "cus_1" }); fake.set("sub_old", { status: "active", customer: "cus_old" }); fake.set("sub_due", { status: "active", customer: "cus_due" });
    expect(await reconcileDueSubscriptions({}, fake)).toMatchObject({ checked: 1, updated: 1 });
    expect((await sub(due.workspaceId)).status).toBe("active");
    expect((await sub(recent.workspaceId)).status).toBe("canceled"); // synchronisé il y a moins de 24 h
    expect((await sub(old.workspaceId)).status).toBe("canceled"); // terminé depuis plus de 90 jours
  });

  it("un abonnement dont la période est échue est candidat même s'il a été synchronisé récemment", async () => {
    const { workspaceId } = await linked({ status: "active", currentPeriodEnd: new Date(Date.now() - DAY), stripeSyncedAt: new Date(Date.now() - 3_600_000) });
    fake.set("sub_1", { status: "active", current_period_end: inDays(29) });
    expect((await reconcileDueSubscriptions({}, fake)).updated).toBe(1);
    expect((await sub(workspaceId)).currentPeriodEnd!.getTime()).toBeGreaterThan(Date.now() + 25 * DAY);
  });

  it("jamais synchronisés d'abord, puis les plus anciens : même ordre sous SQLite et PostgreSQL (qui trient les NULL différemment)", async () => {
    const never = await linked({ stripeSyncedAt: null, stripeSubscriptionId: "sub_never", stripeCustomerId: "cus_never" });
    const older = await linked({ stripeSyncedAt: new Date(Date.now() - 5 * DAY), stripeSubscriptionId: "sub_older", stripeCustomerId: "cus_older" });
    const newer = await linked({ stripeSyncedAt: new Date(Date.now() - 2 * DAY), stripeSubscriptionId: "sub_newer", stripeCustomerId: "cus_newer" });
    for (const id of ["never", "older", "newer"]) fake.set(`sub_${id}`, { status: "active", customer: `cus_${id}` });
    const r = await reconcileDueSubscriptions({ limit: 2 }, fake);
    expect(r.checked).toBe(2);
    expect(fake.calls.map((c) => c.replace("getSubscription:", ""))).toEqual(["sub_never", "sub_older"]);
    expect((await sub(never.workspaceId)).stripeSyncedAt).not.toBeNull();
    expect((await sub(older.workspaceId)).stripeSyncedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect((await sub(newer.workspaceId)).stripeSyncedAt!.getTime()).toBeLessThan(Date.now() - DAY); // pas traité cette fois
  });
});
