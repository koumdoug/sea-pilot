import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createLead, changeLeadStatus } from "@/lib/leads";
import { defaultRange, loadAnalytics } from "@/lib/analytics";
import { loadInsights } from "@/lib/insights";
import { makeWorkspace, resetDb } from "./helpers";

beforeEach(resetDb);
const day = () => new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
const range = () => defaultRange(30);
let n = 0;
const metric = (workspaceId: string, campaignId: string | null, spend: number, clicks: number, impressions = clicks * 20) =>
  db.metric.create({ data: { workspaceId, campaignId, platform: "google_ads", date: day(), spend, clicks, impressions, dedupeKey: `m${++n}-${Date.now()}` } });

describe("périmètres : attribué / non attribué (base de test locale)", () => {
  it("global = attribué + non attribué, sur la même période et les mêmes filtres", async () => {
    const { workspaceId } = await makeWorkspace();
    const c = await db.campaign.create({ data: { workspaceId, name: "Google", platform: "google_ads" } });
    await metric(workspaceId, c.id, 100, 200);
    await metric(workspaceId, null, 20, 30); // dépense d'une plateforme non liée à une campagne
    for (let i = 0; i < 3; i++) await createLead({ workspaceId, name: `A${i}`, email: `a${i}@x.com`, campaignId: c.id });
    for (let i = 0; i < 2; i++) await createLead({ workspaceId, name: `N${i}`, email: `n${i}@x.com` }); // sans campagne
    const won = await createLead({ workspaceId, name: "W", email: "w@x.com", campaignId: c.id });
    await changeLeadStatus({ workspaceId, leadId: won.lead.id, status: "won", value: 500 });
    const wonFree = await createLead({ workspaceId, name: "WF", email: "wf@x.com" });
    await changeLeadStatus({ workspaceId, leadId: wonFree.lead.id, status: "won", value: 300 });

    const a = await loadAnalytics(workspaceId, range());
    expect(a.totals).toMatchObject({ spend: 120, clicks: 230, leads: 7, customers: 2, revenue: 800 });
    expect(a.attributed).toMatchObject({ spend: 100, clicks: 200, leads: 4, customers: 1, revenue: 500 });
    expect(a.unattributed).toMatchObject({ spend: 20, clicks: 30, leads: 3, customers: 1, revenue: 300 });
    for (const f of ["spend", "impressions", "clicks", "leads", "qualifiedLeads", "customers", "revenue"] as const) {
      expect(a.totals[f], f).toBeCloseTo(a.attributed[f] + a.unattributed[f], 6);
    }
    // somme des campagnes = périmètre attribué (même période, même périmètre)
    expect(a.campaigns.reduce((s, r) => s + r.totals.leads, 0)).toBe(a.attributed.leads);
    expect(a.campaigns.reduce((s, r) => s + r.totals.spend, 0)).toBeCloseTo(a.attributed.spend, 6);
    // KPI : le CPL global (120/7) diffère du CPL attribué (100/4) — les deux sont exposés
    expect(a.kpis.cpl).toBeCloseTo(120 / 7);
    expect(a.attributedKpis.cpl).toBeCloseTo(25);
  });

  it("la suppression d'une campagne fait passer ses données en « non attribué » sans changer le global", async () => {
    const { workspaceId } = await makeWorkspace();
    const c = await db.campaign.create({ data: { workspaceId, name: "À supprimer" } });
    await metric(workspaceId, c.id, 80, 100);
    await createLead({ workspaceId, name: "L", email: "l@x.com", campaignId: c.id });
    const before = await loadAnalytics(workspaceId, range());
    expect(before.unattributed.leads).toBe(0);
    await db.campaign.delete({ where: { id: c.id } });
    const after = await loadAnalytics(workspaceId, range());
    expect(after.totals).toEqual(before.totals);
    expect(after.attributed.leads).toBe(0);
    expect(after.unattributed).toMatchObject({ spend: 80, leads: 1 });
    expect(after.campaigns).toHaveLength(0);
  });

  it("avec un filtre de campagne, le non attribué est vide (périmètre identique)", async () => {
    const { workspaceId } = await makeWorkspace();
    const c = await db.campaign.create({ data: { workspaceId, name: "C" } });
    await metric(workspaceId, c.id, 50, 100);
    await metric(workspaceId, null, 9, 9);
    await createLead({ workspaceId, name: "L", email: "l@x.com" });
    const a = await loadAnalytics(workspaceId, { ...range(), campaignId: c.id });
    expect(a.unattributed.spend).toBe(0);
    expect(a.unattributed.leads).toBe(0);
    expect(a.totals.spend).toBe(50);
  });

  it("espace vide : aucun total, aucun non attribué, aucune valeur inventée", async () => {
    const { workspaceId } = await makeWorkspace();
    const a = await loadAnalytics(workspaceId, range());
    expect(a.unattributed.leads + a.unattributed.spend + a.attributed.leads).toBe(0);
    expect(a.attributedKpis.cpl).toBeNull();
  });

  it("isolation : le non attribué d'un autre espace n'apparaît jamais", async () => {
    const a = await makeWorkspace("A");
    const b = await makeWorkspace("B");
    await metric(a.workspaceId, null, 40, 10);
    await createLead({ workspaceId: a.workspaceId, name: "L", email: "l@x.com" });
    const res = await loadAnalytics(b.workspaceId, range());
    expect(res.unattributed.leads).toBe(0);
    expect(res.unattributed.spend).toBe(0);
  });
});

