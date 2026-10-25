import { z } from "zod";
import { db } from "@/lib/db";
import { sha256 } from "@/lib/crypto";
import { rateLimit } from "@/lib/rate-limit";
import { entitlementForWorkspace } from "@/lib/free-access";
import { dedupeKeyOf, EVENT_TYPES, normalizeEmail } from "@/lib/portfolio/rules";
import { PortfolioError, recordProductEvent } from "@/lib/portfolio/service";

export const dynamic = "force-dynamic";

const body = z.object({
  /** identifiant ou « slug » du produit du portefeuille (ex. « driverpilot ») */
  product: z.string().trim().min(1).max(80),
  type: z.enum(EVENT_TYPES),
  occurred_at: z.string().datetime().optional(),
  /** prospect connu : identifiant SEA Pilot, ou courriel (retrouvé par sa clé de déduplication) */
  prospect_id: z.string().max(60).optional(),
  email: z.string().trim().email().max(200).optional(),
  amount: z.number().positive().max(1e9).optional(),
  currency: z.string().trim().length(3).optional(),
  /** référence stable côté produit (identifiant d'utilisateur, de facture, d'événement…) : rend l'appel idempotent */
  external_ref: z.string().trim().min(1).max(120).optional(),
  note: z.string().trim().max(500).optional(),
});

const json = (data: unknown, status = 200) => Response.json(data, { status });

/**
 * Conversions envoyées par un des SaaS du portefeuille (inscription, essai, démonstration, paiement confirmé, résiliation).
 * `Authorization: Bearer sp_…` — clé créée dans Paramètres → Clés API. Idempotent : un même événement n'est jamais compté deux fois.
 * Aucun des trois SaaS n'appelle cette route aujourd'hui : elle est prête, non connectée.
 */
export async function POST(req: Request) {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token.startsWith("sp_")) return json({ error: "Clé API manquante ou invalide." }, 401);
  const key = await db.apiKey.findUnique({ where: { keyHash: sha256(token) }, include: { workspace: { include: { subscription: true } } } });
  if (!key || key.revokedAt || key.workspace.deletedAt) return json({ error: "Clé API manquante ou invalide." }, 401);
  if (!rateLimit(`apikey:${key.id}`, 60, 60_000).ok) return json({ error: "Limite de débit atteinte (60 requêtes/minute)." }, 429);
  if (!(await entitlementForWorkspace(key.workspaceId, key.workspace.subscription)).active) return json({ error: "Abonnement inactif." }, 402);

  let b: z.infer<typeof body>;
  try { b = body.parse(JSON.parse((await req.text()).slice(0, 20_000))); } catch (e) { return json({ error: "Corps invalide.", details: e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")} : ${i.message}`) : undefined }, 400); }

  const workspaceId = key.workspaceId;
  const product = await db.product.findFirst({ where: { workspaceId, deletedAt: null, OR: [{ id: b.product }, { slug: b.product }] }, select: { id: true } });
  if (!product) return json({ error: "Produit introuvable dans cet espace." }, 404);

  let prospectId: string | null = null;
  if (b.prospect_id) {
    prospectId = (await db.prospect.findFirst({ where: { id: b.prospect_id, workspaceId, deletedAt: null }, select: { id: true } }))?.id ?? null;
    if (!prospectId) return json({ error: "Prospect introuvable dans cet espace." }, 404);
  } else if (b.email && normalizeEmail(b.email)) {
    prospectId = (await db.prospect.findUnique({ where: { workspaceId_dedupeKey: { workspaceId, dedupeKey: dedupeKeyOf({ email: b.email, name: "" }) } }, select: { id: true, deletedAt: true } }))?.id ?? null;
  }

  try {
    const r = await recordProductEvent({
      workspaceId, productId: product.id, prospectId, type: b.type, occurredAt: b.occurred_at ? new Date(b.occurred_at) : new Date(),
      amount: b.amount ?? null, currency: b.currency ?? null, externalRef: b.external_ref ?? null, note: b.note ?? null, source: "webhook",
    });
    await db.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
    return json({ id: r.id, created: r.created, matchedProspect: !!prospectId }, r.created ? 201 : 200);
  } catch (e) {
    if (e instanceof PortfolioError) return json({ error: e.message }, 422);
    throw e;
  }
}
