import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { TERMINAL_STATUSES, FOLLOWUP_ACTIONS, LEAD_STATUSES, autoStatusChangeBlockedBy } from "./constants";
import { audit } from "./audit";
import { log, errMsg } from "./logger";
import { entitlementForWorkspace } from "./free-access";
import {
  LEASE_MS, MAX_TECHNICAL_FAILURES, SimulatedCrash, TxAbort, authorizeInTx, cancelInTx, createActivityOnce, createNotificationOnce, createTaskOnce, finishTx, leaseEnd,
  newLeaseToken, prismaCode, requeueTx, runTx, toNeedsReview, type Db, type FollowUpRow, type RunOutcome,
} from "./followup-runtime";
import { runEmailFollowUp } from "./followup-send";

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

type EnrollResult = { enrolled: boolean; reason?: string; count?: number };
const NOT_ENROLLED = "Séquence introuvable ou inactive.";

/**
 * Inscrit un prospect : crée un FollowUp planifié par étape. Refuse si le prospect est clos, désinscrit ou déjà inscrit, ou si la séquence n'est pas active.
 * La décision est prise dans UNE transaction : la séquence est verrouillée par une mise à jour conditionnelle sur `active = true` (désactivation et suppression sont
 * sérialisées avec elle), le prospect est verrouillé sans modifier `updatedAt`, les relances sont créées dans cette même transaction.
 * Ordre de verrouillage : Sequence → Lead (les relances sont des INSERTIONS : aucune relance existante n'est verrouillée).
 * Les statuts « pending », « running » et « needs_review » bloquent une nouvelle inscription à la même séquence.
 */
export async function enrollLead(p: { workspaceId: string; leadId: string; sequenceId: string; now?: Date }): Promise<EnrollResult> {
  const now = p.now ?? new Date();
  // Lectures préalables : messages précis. La décision autoritaire est celle de la transaction ci-dessous.
  const seq0 = await db.followUpSequence.findFirst({ where: { id: p.sequenceId, workspaceId: p.workspaceId } });
  if (!seq0 || !seq0.active) return { enrolled: false, reason: NOT_ENROLLED };
  const lead0 = await db.lead.findFirst({ where: { id: p.leadId, workspaceId: p.workspaceId, deletedAt: null } });
  if (!lead0) return { enrolled: false, reason: "Prospect introuvable." };
  if ((TERMINAL_STATUSES as string[]).includes(lead0.status)) return { enrolled: false, reason: "Le prospect est déjà clos (gagné, perdu ou disqualifié)." };
  if (lead0.unsubscribedAt) return { enrolled: false, reason: "Le prospect s'est désinscrit." };
  if (!parseSteps(seq0.steps).length) return { enrolled: false, reason: "La séquence ne contient aucune étape valide." };

  try {
    return await runTx<EnrollResult>(async (tx) => {
      const refuse = (reason: string) => new TxAbort<EnrollResult>({ enrolled: false, reason });
      const s = await tx.followUpSequence.updateMany({ where: { id: p.sequenceId, workspaceId: p.workspaceId, active: true }, data: { updatedAt: new Date() } });
      if (s.count !== 1) throw refuse(NOT_ENROLLED);
      const lead = await tx.lead.findFirst({ where: { id: p.leadId, workspaceId: p.workspaceId, deletedAt: null } });
      if (!lead) throw refuse("Prospect introuvable.");
      if ((TERMINAL_STATUSES as string[]).includes(lead.status)) throw refuse("Le prospect est déjà clos (gagné, perdu ou disqualifié).");
      if (lead.unsubscribedAt) throw refuse("Le prospect s'est désinscrit.");
      // verrou du prospect sans changer `updatedAt` (valeur identique) : un retrait ou un effacement concurrent est sérialisé avec l'inscription
      const cas = await tx.lead.updateMany({
        where: { id: lead.id, workspaceId: p.workspaceId, updatedAt: lead.updatedAt, deletedAt: null, unsubscribedAt: null, status: { notIn: TERMINAL_STATUSES } },
        data: { updatedAt: lead.updatedAt },
      });
      if (cas.count !== 1) throw refuse("Le prospect vient d'être modifié : réessayez.");
      const scope = { workspaceId: p.workspaceId, leadId: lead.id, sequenceId: p.sequenceId };
      if (await tx.followUp.count({ where: { ...scope, status: "needs_review" } })) throw refuse("Une relance de cette séquence est à examiner : résolvez-la avant de réinscrire ce prospect.");
      if (await tx.followUp.count({ where: { ...scope, status: { in: ["pending", "running"] } } })) throw refuse("Déjà inscrit à cette séquence.");
      const seq = await tx.followUpSequence.findUnique({ where: { id: p.sequenceId } });
      const steps = parseSteps(seq?.steps);
      if (!seq || !steps.length) throw refuse("La séquence ne contient aucune étape valide.");
      // Identifiants déterministes (séquence:lead:génération:étape) : un doublon violerait la clé primaire (second filet derrière le verrou de la séquence).
      const generation = await tx.followUp.count({ where: scope });
      await tx.followUp.createMany({
        data: steps.map((st, idx) => ({
          id: `fu:${seq.id}:${lead.id}:${generation}:${idx}`, workspaceId: p.workspaceId, leadId: lead.id, sequenceId: seq.id, stepIndex: idx, action: st.action, payload: st as unknown as Prisma.InputJsonValue,
          dueAt: new Date(now.getTime() + st.day * 86_400_000), status: "pending",
        })),
      });
      await createActivityOnce(tx, `fue:${seq.id}:${lead.id}:${generation}`, { workspaceId: p.workspaceId, leadId: lead.id, type: "followup", data: { sequence: seq.name, steps: steps.length } });
      return { enrolled: true, count: steps.length };
    });
  } catch (e) {
    const code = prismaCode(e);
    if (code === "P2002") return { enrolled: false, reason: "Déjà inscrit à cette séquence." };
    if (code === "P2003") return { enrolled: false, reason: NOT_ENROLLED };
    throw e;
  }
}

