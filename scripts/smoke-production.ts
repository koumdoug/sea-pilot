// Test de fumée d'un déploiement (LECTURE SEULE) : vérifie en quelques secondes que l'application répond, que la base est joignable, que les pages privées et les API sont protégées, et que le webhook
// Stripe et la tâche planifiée sont correctement configurés — sans jamais s'authentifier ni rien modifier.
//
//   npx tsx scripts/smoke-production.ts --base-url=https://votre-domaine --read-only-confirmed        (ou APP_URL dans l'environnement)
//
// Garanties : requêtes GET, plus TROIS requêtes POST NON AUTHENTIFIÉES (webhook Stripe sans signature, tâche planifiée sans secret, API v1 sans clé) qui doivent être REFUSÉES avant tout effet ; la tâche
// planifiée n'est jamais appelée avec son secret (elle enverrait de vrais e-mails). Aucun secret n'est lu ni affiché. Code de sortie : 0 = aucun échec, 1 = au moins un échec, 2 = refus ou paramètre invalide.
export type Level = "ok" | "warn" | "fail";
export type Check = { level: Level; name: string; detail: string };
type Resp = { status: number; headers: { get(name: string): string | null }; text: () => Promise<string> };
export type FetchLike = (url: string, init: { method: string; headers?: Record<string, string>; body?: string; redirect: "manual"; signal?: AbortSignal }) => Promise<Resp>;

const SLOW_MS = 5_000;
const isLocal = (h: string) => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(h);

/** URL de base valide : https obligatoire (sauf boucle locale), sans chemin ni identifiants. */
export function parseBase(raw: string | undefined): { ok: true; base: string; secure: boolean } | { ok: false; reason: string } {
  if (!raw) return { ok: false, reason: "URL de base absente (--base-url=… ou APP_URL)." };
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, reason: "URL de base illisible." }; }
  if (u.username || u.password) return { ok: false, reason: "L'URL de base ne doit contenir aucun identifiant." };
  if (u.protocol !== "https:" && !(u.protocol === "http:" && isLocal(u.hostname))) return { ok: false, reason: "https obligatoire (http n'est accepté que pour localhost)." };
  return { ok: true, base: u.origin, secure: u.protocol === "https:" };
}

