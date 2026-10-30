// D5 — droits des forfaits appliqués par le SERVEUR : accès API réservé à Pro (création ET utilisation des clés), limites de séquences et d'intégrations
// atomiques (y compris requêtes simultanées et retour OAuth), exécution des relances subordonnée à un abonnement actif. Appels directs aux routes HTTP
// et aux actions serveur : aucun de ces contrôles ne dépend de l'interface.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state: { ws: string } = { ws: "" };
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (u: string) => { throw new Error("NEXT_REDIRECT:" + u); },
  unstable_rethrow: (e: unknown) => { if (e instanceof Error && e.message.startsWith("NEXT_REDIRECT")) throw e; },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));
vi.mock("@/lib/tenant", async (orig) => {
  const actual = await orig<typeof import("@/lib/tenant")>();
  return {
    ...actual,
    requireCtx: async (opts: { action?: import("@/lib/permissions").Action } = {}) => {
      const { db } = await import("@/lib/db");
      const { assertCan, can } = await import("@/lib/permissions");
      const { entitlementForWorkspace } = await import("@/lib/free-access");
      const ws = await db.workspace.findUniqueOrThrow({ where: { id: state.ws }, include: { subscription: true } });
      const m = await db.membership.findFirstOrThrow({ where: { workspaceId: state.ws }, include: { user: true } });
      if (opts.action) assertCan("owner", opts.action);
      return { user: { id: m.userId, email: m.user.email, name: m.user.name }, workspace: ws, workspaceId: ws.id, role: "owner", subscription: ws.subscription, ent: await entitlementForWorkspace(ws.id, ws.subscription), can: (a: import("@/lib/permissions").Action) => can("owner", a) } as never;
    },
  };
});

import { db } from "@/lib/db";
import { sha256 } from "@/lib/crypto";
import { PLANS, planAllowsApi } from "@/lib/plans";
import { createLead } from "@/lib/leads";
import { enrollLead, processDueFollowUps, DEFAULT_SEQUENCE_STEPS } from "@/lib/followups";
import { saveConnection } from "@/lib/integrations/service";
import { IntegrationError } from "@/lib/integrations/types";
import { POST as apiLeads } from "@/app/api/v1/leads/route";
import { POST as apiEvents } from "@/app/api/v1/product-events/route";
import { createApiKeyAction, revokeApiKeyAction } from "../src/app/(app)/settings/actions";
import { createDefaultSequenceAction, saveSequenceAction } from "../src/app/(app)/automations/actions";
import { makeWorkspace, resetDb } from "./helpers";

const DAY = 86_400_000;
beforeEach(resetDb);
afterEach(() => { delete process.env.FREE_ACCESS_USER_IDS; vi.restoreAllMocks(); });

const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const paid = (plan: "starter" | "growth" | "pro") => ({ plan, status: "active", stripeSubscriptionId: `sub_${plan}`, stripeCustomerId: `cus_${plan}`, currentPeriodEnd: new Date(Date.now() + 20 * DAY), cancelAtPeriodEnd: false });
async function workspaceOn(plan: "starter" | "growth" | "pro", over: Record<string, unknown> = {}) {
  const w = await makeWorkspace();
  await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { ...paid(plan), stripeSubscriptionId: `sub_${w.workspaceId}`, stripeCustomerId: `cus_${w.workspaceId}`, ...over } });
  state.ws = w.workspaceId;
  return w;
}
let k = 0;
async function insertKey(workspaceId: string) {
  const key = `sp_rights_${++k}_` + "x".repeat(24);
  await db.apiKey.create({ data: { workspaceId, name: "k", prefix: key.slice(0, 10), keyHash: sha256(key) } });
  return key;
}
const lead = (key: string | null, email = `l${++k}@client.test`) => apiLeads(new Request("http://x/api/v1/leads", { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify({ name: "Lead API", email }) }));

