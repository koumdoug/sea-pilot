// Accès propriétaire gratuit : chaîne RÉELLE session → requireCtx → autorisation, avec seulement les cookies et les redirections simulés.
// Auth, tenant, free-access, plans et env sont ceux de production. Base de test dédiée (globalSetup). Aucun accès à la production.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const jar: { token: string | null; ws: string | null } = { token: null, ws: null };
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (n === "seapilot_session" && jar.token ? { value: jar.token } : n === "seapilot_ws" && jar.ws ? { value: jar.ws } : undefined), set: () => {}, delete: () => {} }) }));
vi.mock("next/navigation", () => ({
  redirect: (u: string) => { throw new Error("NEXT_REDIRECT:" + u); },
  unstable_rethrow: (e: unknown) => { if (e instanceof Error && e.message.startsWith("NEXT_REDIRECT")) throw e; },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));

import { db } from "@/lib/db";
import { signSessionToken } from "@/lib/auth";
import { SESSION_COOKIE } from "@/lib/constants";
import { requireCtx } from "@/lib/tenant";
import { stripeConfigured } from "@/lib/billing";
import { entitlementForWorkspace } from "@/lib/free-access";
import { PLANS } from "@/lib/plans";
import { POST as createLead } from "@/app/api/v1/leads/route";
import { sha256 } from "@/lib/crypto";
import { makeWorkspace, resetDb } from "./helpers";

beforeEach(async () => { await resetDb(); jar.token = null; jar.ws = null; });
afterEach(() => { vi.unstubAllEnvs(); });

const DAY = 86_400_000;
const expire = (workspaceId: string, kind: "trial" | "canceled" | "expired") =>
  db.subscription.update({ where: { workspaceId }, data: kind === "trial" ? { status: "trialing", trialEndsAt: new Date(Date.now() - DAY) } : { status: kind, trialEndsAt: null } });
const login = async (userId: string) => { jar.token = await signSessionToken(userId); };
const redirectOf = async (p: Promise<unknown>) => (await p.then(() => null, (e: Error) => e.message));

describe("propriétaire listé côté serveur : jamais suspendu", () => {
  it("Stripe non configuré dans l'environnement de test (précondition)", () => { expect(stripeConfigured()).toBe(false); });

  it.each(["trial", "canceled", "expired"] as const)("abonnement/essai « %s » : accès autorisé, plan Pro, état « exempt »", async (kind) => {
    const o = await makeWorkspace("Proprio");
    vi.stubEnv("FREE_ACCESS_USER_IDS", o.userId);
    await expire(o.workspaceId, kind);
    await login(o.userId);
    const ctx = await requireCtx(); // ne redirige pas vers /billing?blocked=1
    expect(ctx.workspaceId).toBe(o.workspaceId);
    expect(ctx.ent).toMatchObject({ active: true, state: "exempt" });
    expect(ctx.ent.plan.id).toBe("pro");
  });

  it("sans aucune ligne d'abonnement : accès autorisé", async () => {
    const o = await makeWorkspace("Proprio");
    vi.stubEnv("FREE_ACCESS_USER_IDS", o.userId);
    await db.subscription.delete({ where: { workspaceId: o.workspaceId } });
    await login(o.userId);
    expect((await requireCtx()).ent.state).toBe("exempt");
  });

  it("plusieurs identifiants listés (espaces et virgules) : chacun est reconnu", async () => {
    const a = await makeWorkspace("A"), b = await makeWorkspace("B");
    await expire(a.workspaceId, "expired"); await expire(b.workspaceId, "expired");
    vi.stubEnv("FREE_ACCESS_USER_IDS", ` ${a.userId} , ${b.userId} `);
    await login(b.userId);
    expect((await requireCtx()).ent.state).toBe("exempt");
  });

  it("l'exemption s'applique aussi aux API par clé et aux limites (quotas IA, campagnes) du même espace", async () => {
    const o = await makeWorkspace("Proprio");
    vi.stubEnv("FREE_ACCESS_USER_IDS", o.userId);
    await expire(o.workspaceId, "expired");
    const sub = await db.subscription.findUnique({ where: { workspaceId: o.workspaceId } });
    expect((await entitlementForWorkspace(o.workspaceId, sub)).state).toBe("exempt");
    const key = `sp_${Math.random().toString(36).slice(2)}${Date.now()}`;
    await db.apiKey.create({ data: { workspaceId: o.workspaceId, name: "k", prefix: key.slice(0, 10), keyHash: sha256(key) } });
    const res = await createLead(new Request("http://x/api/v1/leads", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ name: "Test", email: "t@x.test" }) }));
    expect(res.status).not.toBe(402);
  });
});

