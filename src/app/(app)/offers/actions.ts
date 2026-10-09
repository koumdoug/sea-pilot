"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { run, parse, formObject, optNum, optStr, UserError, type ActionState } from "@/lib/action";
import { generate } from "@/lib/ai/service";
import { baseSystem, offerPrompt, offerSchema } from "@/lib/ai/prompts";
import { briefOf } from "@/lib/ai/brief";
import { defaultSections, sid } from "@/lib/landing";
import { slugify } from "@/lib/workspaces";
import { DEFAULT_CONSENT, DEFAULT_FORM_FIELDS } from "@/lib/landing";
import { limitReached } from "@/lib/plans";
import { CURRENCIES } from "@/lib/constants";
import { workspaceUsage } from "@/lib/billing";

const offerSchemaIn = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(2, "Nom requis").max(160),
  description: optStr(2000),
  problem: optStr(1000),
  price: optNum,
  marginPct: optNum.refine((v) => v === undefined || v <= 100, "Entre 0 et 100"),
  currency: z.enum(CURRENCIES).default("EUR"),
  geoZone: optStr(200),
  advantages: z.string().trim().max(2000).optional(),
  differentiation: optStr(800),
  audienceId: optStr(60),
});

export async function saveOfferAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let newId: string | undefined;
  const r = await run({ action: "write" }, async (ctx) => {
    const d = parse(offerSchemaIn, formObject(fd));
    if (d.audienceId && !(await db.audience.findFirst({ where: { id: d.audienceId, workspaceId: ctx.workspaceId }, select: { id: true } }))) throw new UserError("Audience introuvable.");
    const data = {
      name: d.name, description: d.description ?? null, problem: d.problem ?? null, price: d.price ?? null, marginPct: d.marginPct ?? null, currency: d.currency, geoZone: d.geoZone ?? null,
      advantages: (d.advantages ?? "").split(/\r?\n|;/).map((s) => s.trim()).filter(Boolean).slice(0, 12), differentiation: d.differentiation ?? null, audienceId: d.audienceId ?? null,
    };
    if (d.id) {
      const u = await db.offer.updateMany({ where: { id: d.id, workspaceId: ctx.workspaceId }, data });
      if (!u.count) throw new UserError("Offre introuvable.");
      await audit({ workspaceId: ctx.workspaceId, userId: ctx.user.id, action: "offer.updated", entity: "Offer", entityId: d.id });
      revalidatePath("/offers");
      return { ok: true, message: "Offre enregistrée." };
    }
    const o = await db.offer.create({ data: { ...data, workspaceId: ctx.workspaceId, status: "draft" } });
    newId = o.id;
    await audit({ workspaceId: ctx.workspaceId, userId: ctx.user.id, action: "offer.created", entity: "Offer", entityId: o.id });
    return { ok: true, id: o.id };
  });
  if (r.ok && newId) redirect(`/offers/${newId}`);
  return r;
}

export async function setOfferStatusAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const { id, status } = parse(z.object({ id: z.string(), status: z.enum(["draft", "active", "archived"]) }), formObject(fd));
    const u = await db.offer.updateMany({ where: { id, workspaceId: ctx.workspaceId }, data: { status } });
    if (!u.count) throw new UserError("Offre introuvable.");
    revalidatePath("/offers");
  });
}

export async function deleteOfferAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let done = false;
  const r = await run({ action: "delete" }, async (ctx) => {
    const { id } = parse(z.object({ id: z.string() }), formObject(fd));
    const used = await db.campaign.count({ where: { workspaceId: ctx.workspaceId, offerId: id } });
    if (used) throw new UserError("Cette offre est utilisée par des campagnes : archivez-la plutôt.");
    const d = await db.offer.deleteMany({ where: { id, workspaceId: ctx.workspaceId } });
    if (!d.count) throw new UserError("Offre introuvable.");
    await audit({ workspaceId: ctx.workspaceId, userId: ctx.user.id, action: "offer.deleted", entity: "Offer", entityId: id });
    done = true;
  });
  if (done) redirect("/offers");
  return r;
}

export async function generateOfferVariantsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "ai" }, async (ctx) => {
    const { id, count } = parse(z.object({ id: z.string(), count: z.coerce.number().int().min(1).max(5).default(3) }), formObject(fd));
    const offer = await db.offer.findFirst({ where: { id, workspaceId: ctx.workspaceId }, include: { audience: true } });
    if (!offer) throw new UserError("Offre introuvable.");
    const r = await generate({
      workspaceId: ctx.workspaceId, userId: ctx.user.id, kind: "offer", temperature: 0.8,
      system: baseSystem(briefOf(ctx.workspace), "expert en conception d'offres commerciales"),
      prompt: offerPrompt({ product: offer.name, target: offer.audience ? `${offer.audience.name} (${offer.audience.type})` : undefined, problem: offer.problem ?? undefined, price: offer.price, currency: offer.currency, advantages: Array.isArray(offer.advantages) ? (offer.advantages as string[]) : [], differentiation: offer.differentiation ?? undefined, variants: count }),
      schema: offerSchema, input: { offerId: offer.id, count },
    });
    const existing = Array.isArray(offer.variants) ? (offer.variants as unknown[]) : [];
    const stamped = r.data.variants.map((v) => ({ ...v, id: sid("v"), createdAt: new Date().toISOString(), source: "ai", provider: r.provider, model: r.model }));
    await db.offer.update({ where: { id: offer.id }, data: { variants: [...stamped, ...existing].slice(0, 20) as Prisma.InputJsonValue } });
    revalidatePath(`/offers/${offer.id}`);
    return { ok: true, message: `${stamped.length} variante(s) générée(s). Ce sont des propositions de l'IA : relisez-les avant de les utiliser.` };
  });
}

