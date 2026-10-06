import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { sendFollowUpEmail } from "./email";
import { TERMINAL_STATUSES, FOLLOWUP_ACTIONS, LEAD_STATUSES } from "./constants";
import { log, errMsg } from "./logger";

export const stepSchema = z.object({
  day: z.number().int().min(0).max(365),
  action: z.enum(FOLLOWUP_ACTIONS),
  title: z.string().trim().max(200).optional(),
  subject: z.string().trim().max(200).optional(),
  body: z.string().trim().max(5000).optional(),
  status: z.enum(LEAD_STATUSES).optional(),
});
export type Step = z.infer<typeof stepSchema>;
export const stepsSchema = z.array(stepSchema).min(1).max(30);

/** Séquence recommandée : Jour 0 / 1 / 3 / 7 / 14. */
export const DEFAULT_SEQUENCE_STEPS: Step[] = [
  { day: 0, action: "email", subject: "Merci pour votre demande", body: "Bonjour {{prenom}},\n\nMerci pour votre demande. Nous l'avons bien reçue et revenons vers vous très vite.\n\nPouvez-vous nous préciser votre besoin et votre échéance ?" },
  { day: 1, action: "task", title: "Appeler {{nom}} pour qualifier le besoin" },
  { day: 3, action: "email", subject: "Avez-vous eu le temps d'y réfléchir ?", body: "Bonjour {{prenom}},\n\nJe me permets de revenir vers vous au sujet de votre demande. Souhaitez-vous que nous en parlions cette semaine ?" },
  { day: 7, action: "reminder", title: "Dernier suivi actif avec {{nom}} : décider de poursuivre ou clore" },
  { day: 14, action: "status_change", status: "lost", title: "Clôture automatique sans réponse" },
];

export function renderTemplate(t: string, lead: { name: string; company?: string | null }): string {
  const first = lead.name.trim().split(/\s+/)[0] ?? lead.name;
  return t.replaceAll("{{prenom}}", first).replaceAll("{{nom}}", lead.name).replaceAll("{{entreprise}}", lead.company ?? "");
}

export function parseSteps(raw: unknown): Step[] {
  const r = stepsSchema.safeParse(raw);
  return r.success ? r.data : [];
}

/** Inscrit un prospect : crée un FollowUp planifié par étape. Refuse si le prospect est clos ou déjà inscrit. */
export async function enrollLead(p: { workspaceId: string; leadId: string; sequenceId: string; now?: Date }): Promise<{ enrolled: boolean; reason?: string; count?: number }> {
  const now = p.now ?? new Date();
  const seq = await db.followUpSequence.findFirst({ where: { id: p.sequenceId, workspaceId: p.workspaceId } });
  if (!seq || !seq.active) return { enrolled: false, reason: "Séquence introuvable ou inactive." };
  const lead = await db.lead.findFirst({ where: { id: p.leadId, workspaceId: p.workspaceId, deletedAt: null } });
  if (!lead) return { enrolled: false, reason: "Prospect introuvable." };
  if ((TERMINAL_STATUSES as string[]).includes(lead.status)) return { enrolled: false, reason: "Le prospect est déjà clos (gagné, perdu ou disqualifié)." };
  if (lead.unsubscribedAt) return { enrolled: false, reason: "Le prospect s'est désinscrit." };
  const existing = await db.followUp.count({ where: { workspaceId: p.workspaceId, leadId: lead.id, sequenceId: seq.id, status: { in: ["pending", "running"] } } });
  if (existing) return { enrolled: false, reason: "Déjà inscrit à cette séquence." };
  const steps = parseSteps(seq.steps);
  if (!steps.length) return { enrolled: false, reason: "La séquence ne contient aucune étape valide." };
  await db.followUp.createMany({
    data: steps.map((s, idx) => ({
      workspaceId: p.workspaceId, leadId: lead.id, sequenceId: seq.id, stepIndex: idx, action: s.action, payload: s as unknown as Prisma.InputJsonValue,
      dueAt: new Date(now.getTime() + s.day * 86_400_000), status: "pending",
    })),
  });
  await db.leadActivity.create({ data: { workspaceId: p.workspaceId, leadId: lead.id, type: "followup", data: { sequence: seq.name, steps: steps.length } } });
  return { enrolled: true, count: steps.length };
}

export async function cancelPendingFollowUps(workspaceId: string, leadId: string, reason: string) {
  const r = await db.followUp.updateMany({ where: { workspaceId, leadId, status: { in: ["pending", "blocked"] } }, data: { status: "cancelled", result: reason, executedAt: new Date() } });
  return r.count;
}

