// Moteur de stratégie : compréhension de l'offre (sans règle propre à un produit), économie unitaire sans donnée inventée,
// différenciation et objections sans fausse fonctionnalité, canaux selon budget et cible, cohérence onboarding → offre → fiche → analyse IA.
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { buildStrategy, INSUFFICIENT, type StrategyInput, type StrategySheet } from "@/lib/strategy";
import { billingFromPricing, cacPaybackMonths, monthlyGrossMargin } from "@/lib/unit-economics";
import { generateStrategyNarrative, loadStrategyInput } from "@/lib/strategy-service";
import { setAIProviderForTests, type AIProvider, type AIRequest } from "@/lib/ai/providers";
import { strategyNarrativeSchema } from "@/lib/ai/prompts";
import { makeWorkspace, resetDb } from "./helpers";

const base = (o: Partial<StrategyInput> = {}): StrategyInput => ({
  companyName: "Acme", currency: "CAD", industry: "Logiciel de gestion d'activité", country: "Canada", description: "Un logiciel pour gérer son activité indépendante.",
  offer: { name: "Offre A", price: 19.99, marginPct: 10, description: "Gestion des clients, devis et factures.", problem: "Suivre ses revenus sans tableur." },
  audience: { name: "Freelances", type: "b2b", location: "Québec", problems: "Perte de temps administrative", objections: "Déjà un tableur" },
  goals: { leadsPerMonth: 100, salesPerMonth: 10, adBudgetMonthly: 1500, maxCac: 10, revenueGoal: 2000 },
  ...o,
});
const row = (s: StrategySheet, re: RegExp) => s.economics.find((e) => re.test(e.label));
const text = (s: StrategySheet) => JSON.stringify(s);
const alerts = (s: StrategySheet) => s.alerts.map((a) => a.text).join(" || ");
const MONTHLY = { interval: "month", planName: "Mensuel", source: "product_pricing" } as const;

