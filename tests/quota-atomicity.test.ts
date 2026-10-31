// Quotas atomiques restants (membres, landing pages sur tous les chemins de création, campagnes actives) : plafond appliqué par le SERVEUR,
// comptage et écriture dans la même transaction verrouillée (src/lib/quota.ts), page et formulaire créés ensemble ou pas du tout.
// Les appels simultanés sont aussi rejoués sur PostgreSQL (tests/pg-stress.test.ts) : SQLite sérialise toutes les écritures.
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
      const m = await db.membership.findFirstOrThrow({ where: { workspaceId: state.ws, role: "owner" }, include: { user: true } });
      if (opts.action) assertCan("owner", opts.action);
      return { user: { id: m.userId, email: m.user.email, name: m.user.name }, workspace: ws, workspaceId: ws.id, role: "owner", subscription: ws.subscription, ent: await entitlementForWorkspace(ws.id, ws.subscription), can: (a: import("@/lib/permissions").Action) => can("owner", a) } as never;
    },
  };
});

import { db } from "@/lib/db";
import { PLANS } from "@/lib/plans";
import { DEFAULT_CONSENT, DEFAULT_FORM_FIELDS, defaultSections } from "@/lib/landing";
import { createPageWithForms } from "@/lib/landing-quota";
import { CampaignError, transitionCampaign } from "@/lib/campaigns";
import { createProductLanding } from "@/lib/portfolio/landing-service";
import { ensureDefaultProducts } from "@/lib/portfolio/service";
import { addMemberAction } from "../src/app/(app)/settings/actions";
import { createPageAction, duplicatePageAction, publishPageAction } from "../src/app/(app)/landing-pages/actions";
import { createPageFromVariantAction } from "../src/app/(app)/offers/actions";
import { makeWorkspace, resetDb } from "./helpers";

beforeEach(resetDb);
afterEach(() => { delete process.env.FREE_ACCESS_USER_IDS; vi.restoreAllMocks(); });

const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const paid = (plan: "starter" | "growth" | "pro") => ({ plan, status: "active", stripeSubscriptionId: `sub_${plan}_${Math.random()}`, stripeCustomerId: `cus_${plan}_${Math.random()}`, currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000) });
async function workspaceOn(plan: "starter" | "growth" | "pro") {
  const w = await makeWorkspace();
  await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: paid(plan) });
  state.ws = w.workspaceId;
  return w;
}

