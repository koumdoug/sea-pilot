// Lot B1-1 : rentabilité et scaling (R8, R9, R21).
// Convention d'unité constatée : Offer.marginPct est un POURCENT entier (28 = 28 %), de 0 à 100 ; point mort ROAS = 100 / marginPct.
// SCALING_SAFETY_FACTOR vaut null tant qu'aucun facteur commercial n'a été validé : aucun chemin ne doit alors recommander d'augmenter le budget.
// Un facteur numérique n'est injecté ici que via `scalingSafetyFactor` (entrée de buildRecommendations), jamais en modifiant la valeur par défaut.
import { describe, expect, it } from "vitest";
import * as R from "@/lib/recommendations";
import { computeKpis, type Totals } from "@/lib/kpi";

const kpisOf = (t: Partial<Totals>) =>
  computeKpis({ spend: 0, impressions: 0, clicks: 0, leads: 0, qualifiedLeads: 0, customers: 0, revenue: 0, customersWithRevenue: 0, ...t });
const pages: R.RecPage[] = [{ id: "p", name: "Page", views: 1500, leads: 60 }];
const input = (campaigns: R.RecCampaign[], over: Partial<R.RecInput> & { scalingSafetyFactor?: number | null } = {}) =>
  ({ overall: kpisOf({ spend: 3000, impressions: 100_000, clicks: 2000, leads: 100, customers: 10, revenue: 20_000, customersWithRevenue: 10 }),
     previous: null, campaigns, pages, goals: { maxCac: 400 }, staleNewLeads: 0, currency: "EUR", periodDays: 30, ...over }) as R.RecInput;

/** Campagne dépensant 1 000 € ; échantillon réglable ; revenu = ROAS × 1 000. */
const camp = (roas: number, margin?: unknown, sample: { leads: number; customers: number } = { leads: 40, customers: 5 }, status = "active") =>
  ({ id: "c1", name: "c1", status, ...(margin === undefined ? {} : { marginPct: margin }),
     kpis: kpisOf({ spend: 1000, impressions: 30_000, clicks: 600, leads: sample.leads, customers: sample.customers, revenue: roas * 1000, customersWithRevenue: sample.customers }) }) as R.RecCampaign;
const recs = (c: R.RecCampaign, over: Parameters<typeof input>[1] = {}) => R.buildRecommendations(input([c], over));
const find = (c: R.RecCampaign, over?: Parameters<typeof input>[1]) => recs(c, over).find((r) => r.id === "scaling:c1" || r.id === "revenue_signal:c1");
const hasScaling = (c: R.RecCampaign, over?: Parameters<typeof input>[1]) => recs(c, over).some((r) => r.type === "scaling");

describe("facteur de sécurité : valeur par défaut et injection", () => {
  it("SCALING_SAFETY_FACTOR est null (aucun facteur commercial validé)", () => {
    expect((R as Record<string, unknown>).SCALING_SAFETY_FACTOR).toBeNull();
  });
  it("facteur null par défaut : aucun scaling, quel que soit le ROAS (4, 10, 100) et la marge valide (25, 28, 30, 100)", () => {
    for (const margin of [25, 28, 30, 100]) for (const roas of [4, 10, 100]) expect(hasScaling(camp(roas, margin)), `marge ${margin} ROAS ${roas}`).toBe(false);
  });
  it("facteur null explicitement injecté : même résultat que la valeur par défaut", () => {
    expect(hasScaling(camp(100, 28), { scalingSafetyFactor: null })).toBe(false);
  });
  it("injecter un facteur dans un appel ne change pas le comportement par défaut des appels suivants", () => {
    expect(hasScaling(camp(10, 28), { scalingSafetyFactor: 1.2 })).toBe(true);
    expect(hasScaling(camp(10, 28))).toBe(false);
    expect((R as Record<string, unknown>).SCALING_SAFETY_FACTOR).toBeNull();
  });
});

describe("état B : au point mort ou au-dessus, facteur non défini", () => {
  const sentence = "Au point mort ou au-dessus, marge de sécurité non définie ; scaling non recommandé.";
  it("point mort exact (marge 25, ROAS 4,00) : pas de scaling, message B", () => {
    const r = find(camp(4, 25))!;
    expect(r.type).toBe("revenue_signal");
    expect(r.problem).toContain(sentence);
  });
  it("ROAS 3,6 contre point mort 3,571 (marge 28) : pas de scaling (ancien comportement accepté à tort), message B", () => {
    const r = find(camp(3.6, 28))!;
    expect(r.type).toBe("revenue_signal");
    expect(r.problem).toContain(sentence);
  });
  it("marge 30, ROAS 3,34 (+0,3 % au-dessus du point mort 3,333) : pas de scaling", () => {
    expect(find(camp(3.34, 30))!.type).toBe("revenue_signal");
  });
  it("ROAS bien au-dessus (10) : le message n'invite jamais à augmenter le budget", () => {
    const r = find(camp(10, 28))!;
    expect(r.type).toBe("revenue_signal");
    expect(`${r.problem} ${r.impact} ${r.action}`).not.toMatch(/augmentez le budget|augmenter le budget de|scaling recommand/i);
    expect(r.priority).toBe("low");
  });
});

