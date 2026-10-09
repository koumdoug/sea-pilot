"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { run, parse, formObject, optNum, optStr, UserError, type ActionState } from "@/lib/action";
import { CAMPAIGN_OBJECTIVES, PLATFORMS } from "@/lib/constants";
import { CampaignError, duplicateCampaign, transitionCampaign } from "@/lib/campaigns";
import { generate } from "@/lib/ai/service";
import { baseSystem, campaignPrompt, campaignSchema } from "@/lib/ai/prompts";
import { briefOf } from "@/lib/ai/brief";

const date = z.string().trim().optional().transform((v) => (v ? new Date(`${v}T00:00:00.000Z`) : undefined)).refine((d) => !d || !Number.isNaN(d.getTime()), "Date invalide");

export async function createCampaignAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let id: string | undefined;
  const r = await run({ action: "write" }, async (ctx) => {
    const d = parse(z.object({ name: z.string().trim().min(2, "Nom requis").max(120), objective: z.enum(CAMPAIGN_OBJECTIVES) }), formObject(fd));
    const [offer, audience] = await Promise.all([
      db.offer.findFirst({ where: { workspaceId: ctx.workspaceId, status: "active" }, orderBy: { createdAt: "asc" } }),
      db.audience.findFirst({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: "asc" } }),
    ]);
    const c = await db.campaign.create({ data: { workspaceId: ctx.workspaceId, name: d.name, objective: d.objective, offerId: offer?.id, audienceId: audience?.id, budget: ctx.workspace.adBudgetMonthly ?? undefined, builderStep: 2 } });
    await audit({ workspaceId: ctx.workspaceId, userId: ctx.user.id, action: "campaign.created", entity: "Campaign", entityId: c.id });
    id = c.id;
  });
  if (r.ok && id) redirect(`/campaigns/${id}/build?step=2`);
  return r;
}

const stepSchemas: Record<number, z.ZodType> = {
  1: z.object({ name: z.string().trim().min(2, "Nom requis").max(120), objective: z.enum(CAMPAIGN_OBJECTIVES) }),
  2: z.object({ audienceId: z.string().min(1, "Choisissez une audience") }),
  3: z.object({ offerId: z.string().min(1, "Choisissez une offre") }),
  5: z.object({ platform: z.enum(PLATFORMS) }),
  6: z.object({ budget: optNum.refine((v) => v !== undefined && v > 0, "Budget requis"), budgetType: z.enum(["daily", "monthly", "total"]), startDate: date, endDate: date }),
  7: z.object({ landingPageId: z.string().optional() }),
};

/** Enregistre une étape du Campaign Builder, côté serveur, avec contrôle d'appartenance de chaque référence. */
export async function saveCampaignStepAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let next: string | undefined;
  const r = await run({ action: "write" }, async (ctx) => {
    const raw = formObject(fd);
    const id = String(raw.id ?? "");
    const step = Number(raw.step);
    const c = await db.campaign.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!c) throw new UserError("Campagne introuvable.");
    if (!["draft", "ready", "paused"].includes(c.status)) throw new UserError("Cette campagne ne peut plus être modifiée dans son statut actuel.");
    const schema = stepSchemas[step];
    const data: Prisma.CampaignUncheckedUpdateInput = {};

    if (step === 4) {
      const m = parse(z.object({ angle: optStr(300), valueProposition: optStr(600), message: optStr(1200), cta: optStr(80) }), raw);
      const prev = (c.message ?? {}) as Record<string, unknown>;
      data.message = { ...prev, manual: { angle: m.angle, valueProposition: m.valueProposition, message: m.message, cta: m.cta } } as Prisma.InputJsonValue;
    } else if (step === 9) {
      data.tracking = { utmContent: String(raw.utmContent ?? "").slice(0, 100) || null, utmTerm: String(raw.utmTerm ?? "").slice(0, 100) || null } as Prisma.InputJsonValue;
    } else if (schema) {
      const d = parse(schema, raw) as Record<string, unknown>;
      if (step === 2 && !(await db.audience.findFirst({ where: { id: String(d.audienceId), workspaceId: ctx.workspaceId }, select: { id: true } }))) throw new UserError("Audience introuvable.");
      if (step === 3 && !(await db.offer.findFirst({ where: { id: String(d.offerId), workspaceId: ctx.workspaceId }, select: { id: true } }))) throw new UserError("Offre introuvable.");
      if (step === 7 && d.landingPageId && !(await db.landingPage.findFirst({ where: { id: String(d.landingPageId), workspaceId: ctx.workspaceId }, select: { id: true } }))) throw new UserError("Landing page introuvable.");
      if (step === 6 && d.startDate && d.endDate && (d.endDate as Date) < (d.startDate as Date)) throw new UserError("La date de fin précède la date de début.");
      Object.assign(data, d);
      if (step === 7) data.landingPageId = (d.landingPageId as string) || null;
    }
    data.builderStep = Math.max(c.builderStep, Math.min(10, step + 1));
    await db.campaign.update({ where: { id: c.id }, data });
    next = `/campaigns/${c.id}/build?step=${Math.min(10, step + 1)}`;
  });
  if (r.ok && next) redirect(next);
  return r;
}

