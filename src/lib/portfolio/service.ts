// Services du portefeuille multi-produits. Toute requête est bornée par workspaceId (isolation multi-tenant).
// Aucune fonction ici n'envoie de message : les contacts sont CONSIGNÉS par un humain après vérification d'éligibilité.
import type { Prisma, Prospect } from "@prisma/client";
import { db } from "../db";
import { audit } from "../audit";
import { slugify } from "../workspaces";
import { DEFAULT_PRODUCTS } from "./catalog";
import {
  contactEligibility, dedupeKeyOf, domainOf, eventDedupeKey, normalizeEmail, EVENT_TYPES, LEGAL_BASES, OUTREACH_CHANNELS,
  type Eligibility, type ImportRow, type ProductEventType,
} from "./rules";

export class PortfolioError extends Error {}

const isUnique = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
const json = (v: unknown) => v as Prisma.InputJsonValue;

// ───────────── Catalogue ─────────────
/** Crée les fiches initiales manquantes (idempotent : une fiche existante n'est jamais modifiée). */
export async function ensureDefaultProducts(workspaceId: string, actorId?: string | null): Promise<{ created: string[] }> {
  const created: string[] = [];
  for (const d of DEFAULT_PRODUCTS) {
    const exists = await db.product.findUnique({ where: { workspaceId_slug: { workspaceId, slug: d.slug } }, select: { id: true } });
    if (exists) continue;
    await db.product.create({
      data: {
        workspaceId, slug: d.slug, name: d.name, tagline: d.tagline, description: d.description, valueProposition: d.valueProposition, targetCustomers: d.targetCustomers,
        problemsSolved: json(d.problemsSolved), features: json(d.features), pricing: json(d.pricing), publicUrl: d.publicUrl, signupUrl: d.signupUrl, demoUrl: d.demoUrl,
        salesArguments: json(d.salesArguments), objections: json(d.objections), channels: json(d.channels), qualification: json(d.qualification), unconfirmed: json(d.unconfirmed), status: d.status,
      },
    });
    created.push(d.slug);
  }
  if (created.length) await audit({ workspaceId, userId: actorId, action: "product.defaults_created", entity: "Product", meta: { slugs: created } });
  return { created };
}

export async function productSlugFor(workspaceId: string, name: string): Promise<string> {
  const base = slugify(name) || "produit";
  let slug = base;
  for (let i = 2; await db.product.findUnique({ where: { workspaceId_slug: { workspaceId, slug } }, select: { id: true } }); i++) slug = `${base}-${i}`;
  return slug;
}

// ───────────── Prospects : création, déduplication, attribution ─────────────
export type NewProspect = {
  name: string; company?: string | null; jobTitle?: string | null; email?: string | null; phone?: string | null; website?: string | null;
  audienceType?: "b2b" | "b2c"; segment?: string | null; source: string; sourceUrl?: string | null; collectedAt: Date;
  legalBasis?: string; legalBasisNote?: string | null; productId?: string | null; notes?: string | null; importBatch?: string | null;
};

export type AddProspectResult =
  | { kind: "created"; prospect: Prospect }
  | { kind: "duplicate"; prospect: Prospect; interestAdded: boolean };

async function isSuppressed(workspaceId: string, email: string | null): Promise<boolean> {
  if (!email) return false;
  if (await db.emailSuppression.findUnique({ where: { workspaceId_email: { workspaceId, email } }, select: { id: true } })) return true;
  return !!(await db.lead.findFirst({ where: { workspaceId, email, unsubscribedAt: { not: null } }, select: { id: true } }));
}

async function assertProduct(workspaceId: string, productId: string) {
  const p = await db.product.findFirst({ where: { id: productId, workspaceId, deletedAt: null }, select: { id: true, status: true } });
  if (!p) throw new PortfolioError("Produit introuvable.");
  return p;
}