describe("lot 1 — plafond d'utilisateurs", () => {
  const spare = async (n: number) => Promise.all(Array.from({ length: n }, async (_, i) => db.user.create({ data: { email: `spare${i}-${Date.now()}-${Math.random()}@test.local`, name: `Spare ${i}`, passwordHash: "x" } })));

  it("Starter (1 utilisateur) : le propriétaire occupe déjà l'unique place, l'ajout est refusé et rien n'est écrit", async () => {
    const w = await workspaceOn("starter");
    const [u] = await spare(1);
    const r = await addMemberAction({}, fd({ email: u.email, role: "member" }));
    expect(r.ok).toBeFalsy();
    expect(r.error).toMatch(/Limite d'utilisateurs atteinte/);
    expect(await db.membership.count({ where: { workspaceId: w.workspaceId } })).toBe(1);
  });

  it("Growth (5 utilisateurs) : ajouts séquentiels jusqu'au plafond puis refus", async () => {
    const w = await workspaceOn("growth");
    const users = await spare(6);
    const res = [];
    for (const u of users) res.push(await addMemberAction({}, fd({ email: u.email, role: "member" })));
    expect(res.filter((r) => r.ok)).toHaveLength(PLANS.growth.limits.members - 1);
    expect(res.at(-1)?.error).toMatch(/Limite d'utilisateurs atteinte/);
    expect(await db.membership.count({ where: { workspaceId: w.workspaceId } })).toBe(PLANS.growth.limits.members);
  });

  it("ajouts simultanés : jamais plus que la limite du forfait", async () => {
    const w = await workspaceOn("growth");
    const users = await spare(12);
    const res = await Promise.all(users.map((u) => addMemberAction({}, fd({ email: u.email, role: "member" }))));
    expect(res.filter((r) => r.ok).length).toBeLessThanOrEqual(PLANS.growth.limits.members - 1);
    expect(await db.membership.count({ where: { workspaceId: w.workspaceId } })).toBeLessThanOrEqual(PLANS.growth.limits.members);
    expect(res.filter((r) => !r.ok).every((r) => /Limite d'utilisateurs atteinte/.test(r.error ?? ""))).toBe(true);
  });

  it("même compte ajouté deux fois en même temps : une seule appartenance, l'autre appel est refusé proprement", async () => {
    const w = await workspaceOn("growth");
    const [u] = await spare(1);
    const res = await Promise.all([addMemberAction({}, fd({ email: u.email, role: "member" })), addMemberAction({}, fd({ email: u.email, role: "member" }))]);
    expect(res.filter((r) => r.ok)).toHaveLength(1);
    expect(res.find((r) => !r.ok)?.error).toMatch(/fait déjà partie/);
    expect(await db.membership.count({ where: { workspaceId: w.workspaceId, userId: u.id } })).toBe(1);
  });

  it("propriétaire exempté : limites du forfait Pro (25 utilisateurs), même avec un abonnement Starter", async () => {
    const w = await workspaceOn("starter");
    process.env.FREE_ACCESS_USER_IDS = w.userId;
    const [u] = await spare(1);
    const r = await addMemberAction({}, fd({ email: u.email, role: "member" }));
    expect(r.ok).toBe(true);
  });
});

// ── Landing pages ──
/** Résultat d'une action qui redirige en cas de succès : « created » si elle a redirigé, sinon le message d'erreur renvoyé. */
const attempt = (p: Promise<{ ok?: boolean; error?: string }>) => p.then((r) => (r.ok ? "created" : r.error ?? "?"), (e) => (/NEXT_REDIRECT/.test(String(e?.message)) ? "created" : `throw:${String(e?.message)}`));
const PAGE_LIMIT = /Limite de landing pages atteinte/;
const livePages = (workspaceId: string) => db.landingPage.count({ where: { workspaceId, status: { not: "archived" } } });
let seq = 0;
async function seedPage(workspaceId: string, status = "draft") {
  const n = ++seq;
  const page = await db.landingPage.create({ data: { workspaceId, name: `Page ${n}`, slug: `page-${n}-${Math.random().toString(36).slice(2, 6)}`, status, sections: defaultSections({ name: `P${n}`, headline: `Titre ${n}`, benefits: [] }) as never, seoTitle: `T${n}`, seoDescription: `D${n}` } });
  await db.form.create({ data: { workspaceId, landingPageId: page.id, name: "F", fields: DEFAULT_FORM_FIELDS as never, consentText: DEFAULT_CONSENT } });
  return page;
}

describe("lot 2 — plafond de landing pages sur tous les chemins de création", () => {
  it("création : refusée au plafond (Starter = 3), page ET formulaire créés ensemble en deçà", async () => {
    const w = await workspaceOn("starter");
    const res = [];
    for (let i = 0; i < 4; i++) res.push(await attempt(createPageAction({}, fd({ name: `Nouvelle ${i}` }))));
    expect(res.slice(0, 3)).toEqual(["created", "created", "created"]);
    expect(res[3]).toMatch(PAGE_LIMIT);
    expect(await livePages(w.workspaceId)).toBe(PLANS.starter.limits.landingPages);
    expect(await db.form.count({ where: { workspaceId: w.workspaceId } })).toBe(3);
  });

  it("copie : refusée au plafond, aucune page ni formulaire écrit ; acceptée en deçà avec ses formulaires", async () => {
    const w = await workspaceOn("starter");
    const src = await seedPage(w.workspaceId);
    expect(await attempt(duplicatePageAction({}, fd({ id: src.id })))).toBe("created");
    await seedPage(w.workspaceId);
    const pages = await livePages(w.workspaceId), forms = await db.form.count({ where: { workspaceId: w.workspaceId } });
    expect(pages).toBe(PLANS.starter.limits.landingPages);
    expect(await attempt(duplicatePageAction({}, fd({ id: src.id })))).toMatch(PAGE_LIMIT);
    expect(await livePages(w.workspaceId)).toBe(pages);
    expect(await db.form.count({ where: { workspaceId: w.workspaceId } })).toBe(forms);
  });

  it("les pages archivées ne comptent pas : on crée au plafond quand une page est archivée", async () => {
    const w = await workspaceOn("starter");
    for (let i = 0; i < 3; i++) await seedPage(w.workspaceId);
    await seedPage(w.workspaceId, "archived");
    expect(await attempt(createPageAction({}, fd({ name: "Une de trop" })))).toMatch(PAGE_LIMIT);
    await db.landingPage.updateMany({ where: { workspaceId: w.workspaceId, status: "draft" }, data: { status: "archived" } });
    expect(await attempt(createPageAction({}, fd({ name: "Après archivage" })))).toBe("created");
  });

  it("sortie d'archive (publication ou retour en brouillon) : recomptée dans le forfait, refusée au plafond", async () => {
    const w = await workspaceOn("starter");
    for (let i = 0; i < 3; i++) await seedPage(w.workspaceId);
    const archived = await seedPage(w.workspaceId, "archived");
    for (const to of ["published", "draft"]) {
      const r = await publishPageAction({}, fd({ id: archived.id, to }));
      expect(r.error, to).toMatch(PAGE_LIMIT);
      expect((await db.landingPage.findUniqueOrThrow({ where: { id: archived.id } })).status).toBe("archived");
    }
    await db.landingPage.update({ where: { id: (await db.landingPage.findFirstOrThrow({ where: { workspaceId: w.workspaceId, status: "draft" } })).id }, data: { status: "archived" } });
    expect((await publishPageAction({}, fd({ id: archived.id, to: "published" }))).ok).toBe(true);
    expect(await livePages(w.workspaceId)).toBe(3);
  });

  it("atomicité : une erreur à l'écriture du formulaire annule la page (aucune page orpheline)", async () => {
    const w = await workspaceOn("growth");
    const before = await db.landingPage.count({ where: { workspaceId: w.workspaceId } });
    await expect(createPageWithForms({
      workspaceId: w.workspaceId, plan: PLANS.growth,
      page: { workspaceId: w.workspaceId, name: "Orpheline ?", slug: "orpheline", sections: [] as never },
      forms: [{ name: "Bon", fields: [] as never, consentText: "ok" }, { name: "Mauvais" } as never],
    })).rejects.toThrow();
    expect(await db.landingPage.count({ where: { workspaceId: w.workspaceId } })).toBe(before);
    expect(await db.form.count({ where: { workspaceId: w.workspaceId } })).toBe(0);
  });

  it("créations simultanées : jamais plus que le plafond, chaque page créée a son formulaire", async () => {
    const w = await workspaceOn("starter");
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => attempt(createPageAction({}, fd({ name: `Course ${i}` })))));
    expect(res.filter((r) => r === "created").length).toBeLessThanOrEqual(PLANS.starter.limits.landingPages);
    expect(res.filter((r) => r !== "created").every((r) => PAGE_LIMIT.test(r))).toBe(true);
    const pages = await db.landingPage.findMany({ where: { workspaceId: w.workspaceId }, include: { forms: true } });
    expect(pages.every((p) => p.forms.length === 1)).toBe(true);
  });

  it("propriétaire exempté : plafond du forfait Pro (illimité), même avec un abonnement Starter", async () => {
    const w = await workspaceOn("starter");
    process.env.FREE_ACCESS_USER_IDS = w.userId;
    for (let i = 0; i < 5; i++) expect(await attempt(createPageAction({}, fd({ name: `Exempt ${i}` })))).toBe("created");
  });
});

describe("lot 3 — variante d'offre et produit du portefeuille", () => {
  const variant = { id: "v_abcdef", headline: "Titre variante", subheadline: "Sous-titre", benefits: ["a", "b"], objections: [{ objection: "Trop cher ?", answer: "Non" }], valueProposition: "Valeur", cta: "Essayer" };
  const offerWithVariant = (workspaceId: string) => db.offer.create({ data: { workspaceId, name: "Offre test", variants: [variant] as never } });

  it("variante d'offre : refusée au plafond sans écrire ni page ni formulaire, acceptée en deçà avec son formulaire", async () => {
    const w = await workspaceOn("starter");
    const offer = await offerWithVariant(w.workspaceId);
    for (let i = 0; i < 2; i++) await seedPage(w.workspaceId);
    expect(await attempt(createPageFromVariantAction({}, fd({ id: offer.id, variantId: variant.id })))).toBe("created");
    expect(await livePages(w.workspaceId)).toBe(3);
    const forms = await db.form.count({ where: { workspaceId: w.workspaceId } });
    expect(await attempt(createPageFromVariantAction({}, fd({ id: offer.id, variantId: variant.id })))).toMatch(PAGE_LIMIT);
    expect(await livePages(w.workspaceId)).toBe(3);
    expect(await db.form.count({ where: { workspaceId: w.workspaceId } })).toBe(forms);
    expect((await db.landingPage.findMany({ where: { workspaceId: w.workspaceId, offerId: offer.id }, include: { forms: true } })).every((p) => p.forms.length === 1)).toBe(true);
  });

  it("variantes simultanées : jamais plus que le plafond", async () => {
    const w = await workspaceOn("starter");
    const offer = await offerWithVariant(w.workspaceId);
    const res = await Promise.all(Array.from({ length: 8 }, () => attempt(createPageFromVariantAction({}, fd({ id: offer.id, variantId: variant.id })))));
    expect(res.filter((r) => r === "created").length).toBeLessThanOrEqual(PLANS.starter.limits.landingPages);
    expect(await livePages(w.workspaceId)).toBeLessThanOrEqual(PLANS.starter.limits.landingPages);
  });

  it("produit : refusé au plafond sans créer d'offre ni de page ; la page déjà rattachée est renvoyée même au plafond (idempotent)", async () => {
    const w = await workspaceOn("starter");
    await ensureDefaultProducts(w.workspaceId, w.userId);
    const [a, b] = await Promise.all(["freelancenexa", "driverpilot"].map((slug) => db.product.findFirstOrThrow({ where: { workspaceId: w.workspaceId, slug } })));
    const make = (productId: string) => createProductLanding({ workspaceId: w.workspaceId, productId, userId: w.userId, plan: PLANS.starter });
    const first = await make(a.id);
    expect(first.created).toBe(true);
    await seedPage(w.workspaceId); await seedPage(w.workspaceId);
    const offers = await db.offer.count({ where: { workspaceId: w.workspaceId } });
    await expect(make(b.id)).rejects.toThrow(PAGE_LIMIT);
    expect(await db.offer.count({ where: { workspaceId: w.workspaceId } })).toBe(offers);
    expect(await livePages(w.workspaceId)).toBe(3);
    expect(await make(a.id)).toMatchObject({ created: false, pageId: first.pageId });
  });

  it("produit : demandes simultanées pour le même produit → une seule page ; pour des produits différents → jamais au-delà du plafond", async () => {
    const w = await workspaceOn("starter");
    await ensureDefaultProducts(w.workspaceId, w.userId);
    const products = await db.product.findMany({ where: { workspaceId: w.workspaceId } });
    const make = (productId: string) => createProductLanding({ workspaceId: w.workspaceId, productId, userId: w.userId, plan: PLANS.starter });
    const same = await Promise.allSettled(Array.from({ length: 6 }, () => make(products[0].id)));
    expect(same.filter((r) => r.status === "fulfilled" && r.value.created)).toHaveLength(1);
    expect(await db.landingPage.count({ where: { workspaceId: w.workspaceId, OR: [{ productId: products[0].id }, { offer: { productId: products[0].id } }] } })).toBe(1);
    await Promise.allSettled(products.map((p) => make(p.id)));
    expect(await livePages(w.workspaceId)).toBeLessThanOrEqual(PLANS.starter.limits.landingPages);
  });
});

describe("lot 4 — campagnes actives", () => {
  /** n campagnes « prêtes » (offre, audience et page publiée renseignées) dans l'espace, plus `active` campagnes déjà actives. */
  async function campaigns(workspaceId: string, ready: number, active = 0) {
    const lp = await db.landingPage.create({ data: { workspaceId, name: "L", slug: `l-${workspaceId}`, status: "published", sections: [] } });
    const offer = await db.offer.create({ data: { workspaceId, name: "O" } });
    const aud = await db.audience.create({ data: { workspaceId, name: "A" } });
    const base = { workspaceId, platform: "google_ads", budget: 100, objective: "leads", offerId: offer.id, audienceId: aud.id, landingPageId: lp.id };
    for (let i = 0; i < active; i++) await db.campaign.create({ data: { ...base, name: `Active ${i}`, status: "active" } });
    return Promise.all(Array.from({ length: ready }, (_, i) => db.campaign.create({ data: { ...base, name: `Prête ${i}`, status: "ready" } })));
  }
  const activate = (workspaceId: string, campaignId: string) => transitionCampaign({ workspaceId, campaignId, to: "active" });
  const activeCount = (workspaceId: string) => db.campaign.count({ where: { workspaceId, status: "active" } });

  it("au plafond (Starter = 3 actives) : activation refusée avec le message CampaignError d'origine, statut inchangé", async () => {
    const w = await workspaceOn("starter");
    const [c] = await campaigns(w.workspaceId, 1, PLANS.starter.limits.activeCampaigns);
    const err = await activate(w.workspaceId, c.id).catch((e) => e);
    expect(err).toBeInstanceOf(CampaignError);
    expect(err.message).toBe("Limite de campagnes actives atteinte pour votre plan.");
    expect((await db.campaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("ready");
  });

  it("en deçà du plafond : activation acceptée et auditée", async () => {
    const w = await workspaceOn("starter");
    const [c] = await campaigns(w.workspaceId, 1, 2);
    await expect(activate(w.workspaceId, c.id)).resolves.toMatchObject({ status: "active" });
    expect(await db.auditLog.count({ where: { workspaceId: w.workspaceId, action: "campaign.status_changed", entityId: c.id } })).toBe(1);
  });

  it("autres messages inchangés : campagne incomplète ou transition impossible", async () => {
    const w = await workspaceOn("growth");
    const [c] = await campaigns(w.workspaceId, 1);
    await db.campaign.update({ where: { id: c.id }, data: { landingPageId: null } });
    await expect(activate(w.workspaceId, c.id)).rejects.toThrow(/Campagne incomplète/);
    await db.campaign.update({ where: { id: c.id }, data: { status: "archived" } });
    await expect(activate(w.workspaceId, c.id)).rejects.toThrow(/Transition impossible/);
  });

  it("activations simultanées : jamais plus de campagnes actives que le plafond", async () => {
    const w = await workspaceOn("starter");
    const list = await campaigns(w.workspaceId, 8, 1);
    const res = await Promise.allSettled(list.map((c) => activate(w.workspaceId, c.id)));
    expect(await activeCount(w.workspaceId)).toBe(PLANS.starter.limits.activeCampaigns);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(PLANS.starter.limits.activeCampaigns - 1);
    expect(res.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason instanceof CampaignError)).toBe(true);
  });

  it("propriétaire exempté : plafond du forfait Pro (illimité), même avec un abonnement Starter", async () => {
    const w = await workspaceOn("starter");
    process.env.FREE_ACCESS_USER_IDS = w.userId;
    const list = await campaigns(w.workspaceId, 2, 4);
    for (const c of list) await expect(activate(w.workspaceId, c.id)).resolves.toMatchObject({ status: "active" });
    expect(await activeCount(w.workspaceId)).toBe(6);
  });
});
