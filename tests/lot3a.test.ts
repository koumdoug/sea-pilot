// Lot 3A : texte du cas B, seuils d'échantillon (ET), recommandation unique « Données insuffisantes » par campagne, statuts de campagne (R4/R5).
// Les résultats attendus viennent des exigences du lot, pas du comportement du code. Seuils opérationnels PROVISOIRES (« à valider »), pas des vérités statistiques.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildRecommendations, REC_THRESHOLDS, SCALING_SAFETY_FACTOR, type Recommendation, type RecCampaign, type RecInput, type RecPage } from "@/lib/recommendations";
import { computeKpis, type Totals } from "@/lib/kpi";

const kpisOf = (t: Partial<Totals>) => computeKpis({ spend: 0, impressions: 0, clicks: 0, leads: 0, qualifiedLeads: 0, customers: 0, revenue: 0, customersWithRevenue: 0, ...t });
const okPages: RecPage[] = [{ id: "p", name: "Page", views: 5000, leads: 100 }];
const input = (over: Partial<RecInput> & { scalingSafetyFactor?: number | null } = {}) =>
  ({ overall: kpisOf({ spend: 3000, impressions: 100_000, clicks: 2000, leads: 100, customers: 10, revenue: 20_000, customersWithRevenue: 10 }), previous: null, campaigns: [], pages: okPages, goals: { maxCac: 400 }, staleNewLeads: 0, currency: "EUR", periodDays: 30, ...over }) as RecInput;
const camp = (t: Partial<Totals>, status = "active", id = "c1", marginPct?: unknown) => ({ id, name: id, status, kpis: kpisOf(t), ...(marginPct === undefined ? {} : { marginPct }) }) as RecCampaign;
const text = (r: Recommendation) => [r.title, r.problem, ...r.evidence, r.impact, r.action].join(" | ");
const byId = (recs: Recommendation[], id: string) => recs.find((r) => r.id === id);

// ───────────────────────────── Cas B : texte client exact ─────────────────────────────
const B_TEXT = "Sur la période, la marge brute couvre les dépenses publicitaires de cette campagne. SEA Pilot n’émet pas encore de recommandation de hausse de budget : appuyez-vous sur vos marges réelles et sur l’évolution semaine après semaine.";
const OLD_B = "Au point mort ou au-dessus, marge de sécurité non définie ; scaling non recommandé.";
const profit = (roas: number, margin?: unknown, sample = { leads: 40, customers: 5 }, over: Partial<RecInput> & { scalingSafetyFactor?: number | null } = {}) =>
  buildRecommendations(input({ campaigns: [camp({ spend: 1000, impressions: 30_000, clicks: 600, leads: sample.leads, customers: sample.customers, revenue: roas * 1000, customersWithRevenue: sample.customers }, "active", "c1", margin)], ...over }));
const signal = (recs: Recommendation[]) => byId(recs, "revenue_signal:c1");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? sourceFiles(p) : /\.(ts|tsx)$/.test(f) ? [p] : []; });
}

