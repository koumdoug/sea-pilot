// Garde-fou « montants non confirmés » : une annonce ou une variante générée par l'IA ne doit jamais présenter comme un fait
// un prix que l'utilisateur n'a pas fourni. On repère les montants chiffrés et on les compare au prix et aux textes de l'offre.
// Rien n'est supprimé : le résultat sert uniquement à étiqueter le contenu (« montant non confirmé »).
//
// Devises : un montant n'est confirmé que si sa VALEUR et sa DEVISE correspondent à celles de l'offre. Un « $ » seul est ambigu
// (USD, CAD…) : il n'est jamais confirmé par défaut. Aucune conversion ni taux de change : on compare, on ne convertit pas.
// Limites connues : montants sans symbole ni code (« 49/mois »), montants en toutes lettres, et formulations sans devise.

const CUR = [
  "k€", "k\\$",
  "(?<![A-Za-z])(?:CA|C|US)\\$", // CA$49, C$49, US$49
  "\\$\\s?(?:CAD|USD|CA|US)\\b", // 49 $ CA, 49 $US
  "€", "\\$", "£", "USD", "EUR", "CAD", "CHF", "GBP",
  "dollars?\\s(?:canadiens?|am[ée]ricains?|US|CA)\\b",
  "dollars?", "euros?",
].join("|");
const AMOUNT_RE = new RegExp(String.raw`(?:(?:${CUR})\s?\d[\d\s.,]*\d|(?:${CUR})\s?\d|\d[\d\s.,]*\d\s?(?:${CUR})|\d\s?(?:${CUR}))`, "gi");
// « de 29 à 49 $ » : le nombre juste avant un connecteur de plage est la borne basse, qui hérite de la devise de la borne haute.
const RANGE_BEFORE = /(?<![\d.,])(\d[\d\s.,]*?\d|\d)\s*(?:à|-|–|—|to)\s*$/i;

function numberOf(token: string): number | null {
  const m = token.match(/\d[\d\s.,]*/);
  if (!m) return null;
  let s = m[0].replace(/\s/g, "").replace(/[.,]$/, "");
  // « 1.299,50 » / « 1,299.50 » / « 49,90 » / « 49.90 » : le dernier séparateur suivi de 1-2 chiffres est décimal
  const dec = s.match(/[.,](\d{1,2})$/);
  s = dec ? s.slice(0, s.length - dec[0].length).replace(/[.,]/g, "") + "." + dec[1] : s.replace(/[.,]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? (/k/i.test(token) ? n * 1000 : n) : null;
}

/** Devise détectée dans un montant : code ISO, « DOLLAR » pour un « $ » ou « dollars » sans précision, null si indéterminée. */
export type DetectedCurrency = "EUR" | "GBP" | "CHF" | "CAD" | "USD" | "DOLLAR" | null;

export function currencyOf(raw: string): DetectedCurrency {
  const r = raw.toLowerCase();
  if (/€|\beuros?\b|\beur\b/.test(r)) return "EUR";
  if (/£|\bgbp\b/.test(r)) return "GBP";
  if (/\bchf\b/.test(r)) return "CHF";
  if (/\bcad\b|ca\$|(?<![a-z])c\$|\$\s?ca\b|canadiens?/.test(r)) return "CAD";
  if (/\busd\b|us\$|\$\s?us\b|am[ée]ricains?/.test(r)) return "USD";
  if (/\$|dollars?/.test(r)) return "DOLLAR";
  return null;
}

export type FoundAmount = { raw: string; value: number; currency: DetectedCurrency };

export function amountsIn(text: string): FoundAmount[] {
  const out: FoundAmount[] = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const v = numberOf(m[0]);
    if (v === null) continue;
    const raw = m[0].trim();
    const currency = currencyOf(raw);
    const low = RANGE_BEFORE.exec(text.slice(0, m.index));
    if (low) {
      const lv = numberOf(low[1]);
      if (lv !== null) out.push({ raw: raw.replace(/\d[\d\s.,]*\d|\d/, low[1].trim()), value: lv, currency });
    }
    out.push({ raw, value: v, currency });
  }
  return out;
}

/**
 * Faits d'une offre. `currency` : devise de l'offre (ex. « CAD »). `undefined` = non fournie (comparaison sur la valeur seule,
 * comportement historique) ; `null` ou inconnue = fournie mais indéterminée (aucun montant ne peut être confirmé sur la devise).
 */
