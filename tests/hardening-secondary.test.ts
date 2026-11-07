import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state: { user: { id: string; email: string; name: string } | null } = { user: null };
vi.mock("@/lib/auth", async (orig) => ({ ...(await orig<typeof import("@/lib/auth")>()), getSessionUser: async () => state.user }));

import { db } from "@/lib/db";
import { billingNeedsReview, customerIdempotencyKey, handleStripeEvent, liveStripeGateway } from "@/lib/billing";
import { FAILED_EVENT_RETENTION_MS, PROCESSED_EVENT_RETENTION_MS, claimStripeEvent, purgeStripeEvents } from "@/lib/stripe-events";
import { PLANS, planAllowsApi } from "@/lib/plans";
import { PLAN_IDS } from "@/lib/constants";
import { makeOAuthState, saveConnection } from "@/lib/integrations/service";
import { PROVIDERS } from "@/lib/integrations/providers";
import { IntegrationError, IntegrationLimitError } from "@/lib/integrations/types";
import { API_PLANS, summarizeApiKeys, type ApiKeyRow } from "@/lib/api-key-report";
import { GET as oauthCallback } from "@/app/api/integrations/[provider]/callback/route";
import { fake } from "./stripe-fake";
import { makeWorkspace, resetDb } from "./helpers";

// V9 purge et alerte de revue, V10 clé d'idempotence client, V11 refus de limite OAuth, présentation des forfaits, outil de mesure des clés API.

const DAY = 86_400_000;
beforeEach(resetDb);
afterEach(() => { vi.restoreAllMocks(); delete process.env.STRIPE_SECRET_KEY; state.user = null; });

describe("V9 — registre des événements : purge sans jamais toucher à l'idempotence", () => {
  const row = (id: string, status: string, ageDays: number, extra: Record<string, unknown> = {}) =>
    db.stripeEvent.create({ data: { id, type: "invoice.paid", status, processedAt: status === "processed" ? new Date(Date.now() - ageDays * DAY) : null, ...extra } }).then(() => db.stripeEvent.update({ where: { id }, data: { updatedAt: new Date(Date.now() - ageDays * DAY) } }));

  it("purge les événements traités depuis plus de 90 jours et les échecs de plus de 180 jours ; conserve tout le reste", async () => {
    await row("evt_old_processed", "processed", 100);
    await row("evt_recent_processed", "processed", 10);
    await row("evt_old_failed", "failed", 200);
    await row("evt_recent_failed", "failed", 10);
    await row("evt_old_processing", "processing", 365, { lockedUntil: new Date(Date.now() - DAY) }); // bail expiré depuis longtemps : à reprendre, jamais purgé
    expect(await purgeStripeEvents()).toEqual({ processed: 1, failed: 1 });
    const left = (await db.stripeEvent.findMany({ select: { id: true } })).map((e) => e.id).sort();
    expect(left).toEqual(["evt_old_processing", "evt_recent_failed", "evt_recent_processed"]);
    expect([PROCESSED_EVENT_RETENTION_MS, FAILED_EVENT_RETENTION_MS]).toEqual([90 * DAY, 180 * DAY]);
  });

  it("l'idempotence est préservée : un événement traité récemment reste un doublon après la purge ; un événement en attente de reprise est toujours repris", async () => {
    await row("evt_recent_processed", "processed", 10);
    await row("evt_old_processing", "processing", 365, { lockedUntil: new Date(Date.now() - DAY) });
    await purgeStripeEvents();
    expect(await claimStripeEvent("evt_recent_processed", "invoice.paid")).toEqual({ kind: "duplicate", state: "processed" });
    const taken = await claimStripeEvent("evt_old_processing", "invoice.paid");
    expect(taken.kind).toBe("claimed");
    expect(taken.kind === "claimed" && typeof taken.leaseToken === "string" && taken.leaseToken.length > 0).toBe(true);
  });

  it("alerte de revue manuelle : ouverte par un second abonnement détecté (audit) ou un événement needs_review, 30 jours, jamais pour un autre espace", async () => {
    const a = await makeWorkspace(), b = await makeWorkspace();
    expect(await billingNeedsReview(a.workspaceId)).toBe(false);
    await db.auditLog.create({ data: { workspaceId: a.workspaceId, action: "billing.duplicate_subscription" } });
    expect(await billingNeedsReview(a.workspaceId)).toBe(true);
    expect(await billingNeedsReview(b.workspaceId)).toBe(false);
    await db.auditLog.deleteMany();
    await db.stripeEvent.create({ data: { id: "evt_nr", type: "customer.subscription.updated", status: "processed", outcome: "needs_review", workspaceId: b.workspaceId, processedAt: new Date() } });
    expect(await billingNeedsReview(b.workspaceId)).toBe(true);
    expect(await billingNeedsReview(b.workspaceId, new Date(Date.now() + 31 * DAY))).toBe(false); // l'alerte s'éteint après 30 jours
  });

  it("un événement traité en `needs_review` par le webhook ouvre l'alerte (chaîne complète)", async () => {
    const { workspaceId } = await makeWorkspace();
    await db.subscription.update({ where: { workspaceId }, data: { stripeCustomerId: "cus_1" } });
    fake.set("sub_x", { status: "active", customer: "cus_autre" }); // client Stripe différent de celui de l'espace
    await handleStripeEvent({ id: "evt_review", type: "customer.subscription.updated", data: { object: { id: "sub_x", customer: "cus_autre", metadata: { workspaceId } } } }, fake);
    expect(await billingNeedsReview(workspaceId)).toBe(true);
  });
});

