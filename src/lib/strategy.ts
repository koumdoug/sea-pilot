// Fiche stratégie d'acquisition — calculs déterministes à partir des objectifs saisis à l'onboarding.
// Aucun benchmark externe n'est inventé : seuls les chiffres de l'utilisateur sont utilisés ; le reste est présenté comme hypothèse.
// Une donnée inconnue donne « Données insuffisantes », jamais une valeur par défaut (aucune marge « de secours »).
import { fmt, fmtDec, fmtPct } from "./kpi";
import { isReliableMarginPct } from "./margin";
import { cacPaybackMonths, monthlyGrossMargin, type Billing } from "./unit-economics";

export const INSUFFICIENT = "Données insuffisantes";

export type ProductFacts = {
  name: string;
  tagline?: string | null;
  valueProposition?: string | null;
  problemsSolved?: string[];
  /** `verified` = présent dans une source contrôlée ; sinon l'élément reste à confirmer et ne doit jamais être présenté comme existant. */
  features?: { text: string; verified: boolean }[];
  objections?: { objection: string; answer?: string | null; approved?: boolean }[];
};

export type StrategyInput = {
  companyName: string;
  currency: string;
  industry?: string | null;
  country?: string | null;
  /** Description de l'activité saisie à l'onboarding. */
  description?: string | null;
  offer?: { name: string; price?: number | null; marginPct?: number | null; advantages?: string[]; differentiation?: string | null; geoZone?: string | null; description?: string | null; problem?: string | null; billing?: Billing | null } | null;
  audience?: { name: string; type: string; location?: string | null; needs?: string | null; problems?: string | null; objections?: string | null } | null;
  product?: ProductFacts | null;
  goals: { leadsPerMonth?: number | null; salesPerMonth?: number | null; adBudgetMonthly?: number | null; maxCac?: number | null; revenueGoal?: number | null };
};

/** `input` = saisi ; `calculated` = déduit par formule de valeurs saisies ; `estimated` = dépend d'une estimation approximative ; `insufficient` = non calculable. */
export type EconomicsKind = "input" | "calculated" | "estimated" | "insufficient";
export type Channel = { platform: string; share: number; why: string; kind?: "paid" | "organic"; basis?: "hypothesis" };

export type StrategySheet = {
  generatedAt: string;
  company: string;
  /** Contexte métier réellement enregistré (offre, activité, secteur) : transmis tel quel à l'analyse IA. */
  context?: { industry: string | null; country: string | null; geoZone: string | null; businessDescription: string | null; offerDescription: string | null; offerProblem: string | null; billing: { interval: string; planName: string } | null; valueProposition: string | null; problemsSolved: string[] };
  positioning: {
    offer: string | null; audience: string | null; differentiation: string | null; advantages: string[]; objections: string[];
    /** Faits vérifiés issus du catalogue du produit rattaché, et éléments à confirmer (jamais présentés comme existants). */
    verifiedFeatures?: string[]; unverifiedFeatures?: string[];
    /** Rubriques de positionnement non renseignées : à compléter, rien n'est inventé à leur place. */
    gaps?: string[];
  };
  economics: { label: string; value: string; kind: EconomicsKind; note?: string }[];
  funnel: { requiredCloseRate: number | null; maxCpl: number | null; leadsFromBudget: number | null; salesFromBudget: number | null; profitPerSale: number | null; salesNeededForRevenue: number | null; monthlyMargin?: number | null; paybackMonths?: number | null };
  channels: Channel[];
  alerts: { level: "info" | "warning"; text: string }[];
  firstSteps: string[];
  assumptions: string[];
  missing: string[];
};

const nz = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/** Conventions de la méthode (pas des données de marché) : voir `assumptions` de la fiche. */
export const MIN_LEADS_PER_PLATFORM_TEST = 10;

