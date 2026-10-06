// Fiche stratégie d'acquisition — calculs déterministes à partir des objectifs saisis à l'onboarding.
// Aucun benchmark externe n'est inventé : seuls les chiffres de l'utilisateur sont utilisés ; le reste est présenté comme hypothèse.
import { fmt } from "./kpi";

export type StrategyInput = {
  companyName: string;
  currency: string;
  industry?: string | null;
  country?: string | null;
  offer?: { name: string; price?: number | null; marginPct?: number | null; advantages?: string[]; differentiation?: string | null; geoZone?: string | null } | null;
  audience?: { name: string; type: string; location?: string | null; needs?: string | null; problems?: string | null; objections?: string | null } | null;
  goals: { leadsPerMonth?: number | null; salesPerMonth?: number | null; adBudgetMonthly?: number | null; maxCac?: number | null; revenueGoal?: number | null };
};

export type StrategySheet = {
  generatedAt: string;
  company: string;
  positioning: { offer: string | null; audience: string | null; differentiation: string | null; advantages: string[]; objections: string[] };
  economics: { label: string; value: string; kind: "input" | "calculated"; note?: string }[];
  funnel: { requiredCloseRate: number | null; maxCpl: number | null; leadsFromBudget: number | null; salesFromBudget: number | null; profitPerSale: number | null; salesNeededForRevenue: number | null };
  channels: { platform: string; share: number; why: string }[];
  alerts: { level: "info" | "warning"; text: string }[];
  firstSteps: string[];
  assumptions: string[];
  missing: string[];
};

const nz = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

