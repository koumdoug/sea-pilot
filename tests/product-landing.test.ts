// Landing page générée depuis la fiche d'un produit du portefeuille : faits vérifiés seulement, rattachement produit → offre → page → formulaire → lead,
// compatibilité multi-produits, isolation entre espaces, vue globale. Base de test dédiée (globalSetup) ; aucun appel réseau.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state: { ws: string; role: string } = { ws: "", role: "owner" };
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
      const { PLANS } = await import("@/lib/plans");
      const ws = await db.workspace.findUniqueOrThrow({ where: { id: state.ws } });
      const m = await db.membership.findFirstOrThrow({ where: { workspaceId: state.ws }, include: { user: true } });
      if (opts.action) assertCan(state.role, opts.action);
      return { user: { id: m.userId, email: m.user.email, name: m.user.name }, workspace: ws, workspaceId: ws.id, role: state.role, subscription: null, ent: { active: true, plan: PLANS.pro }, can: (a: import("@/lib/permissions").Action) => can(state.role, a) } as never;
    },
  };
});

import { db } from "@/lib/db";
import { formFieldsSchema, sectionsSchema, type Section } from "@/lib/landing";
import { submitToForm } from "@/lib/public-leads";
import { PLANS } from "@/lib/plans";
import { auditLandingPage, pageText } from "@/lib/seo";
import { DEFAULT_PRODUCTS } from "@/lib/portfolio/catalog";
import { ensureDefaultProducts } from "@/lib/portfolio/service";
import { buildProductLanding, signupLink, type TemplateProduct } from "@/lib/portfolio/landing-template";
import { createProductLanding, findProductPage } from "@/lib/portfolio/landing-service";
import { aggregateFunnels, computeFunnel, loadPortfolioFunnels, type FunnelRaw, type PortfolioFunnelRow } from "@/lib/portfolio/funnel";
import { createProductLandingAction } from "../src/app/(app)/products/[id]/actions";
import { savePageAction } from "../src/app/(app)/landing-pages/actions";
import { makeWorkspace, resetDb } from "./helpers";

beforeEach(async () => { await resetDb(); state.role = "owner"; });
afterEach(() => vi.restoreAllMocks());

const mk = (n: number) => { let i = 0; return (p: string) => `${p}-${n}-${++i}`; };
const draftOf = (slug: string) => buildProductLanding(DEFAULT_PRODUCTS.find((p) => p.slug === slug) as unknown as TemplateProduct, mk(1));
const textOf = (slug: string) => { const d = draftOf(slug); return `${pageText(d.sections)}\n${d.seoTitle}\n${d.seoDescription}`; };
const bare: TemplateProduct = { slug: "nouveau", name: "NouveauSaaS", tagline: null, description: null, valueProposition: null, targetCustomers: null, problemsSolved: null, features: null, pricing: null, signupUrl: null, publicUrl: null, unconfirmed: null };

