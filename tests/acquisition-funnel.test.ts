// Parcours d'acquisition d'un produit : attribution du lead au produit (page → offre), rapport honnête (indisponible ≠ zéro), CAC avec réserves.
// Base de test dédiée (globalSetup). Aucune IA, aucun envoi : le test vérifie qu'aucun appel réseau n'a lieu pendant la capture.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { DEFAULT_CONSENT, DEFAULT_FORM_FIELDS } from "@/lib/landing";
import { SubmitError, submitToForm } from "@/lib/public-leads";
import { resolveProductId } from "@/lib/leads";
import { recordProductEvent } from "@/lib/portfolio/service";
import { MIN_CUSTOMERS_FOR_CAC, computeFunnel, loadProductFunnel, type FunnelRaw } from "@/lib/portfolio/funnel";
import { acquisitionReadiness, isPilotProduct, PILOT_PRODUCT_SLUG } from "@/lib/portfolio/pilot";
import { makeWorkspace, resetDb } from "./helpers";

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

const raw = (o: Partial<FunnelRaw> = {}): FunnelRaw => ({
  currency: "EUR", linkedPages: 0, views: 0, pageLeads: 0, leads: 0, qualifiedLeads: 0, leadsFromLinkedCampaigns: 0, sources: [], prospects: 0, events: {},
  payingCustomers: 0, unlinkedPayments: 0, payments: [], linkedCampaigns: 0, spend: { rows: 0, amount: 0, unlinkedAmount: 0 }, ...o,
});
const stage = (f: ReturnType<typeof computeFunnel>, id: string) => f.stages.find((s) => s.id === id)!;

describe("computeFunnel : indisponible n'est jamais zéro", () => {
  it("rien de collecté : visites, conversions, revenus, dépenses, CPL, CAC et taux sont indisponibles (null)", () => {
    const f = computeFunnel(raw());
    expect(stage(f, "visits")).toMatchObject({ value: null, availability: "unavailable" });
    for (const id of ["signup", "trial_started", "demo", "payment_confirmed"]) expect(stage(f, id)).toMatchObject({ value: null, availability: "unavailable" });
    expect(f.revenue).toBeNull();
    expect(f.spend.value).toBeNull();
    expect(f.cpl.value).toBeNull();
    expect(f.cac).toMatchObject({ value: null, status: "unavailable" });
    expect(f.rates).toEqual({ visitToLead: null, qualifiedShare: null, paidPerSignup: null });
    expect(stage(f, "leads").value).toBe(0); // la capture existe : zéro lead est une vraie mesure
  });

  it("dès qu'une conversion existe, les autres types valent 0 ; l'origine manuelle / produit / mixte est indiquée", () => {
    const f = computeFunnel(raw({ events: { signup: { manual: 2, webhook: 0 }, trial_started: { manual: 1, webhook: 1 }, payment_confirmed: { manual: 0, webhook: 3 } } }));
    expect(stage(f, "signup")).toMatchObject({ value: 2, availability: "manual" });
    expect(stage(f, "trial_started")).toMatchObject({ value: 2, availability: "mixed" });
    expect(stage(f, "payment_confirmed")).toMatchObject({ value: 3, availability: "measured" });
    expect(stage(f, "demo")).toMatchObject({ value: 0 });
  });

  it("visites : indisponibles sans page liée ; mesurées (même 0) avec une page liée", () => {
    expect(stage(computeFunnel(raw({ linkedPages: 1, views: 0 })), "visits")).toMatchObject({ value: 0, availability: "measured" });
    const f = computeFunnel(raw({ linkedPages: 1, views: 200, pageLeads: 10, leads: 12, qualifiedLeads: 3 }));
    expect(f.rates.visitToLead).toBeCloseTo(0.05);
    expect(f.rates.qualifiedShare).toBeCloseTo(0.25);
  });

  it("revenus : par devise, jamais additionnés entre devises", () => {
    const f = computeFunnel(raw({ payments: [{ currency: "EUR", amount: 49 }, { currency: "USD", amount: 9.99 }] }));
    expect(f.revenue).toEqual([{ currency: "EUR", amount: 49 }, { currency: "USD", amount: 9.99 }]);
  });

  it("dépenses : indisponibles sans campagne liée, et campagne liée sans aucune ligne de dépense ≠ 0", () => {
    expect(computeFunnel(raw()).spend.value).toBeNull();
    const f = computeFunnel(raw({ linkedCampaigns: 1 }));
    expect(f.spend.value).toBeNull();
    expect(f.spend.note).toMatch(/aucune dépense/);
    expect(computeFunnel(raw({ linkedCampaigns: 1, spend: { rows: 3, amount: 120, unlinkedAmount: 0 } })).spend.value).toBe(120);
  });

  it("CPL : dépenses ÷ leads des campagnes liées ; non calculable sans lead (pas zéro, pas de division par zéro)", () => {
    const base = { linkedCampaigns: 1, spend: { rows: 1, amount: 100, unlinkedAmount: 0 } };
    expect(computeFunnel(raw({ ...base, leadsFromLinkedCampaigns: 4 })).cpl.value).toBe(25);
    const none = computeFunnel(raw(base));
    expect(none.cpl.value).toBeNull();
    expect(none.cpl.note).toMatch(/pas zéro/);
  });
});