describe("cas B — formulation client exacte (point mort atteint, marge valide, facteur de sécurité non défini)", () => {
  it("SCALING_SAFETY_FACTOR reste null et aucune recommandation de hausse de budget n'est émise", () => {
    expect(SCALING_SAFETY_FACTOR).toBeNull();
    for (const roas of [4, 10, 100]) expect(profit(roas, 25).some((r) => r.type === "scaling"), `ROAS ${roas}`).toBe(false);
  });
  it("échantillon suffisant : le problème est EXACTEMENT la nouvelle phrase (point mort exact, au-dessus, très au-dessus)", () => {
    for (const [roas, margin] of [[4, 25], [3.6, 28], [10, 28]] as const) {
      const r = signal(profit(roas, margin))!;
      expect(r.type).toBe("revenue_signal");
      expect(r.problem, `ROAS ${roas} marge ${margin}`).toBe(B_TEXT);
      expect(r.priority).toBe("low");
    }
  });
  it("la phrase utilise les apostrophes typographiques ’ (U+2019) exactes", () => {
    const p = signal(profit(4, 25))!.problem;
    expect(p).toContain("n’émet");
    expect(p).toContain("l’évolution");
    expect(p).not.toContain("n'émet");
    expect(p).not.toContain("l'évolution");
  });
  it("échantillon insuffisant (moins de 30 leads OU moins de 5 clients) : la nouvelle phrase ET une réserve DISTINCTE d'insuffisance, priorité basse", () => {
    for (const sample of [{ leads: 7, customers: 5 }, { leads: 29, customers: 5 }, { leads: 30, customers: 4 }, { leads: 30, customers: 1 }]) {
      const r = signal(profit(10, 28, sample))!;
      expect(r.problem.startsWith(B_TEXT), JSON.stringify(sample)).toBe(true);
      const rest = r.problem.slice(B_TEXT.length).trim();
      expect(rest, JSON.stringify(sample)).toMatch(/Échantillon insuffisant/);
      expect(rest, JSON.stringify(sample)).toMatch(/il manque/);
      expect(r.priority).toBe("low");
    }
  });
  it("la phrase n'apparaît QUE si la marge est valide et le ROAS atteint le point mort", () => {
    for (const margin of [undefined, null, 0, 150, -5, 0.28, 0.3, "28"]) {
      const all = profit(4, margin);
      expect(all.some((r) => text(r).includes("la marge brute couvre les dépenses")), `marge ${String(margin)}`).toBe(false);
    }
    const below = signal(profit(2.9, 28))!; // point mort 3,571 : sous le point mort
    expect(below.title).toMatch(/Sous le point mort/);
    expect(text(below)).not.toContain("la marge brute couvre les dépenses");
    const unreliable = buildRecommendations(input({ campaigns: [camp({ spend: 1000, impressions: 30_000, clicks: 600, leads: 40, customers: 5, revenue: 5000, customersWithRevenue: 3 }, "active", "c1", 28)] }));
    expect(signal(unreliable)).toBeUndefined();
  });
  it("aucun texte du cas B n'invite à augmenter le budget ni n'affirme une rentabilité, un bénéfice ou une rentabilité nette garantie", () => {
    for (const sample of [{ leads: 40, customers: 5 }, { leads: 7, customers: 5 }]) {
      const t = text(signal(profit(10, 28, sample))!);
      expect(t).not.toMatch(/\b(augmentez|accroissez|doublez|montez)\b/i);
      expect(t).not.toMatch(/à augmenter|hausse recommandée|passez à/i);
      expect(t).not.toMatch(/(campagne|elle) (est|devient|reste) rentable/i);
      expect(t).not.toMatch(/génère (nécessairement )?un bénéfice|dégage un bénéfice|bénéfice garanti|rentabilité nette (est )?garantie/i);
    }
  });
  it("l'ancienne formulation a disparu de tout le code de production (src/)", () => {
    const hits = sourceFiles(join(process.cwd(), "src")).filter((f) => readFileSync(f, "utf8").includes("marge de sécurité non définie"));
    expect(hits).toEqual([]);
    expect(buildRecommendations(input({ campaigns: [camp({ spend: 1000, clicks: 600, impressions: 30_000, leads: 40, customers: 5, revenue: 10_000, customersWithRevenue: 5 }, "active", "c1", 28)] })).some((r) => text(r).includes(OLD_B))).toBe(false);
  });
});

// ───────────────────────────── Seuils d'échantillon ─────────────────────────────
const SAMPLES: [number, number, boolean][] = [[30, 1, false], [7, 5, false], [20, 5, false], [30, 5, true], [29, 5, false], [30, 4, false]];
const cplRec = (leads: number, customers: number) => {
  const attributed = kpisOf({ spend: 1000, impressions: 90_000, clicks: 1000, leads: 100, customers: 10, revenue: 5000, customersWithRevenue: 10 });
  const c = camp({ spend: leads * 100, impressions: 60_000, clicks: leads * 10, leads, customers, revenue: customers * 500, customersWithRevenue: customers });
  return byId(buildRecommendations(input({ overall: attributed, attributed, campaigns: [c], goals: { maxCac: 100 } })), "cpl_high:c1");
};
const cacRec = (leads: number, customers: number) =>
  byId(buildRecommendations(input({ overall: kpisOf({ spend: customers * 150, impressions: 50_000, clicks: 1000, leads, customers, revenue: customers * 300, customersWithRevenue: customers }), goals: { maxCac: 100 } })), "cac_high");