describe("modèle de landing page : uniquement des faits de la fiche", () => {
  it.each(DEFAULT_PRODUCTS.map((p) => p.slug))("%s : sections valides, sans preuve ni témoignage inventés", (slug) => {
    const d = draftOf(slug);
    expect(sectionsSchema.safeParse(d.sections).success).toBe(true);
    expect(d.sections.some((s: Section) => s.type === "testimonials" || s.type === "proof")).toBe(false);
    expect(d.sections.some((s) => s.type === "hero")).toBe(true);
    expect(d.sections.some((s) => s.type === "cta")).toBe(true);
    expect(d.gaps.join(" ")).toMatch(/Aucune preuve/);
  });

  it("FreelanceNexa : aucun tarif affiché (non confirmé), aucun « 19,99 », essai de 30 jours repris de la fiche vérifiée", () => {
    const t = textOf("freelancenexa");
    expect(t).not.toMatch(/19[.,]99|CAD|€|\$|par mois/);
    expect(draftOf("freelancenexa").pricingShown).toBe(false);
    expect(draftOf("freelancenexa").gaps.join(" ")).toMatch(/Tarif non confirmé/);
    expect(t).toContain("Essai gratuit de 30 jours");
    const hero = draftOf("freelancenexa").sections.find((s) => s.type === "hero");
    expect(hero?.type === "hero" && hero.ctaLabel).toBe("Essayer gratuitement");
  });

  it("fonctionnalité non vérifiée jamais présentée comme disponible ; signalée comme indisponible quand la fiche le dit", () => {
    const d = draftOf("freelancenexa");
    const benefits = d.sections.find((s) => s.type === "benefits");
    expect(benefits?.type === "benefits" && benefits.items.map((i) => i.title).join("|")).not.toMatch(/connexion bancaire/);
    const faq = d.sections.find((s) => s.type === "faq");
    expect(faq?.type === "faq" && faq.items.some((q) => /pas encore disponible/i.test(q.a) && /connexion bancaire/.test(q.a))).toBe(true);
    const dpBenefits = draftOf("driverpilot").sections.find((s) => s.type === "benefits");
    expect(dpBenefits?.type === "benefits" && dpBenefits.items.map((x) => x.title).join("|")).not.toMatch(/Import automatique/);
  });

  it("DriverPilot : pas d'essai vérifié → bouton « Nous contacter », tarifs non confirmés non affichés", () => {
    const hero = draftOf("driverpilot").sections.find((s) => s.type === "hero");
    expect(hero?.type === "hero" && hero.ctaLabel).toBe("Nous contacter");
    expect(textOf("driverpilot")).not.toMatch(/9,99|89|29,99|269/);
  });

  it("tarif affiché seulement s'il est confirmé AVEC sa devise", () => {
    const plan = (o: object) => ({ ...bare, pricing: { plans: [{ name: "Solo", amount: 20, currency: "CAD", interval: "month", verified: true, ...o }] } });
    const shown = (p: TemplateProduct) => buildProductLanding(p, mk(2));
    expect(shown(plan({})).pricingShown).toBe(true);
    expect(pageText(shown(plan({})).sections)).toContain("Solo : 20 CAD par mois");
    expect(shown(plan({ verified: false })).pricingShown).toBe(false);
    expect(shown(plan({ currency: null })).pricingShown).toBe(false);
    expect(shown(plan({ amount: null })).pricingShown).toBe(false);
    expect(shown(plan({ amount: 0 })).pricingShown).toBe(false);
  });

  it("lien d'inscription : UTM de SEA Pilot ajoutés ; URL absente ou dangereuse ignorée", () => {
    const l = signupLink({ slug: "freelancenexa", signupUrl: "https://x.test/register" })!;
    const u = new URL(l);
    expect([u.origin + u.pathname, u.searchParams.get("utm_source"), u.searchParams.get("utm_medium"), u.searchParams.get("utm_content")]).toEqual(["https://x.test/register", "seapilot", "landing_page", "freelancenexa"]);
    expect(signupLink({ slug: "a", signupUrl: null })).toBeNull();
    expect(signupLink({ slug: "a", signupUrl: "javascript:alert(1)" })).toBeNull();
    const footer = draftOf("freelancenexa").sections.find((s) => s.type === "footer");
    expect(footer?.type === "footer" && footer.links.map((x) => x.label)).toEqual(["Créer mon compte FreelanceNexa"]);
  });

  it("fiche vide (futur SaaS sans données) : page minimale valide, manques listés, aucune invention", () => {
    const d = buildProductLanding(bare, mk(3));
    expect(sectionsSchema.safeParse(d.sections).success).toBe(true);
    expect(d.sections.map((s) => s.type)).toEqual(["hero", "cta", "footer"]);
    expect(d.gaps.length).toBeGreaterThanOrEqual(5);
    expect(d.seoTitle).toBe("NouveauSaaS");
  });

  it("la page générée pour FreelanceNexa passe les contrôles SEO de base", () => {
    const d = draftOf("freelancenexa");
    const a = auditLandingPage({ name: d.name, status: "published", seoTitle: d.seoTitle, seoDescription: d.seoDescription, sections: d.sections, hasActiveForm: true });
    const st = (id: string) => a.checks.find((c) => c.id === id)!.status;
    expect(d.seoTitle.length).toBeLessThanOrEqual(60);
    expect(d.seoDescription.length).toBeGreaterThanOrEqual(70);
    expect(d.seoDescription.length).toBeLessThanOrEqual(160);
    expect([st("title"), st("description"), st("h1"), st("faq"), st("answer-first"), st("form"), st("cta")]).toEqual(["pass", "pass", "pass", "pass", "pass", "pass", "pass"]);
  });
});

