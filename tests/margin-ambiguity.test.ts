// Passe 1 / section 5 : une marge ambiguë (0 < marge < 1, unité probablement fausse) ou invalide ne produit aucune affirmation de rentabilité.
// Convention : marginPct est un POURCENTAGE entier (28 = 28 %).
import { describe, expect, it } from "vitest";
import { buildStrategy } from "@/lib/strategy";
import { buildRecommendations, roasFloorForMargin, validMarginPct, type RecCampaign } from "@/lib/recommendations";
import { computeKpis } from "@/lib/kpi";

const strategy = (marginPct: unknown, maxCac = 130) =>
  buildStrategy({ companyName: "X", currency: "EUR", offer: { name: "O", price: 1000, marginPct: marginPct as number | null | undefined }, audience: { name: "A", type: "b2c" }, goals: { maxCac, leadsPerMonth: 100, salesPerMonth: 10, adBudgetMonthly: 1500 } });
const grossLine = (s: ReturnType<typeof strategy>) => s.economics.find((e) => /Marge brute/.test(e.label));
const alertText = (s: ReturnType<typeof strategy>) => s.alerts.map((a) => a.text).join(" || ");

describe("roasFloorForMargin : aucun point mort trompeur", () => {
  it("marge ambiguë 0,28 et 0,3 → null (même si un appelant oublie la garde externe)", () => {
    expect(roasFloorForMargin(0.28)).toBeNull();
    expect(roasFloorForMargin(0.3)).toBeNull();
    expect(roasFloorForMargin(0.99)).toBeNull();
  });
  it("absente, nulle, négative, > 100, NaN, texte → null (contrat actuel)", () => {
    for (const m of [undefined, null, 0, -5, 150, 100.01, Number.NaN, Infinity, "28"]) expect(roasFloorForMargin(m), String(m)).toBeNull();
  });
  it("marges fiables : calcul inchangé (28 → 3,5714 ; 28,55 → 100/28,55 ; 50 → 2 ; 100 → 1 ; 1 → 100)", () => {
    expect(roasFloorForMargin(28)).toBeCloseTo(100 / 28, 10);
    expect(roasFloorForMargin(28.55)).toBeCloseTo(100 / 28.55, 10);
    expect(roasFloorForMargin(50)).toBe(2);
    expect(roasFloorForMargin(100)).toBe(1);
    expect(roasFloorForMargin(1)).toBe(100);
  });
  it("contrat de validMarginPct inchangé (0,1 reste « valide » : l'ambiguïté est traitée à part)", () => {
    for (const m of [0.1, 0.28, 28, 28.55, 100]) expect(validMarginPct(m)).toBe(m);
    for (const m of [0, -5, 150, undefined]) expect(validMarginPct(m)).toBeNull();
  });
});

describe("buildStrategy : marge brute et affirmations de perte", () => {
  for (const m of [0.28, 0.3]) {
    it(`marge ambiguë ${m}, prix 1 000, CAC maximal 130 : aucune « marge brute par vente », aucune alerte « déficitaire »`, () => {
      const s = strategy(m);
      expect(grossLine(s), JSON.stringify(s.economics)).toBeUndefined();
      expect(s.funnel.profitPerSale).toBeNull();
      expect(alertText(s)).not.toMatch(/déficitaire|marge brute par vente/i);
      expect(alertText(s)).not.toMatch(/2,80|2,8 /);
    });
    it(`marge ambiguë ${m} : signalée comme donnée à vérifier (liste des données manquantes), pas comme valeur exploitable`, () => {
      const s = strategy(m);
      expect(s.missing.join(" | ")).toMatch(/marge approximative.*ambigu/i);
    });
  }
  it("marge absente ou nulle : aucune marge brute ; signalée manquante (comportement existant)", () => {
    for (const m of [undefined, null, 0]) {
      const s = strategy(m);
      expect(grossLine(s), String(m)).toBeUndefined();
      expect(s.missing.join(" | "), String(m)).toMatch(/marge approximative/);
      expect(alertText(s), String(m)).not.toMatch(/déficitaire/);
    }
  });
  it("marge invalide 150 : aucune marge brute supérieure au prix, aucune alerte financière sur cette base", () => {
    const s = strategy(150);
    expect(grossLine(s), JSON.stringify(s.economics)).toBeUndefined();
    expect(s.funnel.profitPerSale).toBeNull();
    expect(alertText(s)).not.toMatch(/déficitaire/);
  });
  it("marge valide 28 : marge brute 280 € conservée ; alerte « déficitaire » conservée si le CAC maximal (300) la dépasse", () => {
    const s = strategy(28, 300);
    expect(grossLine(s)!.value).toMatch(/280/);
    expect(s.funnel.profitPerSale).toBe(280);
    expect(alertText(s)).toMatch(/déficitaire/);
    expect(alertText(strategy(28, 130))).not.toMatch(/déficitaire/);
    expect(s.missing.join(" | ")).not.toMatch(/marge approximative/);
  });
  it("marge valide 28,55 : marge brute 285,50 € ; marge 1 et 100 inchangées (10 € et 1 000 €)", () => {
    expect(grossLine(strategy(28.55))!.value).toMatch(/28[56]/); // l'affichage existant arrondit à l'euro (fmt) ; la valeur exacte est vérifiée ci-dessous
    expect(strategy(28.55).funnel.profitPerSale).toBeCloseTo(285.5, 10);
    expect(strategy(1).funnel.profitPerSale).toBe(10);
    expect(strategy(100).funnel.profitPerSale).toBe(1000);
  });
});

describe("recommandations : la marge ambiguë ne produit toujours aucun point mort (non-régression B1-1)", () => {
  const k = (t: object) => computeKpis({ spend: 1000, impressions: 30000, clicks: 600, leads: 40, qualifiedLeads: 0, customers: 5, revenue: 4000, customersWithRevenue: 5, ...t });
  const recs = (margin: unknown, roasRevenue = 4000) => buildRecommendations({
    overall: k({}), previous: null, campaigns: [{ id: "c1", name: "c1", status: "active", kpis: k({ revenue: roasRevenue }), marginPct: margin } as RecCampaign],
    pages: [{ id: "p", name: "P", views: 1500, leads: 60 }], goals: { maxCac: 400 }, staleNewLeads: 0, periodDays: 30,
  } as never);
  it("0,28 et 0,3 : jamais de scaling ni de « sous le point mort », même avec un facteur injecté", () => {
    for (const m of [0.28, 0.3]) for (const rev of [2000, 4000, 10_000]) {
      const all = buildRecommendations({ overall: k({}), previous: null, campaigns: [{ id: "c1", name: "c1", status: "active", kpis: k({ revenue: rev }), marginPct: m } as RecCampaign], pages: [{ id: "p", name: "P", views: 1500, leads: 60 }], goals: { maxCac: 400 }, staleNewLeads: 0, periodDays: 30, scalingSafetyFactor: 1.2 } as never);
      expect(all.some((r) => r.type === "scaling"), `${m}/${rev}`).toBe(false);
      expect(all.some((r) => /Sous le point mort|point mort ou au-dessus/.test(r.title)), `${m}/${rev}`).toBe(false);
    }
  });
  it("marge valide 28,55 : le signal « sous le point mort » reste calculé sur 100/28,55 = 3,50", () => {
    const r = recs(28.55, 3000).find((x) => x.id === "revenue_signal:c1")!;
    expect(r.title).toMatch(/Sous le point mort/);
    expect(r.evidence.join(" ")).toMatch(/3,50/);
  });
});