export async function addProspect(workspaceId: string, i: NewProspect, actorId?: string | null): Promise<AddProspectResult> {
  const name = i.name.trim().slice(0, 120);
  const source = i.source.trim().slice(0, 160);
  if (!name) throw new PortfolioError("Nom requis.");
  if (!source) throw new PortfolioError("La provenance est obligatoire.");
  if (Number.isNaN(i.collectedAt.getTime())) throw new PortfolioError("Date de collecte invalide.");
  const email = normalizeEmail(i.email);
  if (i.email && !email) throw new PortfolioError("Adresse courriel invalide.");
  if (!email && !i.phone?.trim()) throw new PortfolioError("Un courriel ou un téléphone est requis.");
  const legalBasis = (LEGAL_BASES as readonly string[]).includes(i.legalBasis ?? "") ? (i.legalBasis as string) : "unknown";
  if (i.productId) await assertProduct(workspaceId, i.productId);

  const dedupeKey = dedupeKeyOf({ email, phone: i.phone, company: i.company, name });
  const existing = await db.prospect.findUnique({ where: { workspaceId_dedupeKey: { workspaceId, dedupeKey } } });
  if (existing) return { kind: "duplicate", prospect: existing, interestAdded: await noteInterest(workspaceId, existing, i.productId ?? null, actorId) };

  const suppressed = await isSuppressed(workspaceId, email);
  try {
    const prospect = await db.prospect.create({
      data: {
        workspaceId, productId: i.productId ?? null, name, company: i.company?.trim().slice(0, 160) || null, jobTitle: i.jobTitle?.trim().slice(0, 120) || null,
        email, phone: i.phone?.trim().slice(0, 40) || null, websiteDomain: domainOf(i.website), dedupeKey, audienceType: i.audienceType === "b2c" ? "b2c" : "b2b",
        segment: i.segment?.trim().slice(0, 120) || null, source, sourceUrl: i.sourceUrl?.trim().slice(0, 400) || null, collectedAt: i.collectedAt,
        legalBasis, legalBasisNote: i.legalBasisNote?.trim().slice(0, 400) || null, notes: i.notes?.trim().slice(0, 1000) || null, importBatch: i.importBatch ?? null,
        status: suppressed ? "do_not_contact" : "identified", optedOutAt: suppressed ? new Date() : null, createdById: actorId ?? null,
      },
    });
    await audit({ workspaceId, userId: actorId, action: "prospect.created", entity: "Prospect", entityId: prospect.id, meta: { productId: prospect.productId, source, legalBasis, suppressed } });
    return { kind: "created", prospect };
  } catch (e) {
    if (!isUnique(e)) throw e;
    // Création concurrente de la même personne : on retombe sur la fiche existante.
    const again = await db.prospect.findUnique({ where: { workspaceId_dedupeKey: { workspaceId, dedupeKey } } });
    if (!again) throw e;
    return { kind: "duplicate", prospect: again, interestAdded: await noteInterest(workspaceId, again, i.productId ?? null, actorId) };
  }
}

/** Même personne retrouvée pour un autre produit : on l'enregistre comme intérêt, sans changer l'attribution ni contacter. */
async function noteInterest(workspaceId: string, p: Prospect, productId: string | null, actorId?: string | null): Promise<boolean> {
  if (!productId || productId === p.productId) return false;
  if (!p.productId) {
    await db.prospect.update({ where: { id: p.id }, data: { productId } });
    await audit({ workspaceId, userId: actorId, action: "prospect.assigned", entity: "Prospect", entityId: p.id, meta: { productId } });
    return false;
  }
  try {
    await db.prospectProduct.create({ data: { workspaceId, prospectId: p.id, productId, note: "Retrouvé lors d'un ajout ou import pour ce produit." } });
    await audit({ workspaceId, userId: actorId, action: "prospect.interest_added", entity: "Prospect", entityId: p.id, meta: { productId } });
    return true;
  } catch (e) {
    if (isUnique(e)) return false;
    throw e;
  }
}

export type ImportSummary = { created: number; duplicates: number; interestsAdded: number; rejected: { line: number; message: string }[] };