describe("état C : facteur défini et valide", () => {
  const f = 1.2; // valeur de test uniquement
  it("seuil = max(3, point mort × facteur) : marge 25 → point mort 4 → seuil 4,8", () => {
    expect(hasScaling(camp(4.79, 25), { scalingSafetyFactor: f })).toBe(false);
    expect(hasScaling(camp(4.8, 25), { scalingSafetyFactor: f })).toBe(true);
    expect(hasScaling(camp(4.81, 25), { scalingSafetyFactor: f })).toBe(true);
  });
  it("au point mort exact avec facteur 1,2 : pas de scaling (marge de sécurité non atteinte)", () => {
    const r = find(camp(4, 25), { scalingSafetyFactor: f })!;
    expect(r.type).toBe("revenue_signal");
    expect(r.problem).toMatch(/marge de sécurité/);
    expect(r.problem).toMatch(/non atteinte/);
  });
  it("marge élevée (90 %) : point mort 1,11 × 1,2 = 1,33 < 3 → le plancher historique de 3 reste exigé", () => {
    expect(hasScaling(camp(2.9, 90), { scalingSafetyFactor: f })).toBe(false);
    expect(hasScaling(camp(3, 90), { scalingSafetyFactor: f })).toBe(true);
  });
  it("échantillon exigé : au moins 30 leads ET 5 clients", () => {
    expect(hasScaling(camp(10, 25, { leads: 30, customers: 5 }), { scalingSafetyFactor: f })).toBe(true);
    expect(hasScaling(camp(10, 25, { leads: 29, customers: 5 }), { scalingSafetyFactor: f })).toBe(false);
    expect(hasScaling(camp(10, 25, { leads: 30, customers: 4 }), { scalingSafetyFactor: f })).toBe(false);
    expect(hasScaling(camp(10, 25, { leads: 30, customers: 1 }), { scalingSafetyFactor: f })).toBe(false);
    expect(hasScaling(camp(10, 25, { leads: 7, customers: 5 }), { scalingSafetyFactor: f })).toBe(false);
    expect(hasScaling(camp(10, 25, { leads: 20, customers: 5 }), { scalingSafetyFactor: f })).toBe(false);
  });
  it("échantillon insuffisant avec ROAS suffisant : pas de silence, signal prudent qui nomme la limite", () => {
    const r = find(camp(10, 25, { leads: 20, customers: 5 }), { scalingSafetyFactor: f })!;
    expect(r.type).toBe("revenue_signal");
    expect(r.problem).toMatch(/échantillon/i);
    expect(r.priority).toBe("low");
  });
  it("facteur invalide (< 1, 0, négatif, NaN, Infinity) : traité comme non défini, jamais de scaling", () => {
    for (const bad of [0.9, 0, -1, Number.NaN, Infinity]) expect(hasScaling(camp(10, 25), { scalingSafetyFactor: bad }), String(bad)).toBe(false);
  });
  it("le scaling émis reste une estimation prudente avec échantillon affiché", () => {
    const r = recs(camp(10, 25), { scalingSafetyFactor: f }).find((x) => x.type === "scaling")!;
    expect(r.evidence.join(" ")).toMatch(/Échantillon : 40 lead\(s\), 5 client\(s\)/);
    expect(r.evidence.join(" ")).toMatch(/facteur/i);
  });
});

