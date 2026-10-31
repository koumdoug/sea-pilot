// OAuth et abonnement : `connect`, `callback` et `saveConnection` refusent toute connexion ou reconnexion lorsque l'abonnement est inactif (règle serveur, point de passage commun),
// sans jamais toucher aux connexions déjà enregistrées, et sans affaiblir l'exemption du propriétaire (entitlementForWorkspace). Les connexions simultanées au plafond
// sont aussi rejouées sur PostgreSQL (tests/pg-stress.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state: { user: { id: string; email: string; name: string; locale: string } | null } = { user: null };
vi.mock("@/lib/auth", async (orig) => ({ ...(await orig<typeof import("@/lib/auth")>()), getSessionUser: async () => state.user }));
vi.mock("@/lib/tenant", async (orig) => {
  const actual = await orig<typeof import("@/lib/tenant")>();
  return {
    ...actual,
    // Même résolution que getCtx : première appartenance de l'utilisateur, exemption du propriétaire comprise.
    getCtx: async () => {
      if (!state.user) return null;
      const { db } = await import("@/lib/db");
      const { isExemptWorkspace, isFreeOwner } = await import("@/lib/free-access");
      const m = await db.membership.findFirstOrThrow({ where: { userId: state.user.id }, include: { workspace: { include: { subscription: true } } } });
      const exempt = isFreeOwner(state.user.id, m.role) || (await isExemptWorkspace(m.workspaceId));
      return actual.buildCtx(state.user, m.workspace, m.role, m.workspace.subscription, exempt);
    },
  };
});

import { db } from "@/lib/db";
import { PLANS } from "@/lib/plans";
import { INACTIVE_CONNECTION_MESSAGE, integrationSyncAllowance, makeOAuthState, saveConnection } from "@/lib/integrations/service";
import { PROVIDERS } from "@/lib/integrations/providers";
import { IntegrationError, IntegrationInactiveError, IntegrationLimitError } from "@/lib/integrations/types";
import { GET as oauthCallback } from "@/app/api/integrations/[provider]/callback/route";
import { GET as oauthConnect } from "@/app/api/integrations/[provider]/connect/route";
import { makeWorkspace, resetDb } from "./helpers";

const DAY = 86_400_000;
beforeEach(resetDb);
afterEach(() => { vi.restoreAllMocks(); delete process.env.FREE_ACCESS_USER_IDS; state.user = null; });

const cred = { credentials: { accessToken: "jeton-initial" } };
const callback = (workspaceId: string, userId: string, provider: string) => {
  const st = makeOAuthState(workspaceId, userId, provider);
  return oauthCallback(new Request(`http://x/api/integrations/${provider}/callback?code=abc&state=${encodeURIComponent(st)}`), { params: Promise.resolve({ provider }) });
};
const connect = (provider: string) => oauthConnect(new Request(`http://x/api/integrations/${provider}/connect`), { params: Promise.resolve({ provider }) });
const loc = (r: Response) => r.headers.get("location") ?? "";

async function workspace(status: "active" | "canceled" | "trial_expired" = "active", plan: "starter" | "growth" | "pro" = "growth") {
  const w = await makeWorkspace();
  state.user = { id: w.userId, email: "x@test.local", name: "U", locale: "fr" };
  const base = status === "trial_expired"
    ? { plan, status: "trialing", trialEndsAt: new Date(Date.now() - DAY) }
    : { plan, status, stripeSubscriptionId: `sub_${w.workspaceId}`, stripeCustomerId: `cus_${w.workspaceId}`, currentPeriodEnd: new Date(Date.now() + 20 * DAY) };
  await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: base });
  return w;
}
const mockProvider = (name: "meta_ads" | "google_ads" | "tiktok_ads" | "google_analytics") => {
  const exchange = vi.spyOn(PROVIDERS[name], "exchangeCode").mockResolvedValue({ credentials: { accessToken: `jeton-${name}` } });
  vi.spyOn(PROVIDERS[name], "isConfigured").mockReturnValue(true);
  vi.spyOn(PROVIDERS[name], "authUrl").mockReturnValue("https://fournisseur.test/autoriser");
  return exchange;
};