export const CHANNEL_LABEL: Record<string, string> = {
  seo_content: "Contenu et référencement naturel (SEO)", linkedin_organic: "LinkedIn organique", social_organic: "Réseaux sociaux organiques", email: "E-mail (relance des leads)",
};

const WHY = {
  google_ads: "Capte une demande déjà exprimée (recherche active) : adapté quand la cible cherche une solution à un problème précis.",
  linkedin_ads: "Ciblage par fonction et taille d'entreprise ; coût par clic généralement plus élevé, à valider sur un petit budget.",
  meta_ads: "Large portée, ciblage par centres d'intérêt et audiences similaires : adapté à la découverte d'offres grand public.",
  tiktok_ads: "Test d'audience plus jeune avec des formats vidéo courts, à conserver seulement si les premiers résultats le justifient.",
} as const;
const PAID_B2B = [["google_ads", 60], ["linkedin_ads", 40]] as const;
const PAID_B2C = [["meta_ads", 50], ["google_ads", 30], ["tiktok_ads", 20]] as const;

/**
 * Canaux selon la cible, le budget et le coût par lead maximal : aucun budget = aucun canal payant ; sinon le nombre de plateformes payantes testées est limité
 * pour que chacune puisse produire au moins MIN_LEADS_PER_PLATFORM_TEST leads au coût par lead maximal (une seule plateforme si ce coût est inconnu).
 * Les canaux organiques sont toujours proposés. Tout est une hypothèse de départ, jamais une performance observée.
 */
function recommendChannels(o: { b2b: boolean; budget: number | null; maxCpl: number | null; zone: string | null; hasProblem: boolean }): Channel[] {
  const geo = o.zone ? ` Ciblage géographique à définir pour : ${o.zone}.` : "";
  const candidates = o.b2b ? PAID_B2B : PAID_B2C;
  let paidCount = 0;
  if (nz(o.budget)) paidCount = o.maxCpl && nz(o.maxCpl) ? Math.min(candidates.length, Math.max(1, Math.floor(o.budget / o.maxCpl / MIN_LEADS_PER_PLATFORM_TEST))) : 1;
  const chosen = candidates.slice(0, paidCount);
  const total = chosen.reduce((a, [, w]) => a + w, 0);
  let left = 100;
  const paid: Channel[] = chosen.map(([platform, w], i) => {
    const share = i === chosen.length - 1 ? left : Math.round((w / total) * 100);
    left -= share;
    return { platform, share, kind: "paid", basis: "hypothesis", why: `${WHY[platform]}${geo}` };
  });
  const organic: Channel[] = [
    { platform: "seo_content", share: 0, kind: "organic", basis: "hypothesis", why: o.hasProblem ? "Contenu qui répond aux problèmes et aux questions décrits pour la cible : sans budget publicitaire, effet mesurable seulement après suivi des visites." : "Contenu utile à la cible (problème de votre offre non décrit : à préciser pour orienter les sujets)." },
    o.b2b ? { platform: "linkedin_organic", share: 0, kind: "organic", basis: "hypothesis", why: "Publications et échanges auprès des décideurs de la cible ; sans coût média, mais du temps à y consacrer." }
      : { platform: "social_organic", share: 0, kind: "organic", basis: "hypothesis", why: "Publications régulières sur les réseaux où se trouve la cible ; à conserver selon l'engagement et les leads réellement mesurés." },
    { platform: "email", share: 0, kind: "organic", basis: "hypothesis", why: "Relance et nurturing des leads capturés (avec consentement)." },
  ];
  return [...paid, ...organic];
}

