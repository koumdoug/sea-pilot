"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { audit } from "@/lib/audit";
import { run, parse, formObject, optStr, UserError, type ActionState } from "@/lib/action";
import { DEFAULT_SEQUENCE_STEPS, deleteSequence, processDueFollowUps, stepsSchema, updateSequence } from "@/lib/followups";
import { REVIEW_ACTIONS, ReviewError, resolveFollowUp } from "@/lib/followup-review";
import type { Plan } from "@/lib/plans";
import { QuotaError, createWithinLimit } from "@/lib/quota";

/** Création d'une séquence : comptage et insertion dans la même transaction verrouillée (deux requêtes simultanées ne dépassent pas la limite du forfait). */
async function createSequence(ctx: { workspaceId: string; ent: { plan: Plan } }, data: Prisma.FollowUpSequenceUncheckedCreateInput) {
  try {
    await createWithinLimit({ workspaceId: ctx.workspaceId, plan: ctx.ent.plan, key: "sequences", message: "Limite de séquences atteinte pour votre plan.", create: (tx) => tx.followUpSequence.create({ data }) });
  } catch (e) { if (e instanceof QuotaError) throw new UserError(e.message); throw e; }
}

export async function createDefaultSequenceAction(): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    await createSequence(ctx, { workspaceId: ctx.workspaceId, name: "Relance standard J0 · J1 · J3 · J7 · J14", description: "Accusé de réception, appel, relance, rappel, clôture automatique sans réponse.", steps: DEFAULT_SEQUENCE_STEPS as unknown as Prisma.InputJsonValue, active: true, autoEnroll: false, sendEmails: false });
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
      // T5 transactionnelle (désactivation = annulation des relances en attente ou bloquées) : voir updateSequence
      const found = await updateSequence(ctx.workspaceId, d.id, data);
      if (!found) throw new UserError("Séquence introuvable.");
    } else await createSequence(ctx, { ...data, workspaceId: ctx.workspaceId });
    await audit({ workspaceId: ctx.workspaceId, userId: ctx.user.id, action: "sequence.saved", entity: "FollowUpSequence", entityId: d.id, meta: { sendEmails: data.sendEmails } });
    revalidatePath("/automations");
    return { ok: true, message: "Séquence enregistrée." };
  });
}

export async function deleteSequenceAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "delete" }, async (ctx) => {
    const { id } = parse(z.object({ id: z.string() }), formObject(fd));
    await deleteSequence(ctx.workspaceId, id); // T5 transactionnelle : voir deleteSequence
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

/** Résolution humaine d'une relance à examiner : réservée aux administrateurs (« approve_outreach »), transaction conditionnelle sur l'état vu, jamais de renvoi sans confirmation. */
export async function resolveFollowUpAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "approve_outreach" }, async (ctx) => {
    const d = parse(z.object({
      id: z.string().min(1), action: z.enum(REVIEW_ACTIONS), note: optStr(1000), typed: optStr(40), confirm: z.string().optional(),
      attemptCount: z.string().regex(/^\d+$/), emailStatus: z.string().optional(), attemptId: optStr(120),
    }), formObject(fd));
    try {
      const r = await resolveFollowUp({
        workspaceId: ctx.workspaceId, userId: ctx.user.id, id: d.id, action: d.action, note: d.note, typed: d.typed, confirm: d.confirm === "on",
        seen: { attemptCount: Number(d.attemptCount), emailStatus: d.emailStatus || null }, attemptId: d.attemptId,
      });
      revalidatePath("/automations");
      return { ok: true, message: r.message };
    } catch (e) {
      if (e instanceof ReviewError) throw new UserError(e.message);
      throw e;
    }
  });
}
