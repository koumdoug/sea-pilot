// Contrôle des prix Stripe configurés (LECTURE SEULE) : compare STRIPE_PRICE_STARTER / GROWTH / PRO (et les *_LEGACY) à ce que Stripe renvoie réellement, pour éviter un déploiement avec un
// mauvais prix, un prix archivé, un mauvais mode (test/production) ou un mauvais compte.
//
//   npx tsx --env-file=<fichier d'environnement de la production> scripts/check-stripe-prices.ts --read-only-confirmed
//
// Garanties : uniquement des requêtes GET vers api.stripe.com (prix et liste des prix actifs) ; la clé secrète n'est JAMAIS affichée (ni dans les résultats, ni dans les erreurs : seuls le statut HTTP
// et le type d'erreur Stripe sont rapportés) ; les identifiants de prix et les montants (non secrets) sont affichés pour comparaison humaine. Code de sortie : 0 = aucune erreur, 1 = au moins une erreur,
// 2 = refus ou configuration insuffisante (rien n'a été envoyé).
const PLANS = ["starter", "growth", "pro"] as const;
type Plan = (typeof PLANS)[number];

export type PriceInfo = {
  id: string; active: boolean; livemode: boolean; type: string; currency: string; unitAmount: number | null;
  interval: string | null; intervalCount: number | null; productActive: boolean | null; productName: string | null;
};
export type Fetched = PriceInfo | "missing" | "unreadable";
export type Finding = { level: "ok" | "warn" | "error"; message: string };

export type EvaluateInput = {
  /** Mode de la clé secrète : true = production, false = test, null = clé inconnue. */
  keyLive: boolean | null;
  configured: Record<Plan, string | undefined>;
  legacy: Record<Plan, string[]>;
  fetched: Record<string, Fetched>;
  /** Prix récurrents actifs du compte (null = liste non lue). */
  activeRecurring: PriceInfo[] | null;
};

const money = (p: PriceInfo) => (p.unitAmount === null ? "montant inconnu" : `${(p.unitAmount / 100).toFixed(2)} ${p.currency.toUpperCase()}`);

