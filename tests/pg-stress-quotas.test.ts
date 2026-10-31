// Charge PostgreSQL des quotas ajoutés après le lot D5 : membres, landing pages (tous les chemins de création), campagnes actives, connexions d'intégrations.
// Même principe que tests/pg-stress.test.ts : vraies connexions parallèles, vrai verrou de ligne de l'espace (src/lib/quota.ts) ; les actions serveur réelles sont appelées
// (seule la résolution du contexte est simulée). SQLite sérialise toutes les écritures : ces tests y sont ignorés. Lancer avec `npm run test:pg`.
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
    requireCtx: async (opts: { action?: import("@/lib/permissions").Action } = {}) => {
      const { db } = await import("@/lib/db");
      const { assertCan, can } = await import("@/lib/permissions");
      const { entitlementForWorkspace } = await import("@/lib/free-access");
      const ws = await db.workspace.findUniqueOrThrow({ where: { id: state.ws }, include: { subscription: true } });
      const m = await db.membership.findFirstOrThrow({ where: { workspaceId: state.ws, role: "owner" }, include: { user: true } });
      if (opts.action) assertCan("owner", opts.action);
      return { user: { id: m.userId, email: m.user.email, name: m.user.name }, workspace: ws, workspaceId: ws.id, role: "owner", subscription: ws.subscription, ent: await entitlementForWorkspace(ws.id, ws.subscription), can: (a: import("@/lib/permissions").Action) => can("owner", a) } as never;
    },
  };
});

import { db } from "@/lib/db";
import { PLANS } from "@/lib/plans";
import { CampaignError, transitionCampaign } from "@/lib/campaigns";
import { DEFAULT_CONSENT, DEFAULT_FORM_FIELDS, defaultSections } from "@/lib/landing";
import { createProductLanding } from "@/lib/portfolio/landing-service";
import { ensureDefaultProducts } from "@/lib/portfolio/service";
import { saveConnection } from "@/lib/integrations/service";
import { IntegrationLimitError } from "@/lib/integrations/types";
import { QuotaError, createWithinLimit } from "@/lib/quota";
import { addMemberAction } from "../src/app/(app)/settings/actions";
import { createPageAction, duplicatePageAction, publishPageAction } from "../src/app/(app)/landing-pages/actions";
import { createPageFromVariantAction } from "../src/app/(app)/offers/actions";
import { makeWorkspace, resetDb } from "./helpers";

const isPg = /^postgres(ql)?:\/\//.test(process.env.DATABASE_URL ?? "");
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const attempt = (p: Promise<{ ok?: boolean; error?: string }>) => p.then((r) => (r.ok ? "created" : r.error ?? "?"), (e) => (/NEXT_REDIRECT/.test(String(e?.message)) ? "created" : `throw:${String(e?.message)}`));
const livePages = (workspaceId: string) => db.landingPage.count({ where: { workspaceId, status: { not: "archived" } } });

async function workspaceOn(plan: "starter" | "growth" | "pro") {
  const w = await makeWorkspace();
  await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { plan, status: "active", stripeSubscriptionId: `sub_${w.workspaceId}`, stripeCustomerId: `cus_${w.workspaceId}`, currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000) } });
  state.ws = w.workspaceId;
  return w;
}
let seq = 0;
async function seedPage(workspaceId: string, status = "draft") {
  const n = ++seq;
  const page = await db.landingPage.create({ data: { workspaceId, name: `Page ${n}`, slug: `pg-${n}-${Math.random().toString(36).slice(2, 6)}`, status, sections: defaultSections({ name: `P${n}`, headline: `Titre ${n}`, benefits: [] }) as never, seoTitle: `T${n}`, seoDescription: `D${n}` } });
  await db.form.create({ data: { workspaceId, landingPageId: page.id, name: "F", fields: DEFAULT_FORM_FIELDS as never, consentText: DEFAULT_CONSENT } });
  return page;
}

