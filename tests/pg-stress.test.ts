import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createCheckoutSession, reconcileSubscription } from "@/lib/billing";
import { StripeEventLeaseLostError, claimStripeEvent, completeStripeEvent, failStripeEvent } from "@/lib/stripe-events";
import { QuotaError, createWithinLimit } from "@/lib/quota";
import { PLANS } from "@/lib/plans";
import { fake } from "./stripe-fake";
import { makeWorkspace, resetDb } from "./helpers";

// Charge sur PostgreSQL : vraies connexions parallèles (le pool de Prisma en ouvre plusieurs), donc vraie contention sur les verrous de ligne et les contraintes d'unicité.
// SQLite sérialise toutes les requêtes : ces tests y sont ignorés (ils ne prouveraient rien). Lancer avec `npm run test:pg` (docs/validation-postgresql-stripe.md).
const isPg = /^postgres(ql)?:\/\//.test(process.env.DATABASE_URL ?? "");

describe.skipIf(!isPg)("PostgreSQL — contention réelle sur les mécanismes de verrouillage", () => {
  beforeEach(resetDb);

  it("registre d'événements : 60 prises en charge simultanées du même identifiant → exactement une", async () => {
    const r = await Promise.all(Array.from({ length: 60 }, () => claimStripeEvent("evt_pg_stress", "invoice.paid")));
    expect(r.filter((x) => x.kind === "claimed")).toHaveLength(1);
    expect(r.filter((x) => x.kind === "duplicate")).toHaveLength(59);
    expect(await db.stripeEvent.count({ where: { id: "evt_pg_stress" } })).toBe(1);
    const winner = r.find((x) => x.kind === "claimed");
    expect(winner && winner.kind === "claimed" && winner.leaseToken.length > 0).toBe(true);
    expect((await db.stripeEvent.findUniqueOrThrow({ where: { id: "evt_pg_stress" } })).leaseToken).toBe(winner!.kind === "claimed" ? winner!.leaseToken : "");
  });

  it("registre d'événements, fencing : 40 reprises simultanées d'un bail expiré → un seul nouveau propriétaire ; l'ancien ne peut ni finaliser ni faire échouer", async () => {
    const a = await claimStripeEvent("evt_pg_fence", "invoice.paid");
    if (a.kind !== "claimed") throw new Error("prise en charge attendue");
    await db.stripeEvent.update({ where: { id: "evt_pg_fence" }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    const r = await Promise.all(Array.from({ length: 40 }, () => claimStripeEvent("evt_pg_fence", "invoice.paid")));
    const winners = r.filter((x) => x.kind === "claimed");
    expect(winners).toHaveLength(1);
    expect(r.filter((x) => x.kind === "duplicate")).toHaveLength(39);
    const b = winners[0] as { kind: "claimed"; leaseToken: string };
    expect(b.leaseToken).not.toBe(a.leaseToken);
    expect(await db.stripeEvent.findUniqueOrThrow({ where: { id: "evt_pg_fence" } })).toMatchObject({ status: "processing", attempts: 2, leaseToken: b.leaseToken });
    // A et B tentent d'écrire en même temps : seul B réussit, A est refusé, l'état final est celui de B.
    const [ra, rb, rf] = await Promise.allSettled([
      completeStripeEvent("evt_pg_fence", a.leaseToken, { outcome: "ignored", workspaceId: null, note: "A" }),
      completeStripeEvent("evt_pg_fence", b.leaseToken, { outcome: "handled", workspaceId: null, note: "B" }),
      failStripeEvent("evt_pg_fence", a.leaseToken, "A"),
    ]);
    expect(ra.status).toBe("rejected");
    expect((ra as PromiseRejectedResult).reason).toBeInstanceOf(StripeEventLeaseLostError);
    expect(rb.status).toBe("fulfilled");
    expect(rf.status === "fulfilled" && rf.value).toBe(false);
    expect(await db.stripeEvent.findUniqueOrThrow({ where: { id: "evt_pg_fence" } })).toMatchObject({ status: "processed", outcome: "handled", note: "B", leaseToken: null });
  });

  it("quota : 60 créations simultanées sous un plafond de 20 clés → exactement 20 (verrou de ligne PostgreSQL de l'espace)", async () => {
    const { workspaceId } = await makeWorkspace();
    let n = 0;
    const attempt = () => createWithinLimit({ workspaceId, plan: PLANS.pro, key: "apiKeys", message: "plafond", create: (tx) => tx.apiKey.create({ data: { workspaceId, name: "k", prefix: "sp_stress__", keyHash: `h_stress_${++n}_${Math.random()}` } }) });
    const r = await Promise.allSettled(Array.from({ length: 60 }, attempt));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(20);
    expect(r.filter((x) => x.status === "rejected").every((x) => (x as PromiseRejectedResult).reason instanceof QuotaError)).toBe(true);
    expect(await db.apiKey.count({ where: { workspaceId, revokedAt: null } })).toBe(PLANS.pro.limits.apiKeys);
  });

  it("quota des intégrations et des séquences : les plafonds tiennent sous 40 créations parallèles", async () => {
    const { workspaceId } = await makeWorkspace();
    const seq = () => createWithinLimit({ workspaceId, plan: PLANS.growth, key: "sequences", message: "plafond", create: (tx) => tx.followUpSequence.create({ data: { workspaceId, name: "S", steps: [] } }) });
    const r = await Promise.allSettled(Array.from({ length: 40 }, seq));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(PLANS.growth.limits.sequences);
    expect(await db.followUpSequence.count({ where: { workspaceId } })).toBe(PLANS.growth.limits.sequences);
  });

  it("réservation de paiement : 30 demandes Checkout simultanées → une seule session créée chez Stripe, un seul client", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_placeholder"; process.env.STRIPE_WEBHOOK_SECRET = "whsec_placeholder";
    try {
      const { workspaceId } = await makeWorkspace(); fake.lagMs = 10;
      const r = await Promise.allSettled(Array.from({ length: 30 }, () => createCheckoutSession({ workspaceId, plan: "growth", email: "a@b.c" }, fake)));
      expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
      expect(fake.sessionsCreated).toBe(1);
      expect(fake.customersCreated).toBe(1);
    } finally { delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_WEBHOOK_SECRET; }
  });

  it("bail de synchronisation : 25 synchronisations simultanées du même abonnement → jamais deux lectures Stripe en même temps, état final cohérent", async () => {
    const { workspaceId } = await makeWorkspace();
    await db.subscription.update({ where: { workspaceId }, data: { plan: "growth", status: "active", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1", currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000) } });
    fake.set("sub_1", { status: "past_due" }); fake.lagMs = 10;
    const r = await Promise.all(Array.from({ length: 25 }, () => reconcileSubscription(workspaceId, fake, { waitMs: 30_000 })));
    expect(r.filter((x) => x?.outcome === "handled")).toHaveLength(1);
    expect(fake.maxConcurrentReads).toBe(1);
    expect((await db.subscription.findUniqueOrThrow({ where: { workspaceId } })).status).toBe("past_due");
  });

  it("deux workspaces indépendants ne se bloquent pas : le verrou est par espace, pas global", async () => {
    const a = await makeWorkspace(), b = await makeWorkspace();
    const t0 = Date.now();
    const slow = (workspaceId: string) => createWithinLimit({ workspaceId, plan: PLANS.pro, key: "apiKeys", message: "x", create: async (tx) => { await new Promise((r) => setTimeout(r, 400)); return tx.apiKey.create({ data: { workspaceId, name: "k", prefix: "sp_stress__", keyHash: `h_${workspaceId}_${Math.random()}` } }); } });
    await Promise.all([slow(a.workspaceId), slow(b.workspaceId)]);
    expect(Date.now() - t0).toBeLessThan(750); // en parallèle (≈ 400 ms), pas l'un après l'autre (≈ 800 ms)
  });
});