describe("D5 — accès API : réservé à Pro, appliqué par le serveur à chaque appel", () => {
  it("la règle vient de la source unique des forfaits : seul Pro inclut l'API, et l'affichage en est dérivé", () => {
    expect([PLANS.starter, PLANS.growth, PLANS.pro].map(planAllowsApi)).toEqual([false, false, true]);
    expect(PLANS.pro.features).toContain("Accès API");
    expect(PLANS.starter.features).not.toContain("Accès API");
    expect(PLANS.growth.features).not.toContain("Accès API");
    expect([PLANS.starter.limits.apiKeys, PLANS.growth.limits.apiKeys]).toEqual([0, 0]); // le tableau comparatif n'annonce plus de clé utilisable sous Starter / Growth
  });

  it("1. Starter : appel direct à /api/v1/leads refusé (403), aucun lead créé", async () => {
    const w = await workspaceOn("starter"); const key = await insertKey(w.workspaceId);
    const r = await lead(key);
    expect(r.status).toBe(403);
    expect((await r.json()).error).toMatch(/réservé au forfait Pro/);
    expect(await db.lead.count({ where: { workspaceId: w.workspaceId } })).toBe(0);
  });

  it("2. Growth (abonnement payé) : appel direct refusé (403)", async () => {
    const w = await workspaceOn("growth"); const key = await insertKey(w.workspaceId);
    expect((await lead(key)).status).toBe(403);
    expect(await db.lead.count({ where: { workspaceId: w.workspaceId } })).toBe(0);
  });

  it("3. Pro : appel autorisé (201) ; le même contrôle protège /api/v1/product-events (403 sous Starter, autorisé sous Pro)", async () => {
    const pro = await workspaceOn("pro"); const proKey = await insertKey(pro.workspaceId);
    expect((await lead(proKey)).status).toBe(201);
    const ev = (key: string) => apiEvents(new Request("http://x/api/v1/product-events", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ product: "inconnu", type: "signup" }) }));
    expect([401, 402, 403]).not.toContain((await ev(proKey)).status); // l'autorisation passe : seule la validation du produit répond
    const starter = await workspaceOn("starter"); const starterKey = await insertKey(starter.workspaceId);
    expect((await ev(starterKey)).status).toBe(403);
  });

  it("4. clé existante sur un forfait inférieur : conservée mais refusée ; elle refonctionne au retour sur Pro (le droit est relu à chaque appel)", async () => {
    const w = await workspaceOn("pro"); const key = await insertKey(w.workspaceId);
    expect((await lead(key)).status).toBe(201);
    await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { plan: "growth" } }); // rétrogradation confirmée
    expect((await lead(key)).status).toBe(403);
    expect((await db.apiKey.findFirstOrThrow({ where: { workspaceId: w.workspaceId } })).revokedAt).toBeNull(); // rien n'est supprimé
    await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { plan: "pro" } });
    expect((await lead(key)).status).toBe(201);
  });

  it("5. fin de période, résiliation échue, essai expiré, abonnement terminé : 402 (le forfait ne suffit pas, l'abonnement doit être actif)", async () => {
    for (const over of [{ cancelAtPeriodEnd: true, currentPeriodEnd: new Date(Date.now() - DAY) }, { status: "canceled" }, { status: "trialing", stripeSubscriptionId: null, trialEndsAt: new Date(Date.now() - DAY) }]) {
      const w = await workspaceOn("pro", over); const key = await insertKey(w.workspaceId);
      expect((await lead(key)).status).toBe(402);
    }
  });

  it("9. appel HTTP direct : sans clé, clé inventée ou révoquée → 401, jamais 403 (aucune information sur le forfait n'est donnée sans clé valide)", async () => {
    const w = await workspaceOn("starter"); const key = await insertKey(w.workspaceId);
    expect((await lead(null)).status).toBe(401);
    expect((await lead("sp_inventee_" + "z".repeat(24))).status).toBe(401);
    await db.apiKey.updateMany({ where: { keyHash: sha256(key) }, data: { revokedAt: new Date() } });
    expect((await lead(key)).status).toBe(401);
  });

  it("création de clé : refusée sous Starter et Growth (aucune ligne créée), autorisée sous Pro ; la révocation reste possible partout", async () => {
    for (const plan of ["starter", "growth"] as const) {
      const w = await workspaceOn(plan);
      const r = await createApiKeyAction({}, fd({ name: "CRM externe" }));
      expect(r.ok).toBeFalsy();
      expect(r.error).toMatch(/réservé au forfait Pro/);
      expect(await db.apiKey.count({ where: { workspaceId: w.workspaceId } })).toBe(0);
    }
    const w = await workspaceOn("pro");
    const ok = await createApiKeyAction({}, fd({ name: "CRM externe" }));
    expect(ok.ok).toBe(true);
    const key = (ok.data as { key: string }).key;
    expect((await lead(key)).status).toBe(201);
    const row = await db.apiKey.findFirstOrThrow({ where: { workspaceId: w.workspaceId } });
    await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { plan: "starter" } });
    expect((await revokeApiKeyAction({}, fd({ id: row.id }))).ok).toBe(true); // sous Starter, une clé héritée se révoque
    expect((await lead(key)).status).toBe(401);
  });

  it("7. dépassement par requêtes simultanées : 20 clés au plus sous Pro, même avec 6 créations en parallèle", async () => {
    const w = await workspaceOn("pro");
    for (let i = 0; i < 17; i++) await insertKey(w.workspaceId);
    const r = await Promise.all(Array.from({ length: 6 }, (_, i) => createApiKeyAction({}, fd({ name: `K${i}` }))));
    expect(r.filter((x) => x.ok)).toHaveLength(3);
    expect(r.filter((x) => !x.ok).every((x) => /Limite de clés API atteinte/.test(x.error ?? ""))).toBe(true);
    expect(await db.apiKey.count({ where: { workspaceId: w.workspaceId, revokedAt: null } })).toBe(PLANS.pro.limits.apiKeys);
  });

  it("10. accès propriétaire gratuit : droits Pro, API comprise, indépendamment de l'abonnement local", async () => {
    const w = await workspaceOn("starter", { status: "canceled" });
    process.env.FREE_ACCESS_USER_IDS = w.userId;
    const ok = await createApiKeyAction({}, fd({ name: "Propriétaire" }));
    expect(ok.ok).toBe(true);
    expect((await lead((ok.data as { key: string }).key)).status).toBe(201);
    delete process.env.FREE_ACCESS_USER_IDS;
    expect((await lead((ok.data as { key: string }).key)).status).toBe(402); // sans exemption : abonnement terminé
  });
});

