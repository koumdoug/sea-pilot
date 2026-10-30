import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { reconcileDueSubscriptions, setStripeGateway } from "@/lib/billing";
import { entitlement } from "@/lib/plans";
import { POST as cron } from "@/app/api/cron/followups/route";
import { fake } from "./stripe-fake";
import { makeWorkspace, resetDb } from "./helpers";

// V6 — réconciliation sous budget de temps : rien n'est ignoré sans le dire, une panne de Stripe ne change aucun droit, la reprise est automatique.

const DAY = 86_400_000;
const sub = (workspaceId: string) => db.subscription.findUniqueOrThrow({ where: { workspaceId } });
const SECRET = "cron-secret-for-tests-only";

/** `n` abonnements payés jamais synchronisés (donc candidats), Stripe : actif. */
async function candidates(n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const w = await makeWorkspace();
    await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { plan: "growth", status: "active", stripeCustomerId: `cus_${i}`, stripeSubscriptionId: `sub_${i}`, currentPeriodEnd: new Date(Date.now() + 20 * DAY), stripeSyncedAt: null } });
    fake.set(`sub_${i}`, { status: "active", customer: `cus_${i}` });
    ids.push(w.workspaceId);
  }
  return ids;
}
const post = (q = "") => cron(new Request(`http://x/api/cron/followups?sync=0${q}`, { method: "POST", headers: { authorization: `Bearer ${SECRET}` } }));

beforeEach(resetDb);
afterEach(() => { delete process.env.CRON_SECRET; delete process.env.STRIPE_SECRET_KEY; setStripeGateway(null); });

describe("V6 — reconcileDueSubscriptions : budget, disjoncteur, reprise, résultat honnête", () => {
  it("budget de temps épuisé : les abonnements restants sont DIFFÉRÉS (non traités, non modifiés), le passage n'est pas complet, le suivant reprend", async () => {
    const ids = await candidates(6); fake.lagMs = 80;
    const r = await reconcileDueSubscriptions({ budgetMs: 300, itemReserveMs: 0 }, fake);
    expect(r.stoppedBy).toBe("budget");
    expect(r.complete).toBe(false);
    expect(r.checked).toBeGreaterThan(0);
    expect(r.deferred).toBeGreaterThan(0);
    expect(r.checked + r.deferred).toBe(6); // rien n'est perdu : chaque candidat est traité ou explicitement différé
    expect((await Promise.all(ids.map(sub))).filter((s) => s.stripeSyncedAt === null)).toHaveLength(r.deferred); // les différés n'ont pas été touchés
    fake.lagMs = 0;
    const next = await reconcileDueSubscriptions({ budgetMs: 60_000, itemReserveMs: 0 }, fake); // reprise au passage suivant
    expect(next).toMatchObject({ complete: true, deferred: 0, remaining: 0, stoppedBy: null });
    expect((await Promise.all(ids.map(sub))).every((s) => s.stripeSyncedAt !== null)).toBe(true);
  });

  it("Stripe indisponible : le disjoncteur arrête le passage après 3 échecs consécutifs (pas 50 délais d'attente), aucun droit n'est modifié, reprise automatique ensuite", async () => {
    const ids = await candidates(5); fake.unavailable = true;
    const before = await Promise.all(ids.map(sub));
    const r = await reconcileDueSubscriptions({ itemReserveMs: 0 }, fake);
    expect(r).toMatchObject({ checked: 3, failed: 3, deferred: 2, stoppedBy: "stripe_unavailable", complete: false });
    expect(fake.calls.filter((c) => c.startsWith("getSubscription"))).toHaveLength(3);
    const after = await Promise.all(ids.map(sub));
    expect(after.map((s) => [s.status, s.plan, s.stripeSyncedAt])).toEqual(before.map((s) => [s.status, s.plan, s.stripeSyncedAt])); // aucun droit retiré ni accordé
    expect(after.every((s) => entitlement(s).active)).toBe(true);
    fake.unavailable = false; // Stripe redevient disponible
    expect(await reconcileDueSubscriptions({ itemReserveMs: 0 }, fake)).toMatchObject({ complete: true, checked: 5, failed: 0 });
  });

  it("limite de travail : au-delà de `limit`, le reste est signalé (remaining) et le passage n'est pas complet", async () => {
    await candidates(3);
    const r = await reconcileDueSubscriptions({ limit: 2, itemReserveMs: 0 }, fake);
    expect(r).toMatchObject({ checked: 2, remaining: 1, complete: false, stoppedBy: null });
    expect(await reconcileDueSubscriptions({ limit: 2, itemReserveMs: 0 }, fake)).toMatchObject({ checked: 1, remaining: 0, complete: true });
  });

  it("un abonnement dont la synchronisation est déjà en cours ailleurs est compté « occupé » (passage incomplet), puis repris", async () => {
    const [workspaceId] = await candidates(1);
    await db.subscription.update({ where: { workspaceId }, data: { stripeSyncLeaseId: "autre_passage", stripeSyncLeaseUntil: new Date(Date.now() + 60_000) } });
    const r = await reconcileDueSubscriptions({ itemReserveMs: 0 }, fake);
    expect(r).toMatchObject({ busy: 1, complete: false });
    await db.subscription.update({ where: { workspaceId }, data: { stripeSyncLeaseUntil: new Date(Date.now() - 1) } });
    expect(await reconcileDueSubscriptions({ itemReserveMs: 0 }, fake)).toMatchObject({ checked: 1, complete: true });
  });

  it("une erreur sur un abonnement n'empêche pas les suivants (sous le seuil du disjoncteur) mais rend le passage incomplet", async () => {
    await candidates(3); fake.failNext("getSubscription");
    const r = await reconcileDueSubscriptions({ itemReserveMs: 0 }, fake);
    expect(r).toMatchObject({ checked: 3, failed: 1, complete: false, stoppedBy: null });
  });
});

