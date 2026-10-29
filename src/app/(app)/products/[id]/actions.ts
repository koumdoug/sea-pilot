"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { run, parse, formObject, type ActionState } from "@/lib/action";
import { createProductLanding } from "@/lib/portfolio/landing-service";

/** Création explicite de l'offre et de la landing page (brouillon) d'un produit du catalogue. Rien n'est publié ni envoyé. */
export async function createProductLandingAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let target: string | undefined;
  const r = await run({ action: "write" }, async (ctx) => {
    const { productId } = parse(z.object({ productId: z.string().trim().min(1).max(60) }), formObject(fd));
    const res = await createProductLanding({ workspaceId: ctx.workspaceId, productId, userId: ctx.user.id, plan: ctx.ent.plan });
    revalidatePath(`/products/${productId}`);
    revalidatePath("/landing-pages");
    target = `/landing-pages/${res.pageId}`;
    return { ok: true, id: res.pageId, message: res.created ? "Landing page créée en brouillon." : "Une landing page existe déjà pour ce produit." };
  });
  if (r.ok && target) redirect(target);
  return r;
}