export type ProcessSummary = { processed: number; done: number; blocked: number; failed: number; cancelled: number };

/** Exécute les relances arrivées à échéance. Un e-mail n'est JAMAIS envoyé sans configuration + consentement explicites. */
export async function processDueFollowUps(opts: { workspaceId?: string; now?: Date; limit?: number } = {}): Promise<ProcessSummary> {
  const now = opts.now ?? new Date();
  const due = await db.followUp.findMany({
    where: { status: "pending", dueAt: { lte: now }, ...(opts.workspaceId ? { workspaceId: opts.workspaceId } : {}) },
    orderBy: { dueAt: "asc" }, take: opts.limit ?? 200, include: { lead: true, sequence: true },
  });
  const sum: ProcessSummary = { processed: 0, done: 0, blocked: 0, failed: 0, cancelled: 0 };

  for (const f of due) {
    // Réservation atomique : un seul exécuteur traite une relance.
    const claim = await db.followUp.updateMany({ where: { id: f.id, status: "pending" }, data: { status: "running" } });
    if (claim.count === 0) continue;
    sum.processed++;
    const finish = (status: string, result: string) => db.followUp.update({ where: { id: f.id }, data: { status, result, executedAt: new Date() } });
    try {
      const lead = f.lead;
      if (lead.deletedAt || (TERMINAL_STATUSES as string[]).includes(lead.status) || (lead.unsubscribedAt && f.action === "email")) {
        await finish("cancelled", "Prospect clos ou désinscrit."); sum.cancelled++; continue;
      }
      const step = (f.payload ?? {}) as Step;
      switch (f.action) {
        case "email": {
          const subject = renderTemplate(step.subject ?? "Suivi de votre demande", lead);
          const body = renderTemplate(step.body ?? "", lead);
          if (!f.sequence?.sendEmails) {
            // Envoi réel non autorisé pour cette séquence : une tâche manuelle est créée, rien n'est simulé.
            await db.task.create({ data: { workspaceId: f.workspaceId, leadId: lead.id, title: `Envoyer manuellement : ${subject}`, description: body, dueAt: now, source: "followup" } });
            await finish("blocked", "Envoi automatique d'e-mails non activé pour cette séquence : tâche manuelle créée."); sum.blocked++; break;
          }
          const r = await sendFollowUpEmail({ workspaceId: f.workspaceId, leadId: lead.id, subject, body });
          if (r.sent) {
            await db.conversation.create({ data: { workspaceId: f.workspaceId, leadId: lead.id, channel: "email", direction: "outbound", subject, body } });
            await db.leadActivity.create({ data: { workspaceId: f.workspaceId, leadId: lead.id, type: "email", data: { subject, auto: true } } });
            await finish("done", "E-mail envoyé."); sum.done++;
          } else {
            await db.task.create({ data: { workspaceId: f.workspaceId, leadId: lead.id, title: `Relance e-mail non envoyée : ${subject}`, description: `${r.reason}\n\n${body}`, dueAt: now, source: "followup" } });
            await finish("blocked", r.reason ?? "Envoi refusé."); sum.blocked++;
          }
          break;
        }
        case "task": {
          await db.task.create({ data: { workspaceId: f.workspaceId, leadId: lead.id, title: renderTemplate(step.title ?? "Relancer le prospect", lead), description: step.body ? renderTemplate(step.body, lead) : null, dueAt: now, source: "followup" } });
          await db.leadActivity.create({ data: { workspaceId: f.workspaceId, leadId: lead.id, type: "task", data: { auto: true } } });
          await finish("done", "Tâche créée."); sum.done++; break;
        }
        case "reminder": {
          await db.notification.create({ data: { workspaceId: f.workspaceId, type: "reminder", title: renderTemplate(step.title ?? "Rappel de relance", lead), href: `/leads/${lead.id}` } });
          await finish("done", "Rappel émis."); sum.done++; break;
        }
        case "status_change": {
          if (!step.status) { await finish("failed", "Étape sans statut cible."); sum.failed++; break; }
          const { changeLeadStatus } = await import("./leads");
          await changeLeadStatus({ workspaceId: f.workspaceId, leadId: lead.id, status: step.status, lostReason: step.status === "lost" ? "Aucune réponse à la séquence de relance" : undefined });
          await finish("done", `Statut passé à « ${step.status} ».`); sum.done++; break;
        }
        default:
          await finish("failed", "Action inconnue."); sum.failed++;
      }
    } catch (e) {
      log.error("followup.failed", { id: f.id, error: errMsg(e) });
      await finish("failed", errMsg(e).slice(0, 200)); sum.failed++;
    }
  }
  return sum;
}
