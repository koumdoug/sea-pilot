"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { run, parse, formObject, optStr, UserError, type ActionState } from "@/lib/action";
import { DEFAULT_CONSENT, DEFAULT_FORM_FIELDS, defaultSections, formFieldsSchema, safeUrl, sectionsSchema } from "@/lib/landing";
import { slugify } from "@/lib/workspaces";
import { createWithinLimit } from "@/lib/quota";
import { PAGE_QUOTA_MESSAGE, createPageWithForms, pageWriteError } from "@/lib/landing-quota";

async function uniqueSlug(workspaceId: string, base: string, excludeId?: string) {
  let slug = slugify(base);
  for (let i = 2; ; i++) {
    const hit = await db.landingPage.findUnique({ where: { workspaceId_slug: { workspaceId, slug } }, select: { id: true } });
    if (!hit || hit.id === excludeId) return slug;
    slug = `${slugify(base)}-${i}`;
  }
}

export async function createPageAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let id: string | undefined;
  const r = await run({ action: "write" }, async (ctx) => {
    const d = parse(z.object({ name: z.string().trim().min(2, "Nom requis").max(120), offerId: optStr(60) }), formObject(fd));
    const offer = d.offerId ? await db.offer.findFirst({ where: { id: d.offerId, workspaceId: ctx.workspaceId } }) : null;
    if (d.offerId && !offer) throw new UserError("Offre introuvable.");
    const adv = Array.isArray(offer?.advantages) ? (offer!.advantages as string[]) : [];
    const sections = defaultSections({ name: offer?.name ?? d.name, headline: offer?.name ?? d.name, benefits: adv });
    // Plafond compté et page + formulaire créés dans une seule transaction verrouillée (aucune page orpheline).
    const page = await createPageWithForms({
      workspaceId: ctx.workspaceId, plan: ctx.ent.plan,
      page: { workspaceId: ctx.workspaceId, name: d.name, slug: await uniqueSlug(ctx.workspaceId, d.name), sections: sections as unknown as Prisma.InputJsonValue, offerId: offer?.id, seoTitle: d.name.slice(0, 60), seoDescription: offer?.description?.slice(0, 155) ?? undefined },
      forms: [{ name: "Formulaire principal", fields: DEFAULT_FORM_FIELDS as unknown as Prisma.InputJsonValue, consentText: DEFAULT_CONSENT }],
    });
    await audit({ workspaceId: ctx.workspaceId, userId: ctx.user.id, action: "landing.created", entity: "LandingPage", entityId: page.id });
    id = page.id;
  });
  if (r.ok && id) redirect(`/landing-pages/${id}`);
  return r;
}

const saveSchema = z.object({
  id: z.string(),
  name: z.string().trim().min(2, "Nom requis").max(120),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Lettres minuscules, chiffres et tirets uniquement").max(60),
  seoTitle: optStr(70), seoDescription: optStr(170), ogImage: safeUrl.optional(), canonicalUrl: safeUrl.optional(),
  campaignId: optStr(60), offerId: optStr(60), primary: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Couleur invalide").default("#2563eb"),
  sections: z.string(), formFields: z.string(),
  consentText: z.string().trim().min(5, "Texte de consentement requis").max(500), successMessage: z.string().trim().min(2).max(300), redirectUrl: safeUrl.optional(), formActive: z.string().optional(),
});

function json(s: string, what: string) { try { return JSON.parse(s); } catch { throw new UserError(`${what} : données invalides.`); } }

export async function savePageAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const d = parse(saveSchema, formObject(fd));
    const page = await db.landingPage.findFirst({ where: { id: d.id, workspaceId: ctx.workspaceId } });
    if (!page) throw new UserError("Page introuvable.");
    const sections = parse(sectionsSchema, json(d.sections, "Sections"));
    const fieldsParsed = formFieldsSchema.safeParse(json(d.formFields, "Formulaire"));
    if (!fieldsParsed.success) throw new UserError(fieldsParsed.error.issues[0]?.message ?? "Formulaire invalide.");
    const clash = await db.landingPage.findUnique({ where: { workspaceId_slug: { workspaceId: ctx.workspaceId, slug: d.slug } }, select: { id: true } });
    if (clash && clash.id !== page.id) throw new UserError("Cette adresse (slug) est déjà utilisée.");
    if (d.redirectUrl && !/^https?:\/\//i.test(d.redirectUrl)) throw new UserError("La redirection doit être une URL http(s) complète.");
    if (d.campaignId && !(await db.campaign.findFirst({ where: { id: d.campaignId, workspaceId: ctx.workspaceId }, select: { id: true } }))) throw new UserError("Campagne introuvable.");
    if (d.offerId && !(await db.offer.findFirst({ where: { id: d.offerId, workspaceId: ctx.workspaceId }, select: { id: true } }))) throw new UserError("Offre introuvable.");

    await db.$transaction(async (tx) => {
      await tx.landingPage.update({
        where: { id: page.id },
        data: { name: d.name, slug: d.slug, seoTitle: d.seoTitle ?? null, seoDescription: d.seoDescription ?? null, ogImage: d.ogImage || null, canonicalUrl: d.canonicalUrl || null, campaignId: d.campaignId ?? null, offerId: d.offerId ?? null, theme: { primary: d.primary }, sections: sections as unknown as Prisma.InputJsonValue },
      });
      const formData = { fields: fieldsParsed.data as unknown as Prisma.InputJsonValue, consentText: d.consentText, successMessage: d.successMessage, redirectUrl: d.redirectUrl || null, active: d.formActive === "on" };
      const f = await tx.form.findFirst({ where: { landingPageId: page.id, workspaceId: ctx.workspaceId }, orderBy: { createdAt: "asc" } });
      if (f) await tx.form.update({ where: { id: f.id }, data: formData });
      else await tx.form.create({ data: { ...formData, workspaceId: ctx.workspaceId, landingPageId: page.id, name: "Formulaire principal" } });
    });
    await audit({ workspaceId: ctx.workspaceId, userId: ctx.user.id, action: "landing.updated", entity: "LandingPage", entityId: page.id });
    revalidatePath("/landing-pages"); revalidatePath(`/landing-pages/${page.id}`);
    return { ok: true, message: "Page enregistrée." };
  });
}