describe("V6 — route cron : authentification, configuration, budget, concurrence", () => {
  it("authentification inchangée (503 sans secret, 401 sans ou avec mauvais secret) ; Stripe non configuré : réconciliation ignorée EXPLICITEMENT", async () => {
    expect((await cron(new Request("http://x/api/cron/followups", { method: "POST" }))).status).toBe(503);
    process.env.CRON_SECRET = SECRET;
    expect((await cron(new Request("http://x/api/cron/followups", { method: "POST" }))).status).toBe(401);
    expect((await cron(new Request("http://x/api/cron/followups", { method: "POST", headers: { authorization: "Bearer mauvais" } }))).status).toBe(401);
    const ok = await (await post()).json();
    expect(ok.billing).toEqual({ skipped: true, reason: "Stripe non configuré" });
    expect((await (await post("&reconcile=0")).json()).billing.reason).toMatch(/paramètre/);
  });

  it("avec Stripe configuré : le compte rendu de réconciliation est dans la réponse ; Stripe indisponible : 200 mais `complete: false`, droits intacts", async () => {
    process.env.CRON_SECRET = SECRET; process.env.STRIPE_SECRET_KEY = "sk_test_placeholder"; setStripeGateway(fake);
    const ids = await candidates(2);
    const ok = await (await post()).json();
    expect(ok.billing).toMatchObject({ checked: 2, complete: true });
    expect(ok.complete).toBe(true);
    await db.subscription.updateMany({ where: { workspaceId: { in: ids } }, data: { stripeSyncedAt: new Date(Date.now() - 3 * DAY) } });
    fake.unavailable = true;
    const down = await (await post()).json();
    expect(down.billing).toMatchObject({ failed: 2, complete: false });
    expect(down.complete).toBe(false);
    expect((await Promise.all(ids.map(sub))).every((s) => entitlement(s).active)).toBe(true);
  });

  it("deux passages de cron simultanés : jamais deux lectures en même temps du même abonnement", async () => {
    process.env.CRON_SECRET = SECRET; process.env.STRIPE_SECRET_KEY = "sk_test_placeholder"; setStripeGateway(fake);
    await candidates(3); fake.lagMs = 25;
    const [a, b] = await Promise.all([post(), post()]);
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    expect(fake.maxConcurrentReads).toBe(1);
  });
});