describe("CAC : jamais présenté comme fiable quand les données sont incomplètes", () => {
  const sp = { linkedCampaigns: 1, spend: { rows: 5, amount: 300, unlinkedAmount: 0 } };
  it("aucun client payant : indisponible, pas un CAC nul", () => {
    const f = computeFunnel(raw({ ...sp, payingCustomers: 0 }));
    expect(f.cac).toMatchObject({ value: null, status: "unavailable" });
    expect(f.cac.note).toMatch(/aucun client payant/);
  });
  it("sans dépenses : indisponible même avec des clients", () => {
    expect(computeFunnel(raw({ payingCustomers: 3 })).cac).toMatchObject({ value: null, status: "unavailable" });
  });
  it("calculé mais indicatif, avec réserves, quand les paiements sont saisis à la main et peu nombreux", () => {
    const f = computeFunnel(raw({ ...sp, payingCustomers: 2, payments: [{ currency: "EUR", amount: 98 }], events: { payment_confirmed: { manual: 2, webhook: 0 } } }));
    expect(f.cac.value).toBe(150);
    expect(f.cac.status).toBe("indicative");
    expect(f.cac.caveats.join(" ")).toMatch(/Moins de 5 clients/);
    expect(f.cac.caveats.join(" ")).toMatch(/saisis à la main/);
  });
  it("réserves : dépenses non rattachées, paiements sans prospect, devises différentes", () => {
    const f = computeFunnel(raw({ ...sp, spend: { rows: 5, amount: 300, unlinkedAmount: 80 }, payingCustomers: 6, unlinkedPayments: 2, payments: [{ currency: "USD", amount: 60 }], events: { payment_confirmed: { manual: 0, webhook: 8 } } }));
    expect(f.cac.status).toBe("indicative");
    const c = f.cac.caveats.join(" | ");
    expect(c).toMatch(/non rattachées/);
    expect(c).toMatch(/sans prospect identifié/);
    expect(c).toMatch(/Devise des paiements/);
  });
  it("« calculé » seulement sans aucune réserve", () => {
    const f = computeFunnel(raw({ ...sp, payingCustomers: MIN_CUSTOMERS_FOR_CAC, payments: [{ currency: "EUR", amount: 245 }], events: { payment_confirmed: { manual: 0, webhook: MIN_CUSTOMERS_FOR_CAC } } }));
    expect(f.cac).toMatchObject({ status: "computed", value: 60 });
    expect(f.cac.caveats).toEqual([]);
  });
});

describe("acquisitionReadiness et produit pilote", () => {
  const product = { status: "validation", publicUrl: "https://p.test", signupUrl: "https://p.test/register", pricing: { plans: [{ verified: false, currency: null }] }, unconfirmed: ["x"], salesArguments: [], objections: [] };
  const base = { product, pages: [], webhookEvents: 0, linkedAdCampaigns: 0, approvedTemplates: 0 };
  const get = (r: ReturnType<typeof acquisitionReadiness>, id: string) => r.checks.find((c) => c.id === id)!;
  it("DriverPilot est le produit pilote ; les autres non", () => {
    expect(PILOT_PRODUCT_SLUG).toBe("driverpilot");
    expect(isPilotProduct("driverpilot")).toBe(true);
    expect(isPilotProduct("freelancenexa") || isPilotProduct("operapilot")).toBe(false);
  });
  it("sans page publiée avec formulaire actif : bloqué ; un brouillon ou un formulaire inactif ne comptent pas", () => {
    expect(acquisitionReadiness(base).ready).toBe(false);
    expect(acquisitionReadiness({ ...base, pages: [{ status: "draft", hasActiveForm: true }, { status: "published", hasActiveForm: false }] }).ready).toBe(false);
    expect(acquisitionReadiness({ ...base, pages: [{ status: "published", hasActiveForm: true }] }).ready).toBe(true);
  });
  it("URL d'inscription absente : bloquant", () => {
    expect(acquisitionReadiness({ ...base, product: { ...product, signupUrl: null }, pages: [{ status: "published", hasActiveForm: true }] }).ready).toBe(false);
  });
  it("les réserves non bloquantes sont listées honnêtement (tarif, points à confirmer, flux de conversions, dépenses)", () => {
    const r = acquisitionReadiness({ ...base, pages: [{ status: "published", hasActiveForm: true }] });
    for (const id of ["pricing", "unconfirmed", "arguments", "feed", "ads", "templates", "status"]) expect(get(r, id).ok).toBe(false);
    expect(get(r, "feed").detail).toMatch(/à la main/);
    const ok = acquisitionReadiness({ ...base, product: { ...product, status: "commercialisation", pricing: { plans: [{ verified: true, currency: "USD" }] }, unconfirmed: [], salesArguments: [{ approved: true }] }, pages: [{ status: "published", hasActiveForm: true }], webhookEvents: 2, linkedAdCampaigns: 1, approvedTemplates: 1 });
    expect(ok.checks.every((c) => c.ok)).toBe(true);
  });
});

