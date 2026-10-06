"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { db } from "@/lib/db";
import { run, parse, formObject, optStr, UserError, type ActionState } from "@/lib/action";
import { AD_PLATFORMS, AD_STATUSES } from "@/lib/constants";
import { generate } from "@/lib/ai/service";
import { adCopyPrompt, adCopySchema, baseSystem } from "@/lib/ai/prompts";
import { briefOf } from "@/lib/ai/brief";

export async function generateAdsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "ai" }, async (ctx) => {
    const d = parse(z.object({ platform: z.enum(AD_PLATFORMS), campaignId: optStr(60), offerId: optStr(60), audienceId: optStr(60), tone: optStr(100), count: z.coerce.number().int().min(1).max(8).default(3), objective: optStr(100) }), formObject(fd));
    const [campaign, offer, audience] = await Promise.all([
      d.campaignId ? db.campaign.findFirst({ where: { id: d.campaignId, workspaceId: ctx.workspaceId } }) : null,
      d.offerId ? db.offer.findFirst({ where: { id: d.offerId, workspaceId: ctx.workspaceId } }) : null,
      d.audienceId ? db.audience.findFirst({ where: { id: d.audienceId, workspaceId: ctx.workspaceId } }) : null,
    ]);
    if (d.campaignId && !campaign) throw new UserError("Campagne introuvable.");
    if (!offer && !(campaign?.offerId)) throw new UserError("Choisissez l'offre à promouvoir.");
    const off = offer ?? (campaign?.offerId ? await db.offer.findFirst({ where: { id: campaign.offerId, workspaceId: ctx.workspaceId } }) : null);
    if (!off) throw new UserError("Offre introuvable.");
    const aud = audience ?? (campaign?.audienceId ? await db.audience.findFirst({ where: { id: campaign.audienceId, workspaceId: ctx.workspaceId } }) : null);

    const r = await generate({
      workspaceId: ctx.workspaceId, userId: ctx.user.id, campaignId: campaign?.id, kind: "ad_copy", temperature: 0.85,
      system: baseSystem(briefOf(ctx.workspace), "rédacteur publicitaire spécialisé en annonces à la performance"),
      prompt: adCopyPrompt({
        platform: d.platform, objective: d.objective ?? campaign?.objective, tone: d.tone, count: d.count,
        offer: { name: off.name, description: off.description, price: off.price, advantages: off.advantages, differentiation: off.differentiation, problem: off.problem },
        audience: aud ? { name: aud.name, type: aud.type, needs: aud.needs, problems: aud.problems, objections: aud.objections } : undefined,
      }),
      schema: adCopySchema, input: { platform: d.platform, offerId: off.id, audienceId: aud?.id, count: d.count, tone: d.tone },
    });
    await db.ad.createMany({
      data: r.data.ads.map((a, i) => ({
        workspaceId: ctx.workspaceId, campaignId: campaign?.id, generationId: r.generationId, platform: d.platform, variantLabel: a.variant || String.fromCharCode(65 + i), hook: a.hook || null,
        headline: a.headline, primaryText: a.primaryText || null, description: a.description || null, cta: a.cta || null, status: "draft", source: "ai",
      })),
    });
    revalidatePath("/ai-studio");
    return { ok: true, message: `${r.data.ads.length} variante(s) générée(s) et enregistrée(s). Relisez-les : ce sont des propositions de l'IA.` };
  });
}

const adFields = z.object({ id: z.string(), headline: z.string().trim().min(1, "Titre requis").max(200), hook: optStr(300), primaryText: optStr(1000), description: optStr(500), cta: optStr(80) });

export async function updateAdAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const d = parse(adFields, formObject(fd));
    const u = await db.ad.updateMany({ where: { id: d.id, workspaceId: ctx.workspaceId }, data: { headline: d.headline, hook: d.hook ?? null, primaryText: d.primaryText ?? null, description: d.description ?? null, cta: d.cta ?? null } });
    if (!u.count) throw new UserError("Annonce introuvable.");
    revalidatePath("/ai-studio");
    return { ok: true, message: "Annonce modifiée." };
  });
}

export async function duplicateAdAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const { id } = parse(z.object({ id: z.string() }), formObject(fd));
    const a = await db.ad.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!a) throw new UserError("Annonce introuvable.");
    await db.ad.create({ data: { workspaceId: ctx.workspaceId, campaignId: a.campaignId, platform: a.platform, format: a.format, variantLabel: `${a.variantLabel ?? ""}'`, hook: a.hook, headline: a.headline, primaryText: a.primaryText, description: a.description, cta: a.cta, status: "draft", source: "user" } });
    revalidatePath("/ai-studio");
  });
}

export async function toggleWinnerAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const { id } = parse(z.object({ id: z.string() }), formObject(fd));
    const a = await db.ad.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!a) throw new UserError("Annonce introuvable.");
    await db.ad.update({ where: { id }, data: { isWinner: !a.isWinner } });
    revalidatePath("/ai-studio");
  });
}

export async function setAdStatusAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const { id, status } = parse(z.object({ id: z.string(), status: z.enum(AD_STATUSES) }), formObject(fd));
    const u = await db.ad.updateMany({ where: { id, workspaceId: ctx.workspaceId }, data: { status } });
    if (!u.count) throw new UserError("Annonce introuvable.");
    revalidatePath("/ai-studio");
  });
}

export async function deleteAdAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const { id } = parse(z.object({ id: z.string() }), formObject(fd));
    await db.ad.deleteMany({ where: { id, workspaceId: ctx.workspaceId } });
    revalidatePath("/ai-studio");
  });
}
