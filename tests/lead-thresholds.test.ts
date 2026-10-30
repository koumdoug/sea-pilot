// Seuils de leads informatifs : au-delà du seuil du forfait, la capture continue sur les trois voies de création
// (saisie manuelle, API v1, formulaire public). Les contrôles d'abonnement existants sont conservés.
// Le seuil Starter (300) est dépassé par insertion directe de lignes (db.lead.createMany) : bien plus rapide que 300 appels à createLead.
import { beforeEach, describe, expect, it, vi } from "vitest";

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
    requireCtx: async () => {
      const { db } = await import("@/lib/db");
      const ws = await db.workspace.findUniqueOrThrow({ where: { id: state.ws } });
      const m = await db.membership.findFirstOrThrow({ where: { workspaceId: state.ws }, include: { user: true } });
      return { user: { id: m.userId, email: m.user.email, name: m.user.name }, workspace: ws, workspaceId: ws.id, role: "owner", subscription: null, ent: { active: true }, can: () => true } as never;
    },
  };
});

import { db } from "@/lib/db";
import { sha256 } from "@/lib/crypto";
import { workspaceUsage } from "@/lib/billing";
import { DEFAULT_CONSENT, DEFAULT_FORM_FIELDS } from "@/lib/landing";
import { PLANS, entitlement, limitReached } from "@/lib/plans";
import { POST as apiLead } from "@/app/api/v1/leads/route";
import { POST as publicLead } from "@/app/api/public/leads/route";
import { makeWorkspace, resetDb, grantApiPlan } from "./helpers";

beforeEach(resetDb);

const LIMIT = PLANS.starter.limits.leadsPerMonth;
const redirected = async (p: Promise<{ ok?: boolean; error?: string }>) => { try { return await p; } catch (e) { if (String((e as Error).message).startsWith("NEXT_REDIRECT")) return { ok: true }; throw e; } };
const fd = (f: Record<string, string>) => { const x = new FormData(); for (const [k, v] of Object.entries(f)) x.set(k, v); return x; };

/** Espace Starter déjà à `LIMIT` leads ce mois-ci : la prochaine création dépasse le seuil indicatif. */
async function starterAtThreshold() {
  const w = await makeWorkspace();
  expect((await db.subscription.findUniqueOrThrow({ where: { workspaceId: w.workspaceId } })).plan).toBe("starter");
  await db.lead.createMany({ data: Array.from({ length: LIMIT }, (_, i) => ({ workspaceId: w.workspaceId, name: `Seed ${i}` })) });
  const usage = await workspaceUsage(w.workspaceId);
  expect(usage.leadsPerMonth).toBe(LIMIT);
  expect(limitReached(PLANS.starter, "leadsPerMonth", usage.leadsPerMonth)).toBe(true); // le seuil est atteint : une limite ferme refuserait ici
  state.ws = w.workspaceId;
  return w;
}

async function publishedForm(workspaceId: string) {
  const page = await db.landingPage.create({ data: { workspaceId, name: "LP", slug: "lp", status: "published", sections: [] } });
  return db.form.create({ data: { workspaceId, landingPageId: page.id, name: "F", fields: DEFAULT_FORM_FIELDS as object[], consentText: DEFAULT_CONSENT } });
}
const postPublic = (formId: string, email: string) => publicLead(new Request("http://x/api/public/leads", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "9.9.9.9" }, body: JSON.stringify({ formId, values: { name: "Visiteur", email }, consent: true }) }));