export async function cancelPendingFollowUps(workspaceId: string, leadId: string, reason: string) {
  const r = await db.followUp.updateMany({ where: { workspaceId, leadId, status: { in: ["pending", "blocked"] } }, data: { status: "cancelled", result: reason, executedAt: new Date() } });
  return r.count;
}

/**
 * Révocation (désinscription, effacement) : annule TOUTES les relances du prospect, y compris « running » et « needs_review ». Pour une relance en cours le jeton de bail
 * est effacé : l'exécuteur ne peut plus finaliser ni produire d'effet en base (la finalisation et les contrôles conditionnels échouent). À appeler comme PREMIÈRE
 * instruction de la transaction qui retire le consentement ou efface le prospect (ordre Sequence → FollowUp → Lead).
 * Un e-mail dont l'appel est déjà commencé ne peut pas être rappelé : son résultat sera enregistré dans sa tentative et tracé (email.sent_after_revocation).
 */
export async function revokeLeadFollowUps(client: Pick<Db, "followUp">, workspaceId: string, leadId: string, reason: string, now = new Date()) {
  const r = await client.followUp.updateMany({
    where: { workspaceId, leadId, status: { in: ["pending", "blocked", "needs_review", "running"] } },
    data: { status: "cancelled", result: reason, executedAt: now, failureKind: "revoked", leaseToken: null, leaseUntil: null, retryAfter: null },
  });
  return r.count;
}

export type SequenceSaveData = { name: string; description: string | null; steps: Prisma.InputJsonValue; active: boolean; autoEnroll: boolean; sendEmails: boolean };

/**
 * T5 — modification d'une séquence. La séquence est mise à jour (verrou de ligne) ; si elle devient inactive, ses relances « pending » et « blocked » sont annulées dans la
 * MÊME transaction (ordre Séquence → Relance). Une relance « running » n'est pas annulée aveuglément : son exécuteur contrôle la séquence sous verrou avant tout effet ;
 * une relance « needs_review » est conservée pour examen humain. Renvoie faux si la séquence est introuvable.
 */
export async function updateSequence(workspaceId: string, id: string, data: SequenceSaveData): Promise<boolean> {
  return runTx<boolean>(async (tx) => {
    const u = await tx.followUpSequence.updateMany({ where: { id, workspaceId }, data });
    if (!u.count) throw new TxAbort(false);
    if (!data.active) {
      await tx.followUp.updateMany({ where: { workspaceId, sequenceId: id, status: { in: ["pending", "blocked"] } }, data: { status: "cancelled", result: "Séquence désactivée.", executedAt: new Date(), failureKind: "sequence_inactive", retryAfter: null } });
    }
    return true;
  });
}