describe("les autres utilisateurs restent soumis à leurs règles", () => {
  it.each(["trial", "canceled", "expired"] as const)("utilisateur ordinaire, abonnement « %s » : suspension inchangée", async (kind) => {
    const u = await makeWorkspace("Client");
    await expire(u.workspaceId, kind);
    await login(u.userId);
    expect(await redirectOf(requireCtx())).toBe("NEXT_REDIRECT:/billing?blocked=1");
  });

  it("utilisateur ordinaire, abonnement actif : accès normal, état « paid » et limites du plan inchangées", async () => {
    const u = await makeWorkspace("Client");
    await db.subscription.update({ where: { workspaceId: u.workspaceId }, data: { status: "active", plan: "starter", currentPeriodEnd: new Date(Date.now() + 20 * DAY), trialEndsAt: null } });
    await login(u.userId);
    const ctx = await requireCtx();
    expect(ctx.ent).toMatchObject({ active: true, state: "paid" });
    expect(ctx.ent.plan.limits).toEqual(PLANS.starter.limits);
  });

  it("utilisateur ordinaire en essai valide : accès, limites du plan d'essai", async () => {
    const u = await makeWorkspace("Client");
    await login(u.userId);
    const ctx = await requireCtx();
    expect(ctx.ent.state).toBe("trial");
    expect(ctx.ent.plan.limits).toEqual(PLANS.starter.limits);
  });

  it("l'exemption d'un propriétaire ne s'étend ni aux autres espaces ni aux autres utilisateurs", async () => {
    const owner = await makeWorkspace("Proprio");
    const client = await makeWorkspace("Client");
    vi.stubEnv("FREE_ACCESS_USER_IDS", owner.userId);
    await expire(client.workspaceId, "expired");
    await login(client.userId);
    expect(await redirectOf(requireCtx())).toBe("NEXT_REDIRECT:/billing?blocked=1");
    const sub = await db.subscription.findUnique({ where: { workspaceId: client.workspaceId } });
    expect((await entitlementForWorkspace(client.workspaceId, sub)).active).toBe(false);
  });

  it("un membre non propriétaire de l'espace du propriétaire n'est pas exempté à titre personnel", async () => {
    const owner = await makeWorkspace("Proprio");
    const m = await makeWorkspace("Autre");
    await db.membership.create({ data: { userId: m.userId, workspaceId: owner.workspaceId, role: "admin" } });
    vi.stubEnv("FREE_ACCESS_USER_IDS", owner.userId);
    await expire(owner.workspaceId, "expired");
    await expire(m.workspaceId, "expired");
    await login(m.userId); // 1er espace du membre (le sien) : expiré → suspendu
    expect(await redirectOf(requireCtx())).toBe("NEXT_REDIRECT:/billing?blocked=1");
  });

  it("variable vide : aucune exemption pour personne", async () => {
    const u = await makeWorkspace("Proprio");
    vi.stubEnv("FREE_ACCESS_USER_IDS", "");
    await expire(u.workspaceId, "expired");
    await login(u.userId);
    expect(await redirectOf(requireCtx())).toBe("NEXT_REDIRECT:/billing?blocked=1");
  });
});

