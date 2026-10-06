"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { run, parse, formObject, optStr, UserError, type ActionState } from "@/lib/action";
import { DEFAULT_SEQUENCE_STEPS, processDueFollowUps, stepsSchema } from "@/lib/followups";
import { limitReached } from "@/lib/plans";
import { workspaceUsage } from "@/lib/billing";

async function quota(ctx: { workspaceId: string; ent: { plan: Parameters<typeof limitReached>[0] } }) {
  const usage = await workspaceUsage(ctx.workspaceId);
  if (limitReached(ctx.ent.plan, "sequences", usage.sequences)) throw new UserError("Limite de séquences atteinte pour votre plan.");
}

export async function createDefaultSequenceAction(): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    await quota(ctx);
    await db.followUpSequence.create({ data: { workspaceId: ctx.workspaceId, name: "Relance standard J0 · J1 · J3 · J7 · J14", description: "Accusé de réception, appel, relance, rappel, clôture automatique sans réponse.", steps: DEFAULT_SEQUENCE_STEPS as unknown as Prisma.InputJsonValue, active: true, autoEnroll: false, sendEmails: false } });
    revalidatePath("/automations");
    return { ok: true, message: "Séquence créée. L'envoi d'e-mails est désactivé par défaut : activez-le explicitement quand votre e-mail est connecté." };
  });
}

const seqSchema = z.object({
  id: z.string().optional(), name: z.string().trim().min(2, "Nom requis").max(120), description: optStr(400), steps: z.string(),
  active: z.string().optional(), autoEnroll: z.string().optional(), sendEmails: z.string().optional(),
});

export async function saveSequenceAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const d = parse(seqSchema, formObject(fd));
    let raw: unknown;
    try { raw = JSON.parse(d.steps); } catch { throw new UserError("Étapes invalides."); }
    const sp = stepsSchema.safeParse(raw);
    if (!sp.success) throw new UserError(sp.error.issues[0]?.message ?? "Étapes invalides.");
    for (const [i, s] of sp.data.entries()) {
      if (s.action === "email" && (!s.subject || !s.body)) throw new UserError(`Étape ${i + 1} : objet et message requis pour un e-mail.`);
      if ((s.action === "task" || s.action === "reminder") && !s.title) throw new UserError(`Étape ${i + 1} : titre requis.`);
      if (s.action === "status_change" && !s.status) throw new UserError(`Étape ${i + 1} : statut cible requis.`);
    }
    const data = { name: d.name, description: d.description ?? null, steps: sp.data as unknown as Prisma.InputJsonValue, active: d.active === "on", autoEnroll: d.autoEnroll === "on", sendEmails: d.sendEmails === "on" };
    if (d.id) {
      const u = await db.followUpSequence.updateMany({ where: { id: d.id, workspaceId: ctx.workspaceId }, data });
      if (!u.count) throw new UserError("Séquence introuvable.");
    } else { await quota(ctx); await db.followUpSequence.create({ data: { ...data, workspaceId: ctx.workspaceId } }); }
    await audit({ workspaceId: ctx.workspaceId, userId: ctx.user.id, action: "sequence.saved", entity: "FollowUpSequence", entityId: d.id, meta: { sendEmails: data.sendEmails } });
    revalidatePath("/automations");
    return { ok: true, message: "Séquence enregistrée." };
  });
}

export async function deleteSequenceAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "delete" }, async (ctx) => {
    const { id } = parse(z.object({ id: z.string() }), formObject(fd));
    await db.followUp.updateMany({ where: { workspaceId: ctx.workspaceId, sequenceId: id, status: { in: ["pending", "blocked"] } }, data: { status: "cancelled", result: "Séquence supprimée.", executedAt: new Date() } });
    await db.followUpSequence.deleteMany({ where: { id, workspaceId: ctx.workspaceId } });
    revalidatePath("/automations");
  });
}

export async function runFollowUpsNowAction(): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const s = await processDueFollowUps({ workspaceId: ctx.workspaceId });
    revalidatePath("/automations");
    return { ok: true, message: s.processed === 0 ? "Aucune relance échue." : `${s.processed} relance(s) traitée(s) : ${s.done} exécutée(s), ${s.blocked} bloquée(s) (consentement/configuration), ${s.cancelled} annulée(s), ${s.failed} en échec.` };
  });
}