/** Exécute les contrôles. Fonction sans état : `f` est injectable pour les tests. */
export async function runSmoke(base: string, f: FetchLike): Promise<Check[]> {
  const out: Check[] = [];
  const add = (level: Level, name: string, detail: string) => out.push({ level, name, detail });
  const call = async (method: string, path: string, body?: string, headers?: Record<string, string>) => {
    const t0 = Date.now();
    try {
      const r = await f(base + path, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(15_000) });
      return { r, ms: Date.now() - t0 };
    } catch { return { r: null, ms: Date.now() - t0 }; }
  };
  const slow = (name: string, ms: number) => { if (ms > SLOW_MS) add("warn", `${name} : lenteur`, `${ms} ms (seuil ${SLOW_MS} ms)`); };
  const location = (r: Resp) => r.headers.get("location") ?? "";

  // 1. Santé et base de données
  {
    const { r, ms } = await call("GET", "/api/health");
    if (!r) add("fail", "Santé /api/health", "aucune réponse (réseau, DNS, certificat ou service arrêté)");
    else if (r.status !== 200) add("fail", "Santé /api/health", `HTTP ${r.status} (200 attendu) : l'application ou la base est indisponible`);
    else {
      const j = await r.text().then((t) => { try { return JSON.parse(t) as { status?: string; db?: string }; } catch { return null; } });
      if (j?.status === "ok" && j.db === "up") add("ok", "Santé /api/health", `application et base joignables (${ms} ms)`);
      else add("fail", "Santé /api/health", "réponse 200 mais contenu inattendu (status/db)");
    }
    slow("Santé /api/health", ms);
  }

  // 2. Pages publiques
  for (const [path, critical] of [["/", true], ["/login", true], ["/register", false], ["/demo", false], ["/privacy", false], ["/terms", false]] as const) {
    const { r, ms } = await call("GET", path);
    if (!r) add(critical ? "fail" : "warn", `Page ${path}`, "aucune réponse");
    else if (r.status === 200) add("ok", `Page ${path}`, `200 (${ms} ms)`);
    else add(critical ? "fail" : "warn", `Page ${path}`, `HTTP ${r.status} (200 attendu)`);
    slow(`Page ${path}`, ms);
  }
  {
    const { r } = await call("GET", "/robots.txt");
    if (r?.status === 200 && /disallow:\s*\/api\//i.test(await r.text())) add("ok", "robots.txt", "présent, /api/ exclu de l'indexation");
    else add("warn", "robots.txt", "absent ou sans exclusion de /api/");
    const s = await call("GET", "/sitemap.xml");
    add(s.r?.status === 200 ? "ok" : "warn", "sitemap.xml", s.r ? `HTTP ${s.r.status}` : "aucune réponse");
  }
  {
    const { r } = await call("GET", "/cette-page-n-existe-pas-smoke");
    add(r?.status === 404 ? "ok" : "fail", "Page inexistante", r ? (r.status === 404 ? "404 propre" : `HTTP ${r.status} (404 attendu)`) : "aucune réponse");
  }

  // 3. Pages privées : jamais accessibles sans session
  for (const path of ["/dashboard", "/billing", "/settings", "/leads"]) {
    const { r } = await call("GET", path);
    if (!r) add("fail", `Page privée ${path}`, "aucune réponse");
    else if (r.status >= 300 && r.status < 400 && /\/login/.test(location(r))) add("ok", `Page privée ${path}`, "redirigée vers la connexion");
    else if (r.status === 401 || r.status === 403) add("ok", `Page privée ${path}`, `refusée (HTTP ${r.status})`);
    else add("fail", `Page privée ${path}`, `HTTP ${r.status} sans redirection vers /login : accessible sans session ?`);
  }

  // 4. API protégées (requêtes NON authentifiées, qui doivent être refusées)
  {
    const { r } = await call("POST", "/api/v1/leads", "{}", { "content-type": "application/json" });
    add(r && (r.status === 401 || r.status === 403) ? "ok" : "fail", "API v1 sans clé", r ? (r.status === 401 || r.status === 403 ? `refusée (HTTP ${r.status})` : `HTTP ${r.status} (401 attendu) : l'API accepte une requête sans clé ?`) : "aucune réponse");
    const e = await call("GET", "/api/export");
    add(e.r && [301, 302, 303, 307, 308, 401, 403].includes(e.r.status) ? "ok" : "fail", "Export sans session", e.r ? `HTTP ${e.r.status}` : "aucune réponse");
  }

  // 5. Webhook Stripe : sans signature, il doit répondre 400 (secret configuré) ; 503 = secret absent
  {
    const { r } = await call("POST", "/api/stripe/webhook", "{}", { "content-type": "application/json" });
    if (!r) add("fail", "Webhook Stripe", "aucune réponse");
    else if (r.status === 400) add("ok", "Webhook Stripe", "configuré : refuse une requête non signée (400)");
    else if (r.status === 503) add("fail", "Webhook Stripe", "STRIPE_WEBHOOK_SECRET non configuré (503) : aucun paiement ne serait confirmé");
    else if (r.status >= 200 && r.status < 300) add("fail", "Webhook Stripe", `ACCEPTE une requête non signée (HTTP ${r.status}) : faille critique`);
    else add("fail", "Webhook Stripe", `HTTP ${r.status} inattendu (400 attendu)`);
  }

  // 6. Tâche planifiée : sans secret, elle doit répondre 401 ; 503 = secret absent
  {
    const { r } = await call("POST", "/api/cron/followups");
    if (!r) add("fail", "Tâche planifiée", "aucune réponse");
    else if (r.status === 401) add("ok", "Tâche planifiée", "protégée : refuse un appel sans secret (401)");
    else if (r.status === 503) add("fail", "Tâche planifiée", "CRON_SECRET non configuré (503) : relances et réconciliation Stripe ne tourneront pas");
    else if (r.status >= 200 && r.status < 300) add("fail", "Tâche planifiée", `S'EXÉCUTE sans secret (HTTP ${r.status}) : faille critique`);
    else add("fail", "Tâche planifiée", `HTTP ${r.status} inattendu (401 attendu)`);
  }

  // 7. Désinscription : un jeton invalide ne doit rien faire et ne pas planter
  {
    const { r } = await call("GET", "/api/unsubscribe/jeton-invalide-smoke");
    add(r && r.status >= 400 && r.status < 500 ? "ok" : "fail", "Désinscription (jeton invalide)", r ? (r.status >= 400 && r.status < 500 ? `refusé (HTTP ${r.status})` : `HTTP ${r.status} (4xx attendu)`) : "aucune réponse");
  }

  // 8. En-têtes de sécurité (https seulement pour HSTS)
  {
    const { r } = await call("GET", "/");
    if (r) {
      add(r.headers.get("x-frame-options") ? "ok" : "warn", "En-tête X-Frame-Options", r.headers.get("x-frame-options") ?? "absent");
      if (base.startsWith("https://")) add(r.headers.get("strict-transport-security") ? "ok" : "warn", "En-tête HSTS", r.headers.get("strict-transport-security") ?? "absent");
    }
  }
  return out;
}

export function summarize(c: Check[]): { text: string; fails: number; warns: number } {
  const icon = { ok: "✅", warn: "⚠️ ", fail: "❌" } as const;
  return { text: c.map((x) => `${icon[x.level]} ${x.name} — ${x.detail}`).join("\n"), fails: c.filter((x) => x.level === "fail").length, warns: c.filter((x) => x.level === "warn").length };
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.includes("--read-only-confirmed")) {
    console.error("Refus : ajoutez --read-only-confirmed pour confirmer l'envoi de requêtes de contrôle (lecture seule ; trois requêtes non authentifiées qui doivent être refusées).");
    process.exitCode = 2; return;
  }
  const raw = argv.find((a) => a.startsWith("--base-url="))?.slice("--base-url=".length) ?? process.env.APP_URL;
  const p = parseBase(raw?.trim());
  if (!p.ok) { console.error(`Refus : ${p.reason}`); process.exitCode = 2; return; }
  console.log(`Cible : ${p.base}`);
  const r = summarize(await runSmoke(p.base, fetch as unknown as FetchLike));
  console.log(r.text);
  console.log(`\n${r.fails} échec(s), ${r.warns} avertissement(s).`);
  process.exitCode = r.fails > 0 ? 1 : 0;
}

if (process.argv[1] && /smoke-production\.[cm]?[tj]s$/.test(process.argv[1])) {
  main().catch(() => { console.error("Échec inattendu du test de fumée."); process.exitCode = 1; });
}
