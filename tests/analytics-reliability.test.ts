// Fiabilité du dashboard et des recommandations — tests des corrections (anciens « échecs attendus » convertis en tests normaux).
// Unité de Offer.marginPct : POURCENT (0–100) du prix de vente ; plancher théorique de rentabilité : ROAS ≥ 100 / marginPct, seulement
// si 0 < marginPct ≤ 100 et fini. Aucun coefficient de sécurité ni seuil commercial n'est ajouté ici.
import { describe, expect, it } from "vitest";
import { buildDemo, DEMO_AMOUNTS } from "@/lib/demo-data";
import { buildRecommendations, REC_THRESHOLDS, roasFloorForMargin, trackingState, validMarginPct, type RecCampaign, type RecInput, type RecPage } from "@/lib/recommendations";
import { acquisitionHealth, computeKpis, fmtDec, fmtPct, fmtRatio, type Totals } from "@/lib/kpi";

const demo = buildDemo();
const rec = (id: string) => demo.recommendations.find((r) => r.id === id);
const sumC = (k: "spend" | "impressions" | "clicks" | "leads" | "qualifiedLeads" | "customers" | "revenue") => demo.campaigns.reduce((s, c) => s + c.totals[k], 0);

const kpisOf = (t: Partial<Totals>) =>
  computeKpis({ spend: 0, impressions: 0, clicks: 0, leads: 0, qualifiedLeads: 0, customers: 0, revenue: 0, customersWithRevenue: 0, ...t });
const goodPages: RecPage[] = [{ id: "p", name: "Page", views: 1500, leads: 60 }];
const input = (campaigns: RecCampaign[], over: Partial<RecInput> = {}): RecInput => ({
  overall: kpisOf({ spend: 3000, impressions: 100_000, clicks: 2000, leads: 100, customers: 10, revenue: 20_000, customersWithRevenue: 10 }),
  previous: null, campaigns, pages: goodPages, goals: { maxCac: 400 }, staleNewLeads: 0, currency: "EUR", periodDays: 30, ...over,
});
const campaign = (id: string, status: string, t: Partial<Totals>, marginPct?: unknown): RecCampaign =>
  ({ id, name: id, status, kpis: kpisOf(t), ...(marginPct === undefined ? {} : { marginPct }) }) as RecCampaign;
const scaling = (roas: number, margin?: unknown) => campaign("c1", "active", { spend: 1000, impressions: 30_000, clicks: 600, leads: 40, customers: 5, revenue: roas * 1000, customersWithRevenue: 5 }, margin);
const ids = (c: RecCampaign, over?: Partial<RecInput> & { scalingSafetyFactor?: number | null }) => buildRecommendations(input([c], over)).map((r) => r.id);

describe("démo : réconciliation (global = attribué + non attribué)", () => {
  const fields = ["spend", "impressions", "clicks", "qualifiedLeads", "leads", "customers", "revenue"] as const;
  it("chaque total global est la somme des campagnes et du lot non attribué explicite", () => {
    for (const f of fields) expect(demo.totals[f], f).toBeCloseTo(sumC(f) + demo.unattributed[f], 6);
  });
  it("le périmètre attribué est exactement la somme des campagnes", () => {
    for (const f of fields) expect(demo.attributed[f], f).toBeCloseTo(sumC(f), 6);
  });
  it("le global n'est jamais inférieur à la somme des campagnes (impressions, clics, dépenses, leads)", () => {
    for (const f of ["impressions", "clicks", "spend", "leads"] as const) expect(demo.totals[f]).toBeGreaterThanOrEqual(sumC(f));
  });
  it("la série quotidienne totalise exactement les chiffres globaux", () => {
    const s = (k: "clicks" | "impressions" | "leads" | "spend") => demo.series.reduce((a, p) => a + p[k], 0);
    expect(s("clicks")).toBe(demo.totals.clicks);
    expect(s("impressions")).toBe(demo.totals.impressions);
    expect(s("leads")).toBe(demo.totals.leads);
    expect(s("spend")).toBeCloseTo(demo.totals.spend, 6);
    expect(demo.series).toHaveLength(30);
  });
  it("aucun client ni chiffre d'affaires n'est attribué artificiellement au lot non attribué", () => {
    expect(demo.unattributed.customers).toBe(0);
    expect(demo.unattributed.revenue).toBe(0);
    expect(demo.unattributed.leads).toBeGreaterThan(0);
  });
  it("devis, chiffre d'affaires réalisé et CAC des campagnes sont des notions distinctes et explicites", () => {
    expect(DEMO_AMOUNTS.quote).toBe(5200);
    expect(DEMO_AMOUNTS.realizedPerClient).toBe(540);
    expect(demo.totals.revenue).toBe(9 * DEMO_AMOUNTS.realizedPerClient);
    expect(demo.attributedKpis.cac).toBeCloseTo(1490 / 9, 6); // 165,56 € : suppose les 9 clients attribués aux campagnes
    expect(demo.notes.join(" ")).toMatch(/Montants distincts/);
    expect(demo.notes.join(" ")).toMatch(/165,56/);
    expect(demo.goals.maxCac).toBe(130); // plafond inchangé
  });
  it("la qualification reste présentée comme automatique (aucun modèle d'IA appelé)", () => {
    expect(demo.notes.join(" ")).toMatch(/qualification est automatique/);
    expect(demo.qualification.criteria.some((c) => c.basis === "fact")).toBe(true);
    expect(demo.qualification.criteria.some((c) => c.basis === "inference")).toBe(true);
  });
});