describe("capture au-delà du seuil de leads du forfait", () => {
  it("saisie manuelle : le lead est créé, le compteur dépasse le seuil", async () => {
    const w = await starterAtThreshold();
    const { createLeadAction } = await import("@/app/(app)/leads/actions");
    const r = await redirected(createLeadAction({}, fd({ name: "Manuel", email: "manuel@x.com" })));
    expect(r.ok).toBe(true);
    expect(await db.lead.count({ where: { workspaceId: w.workspaceId, email: "manuel@x.com" } })).toBe(1);
    expect((await workspaceUsage(w.workspaceId)).leadsPerMonth).toBe(LIMIT + 1);
  });

  it("API v1 : 201, le lead est créé, le compteur dépasse le seuil", async () => {
    const w = await starterAtThreshold();
    const key = "sp_threshold_" + "k".repeat(20);
    await db.apiKey.create({ data: { workspaceId: w.workspaceId, name: "k", prefix: key.slice(0, 10), keyHash: sha256(key) } });
    await grantApiPlan(w.workspaceId);
    const res = await apiLead(new Request("http://x/api/v1/leads", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ name: "Via API", email: "api-seuil@x.com" }) }));
    expect(res.status).toBe(201);
    expect(await db.lead.count({ where: { workspaceId: w.workspaceId, email: "api-seuil@x.com" } })).toBe(1);
    expect((await workspaceUsage(w.workspaceId)).leadsPerMonth).toBe(LIMIT + 1);
  });

  it("formulaire public : ok, le lead est enregistré, le compteur dépasse le seuil", async () => {
    const w = await starterAtThreshold();
    const form = await publishedForm(w.workspaceId);
    const res = await postPublic(form.id, "public-seuil@x.com");
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(await db.lead.count({ where: { workspaceId: w.workspaceId, email: "public-seuil@x.com" } })).toBe(1);
    expect((await workspaceUsage(w.workspaceId)).leadsPerMonth).toBe(LIMIT + 1);
  });

  it("les trois voies restent ouvertes bien au-delà du seuil (301e, 302e, 303e lead)", async () => {
    const w = await starterAtThreshold();
    const form = await publishedForm(w.workspaceId);
    const key = "sp_threshold_" + "m".repeat(20);
    await db.apiKey.create({ data: { workspaceId: w.workspaceId, name: "k", prefix: key.slice(0, 10), keyHash: sha256(key) } });
    await grantApiPlan(w.workspaceId);
    const { createLeadAction } = await import("@/app/(app)/leads/actions");
    expect((await redirected(createLeadAction({}, fd({ name: "M", email: "m@x.com" })))).ok).toBe(true);
    expect((await apiLead(new Request("http://x/api/v1/leads", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ name: "A", email: "a@x.com" }) }))).status).toBe(201);
    expect((await postPublic(form.id, "p@x.com")).status).toBe(200);
    expect((await workspaceUsage(w.workspaceId)).leadsPerMonth).toBe(LIMIT + 3);
  });
});

describe("contrôles d'abonnement conservés", () => {
  it("formulaire public : après la fin de l'essai (accès suspendu), la capture continue — conforme aux conditions d'utilisation", async () => {
    const w = await makeWorkspace();
    const form = await publishedForm(w.workspaceId);
    await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { status: "trialing", trialEndsAt: new Date(Date.now() - 86_400_000) } });
    const sub = await db.subscription.findUniqueOrThrow({ where: { workspaceId: w.workspaceId } });
    expect(entitlement(sub).active).toBe(false);
    const res = await postPublic(form.id, "apres-essai@x.com");
    expect((await res.json()).ok).toBe(true);
    expect(await db.lead.count({ where: { workspaceId: w.workspaceId, email: "apres-essai@x.com" } })).toBe(1);
  });

  it("API v1 : abonnement inactif refusé (402), même sous le seuil — aucun lead créé", async () => {
    const w = await makeWorkspace();
    const key = "sp_threshold_" + "z".repeat(20);
    await db.apiKey.create({ data: { workspaceId: w.workspaceId, name: "k", prefix: key.slice(0, 10), keyHash: sha256(key) } });
    await grantApiPlan(w.workspaceId);
    await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { status: "canceled" } });
    const res = await apiLead(new Request("http://x/api/v1/leads", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ name: "N", email: "n@x.com" }) }));
    expect(res.status).toBe(402);
    expect(await db.lead.count({ where: { workspaceId: w.workspaceId } })).toBe(0);
  });
});