describe("état A : ROAS sous le point mort (R21)", () => {
  it("marge 28 (point mort 3,571), ROAS 2,9 : signal « Sous le point mort », pas de scaling", () => {
    const r = find(camp(2.9, 28))!;
    expect(r).toBeDefined();
    expect(r.type).toBe("revenue_signal");
    expect(r.title).toMatch(/Sous le point mort/);
    expect(hasScaling(camp(2.9, 28), { scalingSafetyFactor: 1.2 })).toBe(false);
  });
  it("ROAS 2,0 et ROAS 1,0 avec marge 28 : toujours signalé", () => {
    for (const roas of [2, 1]) expect(find(camp(roas, 28))!.title, String(roas)).toMatch(/Sous le point mort/);
  });
  it("jamais d'affirmation sans réserve de perte : formulation d'estimation, pas « vous perdez de l'argent »", () => {
    const r = find(camp(2.9, 28))!;
    const txt = `${r.title} ${r.problem} ${r.impact} ${r.action}`;
    expect(txt).not.toMatch(/perd(ez|s|ent)? de l.argent|déficitaire|à perte/i);
    expect(txt).toMatch(/estimation|théorique/i);
  });
  it("priorité selon le niveau de preuve : échantillon suffisant → medium ; insuffisant → low", () => {
    expect(find(camp(2.9, 28, { leads: 40, customers: 5 }))!.priority).toBe("medium");
    expect(find(camp(2.9, 28, { leads: 30, customers: 1 }))!.priority).toBe("low");
    expect(find(camp(2.9, 28, { leads: 7, customers: 5 }))!.priority).toBe("low");
    expect(find(camp(2.9, 28, { leads: 20, customers: 5 }))!.priority).toBe("low");
  });
  it("l'échantillon est affiché dans la preuve", () => {
    expect(find(camp(2.9, 28, { leads: 7, customers: 5 }))!.evidence.join(" ")).toMatch(/Échantillon : 7 lead\(s\), 5 client\(s\)/);
  });
  it("ROI non fiable (un client sans montant) : aucun signal de rentabilité", () => {
    const c = { ...camp(2.9, 28), kpis: kpisOf({ spend: 1000, clicks: 600, leads: 40, customers: 5, revenue: 2900, customersWithRevenue: 3 }) } as R.RecCampaign;
    expect(find(c)).toBeUndefined();
  });
  it("aucun client ou aucun revenu : aucun signal de rentabilité (autres règles s'en chargent)", () => {
    const c = { ...camp(0, 28), kpis: kpisOf({ spend: 1000, clicks: 600, leads: 40 }) } as R.RecCampaign;
    expect(find(c)).toBeUndefined();
  });
});

describe("marge absente, nulle, invalide ou ambiguë : aucune affirmation de rentabilité", () => {
  for (const [label, margin] of [["absente", undefined], ["null", null], ["0", 0], ["négative", -5], ["> 100 (150)", 150], ["NaN", Number.NaN], ["texte", "28"]] as const) {
    it(`marge ${label} : ni scaling, ni « sous le point mort », ni « au point mort » ; limite affichée avec ROAS 4`, () => {
      const all = recs(camp(4, margin), { scalingSafetyFactor: 1.2 });
      expect(all.some((r) => r.type === "scaling")).toBe(false);
      const sig = all.find((r) => r.id === "revenue_signal:c1")!;
      expect(sig.title).not.toMatch(/Sous le point mort|point mort ou au-dessus/);
      expect(sig.problem).toMatch(/on ne peut pas dire si la campagne est rentable/);
    });
    it(`marge ${label} : ROAS 2 ne produit aucun signal de rentabilité`, () => {
      expect(find(camp(2, margin))).toBeUndefined();
    });
  }
  it("marge 0,28 (probable fraction saisie par erreur) : ambiguë, jamais un « point mort » de 357", () => {
    for (const roas of [2, 4, 10]) {
      const all = recs(camp(roas, 0.28), { scalingSafetyFactor: 1.2 });
      expect(all.some((r) => r.type === "scaling"), `ROAS ${roas}`).toBe(false);
      const txt = all.filter((r) => r.type === "revenue_signal").map((r) => `${r.title} ${r.problem} ${r.evidence.join(" ")}`).join(" ");
      expect(txt, `ROAS ${roas}`).not.toMatch(/Sous le point mort|357/);
    }
    const sig = find(camp(4, 0.28))!;
    expect(sig.problem).toMatch(/erreur d'unité/i);
    expect(sig.problem).toMatch(/on ne peut pas dire si la campagne est rentable/);
  });
  it("marge 100 : point mort 1 → ROAS 4 reste sans scaling avec facteur null", () => {
    const r = find(camp(4, 100))!;
    expect(r.type).toBe("revenue_signal");
    expect(r.problem).toContain("marge de sécurité non définie");
  });
});

describe("un seul signal de rentabilité par campagne, sans contradiction", () => {
  it("jamais deux recommandations scaling/revenue_signal pour la même campagne", () => {
    for (const roas of [0.5, 2, 2.9, 3.6, 4, 5, 10]) for (const margin of [undefined, 0.28, 25, 28, 30, 100]) for (const fac of [undefined, null, 1.2]) {
      const n = recs(camp(roas, margin), fac === undefined ? {} : { scalingSafetyFactor: fac }).filter((r) => r.campaignId === "c1" && /scaling|revenue_signal/.test(r.type)).length;
      expect(n, `ROAS ${roas} marge ${margin} facteur ${fac}`).toBeLessThanOrEqual(1);
    }
  });
});
