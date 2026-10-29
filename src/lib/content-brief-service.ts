import { db } from "./db";
import { env } from "./env";
import { formFieldsSchema, pageUrl, parseSections } from "./landing";
import { auditLandingPage, pageText } from "./seo";
import { aiBriefSchema, buildBrief, contentBriefPrompt, groundingText, unsupportedFigures, type AiBrief, type BriefInput, type ContentBrief } from "./content-brief";
import { generate } from "./ai/service";
import { baseSystem } from "./ai/prompts";
import { briefOf } from "./ai/brief";
import { UserError } from "./action";

/** Charge, dans l'espace de travail, tout ce qu'il faut pour un brief. Lecture seule : aucun appel IA. Renvoie null si la page n'appartient pas à l'espace. */
export async function loadBrief(workspaceId: string, pageId: string) {
  const ws = await db.workspace.findFirst({ where: { id: workspaceId, deletedAt: null } });
  const page = ws ? await db.landingPage.findFirst({ where: { id: pageId, workspaceId }, include: { forms: { where: { active: true }, take: 1, select: { fields: true } } } }) : null;
  if (!ws || !page) return null;
  const [offer, campaign, views, ctaClicks, leads] = await Promise.all([
    page.offerId ? db.offer.findFirst({ where: { id: page.offerId, workspaceId }, include: { audience: true } }) : null,
    page.campaignId ? db.campaign.findFirst({ where: { id: page.campaignId, workspaceId }, select: { name: true, objective: true } }) : null,
    db.analyticsEvent.count({ where: { workspaceId, landingPageId: pageId, type: "page_view" } }),
    db.analyticsEvent.count({ where: { workspaceId, landingPageId: pageId, type: "cta_click" } }),
    db.lead.count({ where: { workspaceId, landingPageId: pageId, deletedAt: null } }),
  ]);
  const sections = parseSections(page.sections);
  const form = page.forms[0] ? formFieldsSchema.safeParse(page.forms[0].fields) : null;
  const hasActiveForm = !!form?.success;
  const audit = auditLandingPage({ name: page.name, status: page.status, seoTitle: page.seoTitle, seoDescription: page.seoDescription, ogImage: page.ogImage, canonicalUrl: page.canonicalUrl, sections, hasActiveForm, views, leads });
  const input: BriefInput = {
    page: { id: page.id, name: page.name, status: page.status, seoTitle: page.seoTitle, seoDescription: page.seoDescription, sections, url: pageUrl(env.appUrl, ws.slug, page.slug) },
    audit, hasActiveForm,
    offer: offer ? { name: offer.name, description: offer.description, problem: offer.problem, price: offer.price, currency: offer.currency } : null,
    audience: offer?.audience ? { name: offer.audience.name, type: offer.audience.type, needs: offer.audience.needs, problems: offer.audience.problems, objections: offer.audience.objections } : null,
    campaign,
    metrics: { views, ctaClicks, leads },
  };
  return { workspace: ws, input, brief: buildBrief(input), pageContent: pageText(sections), audit };
}

export type GeneratedBrief = { generationId: string; ai: AiBrief; figureWarnings: string[]; createdAt: Date; provider: string | null; model: string | null };

/**
 * Génération EXPLICITE d'un brief par l'IA via generate() : configuration, limite de débit, quota quotidien, validation du schéma,
 * journalisation (AIGeneration). Jamais appelée par la consultation d'une page. Les faits envoyés sont recalculés côté serveur.
 */
export async function generateContentBrief(p: { workspaceId: string; userId: string; pageId: string }): Promise<GeneratedBrief> {
  const d = await loadBrief(p.workspaceId, p.pageId);
  if (!d) throw new UserError("Landing page introuvable.");
  if (d.brief.reliability === "insufficient") throw new UserError("Données insuffisantes : ajoutez un titre SEO ou un titre principal à la page avant de générer un brief.");
  const r = await generate({
    workspaceId: p.workspaceId, userId: p.userId, kind: "content_brief", temperature: 0.5,
    system: baseSystem(briefOf(d.workspace), "stratège de contenu SEO et de visibilité dans les moteurs de réponse"),
    prompt: contentBriefPrompt(d.brief), schema: aiBriefSchema,
    input: { landingPageId: p.pageId, topic: d.brief.topic, issueIds: d.audit.issues.map((i) => i.id), reliability: d.brief.reliability },
  });
  return { generationId: r.generationId, ai: r.data, figureWarnings: unsupportedFigures(r.data, groundingText(d.brief, d.pageContent)), createdAt: new Date(), provider: r.provider, model: r.model };
}

/** Briefs IA déjà générés pour une page (journal AIGeneration), du plus récent au plus ancien, relus avec le même schéma. */
export async function listGeneratedBriefs(workspaceId: string, pageId: string | null, take = 5): Promise<(GeneratedBrief & { landingPageId: string; topic: string | null })[]> {
  const rows = await db.aIGeneration.findMany({ where: { workspaceId, kind: "content_brief", status: "ok" }, orderBy: { createdAt: "desc" }, take: 60 });
  const out: (GeneratedBrief & { landingPageId: string; topic: string | null })[] = [];
  for (const g of rows) {
    const inp = (g.input ?? {}) as { landingPageId?: string; topic?: string | null };
    if (!inp.landingPageId || (pageId && inp.landingPageId !== pageId)) continue;
    const ai = aiBriefSchema.safeParse(g.output);
    if (!ai.success) continue;
    out.push({ generationId: g.id, ai: ai.data, figureWarnings: [], createdAt: g.createdAt, provider: g.provider, model: g.model, landingPageId: inp.landingPageId, topic: inp.topic ?? null });
    if (out.length >= take) break;
  }
  return out;
}

export type { ContentBrief };