export async function generateCampaignProposalAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "ai" }, async (ctx) => {
    const { id } = parse(z.object({ id: z.string() }), formObject(fd));
    const c = await db.campaign.findFirst({ where: { id, workspaceId: ctx.workspaceId }, include: { offer: true, audience: true } });
    if (!c) throw new UserError("Campagne introuvable.");
    if (!c.offer || !c.audience) throw new UserError("Choisissez d'abord l'audience et l'offre (étapes 2 et 3).");
    const r = await generate({
      workspaceId: ctx.workspaceId, userId: ctx.user.id, campaignId: c.id, kind: "campaign", temperature: 0.7,
      system: baseSystem(briefOf(ctx.workspace), "stratège publicitaire"),
      prompt: campaignPrompt({
        objective: c.objective, platform: c.platform, budget: c.budget, offerPrice: c.offer.price, currency: c.offer.currency,
        audience: { name: c.audience.name, type: c.audience.type, location: c.audience.location, needs: c.audience.needs, problems: c.audience.problems, objections: c.audience.objections },
        offer: { name: c.offer.name, description: c.offer.description, price: c.offer.price, advantages: c.offer.advantages, differentiation: c.offer.differentiation },
      }),
      schema: campaignSchema, input: { campaignId: c.id },
    });
    const prev = (c.message ?? {}) as Record<string, unknown>;
    await db.campaign.update({ where: { id: c.id }, data: { message: { ...prev, proposal: r.data, proposalAt: new Date().toISOString(), proposalModel: `${r.provider}/${r.model}` } as Prisma.InputJsonValue } });
    revalidatePath(`/campaigns/${c.id}/build`);
    return { ok: true, message: "Proposition générée. Ce sont des hypothèses de l'IA à valider par des tests." };
  });
}

/** Reprend un angle proposé par l'IA comme message principal (modifiable ensuite). */
export async function adoptAngleAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const { id, index } = parse(z.object({ id: z.string(), index: z.coerce.number().int().min(0).max(20) }), formObject(fd));
    const c = await db.campaign.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    const msg = (c?.message ?? {}) as { proposal?: { angles: { angle: string; valueProposition: string }[]; messages: { text: string }[]; ctas: string[] } };
    const a = msg.proposal?.angles[index];
    if (!c || !a) throw new UserError("Angle introuvable.");
    await db.campaign.update({ where: { id }, data: { message: { ...msg, manual: { angle: a.angle, valueProposition: a.valueProposition, message: msg.proposal?.messages[0]?.text ?? "", cta: msg.proposal?.ctas[0] ?? "" } } as Prisma.InputJsonValue } });
    revalidatePath(`/campaigns/${id}/build`);
    return { ok: true, message: "Angle repris dans votre message." };
  });
}

export async function transitionCampaignAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const { id, to } = parse(z.object({ id: z.string(), to: z.string() }), formObject(fd));
    try { await transitionCampaign({ workspaceId: ctx.workspaceId, campaignId: id, to, actorId: ctx.user.id }); } catch (e) { if (e instanceof CampaignError) throw new UserError(e.message); throw e; }
    revalidatePath("/campaigns"); revalidatePath(`/campaigns/${id}`); revalidatePath(`/campaigns/${id}/build`);
    return { ok: true, message: "Statut mis à jour." };
  });
}

