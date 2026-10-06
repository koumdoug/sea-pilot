"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { db } from "@/lib/db";
import { audit } from "@/lib/audit";
import { run, parse, formObject, optNum, optStr, UserError, type ActionState } from "@/lib/action";
import { LEAD_STATUSES } from "@/lib/constants";
import { LeadError, changeLeadStatus, createLead, eraseLead, qualifyLeadService, unsubscribeLead } from "@/lib/leads";
import { enrollLead, cancelPendingFollowUps } from "@/lib/followups";

const lead = (e: unknown): never => { if (e instanceof LeadError) throw new UserError(e.message); throw e; };

export async function createLeadAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let id: string | undefined;
  const r = await run({ action: "write" }, async (ctx) => {
    const d = parse(z.object({
      name: z.string().trim().min(1, "Nom requis").max(120), email: z.string().trim().email("E-mail invalide").max(200).optional().or(z.literal("")), phone: optStr(40), company: optStr(160), message: optStr(4000),
      source: optStr(120), campaignId: optStr(60), value: optNum, consent: z.string().optional(),
    }), formObject(fd));
    if (!d.email && !d.phone) throw new UserError("Indiquez au moins un e-mail ou un téléphone.");
    const { lead: l, duplicate } = await createLead({
      workspaceId: ctx.workspaceId, name: d.name, email: d.email || null, phone: d.phone, company: d.company, message: d.message, source: d.source ?? "manuel", campaignId: d.campaignId,
      consentMarketing: d.consent === "on", consentText: d.consent === "on" ? "Consentement déclaré par l'utilisateur de SEA Pilot lors de la saisie manuelle" : null, actorId: ctx.user.id, value: d.value,
    });
    if (duplicate) throw new UserError("Un lead avec cet e-mail vient d'être créé.");
    id = l.id;
  });
  if (r.ok && id) redirect(`/leads/${id}`);
  return r;
}

export async function updateLeadAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const d = parse(z.object({ id: z.string(), name: z.string().trim().min(1, "Nom requis").max(120), email: z.string().trim().email("E-mail invalide").max(200).optional().or(z.literal("")), phone: optStr(40), company: optStr(160), value: optNum }), formObject(fd));
    const u = await db.lead.updateMany({ where: { id: d.id, workspaceId: ctx.workspaceId, deletedAt: null }, data: { name: d.name, email: d.email ? d.email.toLowerCase() : null, phone: d.phone ?? null, company: d.company ?? null, value: d.value ?? null } });
    if (!u.count) throw new UserError("Prospect introuvable.");
    revalidatePath(`/leads/${d.id}`);
    return { ok: true, message: "Fiche mise à jour." };
  });
}

export async function changeStatusAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const d = parse(z.object({ id: z.string(), status: z.enum(LEAD_STATUSES), value: optNum, lostReason: optStr(300) }), formObject(fd));
    try { await changeLeadStatus({ workspaceId: ctx.workspaceId, leadId: d.id, status: d.status, actorId: ctx.user.id, value: d.value ?? undefined, lostReason: d.lostReason }); } catch (e) { lead(e); }
    revalidatePath("/crm"); revalidatePath("/leads"); revalidatePath(`/leads/${d.id}`);
    return { ok: true, message: "Statut mis à jour." };
  });
}

export async function qualifyAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const d = parse(z.object({ id: z.string(), ai: z.string().optional() }), formObject(fd));
    const useAi = d.ai === "1";
    if (useAi && !ctx.can("ai")) throw new UserError("Votre rôle ne permet pas d'utiliser l'IA.");
    const r = await (async () => { try { return await qualifyLeadService({ workspaceId: ctx.workspaceId, leadId: d.id, userId: ctx.user.id, allowAi: useAi }); } catch (e) { return lead(e); } })();
    revalidatePath(`/leads/${d.id}`); revalidatePath("/leads");
    return { ok: true, message: r.method === "rules+ai" ? "Lead qualifié (règles + analyse IA)." : useAi ? "Lead qualifié par les règles : l'IA n'a pas pu être utilisée (non configurée ou indisponible)." : "Lead qualifié (règles configurables)." };
  });
}

