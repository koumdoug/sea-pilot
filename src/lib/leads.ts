import type { Lead, Prisma } from "@prisma/client";
import { db } from "./db";
import { audit } from "./audit";
import { TERMINAL_STATUSES, LEAD_STATUSES, type LeadStatus } from "./constants";
import { qualifyLead, normalizeCriteria, DEFAULT_THRESHOLDS, type Qualification, type LeadInput, type OfferContext, type CriterionResult } from "./scoring";
import { generate } from "./ai/service";
import { getProvider } from "./ai/providers";
import { baseSystem, qualificationAiSchema, qualificationPrompt } from "./ai/prompts";
import { slugify } from "./workspaces";
import { cancelPendingFollowUps, enrollLead } from "./followups";
import { log, errMsg } from "./logger";

export type NewLeadInput = {
  workspaceId: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  message?: string | null;
  customFields?: Record<string, unknown> | null;
  source?: string | null;
  medium?: string | null;
  utm?: { source?: string | null; medium?: string | null; campaign?: string | null; term?: string | null; content?: string | null };
  campaignId?: string | null;
  landingPageId?: string | null;
  formId?: string | null;
  referrer?: string | null;
  landingUrl?: string | null;
  consentMarketing?: boolean;
  consentText?: string | null;
  ipHash?: string | null;
  actorId?: string | null;
  value?: number | null;
};

const clean = (s?: string | null, max = 500) => (s && s.trim() ? s.trim().slice(0, max) : null);

/** Rattachement à une campagne : explicite → campagne de la landing page → utm_campaign (id ou nom). Toujours dans l'espace de travail. */
export async function resolveCampaignId(workspaceId: string, p: { campaignId?: string | null; landingPageId?: string | null; utmCampaign?: string | null }): Promise<string | null> {
  if (p.campaignId) {
    const c = await db.campaign.findFirst({ where: { id: p.campaignId, workspaceId }, select: { id: true } });
    if (c) return c.id;
  }
  if (p.landingPageId) {
    const lp = await db.landingPage.findFirst({ where: { id: p.landingPageId, workspaceId }, select: { campaignId: true } });
    if (lp?.campaignId) return lp.campaignId;
  }
  if (p.utmCampaign) {
    const byId = await db.campaign.findFirst({ where: { id: p.utmCampaign, workspaceId }, select: { id: true } });
    if (byId) return byId.id;
    const slug = slugify(p.utmCampaign);
    const all = await db.campaign.findMany({ where: { workspaceId, status: { not: "archived" } }, select: { id: true, name: true } });
    const hit = all.find((c) => slugify(c.name) === slug);
    if (hit) return hit.id;
  }
  return null;
}

export async function createLead(i: NewLeadInput): Promise<{ lead: Lead; duplicate: boolean }> {
  const email = i.email ? i.email.trim().toLowerCase() : null;

  // Anti double-soumission : même e-mail, même espace, même page, moins de 10 minutes.
  if (email) {
    const dup = await db.lead.findFirst({
      where: { workspaceId: i.workspaceId, email, landingPageId: i.landingPageId ?? null, deletedAt: null, createdAt: { gte: new Date(Date.now() - 10 * 60_000) } },
    });
    if (dup) return { lead: dup, duplicate: true };
  }

  const campaignId = await resolveCampaignId(i.workspaceId, { campaignId: i.campaignId, landingPageId: i.landingPageId, utmCampaign: i.utm?.campaign });
  const consent = !!i.consentMarketing && !!email;
  const lead = await db.lead.create({
    data: {
      workspaceId: i.workspaceId,
      name: clean(i.name, 120) ?? "Sans nom",
      email, phone: clean(i.phone, 40), company: clean(i.company, 160), message: clean(i.message, 4000),
      customFields: (i.customFields ?? undefined) as Prisma.InputJsonValue | undefined,
      source: clean(i.source ?? i.utm?.source, 120), medium: clean(i.medium ?? i.utm?.medium, 120),
      utmSource: clean(i.utm?.source, 120), utmMedium: clean(i.utm?.medium, 120), utmCampaign: clean(i.utm?.campaign, 200), utmTerm: clean(i.utm?.term, 200), utmContent: clean(i.utm?.content, 200),
      campaignId, landingPageId: i.landingPageId ?? null, formId: i.formId ?? null,
      referrer: clean(i.referrer, 500), landingUrl: clean(i.landingUrl, 500),
      consentMarketing: consent, consentAt: consent ? new Date() : null, consentText: consent ? clean(i.consentText, 1000) : null,
      ipHash: i.ipHash ?? null, value: i.value ?? null,
    },
  });

  await db.leadActivity.create({ data: { workspaceId: i.workspaceId, leadId: lead.id, type: "created", actorId: i.actorId ?? null, data: { source: lead.source, campaignId } } });
  await db.analyticsEvent.create({
    data: { workspaceId: i.workspaceId, type: "lead_created", leadId: lead.id, campaignId, landingPageId: i.landingPageId ?? null, utmSource: lead.utmSource, utmMedium: lead.utmMedium, utmCampaign: lead.utmCampaign, utmTerm: lead.utmTerm, utmContent: lead.utmContent },
  });
  if (email) await db.consent.create({ data: { workspaceId: i.workspaceId, leadId: lead.id, email, type: "marketing", granted: consent, source: i.formId ? "form" : "manual", text: consent ? clean(i.consentText, 1000) : null, ipHash: i.ipHash ?? null } });
  await db.notification.create({ data: { workspaceId: i.workspaceId, type: "lead", title: `Nouveau lead : ${lead.name}`, body: lead.company ?? lead.email ?? undefined, href: `/leads/${lead.id}` } });

  // Qualification automatique et séquences à inscription automatique : ne doivent jamais faire échouer la capture.
  try {
    const cfg = await db.qualificationConfig.findUnique({ where: { workspaceId: i.workspaceId } });
    if (!cfg || cfg.autoQualify) await qualifyLeadService({ workspaceId: i.workspaceId, leadId: lead.id, userId: null, allowAi: false });
    const seqs = await db.followUpSequence.findMany({ where: { workspaceId: i.workspaceId, active: true, autoEnroll: true } });
    for (const s of seqs) await enrollLead({ workspaceId: i.workspaceId, leadId: lead.id, sequenceId: s.id });
  } catch (e) {
    log.error("lead.post_create_failed", { leadId: lead.id, error: errMsg(e) });
  }
  return { lead: (await db.lead.findUnique({ where: { id: lead.id } })) ?? lead, duplicate: false };
}

