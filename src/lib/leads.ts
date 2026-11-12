import { Prisma, type Lead } from "@prisma/client";
import { db } from "./db";
import { audit } from "./audit";
import { TERMINAL_STATUSES, LEAD_STATUSES, type LeadStatus } from "./constants";
import { qualifyLead, normalizeCriteria, DEFAULT_THRESHOLDS, type Qualification, type LeadInput, type OfferContext, type CriterionResult } from "./scoring";
import { generate } from "./ai/service";
import { getProvider } from "./ai/providers";
import { baseSystem, qualificationAiSchema, qualificationPrompt } from "./ai/prompts";
import { slugify } from "./workspaces";
import { cancelPendingFollowUps, enrollLead, revokeLeadFollowUps } from "./followups";
import { TX_RETRY_CODES, TxAbort, runTx } from "./followup-runtime";
import { suppressionWriteKey } from "./suppression";
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
  productId?: string | null; // SaaS du portefeuille ; à défaut, déduit de la campagne puis de la landing page
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

/** Produit d'un lead entrant : explicite (vérifié dans l'espace) → campagne → landing page → offre de la landing page. Null si rien n'est attribué. */
export async function resolveProductId(workspaceId: string, p: { productId?: string | null; campaignId?: string | null; landingPageId?: string | null }): Promise<string | null> {
  if (p.productId) {
    const x = await db.product.findFirst({ where: { id: p.productId, workspaceId, deletedAt: null }, select: { id: true } });
    if (x) return x.id;
  }
  if (p.campaignId) {
    const c = await db.campaign.findFirst({ where: { id: p.campaignId, workspaceId }, select: { productId: true } });
    if (c?.productId) return c.productId;
  }
  if (p.landingPageId) {
    const lp = await db.landingPage.findFirst({ where: { id: p.landingPageId, workspaceId }, select: { productId: true, offerId: true } });
    if (lp?.productId) return lp.productId;
    // Une page rattachée seulement à une offre hérite du produit de cette offre (sinon ses leads resteraient « non attribués »).
    if (lp?.offerId) {
      const o = await db.offer.findFirst({ where: { id: lp.offerId, workspaceId }, select: { productId: true } });
      if (o?.productId) return o.productId;
    }
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
  const productId = await resolveProductId(i.workspaceId, { productId: i.productId, campaignId, landingPageId: i.landingPageId });
  const consent = !!i.consentMarketing && !!email;
  const lead = await db.lead.create({
    data: {
      workspaceId: i.workspaceId,
      name: clean(i.name, 120) ?? "Sans nom",
      email, phone: clean(i.phone, 40), company: clean(i.company, 160), message: clean(i.message, 4000),
      customFields: (i.customFields ?? undefined) as Prisma.InputJsonValue | undefined,
      source: clean(i.source ?? i.utm?.source, 120), medium: clean(i.medium ?? i.utm?.medium, 120),
      utmSource: clean(i.utm?.source, 120), utmMedium: clean(i.utm?.medium, 120), utmCampaign: clean(i.utm?.campaign, 200), utmTerm: clean(i.utm?.term, 200), utmContent: clean(i.utm?.content, 200),
      campaignId, productId, landingPageId: i.landingPageId ?? null, formId: i.formId ?? null,
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
  // La qualification automatique est déterministe (règles) : jamais d'appel IA à la création d'un lead.
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
/** Le statut a changé entre sa lecture et son écriture (modification concurrente) : jamais d'écrasement. */
export class LeadStatusConflict extends LeadError {}

type LeadClient = Prisma.TransactionClient | typeof db;
export type StatusChangeResult = { lead: Lead; from: string; changed: boolean; valueCorrected: boolean; terminal: boolean; skipped?: boolean };
type StatusChangeInput = {
  workspaceId: string; leadId: string; status: string; actorId?: string | null; value?: number | null; lostReason?: string | null;
  /**
   * Transition AUTOMATIQUE : n'est appliquée que si le statut courant est exactement celui-ci. Sinon (progression commerciale déjà enregistrée),
   * rien n'est écrit (ni statut, ni historique) et le résultat est `skipped`. Un conflit à l'écriture n'est jamais réessayé (voir `changeLeadStatus`).
   */
  expectedFrom?: string;
};

/**
 * Écritures d'un changement de statut sur le client fourni (la base ou une TRANSACTION) : prospect, historique, client gagné, événement.
 * N'utilise que `c` (jamais la connexion globale : SQLite n'a qu'une connexion) ; les effets hors transaction (annulation des étapes restantes, audit)
 * sont faits par l'appelant à partir du résultat. Rejouer le même statut ne produit aucun nouvel effet.
 */
export async function applyLeadStatusChange(c: LeadClient, p: StatusChangeInput): Promise<StatusChangeResult> {
  if (!(LEAD_STATUSES as readonly string[]).includes(p.status)) throw new LeadError("Statut invalide.");
  const status = p.status as LeadStatus;
  const lead = await c.lead.findFirst({ where: { id: p.leadId, workspaceId: p.workspaceId, deletedAt: null } });
  if (!lead) throw new LeadError("Prospect introuvable.");
  if (p.expectedFrom !== undefined && lead.status !== p.expectedFrom) {
    // Transition automatique devenue sans objet : le prospect a progressé (ou déjà changé) depuis la décision. Aucune écriture.
    return { lead, from: lead.status, changed: false, valueCorrected: false, terminal: false, skipped: true };
  }
  if (lead.status === status) {
    // Rejeu (retry, double clic) : aucun nouvel événement ni historique. Seule une correction de montant d'un lead gagné est appliquée.
    if (status === "won" && p.value !== undefined && p.value !== null && p.value !== lead.value) {
      const u = await c.lead.update({ where: { id: lead.id }, data: { value: p.value } });
      if (u.customerId) await c.customer.updateMany({ where: { id: u.customerId, workspaceId: p.workspaceId }, data: { revenue: p.value } });
      return { lead: u, from: lead.status, changed: false, valueCorrected: true, terminal: false };
    }
    return { lead, from: lead.status, changed: false, valueCorrected: false, terminal: false };
  }

  const now = new Date();
  const data: Prisma.LeadUpdateManyMutationInput = { status };
  if (status === "qualified" && !lead.qualifiedAt) data.qualifiedAt = now;
  if (status === "won") { data.wonAt = now; if (p.value !== undefined && p.value !== null) data.value = p.value; data.lostAt = null; data.lostReason = null; }
  if (status === "lost") { data.lostAt = now; data.lostReason = clean(p.lostReason, 300); }
  if (status !== "won" && lead.status === "won") data.wonAt = null;

  // Écriture CONDITIONNELLE au statut effectivement observé (vérification atomique) : une modification concurrente plus récente n'est jamais écrasée,
  // l'historique (`from`) et les dates associées (wonAt, lostAt) sont toujours calculés sur l'état réellement remplacé.
  const cas = await c.lead.updateMany({ where: { id: lead.id, workspaceId: p.workspaceId, status: lead.status, deletedAt: null }, data });
  if (cas.count !== 1) throw new LeadStatusConflict("Le statut du prospect a été modifié entre-temps.");
  const updated = await c.lead.findUniqueOrThrow({ where: { id: lead.id } });
  await c.leadActivity.create({ data: { workspaceId: p.workspaceId, leadId: lead.id, type: "status_changed", actorId: p.actorId ?? null, data: { from: lead.status, to: status } } });

  if (status === "won") {
    // Client créé à partir du lead (une seule fois) ; le revenu est le montant de l'affaire.
    let customerId = updated.customerId;
    if (!customerId) {
      const cu = await c.customer.create({ data: { workspaceId: p.workspaceId, campaignId: updated.campaignId, name: updated.name, email: updated.email, phone: updated.phone, company: updated.company, revenue: updated.value ?? 0 } });
      customerId = cu.id;
      await c.lead.update({ where: { id: lead.id }, data: { customerId } });
    } else {
      await c.customer.updateMany({ where: { id: customerId, workspaceId: p.workspaceId }, data: { revenue: updated.value ?? 0 } });
    }
    await c.analyticsEvent.create({ data: { workspaceId: p.workspaceId, type: "customer_won", leadId: lead.id, campaignId: updated.campaignId, meta: { value: updated.value } } });
  }
  return { lead: (await c.lead.findUnique({ where: { id: lead.id } })) ?? updated, from: lead.status, changed: true, valueCorrected: false, terminal: (TERMINAL_STATUSES as string[]).includes(status) };
}

export async function changeLeadStatus(p: StatusChangeInput): Promise<Lead> {
  // Toutes les écritures d'un essai (prospect, historique, client, événement) sont faites dans UNE transaction : tout ou rien.
  // Un conflit est levé avant toute écriture (écriture conditionnelle en premier), la transaction annulée ne laisse donc aucun effet.
  let r: StatusChangeResult | undefined;
  if (p.expectedFrom !== undefined) {
    // Transition AUTOMATIQUE : un seul essai, jamais de reprise sur conflit. Le prospect est laissé tel quel (une décision humaine plus récente l'emporte).
    try { r = await runTx((tx) => applyLeadStatusChange(tx, p)); }
    catch (e) {
      if (!(e instanceof LeadStatusConflict)) throw e;
      const cur = await db.lead.findFirst({ where: { id: p.leadId, workspaceId: p.workspaceId, deletedAt: null } });
      if (!cur) throw new LeadError("Prospect introuvable.");
      log.info("lead.auto_status_skipped", { leadId: cur.id, expectedFrom: p.expectedFrom, to: p.status });
      return cur;
    }
    if (r.skipped) log.info("lead.auto_status_skipped", { leadId: r.lead.id, expectedFrom: p.expectedFrom, to: p.status });
  } else {
    // Chemin manuel : en cas de modification concurrente, la décision explicite de l'utilisateur est réappliquée sur l'état réellement observé (au plus 3 essais).
    for (let i = 0; !r; i++) {
      try { r = await runTx((tx) => applyLeadStatusChange(tx, p)); }
      catch (e) {
        if (!(e instanceof LeadStatusConflict)) throw e;
        if (i >= 2) throw new LeadError("Le prospect est modifié en continu : réessayez.");
      }
    }
  }
  if (r.valueCorrected) {
    await audit({ workspaceId: p.workspaceId, userId: p.actorId, action: "lead.value_corrected", entity: "Lead", entityId: r.lead.id });
    return r.lead;
  }
  if (!r.changed) return r.lead;
  if (r.terminal) await cancelPendingFollowUps(p.workspaceId, r.lead.id, `Statut « ${p.status} » : relances arrêtées.`);
  await audit({ workspaceId: p.workspaceId, userId: p.actorId, action: "lead.status_changed", entity: "Lead", entityId: r.lead.id, meta: { from: r.from, to: p.status } });
  return r.lead;
}

// ───────────────────────── Coordonnées et consentement ─────────────────────────

export type LeadDetailsInput = {
  workspaceId: string; leadId: string; name: string; email: string | null; phone: string | null; company: string | null; value: number | null;
  /** Consentement marketing EXPLICITE pour l'adresse enregistrée, attesté par l'utilisateur qui saisit la modification. */
  consentForEmail?: boolean; actorId?: string | null;
};
export type LeadDetailsResult = { emailChanged: boolean; consentRevoked: boolean; consentGranted: boolean; cancelledFollowUps: number };

const normEmail = (e?: string | null) => (e && e.trim() ? e.trim().toLowerCase() : null);
const EMAIL_CHANGED_REASON = "Adresse e-mail modifiée : le consentement marketing de l'ancienne adresse ne s'applique pas à la nouvelle.";

/**
 * Point UNIQUE de modification des coordonnées d'un prospect. Règle : une nouvelle adresse (comparaison normalisée) n'hérite JAMAIS de l'autorisation marketing de l'ancienne.
 * Dans UNE transaction (ordre FollowUp → Lead → données dérivées) : les relances e-mail en attente ou bloquées sont annulées, le consentement marketing du prospect est retiré,
 * la révocation est tracée (ligne de consentement « granted: false » sur l'ANCIENNE adresse, source « email_changed »), puis les coordonnées sont écrites de façon CONDITIONNELLE à la
 * version lue (deux modifications concurrentes : la seconde est relue, jamais écrasée). Un nouvel envoi marketing exige un consentement enregistré pour la nouvelle adresse
 * (`consentForEmail`, ou un enregistrement ultérieur) ; la désinscription et la liste de suppression restent inchangées et prioritaires. Aucun message n'est envoyé.
 * Le moteur d'envoi exige en outre une ligne de consentement accordée pour l'adresse EXACTE du prospect : une écriture directe en base ne contourne pas la règle.
 */
export async function updateLeadDetails(p: LeadDetailsInput): Promise<LeadDetailsResult | null> {
  const newEmail = normEmail(p.email);
  for (let attempt = 0; attempt < 3; attempt++) {
    const lead = await db.lead.findFirst({ where: { id: p.leadId, workspaceId: p.workspaceId, deletedAt: null } });
    if (!lead) return null;
    const oldEmail = normEmail(lead.email);
    const changed = oldEmail !== newEmail;
    if (p.consentForEmail) {
      if (lead.unsubscribedAt) throw new LeadError("Le prospect s'est désinscrit : aucun consentement ne peut être enregistré par cette voie.");
      if (!newEmail) throw new LeadError("Indiquez une adresse e-mail pour enregistrer un consentement.");
    }
    const grant = !!p.consentForEmail && (changed || !lead.consentMarketing);
    const now = new Date();
    const consentText = "Consentement attesté par l'utilisateur de SEA Pilot lors de la modification de la fiche";
    const out = await runTx<LeadDetailsResult | "conflict">(async (tx) => {
      let cancelled = 0;
      if (changed) {
        cancelled = (await tx.followUp.updateMany({
          where: { workspaceId: p.workspaceId, leadId: lead.id, action: "email", status: { in: ["pending", "blocked"] } },
          data: { status: "cancelled", result: EMAIL_CHANGED_REASON, executedAt: now, failureKind: "email_changed", leaseToken: null, leaseUntil: null, retryAfter: null },
        })).count;
      }
      const data: Prisma.LeadUpdateManyMutationInput = { name: p.name, email: newEmail, phone: p.phone, company: p.company, value: p.value };
      if (changed) data.consentMarketing = false;
      if (grant) { data.consentMarketing = true; data.consentAt = now; data.consentText = consentText; }
      const u = await tx.lead.updateMany({ where: { id: lead.id, workspaceId: p.workspaceId, updatedAt: lead.updatedAt, deletedAt: null }, data });
      if (u.count !== 1) throw new TxAbort("conflict" as const);
      const revoked = changed && lead.consentMarketing && !!oldEmail;
      if (revoked) {
        await tx.consent.create({ data: { workspaceId: p.workspaceId, leadId: lead.id, email: oldEmail!, type: "marketing", granted: false, source: "email_changed" } });
        await tx.leadActivity.create({ data: { workspaceId: p.workspaceId, leadId: lead.id, type: "consent", actorId: p.actorId ?? null, data: { action: "revoked", reason: "email_changed" } } });
      }
      if (grant && newEmail) {
        await tx.consent.create({ data: { workspaceId: p.workspaceId, leadId: lead.id, email: newEmail, type: "marketing", granted: true, source: "manual_email_change", text: consentText } });
        await tx.leadActivity.create({ data: { workspaceId: p.workspaceId, leadId: lead.id, type: "consent", actorId: p.actorId ?? null, data: { action: "granted", reason: "explicit" } } });
      }
      return { emailChanged: changed, consentRevoked: revoked, consentGranted: grant, cancelledFollowUps: cancelled };
    });
    if (out === "conflict") continue; // modification concurrente : relecture de l'état réel, la règle est réévaluée
    if (out.emailChanged || out.consentGranted) {
      // sans adresse ni donnée personnelle dans la trace
      await audit({ workspaceId: p.workspaceId, userId: p.actorId, action: "lead.email_changed", entity: "Lead", entityId: lead.id, meta: { consentRevoked: out.consentRevoked, consentGranted: out.consentGranted, cancelledFollowUps: out.cancelledFollowUps } });
    }
    return out;
  }
  throw new LeadError("Le prospect est modifié en continu : réessayez.");
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

  // L'IA n'est lancée que sur demande explicite (action manuelle « Qualifier avec l'IA ») ET avec un fournisseur disponible. Aucun réglage enregistré ne l'active (la colonne useAi n'est plus lue).
  const wantAi = p.allowAi === true && !!getProvider();
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
    // Transition automatique : appliquée seulement si le prospect est TOUJOURS « new » au moment de l'écriture (la lecture du début est périmée).
    await changeLeadStatus({ workspaceId: p.workspaceId, leadId: lead.id, status: "qualified", actorId: p.userId, expectedFrom: "new" });
  }
  return { qualification: q, record: rec, method };
}

// ───────────────────────── RGPD ─────────────────────────

/**
 * Codes de reprise des transactions qui écrivent une entrée de la liste de suppression (désinscription, effacement) : les codes habituels, PLUS `P2002`.
 * Une insertion concurrente de la MÊME entrée (typiquement le backfill de la liste, dans une autre connexion, qui crée la clé HMAC) fait échouer l'`upsert` Prisma
 * (désinscription : `update: {}` vide, upsert exécuté côté client, SELECT puis INSERT, donc exposé à la course ; effacement : `update` non vide, qui ne collisionne pas dans le scénario
 * déterministe de tests/pg-suppression-race.test.ts, la reprise y est une précaution). PostgreSQL invalide alors la transaction : elle n'est JAMAIS
 * poursuivie après l'erreur, elle est REPRISE EN ENTIER (Prisma l'a déjà annulée) et le nouvel essai retrouve la ligne créée entre-temps. Mêmes limites que les autres reprises
 * (`TX_MAX_RETRIES`, attente 100–400 ms) ; une `P2002` persistante est relancée, jamais transformée en succès. Aucune autre contrainte d'unicité (hors clés primaires générées)
 * n'est écrite par ces deux transactions.
 */
const SUPPRESSION_TX_CODES = [...TX_RETRY_CODES, "P2002"] as const;

/**
 * Désinscription : UNE transaction (ordre FollowUp → Lead → données dérivées) — révocation de toutes les relances (y compris celles en cours : leur jeton est effacé),
 * retrait du consentement, liste de suppression, trace. Rejouable : un second appel répare une désinscription interrompue (liste de suppression, relances).
 */
export async function unsubscribeLead(workspaceId: string, leadId: string, source = "link") {
  const lead = await db.lead.findFirst({ where: { id: leadId, workspaceId } });
  if (!lead) return false;
  const now = new Date();
  await runTx(async (tx) => {
    await revokeLeadFollowUps(tx, workspaceId, lead.id, "Le prospect s'est désinscrit.", now);
    const first = (await tx.lead.updateMany({ where: { id: lead.id, workspaceId, unsubscribedAt: null }, data: { unsubscribedAt: now, consentMarketing: false } })).count === 1;
    if (lead.email) {
      const email = lead.email.toLowerCase();
      const suppressionKey = suppressionWriteKey(workspaceId, email, { fallback: "plain" }); // avec une clé dédiée : HMAC ; sans clé : adresse en clair comme avant
      await tx.emailSuppression.upsert({ where: { workspaceId_email: { workspaceId, email: suppressionKey } }, create: { workspaceId, email: suppressionKey, reason: "unsubscribe" }, update: {} });
      if (first) await tx.consent.create({ data: { workspaceId, leadId: lead.id, email, type: "marketing", granted: false, source } });
    }
    if (first) await tx.leadActivity.create({ data: { workspaceId, leadId: lead.id, type: "unsubscribed", data: { source } } });
  }, { codes: SUPPRESSION_TX_CODES }); // reprise complète sur collision avec une création concurrente de l'entrée de suppression
  return true;
}

/**
 * Conservation de la PREUVE de consentement après effacement (décision juridique NON tranchée : voir docs/followup-reliability.md § 13).
 * `true` (défaut) : les lignes de consentement sont pseudonymisées (adresse remplacée par une empreinte salée, adresse IP retirée) et conservées ;
 * `false` : elles sont supprimées. Point de décision unique : aucune autre partie du code ne suppose l'une ou l'autre.
 */
export const KEEP_CONSENT_PROOF_AT_ERASURE = true;

const ERASED = "[effacé]";

let eraseHook: ((step: string) => void | Promise<void>) | null = null;
/** Test uniquement : exécuté entre les étapes de l'effacement (une exception annule toute la transaction). */
export const setEraseHookForTests = (h: typeof eraseHook) => { eraseHook = h; };

/**
 * Effacement RGPD d'un prospect : UNE transaction (tout ou rien).
 *  - SUPPRIMÉS : conversations, contacts, qualifications IA, historique, tâches, notifications du prospect (lien `/leads/<id>`) ;
 *  - EFFACÉS dans la fiche : nom, coordonnées, message, champs personnalisés, motif de perte (texte libre), adresse IP, référent, URL, texte de consentement ;
 *  - ANONYMISÉS, conservés : fiche client liée si aucun autre prospect ne la partage (montant conservé pour la comptabilité agrégée), journal d'e-mails (adresse, objet,
 *    erreur et notes retirés ; résultat fournisseur, identifiants techniques et horodatages conservés : preuve d'un envoi éventuel, résultat tardif encore enregistrable),
 *    événements analytiques (rattachement au prospect et à la session retirés ; agrégats conservés), résultat des relances (texte remplacé) ;
 *  - PSEUDONYMISÉS : liste de suppression (empreinte salée, jamais l'adresse en clair) et consentements (voir KEEP_CONSENT_PROOF_AT_ERASURE) ;
 *  - CONSERVÉS : fiche anonyme du prospect (statuts, dates, montant, attribution), audit (identifiants techniques seulement).
 * Relances annulées. Un envoi dont l'appel fournisseur est déjà commencé ne peut pas être rappelé : il est tracé avant l'anonymisation du journal.
 */
export async function eraseLead(workspaceId: string, leadId: string, actorId?: string | null) {
  const lead = await db.lead.findFirst({ where: { id: leadId, workspaceId } });
  if (!lead) return false;
  const inFlight = await db.emailLog.findMany({ where: { workspaceId, leadId, status: "attempting", callStartedAt: { not: null } }, select: { id: true, followUpId: true } });
  const customerAnonymized = await runTx(async (tx) => {
    await revokeLeadFollowUps(tx, workspaceId, leadId, "Prospect effacé.");
    await eraseHook?.("afterRevoke");
    if (lead.email) {
      const email = lead.email.toLowerCase();
      const key = suppressionWriteKey(workspaceId, email, { fallback: "sha" });
      // L'entrée pseudonymisée est écrite et VÉRIFIÉE avant que l'ancienne ligne en clair (désinscription antérieure) soit retirée, dans la même transaction.
      await tx.emailSuppression.upsert({ where: { workspaceId_email: { workspaceId, email: key } }, create: { workspaceId, email: key, reason: "erasure" }, update: { reason: "erasure" } });
      if (key !== email && (await tx.emailSuppression.findUnique({ where: { workspaceId_email: { workspaceId, email: key } }, select: { id: true } }))) await tx.emailSuppression.deleteMany({ where: { workspaceId, email } });
      if (KEEP_CONSENT_PROOF_AT_ERASURE) await tx.consent.updateMany({ where: { workspaceId, leadId }, data: { email: key, ipHash: null } });
    }
    if (!KEEP_CONSENT_PROOF_AT_ERASURE) await tx.consent.deleteMany({ where: { workspaceId, leadId } });
    await eraseHook?.("afterConsent");
    await tx.lead.update({
      where: { id: leadId },
      data: { name: "Prospect effacé", email: null, phone: null, company: null, message: null, customFields: Prisma.DbNull, lostReason: null, ipHash: null, referrer: null, landingUrl: null, consentText: null, consentMarketing: false, deletedAt: new Date() },
    });
    let customerDone = false;
    if (lead.customerId) {
      const shared = await tx.lead.count({ where: { workspaceId, customerId: lead.customerId, id: { not: leadId }, deletedAt: null } });
      if (!shared) {
        customerDone = (await tx.customer.updateMany({ where: { id: lead.customerId, workspaceId }, data: { name: "Client effacé", email: null, phone: null, company: null, notes: null } })).count > 0;
        await tx.contact.deleteMany({ where: { workspaceId, customerId: lead.customerId } });
      }
    }
    await eraseHook?.("afterCustomer");
    await tx.conversation.deleteMany({ where: { workspaceId, leadId } });
    await tx.contact.deleteMany({ where: { workspaceId, leadId } });
    await tx.aIQualification.deleteMany({ where: { workspaceId, leadId } });
    await tx.leadActivity.deleteMany({ where: { workspaceId, leadId } });
    await tx.task.deleteMany({ where: { workspaceId, leadId } });
    await tx.notification.deleteMany({ where: { workspaceId, href: { startsWith: `/leads/${leadId}` } } });
    await tx.emailLog.updateMany({ where: { workspaceId, leadId }, data: { to: ERASED, subject: ERASED, error: null, humanNote: null, contradictionAckNote: null } });
    await tx.analyticsEvent.updateMany({ where: { workspaceId, leadId }, data: { leadId: null, sessionId: null, referrer: null } });
    await tx.followUp.updateMany({ where: { workspaceId, leadId, result: { not: null } }, data: { result: "Résultat effacé (prospect effacé)." } });
    await eraseHook?.("beforeCommit");
    return customerDone;
  }, { codes: SUPPRESSION_TX_CODES }); // reprise complète sur collision avec une création concurrente de l'entrée de suppression
  for (const e of inFlight) await audit({ workspaceId, userId: actorId, action: "email.in_flight_at_revocation", entity: "EmailLog", entityId: e.id, meta: { followUpId: e.followUpId } });
  await audit({ workspaceId, userId: actorId, action: "lead.erased", entity: "Lead", entityId: leadId, meta: { customerAnonymized, consentProofKept: KEEP_CONSENT_PROOF_AT_ERASURE } });
  return true;
}

export async function exportLeadData(workspaceId: string, leadId: string) {
  const lead = await db.lead.findFirst({ where: { id: leadId, workspaceId, deletedAt: null }, include: { conversations: true, activities: true, qualifications: true, tasks: true, followUps: true, contacts: true } });
  return lead;
}
