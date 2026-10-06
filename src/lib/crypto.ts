import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "./env";

const key = () => createHash("sha256").update(env.encryptionKey).digest();

/** AES-256-GCM. Format : v1.<iv>.<tag>.<données> (base64url). */
export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), enc.toString("base64url")].join(".");
}

export function decryptJson<T = unknown>(payload: string): T {
  const [v, iv, tag, data] = payload.split(".");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("Format de secret invalide");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8")) as T;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Pseudonymise une adresse IP (RGPD) : empreinte salée, non réversible. */
export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return createHash("sha256").update(`${env.sessionSecret}|${ip}`).digest("hex").slice(0, 32);
}


/** Jeton signé sans état (HMAC-SHA256) : `<payload>.<signature>`. Utilisé pour les liens de désinscription. */
export function signToken(payload: string): string {
  const p = Buffer.from(payload).toString("base64url");
  const sig = createHmac("sha256", env.sessionSecret).update(p).digest("base64url");
  return `${p}.${sig}`;
}

export function verifyToken(token: string): string | null {
  const [p, sig] = token.split(".");
  if (!p || !sig) return null;
  const expected = createHmac("sha256", env.sessionSecret).update(p).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  try { return Buffer.from(p, "base64url").toString("utf8"); } catch { return null; }
}
