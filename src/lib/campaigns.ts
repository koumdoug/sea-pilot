import type { Campaign, Prisma } from "@prisma/client";
import { db } from "./db";
import { audit } from "./audit";
import { CAMPAIGN_TRANSITIONS, type CampaignStatus, CAMPAIGN_STATUSES } from "./constants";
import { entitlement, limitReached } from "./plans";

export class CampaignError extends Error {}

export function canTransition(from: string, to: string): boolean {
  return (CAMPAIGN_TRANSITIONS[from as CampaignStatus] ?? []).includes(to as CampaignStatus);
}

/** Éléments manquants pour qu'une campagne soit « Prête » / « Active ». */
export function launchBlockers(c: Pick<Campaign, "name" | "platform" | "budget" | "objective" | "offerId" | "audienceId" | "landingPageId">, landingPublished: boolean, forStatus: "ready" | "active"): string[] {
  const out: string[] = [];
  if (!c.name.trim()) out.push("nom");
  if (!c.platform) out.push("plateforme");
  if (!c.budget || c.budget <= 0) out.push("budget");
  if (!c.offerId) out.push("offre");
  if (!c.audienceId) out.push("audience");
  if (forStatus === "active" && (c.objective === "leads" || c.objective === "sales") && !c.landingPageId) out.push("landing page");
  if (forStatus === "active" && c.landingPageId && !landingPublished) out.push("landing page publiée");
  return out;
}

export async function transitionCampaign(p: { workspaceId: string; campaignId: string; to: string; actorId?: string | null }): Promise<Campaign> {
  if (!(CAMPAIGN_STATUSES as readonly string[]).includes(p.to)) throw new CampaignError("Statut invalide.");
  const c = await db.campaign.findFirst({ where: { id: p.campaignId, workspaceId: p.workspaceId } });
  if (!c) throw new CampaignError("Campagne introuvable.");
  if (!canTransition(c.status, p.to)) throw new CampaignError(`Transition impossible : ${c.status} → ${p.to}.`);

  if (p.to === "ready" || p.to === "active") {
    const lp = c.landingPageId ? await db.landingPage.findFirst({ where: { id: c.landingPageId, workspaceId: p.workspaceId }, select: { status: true } }) : null;
    const missing = launchBlockers(c, lp?.status === "published", p.to);
    if (missing.length) throw new CampaignError(`Campagne incomplète : ${missing.join(", ")}.`);
  }
  if (p.to === "active") {
    const sub = await db.subscription.findUnique({ where: { workspaceId: p.workspaceId } });
    const used = await db.campaign.count({ where: { workspaceId: p.workspaceId, status: "active", id: { not: c.id } } });
    if (limitReached(entitlement(sub).plan, "activeCampaigns", used)) throw new CampaignError("Limite de campagnes actives atteinte pour votre plan.");
  }
  const u = await db.campaign.update({ where: { id: c.id }, data: { status: p.to } });
  await audit({ workspaceId: p.workspaceId, userId: p.actorId, action: "campaign.status_changed", entity: "Campaign", entityId: c.id, meta: { from: c.status, to: p.to } });
  return u;
}

/** Duplique une campagne (réglages + annonces), en brouillon, sans métriques ni leads. */
export async function duplicateCampaign(workspaceId: string, campaignId: string, actorId?: string | null): Promise<Campaign> {
  const c = await db.campaign.findFirst({ where: { id: campaignId, workspaceId }, include: { ads: true, keywords: true } });
  if (!c) throw new CampaignError("Campagne introuvable.");
  const copy = await db.campaign.create({
    data: {
      workspaceId, name: `${c.name} (copie)`, objective: c.objective, platform: c.platform, budget: c.budget, budgetType: c.budgetType,
      offerId: c.offerId, audienceId: c.audienceId, landingPageId: c.landingPageId, message: (c.message ?? undefined) as Prisma.InputJsonValue | undefined,
      tracking: (c.tracking ?? undefined) as Prisma.InputJsonValue | undefined, status: "draft", builderStep: c.builderStep, duplicatedFromId: c.id,
    },
  });
  if (c.ads.length) await db.ad.createMany({ data: c.ads.map((a) => ({ workspaceId, campaignId: copy.id, platform: a.platform, format: a.format, variantLabel: a.variantLabel, hook: a.hook, headline: a.headline, primaryText: a.primaryText, description: a.description, cta: a.cta, status: "draft", source: a.source })) });
  if (c.keywords.length) await db.keyword.createMany({ data: c.keywords.map((k) => ({ workspaceId, campaignId: copy.id, text: k.text, matchType: k.matchType, intent: k.intent, source: k.source })) });
  await audit({ workspaceId, userId: actorId, action: "campaign.duplicated", entity: "Campaign", entityId: copy.id, meta: { from: c.id } });
  return copy;
}

/** Paramètres UTM par défaut d'une campagne : utilisés pour construire les URL de destination des annonces. */
export function utmDefaults(c: { id: string; name: string; platform: string }) {
  const medium: Record<string, string> = { google_ads: "cpc", meta_ads: "paid_social", tiktok_ads: "paid_social", linkedin_ads: "paid_social", email: "email", seo: "organic" };
  const source: Record<string, string> = { google_ads: "google", meta_ads: "meta", tiktok_ads: "tiktok", linkedin_ads: "linkedin", email: "email", seo: "organic" };
  return { utm_source: source[c.platform] ?? c.platform, utm_medium: medium[c.platform] ?? "other", utm_campaign: c.id };
}
