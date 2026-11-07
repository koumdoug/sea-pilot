import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { describeFindings, evaluate, fetchActiveRecurring, fetchPrice, keyMode, type EvaluateInput, type Fetched, type PriceInfo } from "../scripts/check-stripe-prices";

// Contrôle des prix Stripe (lecture seule) : logique pure testée sans réseau ni clé ; les appels HTTP sont simulés (aucune requête réelle).

const price = (id: string, amount: number, over: Partial<PriceInfo> = {}): PriceInfo => ({
  id, active: true, livemode: true, type: "recurring", currency: "cad", unitAmount: amount, interval: "month", intervalCount: 1, productActive: true, productName: `Produit ${id}`, ...over,
});
const P = { starter: price("price_s", 1900), growth: price("price_g", 4900), pro: price("price_p", 9900) };
const base = (over: Partial<EvaluateInput> = {}): EvaluateInput => ({
  keyLive: true,
  configured: { starter: "price_s", growth: "price_g", pro: "price_p" },
  legacy: { starter: [], growth: [], pro: [] },
  fetched: { price_s: P.starter, price_g: P.growth, price_p: P.pro },
  activeRecurring: [P.starter, P.growth, P.pro],
  ...over,
});
const levels = (i: EvaluateInput) => evaluate(i).map((f) => f.level);
const text = (i: EvaluateInput) => evaluate(i).map((f) => f.message).join("\n");

describe("evaluate — configuration saine", () => {
  it("trois prix mensuels actifs, bon mode, tous connus : aucune erreur ni avertissement", () => {
    const f = evaluate(base());
    expect(f.filter((x) => x.level !== "ok")).toEqual([]);
    expect(f.filter((x) => x.level === "ok")).toHaveLength(3);
    expect(f[0].message).toContain("19.00 CAD");
  });
});