/** Évalue la configuration contre ce que Stripe a renvoyé. Fonction pure, sans réseau ni secret. */
export function evaluate(i: EvaluateInput): Finding[] {
  const out: Finding[] = [];
  const err = (message: string) => out.push({ level: "error", message });
  const warn = (message: string) => out.push({ level: "warn", message });
  const ok = (message: string) => out.push({ level: "ok", message });
  const seen = new Map<string, Plan>();
  const good: Partial<Record<Plan, PriceInfo>> = {};

  if (i.keyLive === null) warn("Mode de la clé Stripe inconnu (préfixe inattendu) : la cohérence test/production n'est pas vérifiée.");
  for (const plan of PLANS) {
    const label = `STRIPE_PRICE_${plan.toUpperCase()}`;
    const id = i.configured[plan];
    if (!id) { err(`${label} absent : aucun paiement possible pour ce forfait.`); continue; }
    if (!/^price_\S+$/.test(id)) { err(`${label} : format inattendu (price_… attendu).`); continue; }
    const dup = seen.get(id);
    if (dup) err(`${label} identique à STRIPE_PRICE_${dup.toUpperCase()} (${id}) : deux forfaits ne peuvent pas partager un prix.`);
    seen.set(id, plan);
    const f = i.fetched[id];
    if (f === undefined || f === "unreadable") { err(`${label} (${id}) : lecture impossible chez Stripe (clé, réseau ou droits).`); continue; }
    if (f === "missing") { err(`${label} (${id}) : introuvable dans ce compte Stripe (mauvais compte ou mauvais mode ?).`); continue; }
    let bad = false;
    if (!f.active) { err(`${label} (${id}) : prix ARCHIVÉ (inactif) : les paiements échoueront.`); bad = true; }
    if (i.keyLive !== null && f.livemode !== i.keyLive) { err(`${label} (${id}) : prix ${f.livemode ? "de production" : "de test"} alors que la clé est ${i.keyLive ? "de production" : "de test"}.`); bad = true; }
    if (f.type !== "recurring") { err(`${label} (${id}) : prix à paiement unique, un abonnement exige un prix récurrent.`); bad = true; }
    else if (f.interval !== "month" || f.intervalCount !== 1) warn(`${label} (${id}) : périodicité ${f.intervalCount ?? "?"} ${f.interval ?? "?"} (mensuelle attendue).`);
    if (f.productActive === false) warn(`${label} (${id}) : le produit « ${f.productName ?? "?"} » est archivé.`);
    if (!bad) { ok(`${label} = ${id} : ${money(f)} / ${f.interval ?? "?"}, actif${f.productName ? `, produit « ${f.productName} »` : ""}.`); good[plan] = f; }
  }

  const priced = PLANS.map((p) => good[p]).filter((x): x is PriceInfo => !!x);
  if (new Set(priced.map((p) => p.currency)).size > 1) warn("Devises différentes entre les forfaits configurés.");
  if (good.starter && good.growth && good.pro && good.starter.currency === good.growth.currency && good.growth.currency === good.pro.currency) {
    const a = good.starter.unitAmount, b = good.growth.unitAmount, c = good.pro.unitAmount;
    if (a !== null && b !== null && c !== null && !(a < b && b < c)) warn(`Les montants ne croissent pas de Starter à Pro (${a / 100} < ${b / 100} < ${c / 100} attendu) : vérifiez que chaque variable pointe vers le bon forfait.`);
  }

  const current = new Set(Object.values(i.configured).filter((x): x is string => !!x));
  for (const plan of PLANS) {
    for (const id of i.legacy[plan]) {
      const label = `STRIPE_PRICE_${plan.toUpperCase()}_LEGACY`;
      if (!/^price_\S+$/.test(id)) { err(`${label} : « ${id.slice(0, 40)} » n'a pas le format price_….`); continue; }
      if (current.has(id)) { err(`${label} contient un prix COURANT (${id}) : un prix ne peut pas être à la fois courant et historique (résolution ambiguë).`); continue; }
      const f = i.fetched[id];
      if (f === "missing") warn(`${label} (${id}) : introuvable dans ce compte Stripe.`);
      else if (f === undefined || f === "unreadable") warn(`${label} (${id}) : lecture impossible.`);
      else ok(`${label} = ${id} : ${money(f)} (historique).`);
    }
  }

  if (i.activeRecurring === null) warn("Liste des prix actifs non lue : les prix actifs non configurés n'ont pas pu être repérés.");
  else {
    const known = new Set([...current, ...PLANS.flatMap((p) => i.legacy[p])]);
    for (const p of i.activeRecurring) {
      if (!known.has(p.id)) warn(`Prix récurrent ACTIF non configuré : ${p.id} (${money(p)}, produit « ${p.productName ?? "?"} »${p.productActive === false ? ", produit archivé" : ""}). S'il n'a plus d'usage, l'archiver évite une confusion.`);
    }
  }
  return out;
}

export function describeFindings(f: Finding[]): { text: string; errors: number; warnings: number } {
  const icon = { ok: "✅", warn: "⚠️ ", error: "❌" } as const;
  return {
    text: f.map((x) => `${icon[x.level]} ${x.message}`).join("\n"),
    errors: f.filter((x) => x.level === "error").length,
    warnings: f.filter((x) => x.level === "warn").length,
  };
}

/** Mode de la clé d'après son préfixe (sans jamais l'afficher). */
export const keyMode = (key: string): boolean | null => (/^(sk|rk)_live_/.test(key) ? true : /^(sk|rk)_test_/.test(key) ? false : null);