export async function addConversationAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const d = parse(z.object({ id: z.string(), channel: z.enum(["note", "call", "email", "sms", "chat", "meeting"]), direction: z.enum(["inbound", "outbound", "internal"]).default("internal"), subject: optStr(200), body: z.string().trim().min(1, "Message requis").max(5000) }), formObject(fd));
    const l = await db.lead.findFirst({ where: { id: d.id, workspaceId: ctx.workspaceId, deletedAt: null }, select: { id: true, status: true } });
    if (!l) throw new UserError("Prospect introuvable.");
    await db.conversation.create({ data: { workspaceId: ctx.workspaceId, leadId: l.id, channel: d.channel, direction: d.channel === "note" ? "internal" : d.direction, subject: d.subject, body: d.body, authorId: ctx.user.id } });
    await db.leadActivity.create({ data: { workspaceId: ctx.workspaceId, leadId: l.id, type: "note", actorId: ctx.user.id, data: { channel: d.channel } } });
    // Premier contact sortant : le prospect passe automatiquement à « Contacté ».
    if (l.status === "new" && d.direction === "outbound" && d.channel !== "note") await changeLeadStatus({ workspaceId: ctx.workspaceId, leadId: l.id, status: "contacted", actorId: ctx.user.id });
    revalidatePath(`/leads/${l.id}`);
    return { ok: true };
  });
}

export async function addTaskAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const d = parse(z.object({ leadId: optStr(60), title: z.string().trim().min(2, "Titre requis").max(200), dueAt: z.string().optional().transform((v) => (v ? new Date(`${v}T09:00:00.000Z`) : undefined)) }), formObject(fd));
    if (d.leadId && !(await db.lead.findFirst({ where: { id: d.leadId, workspaceId: ctx.workspaceId }, select: { id: true } }))) throw new UserError("Prospect introuvable.");
    await db.task.create({ data: { workspaceId: ctx.workspaceId, leadId: d.leadId, title: d.title, dueAt: d.dueAt, assigneeId: ctx.user.id } });
    if (d.leadId) { await db.leadActivity.create({ data: { workspaceId: ctx.workspaceId, leadId: d.leadId, type: "task", actorId: ctx.user.id, data: { title: d.title } } }); revalidatePath(`/leads/${d.leadId}`); }
    revalidatePath("/crm");
    return { ok: true };
  });
}

export async function toggleTaskAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const { id } = parse(z.object({ id: z.string() }), formObject(fd));
    const t = await db.task.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
    if (!t) throw new UserError("Tâche introuvable.");
    const done = t.status !== "done";
    await db.task.update({ where: { id }, data: { status: done ? "done" : "open", completedAt: done ? new Date() : null } });
    revalidatePath("/crm"); if (t.leadId) revalidatePath(`/leads/${t.leadId}`);
  });
}

export async function enrollSequenceAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const { id, sequenceId } = parse(z.object({ id: z.string(), sequenceId: z.string().min(1, "Choisissez une séquence") }), formObject(fd));
    const r = await enrollLead({ workspaceId: ctx.workspaceId, leadId: id, sequenceId });
    if (!r.enrolled) throw new UserError(r.reason ?? "Inscription impossible.");
    revalidatePath(`/leads/${id}`);
    return { ok: true, message: `Prospect inscrit : ${r.count} étape(s) planifiée(s).` };
  });
}

export async function cancelFollowUpsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const { id } = parse(z.object({ id: z.string() }), formObject(fd));
    const n = await cancelPendingFollowUps(ctx.workspaceId, id, "Arrêt manuel des relances.");
    revalidatePath(`/leads/${id}`);
    return { ok: true, message: `${n} relance(s) annulée(s).` };
  });
}

export async function unsubscribeAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return run({ action: "write" }, async (ctx) => {
    const { id } = parse(z.object({ id: z.string() }), formObject(fd));
    if (!(await unsubscribeLead(ctx.workspaceId, id, "manual"))) throw new UserError("Prospect introuvable.");
    revalidatePath(`/leads/${id}`);
    return { ok: true, message: "Prospect désinscrit : plus aucun e-mail marketing ne lui sera envoyé." };
  });
}

export async function eraseLeadAction(_: ActionState, fd: FormData): Promise<ActionState> {
  let done = false;
  const r = await run({ action: "delete" }, async (ctx) => {
    const { id } = parse(z.object({ id: z.string() }), formObject(fd));
    if (!(await eraseLead(ctx.workspaceId, id, ctx.user.id))) throw new UserError("Prospect introuvable.");
    await audit({ workspaceId: ctx.workspaceId, userId: ctx.user.id, action: "gdpr.lead_erased", entity: "Lead", entityId: id });
    done = true;
  });
  if (done) redirect("/leads");
  return r;
}