describe("seuils d'échantillon : 30 leads ET 5 clients (provisoires, à valider)", () => {
  it("constantes centralisées dans REC_THRESHOLDS", () => {
    expect(REC_THRESHOLDS.minLeadsForPriority).toBe(30);
    expect(REC_THRESHOLDS.minCustomersForPriority).toBe(5);
    expect((REC_THRESHOLDS as Record<string, unknown>).ctrMinImpressions).toBe(1000);
    expect((REC_THRESHOLDS as Record<string, unknown>).ctrMinClicks).toBe(30);
    expect((REC_THRESHOLDS as Record<string, unknown>).minPreviousLeadsForDrop).toBe(10);
  });
  for (const [leads, customers, ok] of SAMPLES) {
    it(`${leads} leads / ${customers} client(s) : ${ok ? "suffisant" : "insuffisant"} — cpl_high ${ok ? "haute" : "basse"}, cac_high ${ok ? "haute" : "basse"}`, () => {
      const cpl = cplRec(leads, customers)!;
      const cac = cacRec(leads, customers)!;
      expect(cpl, "cpl_high émis").toBeDefined();
      expect(cac, "cac_high émis").toBeDefined();
      if (ok) { expect(cac.priority).toBe("high"); expect(cpl.priority).toBe("high"); }
      else { expect(cpl.priority).toBe("low"); expect(cac.priority).toBe("low"); }
    });
  }
  it("l'alerte explicite le volume manquant : 30/1 → 4 clients ; 20/5 → 10 leads ; 7/5 → 23 leads ; 29/5 → 1 lead ; 30/4 → 1 client ; 29/4 → les deux", () => {
    const expectMissing = (leads: number, customers: number, re: RegExp) => {
      expect(cplRec(leads, customers)!.evidence.join(" "), `cpl ${leads}/${customers}`).toMatch(re);
      expect(cacRec(leads, customers)!.evidence.join(" "), `cac ${leads}/${customers}`).toMatch(re);
    };
    expectMissing(30, 1, /il manque 4 client\(s\)/);
    expectMissing(20, 5, /il manque 10 lead\(s\)/);
    expectMissing(7, 5, /il manque 23 lead\(s\)/);
    expectMissing(29, 5, /il manque 1 lead\(s\)/);
    expectMissing(30, 4, /il manque 1 client\(s\)/);
    expectMissing(29, 4, /il manque 1 lead\(s\) et 1 client\(s\)/);
  });
  it("un échantillon suffisant ne mentionne aucun volume manquant", () => {
    expect(cplRec(30, 5)!.evidence.join(" ")).not.toMatch(/il manque/);
    expect(cacRec(30, 5)!.evidence.join(" ")).not.toMatch(/il manque/);
  });
  it("scaling (facteur 1,2 injecté dans le test) : émis seulement à 30 leads ET 5 clients ; sinon signal bas qui nomme le volume manquant", () => {
    for (const [leads, customers, ok] of SAMPLES) {
      const recs = profit(10, 25, { leads, customers }, { scalingSafetyFactor: 1.2 });
      expect(recs.some((r) => r.type === "scaling"), `${leads}/${customers}`).toBe(ok);
      if (!ok) { const s = signal(recs)!; expect(s.priority).toBe("low"); expect(s.problem).toMatch(/il manque/); }
      else expect(byId(recs, "scaling:c1")!.priority).not.toBe("low"); // priorité haute/moyenne réservée à l'échantillon suffisant
    }
  });
});