async function seed(name = "Acme", opts: { role?: string } = {}) {
  const w = await makeWorkspace(name, opts);
  state.ws = w.workspaceId; state.role = opts.role ?? "owner";
  await ensureDefaultProducts(w.workspaceId, w.userId);
  const prod = async (slug: string) => db.product.findFirstOrThrow({ where: { workspaceId: w.workspaceId, slug } });
  return { ...w, prod };
}
const create = (s: { workspaceId: string; userId: string }, productId: string, plan = PLANS.pro) => createProductLanding({ workspaceId: s.workspaceId, productId, userId: s.userId, plan });

describe("createProductLanding : produit → offre → landing page → formulaire", () => {
  it("crée offre (brouillon, sans tarif inventé), page brouillon liée au produit et à l'offre, formulaire minimal avec consentement facultatif ; aucun appel externe", async () => {
    const s = await seed();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const fn = await s.prod("freelancenexa");
    const r = await create(s, fn.id);
    expect(r.created).toBe(true);
    const page = await db.landingPage.findUniqueOrThrow({ where: { id: r.pageId }, include: { forms: true, offer: true } });
    expect([page.productId, page.offerId, page.status, page.workspaceId]).toEqual([fn.id, r.offerId, "draft", s.workspaceId]);
    expect(page.offer).toMatchObject({ productId: fn.id, status: "draft", price: null, workspaceId: s.workspaceId });
    expect(sectionsSchema.safeParse(page.sections).success).toBe(true);
    const form = page.forms[0];
    expect(formFieldsSchema.parse(form.fields).map((f) => f.key)).toEqual(["name", "email", "message"]);
    expect(form.consentText).toMatch(/facultatif/);
    expect(await db.auditLog.count({ where: { workspaceId: s.workspaceId, action: "product.landing_created" } })).toBe(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await db.productEvent.count()).toBe(0);
    expect(await db.emailLog.count()).toBe(0);
  });

  it("idempotent : un second appel ne crée ni page, ni offre, ni formulaire en double", async () => {
    const s = await seed();
    const fn = await s.prod("freelancenexa");
    const a = await create(s, fn.id);
    const b = await create(s, fn.id);
    expect([b.created, b.pageId]).toEqual([false, a.pageId]);
    expect(await db.landingPage.count({ where: { workspaceId: s.workspaceId } })).toBe(1);
    expect(await db.offer.count({ where: { workspaceId: s.workspaceId } })).toBe(1);
    expect(await db.form.count({ where: { workspaceId: s.workspaceId } })).toBe(1);
    expect((await findProductPage(s.workspaceId, fn.id))?.id).toBe(a.pageId);
  });

  it("réutilise l'offre existante du produit au lieu d'en créer une seconde", async () => {
    const s = await seed();
    const fn = await s.prod("freelancenexa");
    const offer = await db.offer.create({ data: { workspaceId: s.workspaceId, productId: fn.id, name: "Offre existante", status: "active", price: 12, currency: "CAD" } });
    const r = await create(s, fn.id);
    expect(r.offerId).toBe(offer.id);
    expect(await db.offer.count({ where: { workspaceId: s.workspaceId } })).toBe(1);
  });

  it("tarif de l'offre seulement s'il est confirmé avec sa devise", async () => {
    const s = await seed();
    const fn = await s.prod("freelancenexa");
    await db.product.update({ where: { id: fn.id }, data: { pricing: { plans: [{ name: "Mensuel", amount: 19.99, currency: "CAD", interval: "month", verified: true }] } } });
    const r = await create(s, fn.id);
    expect(await db.offer.findUniqueOrThrow({ where: { id: r.offerId! } })).toMatchObject({ price: 19.99, currency: "CAD" });
  });

  it("produit d'un autre espace, produit supprimé ou inconnu : refus, rien n'est créé", async () => {
    const a = await seed("A");
    const b = await seed("B");
    const prodB = await b.prod("freelancenexa");
    await expect(create(a, prodB.id)).rejects.toThrow(/Produit introuvable/);
    await expect(create(a, "inconnu")).rejects.toThrow(/Produit introuvable/);
    const prodA = await a.prod("driverpilot");
    await db.product.update({ where: { id: prodA.id }, data: { deletedAt: new Date() } });
    await expect(create(a, prodA.id)).rejects.toThrow(/Produit introuvable/);
    expect(await db.landingPage.count()).toBe(0);
    expect(await db.offer.count()).toBe(0);
  });

  it("quota de landing pages du plan respecté", async () => {
    const s = await seed();
    const fn = await s.prod("freelancenexa");
    const full = { ...PLANS.starter, limits: { ...PLANS.starter.limits, landingPages: 0 } };
    await expect(create(s, fn.id, full)).rejects.toThrow(/Limite de landing pages/);
    expect(await db.landingPage.count()).toBe(0);
  });

  it("deux produits dans le même espace : pages, offres et slugs distincts ; FreelanceNexa ne modifie pas DriverPilot", async () => {
    const s = await seed();
    const fn = await s.prod("freelancenexa"), dp = await s.prod("driverpilot");
    const a = await create(s, dp.id);
    const dpBefore = await db.landingPage.findUniqueOrThrow({ where: { id: a.pageId } });
    const b = await create(s, fn.id);
    expect(b.pageId).not.toBe(a.pageId);
    expect(b.offerId).not.toBe(a.offerId);
    const dpAfter = await db.landingPage.findUniqueOrThrow({ where: { id: a.pageId } });
    expect(dpAfter.updatedAt).toEqual(dpBefore.updatedAt);
    expect(dpAfter.productId).toBe(dp.id);
    const slugs = (await db.landingPage.findMany({ where: { workspaceId: s.workspaceId } })).map((p) => p.slug);
    expect(new Set(slugs).size).toBe(2);
  });

  it("nouveau produit ajouté au portefeuille : même mécanisme, sans code spécifique", async () => {
    const s = await seed();
    const np = await db.product.create({ data: { workspaceId: s.workspaceId, slug: "quotesnap", name: "QuoteSnap", tagline: "Des devis en deux minutes.", description: "Générateur de devis.", features: [{ text: "Export PDF", verified: true }], status: "preparation" } });
    const r = await create(s, np.id);
    const page = await db.landingPage.findUniqueOrThrow({ where: { id: r.pageId } });
    expect(page.productId).toBe(np.id);
    expect(pageText(sectionsSchema.parse(page.sections))).toContain("Export PDF");
  });
});

