// Garde-fou « montants non confirmés » : une annonce ou une variante générée par l'IA ne doit jamais présenter comme un fait
// un prix que l'utilisateur n'a pas fourni. On repère les montants chiffrés et on les compare au prix et aux textes de l'offre.
// Rien n'est supprimé : le résultat sert uniquement à étiqueter le contenu (« montant non confirmé »).

const CUR = "k€|k\\$|€|\\$|£|USD|EUR|CAD|CHF|GBP|dollars?|euros?";
const AMOUNT_RE = new RegExp(String.raw`(?:(?:${CUR})\s?\d[\d\s.,]*\d|(?:${CUR})\s?\d|\d[\d\s.,]*\d\s?(?:${CUR})|\d\s?(?:${CUR}))`, "gi");

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

export function amountsIn(text: string): { raw: string; value: number }[] {
  const out: { raw: string; value: number }[] = [];
  for (const m of text.matchAll(AMOUNT_RE)) {
    const v = numberOf(m[0]);
    if (v !== null) out.push({ raw: m[0].trim(), value: v });
  }
  return out;
}

export type OfferFacts = { price?: number | null; texts?: (string | null | undefined)[] };

/**
 * Montants cités dans `content` qui ne correspondent ni au prix de l'offre ni à un montant écrit par l'utilisateur
 * dans les textes de l'offre. Liste vide = rien à signaler.
 */
export function unconfirmedAmounts(content: string, offer?: OfferFacts | null): string[] {
  const allowed = new Set<number>();
  if (offer?.price != null && offer.price > 0) allowed.add(offer.price);
  for (const t of offer?.texts ?? []) if (t) for (const a of amountsIn(t)) allowed.add(a.value);
  const seen = new Set<string>();
  const res: string[] = [];
  for (const a of amountsIn(content)) {
    if (allowed.has(a.value) || seen.has(a.raw)) continue;
    seen.add(a.raw);
    res.push(a.raw);
  }
  return res;
}

export function offerFactsOf(o: { price: number | null; name: string; description: string | null; problem: string | null; advantages: unknown; differentiation: string | null }): OfferFacts {
  return { price: o.price, texts: [o.name, o.description, o.problem, o.differentiation, ...(Array.isArray(o.advantages) ? (o.advantages as unknown[]).map(String) : [])] };
}

/** Consigne de prompt : le seul prix autorisé est celui de l'offre ; sinon aucun prix. */
export function priceRule(price: number | null | undefined, currency?: string | null): string {
  if (price != null && price > 0) return `Prix de l'offre fourni par l'utilisateur : ${price} ${currency ?? ""}. C'est le SEUL montant que tu peux citer ; n'invente ni remise, ni tarif d'essai, ni autre prix.`.replace("  ", " ");
  return "AUCUN prix n'a été fourni pour cette offre : ne mentionne AUCUN prix, tarif, montant, abonnement, remise ni essai chiffré, et ne propose aucune formule du type « à partir de X ».";
}
