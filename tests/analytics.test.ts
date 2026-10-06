import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createLead, changeLeadStatus } from "@/lib/leads";
import { defaultRange, loadAnalytics } from "@/lib/analytics";
import { loadInsights } from "@/lib/insights";
import { importMetricsCsv, parseCsv } from "@/lib/csv";
import { buildRecommendations } from "@/lib/recommendations";
import { computeKpis, emptyTotals } from "@/lib/kpi";
import { buildStrategy } from "@/lib/strategy";
import { buildDemo } from "@/lib/demo-data";
import { makeWorkspace, resetDb } from "./helpers";

beforeEach(resetDb);
const today = () => new Date().toISOString().slice(0, 10);
const range = () => defaultRange(30);

async function seed(workspaceId: string) {
  const c1 = await db.campaign.create({ data: { workspaceId, name: "Google", platform: "google_ads" } });
  const c2 = await db.campaign.create({ data: { workspaceId, name: "Meta", platform: "meta_ads" } });
  const d = new Date(`${today()}T00:00:00Z`);
  await db.metric.createMany({ data: [
    { workspaceId, campaignId: c1.id, platform: "google_ads", date: d, spend: 100, impressions: 10000, clicks: 200, dedupeKey: "k1" },
    { workspaceId, campaignId: c2.id, platform: "meta_ads", date: d, spend: 50, impressions: 20000, clicks: 100, dedupeKey: "k2" },
  ] });
  for (let i = 0; i < 4; i++) await createLead({ workspaceId, name: `G${i}`, email: `g${i}@x.com`, campaignId: c1.id, utm: { source: "google" } });
  const m = await createLead({ workspaceId, name: "M", email: "m@x.com", campaignId: c2.id, utm: { source: "meta" } });
  const won = await createLead({ workspaceId, name: "W", email: "w@x.com", campaignId: c1.id, utm: { source: "google" } });
  await changeLeadStatus({ workspaceId, leadId: won.lead.id, status: "won", value: 600 });
  return { c1, c2, m };
}

describe("loadAnalytics", () => {
  it("agrège dépenses, leads, clients et revenu et calcule les KPI", async () => {
    const { workspaceId } = await makeWorkspace();
    await seed(workspaceId);
    const a = await loadAnalytics(workspaceId, range());
    expect(a.totals).toMatchObject({ spend: 150, clicks: 300, impressions: 30000, leads: 6, customers: 1, revenue: 600 });
    expect(a.kpis.cpl).toBeCloseTo(25);
    expect(a.kpis.cac).toBeCloseTo(150);
    expect(a.kpis.roas).toBeCloseTo(4);
    expect(a.kpis.roi).toBeCloseTo(3);
    expect(a.kpis.ctr).toBeCloseTo(0.01);
    expect(a.hasSpendData).toBe(true);
    expect(a.campaigns.find((c) => c.name === "Google")!.totals).toMatchObject({ spend: 100, leads: 5, customers: 1 });
    expect(a.series).toHaveLength(30);
    expect(a.series.at(-1)!.leads).toBe(6);
  });

  it("filtres campagne, plateforme et source", async () => {
    const { workspaceId } = await makeWorkspace();
    const { c1 } = await seed(workspaceId);
    expect((await loadAnalytics(workspaceId, { ...range(), campaignId: c1.id })).totals).toMatchObject({ spend: 100, leads: 5 });
    expect((await loadAnalytics(workspaceId, { ...range(), platform: "meta_ads" })).totals).toMatchObject({ spend: 50, leads: 1 });
    const bySource = await loadAnalytics(workspaceId, { ...range(), source: "google" });
    expect(bySource.totals.leads).toBe(5);
    expect(bySource.kpis.cpl).toBeNull(); // la dépense n'est pas ventilée par source : pas de CPL inventé
    expect(bySource.notes.join(" ")).toMatch(/source/);
  });

  it("la période exclut les données hors plage", async () => {
    const { workspaceId } = await makeWorkspace();
    const c = await db.campaign.create({ data: { workspaceId, name: "C" } });
    await db.metric.create({ data: { workspaceId, campaignId: c.id, platform: "google_ads", date: new Date("2020-01-01T00:00:00Z"), spend: 999, dedupeKey: "old" } });
    const a = await loadAnalytics(workspaceId, range());
    expect(a.totals.spend).toBe(0);
    expect(a.hasSpendData).toBe(false);
    expect(a.notes.join(" ")).toMatch(/Aucune dépense/);
  });

  it("isolation : les données d'un autre espace n'apparaissent jamais", async () => {
    const a = await makeWorkspace("A");
    const b = await makeWorkspace("B");
    await seed(a.workspaceId);
    const res = await loadAnalytics(b.workspaceId, range());
    expect(res.totals).toEqual({ ...emptyTotals() });
    expect(res.campaigns).toHaveLength(0);
  });
});