describe("ctr_low : au moins 1 000 impressions ET 30 clics", () => {
  const ctr = (impressions: number, clicks: number) => buildRecommendations(input({ campaigns: [camp({ spend: 100, impressions, clicks, leads: 5 })] })).some((r) => r.id === "ctr_low:c1");
  it("30 clics : CTR 0,49 % → conclusion ; 29 clics : aucune conclusion statistique", () => {
    expect(ctr(6100, 30)).toBe(true);
    expect(ctr(6100, 29)).toBe(false);
    expect(ctr(14_500, 29)).toBe(false); // CTR 0,2 % mais seulement 29 clics
  });
  it("1 000 impressions et 1 clic (CTR 0,1 %) : aucune conclusion", () => {
    expect(ctr(1000, 1)).toBe(false);
    expect(ctr(999, 1)).toBe(false);
  });
  it("limite exacte 1 000 impressions / 30 clics : évalué (CTR 3 % : pas bas) ; 999 impressions / 30 clics : non évalué", () => {
    expect(ctr(1000, 30)).toBe(false); // évalué, CTR 3 % non faible
    const evalued = (impressions: number, clicks: number) => !/CTR : il manque/.test(text(byId(buildRecommendations(input({ campaigns: [camp({ spend: 100, impressions, clicks, leads: 1 })] })), "insufficient_data:c1") ?? ({ title: "", problem: "", evidence: [], impact: "", action: "" } as unknown as Recommendation)));
    expect(evalued(1000, 30)).toBe(true);
    expect(evalued(999, 30)).toBe(false);
    expect(evalued(1000, 29)).toBe(false);
  });
});

describe("lead_drop : au moins 10 leads sur la période précédente", () => {
  const drop = (prev: number, cur: number) => buildRecommendations(input({ overall: kpisOf({ spend: 100, clicks: 200, impressions: 5000, leads: cur }), previous: kpisOf({ spend: 100, clicks: 200, impressions: 5000, leads: prev }) })).find((r) => r.id === "lead_drop");
  it("9 leads précédents : aucune conclusion de baisse ; 10 : conclusion possible", () => {
    expect(drop(9, 2)).toBeUndefined();
    expect(drop(10, 3)).toBeDefined();
    expect(drop(10, 3)!.priority).toBe("high"); // −70 %
    expect(drop(10, 6)!.priority).toBe("medium"); // −40 %
  });
  it("règle de baisse existante inchangée : 10 → 7 (−30 %) n'est pas une baisse suffisante", () => {
    expect(drop(10, 7)).toBeUndefined();
  });
});

describe("alertes techniques : jamais déclassées par un échantillon faible", () => {
  const tiny = () => buildRecommendations(input({
    overall: kpisOf({ spend: 40, impressions: 2000, clicks: 100, leads: 2 }),
    pages: [{ id: "p", name: "P", views: 10, leads: 0 }], staleNewLeads: 6, campaigns: [camp({ spend: 40, impressions: 2000, clicks: 100, leads: 2 })],
  }));
  it("suivi douteux : priorité inchangée (moyenne) ; leads non traités ≥ 5 : priorité haute, malgré 2 leads", () => {
    const recs = tiny();
    expect(byId(recs, "tracking_check")!.priority).toBe("medium");
    expect(byId(recs, "stale_leads")!.priority).toBe("high");
  });
  it("aucune visite mesurée : alerte conservée (moyenne) ; la carte « Données insuffisantes » ne la masque pas", () => {
    const recs = buildRecommendations(input({ overall: kpisOf({ spend: 40, impressions: 2000, clicks: 100, leads: 2 }), pages: [{ id: "p", name: "P", views: 0, leads: 0 }], campaigns: [camp({ spend: 40, impressions: 2000, clicks: 100, leads: 2 })] }));
    expect(byId(recs, "no_tracking")!.priority).toBe("medium");
    expect(byId(recs, "insufficient_data:c1")).toBeDefined();
  });
});

// ───────────────────────────── « Données insuffisantes » ─────────────────────────────
const cardOf = (recs: Recommendation[], id = "c1") => byId(recs, `insufficient_data:${id}`);
const run = (campaigns: RecCampaign[], over: Partial<RecInput> = {}) => buildRecommendations(input({ campaigns, ...over }));