export async function duplicateCampaignAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let id: string | undefined;
  const r = await run({ action: "write" }, async (ctx) => {
    const { id: src } = parse(z.object({ id: z.string() }), formObject(fd));
    try { id = (await duplicateCampaign(ctx.workspaceId, src, ctx.user.id)).id; } catch (e) { if (e instanceof CampaignError) throw new UserError(e.message); throw e; }
  });
  if (r.ok && id) redirect(`/campaigns/${id}`);
  return r;
}

export async function deleteCampaignAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let done = false;
  const r = await run({ action: "delete" }, async (ctx) => {
    const { id } = parse(z.object({ id: z.string() }), formObject(fd));
    const c = await db.campaign.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!c) throw new UserError("Campagne introuvable.");
    const leads = await db.lead.count({ where: { campaignId: id, workspaceId: ctx.workspaceId } });
    if (c.status !== "draft" || leads > 0) throw new UserError("Seules les campagnes en brouillon sans leads peuvent être supprimées : archivez-la plutôt.");
    await db.campaign.delete({ where: { id } });
    await audit({ workspaceId: ctx.workspaceId, userId: ctx.user.id, action: "campaign.deleted", entity: "Campaign", entityId: id });
    done = true;
  });
  if (done) redirect("/campaigns");
  return r;
}

// ── Dépenses publicitaires (saisie manuelle) ──
export async function addMetricAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const d = parse(z.object({
      campaignId: z.string(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date requise"),
      spend: z.coerce.number().min(0, "Montant invalide").max(10_000_000), impressions: z.coerce.number().int().min(0).max(1_000_000_000).default(0), clicks: z.coerce.number().int().min(0).max(1_000_000_000).default(0),
    }), formObject(fd));
    const c = await db.campaign.findFirst({ where: { id: d.campaignId, workspaceId: ctx.workspaceId }, select: { id: true, platform: true } });
    if (!c) throw new UserError("Campagne introuvable.");
    if (d.clicks > d.impressions && d.impressions > 0) throw new UserError("Le nombre de clics ne peut pas dépasser le nombre d'impressions.");
    const dt = new Date(`${d.date}T00:00:00.000Z`);
    if (dt.getTime() > Date.now() + 86_400_000) throw new UserError("La date ne peut pas être dans le futur.");
    const dedupeKey = `manual:${c.id}:${d.date}`;
    await db.metric.upsert({
      where: { workspaceId_dedupeKey: { workspaceId: ctx.workspaceId, dedupeKey } },
      create: { workspaceId: ctx.workspaceId, campaignId: c.id, platform: c.platform, date: dt, spend: d.spend, impressions: d.impressions, clicks: d.clicks, source: "manual", dedupeKey },
      update: { spend: d.spend, impressions: d.impressions, clicks: d.clicks },
    });
    revalidatePath(`/campaigns/${c.id}`); revalidatePath("/dashboard"); revalidatePath("/analytics");
    return { ok: true, message: "Données du jour enregistrées." };
  });
}

export async function deleteMetricAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "delete" }, async (ctx) => {
    const { id } = parse(z.object({ id: z.string() }), formObject(fd));
    const m = await db.metric.findFirst({ where: { id, workspaceId: ctx.workspaceId, source: { in: ["manual", "csv"] } } });
    if (!m) throw new UserError("Ligne introuvable (seules les saisies manuelles sont supprimables).");
    await db.metric.delete({ where: { id } });
    revalidatePath(m.campaignId ? `/campaigns/${m.campaignId}` : "/analytics");
  });
}

// ── Mots-clés ──
export async function addKeywordAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const d = parse(z.object({ campaignId: z.string(), text: z.string().trim().min(2, "Mot-clé requis").max(120), matchType: z.enum(["broad", "phrase", "exact", "negative"]) }), formObject(fd));
    if (!(await db.campaign.findFirst({ where: { id: d.campaignId, workspaceId: ctx.workspaceId }, select: { id: true } }))) throw new UserError("Campagne introuvable.");
    await db.keyword.create({ data: { workspaceId: ctx.workspaceId, campaignId: d.campaignId, text: d.text, matchType: d.matchType } });
    revalidatePath(`/campaigns/${d.campaignId}`);
    return { ok: true };
  });
}

export async function deleteKeywordAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const { id } = parse(z.object({ id: z.string() }), formObject(fd));
    const k = await db.keyword.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!k) throw new UserError("Mot-clé introuvable.");
    await db.keyword.delete({ where: { id } });
    if (k.campaignId) revalidatePath(`/campaigns/${k.campaignId}`);
  });
}
