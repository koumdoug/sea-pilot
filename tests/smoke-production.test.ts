import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { parseBase, runSmoke, summarize, type FetchLike } from "../scripts/smoke-production";

// Test de fumée de production : logique testée contre un faux site (aucune requête réseau réelle).

type R = { status: number; headers?: Record<string, string>; body?: string };
const healthy: Record<string, R> = {
  "GET /api/health": { status: 200, body: JSON.stringify({ status: "ok", db: "up" }) },
  "GET /": { status: 200, headers: { "x-frame-options": "SAMEORIGIN", "strict-transport-security": "max-age=63072000" } },
  "GET /login": { status: 200 }, "GET /register": { status: 200 }, "GET /demo": { status: 200 }, "GET /privacy": { status: 200 }, "GET /terms": { status: 200 },
  "GET /robots.txt": { status: 200, body: "User-agent: *\nDisallow: /api/\n" }, "GET /sitemap.xml": { status: 200 },
  "GET /cette-page-n-existe-pas-smoke": { status: 404 },
  "GET /dashboard": { status: 307, headers: { location: "/login" } }, "GET /billing": { status: 307, headers: { location: "/login" } },
  "GET /settings": { status: 307, headers: { location: "/login" } }, "GET /leads": { status: 307, headers: { location: "/login" } },
  "POST /api/v1/leads": { status: 401 }, "GET /api/export": { status: 307, headers: { location: "/login" } },
  "POST /api/stripe/webhook": { status: 400 }, "POST /api/cron/followups": { status: 401 },
  "GET /api/unsubscribe/jeton-invalide-smoke": { status: 404 },
};
function site(over: Record<string, R | "down"> = {}) {
  const calls: { method: string; path: string; headers: Record<string, string>; body?: string }[] = [];
  const table = { ...healthy, ...over };
  const f: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ method: init.method, path, headers: init.headers ?? {}, body: init.body });
    const r = table[`${init.method} ${path}`];
    if (r === "down" || r === undefined) throw new Error("réseau");
    return { status: r.status, headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null }, text: async () => r.body ?? "" };
  };
  return { f, calls };
}
const run = async (over: Record<string, R | "down"> = {}, base = "https://app.exemple.test") => runSmoke(base, site(over).f);
const fails = (c: Awaited<ReturnType<typeof run>>) => c.filter((x) => x.level === "fail").map((x) => x.name);

describe("site sain", () => {
  it("aucun échec ni avertissement", async () => {
    const c = await run();
    expect(c.filter((x) => x.level !== "ok")).toEqual([]);
    expect(summarize(c)).toMatchObject({ fails: 0, warns: 0 });
  });

  it("n'envoie que des GET et trois POST non authentifiés, sans en-tête d'autorisation ni secret ; la tâche planifiée n'est appelée qu'une fois, sans secret", async () => {
    const s = site();
    await runSmoke("https://app.exemple.test", s.f);
    expect(s.calls.filter((c) => c.method === "POST").map((c) => c.path).sort()).toEqual(["/api/cron/followups", "/api/stripe/webhook", "/api/v1/leads"]);
    expect(s.calls.every((c) => ["GET", "POST"].includes(c.method))).toBe(true);
    expect(s.calls.some((c) => Object.keys(c.headers).some((h) => /authorization|stripe-signature|cookie/i.test(h)))).toBe(false);
    expect(s.calls.filter((c) => c.path === "/api/cron/followups")).toHaveLength(1);
    expect(s.calls.find((c) => c.path === "/api/stripe/webhook")!.body).toBe("{}");
  });
});

