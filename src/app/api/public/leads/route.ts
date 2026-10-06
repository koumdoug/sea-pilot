import { z } from "zod";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { hashIp } from "@/lib/crypto";
import { SubmitError, submitToForm } from "@/lib/public-leads";
import { log, errMsg } from "@/lib/logger";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const body = z.object({
  formId: z.string().min(1).max(60),
  values: z.record(z.string().max(60), z.unknown()),
  consent: z.boolean().optional(),
  hp: z.string().optional(), // piège à robots : doit rester vide
  utm: z.object({ source: z.string().max(200).optional(), medium: z.string().max(200).optional(), campaign: z.string().max(200).optional(), term: z.string().max(200).optional(), content: z.string().max(200).optional() }).optional(),
  referrer: z.string().max(500).optional(),
  landingUrl: z.string().max(500).optional(),
});

const json = (data: unknown, status = 200, headers?: Record<string, string>) => Response.json(data, { status, headers });

/** Capture d'un lead depuis une landing page publique (aucune authentification : protégée par validation, honeypot et limitation de débit). */
export async function POST(req: Request) {
  const ip = clientIp(req.headers);
  const raw = await req.text();
  if (raw.length > 30_000) return json({ ok: false, error: "Requête trop volumineuse." }, 413);
  let parsed: z.infer<typeof body>;
  try { parsed = body.parse(JSON.parse(raw)); } catch { return json({ ok: false, error: "Requête invalide." }, 400); }

  const rl = rateLimit(`lead:${ip}:${parsed.formId}`, 8, 10 * 60_000);
  if (!rl.ok) return json({ ok: false, error: "Trop de soumissions. Réessayez plus tard." }, 429, { "Retry-After": String(rl.retryAfterSec) });
  if (parsed.hp && parsed.hp.trim()) return json({ ok: true }); // robot : réponse neutre, rien n'est enregistré

  try {
    const r = await submitToForm(parsed.formId, { values: parsed.values, consent: parsed.consent, utm: parsed.utm, referrer: parsed.referrer, landingUrl: parsed.landingUrl, ipHash: hashIp(ip) });
    return json({ ok: true, message: r.form.successMessage, redirectUrl: r.form.redirectUrl ?? undefined });
  } catch (e) {
    if (e instanceof SubmitError) return json({ ok: false, error: e.message, fieldErrors: e.fieldErrors }, e.status);
    log.error("public_lead.failed", { error: errMsg(e) });
    return json({ ok: false, error: "Une erreur est survenue. Réessayez." }, 500);
  }
}

export async function GET() {
  void db;
  return json({ error: "Méthode non autorisée" }, 405, { Allow: "POST" });
}
