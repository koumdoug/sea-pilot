// Logs structurés (une ligne JSON). Les champs sensibles sont masqués avant écriture.
const SENSITIVE = /pass|secret|token|key|authorization|cookie|credential|email|phone|ip/i;

// Valeurs : une adresse ou une empreinte de la liste de suppression ne sort jamais d'un texte libre (message d'exception, erreur de base de données…).
const EMAIL_VALUE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const FINGERPRINT_VALUE = /\b(?:h1:[0-9a-f]{12}:[0-9a-f]{64}|erased:[0-9a-f]{64})\b/g;
const redactText = (s: string) => s.replace(EMAIL_VALUE, "[e-mail masqué]").replace(FINGERPRINT_VALUE, "[empreinte masquée]");

function scrub(v: unknown, depth = 0): unknown {
  if (depth > 4 || v == null) return v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => scrub(x, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = SENSITIVE.test(k) ? "[masqué]" : scrub(val, depth + 1);
    return out;
  }
  if (typeof v === "string") { const t = redactText(v); return t.length > 300 ? t.slice(0, 300) + "…" : t; }
  return v;
}

function emit(level: "debug" | "info" | "warn" | "error", event: string, data?: Record<string, unknown>) {
  if (process.env.LOG_LEVEL === "silent" || (process.env.VITEST && process.env.LOG_LEVEL !== "debug")) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...((scrub(data) as object) ?? {}) });
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
}

export const log = {
  debug: (e: string, d?: Record<string, unknown>) => emit("debug", e, d),
  info: (e: string, d?: Record<string, unknown>) => emit("info", e, d),
  warn: (e: string, d?: Record<string, unknown>) => emit("warn", e, d),
  error: (e: string, d?: Record<string, unknown>) => emit("error", e, d),
};

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