export class LeadError extends Error {}

export async function changeLeadStatus(p: { workspaceId: string; leadId: string; status: string; actorId?: string | null; value?: number | null; lostReason?: string | null }): Promise<Lead> {
  if (!(LEAD_STATUSES as readonly string[]).includes(p.status)) throw new LeadError("Statut invalide.");
  const status = p.status as LeadStatus;
  const lead = await db.lead.findFirst({ where: { id: p.leadId, workspaceId: p.workspaceId, deletedAt: null } });
  if (!lead) throw new LeadError("Prospect introuvable.");
  if (lead.status === status && p.value === undefined) return lead;

  const now = new Date();
  const data: Prisma.LeadUpdateInput = { status };
  if (status === "qualified" && !lead.qualifiedAt) data.qualifiedAt = now;
  if (status === "won") { data.wonAt = now; if (p.value !== undefined && p.value !== null) data.value = p.value; data.lostAt = null; data.lostReason = null; }
  if (status === "lost") { data.lostAt = now; data.lostReason = clean(p.lostReason, 300); }
  if (status !== "won" && lead.status === "won") data.wonAt = null;

  const updated = await db.lead.update({ where: { id: lead.id }, data });
  await db.leadActivity.create({ data: { workspaceId: p.workspaceId, leadId: lead.id, type: "status_changed", actorId: p.actorId ?? null, data: { from: lead.status, to: status } } });

  if (status === "won") {
    // Client créé à partir du lead (une seule fois) ; le revenu est le montant de l'affaire.
    let customerId = updated.customerId;
    if (!customerId) {
      const c = await db.customer.create({ data: { workspaceId: p.workspaceId, campaignId: updated.campaignId, name: updated.name, email: updated.email, phone: updated.phone, company: updated.company, revenue: updated.value ?? 0 } });
      customerId = c.id;
      await db.lead.update({ where: { id: lead.id }, data: { customerId } });
    } else {
      await db.customer.updateMany({ where: { id: customerId, workspaceId: p.workspaceId }, data: { revenue: updated.value ?? 0 } });
    }
    await db.analyticsEvent.create({ data: { workspaceId: p.workspaceId, type: "customer_won", leadId: lead.id, campaignId: updated.campaignId, meta: { value: updated.value } } });
  }
  if ((TERMINAL_STATUSES as string[]).includes(status)) await cancelPendingFollowUps(p.workspaceId, lead.id, `Statut « ${status} » : relances arrêtées.`);
  await audit({ workspaceId: p.workspaceId, userId: p.actorId, action: "lead.status_changed", entity: "Lead", entityId: lead.id, meta: { from: lead.status, to: status } });
  return (await db.lead.findUnique({ where: { id: lead.id } })) ?? updated;
}

// ───────────────────────── Qualification ─────────────────────────

type AdjustmentResult = { criteria: CriterionResult[]; applied: string[]; quotes: string[]; nextAction?: string };

