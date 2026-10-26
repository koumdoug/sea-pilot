// Calculs de KPI — fonctions pures. Une valeur indisponible vaut `null` : jamais 0 « inventé ».

export type Totals = {
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  qualifiedLeads: number;
  customers: number;
  revenue: number;
  /** nombre de clients gagnés avec un montant de revenu renseigné */
  customersWithRevenue?: number;
};

export type Kpis = {
  spend: number;
  impressions: number;
  clicks: number;
  leads: number;
  qualifiedLeads: number;
  customers: number;
  revenue: number;
  ctr: number | null; // clics / impressions
  cpc: number | null; // dépense / clics
  cpl: number | null; // dépense / leads
  cvr: number | null; // leads / clics
  qualificationRate: number | null; // leads qualifiés / leads
  closeRate: number | null; // clients / leads
  cac: number | null; // dépense / clients
  roas: number | null; // revenu / dépense
  roi: number | null; // (revenu − dépense) / dépense — uniquement si le calcul est fiable
  roiReliable: boolean;
};

const div = (a: number, b: number): number | null => (b > 0 && Number.isFinite(a / b) ? a / b : null);

export function computeKpis(t: Totals): Kpis {
  // ROI/ROAS fiables : dépense connue ET au moins un client gagné dont le revenu est renseigné.
  const reliable = t.spend > 0 && t.customers > 0 && (t.customersWithRevenue ?? t.customers) === t.customers && t.revenue > 0;
  return {
    spend: t.spend,
    impressions: t.impressions,
    clicks: t.clicks,
    leads: t.leads,
    qualifiedLeads: t.qualifiedLeads,
    customers: t.customers,
    revenue: t.revenue,
    ctr: div(t.clicks, t.impressions),
    cpc: t.spend > 0 ? div(t.spend, t.clicks) : null,
    cpl: t.spend > 0 ? div(t.spend, t.leads) : null,
    cvr: div(t.leads, t.clicks),
    qualificationRate: div(t.qualifiedLeads, t.leads),
    closeRate: div(t.customers, t.leads),
    cac: t.spend > 0 ? div(t.spend, t.customers) : null,
    roas: t.spend > 0 && t.revenue > 0 ? t.revenue / t.spend : null,
    roi: reliable ? (t.revenue - t.spend) / t.spend : null,
    roiReliable: reliable,
  };
}

export const emptyTotals = (): Totals => ({ spend: 0, impressions: 0, clicks: 0, leads: 0, qualifiedLeads: 0, customers: 0, revenue: 0, customersWithRevenue: 0 });

export function addTotals(a: Totals, b: Totals): Totals {
  return {
    spend: a.spend + b.spend, impressions: a.impressions + b.impressions, clicks: a.clicks + b.clicks, leads: a.leads + b.leads,
    qualifiedLeads: a.qualifiedLeads + b.qualifiedLeads, customers: a.customers + b.customers, revenue: a.revenue + b.revenue,
    customersWithRevenue: (a.customersWithRevenue ?? 0) + (b.customersWithRevenue ?? 0),
  };
}

export type Goals = { goalLeadsPerMonth?: number | null; maxCac?: number | null; adBudgetMonthly?: number | null; goalSalesPerMonth?: number | null };
export type Health = { status: "good" | "watch" | "bad" | "unknown"; reasons: string[] };

/**
 * Santé de l'acquisition, calculée à partir des données disponibles et des objectifs de l'onboarding.
 * `periodDays` sert à proratiser les objectifs mensuels.
 */
