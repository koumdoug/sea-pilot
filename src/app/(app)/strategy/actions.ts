"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { run, UserError, type ActionState } from "@/lib/action";
import { buildStrategy } from "@/lib/strategy";
import { generateStrategyNarrative, loadStrategyInput } from "@/lib/strategy-service";

/** Recalcule la fiche à partir de l'offre principale, de l'audience, du produit rattaché (s'il existe) et des objectifs actuels. */
export async function regenerateStrategyAction(): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const input = await loadStrategyInput(ctx.workspaceId);
    if (!input) throw new UserError("Espace de travail introuvable.");
    const sheet = buildStrategy(input);
    let narrative = null;
    let note: string | undefined;
    try { narrative = await generateStrategyNarrative(ctx.workspaceId, ctx.user.id, sheet); } catch { note = " Le récit IA n'a pas pu être généré (fiche chiffrée conservée)."; }
    await db.strategy.create({ data: { workspaceId: ctx.workspaceId, content: { sheet, narrative } as object, source: narrative ? "rules+ai" : "rules" } });
    revalidatePath("/strategy");
    return { ok: true, message: `Fiche stratégie mise à jour.${note ?? ""}` };
  });
}