describe.skipIf(!isPg)("PostgreSQL — quotas : membres, landing pages, campagnes, intégrations", () => {
  beforeEach(resetDb);

  it("membres : 24 ajouts simultanés sous un plafond de 5 utilisateurs → exactement 5 appartenances", async () => {
    const w = await workspaceOn("growth");
    const users = await Promise.all(Array.from({ length: 24 }, (_, i) => db.user.create({ data: { email: `m${i}-${Date.now()}-${Math.random()}@test.local`, name: `M ${i}`, passwordHash: "x" } })));
    const res = await Promise.all(users.map((u) => addMemberAction({}, fd({ email: u.email, role: "member" }))));
    expect(res.filter((r) => r.ok)).toHaveLength(PLANS.growth.limits.members - 1);
    expect(await db.membership.count({ where: { workspaceId: w.workspaceId } })).toBe(PLANS.growth.limits.members);
    expect(res.filter((r) => !r.ok).every((r) => /Limite d'utilisateurs atteinte/.test(r.error ?? ""))).toBe(true);
  });

  it("membres : le même compte ajouté 10 fois en même temps → une seule appartenance", async () => {
    const w = await workspaceOn("pro");
    const u = await db.user.create({ data: { email: `same-${Date.now()}@test.local`, name: "Même", passwordHash: "x" } });
    const res = await Promise.all(Array.from({ length: 10 }, () => addMemberAction({}, fd({ email: u.email, role: "member" }))));
    expect(res.filter((r) => r.ok)).toHaveLength(1);
    expect(await db.membership.count({ where: { workspaceId: w.workspaceId, userId: u.id } })).toBe(1);
  });

  it("landing pages : création, copie, variante d'offre et produit en même temps sous un plafond de 3 → exactement 3 pages, chacune avec son formulaire", async () => {
    const w = await workspaceOn("starter");
    await ensureDefaultProducts(w.workspaceId, w.userId);
    const products = await db.product.findMany({ where: { workspaceId: w.workspaceId } });
    const src = await seedPage(w.workspaceId);
    const variant = { id: "v_abcdef", headline: "Titre variante", subheadline: "Sous-titre", benefits: ["a"], objections: [{ objection: "Cher ?", answer: "Non" }], valueProposition: "Valeur", cta: "Essayer" };
    const offer = await db.offer.create({ data: { workspaceId: w.workspaceId, name: "Offre course", variants: [variant] as never } });
    const jobs: Promise<string>[] = [];
    for (let i = 0; i < 5; i++) jobs.push(attempt(createPageAction({}, fd({ name: `Course création ${i}` }))));
    for (let i = 0; i < 5; i++) jobs.push(attempt(duplicatePageAction({}, fd({ id: src.id }))));
    for (let i = 0; i < 5; i++) jobs.push(attempt(createPageFromVariantAction({}, fd({ id: offer.id, variantId: variant.id }))));
    for (const p of products) jobs.push(createProductLanding({ workspaceId: w.workspaceId, productId: p.id, userId: w.userId, plan: PLANS.starter }).then(() => "created", (e) => String(e?.message)));
    const res = await Promise.all(jobs);
    expect(await livePages(w.workspaceId)).toBe(PLANS.starter.limits.landingPages);
    expect(res.filter((r) => r === "created").length).toBeGreaterThanOrEqual(PLANS.starter.limits.landingPages - 1);
    const pages = await db.landingPage.findMany({ where: { workspaceId: w.workspaceId }, include: { forms: true } });
    expect(pages.every((p) => p.forms.length >= 1)).toBe(true);
    expect(res.filter((r) => r !== "created").every((r) => /Limite de landing pages atteinte|adresse \(slug\)/.test(r))).toBe(true);
  });

  it("landing pages : 12 sorties d'archive simultanées sous un plafond de 3 → jamais plus de 3 pages non archivées", async () => {
    const w = await workspaceOn("starter");
    const archived = await Promise.all(Array.from({ length: 12 }, () => seedPage(w.workspaceId, "archived")));
    const res = await Promise.all(archived.map((p) => publishPageAction({}, fd({ id: p.id, to: "draft" })).then((r) => (r.ok ? "ok" : r.error ?? "?"))));
    expect(await livePages(w.workspaceId)).toBe(PLANS.starter.limits.landingPages);
    expect(res.filter((r) => r === "ok")).toHaveLength(PLANS.starter.limits.landingPages);
    expect(res.filter((r) => r !== "ok").every((r) => /Limite de landing pages atteinte/.test(r))).toBe(true);
  });

  it("landing pages : 20 demandes simultanées pour le même produit → une seule page et une seule offre", async () => {
    const w = await workspaceOn("pro");
    await ensureDefaultProducts(w.workspaceId, w.userId);
    const product = await db.product.findFirstOrThrow({ where: { workspaceId: w.workspaceId, slug: "freelancenexa" } });
    const res = await Promise.allSettled(Array.from({ length: 20 }, () => createProductLanding({ workspaceId: w.workspaceId, productId: product.id, userId: w.userId, plan: PLANS.pro })));
    expect(res.filter((r) => r.status === "fulfilled" && r.value.created)).toHaveLength(1);
    expect(await db.landingPage.count({ where: { workspaceId: w.workspaceId, productId: product.id } })).toBe(1);
    expect(await db.offer.count({ where: { workspaceId: w.workspaceId, productId: product.id } })).toBe(1);
  });

  it("campagnes actives : 30 activations simultanées sous un plafond de 3 → exactement 3 actives, refus CampaignError pour les autres", async () => {
    const w = await workspaceOn("starter");
    const lp = await db.landingPage.create({ data: { workspaceId: w.workspaceId, name: "L", slug: `l-${w.workspaceId}`, status: "published", sections: [] } });
    const offer = await db.offer.create({ data: { workspaceId: w.workspaceId, name: "O" } });
    const aud = await db.audience.create({ data: { workspaceId: w.workspaceId, name: "A" } });
    const list = await Promise.all(Array.from({ length: 30 }, (_, i) => db.campaign.create({ data: { workspaceId: w.workspaceId, name: `C${i}`, status: "ready", platform: "google_ads", budget: 100, objective: "leads", offerId: offer.id, audienceId: aud.id, landingPageId: lp.id } })));
    const res = await Promise.allSettled(list.map((c) => transitionCampaign({ workspaceId: w.workspaceId, campaignId: c.id, to: "active" })));
    expect(await db.campaign.count({ where: { workspaceId: w.workspaceId, status: "active" } })).toBe(PLANS.starter.limits.activeCampaigns);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(PLANS.starter.limits.activeCampaigns);
    expect(res.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof CampaignError && /Limite de campagnes actives/.test((r as PromiseRejectedResult).reason.message))).toBe(true);
  });

  it("intégrations : 4 connexions OAuth simultanées sous un plafond de 2 → exactement 2 connectées, les autres refusées par la limite", async () => {
    const w = await workspaceOn("starter");
    const res = await Promise.allSettled(["meta_ads", "google_ads", "tiktok_ads", "google_analytics"].map((p) => saveConnection(w.workspaceId, p, { credentials: { accessToken: "t" } })));
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(PLANS.starter.limits.integrations);
    expect(res.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof IntegrationLimitError)).toBe(true);
    expect(await db.integration.count({ where: { workspaceId: w.workspaceId, status: "connected" } })).toBe(PLANS.starter.limits.integrations);
  });

  it("intégrations : la même connexion demandée 10 fois en même temps → une seule ligne", async () => {
    const w = await workspaceOn("starter");
    await Promise.all(Array.from({ length: 10 }, () => saveConnection(w.workspaceId, "meta_ads", { credentials: { accessToken: "t" } })));
    expect(await db.integration.count({ where: { workspaceId: w.workspaceId, provider: "meta_ads" } })).toBe(1);
  });

  it("espaces différents : le verrou est par espace — deux espaces saturent leurs quotas en parallèle sans se bloquer", async () => {
    const a = await makeWorkspace(), b = await makeWorkspace();
    const t0 = Date.now();
    const slow = (workspaceId: string) => createWithinLimit({ workspaceId, plan: PLANS.pro, key: "members", message: "x", create: async (tx) => { await new Promise((r) => setTimeout(r, 400)); return tx.workspace.update({ where: { id: workspaceId }, data: { updatedAt: new Date() } }); } });
    await Promise.all([slow(a.workspaceId), slow(b.workspaceId)]);
    expect(Date.now() - t0).toBeLessThan(750); // en parallèle (≈ 400 ms), pas l'un après l'autre (≈ 800 ms)

    const wa = await workspaceOn("starter"); const wb = await (async () => { const x = await makeWorkspace(); await db.subscription.update({ where: { workspaceId: x.workspaceId }, data: { plan: "starter", status: "active", stripeSubscriptionId: `s_${x.workspaceId}`, stripeCustomerId: `c_${x.workspaceId}`, currentPeriodEnd: new Date(Date.now() + 86_400_000 * 20) } }); return x; })();
    const connect = (workspaceId: string) => Promise.allSettled(["meta_ads", "google_ads", "tiktok_ads", "google_analytics"].map((p) => saveConnection(workspaceId, p, { credentials: { accessToken: "t" } })));
    await Promise.all([connect(wa.workspaceId), connect(wb.workspaceId)]);
    for (const id of [wa.workspaceId, wb.workspaceId]) expect(await db.integration.count({ where: { workspaceId: id, status: "connected" } })).toBe(PLANS.starter.limits.integrations);
  });

  it("le verrou n'est pas un simple compteur : une erreur dans la transaction libère l'espace et n'écrit rien", async () => {
    const w = await workspaceOn("starter");
    await expect(createWithinLimit({ workspaceId: w.workspaceId, plan: PLANS.starter, key: "landingPages", message: "x", create: async (tx) => { await tx.landingPage.create({ data: { workspaceId: w.workspaceId, name: "N", slug: "n", sections: [] } }); throw new Error("échec après écriture"); } })).rejects.toThrow("échec après écriture");
    expect(await db.landingPage.count({ where: { workspaceId: w.workspaceId } })).toBe(0);
    await expect(createWithinLimit({ workspaceId: w.workspaceId, plan: PLANS.starter, key: "landingPages", message: "x", create: (tx) => tx.landingPage.create({ data: { workspaceId: w.workspaceId, name: "N", slug: "n", sections: [] } }) })).resolves.toBeTruthy();
    expect(QuotaError).toBeDefined();
  });
});