describe("recommandation unique « Données insuffisantes » par campagne", () => {
  it("plusieurs règles sous-alimentées : UNE seule carte, priorité basse, qui liste chaque règle et son volume manquant", () => {
    const recs = run([camp({ spend: 50, impressions: 400, clicks: 12, leads: 1 })]);
    const cards = recs.filter((r) => r.type === ("insufficient_data" as Recommendation["type"]) && r.campaignId === "c1");
    expect(cards).toHaveLength(1);
    const c = cards[0];
    expect(c.priority).toBe("low");
    expect(c.title).toMatch(/Données insuffisantes/);
    expect(c.evidence).toHaveLength(2);
    expect(c.evidence.join(" | ")).toMatch(/Coût par lead : il manque 2 lead\(s\)/);
    expect(c.evidence.join(" | ")).toMatch(/CTR : il manque 600 impression\(s\) et 18 clic\(s\)/);
  });
  it("scénario historique (R7) : campagne active, 200 € dépensés, 80 clics, 0 lead : jamais silencieuse — la carte nomme les 20 clics manquants", () => {
    const recs = run([camp({ spend: 200, impressions: 4000, clicks: 80, leads: 0 })], { overall: kpisOf({ spend: 200, impressions: 4000, clicks: 80 }), pages: [{ id: "p", name: "P", views: 60, leads: 0 }] });
    expect(byId(recs, "underperforming:c1")).toBeUndefined();
    const c = cardOf(recs)!;
    expect(c).toBeDefined();
    expect(c.priority).toBe("low");
    expect(c.evidence.join(" | ")).toMatch(/Campagne sans résultat : il manque 20 clic\(s\)/);
    expect(recs.some((r) => r.type === "scaling")).toBe(false);
  });
  it("avec une référence de conversion, le volume manquant se calcule au rythme de référence (5 leads attendus)", () => {
    const ref = kpisOf({ spend: 1000, impressions: 90_000, clicks: 2000, leads: 100, customers: 5, revenue: 2500, customersWithRevenue: 5 });
    const c = cardOf(run([camp({ spend: 100, impressions: 10_000, clicks: 80, leads: 0 })], { overall: ref, pages: [{ id: "p", name: "P", views: 5000, leads: 100 }] }))!;
    expect(c.evidence.join(" | ")).toMatch(/Campagne sans résultat : il manque 20 clic\(s\)/);
  });
  it("limites : 3 leads (coût par lead évaluable) et 1 000 impressions ET 30 clics (CTR évaluable) ne figurent plus dans la carte", () => {
    const at = cardOf(run([camp({ spend: 60, impressions: 1000, clicks: 30, leads: 3 })]));
    expect(at).toBeUndefined();
    const below = cardOf(run([camp({ spend: 60, impressions: 999, clicks: 29, leads: 2 })]))!;
    expect(below.evidence.join(" | ")).toMatch(/Coût par lead : il manque 1 lead\(s\)/);
    expect(below.evidence.join(" | ")).toMatch(/CTR : il manque 1 impression\(s\) et 1 clic\(s\)/);
  });
  it("aucune carte quand toutes les règles sont évaluables ; aucune carte pour une campagne sans aucune donnée ni pour un brouillon sans dépense", () => {
    expect(cardOf(run([camp({ spend: 300, impressions: 20_000, clicks: 600, leads: 20, customers: 4 })]))).toBeUndefined();
    expect(cardOf(run([camp({})]))).toBeUndefined();
    expect(cardOf(run([camp({}, "draft")]))).toBeUndefined();
  });
  it("jamais de doublon avec une recommandation déjà émise pour la même règle (cpl_high bas émis → pas de ligne « coût par lead »)", () => {
    const recs = cplRecAll(5, 1);
    expect(byId(recs, "cpl_high:c1")).toBeDefined();
    const c = cardOf(recs);
    if (c) expect(c.evidence.join(" | ")).not.toMatch(/Coût par lead/);
  });
  it("campagnes distinctes : une carte par campagne, jamais fusionnées, chacune avec ses propres volumes", () => {
    const recs = run([camp({ spend: 50, impressions: 400, clicks: 12, leads: 1 }, "active", "c1"), camp({ spend: 60, impressions: 5000, clicks: 100, leads: 2 }, "active", "c2")]);
    const c1 = cardOf(recs, "c1")!;
    const c2 = cardOf(recs, "c2")!;
    expect(c1).toBeDefined();
    expect(c2).toBeDefined();
    expect(c1.campaignId).toBe("c1");
    expect(c2.campaignId).toBe("c2");
    expect(c1.id).not.toBe(c2.id);
    expect(c1.evidence.join(" | ")).toMatch(/CTR/);
    expect(c2.evidence.join(" | ")).not.toMatch(/CTR/);
    expect(c2.evidence.join(" | ")).toMatch(/Coût par lead : il manque 1 lead\(s\)/);
    expect(recs.filter((r) => r.type === ("insufficient_data" as Recommendation["type"]))).toHaveLength(2);
  });
  it("le texte n'invite pas à augmenter le budget et n'affirme aucune rentabilité", () => {
    const t = text(cardOf(run([camp({ spend: 50, impressions: 400, clicks: 12, leads: 1 })]))!);
    expect(t).not.toMatch(/\b(augmentez|accroissez|doublez|montez)\b/i);
    expect(t).not.toMatch(/est rentable|génère un bénéfice/i);
  });
  it("les alertes techniques et les autres recommandations restent présentes à côté de la carte", () => {
    const recs = run([camp({ spend: 50, impressions: 400, clicks: 40, leads: 1 })], { overall: kpisOf({ spend: 50, impressions: 400, clicks: 40, leads: 1 }), pages: [{ id: "p", name: "P", views: 0, leads: 0 }], staleNewLeads: 3 });
    expect(byId(recs, "no_tracking")).toBeDefined();
    expect(byId(recs, "stale_leads")).toBeDefined();
    expect(cardOf(recs)).toBeDefined();
  });
});
function cplRecAll(leads: number, customers: number): Recommendation[] {
  const attributed = kpisOf({ spend: 1000, impressions: 90_000, clicks: 1000, leads: 100, customers: 10, revenue: 5000, customersWithRevenue: 10 });
  return buildRecommendations(input({ overall: attributed, attributed, campaigns: [camp({ spend: leads * 100, impressions: 60_000, clicks: leads * 10, leads, customers, revenue: customers * 500, customersWithRevenue: customers })], goals: { maxCac: 100 } }));
}

