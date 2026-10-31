import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { PLANS } from "@/lib/plans";
import { integrationSyncAllowance, listSyncableIntegrations, saveConnection, syncIntegration } from "@/lib/integrations/service";
import { IntegrationError } from "@/lib/integrations/types";
import { POST as cron } from "@/app/api/cron/followups/route";
import { makeWorkspace, resetDb } from "./helpers";

// V7 — la synchronisation des intégrations est un droit du forfait, distinct de la CONNEXION (conservée), de la FONCTIONNALITÉ et des DONNÉES (consultables).

const DAY = 86_400_000;
const SECRET = "cron-secret-for-tests-only";
const insights = { data: [{ campaign_id: "111", campaign_name: "Soldes", date_start: "2026-06-01", spend: "12.50", impressions: "1000", clicks: "40" }] };
const AD = ["meta_ads", "google_ads", "tiktok_ads"] as const;

/** Espace avec des intégrations publicitaires connectées (créées dans l'ordre : la plus ancienne en premier). */
async function workspaceWith(plan: "starter" | "growth" | "pro", providers: readonly string[], over: Record<string, unknown> = {}) {
  const w = await makeWorkspace();
  await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { plan: "pro" } }); // Pro et abonnement actif (essai) le temps de connecter : connecter exige un abonnement actif ; le forfait cible et l'état inactif testés s'appliquent ensuite aux connexions déjà enregistrées
  for (const p of providers) { await saveConnection(w.workspaceId, p, { credentials: { accessToken: "tok" }, config: { adAccountId: `act_${p}`, customerId: `c_${p}`, advertiserId: `a_${p}` } }); await new Promise((r) => setTimeout(r, 5)); }
  await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { plan, ...over } });
  return w;
}
const post = () => cron(new Request("http://x/api/cron/followups?reconcile=0", { method: "POST", headers: { authorization: `Bearer ${SECRET}` } }));

beforeEach(() => {
  process.env.META_APP_ID = "app"; process.env.META_APP_SECRET = "sec"; process.env.GOOGLE_CLIENT_ID = "g"; process.env.GOOGLE_CLIENT_SECRET = "s"; process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "d"; process.env.TIKTOK_APP_ID = "t"; process.env.TIKTOK_APP_SECRET = "s";
  process.env.CRON_SECRET = SECRET;
  return resetDb();
});
afterEach(() => { vi.restoreAllMocks(); for (const k of ["META_APP_ID", "META_APP_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_ADS_DEVELOPER_TOKEN", "TIKTOK_APP_ID", "TIKTOK_APP_SECRET", "CRON_SECRET", "FREE_ACCESS_USER_IDS"]) delete process.env[k]; });