/**
 * T5 — suppression d'une séquence : désactivation (verrou), annulation des relances « pending » et « blocked », puis suppression, dans UNE transaction.
 * Les relances restantes passent à `sequenceId = NULL` (onDelete: SetNull) : une relance « running » est annulée par son exécuteur (séquence introuvable),
 * une relance « needs_review » reste visible pour examen.
 */
export async function deleteSequence(workspaceId: string, id: string): Promise<void> {
  await runTx<void>(async (tx) => {
    const u = await tx.followUpSequence.updateMany({ where: { id, workspaceId }, data: { active: false } });
    if (!u.count) return;
    await tx.followUp.updateMany({ where: { workspaceId, sequenceId: id, status: { in: ["pending", "blocked"] } }, data: { status: "cancelled", result: "Séquence supprimée.", executedAt: new Date(), failureKind: "sequence_inactive", retryAfter: null } });
    await tx.followUpSequence.deleteMany({ where: { id, workspaceId } });
  });
}

export type ProcessSummary = { processed: number; done: number; blocked: number; failed: number; cancelled: number; needsReview: number; requeued: number; lost: number; deferred: number };
const emptySummary = (): ProcessSummary => ({ processed: 0, done: 0, blocked: 0, failed: 0, cancelled: 0, needsReview: 0, requeued: 0, lost: 0, deferred: 0 });

function count(sum: ProcessSummary, o: RunOutcome) {
  switch (o) {
    case "done": sum.done++; break;
    case "blocked": sum.blocked++; break;
    case "failed": case "exhausted": sum.failed++; break;
    case "cancelled": sum.cancelled++; break;
    case "needs_review": sum.needsReview++; break;
    case "requeued": sum.requeued++; break;
    case "lost": sum.lost++; break;
  }
}

const dueWhere = (now: Date): Prisma.FollowUpWhereInput => ({ status: "pending", dueAt: { lte: now }, OR: [{ retryAfter: null }, { retryAfter: { lte: now } }] });
const expiredWhere = (now: Date): Prisma.FollowUpWhereInput => ({ status: "running", leaseToken: { not: null }, leaseUntil: { lt: now } });

/** Marge de temps minimale (ms) requise avant de commencer une relance quand un délai global est imposé (appel fournisseur ≤ 20 s + écritures). */
export const ITEM_RESERVE_MS = 30_000;

/**
 * Exécute les relances arrivées à échéance et reprend celles dont le bail a expiré (jamais les anciennes lignes « running » sans jeton).
 * Un e-mail n'est JAMAIS envoyé sans configuration + consentement explicites, ni renvoyé automatiquement s'il a pu partir.
 * `deadlineAt` (ms) : aucune relance n'est commencée si le temps restant est inférieur à la marge (les autres restent en attente).
 */
export async function processDueFollowUps(opts: { workspaceId?: string; now?: Date; limit?: number; deadlineAt?: number } = {}): Promise<ProcessSummary> {
  const now = opts.now ?? new Date();
  const scope = opts.workspaceId ? { workspaceId: opts.workspaceId } : {};
  // Exécution = droit du forfait : un espace sans abonnement actif (essai expiré, abonnement terminé, impayé hors délai) n'exécute AUCUNE relance
  // (ni e-mail, ni tâche, ni reprise). Ses relances restent en attente et reprennent à la réactivation ; elles sont exclues de la requête pour ne pas
  // occuper la fenêtre de traitement des autres espaces.
  const [dueWs, expiredWs] = await Promise.all([
    db.followUp.findMany({ where: { ...dueWhere(now), ...scope }, distinct: ["workspaceId"], select: { workspaceId: true } }),
    db.followUp.findMany({ where: { ...expiredWhere(now), ...scope }, distinct: ["workspaceId"], select: { workspaceId: true } }),
  ]);
  const candidates = [...new Set([...dueWs, ...expiredWs].map((c) => c.workspaceId))];
  const subs = new Map((await db.subscription.findMany({ where: { workspaceId: { in: candidates } } })).map((s) => [s.workspaceId, s]));
  const inactive: string[] = [];
  for (const id of candidates) if (!(await entitlementForWorkspace(id, subs.get(id) ?? null)).active) inactive.push(id);
  if (opts.workspaceId && inactive.includes(opts.workspaceId)) return emptySummary();
  const wsFilter = opts.workspaceId ? scope : inactive.length ? { workspaceId: { notIn: inactive } } : {};
  const limit = opts.limit ?? 200;
  const due = await db.followUp.findMany({ where: { ...dueWhere(now), ...wsFilter }, orderBy: { dueAt: "asc" }, take: limit, select: { id: true, leaseToken: true, leaseUntil: true } });
  const expired = limit - due.length > 0
    ? await db.followUp.findMany({ where: { ...expiredWhere(now), ...wsFilter }, orderBy: { leaseUntil: "asc" }, take: limit - due.length, select: { id: true, leaseToken: true, leaseUntil: true } })
    : [];
  const sum = emptySummary();

  const items = [...due.map((x) => ({ ...x, takeover: false })), ...expired.map((x) => ({ ...x, takeover: true }))];
  for (let i = 0; i < items.length; i++) {
    if (opts.deadlineAt !== undefined && opts.deadlineAt - Date.now() < ITEM_RESERVE_MS) { sum.deferred = items.length - i; break; }
    await processOne(items[i], now, sum);
  }
  return sum;
}