describe("recommandations", () => {
  it("détecte campagne sans résultat, CPL élevé et leads à contacter avec preuves", async () => {
    const { workspaceId } = await makeWorkspace();
    await db.workspace.update({ where: { id: workspaceId }, data: { maxCac: 100 } });
    const dead = await db.campaign.create({ data: { workspaceId, name: "Morte", status: "active" } });
    await db.metric.create({ data: { workspaceId, campaignId: dead.id, platform: "tiktok_ads", date: new Date(`${today()}T00:00:00Z`), spend: 200, impressions: 9000, clicks: 80, dedupeKey: "d" } });
    const { lead } = await createLead({ workspaceId, name: "Vieux", email: "v@x.com" });
    await db.lead.update({ where: { id: lead.id }, data: { createdAt: new Date(Date.now() - 5 * 86_400_000), status: "new" } });
    const ins = await loadInsights(workspaceId, range());
    const types = ins.recommendations.map((r) => r.type);
    expect(types).toContain("underperforming");
    expect(types).toContain("stale_leads");
    const u = ins.recommendations.find((r) => r.type === "underperforming")!;
    expect(u.priority).toBe("high");
    expect(u.evidence.join(" ")).toMatch(/80 clics/);
    expect(u.action.length).toBeGreaterThan(10);
    expect(u.impact.length).toBeGreaterThan(10);
  });

  it("aucune recommandation inventée sans données", async () => {
    const { workspaceId } = await makeWorkspace();
    const ins = await loadInsights(workspaceId, range());
    expect(ins.recommendations).toEqual([]);
    expect(ins.health.status).toBe("unknown");
  });

  it("règles pures : CTR faible, forte conversion, scaling, baisse de leads, landing faible", () => {
    const k = (o: Partial<ReturnType<typeof emptyTotals>>) => computeKpis({ ...emptyTotals(), ...o });
    const campaigns = [
      { id: "a", name: "A", status: "active", kpis: k({ spend: 100, impressions: 50000, clicks: 100, leads: 3 }) },
      { id: "b", name: "B", status: "active", kpis: k({ spend: 100, impressions: 5000, clicks: 100, leads: 30, customers: 6, revenue: 900, customersWithRevenue: 6, qualifiedLeads: 10 }) },
    ];
    const overall = k({ spend: 200, impressions: 55000, clicks: 200, leads: 33, customers: 6, revenue: 900, customersWithRevenue: 6 });
    const recs = buildRecommendations({ overall, previous: k({ spend: 200, clicks: 400, leads: 80 }), campaigns, pages: [{ id: "p", name: "P", views: 200, leads: 1 }], goals: { maxCac: 10 }, staleNewLeads: 0, periodDays: 30 });
    const types = recs.map((r) => r.type);
    expect(types).toEqual(expect.arrayContaining(["ctr_low", "high_conversion", "scaling", "lead_drop", "landing_weak", "cac_high"]));
    expect(recs[0].priority).toBe("high"); // triées par priorité
  });
});

