import { describe, expect, it } from "vitest";
import { acquisitionHealth, computeKpis, emptyTotals, type Totals } from "@/lib/kpi";

const base = (o: Partial<Totals> = {}): Totals => ({ ...emptyTotals(), ...o });

describe("computeKpis", () => {
  it("calcule CTR, CPC, CPL, CVR, CAC, ROAS, ROI à partir de données complètes", () => {
    const k = computeKpis(base({ spend: 1000, impressions: 100_000, clicks: 2000, leads: 100, qualifiedLeads: 40, customers: 10, revenue: 5000, customersWithRevenue: 10 }));
    expect(k.ctr).toBeCloseTo(0.02);
    expect(k.cpc).toBeCloseTo(0.5);
    expect(k.cpl).toBeCloseTo(10);
    expect(k.cvr).toBeCloseTo(0.05);
    expect(k.cac).toBeCloseTo(100);
    expect(k.roas).toBeCloseTo(5);
    expect(k.roi).toBeCloseTo(4);
    expect(k.qualificationRate).toBeCloseTo(0.4);
    expect(k.closeRate).toBeCloseTo(0.1);
    expect(k.roiReliable).toBe(true);
  });

  it("renvoie null (jamais 0 inventé) quand le dénominateur est nul", () => {
    const k = computeKpis(base());
    for (const key of ["ctr", "cpc", "cpl", "cvr", "cac", "roas", "roi", "qualificationRate", "closeRate"] as const) expect(k[key]).toBeNull();
  });

  it("ne calcule pas le CPL/CAC sans dépense", () => {
    const k = computeKpis(base({ leads: 5, customers: 1, revenue: 300, customersWithRevenue: 1 }));
    expect(k.cpl).toBeNull(); // dépense = 0 → 0 ≠ « gratuit »
    expect(k.cac).toBeNull();
    expect(k.roas).toBeNull();
    expect(k.roi).toBeNull();
  });

  it("ROI non fiable si un client gagné n'a pas de revenu renseigné", () => {
    const k = computeKpis(base({ spend: 500, leads: 20, customers: 2, revenue: 400, customersWithRevenue: 1 }));
    expect(k.roiReliable).toBe(false);
    expect(k.roi).toBeNull();
    expect(k.roas).toBeCloseTo(0.8); // le ROAS reste calculable sur le revenu connu
  });

  it("ROI négatif possible", () => {
    const k = computeKpis(base({ spend: 1000, leads: 20, customers: 2, revenue: 600, customersWithRevenue: 2 }));
    expect(k.roi).toBeCloseTo(-0.4);
  });
});

describe("acquisitionHealth", () => {
  const goals = { goalLeadsPerMonth: 30, maxCac: 100, adBudgetMonthly: 1000 };

  it("unknown sans aucune donnée", () => {
    expect(acquisitionHealth(computeKpis(base()), goals, 30).status).toBe("unknown");
  });

  it("good quand CAC sous le maximum et objectif de leads tenu", () => {
    const k = computeKpis(base({ spend: 800, impressions: 50_000, clicks: 1000, leads: 40, qualifiedLeads: 20, customers: 10, revenue: 3000, customersWithRevenue: 10 }));
    expect(acquisitionHealth(k, goals, 30).status).toBe("good");
  });

  it("watch quand le CAC dépasse légèrement le maximum", () => {
    const k = computeKpis(base({ spend: 1100, clicks: 800, leads: 35, customers: 10, revenue: 0 }));
    expect(acquisitionHealth(k, goals, 30).status).toBe("watch");
  });

  it("bad quand le CAC dépasse de plus de 25 %", () => {
    const k = computeKpis(base({ spend: 1500, clicks: 800, leads: 35, customers: 10 }));
    expect(acquisitionHealth(k, goals, 30).status).toBe("bad");
  });

  it("bad quand des clics ne produisent aucun lead", () => {
    const k = computeKpis(base({ spend: 300, clicks: 120, impressions: 9000 }));
    const h = acquisitionHealth(k, goals, 30);
    expect(h.status).toBe("bad");
    expect(h.reasons.join(" ")).toMatch(/aucune conversion/);
  });

  it("proratise l'objectif de leads sur la période", () => {
    const k = computeKpis(base({ spend: 100, clicks: 40, leads: 2 }));
    // 7 jours : cible = 30 × 7/30 = 7 leads ; 2 leads = 28 % → bad
    expect(acquisitionHealth(k, { goalLeadsPerMonth: 30 }, 7).status).toBe("bad");
  });
});