async function processOne(it: { id: string; leaseToken: string | null; leaseUntil: Date | null; takeover: boolean }, now: Date, sum: ProcessSummary) {
  const token = newLeaseToken();
  // Réservation atomique (un seul exécuteur) ; une reprise exige le jeton exact observé ET l'expiration du bail, et compte un abandon technique.
  const claim = it.takeover
    ? await db.followUp.updateMany({ where: { id: it.id, status: "running", leaseToken: it.leaseToken ?? "", leaseUntil: { lt: now } }, data: { leaseToken: token, leaseUntil: leaseEnd(now), technicalFailureCount: { increment: 1 } } })
    : await db.followUp.updateMany({ where: { id: it.id, ...dueWhere(now) }, data: { status: "running", leaseToken: token, leaseUntil: leaseEnd(now) } });
  if (claim.count === 0) return;
  sum.processed++;
  let row: FollowUpRow | null = null;
  try {
    // lecture FRAÎCHE après la réservation (jamais l'instantané de la sélection)
    row = await db.followUp.findUnique({ where: { id: it.id }, include: { lead: true, sequence: true } });
    if (!row || row.leaseToken !== token || row.status !== "running") { sum.lost++; return; }
    // début de la réservation abandonnée (le bail d'une action en base n'est jamais renouvelé avant l'autorisation) : référence d'un conflit de statut
    const reservedSince = it.takeover && it.leaseUntil ? new Date(it.leaseUntil.getTime() - LEASE_MS) : null;
    count(sum, await execute(row, token, now, it.takeover, reservedSince));
  } catch (e) {
    if (e instanceof SimulatedCrash) throw e;
    count(sum, await handleError(row, token, e, now));
  }
}

async function execute(row: FollowUpRow, token: string, now: Date, takeover: boolean, reservedSince: Date | null): Promise<RunOutcome> {
  const lead = row.lead;
  if (takeover && row.technicalFailureCount >= MAX_TECHNICAL_FAILURES) {
    const r = await toNeedsReview(row.id, row.workspaceId, token, now, "technical_persistent", `Échec technique persistant (${row.technicalFailureCount} échecs) : intervention requise.`);
    return r === "applied" ? "needs_review" : "lost";
  }
  if (lead.deletedAt || (TERMINAL_STATUSES as string[]).includes(lead.status) || (lead.unsubscribedAt && row.action === "email")) {
    const r = await finishTx(row.id, token, now, { status: "cancelled", result: "Prospect clos ou désinscrit." });
    return r === "applied" ? "cancelled" : "lost";
  }
  if (!row.sequence || !row.sequence.active) {
    const r = await finishTx(row.id, token, now, { status: "cancelled", result: "Séquence désactivée ou supprimée avant exécution.", failureKind: "sequence_inactive" });
    return r === "applied" ? "cancelled" : "lost";
  }
  const step = (row.payload ?? {}) as Step;
  switch (row.action) {
    case "email":
      return runEmailFollowUp({ row, token, now, subject: renderTemplate(step.subject ?? "Suivi de votre demande", lead), body: renderTemplate(step.body ?? "", lead) });
    case "task":
    case "reminder":
    case "status_change":
      return runDbAction(row, token, now, step, reservedSince);
    default: {
      const r = await finishTx(row.id, token, now, { status: "failed", result: "Action inconnue.", failureKind: "business" });
      return r === "applied" ? "failed" : "lost";
    }
  }
}