export function acquisitionHealth(k: Kpis, goals: Goals, periodDays: number): Health {
  if (k.spend === 0 && k.leads === 0 && k.impressions === 0) return { status: "unknown", reasons: ["Aucune donnée sur la période : saisissez vos dépenses publicitaires ou attendez vos premiers leads."] };

  const bad: string[] = [];
  const watch: string[] = [];
  const good: string[] = [];

  if (k.spend > 0 && k.clicks >= 50 && k.leads === 0) bad.push(`${k.clicks} clics et aucune conversion en lead : le tunnel de conversion est cassé ou la page ne convertit pas.`);
  if (k.cac !== null && goals.maxCac) {
    if (k.cac > goals.maxCac * 1.25) bad.push(`Le coût d'acquisition client (${fmt(k.cac)}) dépasse de plus de 25 % le maximum visé (${fmt(goals.maxCac)}).`);
    else if (k.cac > goals.maxCac) watch.push(`Le coût d'acquisition client (${fmt(k.cac)}) dépasse le maximum visé (${fmt(goals.maxCac)}).`);
    else good.push(`Coût d'acquisition client (${fmt(k.cac)}) sous le maximum visé (${fmt(goals.maxCac)}).`);
  }
  if (k.roiReliable && k.roas !== null) {
    if (k.roas < 1) bad.push(`ROAS de ${fmtRatio(k.roas)} (sur chiffre d'affaires) : chaque unité dépensée rapporte moins de chiffre d'affaires qu'elle ne coûte.`);
    else if (k.roas < 2) watch.push(`ROAS de ${fmtRatio(k.roas)} (sur chiffre d'affaires) : rentabilité fragile.`);
    else good.push(`ROAS de ${fmtRatio(k.roas)} (sur chiffre d'affaires, marge non prise en compte).`);
  }
  if (goals.goalLeadsPerMonth && periodDays > 0) {
    const target = (goals.goalLeadsPerMonth * periodDays) / 30;
    if (target >= 1) {
      const pace = k.leads / target;
      if (pace < 0.5) bad.push(`${k.leads} lead(s) sur ${fmtNum(target)} attendus pour la période (${Math.round(pace * 100)} % de l'objectif).`);
      else if (pace < 0.8) watch.push(`${k.leads} lead(s) sur ${fmtNum(target)} attendus (${Math.round(pace * 100)} % de l'objectif).`);
      else good.push(`Objectif de leads tenu (${k.leads} pour ${fmtNum(target)} attendus).`);
    }
  }
  if (k.ctr !== null && k.impressions >= 1000 && k.ctr < 0.005) watch.push(`CTR faible (${fmtPct(k.ctr, 2)}) : les annonces attirent peu de clics.`);
  if (goals.adBudgetMonthly && periodDays > 0 && k.spend > (goals.adBudgetMonthly * periodDays) / 30 * 1.2) watch.push("La dépense dépasse de plus de 20 % le budget mensuel proratisé.");

  if (bad.length) return { status: "bad", reasons: [...bad, ...watch] };
  if (watch.length) return { status: "watch", reasons: [...watch, ...good] };
  if (good.length) return { status: "good", reasons: good };
  return { status: "unknown", reasons: ["Données insuffisantes pour conclure : renseignez vos objectifs (CAC maximum, leads par mois) et vos dépenses."] };
}

export function fmt(n: number, currency = "EUR"): string {
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency, maximumFractionDigits: n >= 100 ? 0 : 2 }).format(n);
}
export const fmtNum = (n: number) => new Intl.NumberFormat("fr-FR").format(Math.round(n));
/** Nombre à la française (virgule décimale, espace pour les milliers) avec un nombre fixe de décimales. */
export const fmtDec = (n: number, digits = 1) => new Intl.NumberFormat("fr-FR", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n);
/** Montant à la française avec la devise en suffixe (« 12,50 EUR ») ; valeur absente ou non finie : « — ». */
export const fmtAmount = (amount: number | null | undefined, currency?: string | null, digits = 2) => (amount == null || !Number.isFinite(amount) ? "—" : `${fmtDec(amount, digits)}${currency ? ` ${currency}` : ""}`);
export const fmtPct = (n: number | null, digits = 1) => (n === null ? "—" : `${fmtDec(n * 100, digits)} %`);
export const fmtMoney = (n: number | null, currency = "EUR") => (n === null ? "—" : fmt(n, currency));
export const fmtRatio = (n: number | null) => (n === null ? "—" : fmtDec(n, 2));

/**
 * Tuile « taux de conversion » : le taux affiché est GLOBAL (leads ÷ clics, leads et clics sans campagne inclus) ; il est libellé comme tel.
 * Quand des leads n'ont pas de campagne, le taux rattaché aux campagnes est affiché à côté pour que les deux périmètres ne soient pas confondus.
 */
export function conversionTile(global: Kpis, attributed: Kpis | null, unattributedLeads: number): { label: string; value: string; hint: string } {
  const base = "leads ÷ clics";
  const showAttributed = unattributedLeads > 0 && attributed !== null && attributed.cvr !== null;
  return {
    label: "Taux de conversion (global)",
    value: fmtPct(global.cvr),
    hint: showAttributed ? `${base}, tous leads confondus (dont ceux sans campagne) · rattaché aux campagnes : ${fmtPct(attributed.cvr)}` : base,
  };
}