describe("V10 — clé d'idempotence de la création d'un client Stripe", () => {
  it("stable pour les mêmes paramètres (rejeu = même client), distincte si l'adresse change (pas d'erreur 400 de paramètres différents), sans adresse en clair", () => {
    const k = customerIdempotencyKey("ws_1", "Marie@Example.com");
    expect(customerIdempotencyKey("ws_1", " marie@example.com ")).toBe(k); // normalisation : même client
    expect(customerIdempotencyKey("ws_1", "autre@example.com")).not.toBe(k);
    expect(customerIdempotencyKey("ws_2", "marie@example.com")).not.toBe(k);
    expect(k).not.toMatch(/marie|example/i);
  });

  it("l'adaptateur réel envoie cette clé dans l'en-tête Idempotency-Key (appel simulé, aucun accès réseau)", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "cus_x" }), { status: 200 }));
    await liveStripeGateway.createCustomer({ email: "marie@example.com", workspaceId: "ws_1" });
    const init = f.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["idempotency-key"]).toBe(customerIdempotencyKey("ws_1", "marie@example.com"));
    expect(String(f.mock.calls[0][0])).toBe("https://api.stripe.com/v1/customers");
  });
});

describe("V11 — retour OAuth au-delà de la limite d'intégrations", () => {
  const callback = async (workspaceId: string, userId: string, provider: string) => {
    const state = makeOAuthState(workspaceId, userId, provider);
    return oauthCallback(new Request(`http://x/api/integrations/${provider}/callback?code=abc&state=${encodeURIComponent(state)}`), { params: Promise.resolve({ provider }) });
  };

  it("limite atteinte : message dédié (error=limit), connexion NON enregistrée, aucun contrôle assoupli ; dans la limite : connecté", async () => {
    const w = await makeWorkspace();
    state.user = { id: w.userId, email: "x@test.local", name: "U" };
    vi.spyOn(PROVIDERS.google_ads, "exchangeCode").mockResolvedValue({ credentials: { accessToken: "t" } });
    vi.spyOn(PROVIDERS.meta_ads, "exchangeCode").mockResolvedValue({ credentials: { accessToken: "t" } });
    await saveConnection(w.workspaceId, "google_analytics", { credentials: { accessToken: "t" } });
    await saveConnection(w.workspaceId, "tiktok_ads", { credentials: { accessToken: "t" } }); // Starter : 2 sur 2
    const refused = await callback(w.workspaceId, w.userId, "meta_ads");
    expect(refused.status).toBe(302);
    expect(refused.headers.get("location")).toContain("error=limit");
    expect(await db.integration.count({ where: { workspaceId: w.workspaceId, provider: "meta_ads" } })).toBe(0);
    await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { plan: "growth" } });
    expect((await callback(w.workspaceId, w.userId, "meta_ads")).headers.get("location")).toContain("connected=meta_ads");
  });

  it("le refus de limite est une erreur dédiée qui reste une IntegrationError (les appelants existants ne changent pas)", async () => {
    const w = await makeWorkspace();
    await saveConnection(w.workspaceId, "google_analytics", { credentials: { accessToken: "t" } });
    await saveConnection(w.workspaceId, "tiktok_ads", { credentials: { accessToken: "t" } });
    const err = await saveConnection(w.workspaceId, "meta_ads", { credentials: { accessToken: "t" } }).catch((e) => e);
    expect(err).toBeInstanceOf(IntegrationLimitError);
    expect(err).toBeInstanceOf(IntegrationError);
  });
});