/**
 * T1 : tâche, rappel, changement de statut. UNE transaction : autorisation (séquence puis relance, plafond), effets, finalisation sous jeton.
 * Un arrêt ou une erreur laisse tout annulé (aucun effet partiel, aucun incrément) ; les identifiants déterministes sont un second filet.
 */
async function runDbAction(row: FollowUpRow, token: string, now: Date, step: Step, reservedSince: Date | null): Promise<RunOutcome> {
  const lead = row.lead;
  if (row.action === "status_change" && !step.status) {
    const r = await finishTx(row.id, token, now, { status: "failed", result: "Étape sans statut cible.", failureKind: "business" });
    return r === "applied" ? "failed" : "lost";
  }
  type Out = { k: "done"; result: string; status?: { workspaceId: string; leadId: string; terminal: boolean; changed: boolean; from: string; to: string } } | { k: "cancelled" | "exhausted" | "lost" }
    | { k: "conflict"; kind: string; from: string; to: string };
  const out = await runTx<Out>(async (tx) => {
    const a = await authorizeInTx(tx, row, token, now);
    if (a === "sequence_inactive") { await cancelInTx(tx, row.id, token, now, "Séquence désactivée ou supprimée avant exécution.", "sequence_inactive"); return { k: "cancelled" }; }
    if (a === "exhausted") return { k: "exhausted" };
    if (a === "lost") throw new TxAbort<Out>({ k: "lost" });
    let result = "";
    let status: Extract<Out, { k: "done" }>["status"];
    if (row.action === "task") {
      await createTaskOnce(tx, row.id, { workspaceId: row.workspaceId, leadId: lead.id, title: renderTemplate(step.title ?? "Relancer le prospect", lead), description: step.body ? renderTemplate(step.body, lead) : null, dueAt: now });
      await createActivityOnce(tx, `fua:${row.id}`, { workspaceId: row.workspaceId, leadId: lead.id, type: "task", data: { auto: true } });
      result = "Tâche créée.";
    } else if (row.action === "reminder") {
      await createNotificationOnce(tx, `fun:${row.id}`, { workspaceId: row.workspaceId, type: "reminder", title: renderTemplate(step.title ?? "Rappel de relance", lead), href: `/leads/${lead.id}` });
      result = "Rappel émis.";
    } else {
      const { applyLeadStatusChange, LeadStatusConflict } = await import("./leads");
      const target = step.status!;
      // Règle : une relance AUTOMATISÉE ne doit jamais écraser une progression commerciale déjà enregistrée (autoStatusChangeBlockedBy). Cas examinables, jamais appliqués :
      //  (1) progression incompatible : clôture d'un prospect déjà « qualified » ou « proposal », ou retour en arrière dans le pipeline → status_progressed ;
      //  (2) statut modifié depuis le début d'une réservation abandonnée (reprise après arrêt) ou entre sa lecture et son écriture (écriture conditionnelle) → status_conflict.
      // Le statut n'est PAS modifié, les informations existantes ne sont pas écrasées, la relance passe en « needs_review » : décision humaine (appliquer, annuler ou replanifier).
      const cur = await tx.lead.findFirst({ where: { id: lead.id, workspaceId: row.workspaceId, deletedAt: null }, select: { status: true } });
      let conflict: { kind: "status_progressed" | "status_conflict"; msg: string; from: string } | null = null;
      if (cur && cur.status !== target) {
        if (autoStatusChangeBlockedBy(cur.status, target)) {
          conflict = { kind: "status_progressed", from: cur.status, msg: `Le prospect a progressé (statut « ${cur.status} ») : le changement automatique vers « ${target} » n'est pas appliqué. Décision humaine requise.` };
        } else if (reservedSince && (await tx.leadActivity.count({ where: { workspaceId: row.workspaceId, leadId: lead.id, type: "status_changed", createdAt: { gt: reservedSince } } })) > 0) {
          conflict = { kind: "status_conflict", from: cur.status, msg: "Le statut du prospect a changé depuis la réservation interrompue : étape non appliquée, à examiner." };
        }
      }
      if (!conflict) {
        try {
          const r = await applyLeadStatusChange(tx, { workspaceId: row.workspaceId, leadId: lead.id, status: target, lostReason: target === "lost" ? "Aucune réponse à la séquence de relance" : undefined });
          status = { workspaceId: row.workspaceId, leadId: lead.id, terminal: r.terminal, changed: r.changed, from: r.from, to: target };
          result = `Statut passé à « ${target} ».`;
        } catch (e) {
          if (!(e instanceof LeadStatusConflict)) throw e;
          conflict = { kind: "status_conflict", from: cur?.status ?? "inconnu", msg: "Le statut du prospect a changé pendant le traitement : étape non appliquée, à examiner." };
        }
      }
      if (conflict) {
        const c = await tx.followUp.updateMany({ where: { id: row.id, leaseToken: token, status: "running" }, data: { status: "needs_review", failureKind: conflict.kind, result: conflict.msg, executedAt: now, leaseToken: null, leaseUntil: null, retryAfter: null } });
        if (c.count !== 1) throw new TxAbort<Out>({ k: "lost" });
        await createNotificationOnce(tx, `fur:${row.id}:${conflict.kind}`, { workspaceId: row.workspaceId, type: "followup_review", title: "Une relance est à examiner", body: conflict.msg, href: "/automations" });
        return { k: "conflict", kind: conflict.kind, from: conflict.from, to: target };
      }
    }
    const fin = await tx.followUp.updateMany({
      where: { id: row.id, leaseToken: token, status: "running" },
      data: { status: "done", result, executedAt: now, failureKind: null, leaseToken: null, leaseUntil: null, retryAfter: null },
    });
    if (fin.count !== 1) throw new TxAbort<Out>({ k: "lost" });
    return { k: "done", result, status };
  });
  if (out.k === "conflict") {
    // trace d'audit cohérente (identifiants et statuts seulement) ; le prospect n'a pas été modifié
    await audit({ workspaceId: row.workspaceId, action: "followup.status_not_applied", entity: "FollowUp", entityId: row.id, meta: { kind: out.kind, observedStatus: out.from, targetStatus: out.to } });
    return "needs_review";
  }
  if (out.k !== "done") return out.k === "cancelled" ? "cancelled" : out.k === "exhausted" ? "exhausted" : "lost";
  if (out.status?.changed) {
    // effets hors transaction (ils utilisent la connexion globale) : annulation des étapes restantes si le statut est terminal, puis audit
    if (out.status.terminal) await cancelPendingFollowUps(out.status.workspaceId, out.status.leadId, `Statut « ${out.status.to} » : relances arrêtées.`);
    await audit({ workspaceId: out.status.workspaceId, action: "lead.status_changed", entity: "Lead", entityId: out.status.leadId, meta: { from: out.status.from, to: out.status.to } });
  }
  return "done";
}

/**
 * Erreur survenue AVANT tout effet (les transactions sont annulées en bloc) : erreur métier → échec définitif ; sinon échec technique → report progressif.
 * Une erreur après l'appel fournisseur ne passe jamais ici : le chemin d'envoi enregistre lui-même un résultat incertain.
 */
async function handleError(row: FollowUpRow | null, token: string, e: unknown, now: Date): Promise<RunOutcome> {
  log.error("followup.failed", { id: row?.id, error: errMsg(e), code: prismaCode(e) });
  if (!row) return "lost";
  try {
    const { LeadError } = await import("./leads");
    if (e instanceof LeadError) {
      const r = await finishTx(row.id, token, now, { status: "failed", result: errMsg(e).slice(0, 200), failureKind: "business" });
      return r === "applied" ? "failed" : "lost";
    }
    return await requeueTx(row, token, now, "technical", `Erreur technique avant exécution : nouvelle tentative planifiée (${errMsg(e).slice(0, 120)}).`);
  } catch (e2) {
    if (e2 instanceof SimulatedCrash) throw e2;
    // la base est indisponible : le bail expirera et la relance sera reprise ; rien n'est inventé
    log.error("followup.requeue_failed", { id: row.id, error: errMsg(e2) });
    return "lost";
  }
}