/** Fusionne les ajustements de l'IA : ils restent des INFÉRENCES ; seules les citations retrouvées mot pour mot dans le lead deviennent des faits cités. */
export function applyAiAdjustments(base: Qualification, adjustments: { key: string; value: number; evidence: string; quote?: string }[], leadText: string, nextAction?: string): AdjustmentResult {
  const text = leadText.toLowerCase();
  const applied: string[] = [];
  const quotes: string[] = [];
  const criteria = base.criteria.map((c) => {
    const a = adjustments.find((x) => x.key === c.key);
    if (!a) return c;
    const value = Math.max(0, Math.min(1, a.value));
    const verbatim = a.quote && text.includes(a.quote.trim().toLowerCase()) ? a.quote.trim() : null;
    if (verbatim) quotes.push(verbatim);
    applied.push(c.key);
    return { ...c, value, basis: "inference" as const, evidence: `${a.evidence} (analyse IA${verbatim ? `, d'après « ${verbatim.slice(0, 120)} »` : ""})` };
  });
  return { criteria, applied, quotes, nextAction: nextAction || undefined };
}

export function levelFor(score: number, hot: number, warm: number, noContact: boolean): Qualification["level"] {
  if (noContact) return "unqualified";
  return score >= hot ? "hot" : score >= warm ? "warm" : "cold";
}

export async function qualifyLeadService(p: { workspaceId: string; leadId: string; userId: string | null; allowAi?: boolean }) {
  const lead = await db.lead.findFirst({ where: { id: p.leadId, workspaceId: p.workspaceId, deletedAt: null } });
  if (!lead) throw new LeadError("Prospect introuvable.");
  const [cfg, ws, offer] = await Promise.all([
    db.qualificationConfig.findUnique({ where: { workspaceId: p.workspaceId } }),
    db.workspace.findUnique({ where: { id: p.workspaceId } }),
    db.offer.findFirst({ where: { workspaceId: p.workspaceId, status: { not: "archived" } }, orderBy: { createdAt: "asc" }, include: { audience: true } }),
  ]);
  const criteria = normalizeCriteria(cfg?.criteria);
  const th = cfg ? { hot: cfg.hotThreshold, warm: cfg.warmThreshold } : DEFAULT_THRESHOLDS;
  const ctx: OfferContext = {
    name: offer?.name, price: offer?.price, geoZone: offer?.geoZone, country: ws?.country, audienceType: offer?.audience?.type ?? null,
    advantages: Array.isArray(offer?.advantages) ? (offer!.advantages as string[]) : [],
    keywords: [offer?.description ?? "", offer?.problem ?? "", offer?.audience?.needs ?? ""].join(" ").split(/\W+/).filter((w) => w.length > 3),
  };
  const input: LeadInput = { name: lead.name, email: lead.email, phone: lead.phone, company: lead.company, message: lead.message, customFields: (lead.customFields as Record<string, unknown> | null) ?? null, source: lead.source, medium: lead.medium };
  let q = qualifyLead(input, ctx, criteria, th);
  let method: "rules" | "rules+ai" = "rules";
  let provider: string | null = null, model: string | null = null;

  const wantAi = (p.allowAi ?? cfg?.useAi ?? false) && !!getProvider();
  if (wantAi && ws) {
    try {
      const r = await generate({
        workspaceId: p.workspaceId, userId: p.userId, kind: "qualification", temperature: 0.2,
        system: baseSystem({ name: ws.name, industry: ws.industry, country: ws.country, language: ws.language, description: ws.description, website: ws.website, currency: ws.currency }, "analyste commercial chargé de qualifier des leads"),
        prompt: qualificationPrompt({ lead: { ...input, customFields: input.customFields }, offer: ctx, baseline: { score: q.score, criteria: q.criteria.map((c) => ({ key: c.key, value: c.value, basis: c.basis })) } }),
        schema: qualificationAiSchema, input: { leadId: lead.id },
      });
      const text = [lead.message ?? "", lead.company ?? "", JSON.stringify(lead.customFields ?? {})].join(" ");
      const adj = applyAiAdjustments(q, r.data.adjustments, text, r.data.nextAction);
      const total = adj.criteria.reduce((s, c) => s + c.weight, 0) || 1;
      const score = Math.round((adj.criteria.reduce((s, c) => s + c.weight * (c.value ?? 0), 0) / total) * 100);
      const noContact = !lead.email && !lead.phone;
      const missingInfo = adj.criteria.filter((c) => c.basis === "missing").length ? q.missingInfo : q.missingInfo.filter((m) => !adj.applied.some((k) => m.toLowerCase().includes(k)));
      q = {
        ...q, criteria: adj.criteria, score: noContact ? Math.min(score, th.warm - 1) : score, level: levelFor(score, th.hot, th.warm, noContact),
        inferences: adj.criteria.filter((c) => c.basis === "inference").map((c) => `${c.label} — ${c.evidence} (inférence)`),
        facts: [...q.facts, ...adj.quotes.map((x) => `Citation relevée : « ${x} »`)],
        reasons: adj.criteria.filter((c) => c.value !== null).sort((a, b) => b.weight * (b.value ?? 0) - a.weight * (a.value ?? 0)).slice(0, 4).map((c) => `${c.label} : ${c.evidence}`),
        missingInfo, nextAction: adj.nextAction ?? q.nextAction,
      };
      method = "rules+ai"; provider = r.provider; model = r.model;
    } catch (e) {
      log.warn("qualification.ai_skipped", { leadId: lead.id, error: errMsg(e) });
    }
  }

  const rec = await db.aIQualification.create({
    data: {
      workspaceId: p.workspaceId, leadId: lead.id, score: q.score, level: q.level, criteria: q.criteria as unknown as Prisma.InputJsonValue,
      facts: q.facts, inferences: q.inferences, reasons: q.reasons, missingInfo: q.missingInfo, nextAction: q.nextAction, method, provider, model,
    },
  });
  await db.lead.update({ where: { id: lead.id }, data: { score: q.score, qualificationLevel: q.level } });
  await db.leadActivity.create({ data: { workspaceId: p.workspaceId, leadId: lead.id, type: "qualified", actorId: p.userId, data: { score: q.score, level: q.level, method } } });
  await db.analyticsEvent.create({ data: { workspaceId: p.workspaceId, type: "lead_qualified", leadId: lead.id, campaignId: lead.campaignId, meta: { score: q.score, level: q.level } } });

  if ((cfg?.autoQualify ?? true) && q.level === "hot" && lead.status === "new") {
    await changeLeadStatus({ workspaceId: p.workspaceId, leadId: lead.id, status: "qualified", actorId: p.userId });
  }
  return { qualification: q, record: rec, method };
}

// ───────────────────────── RGPD ─────────────────────────

/** Désinscription : arrête les relances, enregistre la suppression et le retrait de consentement. */
export async function unsubscribeLead(workspaceId: string, leadId: string, source = "link") {
  const lead = await db.lead.findFirst({ where: { id: leadId, workspaceId } });
  if (!lead) return false;
  const now = new Date();
  await db.lead.update({ where: { id: lead.id }, data: { unsubscribedAt: now, consentMarketing: false } });
  if (lead.email) {
    await db.emailSuppression.upsert({ where: { workspaceId_email: { workspaceId, email: lead.email.toLowerCase() } }, create: { workspaceId, email: lead.email.toLowerCase(), reason: "unsubscribe" }, update: {} });
    await db.consent.create({ data: { workspaceId, leadId: lead.id, email: lead.email.toLowerCase(), type: "marketing", granted: false, source } });
  }
  await db.leadActivity.create({ data: { workspaceId, leadId: lead.id, type: "unsubscribed", data: { source } } });
  await cancelPendingFollowUps(workspaceId, lead.id, "Le prospect s'est désinscrit.");
  return true;
}

/** Effacement RGPD d'un prospect : données personnelles supprimées, relances annulées, comptabilité agrégée conservée. */
export async function eraseLead(workspaceId: string, leadId: string, actorId?: string | null) {
  const lead = await db.lead.findFirst({ where: { id: leadId, workspaceId } });
  if (!lead) return false;
  await cancelPendingFollowUps(workspaceId, leadId, "Prospect effacé.");
  if (lead.email) await db.emailSuppression.upsert({ where: { workspaceId_email: { workspaceId, email: lead.email.toLowerCase() } }, create: { workspaceId, email: lead.email.toLowerCase(), reason: "erasure" }, update: {} });
  await db.$transaction([
    db.conversation.deleteMany({ where: { workspaceId, leadId } }),
    db.contact.deleteMany({ where: { workspaceId, leadId } }),
    db.aIQualification.deleteMany({ where: { workspaceId, leadId } }),
    db.leadActivity.deleteMany({ where: { workspaceId, leadId } }),
    db.emailLog.deleteMany({ where: { workspaceId, leadId } }),
    db.consent.deleteMany({ where: { workspaceId, leadId } }),
    db.task.deleteMany({ where: { workspaceId, leadId } }),
    db.lead.update({
      where: { id: leadId },
      data: { name: "Prospect effacé", email: null, phone: null, company: null, message: null, customFields: undefined, ipHash: null, referrer: null, landingUrl: null, consentText: null, consentMarketing: false, deletedAt: new Date() },
    }),
  ]);
  await audit({ workspaceId, userId: actorId, action: "lead.erased", entity: "Lead", entityId: leadId });
  return true;
}

export async function exportLeadData(workspaceId: string, leadId: string) {
  const lead = await db.lead.findFirst({ where: { id: leadId, workspaceId, deletedAt: null }, include: { conversations: true, activities: true, qualifications: true, tasks: true, followUps: true, contacts: true } });
  return lead;
}