describe("protections maintenues", () => {
  it("utilisateur non authentifié : redirigé vers la connexion, même avec un cookie invalide", async () => {
    expect(await redirectOf(requireCtx())).toMatch(/^NEXT_REDIRECT:\/login/);
    jar.token = "jeton.forgé.invalide";
    expect(await redirectOf(requireCtx())).toMatch(/^NEXT_REDIRECT:\/login/);
    jar.token = null;
    expect(SESSION_COOKIE).toBe("seapilot_session");
  });

  it("jeton signé pour un utilisateur supprimé : refusé", async () => {
    const o = await makeWorkspace("Proprio");
    vi.stubEnv("FREE_ACCESS_USER_IDS", o.userId);
    await db.user.update({ where: { id: o.userId }, data: { deletedAt: new Date() } });
    await login(o.userId);
    expect(await redirectOf(requireCtx())).toMatch(/^NEXT_REDIRECT:\/login/);
  });

  it("le paramètre blocked=1 n'est lu par aucun garde : un propriétaire reste autorisé, un client suspendu l'est quelle que soit l'URL", async () => {
    const o = await makeWorkspace("Proprio");
    vi.stubEnv("FREE_ACCESS_USER_IDS", o.userId);
    await expire(o.workspaceId, "expired");
    await login(o.userId);
    expect((await requireCtx()).ent.active).toBe(true); // requireCtx ne reçoit aucun paramètre d'URL
    const c = await makeWorkspace("Client");
    await db.subscription.update({ where: { workspaceId: c.workspaceId }, data: { status: "active", plan: "starter", currentPeriodEnd: new Date(Date.now() + 5 * DAY) } });
    await login(c.userId);
    expect((await requireCtx()).ent.state).toBe("paid"); // un client actif n'est pas suspendu parce qu'une URL le dirait
  });

  it("la page de facturation ne se fie pas au paramètre : propriétaire actif + blocked=1 → redirection vers /billing ; client suspendu → alerte affichée", async () => {
    const BillingPage = (await import("../src/app/(app)/billing/page")).default;
    const o = await makeWorkspace("Proprio");
    vi.stubEnv("FREE_ACCESS_USER_IDS", o.userId);
    await expire(o.workspaceId, "expired");
    await login(o.userId);
    expect(await redirectOf(BillingPage({ searchParams: Promise.resolve({ blocked: "1" }) }))).toBe("NEXT_REDIRECT:/billing");

    const c = await makeWorkspace("Client");
    await expire(c.workspaceId, "expired");
    await login(c.userId);
    const el = await BillingPage({ searchParams: Promise.resolve({ blocked: "1" }) });
    expect(JSON.stringify(el)).toContain("Accès suspendu");
    // sans le paramètre, un client suspendu voit son état réel sans l'alerte d'accès suspendu
    const el2 = await BillingPage({ searchParams: Promise.resolve({}) });
    expect(JSON.stringify(el2)).not.toContain("Accès suspendu");
  });

  it("la page de facturation du propriétaire affiche l'état « exempt » (Plan Pro, accès gratuit) sans alerte de suspension", async () => {
    const BillingPage = (await import("../src/app/(app)/billing/page")).default;
    const o = await makeWorkspace("Proprio");
    vi.stubEnv("FREE_ACCESS_USER_IDS", o.userId);
    await expire(o.workspaceId, "expired");
    await login(o.userId);
    const html = JSON.stringify(await BillingPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("Accès propriétaire gratuit");
    expect(html).not.toContain("Accès suspendu");
  });
});

// ── Règle unique portée par l'ESPACE : interface, actions, API et quotas appliquent la même exemption ──
describe("cohérence interface / API / quotas : un espace est exempté s'il appartient à un propriétaire listé", () => {
  async function setup() {
    const owner = await makeWorkspace("Proprio");
    vi.stubEnv("FREE_ACCESS_USER_IDS", owner.userId);
    await expire(owner.workspaceId, "expired");
    const invite = async (role: string) => {
      const u = await makeWorkspace(`Invité-${role}`);
      await db.membership.create({ data: { userId: u.userId, workspaceId: owner.workspaceId, role } });
      return u;
    };
    return { owner, invite };
  }
  const apiActive = async (workspaceId: string) => (await entitlementForWorkspace(workspaceId, await db.subscription.findUnique({ where: { workspaceId } }))).active;

  it.each(["admin", "member", "viewer"])("%s invité dans l'espace du propriétaire : accès (même règle que les API), permissions de rôle inchangées", async (role) => {
    const { owner, invite } = await setup();
    const u = await invite(role);
    await login(u.userId); jar.ws = owner.workspaceId;
    const ctx = await requireCtx();
    expect(ctx.workspaceId).toBe(owner.workspaceId);
    expect(ctx.ent).toMatchObject({ active: true, state: "exempt" });
    expect(ctx.ent.active).toBe(await apiActive(owner.workspaceId)); // interface = API
    expect(ctx.can("write")).toBe(role !== "viewer"); // le rôle gouverne toujours les actions
    expect(ctx.can("manage_billing")).toBe(false);
    expect(ctx.can("delete_workspace")).toBe(false);
  });

  it("le même membre, dans son PROPRE espace expiré, reste suspendu : l'exemption suit l'espace, pas la personne", async () => {
    const { owner, invite } = await setup();
    const u = await invite("member");
    await expire(u.workspaceId, "expired");
    await login(u.userId); jar.ws = u.workspaceId;
    expect(await redirectOf(requireCtx())).toBe("NEXT_REDIRECT:/billing?blocked=1");
    expect(await apiActive(u.workspaceId)).toBe(false);
    expect(await apiActive(owner.workspaceId)).toBe(true);
  });

  it("utilisateur listé simplement administrateur (ou membre) de l'espace d'un client : cet espace n'est PAS exempté, ni en interface ni en API", async () => {
    const listed = await makeWorkspace("Proprio");
    vi.stubEnv("FREE_ACCESS_USER_IDS", listed.userId);
    const client = await makeWorkspace("Client");
    await expire(client.workspaceId, "expired");
    await db.membership.create({ data: { userId: listed.userId, workspaceId: client.workspaceId, role: "admin" } });
    await login(listed.userId); jar.ws = client.workspaceId;
    expect(await redirectOf(requireCtx())).toBe("NEXT_REDIRECT:/billing?blocked=1");
    expect(await apiActive(client.workspaceId)).toBe(false);
    const key = `sp_${Math.random().toString(36).slice(2)}${Date.now()}`;
    await db.apiKey.create({ data: { workspaceId: client.workspaceId, name: "k", prefix: key.slice(0, 10), keyHash: sha256(key) } });
    const res = await createLead(new Request("http://x/api/v1/leads", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ name: "T", email: "t@x.test" }) }));
    expect(res.status).toBe(402);
  });

  it("espace client sans propriétaire listé : suspendu pour tous ses membres, même invités par un client", async () => {
    const listed = await makeWorkspace("Proprio");
    vi.stubEnv("FREE_ACCESS_USER_IDS", listed.userId);
    const client = await makeWorkspace("Client");
    const m = await makeWorkspace("Collègue");
    await db.membership.create({ data: { userId: m.userId, workspaceId: client.workspaceId, role: "member" } });
    await expire(client.workspaceId, "expired");
    await login(m.userId); jar.ws = client.workspaceId;
    expect(await redirectOf(requireCtx())).toBe("NEXT_REDIRECT:/billing?blocked=1");
  });

  it("utilisateur listé propriétaire de deux espaces : les deux sont exemptés ; un cookie vers un espace étranger est ignoré", async () => {
    const a = await makeWorkspace("A");
    vi.stubEnv("FREE_ACCESS_USER_IDS", a.userId);
    const second = await db.workspace.create({ data: { name: "Second", slug: `second-${Date.now()}`, onboardingCompletedAt: new Date(), subscription: { create: { plan: "starter", status: "canceled" } } } });
    await db.membership.create({ data: { userId: a.userId, workspaceId: second.id, role: "owner" } });
    const stranger = await makeWorkspace("Étranger");
    await expire(a.workspaceId, "expired");
    await login(a.userId);
    for (const ws of [a.workspaceId, second.id]) { jar.ws = ws; expect((await requireCtx()).ent.state).toBe("exempt"); }
    jar.ws = stranger.workspaceId; // pas membre : retombe sur un espace dont il est membre
    expect([a.workspaceId, second.id]).toContain((await requireCtx()).workspaceId);
  });

  it("variable vide : aucune exemption, nulle part (interface comme API) ; aucune requête d'appartenance nécessaire", async () => {
    const o = await makeWorkspace("Proprio");
    vi.stubEnv("FREE_ACCESS_USER_IDS", "");
    await expire(o.workspaceId, "expired");
    await login(o.userId);
    expect(await redirectOf(requireCtx())).toBe("NEXT_REDIRECT:/billing?blocked=1");
    expect(await apiActive(o.workspaceId)).toBe(false);
  });

  it("limites de plan : espace exempté = limites Pro ; espace client = limites de son plan, inchangées", async () => {
    const { owner } = await setup();
    await login(owner.userId);
    expect((await requireCtx()).ent.plan.limits).toEqual(PLANS.pro.limits);
    const c = await makeWorkspace("Client");
    await db.subscription.update({ where: { workspaceId: c.workspaceId }, data: { status: "active", plan: "growth", currentPeriodEnd: new Date(Date.now() + 9 * DAY) } });
    await login(c.userId);
    expect((await requireCtx()).ent.plan.limits).toEqual(PLANS.growth.limits);
  });
});