export type OfferFacts = { price?: number | null; currency?: string | null; texts?: (string | null | undefined)[] };

export type AmountVerdict = "confirmed" | "wrong_amount" | "wrong_currency" | "ambiguous_currency";
export type AssessedAmount = FoundAmount & { verdict: AmountVerdict };

type Compat = "match" | "ambiguous" | "mismatch";
const DOLLAR_FAMILY = new Set(["USD", "CAD", "AUD", "NZD", "MXN", "SGD", "HKD"]);
const NON_DOLLAR = new Set(["EUR", "GBP", "CHF", "JPY", "SEK", "NOK", "DKK", "PLN", "CZK"]);

function compat(ad: DetectedCurrency, ref: string | null): Compat {
  if (!ad || !ref) return "ambiguous";
  const r = ref.toUpperCase();
  if (ad === "DOLLAR") {
    if (r === "DOLLAR") return "match"; // le même « $ » écrit par l'utilisateur lui-même
    if (DOLLAR_FAMILY.has(r)) return "ambiguous"; // USD ? CAD ? : jamais confirmé par défaut
    return NON_DOLLAR.has(r) ? "mismatch" : "ambiguous";
  }
  if (r === "DOLLAR") return NON_DOLLAR.has(ad) ? "mismatch" : "ambiguous";
  return ad === r ? "match" : "mismatch";
}

/** Verdict de chaque montant de `content` par rapport à l'offre (prix officiel + montants écrits dans ses textes). */
export function assessAmounts(content: string, offer?: OfferFacts | null): AssessedAmount[] {
  const legacy = offer?.currency === undefined; // devise non fournie : valeur seule
  const refs: { value: number; currency: string | null }[] = [];
  if (offer?.price != null && offer.price > 0) refs.push({ value: offer.price, currency: legacy ? "" : offer.currency ?? null });
  for (const t of offer?.texts ?? []) if (t) for (const a of amountsIn(t)) refs.push({ value: a.value, currency: a.currency });

  const seen = new Set<string>();
  const res: AssessedAmount[] = [];
  for (const a of amountsIn(content)) {
    if (seen.has(a.raw)) continue;
    seen.add(a.raw);
    const same = refs.filter((r) => r.value === a.value);
    let verdict: AmountVerdict = "wrong_amount";
    if (same.length) {
      const cs = same.map((r) => (legacy ? "match" : compat(a.currency, r.currency)));
      verdict = cs.includes("match") ? "confirmed" : cs.includes("ambiguous") ? "ambiguous_currency" : "wrong_currency";
    }
    res.push({ ...a, verdict });
  }
  return res;
}

/**
 * Montants cités dans `content` qui ne sont pas confirmés par l'offre : valeur absente, devise différente ou devise ambiguë.
 * Liste vide = rien à signaler.
 */
export function unconfirmedAmounts(content: string, offer?: OfferFacts | null): string[] {
  return assessAmounts(content, offer).filter((a) => a.verdict !== "confirmed").map((a) => a.raw);
}

export function offerFactsOf(o: { price: number | null; currency?: string | null; name: string; description: string | null; problem: string | null; advantages: unknown; differentiation: string | null }): OfferFacts {
  return { price: o.price, currency: o.currency, texts: [o.name, o.description, o.problem, o.differentiation, ...(Array.isArray(o.advantages) ? (o.advantages as unknown[]).map(String) : [])] };
}

/** Consigne de prompt : le seul prix autorisé est celui de l'offre ; sinon aucun prix. */
export function priceRule(price: number | null | undefined, currency?: string | null): string {
  if (price != null && price > 0) return `Prix de l'offre fourni par l'utilisateur : ${price} ${currency ?? ""}. C'est le SEUL montant que tu peux citer ; n'invente ni remise, ni tarif d'essai, ni autre prix.`.replace("  ", " ");
  return "AUCUN prix n'a été fourni pour cette offre : ne mentionne AUCUN prix, tarif, montant, abonnement, remise ni essai chiffré, et ne propose aucune formule du type « à partir de X ».";
}