describe("import CSV", () => {
  it("parse guillemets, séparateur « ; » et virgule décimale", () => {
    expect(parseCsv('date;campagne;dépense\n2026-06-01;"Ma ; camp";"12,5"')).toEqual([["date", "campagne", "dépense"], ["2026-06-01", "Ma ; camp", "12,5"]]);
  });
  it("importe, rapproche les campagnes par nom, remplace un jour déjà importé et signale les erreurs", async () => {
    const { workspaceId } = await makeWorkspace();
    const c = await db.campaign.create({ data: { workspaceId, name: "Ma Campagne", platform: "meta_ads" } });
    const csv = `date,campagne,dépense,impressions,clics\n2026-06-01,ma campagne,10.5,1000,50\n2026-06-02,Ma Campagne,20,2000,80\n2026-06-03,Inconnue,5,1,1\n13/06/2026,Ma Campagne,5,1,1\n2026-06-04,Ma Campagne,5,10,50`;
    const r = await importMetricsCsv(workspaceId, csv);
    expect(r.imported).toBe(2);
    expect(r.errors.map((e) => e.line)).toEqual([4, 5, 6]);
    expect(await db.metric.count({ where: { workspaceId, campaignId: c.id } })).toBe(2);
    await importMetricsCsv(workspaceId, "date,campagne,dépense\n2026-06-01,Ma Campagne,99"); // ré-import du même jour
    expect(await db.metric.count({ where: { workspaceId, campaignId: c.id } })).toBe(2);
    expect((await db.metric.findFirstOrThrow({ where: { workspaceId, dedupeKey: `csv:${c.id}:2026-06-01` } })).spend).toBe(99);
  });
  it("refuse un fichier sans colonnes obligatoires", async () => {
    const { workspaceId } = await makeWorkspace();
    const r = await importMetricsCsv(workspaceId, "a,b\n1,2");
    expect(r.imported).toBe(0);
    expect(r.errors[0].message).toMatch(/Colonnes manquantes/);
  });
});

describe("stratégie et démo", () => {
  it("fiche stratégie : calculs déterministes, alertes de cohérence, données manquantes listées", () => {
    const s = buildStrategy({ companyName: "X", currency: "EUR", offer: { name: "O", price: 1000, marginPct: 20 }, audience: { name: "A", type: "b2b" }, goals: { leadsPerMonth: 100, salesPerMonth: 10, adBudgetMonthly: 1000, maxCac: 250, revenueGoal: 20000 } });
    expect(s.funnel.requiredCloseRate).toBeCloseTo(0.1);
    expect(s.funnel.maxCpl).toBeCloseTo(25);
    expect(s.funnel.leadsFromBudget).toBeCloseTo(40);
    expect(s.funnel.profitPerSale).toBeCloseTo(200);
    expect(s.funnel.salesNeededForRevenue).toBe(20);
    expect(s.alerts.some((a) => a.level === "warning" && /marge brute/.test(a.text))).toBe(true);
    expect(s.alerts.some((a) => /moins que l'objectif/.test(a.text))).toBe(true);
    expect(s.channels.map((c) => c.platform)).toContain("linkedin_ads"); // B2B
    expect(s.channels.reduce((a, c) => a + c.share, 0)).toBe(100);
    expect(buildStrategy({ companyName: "X", currency: "EUR", goals: {} }).missing.length).toBe(6);
  });
  it("démo : jeu de données cohérent et étiqueté, calculé par les vrais moteurs", () => {
    const d = buildDemo();
    expect(d.series).toHaveLength(30);
    expect(d.kpis.cpl).toBeCloseTo(d.totals.spend / d.totals.leads);
    expect(d.qualification.criteria.some((c) => c.basis === "fact")).toBe(true);
    expect(d.recommendations.length).toBeGreaterThan(0);
  });
});