describe("économie unitaire : fonctions pures", () => {
  it("délai de récupération : CAC ÷ marge mensuelle ; null (jamais 0 ni Infinity) si une donnée manque", () => {
    expect(cacPaybackMonths(10, 2)).toBe(5);
    for (const [c, m] of [[0, 2], [10, 0], [null, 2], [10, null], [undefined, undefined], [-5, 2], [10, -1], [Number.NaN, 2], [10, Number.NaN], [Infinity, 2]] as const) expect(cacPaybackMonths(c, m), `${c}/${m}`).toBeNull();
  });
  it("marge mensuelle : annuel ÷ 12 ; marge inconnue → null", () => {
    expect(monthlyGrossMargin(120, "year")).toBe(10);
    expect(monthlyGrossMargin(5, "month")).toBe(5);
    expect(monthlyGrossMargin(null, "month")).toBeNull();
    expect(monthlyGrossMargin(0, "month")).toBeNull();
  });
  it("mode de facturation : un seul plan VÉRIFIÉ au prix et à la devise de l'offre, sinon null (rien n'est deviné)", () => {
    const p = { plans: [{ name: "Pro", amount: 19.99, currency: "CAD", interval: "month", verified: true }, { name: "An", amount: 199, currency: "CAD", interval: "year", verified: true }] };
    expect(billingFromPricing(p, 19.99, "CAD")).toMatchObject({ interval: "month", planName: "Pro" });
    expect(billingFromPricing(p, 199, "CAD")).toMatchObject({ interval: "year" });
    expect(billingFromPricing(p, 25, "CAD")).toBeNull();
    expect(billingFromPricing(p, 19.99, "EUR")).toBeNull();
    expect(billingFromPricing({ plans: [{ name: "x", amount: 10, currency: "CAD", interval: "month", verified: true }, { name: "y", amount: 10, currency: "CAD", interval: "year", verified: true }] }, 10, "CAD")).toBeNull(); // ambigu
    expect(billingFromPricing({ plans: [{ name: "x", amount: 10, currency: "CAD", interval: null, verified: true }] }, 10, "CAD")).toBeNull();
    for (const bad of [null, undefined, {}, { plans: "x" }, 5]) expect(billingFromPricing(bad, 10, "CAD")).toBeNull();
    expect(billingFromPricing(p, null, "CAD")).toBeNull();
  });
  describe("D2 : une donnée tarifaire non confirmée n'est jamais un fait", () => {
    const plan = (o: Record<string, unknown> = {}) => ({ plans: [{ name: "Mensuel", amount: 19.99, currency: "CAD", interval: "month", verified: true, ...o }] });
    const get = (pricing: unknown, price: number | null = 19.99, cur: string | null = "CAD") => billingFromPricing(pricing, price, cur);
    it("forfait vérifié avec devise valide : facturation retenue (mensuelle, annuelle ; casse et espaces de la devise normalisés)", () => {
      expect(get(plan())).toEqual({ interval: "month", planName: "Mensuel", source: "product_pricing" });
      expect(get(plan({ interval: "year", amount: 199 }), 199)).toMatchObject({ interval: "year" });
      expect(get(plan({ currency: " cad " }))).toMatchObject({ interval: "month" });
      expect(get(plan(), 19.99, "cad")).toMatchObject({ interval: "month" });
    });
    it("forfait non vérifié, `verified` absent ou non booléen : refusé (récurrence inconnue)", () => {
      expect(get(plan({ verified: false }))).toBeNull();
      const noFlag = plan(); delete (noFlag.plans[0] as Record<string, unknown>).verified;
      expect(get(noFlag)).toBeNull();
      for (const v of ["true", 1, "yes", null, undefined]) expect(get(plan({ verified: v })), String(v)).toBeNull();
    });
    it("devise absente, vide, invalide ou différente : refusé, jamais remplacée par la devise de l'offre", () => {
      for (const c of [null, undefined, "", "  ", "C", "CA", "CADD", "12$", "€", 5, {}]) expect(get(plan({ currency: c })), JSON.stringify(c)).toBeNull();
      expect(get(plan({ currency: "USD" }))).toBeNull(); // devise du forfait ≠ devise de l'offre
      for (const c of [null, undefined, "", "??", "EURO"]) expect(billingFromPricing(plan(), 19.99, c), String(c)).toBeNull(); // devise de l'offre inexploitable (appel direct : le paramètre par défaut de `get` masquerait `undefined`)
    });
    it("un forfait vérifié n'est pas rendu ambigu par un forfait non vérifié de même prix ; deux forfaits vérifiés identiques le sont", () => {
      expect(get({ plans: [{ name: "A", amount: 19.99, currency: "CAD", interval: "year", verified: false }, { name: "B", amount: 19.99, currency: "CAD", interval: "month", verified: true }] })).toMatchObject({ planName: "B", interval: "month" });
      expect(get({ plans: [{ name: "A", amount: 19.99, currency: "CAD", interval: "year", verified: true }, { name: "B", amount: 19.99, currency: "CAD", interval: "month", verified: true }] })).toBeNull();
    });
    it("période absente ou inconnue (ni mensuelle ni annuelle) : aucune récurrence retenue, jamais devinée", () => {
      for (const i of [null, undefined, "", "week", "one_time", 1]) expect(get(plan({ interval: i })), String(i)).toBeNull();
    });
    it("données nulles ou mal formées : jamais d'exception ni de valeur supposée", () => {
      for (const bad of [null, undefined, 0, "x", [], {}, { plans: null }, { plans: [null, 1, "x", {}] }, { plans: [{ verified: true }] }]) expect(get(bad), JSON.stringify(bad)).toBeNull();
      for (const price of [null, 0, -1, Number.NaN, Infinity]) expect(get(plan(), price as number | null), String(price)).toBeNull();
      expect(get(plan({ amount: null }))).toBeNull();
      expect(get(plan({ amount: "19.99" }))).toBeNull();
    });
    it("conséquence dans la fiche : sans plan confirmé, la récurrence reste inconnue (pas de délai de récupération, formulation « mode de facturation non connu »)", () => {
      const billing = get(plan({ verified: false }));
      const s = buildStrategy(base({ offer: { ...base().offer!, billing } }));
      expect(billing).toBeNull();
      expect(s.funnel.paybackMonths ?? null).toBeNull();
      expect(s.economics.find((e) => /Délai de récupération/.test(e.label))).toBeUndefined();
      expect(s.alerts.map((a) => a.text).join(" ")).toMatch(/mode de facturation .* n'est pas connu/);
      const ok = buildStrategy(base({ offer: { ...base().offer!, billing: get(plan()) } }));
      expect(ok.funnel.paybackMonths).toBeCloseTo(10 / 1.999, 5); // un plan confirmé continue de produire le calcul attendu
    });
    it("un catalogue non confirmé n'alimente pas la fiche d'une organisation (lecture réelle en base)", async () => {
      await resetDb();
      const w = await makeWorkspace("Pricing");
      const mk = async (verified: boolean, currency: string | null) => {
        const product = await db.product.create({ data: { workspaceId: w.workspaceId, name: `P${verified}${currency}`, slug: `p-${verified}-${currency}-${Date.now()}`, pricing: { plans: [{ name: "Mensuel", amount: 19.99, currency, interval: "month", verified }] } } });
        await db.offer.deleteMany({ where: { workspaceId: w.workspaceId } });
        await db.offer.create({ data: { workspaceId: w.workspaceId, productId: product.id, name: "O", price: 19.99, currency: "CAD", marginPct: 70, status: "active" } });
        return (await loadStrategyInput(w.workspaceId))!.offer!.billing;
      };
      expect(await mk(false, "CAD")).toBeNull();
      expect(await mk(true, null)).toBeNull();
      expect(await mk(true, "CAD")).toMatchObject({ interval: "month" });
    });
  });
});

describe("1-2. offres SaaS B2B et B2C : la fiche s'appuie sur l'offre enregistrée, sans règle propre à un produit", () => {
  it("SaaS B2B : le contexte réel (secteur, activité, offre, problème) est dans la fiche ; canaux B2B ; aucun TikTok ni Meta", () => {
    const s = buildStrategy(base());
    expect(s.context).toMatchObject({ industry: "Logiciel de gestion d'activité", country: "Canada", businessDescription: "Un logiciel pour gérer son activité indépendante.", offerDescription: "Gestion des clients, devis et factures.", offerProblem: "Suivre ses revenus sans tableur." });
    const platforms = s.channels.map((c) => c.platform);
    expect(platforms).toEqual(expect.arrayContaining(["google_ads", "seo_content", "linkedin_organic", "email"]));
    expect(platforms).not.toContain("tiktok_ads");
    expect(platforms).not.toContain("meta_ads");
    expect(s.positioning.audience).toMatch(/B2B/);
  });
  it("le moteur ne dépend d'aucun nom de produit : mêmes résultats pour un nom quelconque", () => {
    const a = buildStrategy(base({ offer: { ...base().offer!, name: "FreelanceNexa" } }), new Date(0));
    const b = buildStrategy(base({ offer: { ...base().offer!, name: "Zorglub" } }), new Date(0));
    expect({ ...a, positioning: { ...a.positioning, offer: null } }).toEqual({ ...b, positioning: { ...b.positioning, offer: null } });
  });
  it("B2C : canaux grand public (Meta, Google, TikTok) si le budget le justifie, social organique ; pas de LinkedIn", () => {
    const s = buildStrategy(base({ audience: { name: "Particuliers", type: "b2c" }, goals: { leadsPerMonth: 100, salesPerMonth: 10, adBudgetMonthly: 5000, maxCac: 100 } }));
    const platforms = s.channels.map((c) => c.platform);
    expect(platforms).toEqual(expect.arrayContaining(["meta_ads", "google_ads", "tiktok_ads", "social_organic", "seo_content"]));
    expect(platforms).not.toContain("linkedin_ads");
    expect(platforms).not.toContain("linkedin_organic");
    expect(s.channels.filter((c) => c.kind === "paid").reduce((a, c) => a + c.share, 0)).toBe(100);
  });
});

describe("3-6. marge, coûts et récurrence : aucune valeur inventée", () => {
  it("3. marge inconnue : « Données insuffisantes », aucune marge supposée, aucune alerte de perte", () => {
    for (const marginPct of [undefined, null, 0, 0.28, 150]) {
      const s = buildStrategy(base({ offer: { ...base().offer!, marginPct } }));
      const g = row(s, /Marge brute/)!;
      expect(g.value, String(marginPct)).toBe(INSUFFICIENT);
      expect(g.kind).toBe("insufficient");
      expect(s.funnel.profitPerSale).toBeNull();
      expect(s.funnel.paybackMonths ?? null).toBeNull();
      expect(row(s, /Délai de récupération/)).toBeUndefined();
      expect(row(s, /LTV/)).toBeUndefined(); // sans marge, aucune ligne de valeur vie client trompeuse
      expect(alerts(s)).not.toMatch(/déficitaire/);
      expect(text(s)).not.toMatch(/80 ?%/);
    }
  });
  it("4. marge connue : marge brute estimée = prix × marge ; libellée comme estimation, pas comme marge mesurée ; LTV non calculée", () => {
    const s = buildStrategy(base({ offer: { ...base().offer!, price: 100, marginPct: 40 }, goals: { ...base().goals, maxCac: 20 } }));
    const g = row(s, /Marge brute estimée/)!;
    expect(g.kind).toBe("estimated");
    expect(g.value).toMatch(/40/);
    expect(g.note).toMatch(/estimation/i);
    expect(s.funnel.profitPerSale).toBe(40);
    expect(row(s, /LTV/)!.value).toBe(INSUFFICIENT);
    expect(row(s, /LTV/)!.note).toMatch(/première vente n'est pas une valeur vie client/);
  });
  it("5. CAC supérieur à la marge du premier mois, facturation inconnue : alerte « déficitaire sauf achats répétés », sans calcul de récupération", () => {
    const s = buildStrategy(base()); // prix 19,99 × 10 % = 2,00 ; CAC maximal 10
    expect(s.funnel.profitPerSale).toBeCloseTo(1.999, 5);
    expect(alerts(s)).toMatch(/déficitaire/);
    expect(alerts(s)).toMatch(/mode de facturation .* n'est pas connu/);
    expect(row(s, /Délai de récupération/)).toBeUndefined();
  });
  it("6. revenus récurrents mensuels : délai de récupération calculé, formulé en mois et non comme une perte ; la marge du premier mois n'est pas une LTV", () => {
    const s = buildStrategy(base({ offer: { ...base().offer!, billing: MONTHLY } }));
    expect(s.funnel.paybackMonths).toBeCloseTo(10 / 1.999, 5);
    expect(row(s, /Délai de récupération/)!.value).toBe("5,0 mois");
    expect(row(s, /Délai de récupération/)!.note).toMatch(/aucune résiliation/);
    expect(alerts(s)).toMatch(/~5,0 mois d'abonnement/);
    expect(alerts(s)).not.toMatch(/déficitaire/);
    expect(row(s, /LTV/)!.value).toBe(INSUFFICIENT);
  });
  it("6 bis. abonnement annuel : marge mensuelle = marge de la période ÷ 12", () => {
    const s = buildStrategy(base({ offer: { ...base().offer!, price: 240, marginPct: 50, billing: { interval: "year", planName: "An", source: "product_pricing" } }, goals: { ...base().goals, maxCac: 50 } }));
    expect(s.funnel.profitPerSale).toBe(120);
    expect(s.funnel.monthlyMargin).toBe(10);
    expect(s.funnel.paybackMonths).toBe(5);
  });
  it("formules : taux = ventes ÷ leads ; CPL maximal = CAC maximal × taux ; ventes nécessaires = CA ÷ prix (arrondi au supérieur)", () => {
    const s = buildStrategy(base({ offer: { ...base().offer!, price: 1000, marginPct: 20 }, goals: { leadsPerMonth: 100, salesPerMonth: 10, adBudgetMonthly: 1000, maxCac: 250, revenueGoal: 2500 } }));
    expect(s.funnel.requiredCloseRate).toBeCloseTo(0.1, 10);
    expect(s.funnel.maxCpl).toBeCloseTo(25, 10);
    expect(s.funnel.leadsFromBudget).toBeCloseTo(40, 10);
    expect(s.funnel.salesNeededForRevenue).toBe(3);
  });
  it("9. zéro lead (ou zéro vente, zéro CAC) : aucun résultat numérique trompeur (ni NaN, ni Infinity, ni taux)", () => {
    for (const goals of [{ leadsPerMonth: 0, salesPerMonth: 10, adBudgetMonthly: 1500, maxCac: 10 }, { leadsPerMonth: 100, salesPerMonth: 0, adBudgetMonthly: 1500, maxCac: 10 }, { leadsPerMonth: 100, salesPerMonth: 10, adBudgetMonthly: 1500, maxCac: 0 }, {}]) {
      const s = buildStrategy(base({ goals }));
      expect(s.funnel.maxCpl, JSON.stringify(goals)).toBeNull();
      expect(s.funnel.leadsFromBudget).toBeNull();
      expect(text(s)).not.toMatch(/NaN|Infinity/);
    }
  });
  it("objectif de ventes supérieur à l'objectif de leads : aucun taux supérieur à 100 %, alerte explicite", () => {
    const s = buildStrategy(base({ goals: { leadsPerMonth: 10, salesPerMonth: 50, adBudgetMonthly: 1500, maxCac: 10 } }));
    expect(s.funnel.requiredCloseRate).toBeNull();
    expect(s.funnel.maxCpl).toBeNull();
    expect(alerts(s)).toMatch(/dépasse l'objectif de leads/);
  });
});

describe("7. différenciation, avantages et objections : jamais de fonctionnalité non vérifiée présentée comme existante", () => {
  it("rien n'est renseigné : rubriques signalées à compléter, aucun contenu inventé", () => {
    const s = buildStrategy(base({ offer: { ...base().offer!, differentiation: null, advantages: [] }, audience: { name: "A", type: "b2b" } }));
    expect(s.positioning.differentiation).toBeNull();
    expect(s.positioning.advantages).toEqual([]);
    expect(s.positioning.objections).toEqual([]);
    expect(s.positioning.gaps!.join(" | ")).toMatch(/Différenciation non renseignée/);
    expect(s.positioning.gaps!.join(" | ")).toMatch(/Avantages non renseignés/);
    expect(s.positioning.gaps!.join(" | ")).toMatch(/Objections non renseignées/);
    expect(s.missing.join(" | ")).not.toMatch(/différenciation|objection|avantage/i); // les lacunes de positionnement ne se mélangent pas aux données chiffrées manquantes
  });
  it("fonctionnalités du produit : seules celles vérifiées comptent comme faits ; les autres restent « à confirmer »", () => {
    const s = buildStrategy(base({ offer: { ...base().offer!, differentiation: null, advantages: [] }, product: { name: "P", valueProposition: "Tout au même endroit", features: [{ text: "Devis", verified: true }, { text: "Rappels automatiques", verified: false }], objections: [{ objection: "Trop cher", answer: "Réponse non approuvée", approved: false }] } }));
    expect(s.positioning.verifiedFeatures).toEqual(["Devis"]);
    expect(s.positioning.unverifiedFeatures).toEqual(["Rappels automatiques"]);
    expect(s.positioning.advantages).toEqual([]); // les fonctionnalités ne sont pas recopiées comme avantages saisis
    expect(s.positioning.gaps!.join(" | ")).not.toMatch(/Avantages non renseignés/); // une fonctionnalité vérifiée existe
    expect(s.positioning.objections).toEqual(expect.arrayContaining(["Déjà un tableur", "Trop cher"]));
    expect(JSON.stringify(s.positioning)).not.toMatch(/Réponse non approuvée/);
    expect(s.context!.valueProposition).toBe("Tout au même endroit");
  });
});

describe("8. budget publicitaire nul ou inconnu : aucune plateforme payante imposée", () => {
  for (const adBudgetMonthly of [0, null, undefined]) {
    it(`budget ${String(adBudgetMonthly)} : canaux organiques seulement, aucune répartition de budget`, () => {
      const s = buildStrategy(base({ goals: { ...base().goals, adBudgetMonthly } }));
      expect(s.channels.length).toBeGreaterThan(0);
      expect(s.channels.every((c) => c.kind === "organic" && c.share === 0 && c.basis === "hypothesis")).toBe(true);
      expect(s.firstSteps.join(" | ")).not.toMatch(/campagne de test|dépenses quotidiennes/);
      expect(s.missing.join(" | ")).toMatch(/budget publicitaire/);
      expect(s.assumptions.join(" | ")).toMatch(/organiques n'ont pas de budget/);
    });
  }
  it("petit budget : une seule plateforme payante ; budget large : plusieurs ; la répartition vaut 100 % du budget payant et reste une hypothèse", () => {
    const small = buildStrategy(base({ goals: { leadsPerMonth: 100, salesPerMonth: 10, adBudgetMonthly: 15, maxCac: 10 } })); // CPL max 1 → 15 leads attendus : moins de deux tests de 10 leads, donc une plateforme
    expect(small.channels.filter((c) => c.kind === "paid")).toHaveLength(1);
    expect(small.channels.find((c) => c.kind === "paid")!.share).toBe(100);
    const wide = buildStrategy(base({ goals: { leadsPerMonth: 100, salesPerMonth: 10, adBudgetMonthly: 5000, maxCac: 100 } }));
    expect(wide.channels.filter((c) => c.kind === "paid").length).toBe(2);
    expect(wide.channels.filter((c) => c.kind === "paid").reduce((a, c) => a + c.share, 0)).toBe(100);
    expect(wide.assumptions.join(" | ")).toMatch(/hypothèse de départ/);
  });
  it("coût par lead inconnu avec un budget : une seule plateforme à tester", () => {
    const s = buildStrategy(base({ goals: { adBudgetMonthly: 2000 } }));
    expect(s.channels.filter((c) => c.kind === "paid")).toHaveLength(1);
  });
});

describe("cohérence onboarding → offre enregistrée → fiche → analyse IA → analytics", () => {
  class Spy implements AIProvider {
    readonly id = "spy"; readonly model = "spy-1"; calls: AIRequest[] = [];
    constructor(private reply: object) {}
    async complete(req: AIRequest) { this.calls.push(req); return { text: JSON.stringify(this.reply), model: this.model, promptTokens: 10, completionTokens: 10 }; }
  }
  beforeEach(async () => { await resetDb(); setAIProviderForTests(null); });

  async function seed() {
    const w = await makeWorkspace("Cohérence");
    await db.workspace.update({ where: { id: w.workspaceId }, data: { industry: "Logiciel de gestion", country: "Canada", description: "Logiciel de facturation pour indépendants.", currency: "CAD", goalLeadsPerMonth: 100, goalSalesPerMonth: 10, adBudgetMonthly: 800, maxCac: 12, revenueGoal: 1000 } });
    const product = await db.product.create({ data: { workspaceId: w.workspaceId, name: "Produit", slug: `p-${Date.now()}`, valueProposition: "Facturer sans effort", problemsSolved: ["Factures en retard"],
      features: [{ text: "Facturation", verified: true }, { text: "Paiement en ligne", verified: false }], pricing: { plans: [{ name: "Mensuel", amount: 19.99, currency: "CAD", interval: "month", verified: true }] } } });
    const aud = await db.audience.create({ data: { workspaceId: w.workspaceId, name: "Freelances", type: "b2b", location: "Québec", problems: "Factures impayées", objections: "Trop cher; Déjà un outil" } });
    await db.offer.create({ data: { workspaceId: w.workspaceId, productId: product.id, audienceId: aud.id, name: "Offre", description: "Facturation et suivi des paiements.", price: 19.99, currency: "CAD", marginPct: 70, status: "active", advantages: ["Simple"], differentiation: "Pensé pour le Québec" } });
    return w;
  }

  it("la fiche reflète exactement l'espace de travail, l'offre et le produit enregistrés ; objectifs identiques à ceux des analytics", async () => {
    const w = await seed();
    const input = (await loadStrategyInput(w.workspaceId))!;
    const ws = await db.workspace.findUniqueOrThrow({ where: { id: w.workspaceId } });
    expect(input.goals).toEqual({ leadsPerMonth: ws.goalLeadsPerMonth, salesPerMonth: ws.goalSalesPerMonth, adBudgetMonthly: ws.adBudgetMonthly, maxCac: ws.maxCac, revenueGoal: ws.revenueGoal });
    expect(input.offer).toMatchObject({ name: "Offre", price: 19.99, marginPct: 70, differentiation: "Pensé pour le Québec", description: "Facturation et suivi des paiements.", billing: { interval: "month", planName: "Mensuel" } });
    const s = buildStrategy(input);
    expect(s.context).toMatchObject({ industry: "Logiciel de gestion", country: "Canada", businessDescription: "Logiciel de facturation pour indépendants.", billing: { interval: "month" } });
    expect(s.funnel.profitPerSale).toBeCloseTo(13.993, 5);
    expect(s.funnel.paybackMonths).toBeCloseTo(12 / 13.993, 5);
    expect(s.positioning).toMatchObject({ differentiation: "Pensé pour le Québec", verifiedFeatures: ["Facturation"], unverifiedFeatures: ["Paiement en ligne"] });
    expect(s.positioning.objections).toEqual(["Trop cher", "Déjà un outil"]);
  });
  it("sans produit rattaché, la récurrence reste inconnue (rien n'est deviné)", async () => {
    const w = await makeWorkspace("Sans produit");
    await db.offer.create({ data: { workspaceId: w.workspaceId, name: "O", price: 19.99, currency: "CAD", marginPct: 10, status: "active" } });
    const input = (await loadStrategyInput(w.workspaceId))!;
    expect(input.offer!.billing).toBeNull();
    expect(buildStrategy(input).funnel.paybackMonths ?? null).toBeNull();
  });
  it("l'offre d'un autre espace n'est jamais lue", async () => {
    const a = await seed(); const b = await makeWorkspace("Autre");
    const input = (await loadStrategyInput(b.workspaceId))!;
    expect(input.offer).toBeNull(); expect(input.product).toBeNull();
    expect((await loadStrategyInput(a.workspaceId))!.offer!.name).toBe("Offre");
  });
  it("l'analyse IA reçoit le contexte réel de l'offre et les règles anti-invention ; ses hypothèses sont validées par le schéma", async () => {
    const w = await seed();
    const spy = new Spy({ summary: "Résumé", channelRationale: [], risks: [], firstSteps: [], differentiationHypotheses: ["H1"], advantageHypotheses: ["H2"], objectionHypotheses: ["H3"], missingInfo: ["Q1"] });
    setAIProviderForTests(spy);
    const sheet = buildStrategy((await loadStrategyInput(w.workspaceId))!);
    const n = (await generateStrategyNarrative(w.workspaceId, w.userId, sheet))!;
    expect(spy.calls).toHaveLength(1);
    const p = spy.calls[0].prompt;
    for (const needle of ["Logiciel de gestion", "Logiciel de facturation pour indépendants.", "Facturation et suivi des paiements.", "verifiedFeatures", "unverifiedFeatures", "Paiement en ligne"]) expect(p).toContain(needle);
    expect(p).toMatch(/n'est que l'outil utilisé/);
    expect(p).toMatch(/n'affirme JAMAIS qu'une fonctionnalité existe/);
    expect(p).toMatch(/Données insuffisantes/);
    expect(n).toMatchObject({ differentiationHypotheses: ["H1"], advantageHypotheses: ["H2"], objectionHypotheses: ["H3"], missingInfo: ["Q1"] });
  });
  it("une ancienne réponse IA (sans les nouveaux champs) reste valide", () => {
    const r = strategyNarrativeSchema.parse({ summary: "S", channelRationale: [], risks: [], firstSteps: [] });
    expect(r.differentiationHypotheses).toEqual([]); expect(r.missingInfo).toEqual([]);
  });
});