export async function publishPageAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const { id, to } = parse(z.object({ id: z.string(), to: z.enum(["published", "draft", "archived"]) }), formObject(fd));
    const page = await db.landingPage.findFirst({ where: { id, workspaceId: ctx.workspaceId }, include: { forms: { where: { active: true } } } });
    if (!page) throw new UserError("Page introuvable.");
    if (to === "published") {
      const problems: string[] = [];
      const sections = sectionsSchema.safeParse(page.sections);
      const hero = sections.success ? sections.data.find((s) => s.type === "hero") : null;
      if (!hero || hero.type !== "hero" || !hero.headline.trim()) problems.push("un titre (section Hero)");
      if (!page.seoTitle?.trim()) problems.push("un title SEO");
      if (!page.seoDescription?.trim()) problems.push("une meta description");
      if (!page.forms.length) problems.push("un formulaire actif");
      if (problems.length) throw new UserError(`Publication impossible : il manque ${problems.join(", ")}.`);
    }
    const change = (client: Pick<typeof db, "landingPage">) => client.landingPage.update({ where: { id }, data: { status: to, publishedAt: to === "published" ? page.publishedAt ?? new Date() : page.publishedAt } });
    // Sortir une page de l'archive la recompte dans le forfait (publication OU retour en brouillon) : plafond compté et statut écrit dans la même transaction verrouillée.
    if (page.status === "archived" && to !== "archived") {
      try { await createWithinLimit({ workspaceId: ctx.workspaceId, plan: ctx.ent.plan, key: "landingPages", message: PAGE_QUOTA_MESSAGE, create: (tx) => change(tx) }); } catch (e) { pageWriteError(e); }
    } else await change(db);
    await audit({ workspaceId: ctx.workspaceId, userId: ctx.user.id, action: `landing.${to}`, entity: "LandingPage", entityId: id });
    revalidatePath("/landing-pages"); revalidatePath(`/landing-pages/${id}`);
    return { ok: true, message: to === "published" ? "Page publiée." : to === "draft" ? "Page dépubliée (brouillon)." : "Page archivée." };
  });
}

export async function duplicatePageAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let id: string | undefined;
  const r = await run({ action: "write" }, async (ctx) => {
    const { id: src } = parse(z.object({ id: z.string() }), formObject(fd));
    const p = await db.landingPage.findFirst({ where: { id: src, workspaceId: ctx.workspaceId }, include: { forms: true } });
    if (!p) throw new UserError("Page introuvable.");
    const copy = await createPageWithForms({
      workspaceId: ctx.workspaceId, plan: ctx.ent.plan,
      page: { workspaceId: ctx.workspaceId, name: `${p.name} (copie)`, slug: await uniqueSlug(ctx.workspaceId, `${p.slug}-copie`), status: "draft", sections: p.sections as Prisma.InputJsonValue, theme: (p.theme ?? undefined) as Prisma.InputJsonValue | undefined, seoTitle: p.seoTitle, seoDescription: p.seoDescription, ogImage: p.ogImage, campaignId: p.campaignId, offerId: p.offerId },
      forms: p.forms.map((f) => ({ name: f.name, fields: f.fields as Prisma.InputJsonValue, consentText: f.consentText, successMessage: f.successMessage, redirectUrl: f.redirectUrl, active: f.active })),
    });
    id = copy.id;
  });
  if (r.ok && id) redirect(`/landing-pages/${id}`);
  return r;
}

export async function deletePageAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let done = false;
  const r = await run({ action: "delete" }, async (ctx) => {
    const { id } = parse(z.object({ id: z.string() }), formObject(fd));
    const p = await db.landingPage.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!p) throw new UserError("Page introuvable.");
    const leads = await db.lead.count({ where: { landingPageId: id, workspaceId: ctx.workspaceId } });
    if (p.status === "published" || leads > 0) throw new UserError("Une page publiée ou ayant reçu des leads ne peut pas être supprimée : archivez-la.");
    await db.landingPage.delete({ where: { id } });
    done = true;
  });
  if (done) redirect("/landing-pages");
  return r;
}
