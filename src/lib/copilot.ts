import { db } from "./db";
import { defaultRange } from "./analytics";
import { loadInsights } from "./insights";
import { generate } from "./ai/service";
import { baseSystem, copilotPrompt, copilotSchema } from "./ai/prompts";
import { briefOf } from "./ai/brief";
import type { Workspace } from "@prisma/client";

const r2 = (n: number | null) => (n === null ? null : Math.round(n * 10000) / 10000);

/** Données exposées au Copilot : uniquement des mesures réelles. Une valeur non calculable est `null` et documentée dans `dataGaps`. */
export async function buildCopilotContext(workspaceId: string, days = 30) {
  const { from, to } = defaultRange(days);
  const ins = await loadInsights(workspaceId, { from, to });
  const { analytics: a, previous: p } = ins;
  const kp = (k: typeof a.kpis) => ({ spend: k.spend, impressions: k.impressions, clicks: k.clicks, leads: k.leads, qualifiedLeads: k.qualifiedLeads, customers: k.customers, revenue: k.revenue, ctr: r2(k.ctr), cpc: r2(k.cpc), cpl: r2(k.cpl), conversionRateClickToLead: r2(k.cvr), cac: r2(k.cac), roas: r2(k.roas), roi: r2(k.roi) });
  const statusCounts = await db.lead.groupBy({ by: ["status"], where: { workspaceId, deletedAt: null }, _count: { _all: true } });
  const dataGaps: string[] = [];
  if (!a.hasSpendData) dataGaps.push("Aucune dépense publicitaire enregistrée sur la période : CPL, CAC, ROAS, ROI, CPC et CTR ne sont pas calculables.");
  if (a.pageviews === 0) dataGaps.push("Aucune visite de landing page mesurée sur la période.");
  if (!a.kpis.roiReliable) dataGaps.push("ROI non fiable : il faut des dépenses ET le revenu de tous les clients gagnés.");
  return {
    periodDays: days, period: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
    goals: ins.goals, healthStatus: ins.health.status, healthReasons: ins.health.reasons,
    currentPeriod: kp(a.kpis), previousPeriod: kp(p.kpis),
    dailySeries: a.series.map((s) => ({ date: s.date, leads: s.leads, spend: s.spend, clicks: s.clicks })),
    campaigns: a.campaigns.map((c) => ({ id: c.id, name: c.name, platform: c.platform, status: c.status, ...kp(c.kpis) })),
    sources: a.sources, leadsByStatus: Object.fromEntries(statusCounts.map((s) => [s.status, s._count._all])), landingPages: ins.pages,
    recommendations: ins.recommendations.map((r) => ({ title: r.title, priority: r.priority, evidence: r.evidence, action: r.action })),
    staleNewLeads: ins.staleNewLeads, dataGaps,
  };
}

export async function askCopilot(p: { workspace: Workspace; userId: string; question: string }) {
  const data = await buildCopilotContext(p.workspace.id);
  const r = await generate({
    workspaceId: p.workspace.id, userId: p.userId, kind: "copilot", temperature: 0.3,
    system: baseSystem(briefOf(p.workspace), "copilote d'acquisition : analyste data rigoureux") + "\nTu ne cites que des chiffres présents dans les données fournies. Si une valeur est null ou absente, tu l'indiques comme donnée manquante.",
    prompt: copilotPrompt(p.question, data), schema: copilotSchema, input: { question: p.question },
  });
  return { answer: r.data, context: data, generationId: r.generationId };
}