describe("route connect", () => {
  it("abonnement actif : redirige vers le fournisseur", async () => {
    await workspace("active"); mockProvider("meta_ads");
    expect(loc(await connect("meta_ads"))).toBe("https://fournisseur.test/autoriser");
  });

  it.each(["canceled", "trial_expired"] as const)("abonnement inactif (%s) : refusé avant toute demande d'autorisation au fournisseur (error=inactive)", async (status) => {
    await workspace(status); mockProvider("meta_ads");
    const r = await connect("meta_ads");
    expect(r.status).toBe(302);
    expect(loc(r)).toContain("/integrations?error=inactive");
  });

  it("propriétaire exempté : accepté même avec un abonnement inactif", async () => {
    const w = await workspace("canceled"); mockProvider("meta_ads");
    process.env.FREE_ACCESS_USER_IDS = w.userId;
    expect(loc(await connect("meta_ads"))).toBe("https://fournisseur.test/autoriser");
  });

  it("rôle insuffisant : toujours refusé avant le contrôle d'abonnement", async () => {
    const w = await workspace("active"); mockProvider("meta_ads");
    await db.membership.updateMany({ where: { workspaceId: w.workspaceId }, data: { role: "member" } });
    expect(loc(await connect("meta_ads"))).toContain("error=forbidden");
  });
});

describe("route callback", () => {
  it("abonnement actif : connexion enregistrée", async () => {
    const w = await workspace("active"); const ex = mockProvider("meta_ads");
    expect(loc(await callback(w.workspaceId, w.userId, "meta_ads"))).toContain("connected=meta_ads");
    expect(ex).toHaveBeenCalledTimes(1);
    expect(await db.integration.count({ where: { workspaceId: w.workspaceId, status: "connected" } })).toBe(1);
  });

  it.each(["canceled", "trial_expired"] as const)("abonnement inactif (%s) : refusé AVANT l'échange du code, rien n'est enregistré (error=inactive)", async (status) => {
    const w = await workspace(status); const ex = mockProvider("meta_ads");
    const r = await callback(w.workspaceId, w.userId, "meta_ads");
    expect(loc(r)).toContain("error=inactive");
    expect(ex).not.toHaveBeenCalled();
    expect(await db.integration.count({ where: { workspaceId: w.workspaceId } })).toBe(0);
  });

  it("reconnexion refusée si l'abonnement est inactif : la connexion existante reste intacte", async () => {
    const w = await workspace("active"); mockProvider("meta_ads");
    await saveConnection(w.workspaceId, "meta_ads", cred);
    const before = await db.integration.findFirstOrThrow({ where: { workspaceId: w.workspaceId, provider: "meta_ads" } });
    await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { status: "canceled" } });
    expect(loc(await callback(w.workspaceId, w.userId, "meta_ads"))).toContain("error=inactive");
    const after = await db.integration.findFirstOrThrow({ where: { workspaceId: w.workspaceId, provider: "meta_ads" } });
    expect({ status: after.status, credentials: after.credentials, connectedAt: after.connectedAt }).toEqual({ status: before.status, credentials: before.credentials, connectedAt: before.connectedAt });
  });

  it("propriétaire exempté : connexion et reconnexion acceptées avec un abonnement inactif", async () => {
    const w = await workspace("canceled"); mockProvider("meta_ads");
    process.env.FREE_ACCESS_USER_IDS = w.userId;
    expect(loc(await callback(w.workspaceId, w.userId, "meta_ads"))).toContain("connected=meta_ads");
    expect(loc(await callback(w.workspaceId, w.userId, "meta_ads"))).toContain("connected=meta_ads");
    expect(await db.integration.count({ where: { workspaceId: w.workspaceId, provider: "meta_ads" } })).toBe(1);
  });

  it("le plafond d'intégrations reste appliqué en plus du contrôle d'abonnement (error=limit)", async () => {
    const w = await workspace("active", "starter"); mockProvider("meta_ads");
    await saveConnection(w.workspaceId, "google_analytics", cred);
    await saveConnection(w.workspaceId, "tiktok_ads", cred);
    expect(loc(await callback(w.workspaceId, w.userId, "meta_ads"))).toContain("error=limit");
  });
});