describe("lead capturé par la page d'un produit", () => {
  it("attribué au bon produit (jamais à un autre), UTM, source et consentement conservés ; aucun faux client ni revenu", async () => {
    const s = await seed();
    const fn = await s.prod("freelancenexa"), dp = await s.prod("driverpilot");
    const pf = await create(s, fn.id), pd = await create(s, dp.id);
    for (const id of [pf.pageId, pd.pageId]) await db.landingPage.update({ where: { id }, data: { status: "published" } });
    const formOf = async (pageId: string) => (await db.form.findFirstOrThrow({ where: { landingPageId: pageId } })).id;
    const lf = await submitToForm(await formOf(pf.pageId), { values: { name: "Julie", email: "julie@free.test", message: "Bonjour" }, consent: true, utm: { source: "linkedin", medium: "organic", campaign: "lancement", content: "post1" } });
    const ld = await submitToForm(await formOf(pd.pageId), { values: { name: "Marc", email: "marc@drive.test" }, utm: { source: "facebook" } });
    expect(lf.lead.productId).toBe(fn.id);
    expect(ld.lead.productId).toBe(dp.id);
    expect([lf.lead.utmSource, lf.lead.utmMedium, lf.lead.utmCampaign, lf.lead.utmContent, lf.lead.source]).toEqual(["linkedin", "organic", "lancement", "post1", "linkedin"]);
    expect(lf.lead.consentMarketing).toBe(true);
    expect(ld.lead.consentMarketing).toBe(false);
    expect(lf.lead.status).toBe("new");
    expect(lf.lead.customerId).toBeNull();
    expect(lf.lead.value).toBeNull();
    expect(await db.productEvent.count()).toBe(0);
    expect(await db.customer.count()).toBe(0);
  });

  it("un brouillon ne capte aucun lead", async () => {
    const s = await seed();
    const fn = await s.prod("freelancenexa");
    const r = await create(s, fn.id);
    const form = await db.form.findFirstOrThrow({ where: { landingPageId: r.pageId } });
    await expect(submitToForm(form.id, { values: { name: "A", email: "a@b.co" } })).rejects.toMatchObject({ status: 404 });
    expect(await db.lead.count()).toBe(0);
  });
});

