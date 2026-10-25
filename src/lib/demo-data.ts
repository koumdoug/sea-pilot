// Jeu de données de DÉMONSTRATION — fictif, affiché uniquement sur la page /demo et toujours étiqueté comme tel.
// Les calculs (KPI, qualification, recommandations) utilisent les vrais moteurs de SEA Pilot sur ces données fictives.
//
// Cohérence : le GLOBAL est la somme des campagnes (attribué) ET d'un lot NON ATTRIBUÉ explicite. Aucune donnée n'est attribuée
// artificiellement à une campagne : les leads sans campagne et les dépenses d'une plateforme non liée restent « non attribués ».
import { acquisitionHealth, addTotals, computeKpis, emptyTotals, fmtDec, type Totals } from "./kpi";
import { qualifyLead, type OfferContext } from "./scoring";
import { buildRecommendations } from "./recommendations";

const DAYS = 30;
const rng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

export const DEMO_COMPANY = "Atelier Démo (entreprise fictive)";

/** Trois notions DISTINCTES de montant dans la démo (fictives) : ne jamais les confondre. */
export const DEMO_AMOUNTS = {
  /** devis moyen de l'offre affichée : ce que l'entreprise propose, pas un revenu */
  quote: 5200,
  /** chiffre d'affaires RÉALISÉ par client gagné : montant encaissé à la signature (acompte), inférieur au devis */
  realizedPerClient: 540,
} as const;

type DemoCampaign = { id: string; name: string; platform: string; status: string; totals: Totals; marginPct: null };

/** Répartit `total` (entier) sur des jours selon des poids, exactement (méthode du plus fort reste). */
function allocate(total: number, weights: number[]): number[] {
  const w = weights.reduce((s, x) => s + x, 0);
  const raw = weights.map((x) => (total * x) / w);
  const out = raw.map(Math.floor);
  let rest = total - out.reduce((s, x) => s + x, 0);
  const order = raw.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0]);
  for (let j = 0; rest > 0; j = (j + 1) % order.length, rest--) out[order[j][1]]++;
  return out;
}

export function buildDemo() {
  const r = rng(42);
  const base = new Date("2026-05-01T00:00:00Z");
  const realized = (clients: number) => clients * DEMO_AMOUNTS.realizedPerClient;

  const campaigns: DemoCampaign[] = [
    { id: "demo-1", name: "Recherche Google — salle de bain", platform: "google_ads", status: "active", marginPct: null, totals: { spend: 820, impressions: 21500, clicks: 1010, leads: 93, qualifiedLeads: 31, customers: 7, revenue: realized(7), customersWithRevenue: 7 } },
    { id: "demo-2", name: "Meta — remarketing visiteurs", platform: "meta_ads", status: "active", marginPct: null, totals: { spend: 410, impressions: 52000, clicks: 330, leads: 14, qualifiedLeads: 4, customers: 2, revenue: realized(2), customersWithRevenue: 2 } },
    { id: "demo-3", name: "TikTok — notoriété locale", platform: "tiktok_ads", status: "paused", marginPct: null, totals: { spend: 260, impressions: 40000, clicks: 120, leads: 0, qualifiedLeads: 0, customers: 0, revenue: 0, customersWithRevenue: 0 } },
  ];
  const rows = campaigns.map((c) => ({ ...c, kpis: computeKpis(c.totals) }));

  // Lot NON ATTRIBUÉ (fictif, explicite) : dépenses d'une plateforme non liée à une campagne + leads sans campagne (organique, direct, saisie manuelle).
  // Aucun client n'est rattaché à ce lot : tous les clients de la démo sont attribués à une campagne.
  const unattributed: Totals = { spend: 26, impressions: 1200, clicks: 34, leads: 42, qualifiedLeads: 6, customers: 0, revenue: 0, customersWithRevenue: 0 };
  const attributed = campaigns.reduce((s, c) => addTotals(s, c.totals), emptyTotals());
  const totals: Totals = addTotals(attributed, unattributed);
  const kpis = computeKpis(totals);
  const attributedKpis = computeKpis(attributed);

  // Série quotidienne : répartition EXACTE des totaux globaux (la somme de la série égale les totaux).
  const weights = Array.from({ length: DAYS }, (_, i) => (1 + 0.25 * Math.sin(i / 3)) * (0.9 + 0.2 * r()));
  const clicks = allocate(totals.clicks, weights);
  const impressions = allocate(totals.impressions, weights);
  const leads = allocate(totals.leads, weights);
  const spendCents = allocate(Math.round(totals.spend * 100), weights);
  const series = Array.from({ length: DAYS }, (_, i) => ({ date: new Date(base.getTime() + i * 86_400_000).toISOString().slice(0, 10), clicks: clicks[i], impressions: impressions[i], leads: leads[i], spend: spendCents[i] / 100 }));

  const goals = { goalLeadsPerMonth: 100, maxCac: 130, adBudgetMonthly: 1500, goalSalesPerMonth: 10 };
  const health = acquisitionHealth(kpis, goals, DAYS);
  const recommendations = buildRecommendations({
    overall: kpis, attributed: attributedKpis, previous: null, campaigns: rows.map((c) => ({ id: c.id, name: c.name, status: c.status, kpis: c.kpis, marginPct: c.marginPct })),
    pages: [{ id: "page-1", name: "Devis salle de bain (démo)", views: 640, leads: 11 }], goals, staleNewLeads: 3, currency: "EUR", periodDays: DAYS,
  });

  const offer: OfferContext = { name: "Rénovation de salle de bain", price: DEMO_AMOUNTS.quote, geoZone: "Lyon et Rhône", advantages: ["devis gratuit sous 48 h", "artisans certifiés"], keywords: ["rénovation", "salle", "bain", "carrelage", "douche"], audienceType: "b2c" };
  const lead = { name: "Camille Martin (prospect fictif)", email: "camille@exemple.test", phone: "06 00 00 00 00", message: "Bonjour, nous voulons rénover notre salle de bain et remplacer la baignoire par une douche. C'est assez urgent, nous aimerions un devis cette semaine.", customFields: { budget: "6000", ville: "Lyon" } };
  const qualification = qualifyLead(lead, offer);

  const notes = [
    `Le total global (${totals.leads} leads, ${Math.round(totals.spend)} € de dépenses) = campagnes (${attributed.leads} leads, ${Math.round(attributed.spend)} €) + lot non attribué (${unattributed.leads} leads, ${unattributed.spend} € de dépenses d'une plateforme non liée à une campagne).`,
    `Montants distincts : devis moyen de l'offre ${DEMO_AMOUNTS.quote} € (ce que l'entreprise propose) ≠ chiffre d'affaires réalisé ${DEMO_AMOUNTS.realizedPerClient} € par client (montant encaissé à la signature, ici un acompte, fictif).`,
    `Le CAC des campagnes (${Math.round(attributed.spend)} € ÷ ${attributed.customers} clients = ${fmtDec(attributed.spend / attributed.customers, 2)} €) suppose que les ${attributed.customers} clients leur sont attribués, ce qui est le cas dans cette démo fictive.`,
    "La marge de l'offre n'est pas renseignée dans la démo : aucune rentabilité n'est affirmée, seul le ROAS sur chiffre d'affaires est affiché.",
    "La qualification est automatique (règles et mots-clés) : la démo n'appelle aucun modèle d'IA.",
  ];

  return { series, totals, kpis, attributed, attributedKpis, unattributed, campaigns: rows, health, recommendations, lead, qualification, goals, days: DAYS, notes, amounts: DEMO_AMOUNTS };
}
