import { z } from "zod";
import { db } from "@/lib/db";
import { sha256 } from "@/lib/crypto";
import { createLead } from "@/lib/leads";
import { rateLimit } from "@/lib/rate-limit";
import { entitlementForWorkspace } from "@/lib/free-access";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const body = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200).optional(),
  phone: z.string().trim().max(40).optional(),
  company: z.string().trim().max(160).optional(),
  message: z.string().trim().max(4000).optional(),
  source: z.string().trim().max(120).optional(),
  campaign_id: z.string().max(60).optional(),
  utm_source: z.string().max(200).optional(), utm_medium: z.string().max(200).optional(), utm_campaign: z.string().max(200).optional(), utm_term: z.string().max(200).optional(), utm_content: z.string().max(200).optional(),
  custom: z.record(z.string().max(60), z.union([z.string().max(300), z.number(), z.boolean()])).optional(),
  value: z.number().min(0).max(1e9).optional(),
  // l'appelant atteste avoir recueilli le consentement marketing du prospect
  consent_marketing: z.boolean().optional(),
}).refine((b) => b.email || b.phone, { message: "email ou phone requis" });

const json = (data: unknown, status = 200) => Response.json(data, { status });

/** API d'ingestion de leads (serveur à serveur) : `Authorization: Bearer sp_…` — clé créée dans Paramètres → Clés API. */
export async function POST(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token.startsWith("sp_")) return json({ error: "Clé API manquante ou invalide." }, 401);
  const key = await db.apiKey.findUnique({ where: { keyHash: sha256(token) }, include: { workspace: { include: { subscription: true } } } });
  if (!key || key.revokedAt || key.workspace.deletedAt) return json({ error: "Clé API manquante ou invalide." }, 401);
  if (!rateLimit(`apikey:${key.id}`, 60, 60_000).ok) return json({ error: "Limite de débit atteinte (60 requêtes/minute)." }, 429);
  if (!(await entitlementForWorkspace(key.workspaceId, key.workspace.subscription)).active) return json({ error: "Abonnement inactif." }, 402);

  let b: z.infer<typeof body>;
  try { b = body.parse(JSON.parse((await req.text()).slice(0, 40_000))); } catch (e) { return json({ error: "Corps invalide.", details: e instanceof z.ZodError ? e.issues.map((i) => i.message) : undefined }, 400); }

  const { lead, duplicate } = await createLead({
    workspaceId: key.workspaceId, name: b.name, email: b.email, phone: b.phone, company: b.company, message: b.message, source: b.source ?? "api",
    campaignId: b.campaign_id, utm: { source: b.utm_source, medium: b.utm_medium, campaign: b.utm_campaign, term: b.utm_term, content: b.utm_content },
    customFields: b.custom ?? null, consentMarketing: b.consent_marketing, consentText: b.consent_marketing ? "Consentement attesté par l'appelant de l'API" : null, value: b.value,
  });
  await db.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
  if (!duplicate) await audit({ workspaceId: key.workspaceId, action: "lead.created_api", entity: "Lead", entityId: lead.id, meta: { apiKey: key.prefix } });
  return json({ id: lead.id, status: lead.status, score: lead.score, duplicate }, duplicate ? 200 : 201);
}