export async function importProspects(workspaceId: string, rows: ImportRow[], opts: { defaultProductId?: string | null; batch: string; actorId?: string | null }): Promise<ImportSummary> {
  const products = await db.product.findMany({ where: { workspaceId, deletedAt: null }, select: { id: true, slug: true } });
  const bySlug = new Map(products.map((p) => [p.slug, p.id]));
  const sum: ImportSummary = { created: 0, duplicates: 0, interestsAdded: 0, rejected: [] };
  for (const r of rows) {
    const productId = r.productSlug ? bySlug.get(r.productSlug) : opts.defaultProductId ?? undefined;
    if (!productId) { sum.rejected.push({ line: r.line, message: r.productSlug ? `Produit inconnu : « ${r.productSlug} ».` : "Aucun produit indiqué (colonne produit ou produit par défaut)." }); continue; }
    try {
      const res = await addProspect(workspaceId, {
        name: r.name, company: r.company, jobTitle: r.jobTitle, email: r.email, phone: r.phone, website: r.website, audienceType: r.audienceType, segment: r.segment,
        source: r.source, sourceUrl: r.sourceUrl, collectedAt: r.collectedAt, legalBasis: r.legalBasis, legalBasisNote: r.legalBasisNote, productId, notes: r.notes, importBatch: opts.batch,
      }, opts.actorId);
      if (res.kind === "created") sum.created++;
      else { sum.duplicates++; if (res.interestAdded) sum.interestsAdded++; }
    } catch (e) {
      if (e instanceof PortfolioError) sum.rejected.push({ line: r.line, message: e.message });
      else throw e;
    }
  }
  await audit({ workspaceId, userId: opts.actorId, action: "prospect.imported", entity: "Prospect", meta: { batch: opts.batch, ...sum, rejected: sum.rejected.length } });
  return sum;
}

/** Réattribution explicite : exige un motif, détache le prospect de toute campagne et conserve l'ancien produit comme intérêt. */
export async function reassignProspect(p: { workspaceId: string; prospectId: string; toProductId: string; reason: string; actorId?: string | null }): Promise<Prospect> {
  const reason = p.reason.trim();
  if (reason.length < 5) throw new PortfolioError("Un motif de réattribution est requis.");
  await assertProduct(p.workspaceId, p.toProductId);
  const pr = await db.prospect.findFirst({ where: { id: p.prospectId, workspaceId: p.workspaceId, deletedAt: null } });
  if (!pr) throw new PortfolioError("Prospect introuvable.");
  if (pr.productId === p.toProductId) return pr;
  if (pr.productId) await db.prospectProduct.upsert({ where: { prospectId_productId: { prospectId: pr.id, productId: pr.productId } }, create: { workspaceId: p.workspaceId, prospectId: pr.id, productId: pr.productId, note: "Ancienne attribution" }, update: {} });
  await db.prospectProduct.deleteMany({ where: { prospectId: pr.id, productId: p.toProductId } });
  const u = await db.prospect.update({ where: { id: pr.id }, data: { productId: p.toProductId, campaignId: null } });
  await audit({ workspaceId: p.workspaceId, userId: p.actorId, action: "prospect.reassigned", entity: "Prospect", entityId: pr.id, meta: { from: pr.productId, to: p.toProductId, reason } });
  return u;
}

/** Opposition / désinscription : définitive, applicable à tous les produits, et répercutée dans la liste de suppression. */
export async function optOutProspect(p: { workspaceId: string; prospectId: string; actorId?: string | null; reason?: string }): Promise<Prospect> {
  const pr = await db.prospect.findFirst({ where: { id: p.prospectId, workspaceId: p.workspaceId } });
  if (!pr) throw new PortfolioError("Prospect introuvable.");
  if (pr.optedOutAt && pr.status === "do_not_contact") return pr; // rejeu
  const u = await db.prospect.update({ where: { id: pr.id }, data: { status: "do_not_contact", optedOutAt: pr.optedOutAt ?? new Date(), campaignId: null, nextFollowUpAt: null } });
  if (pr.email) await db.emailSuppression.upsert({ where: { workspaceId_email: { workspaceId: p.workspaceId, email: pr.email } }, create: { workspaceId: p.workspaceId, email: pr.email, reason: "prospect_opt_out" }, update: {} });
  await audit({ workspaceId: p.workspaceId, userId: p.actorId, action: "prospect.opted_out", entity: "Prospect", entityId: pr.id, meta: { reason: p.reason ?? null } });
  return u;
}

// ───────────── Contact : éligibilité puis consignation (aucun envoi) ─────────────
async function concurrentCampaignFor(workspaceId: string, prospect: Prospect, productId: string): Promise<boolean> {
  if (!prospect.campaignId) return false;
  const c = await db.outreachCampaign.findFirst({ where: { id: prospect.campaignId, workspaceId }, select: { productId: true, status: true } });
  return !!c && c.productId !== productId && c.status === "active";
}