// ───────────── Rattachement d'une annonce à son offre, et verdict du badge ─────────────
// Une annonce n'a pas de colonne « offre » : le lien fiable est l'offre de la génération (AIGeneration.input.offerId, écrit par
// generateAdsAction), à défaut l'offre de la campagne. Sans offre valide de l'espace, aucun montant ne peut être déclaré confirmé.

export type AdOfferLink = { offerId: string | null; via: "generation" | "campaign" | "none" };

/**
 * `validOfferIds` : identifiants des offres qui existent réellement dans l'espace de travail de l'annonce. Une offre absente de
 * cet ensemble (supprimée, d'un autre espace, invalide) ne peut jamais servir de preuve : on passe au repli suivant.
 */
export function adOfferLink(
  ad: { generationId?: string | null; campaignId?: string | null },
  offerOfGeneration: ReadonlyMap<string, string | null>,
  offerOfCampaign: ReadonlyMap<string, string | null>,
  validOfferIds: ReadonlySet<string>,
): AdOfferLink {
  const g = ad.generationId ? offerOfGeneration.get(ad.generationId) : null;
  if (g && validOfferIds.has(g)) return { offerId: g, via: "generation" };
  const c = ad.campaignId ? offerOfCampaign.get(ad.campaignId) : null;
  if (c && validOfferIds.has(c)) return { offerId: c, via: "campaign" };
  return { offerId: null, via: "none" };
}

/** `input` d'une génération (JSON) → identifiant d'offre, ou null si absent ou mal formé. */
export function offerIdFromGenerationInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const v = (input as Record<string, unknown>).offerId;
  return typeof v === "string" && v.length > 0 ? v : null;
}

export type AdAmountState = "no_amount" | "confirmed" | "unconfirmed" | "currency_mismatch" | "currency_ambiguous" | "unlinked";
export type AdAmountCheck = {
  /**
   * no_amount : rien à signaler · confirmed : tous les montants sont ceux de l'offre, dans sa devise · unconfirmed : un montant absent de l'offre ·
   * currency_mismatch : valeur connue mais devise différente · currency_ambiguous : « $ » seul face à une offre en USD/CAD… · unlinked : offre introuvable
   */
  state: AdAmountState;
  amounts: string[];
  /** Montants non confirmés (valeur, devise différente ou ambiguë, ou offre introuvable). */
  unconfirmed: string[];
};

export function checkAdAmounts(content: string, facts: OfferFacts | null | undefined): AdAmountCheck {
  if (!facts) {
    const amounts = [...new Set(amountsIn(content).map((a) => a.raw))];
    return amounts.length ? { state: "unlinked", amounts, unconfirmed: amounts } : { state: "no_amount", amounts, unconfirmed: [] };
  }
  const items = assessAmounts(content, facts);
  const amounts = items.map((a) => a.raw);
  if (items.length === 0) return { state: "no_amount", amounts, unconfirmed: [] };
  const bad = items.filter((a) => a.verdict !== "confirmed");
  const has = (v: AmountVerdict) => bad.some((a) => a.verdict === v);
  const state: AdAmountState = has("wrong_amount") ? "unconfirmed" : has("wrong_currency") ? "currency_mismatch" : has("ambiguous_currency") ? "currency_ambiguous" : "confirmed";
  return { state, amounts, unconfirmed: bad.map((a) => a.raw) };
}

/** Libellé du badge d'une annonce IA (null = aucun badge). Le texte historique « montant non confirmé » est conservé pour le cas « montant absent ». */
export function adBadge(check: AdAmountCheck | null | undefined): { label: string; detail: string } | null {
  if (!check || check.state === "no_amount" || check.state === "confirmed") return null;
  const list = check.unconfirmed.join(", ");
  switch (check.state) {
    case "unconfirmed": return { label: "montant non confirmé", detail: `Montant(s) absent(s) du prix et des textes de l'offre : ${list}` };
    case "currency_mismatch": return { label: "devise différente de l'offre", detail: `Même montant mais devise différente de celle de l'offre : ${list}` };
    case "currency_ambiguous": return { label: "devise ambiguë", detail: `« $ » seul : précisez la devise (CAD, USD…) : ${list}` };
    default: return { label: "offre d'origine introuvable", detail: `Impossible de vérifier ce montant, l'offre d'origine est introuvable. Corrigez le texte si besoin : ${list}` };
  }
}
