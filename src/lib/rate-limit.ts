// Limiteur de débit en mémoire (fenêtre glissante). Suffisant pour une instance unique ;
// pour plusieurs instances, remplacer le store par Redis (même interface).
type Bucket = number[];
const store = new Map<string, Bucket>();

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): { ok: boolean; remaining: number; retryAfterSec: number } {
  const b = (store.get(key) ?? []).filter((t) => now - t < windowMs);
  if (b.length >= limit) {
    store.set(key, b);
    return { ok: false, remaining: 0, retryAfterSec: Math.max(1, Math.ceil((windowMs - (now - b[0])) / 1000)) };
  }
  b.push(now);
  store.set(key, b);
  if (store.size > 5000) for (const [k, v] of store) if (!v.length || now - v[v.length - 1] > 3_600_000) store.delete(k);
  return { ok: true, remaining: limit - b.length, retryAfterSec: 0 };
}

export function resetRateLimits() { store.clear(); }

export function clientIp(h: Headers): string {
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}
