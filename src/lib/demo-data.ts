// Jeu de données de DÉMONSTRATION — fictif, affiché uniquement sur la page /demo et toujours étiqueté comme tel.
// Les calculs (KPI, qualification, recommandations) utilisent les vrais moteurs de SEA Pilot sur ces données fictives.
import { acquisitionHealth, computeKpis, type Totals } from "./kpi";
import { qualifyLead, type OfferContext } from "./scoring";
import { buildRecommendations } from "./recommendations";

const DAYS = 30;
const rng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

export const DEMO_COMPANY = "Atelier Démo (entreprise fictive)";

type DemoCampaign = { id: string; name: string; platform: string; status: string; totals: Totals };

export function buildDemo() {
  const r = rng(42);
  const base = new Date("2026-05-01T00:00:00Z");
  const series = Array.from({ length: DAYS }, (_, i) => {
    const wave = 1 + 0.25 * Math.sin(i / 3);
    const clicks = Math.round(52 * wave + r() * 10);
    const impressions = Math.round(clicks * (38 + r() * 6));
    const leads = Math.round(clicks * (0.07 + r() * 0.03));
    const spend = Math.round((clicks * (0.78 + r() * 0.12)) * 100) / 100;
    return { date: new Date(base.getTime() + i * 86_400_000).toISOString().slice(0, 10), clicks, impressions, leads, spend };
  });
  const sum = (k: "clicks" | "impressions" | "leads" | "spend") => series.reduce((s, p) => s + p[k], 0);
  const customers = 9, revenue = 9 * 540;
  const totals: Totals = { spend: sum("spend"), impressions: sum("impressions"), clicks: sum("clicks"), leads: sum("leads"), qualifiedLeads: 41, customers, revenue, customersWithRevenue: customers };
  const kpis = computeKpis(totals);

  const campaigns: DemoCampaign[] = [
    { id: "demo-1", name: "Recherche Google — salle de bain", platform: "google_ads", status: "active", totals: { spend: 820, impressions: 21500, clicks: 1010, leads: 93, qualifiedLeads: 31, customers: 7, revenue: 3780, customersWithRevenue: 7 } },
    { id: "demo-2", name: "Meta — remarketing visiteurs", platform: "meta_ads", status: "active", totals: { spend: 410, impressions: 52000, clicks: 330, leads: 14, qualifiedLeads: 4, customers: 2, revenue: 1080, customersWithRevenue: 2 } },
    { id: "demo-3", name: "TikTok — notoriété locale", platform: "tiktok_ads", status: "paused", totals: { spend: 260, impressions: 40000, clicks: 120, leads: 0, qualifiedLeads: 0, customers: 0, revenue: 0, customersWithRevenue: 0 } },
  ].map((c) => ({ ...c }));
  const rows = campaigns.map((c) => ({ ...c, kpis: computeKpis(c.totals) }));

  const goals = { goalLeadsPerMonth: 100, maxCac: 130, adBudgetMonthly: 1500, goalSalesPerMonth: 10 };
  const health = acquisitionHealth(kpis, goals, DAYS);
  const recommendations = buildRecommendations({
    overall: kpis, previous: null, campaigns: rows.map((c) => ({ id: c.id, name: c.name, status: c.status, kpis: c.kpis })),
    pages: [{ id: "page-1", name: "Devis salle de bain (démo)", views: 640, leads: 11 }], goals, staleNewLeads: 3, currency: "EUR", periodDays: DAYS,
  });

  const offer: OfferContext = { name: "Rénovation de salle de bain", price: 5200, geoZone: "Lyon et Rhône", advantages: ["devis gratuit sous 48 h", "artisans certifiés"], keywords: ["rénovation", "salle", "bain", "carrelage", "douche"], audienceType: "b2c" };
  const lead = { name: "Camille Martin (prospect fictif)", email: "camille@exemple.test", phone: "06 00 00 00 00", message: "Bonjour, nous voulons rénover notre salle de bain et remplacer la baignoire par une douche. C'est assez urgent, nous aimerions un devis cette semaine.", customFields: { budget: "6000", ville: "Lyon" } };
  const qualification = qualifyLead(lead, offer);

  return { series, totals, kpis, campaigns: rows, health, recommendations, lead, qualification, goals, days: DAYS };
}