describe("actions : permissions et isolation", () => {
  it("membre : création puis redirection vers l'éditeur de la page ; seconde demande : même page", async () => {
    const s = await seed("Acme", { role: "member" });
    const fn = await s.prod("freelancenexa");
    const fd = new FormData(); fd.set("productId", fn.id);
    await expect(createProductLandingAction({}, fd)).rejects.toThrow(/NEXT_REDIRECT:\/landing-pages\//);
    await expect(createProductLandingAction({}, fd)).rejects.toThrow(/NEXT_REDIRECT:\/landing-pages\//);
    expect(await db.landingPage.count({ where: { workspaceId: s.workspaceId } })).toBe(1);
  });

  it("lecteur : permission refusée, rien n'est créé", async () => {
    const s = await seed("Acme", { role: "viewer" });
    const fn = await s.prod("freelancenexa");
    const fd = new FormData(); fd.set("productId", fn.id);
    const r = await createProductLandingAction({}, fd);
    expect(r.error).toMatch(/permission/);
    expect(await db.landingPage.count()).toBe(0);
  });

  it("identifiant de produit vide : erreur de validation", async () => {
    await seed();
    const fd = new FormData(); fd.set("productId", "  ");
    expect((await createProductLandingAction({}, fd)).error).toBeTruthy();
  });

  it("impossible de rattacher une page à l'offre d'un autre espace", async () => {
    const a = await seed("A");
    const b = await seed("B");
    const prodA = await a.prod("freelancenexa");
    const page = await create(a, prodA.id);
    const offerB = await db.offer.create({ data: { workspaceId: b.workspaceId, name: "Offre B" } });
    state.ws = a.workspaceId; state.role = "owner";
    const p = await db.landingPage.findUniqueOrThrow({ where: { id: page.pageId } });
    const fd = new FormData();
    for (const [k, v] of Object.entries({ id: p.id, name: p.name, slug: p.slug, primary: "#2563eb", sections: JSON.stringify(p.sections), formFields: JSON.stringify([{ key: "email", label: "E-mail", type: "email", required: true }]), consentText: "Consentement facultatif", successMessage: "Merci", offerId: offerB.id, formActive: "on" })) fd.set(k, v);
    const r = await savePageAction({}, fd);
    expect(r.error).toMatch(/Offre introuvable/);
    expect((await db.landingPage.findUniqueOrThrow({ where: { id: p.id } })).offerId).toBe(page.offerId);
  });
});

describe("vue globale du portefeuille", () => {
  const raw = (o: Partial<FunnelRaw> = {}): FunnelRaw => ({ currency: "CAD", linkedPages: 0, views: 0, pageLeads: 0, leads: 0, qualifiedLeads: 0, leadsFromLinkedCampaigns: 0, sources: [], prospects: 0, events: {}, payingCustomers: 0, unlinkedPayments: 0, payments: [], linkedCampaigns: 0, spend: { rows: 0, amount: 0, unlinkedAmount: 0 }, ...o });
  const row = (name: string, o: Partial<FunnelRaw>): PortfolioFunnelRow => ({ productId: name, name, slug: name, funnel: computeFunnel(raw(o)) });

  it("somme les étapes mesurées ; indisponible seulement si indisponible partout ; revenus séparés par devise", () => {
    const t = aggregateFunnels([
      row("a", { leads: 3, events: { signup: { manual: 2, webhook: 0 } }, payments: [{ currency: "CAD", amount: 20 }], payingCustomers: 1 }),
      row("b", { leads: 2, payments: [{ currency: "EUR", amount: 9 }, { currency: "CAD", amount: 5 }] }),
    ], "CAD");
    expect(t.stages.leads).toBe(5);
    expect(t.stages.signup).toBe(2); // b : indisponible, ignoré (jamais compté comme 0 faussement)
    expect(t.stages.payment_confirmed).toBe(0); // a a des conversions saisies (0 paiement), b aucune
    expect(t.stages.visits).toBeNull();
    expect(t.revenue).toEqual([{ currency: "CAD", amount: 25 }, { currency: "EUR", amount: 9 }]);
    expect(t.spend).toBeNull();
  });

  it("aucune donnée nulle part : tout reste indisponible", () => {
    const t = aggregateFunnels([row("a", {}), row("b", {})], "CAD");
    expect(t.stages.signup).toBeNull();
    expect(t.revenue).toBeNull();
    expect(t.spend).toBeNull();
    expect(aggregateFunnels([], "CAD").stages).toEqual({});
  });

  it("chargement réel : chaque produit garde ses leads ; un produit ajouté apparaît ; un autre espace est étanche", async () => {
    const a = await seed("A");
    const b = await seed("B");
    const fn = await a.prod("freelancenexa"), dp = await a.prod("driverpilot");
    const pf = await create(a, fn.id);
    await db.landingPage.update({ where: { id: pf.pageId }, data: { status: "published" } });
    const form = await db.form.findFirstOrThrow({ where: { landingPageId: pf.pageId } });
    await submitToForm(form.id, { values: { name: "J", email: "j@x.test" }, utm: { source: "linkedin" } });
    await db.product.create({ data: { workspaceId: a.workspaceId, slug: "futur", name: "FuturSaaS" } });
    const to = new Date(), from = new Date(to.getTime() - 30 * 86_400_000);
    const g = await loadPortfolioFunnels(a.workspaceId, from, to);
    const leads = (name: string) => g.rows.find((r) => r.name === name)!.funnel.stages.find((s) => s.id === "leads")!.value;
    expect(leads("FreelanceNexa")).toBe(1);
    expect(leads("DriverPilot")).toBe(0);
    expect(g.rows.map((r) => r.name)).toContain("FuturSaaS");
    expect(g.totals.stages.leads).toBe(1);
    expect(g.totals.revenue).toBeNull();
    expect(dp.id).not.toBe(fn.id);
    const gb = await loadPortfolioFunnels(b.workspaceId, from, to);
    expect(gb.totals.stages.leads).toBe(0);
    expect(gb.rows.every((r) => r.name !== "FuturSaaS")).toBe(true);
  });
});