async function seedProduct(name = "Acme") {
  const w = await makeWorkspace(name);
  const product = await db.product.create({ data: { workspaceId: w.workspaceId, slug: PILOT_PRODUCT_SLUG, name: "DriverPilot", status: "commercialisation" } });
  const offer = await db.offer.create({ data: { workspaceId: w.workspaceId, name: "Essai DriverPilot", productId: product.id, status: "active" } });
  const page = await db.landingPage.create({ data: { workspaceId: w.workspaceId, name: "DriverPilot", slug: "driverpilot", status: "published", sections: [], offerId: offer.id } });
  const form = await db.form.create({ data: { workspaceId: w.workspaceId, landingPageId: page.id, name: "F", fields: DEFAULT_FORM_FIELDS as object[], consentText: DEFAULT_CONSENT } });
  return { ...w, product, offer, page, form };
}
const submit = (formId: string, email: string, utm: Record<string, string> = {}) => submitToForm(formId, { values: { name: "Chauffeur", email }, consent: true, utm });
const range = () => [new Date(Date.now() - 30 * 86_400_000), new Date(Date.now() + 60_000)] as const;

describe("capture d'un prospect pour le produit pilote", () => {
  it("page rattachée seulement à l'offre : le lead est attribué au produit, avec source, UTM, consentement ; aucun appel réseau, aucun faux événement", async () => {
    const s = await seedProduct();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await submit(s.form.id, "marc@driver.test", { source: "facebook", medium: "paid_social", campaign: "lancement", term: "chauffeur", content: "v1" });
    expect(r.lead.productId).toBe(s.product.id);
    expect(r.lead.workspaceId).toBe(s.workspaceId);
    expect([r.lead.utmSource, r.lead.utmMedium, r.lead.utmCampaign, r.lead.utmTerm, r.lead.utmContent]).toEqual(["facebook", "paid_social", "lancement", "chauffeur", "v1"]);
    expect(r.lead.source).toBe("facebook");
    expect(r.lead.consentMarketing).toBe(true);
    expect(r.lead.landingPageId).toBe(s.page.id);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await db.emailLog.count({ where: { workspaceId: s.workspaceId } })).toBe(0);
    expect(await db.productEvent.count({ where: { workspaceId: s.workspaceId } })).toBe(0);
    expect(await db.prospect.count({ where: { workspaceId: s.workspaceId } })).toBe(0);
  });

  it("données invalides : rejet, aucun lead créé", async () => {
    const s = await seedProduct();
    await expect(submit(s.form.id, "pas-un-email")).rejects.toBeInstanceOf(SubmitError);
    await expect(submitToForm(s.form.id, { values: {} })).rejects.toBeInstanceOf(SubmitError);
    expect(await db.lead.count({ where: { workspaceId: s.workspaceId } })).toBe(0);
  });

  it("page non publiée : le formulaire n'accepte rien", async () => {
    const s = await seedProduct();
    await db.landingPage.update({ where: { id: s.page.id }, data: { status: "draft" } });
    await expect(submit(s.form.id, "a@b.co")).rejects.toMatchObject({ status: 404 });
  });

  it("résolution du produit : explicite > campagne > page > offre de la page ; offre d'un autre espace ignorée", async () => {
    const a = await seedProduct("A");
    const b = await seedProduct("B");
    expect(await resolveProductId(a.workspaceId, { landingPageId: a.page.id })).toBe(a.product.id);
    expect(await resolveProductId(a.workspaceId, { productId: b.product.id, landingPageId: a.page.id })).toBe(a.product.id); // produit étranger ignoré, repli sur la page
    await db.landingPage.update({ where: { id: a.page.id }, data: { offerId: b.offer.id } });
    expect(await resolveProductId(a.workspaceId, { landingPageId: a.page.id })).toBeNull(); // offre d'un autre espace : aucune attribution
    expect(await resolveProductId(a.workspaceId, {})).toBeNull();
  });
});

