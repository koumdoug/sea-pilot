"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { run, parse, formObject, optStr, UserError, type ActionState } from "@/lib/action";
import {
  addProspect, approveOutreachCampaign, attachProspectToCampaign, ensureDefaultProducts, importProspects, logContact, logReply, optOutProspect,
  PortfolioError, productSlugFor, recordProductEvent, reassignProspect,
} from "@/lib/portfolio/service";
import { dedupeKeyOf, EVENT_TYPES, LEGAL_BASES, OUTREACH_CHANNELS, PRODUCT_STATUSES, parseProspectCsv } from "@/lib/portfolio/rules";

/** Les erreurs métier du portefeuille deviennent des messages utilisateur. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PortfolioError) throw new UserError(e.message);
    throw e;
  }
}

const lines = (s?: string, max = 20, len = 300) => (s ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, max).map((x) => x.slice(0, len));
const date = (s?: string) => (s ? new Date(`${s.length === 10 ? s + "T12:00:00Z" : s}`) : new Date());
const refresh = () => { revalidatePath("/portfolio"); revalidatePath("/prospects"); revalidatePath("/products"); };

// ───────────── Catalogue ─────────────
export async function initCatalogAction(): Promise<ActionState> {
  return run({ action: "manage_products" }, async (ctx) => {
    const r = await ensureDefaultProducts(ctx.workspaceId, ctx.user.id);
    refresh();
    return { ok: true, message: r.created.length ? `${r.created.length} fiche(s) créée(s) en préparation : vérifiez les points à confirmer.` : "Les fiches existent déjà : aucune modification." };
  });
}

const productSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(2, "Nom requis").max(120),
  tagline: optStr(240), description: optStr(2000), valueProposition: optStr(1000), targetCustomers: optStr(1000),
  problemsSolved: z.string().max(3000).optional(), unconfirmed: z.string().max(3000).optional(),
  publicUrl: z.union([z.literal(""), z.string().trim().url("URL invalide").max(300)]).optional(),
  signupUrl: z.union([z.literal(""), z.string().trim().url("URL invalide").max(300)]).optional(),
  demoUrl: z.union([z.literal(""), z.string().trim().url("URL invalide").max(300)]).optional(),
  status: z.enum(PRODUCT_STATUSES).default("preparation"),
  confirmReady: z.string().optional(),
});

export async function saveProductAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let newId: string | undefined;
  const r = await run({ action: "manage_products" }, async (ctx) => {
    const d = parse(productSchema, formObject(fd));
    const unconfirmed = lines(d.unconfirmed);
    const data = {
      name: d.name, tagline: d.tagline ?? null, description: d.description ?? null, valueProposition: d.valueProposition ?? null, targetCustomers: d.targetCustomers ?? null,
      problemsSolved: lines(d.problemsSolved) as Prisma.InputJsonValue, unconfirmed: unconfirmed as Prisma.InputJsonValue,
      publicUrl: d.publicUrl || null, signupUrl: d.signupUrl || null, demoUrl: d.demoUrl || null, status: d.status,
    };
    if (d.id) {
      const cur = await db.product.findFirst({ where: { id: d.id, workspaceId: ctx.workspaceId, deletedAt: null } });
      if (!cur) throw new UserError("Produit introuvable.");
      if (d.status === "commercialisation" && cur.status !== "commercialisation" && d.confirmReady !== "on")
        throw new UserError("Pour passer en commercialisation, confirmez que les points « à confirmer » ont été vérifiés.");
      await db.product.update({ where: { id: cur.id }, data });
      if (cur.status !== d.status) await audit({ workspaceId: ctx.workspaceId, userId: ctx.user.id, action: "product.status_changed", entity: "Product", entityId: cur.id, meta: { from: cur.status, to: d.status } });
      else await audit({ workspaceId: ctx.workspaceId, userId: ctx.user.id, action: "product.updated", entity: "Product", entityId: cur.id });
      refresh();
      return { ok: true, message: "Fiche produit enregistrée." };
    }
    if (d.status === "commercialisation") throw new UserError("Un nouveau produit démarre en préparation.");
    const p = await db.product.create({ data: { ...data, workspaceId: ctx.workspaceId, slug: await productSlugFor(ctx.workspaceId, d.name), status: "preparation" } });
    newId = p.id;
    await audit({ workspaceId: ctx.workspaceId, userId: ctx.user.id, action: "product.created", entity: "Product", entityId: p.id });
    return { ok: true, id: p.id };
  });
  if (r.ok && newId) redirect(`/products/${newId}`);
  return r;
}

export async function suspendProductAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "manage_products" }, async (ctx) => {
    const { id, to } = parse(z.object({ id: z.string(), to: z.enum(["suspended", "preparation"]) }), formObject(fd));
    const u = await db.product.updateMany({ where: { id, workspaceId: ctx.workspaceId, deletedAt: null }, data: { status: to } });
    if (!u.count) throw new UserError("Produit introuvable.");
    if (to === "suspended") {
      // Suspendre un produit met en pause ses campagnes actives : aucune action commerciale ne continue.
      await db.outreachCampaign.updateMany({ where: { workspaceId: ctx.workspaceId, productId: id, status: "active" }, data: { status: "paused" } });
    }
    await audit({ workspaceId: ctx.workspaceId, userId: ctx.user.id, action: "product.status_changed", entity: "Product", entityId: id, meta: { to } });
    refresh();
  });
}

// ───────────── Canaux ─────────────
export async function saveChannelAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "manage_products" }, async (ctx) => {
    const d = parse(z.object({
      channel: z.enum(OUTREACH_CHANNELS), enabled: z.string().optional(),
      minDays: z.coerce.number().int().min(1).max(90).default(7), maxContacts: z.coerce.number().int().min(1).max(10).default(3),
    }), formObject(fd));
    const enabled = d.enabled === "on";
    await db.outreachChannel.upsert({
      where: { workspaceId_channel: { workspaceId: ctx.workspaceId, channel: d.channel } },
      create: { workspaceId: ctx.workspaceId, channel: d.channel, enabled, minDaysBetweenContacts: d.minDays, maxContactsPerProspect: d.maxContacts, updatedById: ctx.user.id },
      update: { enabled, minDaysBetweenContacts: d.minDays, maxContactsPerProspect: d.maxContacts, updatedById: ctx.user.id },
    });
    await audit({ workspaceId: ctx.workspaceId, userId: ctx.user.id, action: "outreach.channel_updated", entity: "OutreachChannel", meta: { channel: d.channel, enabled } });
    refresh();
    return { ok: true, message: enabled ? "Canal activé. Rien n'est envoyé automatiquement : les contacts restent consignés par vous." : "Canal désactivé." };
  });
}

// ───────────── Modèles de messages ─────────────
export async function saveTemplateAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const d = parse(z.object({
      id: z.string().optional(), productId: z.string().min(1, "Produit requis"), name: z.string().trim().min(2, "Nom requis").max(120),
      channel: z.enum(OUTREACH_CHANNELS), subject: optStr(200), body: z.string().trim().min(10, "Message trop court").max(4000),
    }), formObject(fd));
    if (!(await db.product.findFirst({ where: { id: d.productId, workspaceId: ctx.workspaceId, deletedAt: null }, select: { id: true } }))) throw new UserError("Produit introuvable.");
    if (d.id) {
      // Toute modification d'un modèle approuvé le repasse en brouillon : il doit être ré-approuvé.
      const u = await db.messageTemplate.updateMany({ where: { id: d.id, workspaceId: ctx.workspaceId }, data: { name: d.name, channel: d.channel, subject: d.subject ?? null, body: d.body, status: "draft", approvedById: null, approvedAt: null } });
      if (!u.count) throw new UserError("Modèle introuvable.");
    } else {
      await db.messageTemplate.create({ data: { workspaceId: ctx.workspaceId, productId: d.productId, name: d.name, channel: d.channel, subject: d.subject ?? null, body: d.body, createdById: ctx.user.id } });
    }
    refresh();
    return { ok: true, message: "Modèle enregistré en brouillon : il doit être approuvé avant usage." };
  });
}

export async function templateStatusAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: fd.get("to") === "approved" ? "approve_outreach" : "write" }, async (ctx) => {
    const { id, to } = parse(z.object({ id: z.string(), to: z.enum(["approved", "archived", "draft"]) }), formObject(fd));
    const u = await db.messageTemplate.updateMany({
      where: { id, workspaceId: ctx.workspaceId },
      data: to === "approved" ? { status: "approved", approvedById: ctx.user.id, approvedAt: new Date() } : { status: to, approvedById: null, approvedAt: null },
    });
    if (!u.count) throw new UserError("Modèle introuvable.");
    await audit({ workspaceId: ctx.workspaceId, userId: ctx.user.id, action: `outreach.template_${to}`, entity: "MessageTemplate", entityId: id });
    refresh();
  });
}

// ───────────── Campagnes de prospection ─────────────
export async function createOutreachCampaignAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const d = parse(z.object({ productId: z.string().min(1), name: z.string().trim().min(2, "Nom requis").max(120), channel: z.enum(OUTREACH_CHANNELS), templateId: optStr(60), segment: optStr(120) }), formObject(fd));
    if (!(await db.product.findFirst({ where: { id: d.productId, workspaceId: ctx.workspaceId, deletedAt: null }, select: { id: true } }))) throw new UserError("Produit introuvable.");
    if (d.templateId && !(await db.messageTemplate.findFirst({ where: { id: d.templateId, workspaceId: ctx.workspaceId, productId: d.productId, channel: d.channel }, select: { id: true } }))) throw new UserError("Modèle incompatible avec ce produit ou ce canal.");
    const c = await db.outreachCampaign.create({ data: { workspaceId: ctx.workspaceId, productId: d.productId, name: d.name, channel: d.channel, templateId: d.templateId ?? null, segment: d.segment ?? null, requestedById: ctx.user.id } });
    await audit({ workspaceId: ctx.workspaceId, userId: ctx.user.id, action: "outreach.campaign_created", entity: "OutreachCampaign", entityId: c.id });
    refresh();
    return { ok: true, message: "Campagne créée en brouillon (désactivée)." };
  });
}

export async function campaignTransitionAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: fd.get("to") === "active" ? "approve_outreach" : "write" }, async (ctx) => {
    const { id, to } = parse(z.object({ id: z.string(), to: z.enum(["pending_approval", "active", "paused", "completed", "draft"]) }), formObject(fd));
    await guard(async () => {
      if (to === "active") return approveOutreachCampaign({ workspaceId: ctx.workspaceId, campaignId: id, actorId: ctx.user.id });
      const c = await db.outreachCampaign.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
      if (!c) throw new PortfolioError("Campagne introuvable.");
      const allowed: Record<string, string[]> = { draft: ["pending_approval"], pending_approval: ["draft"], active: ["paused", "completed"], paused: ["pending_approval", "completed"], completed: [] };
      if (c.status === to) return;
      if (!(allowed[c.status] ?? []).includes(to)) throw new PortfolioError("Transition de statut non autorisée.");
      await db.outreachCampaign.update({ where: { id }, data: { status: to, ...(to === "pending_approval" ? { requestedById: ctx.user.id } : {}) } });
      await audit({ workspaceId: ctx.workspaceId, userId: ctx.user.id, action: `outreach.campaign_${to}`, entity: "OutreachCampaign", entityId: id });
    });
    refresh();
  });
}

export async function attachToCampaignAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const d = parse(z.object({ prospectId: z.string(), campaignId: z.string().min(1, "Choisissez une campagne") }), formObject(fd));
    await guard(() => attachProspectToCampaign({ workspaceId: ctx.workspaceId, campaignId: d.campaignId, prospectId: d.prospectId, actorId: ctx.user.id }));
    refresh();
    return { ok: true, message: "Prospect ajouté à la campagne." };
  });
}

// ───────────── Prospects ─────────────
const prospectSchema = z.object({
  name: z.string().trim().min(2, "Nom requis").max(120), company: optStr(160), jobTitle: optStr(120),
  email: z.union([z.literal(""), z.string().trim().email("Courriel invalide").max(200)]).optional(), phone: optStr(40), website: optStr(200),
  audienceType: z.enum(["b2b", "b2c"]).default("b2b"), segment: optStr(120),
  source: z.string().trim().min(2, "La provenance est obligatoire").max(160), sourceUrl: optStr(400),
  collectedAt: z.string().min(1, "Date de collecte requise"), legalBasis: z.enum(LEGAL_BASES).default("unknown"), legalBasisNote: optStr(400),
  productId: z.string().min(1, "Produit requis"), notes: optStr(1000),
});

export async function addProspectAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const d = parse(prospectSchema, formObject(fd));
    const when = date(d.collectedAt);
    if (Number.isNaN(when.getTime()) || when.getTime() > Date.now() + 86_400_000) throw new UserError("Date de collecte invalide.");
    const r = await guard(() => addProspect(ctx.workspaceId, { ...d, email: d.email || null, collectedAt: when }, ctx.user.id));
    refresh();
    if (r.kind === "created") return { ok: true, id: r.prospect.id, message: r.prospect.status === "do_not_contact" ? "Prospect enregistré, mais cette adresse est déjà désinscrite : « ne pas contacter »." : "Prospect enregistré." };
    return { ok: true, id: r.prospect.id, message: r.interestAdded ? "Cette personne existe déjà : intérêt pour ce produit ajouté, sans doublon ni changement d'attribution." : "Cette personne existe déjà : aucun doublon créé." };
  });
}

export async function importProspectsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const d = parse(z.object({ defaultProductId: optStr(60), dryRun: z.string().optional(), confirmLawful: z.string().optional() }), formObject(fd));
    const file = fd.get("file");
    if (!(file instanceof File) || file.size === 0) throw new UserError("Choisissez un fichier CSV.");
    if (file.size > 1_000_000) throw new UserError("Fichier trop volumineux (1 Mo maximum).");
    const dry = d.dryRun === "on";
    if (!dry && d.confirmLawful !== "on") throw new UserError("Confirmez que ces données ont été collectées de façon licite, avec leur provenance.");
    const { rows, errors } = parseProspectCsv(await file.text());
    if (!rows.length && errors.length) return { error: `Import impossible : ${errors.slice(0, 5).map((e) => `ligne ${e.line} — ${e.message}`).join(" ; ")}` };
    if (dry) {
      const keys = rows.map((r) => dedupeKeyOf({ email: r.email, phone: r.phone, company: r.company, name: r.name }));
      const dup = await db.prospect.count({ where: { workspaceId: ctx.workspaceId, dedupeKey: { in: keys } } });
      return { ok: true, message: `Vérification : ${rows.length} ligne(s) valide(s), ${dup} déjà connue(s) (doublons), ${errors.length} rejetée(s)${errors.length ? ` — ${errors.slice(0, 5).map((e) => `ligne ${e.line} : ${e.message}`).join(" ; ")}` : ""}. Rien n'a été enregistré.` };
    }
    const sum = await guard(() => importProspects(ctx.workspaceId, rows, { defaultProductId: d.defaultProductId, batch: `csv-${new Date().toISOString().slice(0, 19)}`, actorId: ctx.user.id }));
    refresh();
    const rejected = [...errors, ...sum.rejected];
    return { ok: true, message: `Import terminé : ${sum.created} créé(s), ${sum.duplicates} doublon(s) ignoré(s) dont ${sum.interestsAdded} intérêt(s) multi-produits, ${rejected.length} rejeté(s)${rejected.length ? ` — ${rejected.slice(0, 5).map((e) => `ligne ${e.line} : ${e.message}`).join(" ; ")}` : ""}.` };
  });
}

export async function logContactAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const d = parse(z.object({
      prospectId: z.string(), productId: z.string(), channel: z.enum(OUTREACH_CHANNELS), templateId: optStr(60), subject: optStr(200), summary: optStr(2000),
      outcome: z.enum(["", "no_reply", "replied", "interested", "not_interested", "demo_booked", "opted_out"]).optional(), nextFollowUp: optStr(10),
    }), formObject(fd));
    const r = await guard(() => logContact({
      workspaceId: ctx.workspaceId, prospectId: d.prospectId, productId: d.productId, channel: d.channel, templateId: d.templateId ?? null, subject: d.subject, summary: d.summary,
      outcome: d.outcome || null, actorId: ctx.user.id, nextFollowUpAt: d.nextFollowUp ? date(d.nextFollowUp) : null,
    }));
    refresh();
    if (!r.eligibility.ok) return { error: `Contact non autorisé : ${r.eligibility.reasons.join(" ")}` };
    return { ok: true, message: "Contact consigné. SEA Pilot n'envoie rien : le message est à envoyer par vous." };
  });
}

export async function logReplyAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const d = parse(z.object({ prospectId: z.string(), channel: z.enum(OUTREACH_CHANNELS), summary: optStr(2000), optOut: z.string().optional() }), formObject(fd));
    await guard(() => logReply({ workspaceId: ctx.workspaceId, prospectId: d.prospectId, channel: d.channel, summary: d.summary, actorId: ctx.user.id, optOut: d.optOut === "on" }));
    refresh();
    return { ok: true, message: d.optOut === "on" ? "Opposition enregistrée : plus aucun contact, tous produits confondus." : "Réponse consignée." };
  });
}

export async function optOutAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const { prospectId } = parse(z.object({ prospectId: z.string() }), formObject(fd));
    await guard(() => optOutProspect({ workspaceId: ctx.workspaceId, prospectId, actorId: ctx.user.id, reason: "saisie manuelle" }));
    refresh();
    return { ok: true, message: "Prospect marqué « ne pas contacter »." };
  });
}

export async function reassignAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const d = parse(z.object({ prospectId: z.string(), toProductId: z.string().min(1, "Choisissez le produit"), reason: z.string().trim().min(5, "Motif requis (5 caractères minimum)").max(300) }), formObject(fd));
    await guard(() => reassignProspect({ workspaceId: ctx.workspaceId, prospectId: d.prospectId, toProductId: d.toProductId, reason: d.reason, actorId: ctx.user.id }));
    refresh();
    return { ok: true, message: "Prospect réattribué (motif consigné au journal)." };
  });
}

// ───────────── Conversions (saisie manuelle) ─────────────
export async function recordEventAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const d = parse(z.object({
      productId: z.string().min(1, "Produit requis"), prospectId: optStr(60), type: z.enum(EVENT_TYPES), occurredAt: z.string().min(1, "Date requise"),
      amount: optStr(20), currency: optStr(3), externalRef: optStr(120), note: optStr(500),
    }), formObject(fd));
    const when = date(d.occurredAt);
    if (Number.isNaN(when.getTime())) throw new UserError("Date invalide.");
    const amount = d.amount ? Number(d.amount.replace(",", ".")) : null;
    if (d.amount && !Number.isFinite(amount)) throw new UserError("Montant invalide.");
    const r = await guard(() => recordProductEvent({
      workspaceId: ctx.workspaceId, productId: d.productId, prospectId: d.prospectId ?? null, type: d.type, occurredAt: when, amount, currency: d.currency ?? null,
      externalRef: d.externalRef ?? null, note: d.note ?? null, source: "manual", actorId: ctx.user.id,
    }));
    refresh();
    return { ok: true, message: r.created ? "Conversion enregistrée." : "Cette conversion est déjà enregistrée : aucun double comptage." };
  });
}