type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ status: number; ok: boolean; json: () => Promise<unknown> }>;
type RawPrice = {
  id?: string; active?: boolean; livemode?: boolean; type?: string; currency?: string; unit_amount?: number | null;
  recurring?: { interval?: string; interval_count?: number } | null; product?: { active?: boolean; name?: string } | string | null;
};
const toInfo = (r: RawPrice): PriceInfo => ({
  id: String(r.id ?? ""), active: !!r.active, livemode: !!r.livemode, type: String(r.type ?? ""), currency: String(r.currency ?? ""), unitAmount: typeof r.unit_amount === "number" ? r.unit_amount : null,
  interval: r.recurring?.interval ?? null, intervalCount: r.recurring?.interval_count ?? null,
  productActive: r.product && typeof r.product === "object" ? !!r.product.active : null, productName: r.product && typeof r.product === "object" ? r.product.name ?? null : null,
});

/** Lit un prix (GET). `missing` = 404 ; `unreadable` = toute autre erreur. Jamais d'exception, jamais de clé dans le résultat. */
export async function fetchPrice(id: string, key: string, f: FetchLike = fetch as unknown as FetchLike): Promise<Fetched> {
  try {
    const r = await f(`https://api.stripe.com/v1/prices/${encodeURIComponent(id)}?expand[]=product`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    if (r.status === 404) return "missing";
    if (!r.ok) return "unreadable";
    return toInfo((await r.json()) as RawPrice);
  } catch { return "unreadable"; }
}

/** Liste des prix récurrents actifs (une page de 100). `null` si illisible. */
export async function fetchActiveRecurring(key: string, f: FetchLike = fetch as unknown as FetchLike): Promise<PriceInfo[] | null> {
  try {
    const r = await f("https://api.stripe.com/v1/prices?active=true&type=recurring&limit=100&expand[]=data.product", { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    const body = (await r.json()) as { data?: RawPrice[] };
    return (body.data ?? []).map(toInfo);
  } catch { return null; }
}

const list = (v: string | undefined) => (v ?? "").split(",").map((x) => x.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
const clean = (v: string | undefined) => { const x = (v ?? "").trim().replace(/^['"]|['"]$/g, "").trim(); return x || undefined; };

async function main() {
  if (!process.argv.includes("--read-only-confirmed")) {
    console.error("Refus : ajoutez --read-only-confirmed pour confirmer que vous souhaitez interroger Stripe (lecture seule) avec la clé de STRIPE_SECRET_KEY.");
    process.exitCode = 2; return;
  }
  const key = clean(process.env.STRIPE_SECRET_KEY);
  if (!key) { console.error("STRIPE_SECRET_KEY absente : rien n'a été envoyé."); process.exitCode = 2; return; }
  const configured = Object.fromEntries(PLANS.map((p) => [p, clean(process.env[`STRIPE_PRICE_${p.toUpperCase()}`])])) as Record<Plan, string | undefined>;
  const legacy = Object.fromEntries(PLANS.map((p) => [p, list(process.env[`STRIPE_PRICE_${p.toUpperCase()}_LEGACY`])])) as Record<Plan, string[]>;
  const ids = [...new Set([...Object.values(configured), ...Object.values(legacy).flat()].filter((x): x is string => !!x && /^price_\S+$/.test(x)))];
  const mode = keyMode(key);
  console.log(`Clé Stripe : mode ${mode === null ? "inconnu" : mode ? "PRODUCTION" : "test"} (valeur non affichée). Lecture seule.`);
  const fetched: Record<string, Fetched> = {};
  for (const id of ids) fetched[id] = await fetchPrice(id, key);
  const active = await fetchActiveRecurring(key);
  const r = describeFindings(evaluate({ keyLive: mode, configured, legacy, fetched, activeRecurring: active }));
  console.log(r.text);
  console.log(`\n${r.errors} erreur(s), ${r.warnings} avertissement(s).`);
  process.exitCode = r.errors > 0 ? 1 : 0;
}

if (process.argv[1] && /check-stripe-prices\.[cm]?[tj]s$/.test(process.argv[1])) {
  main().catch(() => { console.error("Échec inattendu du contrôle (aucun détail affiché pour ne pas exposer de secret)."); process.exitCode = 1; });
}