describe("Présentation commerciale — les limites affichées sont les limites appliquées", () => {
  it("chaque limite chiffrée de séquences et d'intégrations est annoncée comme telle ; plus de « Toutes les intégrations » ambigu", () => {
    for (const id of PLAN_IDS) {
      const p = PLANS[id], text = p.features.join(" | ");
      expect(text, id).not.toMatch(/toutes les intégrations/i);
      if (p.limits.sequences > 0 && p.limits.sequences !== -1) expect(text, id).toContain(`${p.limits.sequences} séquence`);
      if (p.limits.integrations > 0 && p.limits.integrations !== -1) expect(text, id).toContain(`${p.limits.integrations} intégration`);
    }
    expect(PLANS.starter.features).toEqual(expect.arrayContaining(["1 séquence", "2 intégrations"]));
    expect(PLANS.growth.features).toEqual(expect.arrayContaining(["10 séquences", "5 intégrations", "Séquences de relance"]));
    expect(PLANS.pro.features).toEqual(expect.arrayContaining(["Séquences illimitées", "Accès API"]));
  });

  it("droits conservés pendant cette mission : API Pro seulement, 20 clés, séquences 1 / 10 / illimitées, intégrations 2 / 5 / illimitées", () => {
    expect(PLAN_IDS.map((id) => planAllowsApi(PLANS[id]))).toEqual([false, false, true]);
    expect(PLAN_IDS.map((id) => PLANS[id].limits.apiKeys)).toEqual([0, 0, 20]);
    expect(PLAN_IDS.map((id) => PLANS[id].limits.sequences)).toEqual([1, 10, -1]);
    expect(PLAN_IDS.map((id) => PLANS[id].limits.integrations)).toEqual([2, 5, -1]);
  });
});

describe("Mesure des clés API existantes — lecture seule, comptages uniquement", () => {
  const D = (n: number) => new Date(Date.now() - n * DAY);
  const rows: ApiKeyRow[] = [
    { workspaceId: "a", plan: "starter", exempt: false, revokedAt: null, lastUsedAt: D(2) },
    { workspaceId: "a", plan: "starter", exempt: false, revokedAt: D(5), lastUsedAt: D(40) },
    { workspaceId: "b", plan: "growth", exempt: false, revokedAt: null, lastUsedAt: null },
    { workspaceId: "c", plan: "growth", exempt: false, revokedAt: null, lastUsedAt: D(100) },
    { workspaceId: "d", plan: "pro", exempt: false, revokedAt: null, lastUsedAt: D(1) },
    { workspaceId: "e", plan: "starter", exempt: true, revokedAt: null, lastUsedAt: D(1) },
    { workspaceId: "f", plan: null, exempt: false, revokedAt: null, lastUsedAt: D(3) },
  ];

  it("comptes par forfait, clés actives, utilisation récente, clients concernés ; le propriétaire exempté et Pro ne sont jamais « concernés »", () => {
    const r = summarizeApiKeys(rows, { recentDays: 30 });
    expect(r.byPlan.starter).toMatchObject({ keys: 2, activeKeys: 1, recentlyUsedKeys: 1, workspaces: 1, workspacesWithActiveKeys: 1, workspacesWithRecentUse: 1 });
    expect(r.byPlan.growth).toMatchObject({ keys: 2, activeKeys: 2, recentlyUsedKeys: 0, workspaces: 2, workspacesWithActiveKeys: 2, workspacesWithRecentUse: 0 });
    expect(r.byPlan.pro).toMatchObject({ keys: 1, activeKeys: 1, recentlyUsedKeys: 1 });
    expect(r.byPlan.sans_abonnement.keys).toBe(1);
    expect(r.exempt).toMatchObject({ keys: 1, activeKeys: 1 });
    expect(Math.abs(new Date(r.byPlan.starter.lastUsedAt!).getTime() - D(2).getTime())).toBeLessThan(5_000); // dernière utilisation connue
    expect(r.affected).toEqual({ workspacesWithActiveKeys: 4, workspacesWithRecentUse: 2, activeKeys: 4, recentlyUsedKeys: 2 }); // a, b, c, f (sans abonnement) ; récents : a, f
  });

  it("la sortie ne contient aucun identifiant d'espace, de clé, préfixe, empreinte ni adresse", () => {
    const text = JSON.stringify(summarizeApiKeys(rows));
    for (const id of ["\"a\"", "\"b\"", "workspaceId", "prefix", "keyHash", "@"]) expect(text).not.toContain(id);
  });

  it("l'ensemble des forfaits « avec API » de l'outil est aligné sur les droits réels (plans.ts)", () => {
    expect([...API_PLANS].sort()).toEqual(PLAN_IDS.filter((id) => planAllowsApi(PLANS[id])).sort());
  });

  it("le chargement depuis la base ne modifie rien (comptes avant/après identiques)", async () => {
    const w = await makeWorkspace();
    await db.apiKey.create({ data: { workspaceId: w.workspaceId, name: "k", prefix: "sp_xxxxxxx", keyHash: "h_" + Math.random() } });
    const before = JSON.stringify(await db.apiKey.findMany());
    const keys = await db.apiKey.findMany({ select: { workspaceId: true, revokedAt: true, lastUsedAt: true } });
    expect(summarizeApiKeys(keys.map((k) => ({ ...k, plan: "starter", exempt: false }))).affected.activeKeys).toBe(1);
    expect(JSON.stringify(await db.apiKey.findMany())).toBe(before);
  });
});
