"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { run, type ActionState } from "@/lib/action";
import { buildStrategy } from "@/lib/strategy";
import { generateStrategyNarrative } from "@/lib/strategy-service";

/** Recalcule la fiche à partir de l'offre principale, de l'audience et des objectifs actuels. */
export async function regenerateStrategyAction(): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const w = ctx.workspace;
    const offer = await db.offer.findFirst({ where: { workspaceId: ctx.workspaceId, status: { not: "archived" } }, orderBy: { createdAt: "asc" }, include: { audience: true } });
    const sheet = buildStrategy({
      companyName: w.name, currency: w.currency, industry: w.industry, country: w.country,
      offer: offer ? { name: offer.name, price: offer.price, marginPct: offer.marginPct, advantages: Array.isArray(offer.advantages) ? (offer.advantages as string[]) : [], differentiation: offer.differentiation, geoZone: offer.geoZone } : null,
      audience: offer?.audience ? { name: offer.audience.name, type: offer.audience.type, location: offer.audience.location, needs: offer.audience.needs, problems: offer.audience.problems, objections: offer.audience.objections } : null,
      goals: { leadsPerMonth: w.goalLeadsPerMonth, salesPerMonth: w.goalSalesPerMonth, adBudgetMonthly: w.adBudgetMonthly, maxCac: w.maxCac, revenueGoal: w.revenueGoal },
    });
    let narrative = null;
    let note: string | undefined;
    try { narrative = await generateStrategyNarrative(ctx.workspaceId, ctx.user.id, sheet); } catch { note = " Le récit IA n'a pas pu être généré (fiche chiffrée conservée)."; }
    await db.strategy.create({ data: { workspaceId: ctx.workspaceId, content: { sheet, narrative } as object, source: narrative ? "rules+ai" : "rules" } });
    revalidatePath("/strategy");
    return { ok: true, message: `Fiche stratégie mise à jour.${note ?? ""}` };
  });
}