describe("evaluate — erreurs bloquantes", () => {
  it("variable absente, format inattendu, prix introuvable ou illisible", () => {
    expect(text(base({ configured: { starter: undefined, growth: "price_g", pro: "price_p" } }))).toMatch(/STRIPE_PRICE_STARTER absent/);
    expect(text(base({ configured: { starter: "prod_123", growth: "price_g", pro: "price_p" } }))).toMatch(/format inattendu/);
    expect(text(base({ fetched: { ...base().fetched, price_g: "missing" } }))).toMatch(/introuvable dans ce compte/);
    expect(text(base({ fetched: { ...base().fetched, price_p: "unreadable" } }))).toMatch(/lecture impossible/);
    expect(levels(base({ fetched: { ...base().fetched, price_p: "unreadable" } }))).toContain("error");
  });

  it("prix archivé, paiement unique, mauvais mode : erreurs", () => {
    expect(text(base({ fetched: { ...base().fetched, price_s: price("price_s", 1900, { active: false }) } }))).toMatch(/ARCHIVÉ/);
    expect(text(base({ fetched: { ...base().fetched, price_s: price("price_s", 1900, { type: "one_time", interval: null, intervalCount: null }) } }))).toMatch(/paiement unique/);
    const t = text(base({ keyLive: true, fetched: { ...base().fetched, price_g: price("price_g", 4900, { livemode: false }) } }));
    expect(t).toMatch(/de test alors que la clé est de production/);
    expect(text(base({ keyLive: false }))).toMatch(/de production alors que la clé est de test/);
  });

  it("deux forfaits sur le même prix : erreur", () => {
    expect(text(base({ configured: { starter: "price_s", growth: "price_s", pro: "price_p" } }))).toMatch(/identique à STRIPE_PRICE_STARTER/);
  });

  it("prix historique identique à un prix courant ou au format invalide : erreur (résolution ambiguë)", () => {
    expect(text(base({ legacy: { starter: ["price_g"], growth: [], pro: [] } }))).toMatch(/prix COURANT/);
    expect(text(base({ legacy: { starter: [], growth: ["pas-un-prix"], pro: [] } }))).toMatch(/n'a pas le format/);
  });
});

describe("evaluate — avertissements", () => {
  const warns = (i: EvaluateInput) => evaluate(i).filter((x) => x.level === "warn").map((x) => x.message).join("\n");

  it("prix actif non configuré (ex. ancien prix) : signalé avec son montant, sans bloquer", () => {
    const stale = price("price_old", 1900, { productActive: false, productName: "SEA Pilot Starter" });
    const f = evaluate(base({ activeRecurring: [P.starter, P.growth, P.pro, stale] }));
    expect(f.filter((x) => x.level === "error")).toEqual([]);
    expect(warns(base({ activeRecurring: [P.starter, P.growth, P.pro, stale] }))).toMatch(/price_old.*19.00 CAD.*produit archivé/);
  });

  it("un prix historique déclaré n'est pas signalé comme « non configuré »", () => {
    const old = price("price_old", 900);
    const i = base({ legacy: { starter: ["price_old"], growth: [], pro: [] }, fetched: { ...base().fetched, price_old: old }, activeRecurring: [P.starter, P.growth, P.pro, old] });
    expect(warns(i)).toBe("");
    expect(text(i)).toMatch(/\(historique\)/);
  });

  it("montants qui ne croissent pas, devises différentes, périodicité inattendue, produit archivé, mode de clé inconnu, liste non lue", () => {
    expect(warns(base({ fetched: { ...base().fetched, price_s: price("price_s", 9900), price_p: price("price_p", 1900) } }))).toMatch(/ne croissent pas/);
    expect(warns(base({ fetched: { ...base().fetched, price_g: price("price_g", 4900, { currency: "usd" }) } }))).toMatch(/Devises différentes/);
    expect(warns(base({ fetched: { ...base().fetched, price_g: price("price_g", 4900, { interval: "year" }) } }))).toMatch(/mensuelle attendue/);
    expect(warns(base({ fetched: { ...base().fetched, price_g: price("price_g", 4900, { productActive: false, productName: "Ancien" }) } }))).toMatch(/produit « Ancien » est archivé/);
    expect(warns(base({ keyLive: null }))).toMatch(/Mode de la clé Stripe inconnu/);
    expect(warns(base({ activeRecurring: null }))).toMatch(/Liste des prix actifs non lue/);
  });

  it("historique introuvable ou illisible : simple avertissement", () => {
    const i = base({ legacy: { starter: ["price_x", "price_y"], growth: [], pro: [] }, fetched: { ...base().fetched, price_x: "missing", price_y: "unreadable" as Fetched } });
    expect(levels(i).filter((l) => l === "error")).toHaveLength(0);
    expect(warns(i)).toMatch(/price_x.*introuvable/);
  });
});

describe("describeFindings, keyMode", () => {
  it("compte les erreurs et avertissements", () => {
    const r = describeFindings([{ level: "ok", message: "a" }, { level: "warn", message: "b" }, { level: "error", message: "c" }, { level: "error", message: "d" }]);
    expect([r.errors, r.warnings]).toEqual([2, 1]);
    expect(r.text).toContain("❌ c");
  });
  it("mode de la clé d'après son préfixe, sans la renvoyer", () => {
    expect(keyMode("sk_live_abc")).toBe(true);
    expect(keyMode("rk_live_abc")).toBe(true);
    expect(keyMode("sk_test_abc")).toBe(false);
    expect(keyMode("autre")).toBeNull();
  });
});

describe("fetchPrice / fetchActiveRecurring — GET uniquement, jamais de clé dans le résultat", () => {
  const KEY = "sk_live_CLE_SECRETE_DE_TEST_1234567890";
  const raw = { id: "price_s", active: true, livemode: true, type: "recurring", currency: "cad", unit_amount: 1900, recurring: { interval: "month", interval_count: 1 }, product: { active: true, name: "SEA Pilot Starter" } };
  const reply = (status: number, body: unknown = {}) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });

  it("200 : champs convertis ; la requête est un GET d'un seul prix avec la clé en en-tête", async () => {
    const calls: { url: string; auth: string }[] = [];
    const f = await fetchPrice("price_s", KEY, async (url, init) => { calls.push({ url, auth: init.headers.authorization }); return { status: 200, ok: true, json: async () => raw }; });
    expect(f).toMatchObject({ id: "price_s", active: true, livemode: true, unitAmount: 1900, interval: "month", intervalCount: 1, productActive: true, productName: "SEA Pilot Starter" });
    expect(calls).toEqual([{ url: "https://api.stripe.com/v1/prices/price_s?expand[]=product", auth: `Bearer ${KEY}` }]);
  });

  it("404 : « missing » ; 401, 500, panne réseau, délai dépassé : « unreadable » ; la clé n'apparaît jamais dans le résultat", async () => {
    expect(await fetchPrice("price_x", KEY, reply(404))).toBe("missing");
    for (const s of [401, 403, 429, 500]) expect(await fetchPrice("price_x", KEY, reply(s, { error: { message: `Invalid API Key provided: ${KEY}` } }))).toBe("unreadable");
    expect(await fetchPrice("price_x", KEY, async () => { throw new Error(`réseau ${KEY}`); })).toBe("unreadable");
    expect(JSON.stringify(await fetchPrice("price_x", KEY, reply(200, raw)))).not.toContain(KEY);
  });

  it("identifiant encodé dans l'URL (aucune injection de chemin)", async () => {
    let url = "";
    await fetchPrice("price_a/../../customers", KEY, async (u) => { url = u; return { status: 404, ok: false, json: async () => ({}) }; });
    expect(url).toBe("https://api.stripe.com/v1/prices/price_a%2F..%2F..%2Fcustomers?expand[]=product");
  });

  it("liste des prix actifs : convertie ; erreur : null", async () => {
    const l = await fetchActiveRecurring(KEY, reply(200, { data: [raw, { ...raw, id: "price_2" }] }));
    expect(l?.map((x) => x.id)).toEqual(["price_s", "price_2"]);
    expect(await fetchActiveRecurring(KEY, reply(500))).toBeNull();
    expect(await fetchActiveRecurring(KEY, async () => { throw new Error("x"); })).toBeNull();
  });
});

describe("ligne de commande — refus sans effet réseau", () => {
  const run = (args: string[], env: Record<string, string>) =>
    spawnSync("npx", ["tsx", "scripts/check-stripe-prices.ts", ...args], { encoding: "utf8", shell: true, env: { ...process.env, STRIPE_SECRET_KEY: "", ...env }, timeout: 60_000 });

  it("sans --read-only-confirmed : refus (code 2), rien n'est envoyé", () => {
    const r = run([], { STRIPE_SECRET_KEY: "sk_test_ne_sera_pas_utilisee" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--read-only-confirmed");
    expect(r.stdout + r.stderr).not.toContain("sk_test_ne_sera_pas_utilisee");
  });
  it("avec --read-only-confirmed mais sans clé : refus (code 2)", () => {
    const r = run(["--read-only-confirmed"], {});
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("STRIPE_SECRET_KEY absente");
  });
});
