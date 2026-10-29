"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { run, parse, formObject, type ActionState } from "@/lib/action";
import { generateContentBrief } from "@/lib/content-brief-service";

/** Génération explicite d'un brief par l'IA : permission « ai », quota et débit appliqués par generate(). */
export async function generateBriefAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "ai" }, async (ctx) => {
    const { pageId } = parse(z.object({ pageId: z.string().trim().min(1).max(60) }), formObject(fd));
    const r = await generateContentBrief({ workspaceId: ctx.workspaceId, userId: ctx.user.id, pageId });
    revalidatePath(`/landing-pages/${pageId}/brief`);
    revalidatePath("/ai-studio");
    return { ok: true, id: r.generationId, message: r.figureWarnings.length ? `Brief généré. Attention : ${r.figureWarnings.length} chiffre(s) cité(s) par l'IA ne figurent pas dans vos données — vérifiez-les.` : "Brief généré. C'est une proposition de l'IA : relisez-la avant de l'utiliser." };
  });
}