export function buildStrategy(i: StrategyInput, now = new Date()): StrategySheet {
  const g = i.goals;
  const price = i.offer?.price ?? null;
  const rawMargin = i.offer?.marginPct ?? null;
  const billing = i.offer?.billing ?? null;
  // Marge ambiguë (0 < marge < 1 : probablement une fraction) ou invalide (> 100) : donnée insuffisante, aucune marge brute ni alerte de perte calculée dessus.
  const margin = isReliableMarginPct(rawMargin) ? rawMargin : null;
  const marginUnreliable = nz(rawMargin) && margin === null;
  const profitPerSale = nz(price) && nz(margin) ? (price * margin) / 100 : null;
  // Taux ventes ÷ leads : au plus 100 % (plus de ventes que de leads est incohérent : aucun taux, aucun coût par lead qui en découle).
  const rawCloseRate = nz(g.leadsPerMonth) && nz(g.salesPerMonth) ? g.salesPerMonth / g.leadsPerMonth : null;
  const closeRateInconsistent = rawCloseRate !== null && rawCloseRate > 1;
  const requiredCloseRate = closeRateInconsistent ? null : rawCloseRate;
  const maxCpl = nz(g.maxCac) && requiredCloseRate ? g.maxCac * requiredCloseRate : null;
  const leadsFromBudget = nz(g.adBudgetMonthly) && maxCpl ? g.adBudgetMonthly / maxCpl : null;
  const salesFromBudget = nz(g.adBudgetMonthly) && nz(g.maxCac) ? g.adBudgetMonthly / g.maxCac : null;
  const salesNeededForRevenue = nz(g.revenueGoal) && nz(price) ? Math.ceil(g.revenueGoal / price) : null;
  const monthlyMargin = billing && profitPerSale !== null ? monthlyGrossMargin(profitPerSale, billing.interval) : null;
  const paybackMonths = monthlyMargin !== null ? cacPaybackMonths(g.maxCac, monthlyMargin) : null;

  const m = (k: string, v: boolean) => (v ? [] : [k]);
  const missing = [
    ...m("prix de l'offre", nz(price)), ...m(marginUnreliable ? "marge approximative (valeur ambiguë ou invalide : elle s'exprime en pourcentage entier, 28 pour 28 %)" : "marge approximative", nz(margin)), ...m("objectif de leads par mois", nz(g.leadsPerMonth)),
    ...m("objectif de ventes par mois", nz(g.salesPerMonth)), ...m("budget publicitaire mensuel", nz(g.adBudgetMonthly)), ...m("coût d'acquisition maximal", nz(g.maxCac)),
  ];

  const e: StrategySheet["economics"] = [];
  const cur = i.currency;
  if (nz(price)) e.push({ label: "Prix de l'offre", value: fmt(price, cur), kind: "input" });
  if (profitPerSale !== null) e.push({ label: "Marge brute estimée par vente", value: fmt(profitPerSale, cur), kind: "estimated", note: "prix × marge approximative saisie : une estimation, pas une marge mesurée" });
  else if (nz(price)) e.push({ label: "Marge brute estimée par vente", value: INSUFFICIENT, kind: "insufficient", note: marginUnreliable ? "la marge saisie est ambiguë ou invalide" : "marge approximative non renseignée : aucune marge n'est supposée" });
  if (monthlyMargin !== null && billing) e.push({ label: "Marge brute mensuelle estimée", value: fmt(monthlyMargin, cur), kind: "estimated", note: billing.interval === "year" ? "marge d'un abonnement annuel ÷ 12" : "marge d'une période d'abonnement mensuel" });
  if (nz(g.maxCac)) e.push({ label: "CAC maximal", value: fmt(g.maxCac, cur), kind: "input" });
  if (paybackMonths !== null) e.push({ label: "Délai de récupération du CAC", value: `${fmtDec(paybackMonths, 1)} mois`, kind: "estimated", note: "CAC maximal ÷ marge brute mensuelle estimée ; suppose aucune résiliation (aucune donnée de rétention)" });
  if (profitPerSale !== null) e.push({ label: "Valeur vie client (LTV)", value: INSUFFICIENT, kind: "insufficient", note: "durée de vie des clients inconnue : la marge de la première vente n'est pas une valeur vie client" });
  if (requiredCloseRate !== null) e.push({ label: "Taux lead → vente nécessaire", value: fmtPct(requiredCloseRate), kind: "calculated", note: "ventes ÷ leads visés" });
  if (maxCpl !== null) e.push({ label: "Coût par lead maximal", value: fmt(maxCpl, cur), kind: "calculated", note: "CAC maximal × taux lead → vente" });
  if (leadsFromBudget !== null) e.push({ label: "Leads atteignables avec le budget", value: String(Math.floor(leadsFromBudget)), kind: "calculated", note: "budget ÷ coût par lead maximal" });
  if (salesNeededForRevenue !== null) e.push({ label: "Ventes nécessaires pour l'objectif de CA", value: String(salesNeededForRevenue), kind: "calculated", note: "objectif de CA ÷ prix" });

  const alerts: StrategySheet["alerts"] = [];
  if (profitPerSale !== null && nz(g.maxCac) && g.maxCac > profitPerSale) {
    if (billing && paybackMonths !== null)
      alerts.push({ level: "warning", text: `Votre CAC maximal (${fmt(g.maxCac, cur)}) dépasse la marge brute estimée d'une période d'abonnement (${fmt(profitPerSale, cur)}) : il n'est récupéré qu'en ~${fmtDec(paybackMonths, 1)} mois d'abonnement, si le client ne résilie pas. La rétention n'est pas connue : à valider avec vos premiers clients.` });
    else
      alerts.push({ level: "warning", text: `Votre CAC maximal (${fmt(g.maxCac, cur)}) dépasse la marge brute par vente estimée (${fmt(profitPerSale, cur)}) : chaque première vente est déficitaire, sauf achats répétés ou abonnement (le mode de facturation de cette offre n'est pas connu).` });
  }
  if (closeRateInconsistent) alerts.push({ level: "warning", text: `L'objectif de ventes (${g.salesPerMonth}) dépasse l'objectif de leads (${g.leadsPerMonth}) : le taux lead → vente dépasserait 100 %, il n'est pas calculé. Corrigez l'un des deux objectifs.` });
  if (leadsFromBudget !== null && nz(g.leadsPerMonth) && leadsFromBudget < g.leadsPerMonth)
    alerts.push({ level: "warning", text: `Avec ${fmt(g.adBudgetMonthly!, cur)} et un coût par lead maximal de ${fmt(maxCpl!, cur)}, vous pouvez viser ~${Math.floor(leadsFromBudget)} leads/mois, soit moins que l'objectif de ${g.leadsPerMonth}. Augmentez le budget, améliorez le taux de closing ou revoyez l'objectif.` });
  if (salesFromBudget !== null && nz(g.salesPerMonth) && salesFromBudget < g.salesPerMonth)
    alerts.push({ level: "warning", text: `Le budget finance au mieux ~${Math.floor(salesFromBudget)} vente(s)/mois au CAC maximal, contre ${g.salesPerMonth} visées.` });
  if (salesNeededForRevenue !== null && nz(g.salesPerMonth) && salesNeededForRevenue > g.salesPerMonth)
    alerts.push({ level: "warning", text: `L'objectif de chiffre d'affaires nécessite ${salesNeededForRevenue} ventes alors que l'objectif de ventes est de ${g.salesPerMonth}.` });
  if (!alerts.length && !missing.length) alerts.push({ level: "info", text: "Vos objectifs sont cohérents entre eux selon les chiffres saisis. Ils restent à valider par des tests de campagne." });
  if (missing.length) alerts.push({ level: "info", text: `Données manquantes pour une fiche complète : ${missing.join(", ")}.` });

  const b2b = i.audience?.type === "b2b";
  const zone = i.offer?.geoZone ?? i.audience?.location ?? i.country ?? null;
  const hasProblem = !!(i.audience?.problems?.trim() || i.offer?.problem?.trim() || i.product?.problemsSolved?.length);
  const channels = recommendChannels({ b2b, budget: nz(g.adBudgetMonthly) ? g.adBudgetMonthly : null, maxCpl, zone, hasProblem });
  const paid = channels.filter((c) => c.kind === "paid");

  const steps = [
    "Valider l'offre dans Offer Builder (3 variantes à comparer).",
    "Créer une landing page avec formulaire et consentement, puis la publier.",
    paid.length
      ? "Lancer une première campagne de test avec 2 à 3 variantes d'annonce, sur 1 seule plateforme."
      : "Publier des contenus (page de destination, article, publications) et suivre les visites et les leads avant d'engager un budget publicitaire.",
    ...(paid.length ? ["Saisir ou synchroniser les dépenses quotidiennes pour suivre le CPL et le CAC."] : []),
    "Qualifier chaque lead sous 24 h et activer la séquence de relance.",
    paid.length ? "Après 7 à 14 jours : couper les variantes les plus faibles, dupliquer la meilleure." : "Après quelques semaines de suivi : garder les canaux qui produisent des leads, et décider ensuite d'un budget.",
  ];

  const advantages = i.offer?.advantages ?? [];
  const objections = [...new Set([
    ...(i.audience?.objections ?? "").split(/[\n;]+/).map((s) => s.trim()).filter(Boolean),
    ...(i.product?.objections ?? []).map((o) => o.objection.trim()).filter(Boolean),
  ])];
  const features = i.product?.features ?? [];
  const verifiedFeatures = features.filter((f) => f.verified).map((f) => f.text);
  const unverifiedFeatures = features.filter((f) => !f.verified).map((f) => f.text);
  const gaps = [
    ...(i.offer?.differentiation?.trim() ? [] : ["Différenciation non renseignée : précisez ce qui distingue votre offre de ses alternatives."]),
    ...(advantages.length || verifiedFeatures.length ? [] : ["Avantages non renseignés : listez les bénéfices concrets et les fonctionnalités réellement disponibles."]),
    ...(objections.length ? [] : ["Objections non renseignées : indiquez les freins que vos clients expriment avant d'acheter."]),
  ];

  return {
    generatedAt: now.toISOString(),
    company: i.companyName,
    context: {
      industry: i.industry ?? null, country: i.country ?? null, geoZone: i.offer?.geoZone ?? null, businessDescription: i.description ?? null,
      offerDescription: i.offer?.description ?? null, offerProblem: i.offer?.problem ?? null, billing: billing ? { interval: billing.interval, planName: billing.planName } : null,
      valueProposition: i.product?.valueProposition ?? null, problemsSolved: i.product?.problemsSolved ?? [],
    },
    positioning: {
      offer: i.offer?.name ?? null,
      audience: i.audience ? `${i.audience.name} (${i.audience.type.toUpperCase()}${i.audience.location ? ", " + i.audience.location : ""})` : null,
      differentiation: i.offer?.differentiation ?? null,
      advantages,
      objections,
      verifiedFeatures, unverifiedFeatures, gaps,
    },
    economics: e,
    funnel: { requiredCloseRate, maxCpl, leadsFromBudget, salesFromBudget, profitPerSale, salesNeededForRevenue, monthlyMargin, paybackMonths },
    channels,
    alerts,
    firstSteps: steps,
    assumptions: [
      "Les canaux et la répartition de budget sont une hypothèse de départ fondée sur le type de cible (B2B/B2C) et le budget saisi, à valider par des tests : aucune performance n'a été observée.",
      "Les canaux organiques n'ont pas de budget publicitaire ; leur effet n'est mesurable qu'après le suivi des visites et des leads.",
      "Le taux lead → vente est déduit de vos objectifs ; il sera remplacé par vos résultats réels dès que des leads sont suivis dans le CRM.",
      ...(nz(price) ? ["La marge brute est une estimation à partir de la marge approximative saisie ; elle n'est ni une marge réelle ni une valeur vie client."] : []),
    ],
    missing,
  };
}