describe("D5 — séquences de relance : limite du forfait, atomique, et exécution subordonnée à l'abonnement", () => {
  it("6. Starter : 1 séquence ; Growth : 10 ; la création au-delà est refusée par le serveur", async () => {
    const s = await workspaceOn("starter");
    expect((await createDefaultSequenceAction()).ok).toBe(true);
    const r = await createDefaultSequenceAction();
    expect(r.ok).toBeFalsy();
    expect(r.error).toMatch(/Limite de séquences atteinte/);
    expect(await db.followUpSequence.count({ where: { workspaceId: s.workspaceId } })).toBe(PLANS.starter.limits.sequences);
    const steps = JSON.stringify(DEFAULT_SEQUENCE_STEPS);
    const g = await workspaceOn("growth");
    for (let i = 0; i < PLANS.growth.limits.sequences; i++) expect((await saveSequenceAction({}, fd({ name: `Séquence ${i}`, steps }))).ok).toBe(true);
    expect((await saveSequenceAction({}, fd({ name: "Onzième", steps }))).error).toMatch(/Limite de séquences atteinte/);
    expect(await db.followUpSequence.count({ where: { workspaceId: g.workspaceId } })).toBe(10);
  });

  it("7 bis. dépassement par requêtes simultanées : une seule séquence créée sous Starter malgré 5 demandes parallèles", async () => {
    const s = await workspaceOn("starter");
    const r = await Promise.all(Array.from({ length: 5 }, () => createDefaultSequenceAction()));
    expect(r.filter((x) => x.ok)).toHaveLength(1);
    expect(await db.followUpSequence.count({ where: { workspaceId: s.workspaceId } })).toBe(1);
    const g = await workspaceOn("growth");
    const steps = JSON.stringify(DEFAULT_SEQUENCE_STEPS);
    for (let i = 0; i < 8; i++) await saveSequenceAction({}, fd({ name: `S${i}`, steps }));
    const r2 = await Promise.all(Array.from({ length: 5 }, (_, i) => saveSequenceAction({}, fd({ name: `P${i}`, steps }))));
    expect(r2.filter((x) => x.ok)).toHaveLength(2);
    expect(await db.followUpSequence.count({ where: { workspaceId: g.workspaceId } })).toBe(10);
  });

  async function dueFollowUp(workspaceId: string, email: string) {
    const seq = await db.followUpSequence.create({ data: { workspaceId, name: "S", steps: DEFAULT_SEQUENCE_STEPS as never, active: true } });
    const { lead: l } = await createLead({ workspaceId, name: "Marie", email, consentMarketing: true });
    await enrollLead({ workspaceId, leadId: l.id, sequenceId: seq.id, now: new Date(Date.now() - 30 * DAY) });
  }

  it("exécution : un espace sans abonnement actif n'exécute aucune relance (elles restent en attente) et n'empêche pas les autres de s'exécuter", async () => {
    const dead = await workspaceOn("growth", { status: "canceled" });
    const trial = await makeWorkspace(); await db.subscription.update({ where: { workspaceId: trial.workspaceId }, data: { trialEndsAt: new Date(Date.now() - DAY) } });
    const live = await workspaceOn("growth");
    await dueFollowUp(dead.workspaceId, "a@client.test"); await dueFollowUp(trial.workspaceId, "b@client.test"); await dueFollowUp(live.workspaceId, "c@client.test");
    const s = await processDueFollowUps({ limit: 7 }); // la fenêtre de traitement n'est pas occupée par les espaces inactifs
    expect(s.processed).toBeGreaterThan(0);
    expect(await db.followUp.count({ where: { workspaceId: dead.workspaceId, status: "pending" } })).toBe(5);
    expect(await db.followUp.count({ where: { workspaceId: trial.workspaceId, status: "pending" } })).toBe(5);
    expect(await db.followUp.count({ where: { workspaceId: live.workspaceId, status: "pending" } })).toBeLessThan(5);
    expect(await processDueFollowUps({ workspaceId: dead.workspaceId })).toMatchObject({ processed: 0 }); // même en ciblant l'espace inactif
    // Réactivation : les relances reprennent.
    await db.subscription.update({ where: { workspaceId: dead.workspaceId }, data: { status: "active" } });
    expect((await processDueFollowUps({ workspaceId: dead.workspaceId })).processed).toBeGreaterThan(0);
  });

  it("exécution : l'espace propriétaire exempté s'exécute même avec un abonnement local terminé", async () => {
    const w = await workspaceOn("starter", { status: "canceled" });
    process.env.FREE_ACCESS_USER_IDS = w.userId;
    await dueFollowUp(w.workspaceId, "owner@client.test");
    expect((await processDueFollowUps({ workspaceId: w.workspaceId })).processed).toBeGreaterThan(0);
  });
});

