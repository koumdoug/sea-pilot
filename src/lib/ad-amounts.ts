import { db } from "./db";
import { adOfferLink, checkAdAmounts, offerFactsOf, offerIdFromGenerationInput, type AdAmountCheck } from "./price-guard";

type OfferRow = Parameters<typeof offerFactsOf>[0] & { id: string };

export type AdForAmountCheck = {
  id: string;
  source: string;
  generationId: string | null;
  campaignId: string | null;
  hook: string | null;
  headline: string | null;
  primaryText: string | null;
  description: string | null;
  cta: string | null;
  /** offre de la campagne (relation déjà chargée avec l'annonce) */
  campaign?: { offerId: string | null } | null;
};

/**
 * Verdict des montants des annonces IA (lecture seule). Seules les annonces `source = "ai"` sont contrôlées.
 *
 * - `offers` DOIT provenir de l'espace de travail `workspaceId` (liste déjà chargée par l'appelant : aucune requête en plus) ;
 *   un identifiant d'offre absent de cette liste ne peut pas confirmer un montant.
 * - L'offre de la génération (`AIGeneration.input.offerId`) est prioritaire ; l'offre de la campagne sert de repli ;
 *   sans offre valide, le verdict est « unlinked » (jamais « confirmed »).
 * - Une seule requête, bornée à l'espace, pour les générations des annonces affichées.
 */
export async function adAmountChecks(workspaceId: string, ads: AdForAmountCheck[], offers: OfferRow[]): Promise<Map<string, AdAmountCheck>> {
  const out = new Map<string, AdAmountCheck>();
  const ai = ads.filter((a) => a.source === "ai");
  if (ai.length === 0) return out;

  const genIds = [...new Set(ai.map((a) => a.generationId).filter((x): x is string => !!x))];
  const gens = genIds.length ? await db.aIGeneration.findMany({ where: { workspaceId, id: { in: genIds } }, select: { id: true, input: true } }) : [];
  const offerOfGeneration = new Map(gens.map((g) => [g.id, offerIdFromGenerationInput(g.input)] as const));
  const offerOfCampaign = new Map(ai.filter((a) => a.campaignId).map((a) => [a.campaignId as string, a.campaign?.offerId ?? null] as const));
  const validOfferIds = new Set(offers.map((o) => o.id));
  const facts = new Map(offers.map((o) => [o.id, offerFactsOf(o)] as const));

  for (const a of ai) {
    const link = adOfferLink(a, offerOfGeneration, offerOfCampaign, validOfferIds);
    const text = [a.hook, a.headline, a.primaryText, a.description, a.cta].filter(Boolean).join(" ");
    out.set(a.id, checkAdAmounts(text, link.offerId ? facts.get(link.offerId) ?? null : null));
  }
  return out;
}