// ───────────────────────────── Statuts de campagne (R4, R5) ─────────────────────────────
describe("statuts de campagne : jamais « Mettez la campagne en pause » pour une campagne non active, textes cohérents avec le statut", () => {
  const overall = kpisOf({ spend: 300, impressions: 20_000, clicks: 1000, leads: 0 });
  const dead = (status: string) => camp({ spend: 300, impressions: 20_000, clicks: 200, leads: 0 }, status);
  const act = (status: string, views: number) => byId(run([dead(status)], { overall, pages: [{ id: "p", name: "P", views, leads: 0 }] }), "underperforming:c1")!;
  const NON_ACTIVE = ["paused", "completed", "archived", "draft", "ready"];
  for (const status of NON_ACTIVE) {
    it(`${status} + suivi plausible : jamais « pause » en action, priorité basse, statut rappelé`, () => {
      const r = act(status, 600);
      expect(r, "recommandation émise").toBeDefined();
      expect(r.action).not.toMatch(/mettez la campagne en pause/i);
      expect(r.priority).toBe("low");
      expect(text(r)).toMatch(/pause|terminée|archivée|brouillon|prête|diffusée/i);
    });
    it(`${status} + suivi douteux : la vérification du suivi reste pertinente mais sans « décision de pause », priorité basse`, () => {
      const r = act(status, 120);
      expect(r.action).toMatch(/Vérifiez d'abord le suivi/);
      expect(text(r)).not.toMatch(/décision de pause|mettez la campagne en pause/i);
      expect(r.priority).toBe("low");
    });
    it(`${status} + suivi absent : même cohérence`, () => {
      const r = act(status, 0);
      expect(text(r)).not.toMatch(/décision de pause|mettez la campagne en pause/i);
      expect(r.priority).toBe("low");
    });
  }
  it("paused : « déjà en pause » (texte propre au statut)", () => {
    expect(act("paused", 600).action).toMatch(/déjà en pause/);
  });
  it("active : comportement conservé — plausible → pause recommandée (haute) ; douteux → vérifier le suivi avant toute décision de pause (moyenne)", () => {
    expect(act("active", 600).action).toMatch(/^Mettez la campagne en pause/);
    expect(act("active", 600).priority).toBe("high");
    const d = act("active", 120);
    expect(d.action).toMatch(/Vérifiez d'abord le suivi/);
    expect(d.priority).toBe("medium");
  });
});
