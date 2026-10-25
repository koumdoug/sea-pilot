// Marge d'une offre : unité et saisie.
// Convention constatée (schéma Prisma Float?, champs « Marge approximative (%) » min 0 / max 100, calculs `price * margin / 100`) :
// la marge est un POURCENTAGE entier du prix de vente — 28 signifie 28 %, jamais 0,28.
// Une valeur strictement comprise entre 0 et 1 est donc probablement une fraction saisie par erreur : elle n'est jamais transformée
// silencieusement, mais elle exige une confirmation à la saisie et n'alimente aucune affirmation de rentabilité.

/** En dessous de ce pourcentage, la saisie est jugée ambiguë (0,28 : 0,28 % ou 28 % ?). */
export const MARGIN_AMBIGUOUS_BELOW = 1;

/** Marge strictement positive, finie, inférieure à 1 % et au plus 100 : unité douteuse. */
export const isAmbiguousMarginPct = (m: unknown): boolean => typeof m === "number" && Number.isFinite(m) && m > 0 && m < MARGIN_AMBIGUOUS_BELOW;

/** Marge utilisable pour un calcul de rentabilité : finie, d'au moins 1 % (en dessous : ambiguë) et au plus 100 %. */
export const isReliableMarginPct = (m: unknown): m is number => typeof m === "number" && Number.isFinite(m) && m >= MARGIN_AMBIGUOUS_BELOW && m <= 100;

/**
 * Message d'erreur pour une marge saisie (null si acceptée). `undefined` = champ vide : marge non renseignée, jamais convertie en 0.
 * 0 reste accepté tel quel (valeur historiquement acceptée) ; le moteur de recommandations ne l'utilise pas pour juger la rentabilité.
 */
export function marginInputError(value: number | undefined, confirmedLow: boolean): string | null {
  if (value === undefined) return null;
  if (!Number.isFinite(value) || value < 0 || value > 100) return "La marge doit être comprise entre 0 et 100 (en pourcentage).";
  if (isAmbiguousMarginPct(value) && !confirmedLow) {
    return `La marge s'exprime en pourcentage entier (28 pour 28 %). La valeur saisie (${String(value).replace(".", ",")}) serait lue comme ${String(value).replace(".", ",")} %. Si c'est bien voulu, cochez la confirmation ; sinon corrigez la valeur.`;
  }
  return null;
}