export async function checkEligibility(p: { workspaceId: string; prospectId: string; productId: string; channel: string; templateId?: string | null; now?: Date }): Promise<Eligibility> {
  const prospect = await db.prospect.findFirst({ where: { id: p.prospectId, workspaceId: p.workspaceId } });
  if (!prospect) return { ok: false, reasons: ["Prospect introuvable."] };
  const [product, channelSetting, template, suppressed, concurrent] = await Promise.all([
    db.product.findFirst({ where: { id: p.productId, workspaceId: p.workspaceId }, select: { status: true, deletedAt: true } }),
    db.outreachChannel.findUnique({ where: { workspaceId_channel: { workspaceId: p.workspaceId, channel: p.channel } } }),
    p.templateId === undefined ? Promise.resolve(undefined) : db.messageTemplate.findFirst({ where: { id: p.templateId ?? "", workspaceId: p.workspaceId }, select: { status: true, productId: true, channel: true } }),
    isSuppressed(p.workspaceId, prospect.email),
    concurrentCampaignFor(p.workspaceId, prospect, p.productId),
  ]);
  return contactEligibility({
    now: p.now, channel: p.channel, productId: p.productId, product, prospect, suppressed, channelSetting,
    template: template === undefined ? undefined : template, concurrentCampaign: concurrent,
  });
}

export async function logContact(p: {
  workspaceId: string; prospectId: string; productId: string; channel: string; templateId?: string | null; subject?: string | null; summary?: string | null;
  outcome?: string | null; actorId?: string | null; nextFollowUpAt?: Date | null; now?: Date;
}): Promise<{ eligibility: Eligibility; prospect?: Prospect }> {
  if (!(OUTREACH_CHANNELS as readonly string[]).includes(p.channel)) throw new PortfolioError("Canal inconnu.");
  const eligibility = await checkEligibility({ ...p, templateId: p.templateId ?? undefined });
  if (!eligibility.ok) {
    await audit({ workspaceId: p.workspaceId, userId: p.actorId, action: "prospect.contact_refused", entity: "Prospect", entityId: p.prospectId, meta: { productId: p.productId, channel: p.channel, reasons: eligibility.reasons } });
    return { eligibility };
  }
  const now = p.now ?? new Date();
  const prospect = await db.$transaction(async (tx) => {
    await tx.prospectContact.create({ data: { workspaceId: p.workspaceId, prospectId: p.prospectId, productId: p.productId, channel: p.channel, direction: "outbound", templateId: p.templateId ?? null, subject: p.subject?.slice(0, 200) ?? null, summary: p.summary?.slice(0, 2000) ?? null, outcome: p.outcome ?? null, actorId: p.actorId ?? null } });
    return tx.prospect.update({
      where: { id: p.prospectId },
      data: { contactCount: { increment: 1 }, lastContactedAt: now, nextFollowUpAt: p.nextFollowUpAt ?? null, status: "contacted" },
    });
  });
  await audit({ workspaceId: p.workspaceId, userId: p.actorId, action: "prospect.contacted", entity: "Prospect", entityId: p.prospectId, meta: { productId: p.productId, channel: p.channel, templateId: p.templateId ?? null } });
  if (p.outcome === "opted_out") return { eligibility, prospect: await optOutProspect({ workspaceId: p.workspaceId, prospectId: p.prospectId, actorId: p.actorId, reason: "opposition lors du contact" }) };
  return { eligibility, prospect };
}

/** Réponse reçue (consignée à la main). Remplace le statut « contacté » par « a répondu ». */
export async function logReply(p: { workspaceId: string; prospectId: string; channel: string; summary?: string | null; actorId?: string | null; optOut?: boolean }): Promise<Prospect> {
  const pr = await db.prospect.findFirst({ where: { id: p.prospectId, workspaceId: p.workspaceId, deletedAt: null } });
  if (!pr) throw new PortfolioError("Prospect introuvable.");
  await db.prospectContact.create({ data: { workspaceId: p.workspaceId, prospectId: pr.id, productId: pr.productId, channel: p.channel, direction: "inbound", summary: p.summary?.slice(0, 2000) ?? null, outcome: p.optOut ? "opted_out" : "replied", actorId: p.actorId ?? null } });
  if (p.optOut) return optOutProspect({ workspaceId: p.workspaceId, prospectId: pr.id, actorId: p.actorId, reason: "opposition dans la réponse" });
  const keep = ["demo", "trial", "customer"].includes(pr.status);
  return db.prospect.update({ where: { id: pr.id }, data: { status: keep ? pr.status : "replied" } });
}

