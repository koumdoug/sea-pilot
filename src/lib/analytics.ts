import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { addTotals, computeKpis, emptyTotals, type Kpis, type Totals } from "./kpi";

export type AnalyticsFilters = {
  from: Date;
  to: Date;
  campaignId?: string;
  platform?: string;
  source?: string;
  audienceId?: string;
};

export type SeriesPoint = { date: string; spend: number; clicks: number; impressions: number; leads: number; customers: number };
export type CampaignRow = { id: string; name: string; platform: string; status: string; totals: Totals; kpis: Kpis };

export type AnalyticsResult = {
  totals: Totals;
  kpis: Kpis;
  series: SeriesPoint[];
  campaigns: CampaignRow[];
  sources: { source: string; leads: number; qualified: number; customers: number; revenue: number }[];
  pageviews: number;
  /** vrai si au moins une ligne de dépense existe sur la période (sinon CPL/CAC/ROAS ne sont pas calculables) */
  hasSpendData: boolean;
  notes: string[];
  periodDays: number;
};

const dayKey = (d: Date) => d.toISOString().slice(0, 10);
export const startOfDayUtc = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

export function defaultRange(days = 30, now = new Date()): { from: Date; to: Date } {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999));
  const from = startOfDayUtc(new Date(to.getTime() - (days - 1) * 86_400_000));
  return { from, to };
}

const QUALIFIED = ["qualified", "proposal", "won"];

export async function loadAnalytics(workspaceId: string, f: AnalyticsFilters): Promise<AnalyticsResult> {
  const notes: string[] = [];
  const periodDays = Math.max(1, Math.round((f.to.getTime() - f.from.getTime()) / 86_400_000) + (0));

  // Campagnes retenues par les filtres campagne / plateforme / audience
  let campaignIds: string[] | null = null;
  if (f.campaignId || f.platform || f.audienceId) {
    const cw: Prisma.CampaignWhereInput = { workspaceId };
    if (f.campaignId) cw.id = f.campaignId;
    if (f.platform) cw.platform = f.platform;
    if (f.audienceId) cw.audienceId = f.audienceId;
    campaignIds = (await db.campaign.findMany({ where: cw, select: { id: true } })).map((c) => c.id);
  }

  const metricWhere: Prisma.MetricWhereInput = { workspaceId, date: { gte: f.from, lte: f.to } };
  if (campaignIds) metricWhere.campaignId = { in: campaignIds };
  const leadWhere: Prisma.LeadWhereInput = { workspaceId, deletedAt: null, createdAt: { gte: f.from, lte: f.to } };
  if (campaignIds) leadWhere.campaignId = { in: campaignIds };
  if (f.source) {
    leadWhere.utmSource = f.source;
    notes.push("Le filtre « source » s'applique aux leads uniquement : la dépense publicitaire n'est pas ventilée par source, donc CPL/CAC/ROAS ne sont pas calculés.");
  }

  const [metrics, leads, pageviews] = await Promise.all([
    f.source ? Promise.resolve([]) : db.metric.findMany({ where: metricWhere, select: { date: true, campaignId: true, spend: true, impressions: true, clicks: true } }),
    db.lead.findMany({ where: leadWhere, select: { createdAt: true, status: true, qualifiedAt: true, value: true, campaignId: true, utmSource: true } }),
    db.analyticsEvent.count({ where: { workspaceId, type: "page_view", createdAt: { gte: f.from, lte: f.to }, ...(campaignIds ? { campaignId: { in: campaignIds } } : {}) } }),
  ]);

  const totals = emptyTotals();
  const byDay = new Map<string, SeriesPoint>();
  const point = (d: string): SeriesPoint => {
    let p = byDay.get(d);
    if (!p) { p = { date: d, spend: 0, clicks: 0, impressions: 0, leads: 0, customers: 0 }; byDay.set(d, p); }
    return p;
  };
  const byCampaign = new Map<string, Totals>();
  const cTotals = (id: string) => { let t = byCampaign.get(id); if (!t) { t = emptyTotals(); byCampaign.set(id, t); } return t; };
  const bySource = new Map<string, { source: string; leads: number; qualified: number; customers: number; revenue: number }>();

  for (const m of metrics) {
    totals.spend += m.spend; totals.impressions += m.impressions; totals.clicks += m.clicks;
    const p = point(dayKey(m.date)); p.spend += m.spend; p.clicks += m.clicks; p.impressions += m.impressions;
    if (m.campaignId) { const c = cTotals(m.campaignId); c.spend += m.spend; c.impressions += m.impressions; c.clicks += m.clicks; }
  }
  for (const l of leads) {
    const isQ = QUALIFIED.includes(l.status) || !!l.qualifiedAt;
    const won = l.status === "won";
    totals.leads++; if (isQ) totals.qualifiedLeads++;
    if (won) { totals.customers++; totals.revenue += l.value ?? 0; if (l.value && l.value > 0) totals.customersWithRevenue = (totals.customersWithRevenue ?? 0) + 1; }
    const p = point(dayKey(l.createdAt)); p.leads++; if (won) p.customers++;
    if (l.campaignId) {
      const c = cTotals(l.campaignId); c.leads++; if (isQ) c.qualifiedLeads++;
      if (won) { c.customers++; c.revenue += l.value ?? 0; if (l.value && l.value > 0) c.customersWithRevenue = (c.customersWithRevenue ?? 0) + 1; }
    }
    const s = bySource.get(l.utmSource ?? "(direct / inconnu)") ?? { source: l.utmSource ?? "(direct / inconnu)", leads: 0, qualified: 0, customers: 0, revenue: 0 };
    s.leads++; if (isQ) s.qualified++; if (won) { s.customers++; s.revenue += l.value ?? 0; }
    bySource.set(s.source, s);
  }

  // Série continue (jours sans donnée = 0 pour les compteurs ; l'absence de dépense est signalée par hasSpendData)
  const series: SeriesPoint[] = [];
  for (let t = startOfDayUtc(f.from).getTime(); t <= f.to.getTime() && series.length < 400; t += 86_400_000) {
    const k = dayKey(new Date(t));
    series.push(byDay.get(k) ?? { date: k, spend: 0, clicks: 0, impressions: 0, leads: 0, customers: 0 });
  }

  const ids = [...byCampaign.keys()];
  const camps = ids.length ? await db.campaign.findMany({ where: { workspaceId, id: { in: ids } }, select: { id: true, name: true, platform: true, status: true } }) : [];
  const campaigns: CampaignRow[] = camps
    .map((c) => { const t = byCampaign.get(c.id) ?? emptyTotals(); return { ...c, totals: t, kpis: computeKpis(t) }; })
    .sort((a, b) => b.totals.spend - a.totals.spend || b.totals.leads - a.totals.leads);

  const hasSpendData = metrics.length > 0 && totals.spend > 0;
  if (!hasSpendData && !f.source) notes.push("Aucune dépense publicitaire enregistrée sur la période : CPL, CAC, ROAS et ROI ne peuvent pas être calculés. Saisissez vos dépenses ou connectez une plateforme publicitaire.");

  return {
    totals, kpis: computeKpis(totals), series, campaigns, sources: [...bySource.values()].sort((a, b) => b.leads - a.leads),
    pageviews, hasSpendData, notes, periodDays,
  };
}

export { addTotals };