export async function deleteVariantAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const { id, variantId } = parse(z.object({ id: z.string(), variantId: z.string() }), formObject(fd));
    const offer = await db.offer.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!offer) throw new UserError("Offre introuvable.");
    const list = (Array.isArray(offer.variants) ? offer.variants : []) as { id: string }[];
    await db.offer.update({ where: { id }, data: { variants: list.filter((v) => v.id !== variantId) as Prisma.InputJsonValue } });
    revalidatePath(`/offers/${id}`);
  });
}

/** Crée une landing page (brouillon) + son formulaire à partir d'une variante d'offre. */
export async function createPageFromVariantAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let pageId: string | undefined;
  const r = await run({ action: "write" }, async (ctx) => {
    const { id, variantId } = parse(z.object({ id: z.string(), variantId: z.string() }), formObject(fd));
    const offer = await db.offer.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!offer) throw new UserError("Offre introuvable.");
    const v = ((Array.isArray(offer.variants) ? offer.variants : []) as { id: string; headline: string; subheadline: string; benefits: string[]; objections: { objection: string; answer: string }[]; valueProposition: string; cta: string }[]).find((x) => x.id === variantId);
    if (!v) throw new UserError("Variante introuvable.");
    const usage = await workspaceUsage(ctx.workspaceId);
    if (limitReached(ctx.ent.plan, "landingPages", usage.landingPages)) throw new UserError("Limite de landing pages atteinte pour votre plan.");
    const sections = defaultSections({ name: offer.name, headline: v.headline, subheadline: v.subheadline, benefits: v.benefits });
    for (const s of sections) {
      if (s.type === "solution") s.body = v.valueProposition;
      if (s.type === "cta") s.ctaLabel = v.cta.slice(0, 60);
      if (s.type === "faq") s.items = v.objections.slice(0, 8).map((o) => ({ q: o.objection.slice(0, 240), a: o.answer.slice(0, 800) }));
    }
    let slug = slugify(`${offer.name}-${variantId.slice(2, 6)}`);
    for (let i = 2; await db.landingPage.findUnique({ where: { workspaceId_slug: { workspaceId: ctx.workspaceId, slug } } }); i++) slug = `${slugify(offer.name)}-${i}`;
    const page = await db.landingPage.create({ data: { workspaceId: ctx.workspaceId, name: `${offer.name} — ${v.headline.slice(0, 40)}`, slug, sections: sections as unknown as Prisma.InputJsonValue, offerId: offer.id, seoTitle: v.headline.slice(0, 60), seoDescription: v.subheadline.slice(0, 155) } });
    await db.form.create({ data: { workspaceId: ctx.workspaceId, landingPageId: page.id, name: "Formulaire principal", fields: DEFAULT_FORM_FIELDS as unknown as Prisma.InputJsonValue, consentText: DEFAULT_CONSENT } });
    pageId = page.id;
  });
  if (r.ok && pageId) redirect(`/landing-pages/${pageId}`);
  return r;
}

const audienceSchema = z.object({
  id: z.string().optional(), name: z.string().trim().min(2, "Nom requis").max(120), type: z.enum(["b2b", "b2c"]), customerType: optStr(200), location: optStr(200), needs: optStr(800), problems: optStr(800), objections: optStr(800),
});

export async function saveAudienceAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const d = parse(audienceSchema, formObject(fd));
    const { id, ...rest } = d;
    if (id) {
      const u = await db.audience.updateMany({ where: { id, workspaceId: ctx.workspaceId }, data: rest });
      if (!u.count) throw new UserError("Audience introuvable.");
    } else await db.audience.create({ data: { ...rest, workspaceId: ctx.workspaceId } });
    revalidatePath("/offers");
    return { ok: true, message: "Audience enregistrée." };
  });
}

export async function deleteAudienceAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "delete" }, async (ctx) => {
    const { id } = parse(z.object({ id: z.string() }), formObject(fd));
    const used = await db.campaign.count({ where: { workspaceId: ctx.workspaceId, audienceId: id } });
    if (used) throw new UserError("Cette audience est utilisée par des campagnes.");
    await db.audience.deleteMany({ where: { id, workspaceId: ctx.workspaceId } });
    revalidatePath("/offers");
  });
}