// ───────────── Campagnes de prospection : approbation humaine ─────────────
export async function attachProspectToCampaign(p: { workspaceId: string; campaignId: string; prospectId: string; actorId?: string | null }): Promise<void> {
  const [c, pr] = await Promise.all([
    db.outreachCampaign.findFirst({ where: { id: p.campaignId, workspaceId: p.workspaceId } }),
    db.prospect.findFirst({ where: { id: p.prospectId, workspaceId: p.workspaceId, deletedAt: null } }),
  ]);
  if (!c || !pr) throw new PortfolioError("Campagne ou prospect introuvable.");
  if (pr.productId !== c.productId) throw new PortfolioError("Le prospect n'est pas attribué au produit de cette campagne.");
  if (pr.optedOutAt || pr.status === "do_not_contact") throw new PortfolioError("Le prospect s'est opposé à tout contact.");
  if (pr.campaignId && pr.campaignId !== c.id) throw new PortfolioError("Le prospect est déjà dans une autre campagne de prospection (une seule à la fois).");
  await db.prospect.update({ where: { id: pr.id }, data: { campaignId: c.id } });
  await audit({ workspaceId: p.workspaceId, userId: p.actorId, action: "outreach.prospect_attached", entity: "OutreachCampaign", entityId: c.id, meta: { prospectId: pr.id } });
}

export async function approveOutreachCampaign(p: { workspaceId: string; campaignId: string; actorId?: string | null }): Promise<void> {
  const c = await db.outreachCampaign.findFirst({ where: { id: p.campaignId, workspaceId: p.workspaceId } });
  if (!c) throw new PortfolioError("Campagne introuvable.");
  if (c.status === "active") return; // rejeu
  if (c.status !== "pending_approval") throw new PortfolioError("La campagne doit d'abord être soumise à l'approbation.");
  const [product, channel, template] = await Promise.all([
    db.product.findFirst({ where: { id: c.productId, workspaceId: p.workspaceId, deletedAt: null }, select: { status: true } }),
    db.outreachChannel.findUnique({ where: { workspaceId_channel: { workspaceId: p.workspaceId, channel: c.channel } } }),
    c.templateId ? db.messageTemplate.findFirst({ where: { id: c.templateId, workspaceId: p.workspaceId } }) : null,
  ]);
  const problems: string[] = [];
  if (product?.status !== "commercialisation") problems.push("le produit n'est pas en commercialisation");
  if (!channel?.enabled) problems.push("le canal est désactivé");
  if (!template || template.status !== "approved" || template.productId !== c.productId || template.channel !== c.channel) problems.push("aucun modèle de message approuvé pour ce produit et ce canal");
  if (problems.length) throw new PortfolioError(`Approbation impossible : ${problems.join(" ; ")}.`);
  await db.outreachCampaign.update({ where: { id: c.id }, data: { status: "active", approvedById: p.actorId ?? null, approvedAt: new Date() } });
  await audit({ workspaceId: p.workspaceId, userId: p.actorId, action: "outreach.campaign_approved", entity: "OutreachCampaign", entityId: c.id });
}

// ───────────── Conversions ─────────────
const STATUS_AFTER_EVENT: Partial<Record<ProductEventType, string>> = { trial_started: "trial", demo: "demo", payment_confirmed: "customer", cancellation: "lost" };

export type RecordEventInput = {
  workspaceId: string; productId: string; prospectId?: string | null; type: string; occurredAt: Date; amount?: number | null; currency?: string | null;
  externalRef?: string | null; note?: string | null; source?: "manual" | "webhook"; actorId?: string | null;
};