describe("recommandations de la démo (corrigées)", () => {
  it("Google (CPL 8,82 €, sous sa propre référence de 9,79 €) n'est plus signalé « CPL trop élevé »", () => {
    expect(demo.recommendations.map((r) => r.id)).not.toContain("cpl_high:demo-1");
    expect(demo.campaigns[0].kpis.cpl!).toBeLessThan((130 * 7) / 93);
  });
  it("Meta (14 leads, 2 clients) reste signalé mais en priorité basse, avec l'échantillon et le caractère indicatif", () => {
    const m = rec("cpl_high:demo-2")!;
    expect(m.priority).toBe("low");
    expect(m.evidence.join(" ")).toMatch(/insuffisant/);
    expect(m.impact).toMatch(/Estimation indicative/);
    expect(m.problem).toMatch(/indicative/);
  });
  it("TikTok, déjà en pause, ne reçoit jamais « mettez la campagne en pause »", () => {
    const t = rec("underperforming:demo-3")!;
    expect(t.action).not.toMatch(/mettez la campagne en pause/i);
  });
  it("le suivi douteux (640 visites pour 1 494 clics) est signalé avant toute décision budgétaire", () => {
    expect(rec("tracking_check")).toBeDefined();
    expect(rec("underperforming:demo-3")!.action).toMatch(/Vérifiez d'abord le suivi/);
    expect(rec("underperforming:demo-3")!.priority).not.toBe("high");
  });
  it("sans marge renseignée, la démo n'affirme aucun scaling : signal de chiffre d'affaires et limite affichée", () => {
    expect(demo.recommendations.some((r) => r.type === "scaling")).toBe(false);
    const s = rec("revenue_signal:demo-1")!;
    expect(s.priority).toBe("low");
    expect(s.evidence.join(" ")).toMatch(/ROAS sur chiffre d'affaires/);
    expect(s.evidence.join(" ")).toMatch(/marge de l'offre absente ou invalide/);
  });
  it("la landing page (11 leads sur 640 visites) n'est pas jugée faible : écart non significatif", () => {
    expect(demo.recommendations.some((r) => r.type === "landing_weak")).toBe(false);
  });
});

describe("CPL de référence par campagne et petits échantillons", () => {
  const overall = kpisOf({ spend: 1000, clicks: 1000, leads: 100, customers: 10, revenue: 5000, customersWithRevenue: 10, impressions: 100_000 });
  const run = (c: RecCampaign, over: Partial<RecInput> = {}) => buildRecommendations(input([c, campaign("other", "active", { spend: 500, clicks: 500, leads: 50, customers: 5, revenue: 2500, customersWithRevenue: 5, impressions: 50_000 })], { overall, attributed: overall, ...over })).find((r) => r.id === "cpl_high:c1");
  it("avec au moins 5 clients, la référence est propre à la campagne (CAC max × son taux de closing)", () => {
    // 100 leads, 10 clients, 1 000 € → CPL 10 ; référence = 400 × 10/100 = 40 → pas d'alerte
    expect(run(campaign("c1", "active", { spend: 1000, clicks: 1000, leads: 100, customers: 10, revenue: 5000, customersWithRevenue: 10, impressions: 100_000 }))).toBeUndefined();
  });
  it("avec moins de 5 clients, la référence du périmètre attribué est utilisée, marquée indicative", () => {
    const r = run(campaign("c1", "active", { spend: 2000, clicks: 400, leads: 40, customers: 4, revenue: 1000, customersWithRevenue: 4, impressions: 50_000 }), { goals: { maxCac: 100 } })!;
    expect(r.problem).toMatch(/périmètre rattaché/);
    expect(r.problem).toMatch(/indicative/);
  });
  it("priorité haute seulement si 30 leads OU 5 clients ; sinon priorité basse (seuils explicites)", () => {
    expect(REC_THRESHOLDS.minLeadsForPriority).toBe(30);
    expect(REC_THRESHOLDS.minCustomersForPriority).toBe(5);
    const big = run(campaign("c1", "active", { spend: 6000, clicks: 600, leads: 30, customers: 3, revenue: 900, customersWithRevenue: 3, impressions: 60_000 }), { goals: { maxCac: 100 } })!; // CPL 200 ≫ 1,5 × réf.
    const small = run(campaign("c1", "active", { spend: 580, clicks: 90, leads: 29, customers: 3, revenue: 900, customersWithRevenue: 3, impressions: 9000 }), { goals: { maxCac: 100 } })!; // CPL 20, 29 leads, 3 clients
    expect(big.priority).toBe("high");
    expect(small.priority).toBe("low");
  });
  it("l'impact financier est toujours présenté comme une estimation", () => {
    const r = run(campaign("c1", "active", { spend: 6000, clicks: 600, leads: 30, customers: 3, revenue: 900, customersWithRevenue: 3, impressions: 60_000 }), { goals: { maxCac: 100 } })!;
    expect(r.impact).toMatch(/Estimation/);
  });
});

describe("campagne sans lead : pause, campagne déjà en pause, diagnostic du suivi", () => {
  const dead = (status: string) => campaign("c1", status, { spend: 300, impressions: 20_000, clicks: 200, leads: 0 });
  const overall = kpisOf({ spend: 300, impressions: 20_000, clicks: 1000, leads: 0 });
  const act = (status: string, pages: RecPage[], extra: Partial<RecInput> = {}) => buildRecommendations(input([dead(status)], { overall, pages, ...extra })).find((r) => r.id === "underperforming:c1");
  it("suivi plausible + campagne active : pause recommandée, priorité haute", () => {
    const r = act("active", [{ id: "p", name: "P", views: 600, leads: 0 }])!;
    expect(r.action).toMatch(/^Mettez la campagne en pause/);
    expect(r.priority).toBe("high");
  });
  it("suivi plausible + campagne déjà en pause : jamais « pause », priorité basse", () => {
    const r = act("paused", [{ id: "p", name: "P", views: 600, leads: 0 }])!;
    expect(r.action).not.toMatch(/mettez la campagne en pause/i);
    expect(r.action).toMatch(/déjà en pause/);
    expect(r.priority).toBe("low");
  });
  it("suivi douteux (visites < 50 % des clics) : vérifier le suivi d'abord, jamais de pause", () => {
    const r = act("active", [{ id: "p", name: "P", views: 120, leads: 0 }])!;
    expect(r.action).toMatch(/Vérifiez d'abord le suivi/);
    expect(r.action).not.toMatch(/Mettez la campagne en pause/);
    expect(r.priority).toBe("medium");
  });
  it("suivi absent (aucune visite) : vérifier le suivi d'abord", () => {
    expect(act("active", [{ id: "p", name: "P", views: 0, leads: 0 }])!.action).toMatch(/Vérifiez d'abord le suivi/);
  });
  it("échantillon insuffisant : pas assez de clics pour attendre des leads → aucune recommandation", () => {
    const few = buildRecommendations(input([campaign("c1", "active", { spend: 50, impressions: 3000, clicks: 40, leads: 0 })], { overall: kpisOf({ spend: 50, impressions: 3000, clicks: 40 }), pages: [{ id: "p", name: "P", views: 40, leads: 0 }] }));
    expect(few.some((r) => r.id === "underperforming:c1")).toBe(false);
    expect(REC_THRESHOLDS.minClicksNoReference).toBe(100);
  });
  it("seuil au rythme de référence : au moins 5 leads attendus", () => {
    // cvr de référence 5 % : 100 clics → 5 leads attendus (limite incluse) ; 99 clics → 4,95 : insuffisant
    const ref = { overall: kpisOf({ spend: 1000, impressions: 90_000, clicks: 2000, leads: 100, customers: 5, revenue: 2500, customersWithRevenue: 5 }) };
    const mk = (clicks: number) => buildRecommendations(input([campaign("c1", "active", { spend: 100, impressions: 10_000, clicks, leads: 0 })], { ...ref, pages: [{ id: "p", name: "P", views: 5000, leads: 100 }] })).some((r) => r.id === "underperforming:c1");
    expect(mk(100)).toBe(true);
    expect(mk(99)).toBe(false);
  });
  it("trackingState : seuils explicites (visites ≥ 50 % des clics, au moins 30 clics)", () => {
    const pg = (views: number): RecPage[] => [{ id: "p", name: "P", views, leads: 0 }];
    expect(trackingState(pg(500), 29)).toBe("unknown");
    expect(trackingState(pg(0), 1000)).toBe("missing");
    expect(trackingState([], 1000)).toBe("missing");
    expect(trackingState(pg(499), 1000)).toBe("doubtful");
    expect(trackingState(pg(500), 1000)).toBe("plausible");
  });
});

describe("landing page : écart significatif seulement", () => {
  const pageRecs = (views: number, leads: number) => buildRecommendations(input([], { pages: [{ id: "p", name: "P", views, leads }], overall: kpisOf({ spend: 10, clicks: views, impressions: views * 10 }) })).filter((r) => r.type === "landing_weak");
  it("640 visites, 11 leads (1,72 %) : non significatif", () => expect(pageRecs(640, 11)).toHaveLength(0));
  it("400 visites, 2 leads : significatif", () => expect(pageRecs(400, 2)).toHaveLength(1));
  it("150 visites, 0 lead : significatif, priorité haute ; 100 visites, 0 lead : pas assez de preuves", () => {
    expect(pageRecs(150, 0)[0]?.priority).toBe("high");
    expect(pageRecs(100, 0)).toHaveLength(0);
  });
  it("moins de 50 visites : jamais", () => expect(pageRecs(49, 0)).toHaveLength(0));
});

describe("scaling et marge (plancher théorique ROAS ≥ 100 / marge %)", () => {
  it("validité de la marge : finie, strictement positive, au plus 100", () => {
    for (const m of [undefined, null, 0, -5, Number.NaN, Infinity, 150, "28", {}]) expect(validMarginPct(m), String(m)).toBeNull();
    for (const m of [0.1, 28, 100]) expect(validMarginPct(m)).toBe(m);
  });
  it("arithmétique du plancher (pourcent) : 28 % → 3,571 ; 50 % → 2 ; 100 % → 1 ; invalide → null", () => {
    expect(roasFloorForMargin(28)).toBeCloseTo(3.5714, 4);
    expect(roasFloorForMargin(50)).toBe(2);
    expect(roasFloorForMargin(100)).toBe(1);
    expect(roasFloorForMargin(0)).toBeNull();
    expect(roasFloorForMargin(null)).toBeNull();
  });
  // Corrigé (lot B1-1, R8) : « ROAS ≥ plancher ⇒ scaling » était le défaut. Sans facteur de sécurité validé, aucun scaling ; avec un facteur injecté (test seulement), seuil = max(3, plancher × facteur).
  it("marge valide 28 % : ROAS 3,6 (≥ plancher 3,571) et 4,61 → PAS de scaling par défaut (facteur de sécurité non défini)", () => {
    for (const roas of [3.6, 4.61]) {
      expect(ids(scaling(roas, 28))).not.toContain("scaling:c1");
      expect(ids(scaling(roas, 28))).toContain("revenue_signal:c1");
    }
  });
  it("marge valide 28 %, facteur 1,2 injecté (seuil 4,286) : ROAS 3,6 → pas de scaling ; 4,61 → scaling", () => {
    expect(ids(scaling(3.6, 28), { scalingSafetyFactor: 1.2 })).not.toContain("scaling:c1");
    expect(ids(scaling(4.61, 28), { scalingSafetyFactor: 1.2 })).toContain("scaling:c1");
  });
  it("marge valide 28 % : ROAS 3,5 ou 3,2 (≥ 3 mais < plancher) → pas de scaling, signal « sous le seuil de rentabilité »", () => {
    for (const roas of [3.5, 3.2]) {
      const got = ids(scaling(roas, 28));
      expect(got).not.toContain("scaling:c1");
      expect(got).toContain("revenue_signal:c1");
    }
    const r = buildRecommendations(input([scaling(3.2, 28)])).find((x) => x.id === "revenue_signal:c1")!;
    expect(r.title).toMatch(/Sous le point mort/); // titre reformulé (lot B1-1) ; l'assertion de fond (signal « sous le seuil ») est conservée
    expect(r.priority).toBe("medium");
  });
  it("marge valide élevée (90 %) : le ROAS minimal historique de 3 reste exigé (facteur 1,2 injecté) ; par défaut, jamais de scaling", () => {
    expect(ids(scaling(2.5, 90))).not.toContain("scaling:c1");
    expect(ids(scaling(2.5, 90), { scalingSafetyFactor: 1.2 })).not.toContain("scaling:c1");
    expect(ids(scaling(3.1, 90), { scalingSafetyFactor: 1.2 })).toContain("scaling:c1");
    expect(ids(scaling(3.1, 90))).not.toContain("scaling:c1");
  });
  for (const [label, margin] of [["absente", undefined], ["null", null], ["nulle (0)", 0], ["négative (−5)", -5], ["NaN", Number.NaN], ["infinie", Infinity], ["> 100 (150)", 150], ["texte", "28"]] as const) {
    it(`marge ${label} : aucun scaling affirmatif, même avec un ROAS de 4 ; limite affichée`, () => {
      const got = buildRecommendations(input([scaling(4, margin)]));
      expect(got.some((r) => r.id === "scaling:c1")).toBe(false);
      const sig = got.find((r) => r.id === "revenue_signal:c1")!;
      expect(sig.priority).toBe("low");
      expect(sig.problem).toMatch(/on ne peut pas dire si la campagne est rentable/);
    });
  }
  // Corrigé (lot B1-1, R21) : avec une marge valide, un ROAS sous le point mort est signalé (« Sous le point mort ») ; sans marge, le silence est conservé.
  it("ROAS inférieur à 3 : jamais de scaling ; marge valide → signal « Sous le point mort » ; sans marge → aucun signal ; ROI non fiable : rien", () => {
    expect(ids(scaling(2.9, 28))).not.toEqual(expect.arrayContaining(["scaling:c1"]));
    expect(ids(scaling(2.9, 28))).toContain("revenue_signal:c1");
    expect(ids(scaling(2.9)).some((i) => i.startsWith("revenue_signal"))).toBe(false);
    const unreliable = campaign("c1", "active", { spend: 1000, impressions: 30_000, clicks: 600, leads: 40, customers: 5, revenue: 5000, customersWithRevenue: 3 }, 28);
    expect(ids(unreliable).some((i) => i.startsWith("scaling") || i.startsWith("revenue_signal"))).toBe(false);
  });
});

describe("formats français et valeurs indisponibles", () => {
  it("pourcentages et ratios avec virgule décimale", () => {
    expect(fmtPct(0.0831)).toBe("8,3 %");
    expect(fmtPct(0.0172, 2)).toBe("1,72 %");
    expect(fmtPct(2.206, 0)).toBe("221 %");
    expect(fmtRatio(4.6098)).toBe("4,61");
    expect(fmtDec(3.5714, 3)).toBe("3,571");
  });
  it("grands nombres groupés à la française", () => {
    expect(fmtPct(17, 0)).toMatch(/^1\s700 %$/);
  });
  it("valeurs indisponibles : « — » (jamais 0 inventé)", () => {
    expect(fmtPct(null)).toBe("—");
    expect(fmtRatio(null)).toBe("—");
  });
  it("aucun point décimal dans les textes produits (santé et recommandations de la démo)", () => {
    const text = [...demo.health.reasons, ...demo.recommendations.flatMap((r) => [r.problem, r.impact, r.action, ...r.evidence])].join(" | ");
    expect(text).not.toMatch(/\d\.\d/);
  });
  it("santé : ROAS et objectifs formatés à la française, précisés « sur chiffre d'affaires »", () => {
    const h = acquisitionHealth(kpisOf({ spend: 1000, impressions: 90_000, clicks: 900, leads: 100, customers: 10, revenue: 3210, customersWithRevenue: 10 }), { goalLeadsPerMonth: 100 }, 30);
    expect(h.reasons.join(" ")).toMatch(/ROAS de 3,21 \(sur chiffre d'affaires/);
  });
  it("divisions par zéro et dénominateurs nuls : métriques indisponibles", () => {
    const k = kpisOf({ spend: 100, clicks: 0, impressions: 0, leads: 0, customers: 0 });
    expect(k.cpl).toBeNull();
    expect(k.cac).toBeNull();
    expect(k.cvr).toBeNull();
    expect(k.roas).toBeNull();
    expect(k.roi).toBeNull();
  });
});