describe("recommandations de scaling : la marge vient de l'offre de la campagne (base de test locale)", () => {
  async function setup(marginPct: number | null, revenue: number) {
    const { workspaceId } = await makeWorkspace();
    const offer = await db.offer.create({ data: { workspaceId, name: "O", price: 1000, marginPct, status: "active" } });
    const c = await db.campaign.create({ data: { workspaceId, name: "Camp", status: "active", offerId: offer.id } });
    await metric(workspaceId, c.id, 1000, 500);
    for (let i = 0; i < 5; i++) {
      const l = await createLead({ workspaceId, name: `L${i}`, email: `l${i}@x.com`, campaignId: c.id });
      await changeLeadStatus({ workspaceId, leadId: l.lead.id, status: "won", value: revenue / 5 });
    }
    return { workspaceId, campaignId: c.id };
  }
  const types = async (workspaceId: string) => (await loadInsights(workspaceId, range())).recommendations.filter((r) => /scaling|revenue_signal/.test(r.type)).map((r) => r.type);

  // Corrigé (lot B1-1, R8) : sans facteur de sécurité validé (SCALING_SAFETY_FACTOR = null), aucun scaling, même à ROAS 5 avec une marge valide.
  it("marge 28 % et ROAS 5 : pas de scaling (facteur de sécurité non défini), signal « au point mort ou au-dessus »", async () => {
    const s = await setup(28, 5000);
    expect(await types(s.workspaceId)).toEqual(["revenue_signal"]);
    const sig = (await loadInsights(s.workspaceId, range())).recommendations.find((r) => r.type === "revenue_signal")!;
    expect(sig.problem).toMatch(/la marge brute couvre les dépenses publicitaires de cette campagne/); // lot 3A : nouvelle formulation du cas B
    expect(sig.problem).toMatch(/Échantillon insuffisant/); // la réserve d'échantillon (5 leads) reste une phrase distincte
    expect(sig.priority).toBe("low");
  });
  it("marge 28 % et ROAS 3,2 : pas de scaling, signal sous le seuil de rentabilité", async () => {
    const s = await setup(28, 3200);
    expect(await types(s.workspaceId)).toEqual(["revenue_signal"]);
  });
  it("marge absente : jamais de scaling, signal de chiffre d'affaires avec la limite", async () => {
    const s = await setup(null, 5000);
    const recs = (await loadInsights(s.workspaceId, range())).recommendations;
    expect(recs.some((r) => r.type === "scaling")).toBe(false);
    expect(recs.find((r) => r.type === "revenue_signal")?.evidence.join(" ")).toMatch(/marge de l'offre absente ou invalide/);
  });
  it("marge hors plage (150) : traitée comme invalide", async () => {
    const s = await setup(150, 5000);
    expect((await types(s.workspaceId))).toEqual(["revenue_signal"]);
  });
});
