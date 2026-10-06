"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { run, parse, formObject, optNum, optStr, type ActionState, UserError } from "@/lib/action";
import { buildStrategy } from "@/lib/strategy";
import { generateStrategyNarrative } from "@/lib/strategy-service";
import { COMPANY_SIZES, CURRENCIES, LANGUAGES } from "@/lib/constants";
import { createWorkspace } from "@/lib/workspaces";
import { requireUser } from "@/lib/auth";
import { cookies } from "next/headers";
import { WORKSPACE_COOKIE } from "@/lib/constants";
import { env } from "@/lib/env";

const url = z.string().trim().max(300).optional().transform((v) => (v ? (/^https?:\/\//i.test(v) ? v : `https://${v}`) : undefined)).refine((v) => !v || /^https?:\/\/[^\s.]+\.[^\s]+$/.test(v), "Adresse de site invalide");

const schema = z.object({
  name: z.string().trim().min(2, "Nom requis").max(100),
  website: url,
  industry: z.string().trim().min(2, "Secteur requis").max(120),
  country: z.string().trim().min(2, "Pays requis").max(80),
  language: z.enum(LANGUAGES.map((l) => l[0]) as [string, ...string[]]),
  currency: z.enum(CURRENCIES),
  description: z.string().trim().min(10, "Décrivez votre activité en quelques mots").max(1500),
  companySize: z.enum(COMPANY_SIZES),
  // offre
  offerName: z.string().trim().min(2, "Produit / service requis").max(160),
  price: optNum,
  marginPct: optNum.refine((v) => v === undefined || v <= 100, "Entre 0 et 100"),
  geoZone: optStr(200),
  advantages: z.string().trim().max(1500).optional(),
  differentiation: optStr(600),
  // client idéal
  audienceType: z.enum(["b2b", "b2c"]),
  customerType: z.string().trim().min(2, "Type de client requis").max(200),
  location: optStr(200),
  needs: optStr(800),
  problems: optStr(800),
  objections: optStr(800),
  // objectifs
  goalLeadsPerMonth: optNum,
  goalSalesPerMonth: optNum,
  adBudgetMonthly: optNum,
  maxCac: optNum,
  revenueGoal: optNum,
});

export async function completeOnboardingAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const r = await run({ allowIncompleteOnboarding: true, allowInactive: true, action: "manage_settings" }, async (ctx) => {
    const d = parse(schema, formObject(fd));
    const advantages = (d.advantages ?? "").split(/\r?\n|;/).map((s) => s.trim()).filter(Boolean).slice(0, 12);
    const goals = { leadsPerMonth: d.goalLeadsPerMonth, salesPerMonth: d.goalSalesPerMonth, adBudgetMonthly: d.adBudgetMonthly, maxCac: d.maxCac, revenueGoal: d.revenueGoal };
    if (goals.leadsPerMonth && goals.salesPerMonth && goals.salesPerMonth > goals.leadsPerMonth) throw new UserError("L'objectif de ventes ne peut pas dépasser l'objectif de leads.");

    const { offer, audience } = await db.$transaction(async (tx) => {
      await tx.workspace.update({
        where: { id: ctx.workspaceId },
        data: {
          name: d.name, website: d.website ?? null, industry: d.industry, country: d.country, language: d.language, currency: d.currency, description: d.description, companySize: d.companySize,
          goalLeadsPerMonth: goals.leadsPerMonth ? Math.round(goals.leadsPerMonth) : null, goalSalesPerMonth: goals.salesPerMonth ? Math.round(goals.salesPerMonth) : null,
          adBudgetMonthly: goals.adBudgetMonthly ?? null, maxCac: goals.maxCac ?? null, revenueGoal: goals.revenueGoal ?? null,
        },
      });
      const aud = await tx.audience.create({ data: { workspaceId: ctx.workspaceId, name: d.customerType, type: d.audienceType, customerType: d.customerType, location: d.location, needs: d.needs, problems: d.problems, objections: d.objections } });
      const off = await tx.offer.create({
        data: { workspaceId: ctx.workspaceId, audienceId: aud.id, name: d.offerName, description: d.description, price: d.price, currency: d.currency, marginPct: d.marginPct, geoZone: d.geoZone, advantages, differentiation: d.differentiation, status: "active" },
      });
      return { offer: off, audience: aud };
    });

    const sheet = buildStrategy({
      companyName: d.name, currency: d.currency, industry: d.industry, country: d.country,
      offer: { name: offer.name, price: offer.price, marginPct: offer.marginPct, advantages, differentiation: offer.differentiation, geoZone: offer.geoZone },
      audience: { name: audience.name, type: audience.type, location: audience.location, needs: audience.needs, problems: audience.problems, objections: audience.objections },
      goals,
    });
    const narrative = await generateStrategyNarrative(ctx.workspaceId, ctx.user.id, sheet).catch(() => null);
    await db.strategy.create({ data: { workspaceId: ctx.workspaceId, content: { sheet, narrative } as object, source: narrative ? "rules+ai" : "rules" } });
    await db.workspace.update({ where: { id: ctx.workspaceId }, data: { onboardingCompletedAt: new Date() } });
    await audit({ workspaceId: ctx.workspaceId, userId: ctx.user.id, action: "onboarding.completed" });
    return { ok: true };
  });
  if (r.ok) redirect("/strategy?welcome=1");
  return r;
}

export async function createFirstWorkspaceAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const name = String(fd.get("name") ?? "").trim();
  if (name.length < 2) return { error: "Nom requis.", fieldErrors: { name: "Nom requis." } };
  const ws = await createWorkspace(user.id, name);
  (await cookies()).set(WORKSPACE_COOKIE, ws.id, { httpOnly: true, sameSite: "lax", secure: env.isProd, path: "/", maxAge: 60 * 60 * 24 * 365 });
  redirect("/onboarding");
}