describe("loadProductFunnel : chiffres réels, isolés par espace", () => {
  it("agrège visites, sources, leads, qualifiés, prospects, conversions, revenus, dépenses, CPL et CAC indicatif", async () => {
    const s = await seedProduct();
    const camp = await db.campaign.create({ data: { workspaceId: s.workspaceId, name: "Meta lancement", productId: s.product.id } });
    await db.analyticsEvent.createMany({ data: Array.from({ length: 40 }, () => ({ workspaceId: s.workspaceId, type: "page_view", landingPageId: s.page.id })) });
    await db.landingPage.update({ where: { id: s.page.id }, data: { campaignId: camp.id } });
    const l1 = await submit(s.form.id, "a@driver.test", { source: "facebook", medium: "paid_social" });
    await submit(s.form.id, "b@driver.test", { source: "facebook", medium: "paid_social" });
    await submit(s.form.id, "c@driver.test");
    await db.lead.update({ where: { id: l1.lead.id }, data: { qualifiedAt: new Date() } });
    await db.metric.create({ data: { workspaceId: s.workspaceId, campaignId: camp.id, platform: "meta_ads", date: new Date(), spend: 90, dedupeKey: "m1" } });
    const pr = await db.prospect.create({ data: { workspaceId: s.workspaceId, productId: s.product.id, name: "P", dedupeKey: "p@x.test", source: "manuel", collectedAt: new Date() } });
    await recordProductEvent({ workspaceId: s.workspaceId, productId: s.product.id, prospectId: pr.id, type: "signup", occurredAt: new Date() });
    await recordProductEvent({ workspaceId: s.workspaceId, productId: s.product.id, prospectId: pr.id, type: "payment_confirmed", occurredAt: new Date(), amount: 49, currency: "EUR" });

    const f = await loadProductFunnel(s.workspaceId, s.product.id, ...range());
    const st = (id: string) => f.stages.find((x) => x.id === id)!;
    expect(st("visits")).toMatchObject({ value: 40, availability: "measured" });
    expect(st("leads").value).toBe(3);
    expect(st("qualified").value).toBe(1);
    expect(st("prospects").value).toBe(1);
    expect(st("signup")).toMatchObject({ value: 1, availability: "manual" });
    expect(st("payment_confirmed").value).toBe(1);
    expect(f.revenue).toEqual([{ currency: "EUR", amount: 49 }]);
    expect(f.spend.value).toBe(90);
    expect(f.cpl.value).toBe(30); // 3 leads issus de la campagne liée (via la page)
    expect(f.rates.visitToLead).toBeCloseTo(3 / 40);
    expect(f.sources[0]).toEqual({ label: "facebook / paid_social", leads: 2 });
    expect(f.sources.some((x) => x.label === "Source non renseignée")).toBe(true);
    expect(f.cac).toMatchObject({ status: "indicative", value: 90 });
    expect(f.cac.caveats.length).toBeGreaterThan(0);
  });

  it("espace vierge : tout est indisponible, aucun zéro trompeur ; un autre espace ne voit rien des données du premier", async () => {
    const a = await seedProduct("A");
    const b = await seedProduct("B");
    await submit(a.form.id, "a@driver.test", { source: "x" });
    await recordProductEvent({ workspaceId: a.workspaceId, productId: a.product.id, type: "signup", occurredAt: new Date(), externalRef: "u1" });
    const fb = await loadProductFunnel(b.workspaceId, b.product.id, ...range());
    expect(fb.stages.find((x) => x.id === "leads")!.value).toBe(0);
    expect(fb.stages.find((x) => x.id === "signup")).toMatchObject({ value: null, availability: "unavailable" });
    expect(fb.sources).toEqual([]);
    // produit d'un autre espace demandé avec l'identifiant de A : aucune donnée de A ne fuit
    const cross = await loadProductFunnel(b.workspaceId, a.product.id, ...range());
    expect(cross.stages.find((x) => x.id === "leads")!.value).toBe(0);
    expect(cross.stages.find((x) => x.id === "signup")!.value).toBeNull();
  });

  it("la période exclut les événements hors fenêtre", async () => {
    const s = await seedProduct();
    await recordProductEvent({ workspaceId: s.workspaceId, productId: s.product.id, type: "signup", occurredAt: new Date(Date.now() - 200 * 86_400_000), externalRef: "old" });
    const f = await loadProductFunnel(s.workspaceId, s.product.id, ...range());
    expect(f.stages.find((x) => x.id === "signup")!.value).toBeNull();
  });
});