export function buildStrategy(i: StrategyInput, now = new Date()): StrategySheet {
  const g = i.goals;
  const price = i.offer?.price ?? null;
  const margin = i.offer?.marginPct ?? null;
  const profitPerSale = nz(price) && nz(margin) ? (price * margin) / 100 : null;
  const requiredCloseRate = nz(g.leadsPerMonth) && nz(g.salesPerMonth) ? g.salesPerMonth / g.leadsPerMonth : null;
  const maxCpl = nz(g.maxCac) && requiredCloseRate ? g.maxCac * requiredCloseRate : null;
  const leadsFromBudget = nz(g.adBudgetMonthly) && maxCpl ? g.adBudgetMonthly / maxCpl : null;
  const salesFromBudget = nz(g.adBudgetMonthly) && nz(g.maxCac) ? g.adBudgetMonthly / g.maxCac : null;
  const salesNeededForRevenue = nz(g.revenueGoal) && nz(price) ? Math.ceil(g.revenueGoal / price) : null;

  const m = (k: string, v: boolean) => (v ? [] : [k]);
  const missing = [
    ...m("prix de l'offre", nz(price)), ...m("marge approximative", nz(margin)), ...m("objectif de leads par mois", nz(g.leadsPerMonth)),
    ...m("objectif de ventes par mois", nz(g.salesPerMonth)), ...m("budget publicitaire mensuel", nz(g.adBudgetMonthly)), ...m("coût d'acquisition maximal", nz(g.maxCac)),
  ];

  const e: StrategySheet["economics"] = [];
  const cur = i.currency;
  if (nz(price)) e.push({ label: "Prix de l'offre", value: fmt(price, cur), kind: "input" });
  if (profitPerSale !== null) e.push({ label: "Marge brute par vente", value: fmt(profitPerSale, cur), kind: "calculated", note: "prix × marge approximative" });
  if (nz(g.maxCac)) e.push({ label: "CAC maximal", value: fmt(g.maxCac, cur), kind: "input" });
  if (requiredCloseRate !== null) e.push({ label: "Taux lead → vente nécessaire", value: `${(requiredCloseRate * 100).toFixed(1)} %`, kind: "calculated", note: "ventes ÷ leads visés" });
  if (maxCpl !== null) e.push({ label: "Coût par lead maximal", value: fmt(maxCpl, cur), kind: "calculated", note: "CAC maximal × taux lead → vente" });
  if (leadsFromBudget !== null) e.push({ label: "Leads atteignables avec le budget", value: String(Math.floor(leadsFromBudget)), kind: "calculated", note: "budget ÷ coût par lead maximal" });
  if (salesNeededForRevenue !== null) e.push({ label: "Ventes nécessaires pour l'objectif de CA", value: String(salesNeededForRevenue), kind: "calculated", note: "objectif de CA ÷ prix" });

  const alerts: StrategySheet["alerts"] = [];
  if (profitPerSale !== null && nz(g.maxCac) && g.maxCac > profitPerSale)
    alerts.push({ level: "warning", text: `Votre CAC maximal (${fmt(g.maxCac, cur)}) dépasse la marge brute par vente (${fmt(profitPerSale, cur)}) : chaque première vente est déficitaire, sauf achats répétés.` });
  if (leadsFromBudget !== null && nz(g.leadsPerMonth) && leadsFromBudget < g.leadsPerMonth)
    alerts.push({ level: "warning", text: `Avec ${fmt(g.adBudgetMonthly!, cur)} et un coût par lead maximal de ${fmt(maxCpl!, cur)}, vous pouvez viser ~${Math.floor(leadsFromBudget)} leads/mois, soit moins que l'objectif de ${g.leadsPerMonth}. Augmentez le budget, améliorez le taux de closing ou revoyez l'objectif.` });
  if (salesFromBudget !== null && nz(g.salesPerMonth) && salesFromBudget < g.salesPerMonth)
    alerts.push({ level: "warning", text: `Le budget finance au mieux ~${Math.floor(salesFromBudget)} vente(s)/mois au CAC maximal, contre ${g.salesPerMonth} visées.` });
  if (salesNeededForRevenue !== null && nz(g.salesPerMonth) && salesNeededForRevenue > g.salesPerMonth)
    alerts.push({ level: "warning", text: `L'objectif de chiffre d'affaires nécessite ${salesNeededForRevenue} ventes alors que l'objectif de ventes est de ${g.salesPerMonth}.` });
  if (!alerts.length && !missing.length) alerts.push({ level: "info", text: "Vos objectifs sont cohérents entre eux selon les chiffres saisis. Ils restent à valider par des tests de campagne." });
  if (missing.length) alerts.push({ level: "info", text: `Données manquantes pour une fiche complète : ${missing.join(", ")}.` });

  const b2b = i.audience?.type === "b2b";
  const channels: StrategySheet["channels"] = b2b
    ? [
        { platform: "google_ads", share: 45, why: "Capte une demande déjà exprimée (recherche active) — adapté aux décideurs qui cherchent une solution." },
        { platform: "linkedin_ads", share: 35, why: "Ciblage par fonction et taille d'entreprise ; coût par clic généralement plus élevé, à valider sur un petit budget." },
        { platform: "email", share: 20, why: "Relance et nurturing des leads capturés (avec consentement)." },
      ]
    : [
        { platform: "meta_ads", share: 45, why: "Large portée, ciblage par centres d'intérêt et lookalike — adapté à la découverte d'offres B2C." },
        { platform: "google_ads", share: 35, why: "Capte les recherches à intention d'achat locale ou produit." },
        { platform: "tiktok_ads", share: 20, why: "Test d'audience plus jeune avec des formats vidéo courts, à conserver seulement si les premiers résultats le justifient." },
      ];

  const steps = [
    "Valider l'offre dans Offer Builder (3 variantes à comparer).",
    "Créer une landing page avec formulaire et consentement, puis la publier.",
    "Lancer une première campagne de test avec 2 à 3 variantes d'annonce, sur 1 seule plateforme.",
    "Saisir ou synchroniser les dépenses quotidiennes pour suivre le CPL et le CAC.",
    "Qualifier chaque lead sous 24 h et activer la séquence de relance.",
    "Après 7 à 14 jours : couper les variantes les plus faibles, dupliquer la meilleure.",
  ];

  return {
    generatedAt: now.toISOString(),
    company: i.companyName,
    positioning: {
      offer: i.offer?.name ?? null,
      audience: i.audience ? `${i.audience.name} (${i.audience.type.toUpperCase()}${i.audience.location ? ", " + i.audience.location : ""})` : null,
      differentiation: i.offer?.differentiation ?? null,
      advantages: i.offer?.advantages ?? [],
      objections: (i.audience?.objections ?? "").split(/[\n;]+/).map((s) => s.trim()).filter(Boolean),
    },
    economics: e,
    funnel: { requiredCloseRate, maxCpl, leadsFromBudget, salesFromBudget, profitPerSale, salesNeededForRevenue },
    channels,
    alerts,
    firstSteps: steps,
    assumptions: [
      "Les canaux et la répartition de budget sont une hypothèse de départ fondée sur le type de cible (B2B/B2C), à valider par des tests.",
      "Le taux lead → vente est déduit de vos objectifs ; il sera remplacé par vos résultats réels dès que des leads sont suivis dans le CRM.",
    ],
    missing,
  };
}
