// Économie unitaire : fonctions pures. Une valeur indisponible ou non calculable vaut `null` : jamais un zéro ni une valeur « inventée ».
// Aucune marge par défaut n'existe ici : la marge vient de l'utilisateur (estimation approximative) ou reste inconnue.

export type BillingInterval = "month" | "year";
export type Billing = { interval: BillingInterval; planName: string; source: "product_pricing" };

const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/** Nombre de mois couverts par une période de facturation. */
export const monthsIn = (i: BillingInterval): number => (i === "year" ? 12 : 1);

/** Marge brute mensuelle équivalente d'une vente récurrente (marge d'une période ÷ mois de la période). Null si la marge est inconnue. */
export function monthlyGrossMargin(marginPerPeriod: number | null, interval: BillingInterval): number | null {
  return positive(marginPerPeriod) ? marginPerPeriod / monthsIn(interval) : null;
}

/**
 * Délai de récupération du CAC, en mois : CAC ÷ marge brute mensuelle. Null (jamais 0, jamais Infinity) si le CAC ou la marge mensuelle
 * est absent, nul ou négatif. Ne tient AUCUN compte de la résiliation : sans donnée de rétention, c'est un délai théorique.
 */
export function cacPaybackMonths(cac: number | null | undefined, monthlyMargin: number | null | undefined): number | null {
  if (!positive(cac) || !positive(monthlyMargin)) return null;
  const m = cac / monthlyMargin;
  return Number.isFinite(m) ? m : null;
}

/** Devise exploitable : exactement trois lettres (code ISO 4217), ramenée en majuscules. Absente, vide ou mal formée : null (jamais une devise supposée). */
const currencyCode = (c: unknown): string | null => (typeof c === "string" && /^[A-Za-z]{3}$/.test(c.trim()) ? c.trim().toUpperCase() : null);

/**
 * Mode de facturation d'une offre, lu dans le catalogue du produit rattaché. Une donnée tarifaire n'est utilisée comme fait que si TOUT est confirmé :
 *  - le plan est explicitement vérifié (`verified === true` ; absent ou faux = non confirmé) ;
 *  - sa devise est valide ET identique à celle de l'offre (une devise absente, vide, mal formée ou différente rend le prix incomparable) ;
 *  - son montant est exactement le prix de l'offre, et UN SEUL plan vérifié y correspond ;
 *  - sa période est mensuelle ou annuelle.
 * Sinon : null = « données insuffisantes » (récurrence inconnue). Rien n'est deviné et aucune valeur manquante n'est remplacée par une valeur supposée ;
 * une période absente (null) n'est jamais interprétée comme « mensuelle » ni comme « unique » : aucune récurrence n'est retenue.
 */
export function billingFromPricing(pricing: unknown, price: number | null | undefined, currency: string | null | undefined): Billing | null {
  const offerCurrency = currencyCode(currency);
  if (!positive(price) || !offerCurrency || !pricing || typeof pricing !== "object") return null;
  const plans = (pricing as { plans?: unknown }).plans;
  if (!Array.isArray(plans)) return null;
  const hits = plans.filter((p): p is { name?: unknown; amount: number; currency?: unknown; interval: unknown; verified: true } =>
    !!p && typeof p === "object" && (p as { verified?: unknown }).verified === true && (p as { amount?: unknown }).amount === price && currencyCode((p as { currency?: unknown }).currency) === offerCurrency);
  if (hits.length !== 1) return null;
  const interval = hits[0].interval;
  if (interval !== "month" && interval !== "year") return null;
  return { interval, planName: typeof hits[0].name === "string" && hits[0].name ? hits[0].name : "plan", source: "product_pricing" };
}