describe("saveConnection — point de passage commun", () => {
  it("abonnement inactif : IntegrationInactiveError (toujours une IntegrationError), message explicite, aucune écriture", async () => {
    const w = await workspace("canceled");
    const err = await saveConnection(w.workspaceId, "meta_ads", cred).catch((e) => e);
    expect(err).toBeInstanceOf(IntegrationInactiveError);
    expect(err).toBeInstanceOf(IntegrationError);
    expect(err).not.toBeInstanceOf(IntegrationLimitError);
    expect(err.message).toBe(INACTIVE_CONNECTION_MESSAGE);
    expect(await db.integration.count({ where: { workspaceId: w.workspaceId } })).toBe(0);
  });

  it("reconnexion d'une intégration existante : refusée si inactif, libre (sans consommer de place) si actif", async () => {
    const w = await workspace("active", "starter");
    await saveConnection(w.workspaceId, "google_analytics", cred);
    await saveConnection(w.workspaceId, "tiktok_ads", cred); // Starter : 2 sur 2
    await expect(saveConnection(w.workspaceId, "tiktok_ads", { credentials: { accessToken: "nouveau" } })).resolves.toMatchObject({ status: "connected" });
    await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { status: "canceled" } });
    await expect(saveConnection(w.workspaceId, "tiktok_ads", cred)).rejects.toBeInstanceOf(IntegrationInactiveError);
    expect(await db.integration.count({ where: { workspaceId: w.workspaceId, status: "connected" } })).toBe(2);
  });

  it("connexion par clé (e-mail) : même règle ; propriétaire exempté accepté", async () => {
    const w = await workspace("canceled");
    await expect(saveConnection(w.workspaceId, "email", cred)).rejects.toBeInstanceOf(IntegrationInactiveError);
    process.env.FREE_ACCESS_USER_IDS = w.userId;
    await expect(saveConnection(w.workspaceId, "email", cred)).resolves.toMatchObject({ status: "connected" });
  });

  it("les connexions déjà enregistrées ne sont ni supprimées ni modifiées par un abonnement inactif ; les synchronisations autorisées le restent", async () => {
    const w = await workspace("active", "growth");
    await saveConnection(w.workspaceId, "google_analytics", cred);
    expect((await integrationSyncAllowance(w.workspaceId, "google_analytics")).allowed).toBe(true);
    await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { status: "canceled" } });
    const row = await db.integration.findFirstOrThrow({ where: { workspaceId: w.workspaceId } });
    expect(row.status).toBe("connected");
    expect(row.credentials).not.toBeNull();
    expect(await integrationSyncAllowance(w.workspaceId, "google_analytics")).toMatchObject({ allowed: false, reason: "inactive" }); // comportement de la tâche planifiée inchangé
    await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { status: "active" } });
    expect((await integrationSyncAllowance(w.workspaceId, "google_analytics")).allowed).toBe(true);
  });

  it("retours OAuth simultanés au plafond (Starter = 2) : jamais plus de connexions que le forfait", async () => {
    const w = await workspace("active", "starter");
    for (const p of ["meta_ads", "google_ads", "tiktok_ads", "google_analytics"] as const) mockProvider(p);
    const results = await Promise.all(["meta_ads", "google_ads", "tiktok_ads", "google_analytics"].map((p) => callback(w.workspaceId, w.userId, p)));
    expect(results.filter((r) => loc(r).includes("connected=")).length).toBeLessThanOrEqual(PLANS.starter.limits.integrations);
    expect(await db.integration.count({ where: { workspaceId: w.workspaceId, status: "connected" } })).toBeLessThanOrEqual(PLANS.starter.limits.integrations);
    expect(results.filter((r) => !loc(r).includes("connected=")).every((r) => loc(r).includes("error=limit"))).toBe(true);
  });
});
