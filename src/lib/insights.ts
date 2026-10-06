import { db } from "./db";
import { loadAnalytics, type AnalyticsFilters } from "./analytics";
import { acquisitionHealth, computeKpis, type Goals, emptyTotals } from "./kpi";
import { buildRecommendations, type Recommendation } from "./recommendations";

/** Charge les données réelles et calcule recommandations + santé de l'acquisition pour une période. */
export async function loadInsights(workspaceId: string, f: AnalyticsFilters, currency = "EUR") {
  const [ws, current] = await Promise.all([
    db.workspace.findUnique({ where: { id: workspaceId }, select: { goalLeadsPerMonth: true, maxCac: true, adBudgetMonthly: true, goalSalesPerMonth: true, currency: true } }),
    loadAnalytics(workspaceId, f),
  ]);
  const span = f.to.getTime() - f.from.getTime();
  const prev = await loadAnalytics(workspaceId, { ...f, from: new Date(f.from.getTime() - span - 1), to: new Date(f.from.getTime() - 1) });
  const goals: Goals = ws ?? {};
  const health = acquisitionHealth(current.kpis, goals, current.periodDays);

  const pagesRaw = await db.landingPage.findMany({ where: { workspaceId, status: "published" }, select: { id: true, name: true } });
  const views = await db.analyticsEvent.groupBy({ by: ["landingPageId"], where: { workspaceId, type: "page_view", createdAt: { gte: f.from, lte: f.to } }, _count: { _all: true } });
  const leadsBy = await db.lead.groupBy({ by: ["landingPageId"], where: { workspaceId, deletedAt: null, createdAt: { gte: f.from, lte: f.to } }, _count: { _all: true } });
  const pages = pagesRaw.map((p) => ({
    id: p.id, name: p.name,
    views: views.find((v) => v.landingPageId === p.id)?._count._all ?? 0,
    leads: leadsBy.find((v) => v.landingPageId === p.id)?._count._all ?? 0,
  }));
  const staleNewLeads = await db.lead.count({ where: { workspaceId, deletedAt: null, status: "new", createdAt: { lt: new Date(Date.now() - 48 * 3_600_000) } } });

  const recommendations: Recommendation[] = buildRecommendations({
    overall: current.kpis,
    previous: prev.totals.leads || prev.totals.spend ? prev.kpis : null,
    campaigns: current.campaigns.map((c) => ({ id: c.id, name: c.name, status: c.status, kpis: c.kpis })),
    pages, goals, staleNewLeads, currency: ws?.currency ?? currency, periodDays: current.periodDays,
  });
  return { analytics: current, previous: prev, health, recommendations, goals, pages, staleNewLeads };
}

export { computeKpis, emptyTotals };
