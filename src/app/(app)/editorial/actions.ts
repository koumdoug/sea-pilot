"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { run, parse, formObject, type ActionState } from "@/lib/action";
import { changeContentState, createContentItem, deleteContentItem, updateContentItem } from "@/lib/editorial-service";

// Toute écriture : permission vérifiée CÔTÉ SERVEUR par run() (write ; delete pour la suppression), périmètre d'espace de travail dans le service.
// Aucune de ces actions n'appelle l'IA : la génération d'un brief reste l'action explicite de la page de brief.
const idOnly = z.object({ id: z.string().trim().min(1).max(60) });
const done = (message: string): ActionState => { revalidatePath("/editorial"); return { ok: true, message }; };

export async function createContentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    await createContentItem({ workspaceId: ctx.workspaceId, actorId: ctx.user.id }, formObject(fd));
    return done("Contenu ajouté.");
  });
}

export async function updateContentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const o = formObject(fd);
    const { id } = parse(idOnly, o);
    await updateContentItem({ workspaceId: ctx.workspaceId, actorId: ctx.user.id }, id, o);
    return done("Contenu mis à jour.");
  });
}

export async function changeContentStateAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const r = await changeContentState({ workspaceId: ctx.workspaceId, actorId: ctx.user.id }, formObject(fd));
    return done(r.state === "published" ? "Publication confirmée." : "État mis à jour.");
  });
}

export async function deleteContentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "delete" }, async (ctx) => {
    const { id } = parse(idOnly, formObject(fd));
    await deleteContentItem({ workspaceId: ctx.workspaceId, actorId: ctx.user.id }, id);
    return done("Contenu supprimé.");
  });
}