export async function recordProductEvent(i: RecordEventInput): Promise<{ created: boolean; id: string }> {
  if (!(EVENT_TYPES as readonly string[]).includes(i.type)) throw new PortfolioError("Type de conversion inconnu.");
  await assertProduct(i.workspaceId, i.productId);
  if (i.prospectId && !(await db.prospect.findFirst({ where: { id: i.prospectId, workspaceId: i.workspaceId }, select: { id: true } }))) throw new PortfolioError("Prospect introuvable.");
  if (i.type === "payment_confirmed" && !(i.amount && i.amount > 0)) throw new PortfolioError("Un paiement confirmé exige un montant positif.");
  if (i.type === "payment_confirmed" && !i.currency) throw new PortfolioError("Un paiement confirmé exige une devise.");
  if (!i.prospectId && !i.externalRef?.trim()) throw new PortfolioError("Indiquez le prospect concerné ou une référence externe (traçabilité de la source).");
  const key = eventDedupeKey({ productId: i.productId, type: i.type, prospectId: i.prospectId, externalRef: i.externalRef, occurredAt: i.occurredAt, amount: i.amount });
  try {
    const ev = await db.productEvent.create({
      data: {
        workspaceId: i.workspaceId, productId: i.productId, prospectId: i.prospectId ?? null, type: i.type, occurredAt: i.occurredAt, amount: i.amount ?? null,
        currency: i.currency?.toUpperCase().slice(0, 3) ?? null, source: i.source ?? "manual", externalRef: i.externalRef?.trim() || null, dedupeKey: key, note: i.note?.slice(0, 500) ?? null, recordedById: i.actorId ?? null,
      },
    });
    const next = STATUS_AFTER_EVENT[i.type as ProductEventType];
    if (i.prospectId && next) await db.prospect.updateMany({ where: { id: i.prospectId, workspaceId: i.workspaceId }, data: { status: next, campaignId: null } });
    await audit({ workspaceId: i.workspaceId, userId: i.actorId, action: "product_event.recorded", entity: "ProductEvent", entityId: ev.id, meta: { productId: i.productId, type: i.type, source: i.source ?? "manual" } });
    return { created: true, id: ev.id };
  } catch (e) {
    if (!isUnique(e)) throw e;
    const ex = await db.productEvent.findUnique({ where: { workspaceId_dedupeKey: { workspaceId: i.workspaceId, dedupeKey: key } }, select: { id: true } });
    return { created: false, id: ex?.id ?? "" };
  }
}

// ───────────── Indicateurs ─────────────
export type ProductStats = {
  productId: string;
  prospects: Record<string, number>;
  prospectsTotal: number;
  inboundLeads: number;
  events: Record<string, number>;
  revenue: { currency: string; amount: number }[];
  activeCampaigns: number;
  approvedTemplates: number;
};

export async function portfolioStats(workspaceId: string, since?: Date): Promise<ProductStats[]> {
  const products = await db.product.findMany({ where: { workspaceId, deletedAt: null }, select: { id: true } });
  const evWhere: Prisma.ProductEventWhereInput = { workspaceId, ...(since ? { occurredAt: { gte: since } } : {}) };
  const [pros, leads, evs, pays, camps, tpls] = await Promise.all([
    db.prospect.groupBy({ by: ["productId", "status"], where: { workspaceId, deletedAt: null, productId: { not: null } }, _count: { _all: true } }),
    db.lead.groupBy({ by: ["productId"], where: { workspaceId, deletedAt: null, productId: { not: null } }, _count: { _all: true } }),
    db.productEvent.groupBy({ by: ["productId", "type"], where: evWhere, _count: { _all: true } }),
    db.productEvent.groupBy({ by: ["productId", "currency"], where: { ...evWhere, type: "payment_confirmed" }, _sum: { amount: true } }),
    db.outreachCampaign.groupBy({ by: ["productId"], where: { workspaceId, status: "active" }, _count: { _all: true } }),
    db.messageTemplate.groupBy({ by: ["productId"], where: { workspaceId, status: "approved" }, _count: { _all: true } }),
  ]);
  return products.map(({ id }) => {
    const prospects: Record<string, number> = {};
    for (const r of pros) if (r.productId === id) prospects[r.status] = r._count._all;
    const events: Record<string, number> = {};
    for (const r of evs) if (r.productId === id) events[r.type] = r._count._all;
    return {
      productId: id, prospects, prospectsTotal: Object.values(prospects).reduce((a, b) => a + b, 0),
      inboundLeads: leads.find((l) => l.productId === id)?._count._all ?? 0, events,
      revenue: pays.filter((r) => r.productId === id && r._sum.amount).map((r) => ({ currency: r.currency ?? "?", amount: r._sum.amount ?? 0 })),
      activeCampaigns: camps.find((c) => c.productId === id)?._count._all ?? 0,
      approvedTemplates: tpls.find((t) => t.productId === id)?._count._all ?? 0,
    };
  });
}