describe("V7 — abonnement actif et dans la limite : synchronisé ; sinon suspendu SANS rien supprimer", () => {
  it("abonnement actif, dans la limite : la tâche planifiée synchronise (appel externe effectué)", async () => {
    const { workspaceId } = await workspaceWith("starter", ["meta_ads"]);
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(insights), { status: 200 }));
    const r = await (await post()).json();
    expect(r).toMatchObject({ syncs: 1, syncErrors: 0 });
    expect(f).toHaveBeenCalled();
    expect((await db.integration.findFirstOrThrow({ where: { workspaceId, provider: "meta_ads" } })).lastSyncAt).not.toBeNull();
  });

  it("abonnement inactif (essai expiré) : AUCUN appel externe, connexion et données conservées, synchronisation manuelle refusée", async () => {
    const { workspaceId } = await workspaceWith("growth", ["meta_ads"]);
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(insights), { status: 200 }));
    await syncIntegration(workspaceId, "meta_ads"); // une première synchronisation (abonnement actif) crée des données historiques
    const metricsBefore = await db.metric.count({ where: { workspaceId } });
    expect(metricsBefore).toBeGreaterThan(0);
    f.mockClear();
    await db.subscription.update({ where: { workspaceId }, data: { status: "trialing", trialEndsAt: new Date(Date.now() - DAY), stripeSubscriptionId: null } });
    const r = await (await post()).json();
    expect(r).toMatchObject({ syncs: 0, syncSkipped: { inactive: 1, overLimit: 0 } });
    expect(f).not.toHaveBeenCalled();
    await expect(syncIntegration(workspaceId, "meta_ads")).rejects.toThrow(/Abonnement inactif/);
    expect(f).not.toHaveBeenCalled();
    const row = await db.integration.findFirstOrThrow({ where: { workspaceId, provider: "meta_ads" } });
    expect(row.status).toBe("connected"); // la connexion est conservée (pas de déconnexion, identifiants intacts)
    expect(row.credentials).not.toBeNull();
    expect(await db.metric.count({ where: { workspaceId } })).toBe(metricsBefore); // les données historiques sont conservées
  });

  it("rétrogradation au-delà de la limite : les plus anciennes sont synchronisées, les autres suspendues mais conservées ; reprise propre au retour du forfait", async () => {
    const { workspaceId } = await workspaceWith("starter", AD); // trois connexions pour un forfait qui en inclut 2
    expect(PLANS.starter.limits.integrations).toBe(2);
    const plan = await listSyncableIntegrations();
    expect(plan.allowed.filter((a) => a.workspaceId === workspaceId).map((a) => a.provider)).toEqual(["meta_ads", "google_ads"]); // les deux plus anciennes
    expect(plan.skippedOverLimit).toBe(1);
    const f = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(insights), { status: 200 }));
    await expect(syncIntegration(workspaceId, "tiktok_ads")).rejects.toThrow(/inclut 2 intégrations/);
    expect(f).not.toHaveBeenCalled();
    expect(await db.integration.count({ where: { workspaceId, status: "connected" } })).toBe(3); // rien n'est déconnecté
    await db.subscription.update({ where: { workspaceId }, data: { plan: "growth" } }); // le forfait couvre de nouveau les trois
    expect((await listSyncableIntegrations()).allowed.filter((a) => a.workspaceId === workspaceId)).toHaveLength(3);
    expect((await integrationSyncAllowance(workspaceId, "tiktok_ads")).allowed).toBe(true);
  });

  it("reprise après réactivation : l'abonnement redevient actif, la synchronisation repart (et seulement alors)", async () => {
    const { workspaceId } = await workspaceWith("growth", ["meta_ads"], { status: "canceled", stripeSubscriptionId: "sub_x", stripeCustomerId: "cus_x" });
    expect((await integrationSyncAllowance(workspaceId, "meta_ads")).allowed).toBe(false);
    await db.subscription.update({ where: { workspaceId }, data: { status: "active", currentPeriodEnd: new Date(Date.now() + 20 * DAY) } });
    expect((await integrationSyncAllowance(workspaceId, "meta_ads")).allowed).toBe(true);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(insights), { status: 200 }));
    await expect(syncIntegration(workspaceId, "meta_ads")).resolves.toMatchObject({ rows: 1 });
  });

  it("propriétaire exempté : toutes les intégrations sont synchronisées sans abonnement valide (droits Pro)", async () => {
    const { workspaceId, userId } = await workspaceWith("starter", AD, { status: "canceled", stripeSubscriptionId: "sub_x", stripeCustomerId: "cus_x" });
    process.env.FREE_ACCESS_USER_IDS = userId;
    const plan = await listSyncableIntegrations();
    expect(plan.allowed.filter((a) => a.workspaceId === workspaceId)).toHaveLength(3);
    expect(plan.skippedInactive).toBe(0);
    expect((await integrationSyncAllowance(workspaceId, "tiktok_ads")).allowed).toBe(true);
  });

  it("sont ignorées : intégrations déconnectées et fournisseurs sans synchronisation de métriques (e-mail, analytics) — décompte exact", async () => {
    const { workspaceId } = await workspaceWith("pro", ["meta_ads", "email", "google_analytics"]);
    await db.integration.updateMany({ where: { workspaceId, provider: "email" }, data: { status: "disconnected" } });
    const plan = await listSyncableIntegrations();
    expect(plan.allowed.filter((a) => a.workspaceId === workspaceId).map((a) => a.provider)).toEqual(["meta_ads"]);
  });

  it("les synchronisations lancées à la main passent par la même règle côté serveur (appel direct de syncIntegration)", async () => {
    const { workspaceId } = await workspaceWith("starter", AD);
    await expect(syncIntegration(workspaceId, "tiktok_ads")).rejects.toBeInstanceOf(IntegrationError);
  });
});
