// Logs structurés (une ligne JSON). Les champs sensibles sont masqués avant écriture.
const SENSITIVE = /pass|secret|token|key|authorization|cookie|credential|email|phone|ip/i;

function scrub(v: unknown, depth = 0): unknown {
  if (depth > 4 || v == null) return v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => scrub(x, depth + 1));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = SENSITIVE.test(k) ? "[masqué]" : scrub(val, depth + 1);
    return out;
  }
  if (typeof v === "string" && v.length > 300) return v.slice(0, 300) + "…";
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