describe("pannes détectées", () => {
  it("application arrêtée : tout échoue sans exception", async () => {
    const all = Object.fromEntries(Object.keys(healthy).map((k) => [k, "down" as const]));
    const c = await run(all);
    expect(fails(c)).toEqual(expect.arrayContaining(["Santé /api/health", "Page /", "Page /login", "Webhook Stripe", "Tâche planifiée"]));
  });
  it("base indisponible (503) ou contenu inattendu de /api/health", async () => {
    expect(fails(await run({ "GET /api/health": { status: 503, body: "{}" } }))).toContain("Santé /api/health");
    expect(fails(await run({ "GET /api/health": { status: 200, body: JSON.stringify({ status: "ok", db: "down" }) } }))).toContain("Santé /api/health");
    expect(fails(await run({ "GET /api/health": { status: 200, body: "pas du json" } }))).toContain("Santé /api/health");
  });
  it("page publique critique en erreur : échec ; page secondaire : simple avertissement", async () => {
    expect(fails(await run({ "GET /login": { status: 500 } }))).toContain("Page /login");
    const c = await run({ "GET /terms": { status: 500 } });
    expect(fails(c)).toEqual([]);
    expect(c.find((x) => x.name === "Page /terms")!.level).toBe("warn");
  });
  it("page privée accessible sans session : échec", async () => {
    expect(fails(await run({ "GET /billing": { status: 200 } }))).toContain("Page privée /billing");
    expect(fails(await run({ "GET /dashboard": { status: 307, headers: { location: "/ailleurs" } } }))).toContain("Page privée /dashboard");
    expect(fails(await run({ "GET /settings": { status: 403 } }))).toEqual([]);
  });
  it("API v1 sans clé acceptée, export sans session ouvert : échecs", async () => {
    expect(fails(await run({ "POST /api/v1/leads": { status: 200 } }))).toContain("API v1 sans clé");
    expect(fails(await run({ "GET /api/export": { status: 200 } }))).toContain("Export sans session");
  });
  it("webhook : non configuré (503), accepte le non signé (200), réponse inattendue : échecs ; 400 : correct", async () => {
    expect(fails(await run({ "POST /api/stripe/webhook": { status: 503 } }))).toContain("Webhook Stripe");
    const crit = await run({ "POST /api/stripe/webhook": { status: 200 } });
    expect(crit.find((x) => x.name === "Webhook Stripe")!.detail).toMatch(/faille critique/);
    expect(fails(await run({ "POST /api/stripe/webhook": { status: 500 } }))).toContain("Webhook Stripe");
  });
  it("tâche planifiée : non configurée (503), s'exécute sans secret (200), réponse inattendue : échecs ; 401 : correct", async () => {
    expect(fails(await run({ "POST /api/cron/followups": { status: 503 } }))).toContain("Tâche planifiée");
    const crit = await run({ "POST /api/cron/followups": { status: 200 } });
    expect(crit.find((x) => x.name === "Tâche planifiée")!.detail).toMatch(/faille critique/);
    expect(fails(await run({ "POST /api/cron/followups": { status: 500 } }))).toContain("Tâche planifiée");
  });
  it("erreur serveur sur une page inexistante ou sur un jeton de désinscription invalide : échecs", async () => {
    expect(fails(await run({ "GET /cette-page-n-existe-pas-smoke": { status: 500 } }))).toContain("Page inexistante");
    expect(fails(await run({ "GET /api/unsubscribe/jeton-invalide-smoke": { status: 500 } }))).toContain("Désinscription (jeton invalide)");
  });
});

describe("avertissements", () => {
  const warns = (c: Awaited<ReturnType<typeof run>>) => c.filter((x) => x.level === "warn").map((x) => x.name);
  it("en-têtes de sécurité absents, robots sans exclusion de /api/, sitemap absent", async () => {
    expect(warns(await run({ "GET /": { status: 200 } }))).toEqual(expect.arrayContaining(["En-tête X-Frame-Options", "En-tête HSTS"]));
    expect(warns(await run({ "GET /robots.txt": { status: 200, body: "User-agent: *\nAllow: /" } }))).toContain("robots.txt");
    expect(warns(await run({ "GET /sitemap.xml": { status: 404 } }))).toContain("sitemap.xml");
  });
  it("HSTS non exigé en http local", async () => {
    const c = await run({ "GET /": { status: 200, headers: { "x-frame-options": "SAMEORIGIN" } } }, "http://localhost:3000");
    expect(c.some((x) => x.name === "En-tête HSTS")).toBe(false);
  });
});

describe("parseBase", () => {
  it("https accepté (chemin ignoré) ; http uniquement en local ; identifiants et valeurs invalides refusés", () => {
    expect(parseBase("https://app.exemple.test/chemin?x=1")).toEqual({ ok: true, base: "https://app.exemple.test", secure: true });
    expect(parseBase("http://localhost:3101")).toMatchObject({ ok: true, secure: false });
    expect(parseBase("http://127.0.0.1:3000")).toMatchObject({ ok: true });
    for (const bad of [undefined, "", "pas une url", "http://app.exemple.test", "ftp://x.test", "https://user:pw@app.exemple.test"]) expect(parseBase(bad as string | undefined), String(bad)).toMatchObject({ ok: false });
  });
});

describe("ligne de commande — refus sans requête", () => {
  const cli = (args: string[], env: Record<string, string> = {}) =>
    spawnSync("npx", ["tsx", "scripts/smoke-production.ts", ...args], { encoding: "utf8", shell: true, env: { ...process.env, APP_URL: "", ...env }, timeout: 60_000 });
  it("sans --read-only-confirmed : refus (code 2)", () => {
    const r = cli(["--base-url=https://app.exemple.test"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--read-only-confirmed");
  });
  it("URL manquante ou http distant : refus (code 2)", () => {
    expect(cli(["--read-only-confirmed"]).status).toBe(2);
    const r = cli(["--read-only-confirmed", "--base-url=http://app.exemple.test"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("https obligatoire");
  });
});