describe("D5 — intégrations : « toutes les intégrations » = tous les types, limitée en nombre ; limite appliquée à tout chemin de connexion", () => {
  const connect = (workspaceId: string, provider: string) => saveConnection(workspaceId, provider, { credentials: { accessToken: "tok" }, accountName: provider });

  it("Growth (5) couvre tous les types d'intégration existants : la promesse « Toutes les intégrations » est exacte ; Starter est limité à 2", async () => {
    const { INTEGRATION_PROVIDERS } = await import("@/lib/constants");
    expect(PLANS.growth.limits.integrations).toBeGreaterThanOrEqual(INTEGRATION_PROVIDERS.length);
    expect(PLANS.starter.limits.integrations).toBeLessThan(INTEGRATION_PROVIDERS.length);
  });

  it("8. connexion au-delà de la limite refusée par le serveur (chemin commun action + callback OAuth), reconnexion d'une intégration existante libre", async () => {
    const w = await workspaceOn("starter");
    await connect(w.workspaceId, "google_analytics"); await connect(w.workspaceId, "meta_ads");
    await expect(connect(w.workspaceId, "google_ads")).rejects.toThrow(IntegrationError);
    await expect(connect(w.workspaceId, "google_ads")).rejects.toThrow(/Limite d'intégrations atteinte/);
    expect(await db.integration.count({ where: { workspaceId: w.workspaceId } })).toBe(2);
    await expect(connect(w.workspaceId, "meta_ads")).resolves.toBeTruthy(); // jeton renouvelé : pas une nouvelle intégration
    const g = await workspaceOn("growth");
    for (const p of ["google_analytics", "meta_ads", "google_ads", "tiktok_ads", "email"]) await connect(g.workspaceId, p);
    expect(await db.integration.count({ where: { workspaceId: g.workspaceId } })).toBe(5);
  });

  it("7 ter. connexions simultanées avec une seule place restante : une seule aboutit", async () => {
    const w = await workspaceOn("starter");
    await connect(w.workspaceId, "google_analytics");
    const r = await Promise.allSettled(["meta_ads", "google_ads", "tiktok_ads", "email"].map((p) => connect(w.workspaceId, p)));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await db.integration.count({ where: { workspaceId: w.workspaceId, status: { not: "disconnected" } } })).toBe(2);
  });

  it("l'espace propriétaire exempté dispose de toutes les intégrations (limites Pro)", async () => {
    const w = await workspaceOn("starter", { status: "canceled" });
    process.env.FREE_ACCESS_USER_IDS = w.userId;
    for (const p of ["google_analytics", "meta_ads", "google_ads", "tiktok_ads", "email"]) await expect(connect(w.workspaceId, p)).resolves.toBeTruthy();
  });
});
