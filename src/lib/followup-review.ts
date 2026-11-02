import { db } from "./db";
import { audit } from "./audit";
import { createActivityOnce, createTaskOnce, leaseEnd, newLeaseToken, runTx, TxAbort, type Tx } from "./followup-runtime";
import { cancelPendingFollowUps, renderTemplate, type Step } from "./followups";
import { LeadError, LeadStatusConflict, applyLeadStatusChange } from "./leads";
import { runEmailFollowUp } from "./followup-send";
import type { RunOutcome } from "./followup-runtime";

/**
 * Résolution HUMAINE des relances à examiner (e-mail incertain, échec technique persistant, anciennes lignes « running » sans bail).
 * Réservée aux administrateurs (permission « approve_outreach », vérifiée par l'action serveur). Chaque résolution est une transaction dont la PREMIÈRE
 * instruction est une mise à jour conditionnelle sur l'état vu par l'administrateur : une résolution concurrente n'est jamais écrasée.
 * Séparation stricte : le résultat du fournisseur (EmailLog.status) n'est jamais modifié ici ; la décision humaine vit dans des colonnes distinctes (humanVerdict…).
 * Aucune résolution ne renvoie un e-mail sans avertissement et confirmation explicites ; « Marquer envoyé » n'est jamais une acceptation du fournisseur.
 */

export class ReviewError extends Error {}

export const REVIEW_ACTIONS = ["finalize", "mark_sent", "mark_not_sent", "cancel", "resend", "replan", "apply_status", "ack_contradiction"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];

export const RESEND_TYPED_WORD = "RENVOYER";
export const ACK_TYPED_WORD = "COMPRIS";
export const NOTE_MIN = 15;
export const ACK_NOTE_MIN = 20;
/** Au-delà, la protection d'idempotence du fournisseur ne s'applique plus : avertissement renforcé. */
export const RESEND_WARN_MS = 24 * 3_600_000;
/**
 * Une tentative « attempting » dont l'appel a commencé depuis moins d'une minute peut encore aboutir (résultat tardif) : un renvoi immédiat risquerait un doublon que rien n'empêche techniquement.
 * Le délai de 60 s dépasse le délai maximal de l'appel (20 s). Il RÉDUIT le risque, il ne le supprime pas : le fournisseur a pu accepter une requête déjà abandonnée côté client.
 */
export const RESEND_MIN_WAIT_MS = 60_000;

type Attempt = { id: string; status: string; attemptNo: number | null; humanVerdict: string | null; contradictionAckAt: Date | null; authorizedAt: Date | null; callStartedAt: Date | null; payloadHash: string | null; finishedAt: Date | null; httpStatus: number | null; providerMessageId: string | null; error: string | null; humanVerdictAt: Date | null; humanNote: string | null; createdAt: Date; subject: string };

/** Contradiction (état dérivé, jamais stocké) entre le résultat du fournisseur et le verdict humain. */
export const hasContradiction = (a: Pick<Attempt, "status" | "humanVerdict">) =>
  (a.humanVerdict === "confirmed_not_sent" && a.status === "sent") || (a.humanVerdict === "confirmed_sent" && (a.status === "failed" || a.status === "aborted"));

export type ReviewItem = {
  id: string; action: string; status: string; result: string | null; failureKind: string | null; attemptCount: number; technicalFailureCount: number; lastAttemptAt: Date | null; dueAt: Date;
  legacy: boolean; leadId: string; leadName: string; sequenceName: string | null; attempts: Attempt[]; contradiction: Attempt | null;
};

export async function listReviewItems(workspaceId: string): Promise<ReviewItem[]> {
  const rows = await db.followUp.findMany({
    where: { workspaceId, OR: [{ status: "needs_review" }, { status: "running", leaseToken: null }] },
    include: { lead: { select: { id: true, name: true } }, sequence: { select: { name: true } } }, orderBy: { dueAt: "asc" }, take: 50,
  });
  if (!rows.length) return [];
  const logs = await db.emailLog.findMany({ where: { followUpId: { in: rows.map((r) => r.id) } }, orderBy: { attemptNo: "asc" } });
  return rows.map((r) => {
    const attempts = logs.filter((l) => l.followUpId === r.id);
    return {
      id: r.id, action: r.action, status: r.status, result: r.result, failureKind: r.failureKind, attemptCount: r.attemptCount, technicalFailureCount: r.technicalFailureCount, lastAttemptAt: r.lastAttemptAt, dueAt: r.dueAt,
      legacy: r.status === "running" && !r.leaseToken, leadId: r.lead.id, leadName: r.lead.name, sequenceName: r.sequence?.name ?? null, attempts, contradiction: attempts.find((a) => hasContradiction(a) && !a.contradictionAckAt) ?? null,
    };
  });
}

/** Contradictions non acquittées de l'espace (relances déjà résolues comprises). */
export async function listContradictions(workspaceId: string) {
  const rows = await db.emailLog.findMany({ where: { workspaceId, followUpId: { not: null }, humanVerdict: { not: null }, contradictionAckAt: null }, orderBy: { createdAt: "desc" }, take: 50 });
  return rows.filter(hasContradiction);
}

export type ResolveInput = {
  workspaceId: string; userId: string; id: string; action: ReviewAction;
  note?: string; confirm?: boolean; typed?: string;
  /** état vu par l'administrateur au moment de l'affichage */
  seen: { attemptCount: number; emailStatus?: string | null };
  /** tentative visée (acquittement d'une contradiction) */
  attemptId?: string;
  now?: Date;
};

const stale = () => new ReviewError("L'état de la relance a changé depuis l'affichage : réexaminez-la avant d'agir.");

export async function resolveFollowUp(p: ResolveInput): Promise<{ message: string }> {
  const now = p.now ?? new Date();
  const f = await db.followUp.findFirst({ where: { id: p.id, workspaceId: p.workspaceId }, include: { lead: true, sequence: true } });
  if (!f) throw new ReviewError("Relance introuvable.");
  const attempts = (await db.emailLog.findMany({ where: { followUpId: f.id }, orderBy: { attemptNo: "asc" } })) as Attempt[];
  const real = attempts.filter((a) => a.status !== "aborted");
  const last = real[real.length - 1] ?? null;
  const legacy = f.status === "running" && !f.leaseToken;
  const note = (p.note ?? "").trim();
  const step = (f.payload ?? {}) as Step;
  const subject = renderTemplate(step.subject ?? "Suivi de votre demande", f.lead);
  const body = renderTemplate(step.body ?? "", f.lead);
  const isEmail = f.action === "email";

  if (p.action === "ack_contradiction") {
    const a = attempts.find((x) => x.id === p.attemptId);
    if (!a || !hasContradiction(a)) throw new ReviewError("Aucune contradiction à acquitter pour cette tentative.");
    if (a.contradictionAckAt) throw new ReviewError("Cette contradiction a déjà été acquittée.");
    if (note.length < ACK_NOTE_MIN) throw new ReviewError(`Une note d'au moins ${ACK_NOTE_MIN} caractères citant la preuve (identifiant fournisseur, journal de livraison) est requise.`);
    if (!p.confirm || (p.typed ?? "").trim().toUpperCase() !== ACK_TYPED_WORD) throw new ReviewError(`Cochez la confirmation et saisissez « ${ACK_TYPED_WORD} ».`);
    // Prospect effacé (avant ou pendant l'écriture) : l'acquittement est enregistré, mais la note libre n'est pas conservée.
    const ack = { contradictionAckAt: now, contradictionAckById: p.userId };
    let r = await db.emailLog.updateMany({ where: { id: a.id, workspaceId: p.workspaceId, contradictionAckAt: null, lead: { is: { deletedAt: null } } }, data: { ...ack, contradictionAckNote: note.slice(0, 1000) } });
    if (r.count === 0) r = await db.emailLog.updateMany({ where: { id: a.id, workspaceId: p.workspaceId, contradictionAckAt: null }, data: { ...ack, contradictionAckNote: null } });
    if (r.count !== 1) throw stale();
    await audit({ workspaceId: p.workspaceId, userId: p.userId, action: "email.contradiction_acknowledged", entity: "EmailLog", entityId: a.id, meta: { followUpId: f.id } });
    return { message: "Contradiction acquittée. Aucun renvoi n'est ouvert par cet acquittement." };
  }

  if (f.status !== "needs_review" && !legacy) throw new ReviewError("Cette relance n'est plus à examiner.");
  if (f.attemptCount !== p.seen.attemptCount || (last?.status ?? null) !== (p.seen.emailStatus ?? null)) throw stale();
  if (real.some((a) => hasContradiction(a) && !a.contradictionAckAt)) throw new ReviewError("Une contradiction entre le verdict humain et le résultat du fournisseur doit d'abord être acquittée.");
  const fState = { id: f.id, workspaceId: p.workspaceId, status: f.status, attemptCount: f.attemptCount, ...(legacy ? { leaseToken: null } : {}) };
  const verdictable = !!last && (last.status === "attempting" || last.status === "uncertain") && !last.humanVerdict;
  const audited = async (mode: string, extra: Record<string, unknown> = {}) =>
    audit({ workspaceId: p.workspaceId, userId: p.userId, action: "followup.resolved", entity: "FollowUp", entityId: f.id, meta: { mode, legacy, emailLogId: last?.id ?? null, emailStatus: last?.status ?? null, ...extra } });

  switch (p.action) {
    case "cancel": {
      if (last?.status === "sent") throw new ReviewError("L'e-mail a été accepté par le fournisseur : finalisez la relance au lieu de l'annuler.");
      const r = await db.followUp.updateMany({ where: fState, data: { status: "cancelled", result: "Annulée par un administrateur.", executedAt: now, failureKind: null, leaseToken: null, leaseUntil: null, retryAfter: null } });
      if (r.count !== 1) throw stale();
      await audited("cancel");
      return { message: "Relance annulée." };
    }
    case "finalize": {
      if (!isEmail || last?.status !== "sent" || f.status !== "needs_review") throw new ReviewError("Seule une relance dont l'e-mail a été accepté par le fournisseur peut être finalisée sans renvoi.");
      if (last.humanVerdict) throw new ReviewError("Un verdict humain existe déjà pour cette tentative.");
      const out = await runTx<"ok" | "stale">(async (tx) => {
        const r = await tx.followUp.updateMany({ where: fState, data: { status: "done", result: "E-mail envoyé (acceptation du fournisseur confirmée ; finalisation par un administrateur).", executedAt: now, failureKind: null } });
        if (r.count !== 1) throw new TxAbort("stale" as const);
        const e = await tx.emailLog.count({ where: { id: last.id, status: "sent" } });
        if (e !== 1) throw new TxAbort("stale" as const);
        await sentEffects(tx, f, subject, body, true);
        return "ok" as const;
      });
      if (out !== "ok") throw stale();
      await audited("finalize");
      return { message: "Relance finalisée : l'e-mail avait été accepté par le fournisseur, rien n'est renvoyé." };
    }
    case "mark_sent":
    case "mark_not_sent": {
      if (!isEmail) throw new ReviewError("Cette action concerne uniquement les relances par e-mail.");
      if (isEmail && real.length && !verdictable) throw new ReviewError(last?.status === "sent" ? "L'e-mail a été accepté par le fournisseur : utilisez « Finaliser »." : "Cette tentative a déjà un résultat définitif ou un verdict humain.");
      const sent = p.action === "mark_sent";
      if (note.length < NOTE_MIN) throw new ReviewError(`Une note d'au moins ${NOTE_MIN} caractères documentant la vérification (identifiant fournisseur, boîte de réception…) est requise.`);
      if (!p.confirm) throw new ReviewError(sent ? "Cochez la confirmation : vous attestez avoir vérifié que l'e-mail a bien été envoyé." : "Cochez la confirmation : vous attestez avoir vérifié que l'e-mail n'a pas été envoyé.");
      const out = await runTx<"ok" | "stale">(async (tx) => {
        const r = await tx.followUp.updateMany({
          where: fState,
          data: sent
            ? { status: "done", result: "E-mail confirmé envoyé par un administrateur (vérification humaine, non confirmée par le fournisseur).", executedAt: now, failureKind: null, leaseToken: null, leaseUntil: null }
            : { status: "blocked", result: "E-mail déclaré non envoyé par un administrateur : tâche manuelle créée.", executedAt: now, failureKind: null, leaseToken: null, leaseUntil: null },
        });
        if (r.count !== 1) throw new TxAbort("stale" as const);
        if (last) {
          const e = await tx.emailLog.updateMany({
            where: { id: last.id, status: { in: ["attempting", "uncertain"] }, humanVerdict: null },
            data: { humanVerdict: sent ? "confirmed_sent" : "confirmed_not_sent", humanVerdictAt: now, humanVerdictById: p.userId, humanNote: note.slice(0, 1000) },
          });
          if (e.count !== 1) throw new TxAbort("stale" as const);
        }
        if (sent) await sentEffects(tx, f, subject, body, false);
        else await createTaskOnce(tx, f.id, { workspaceId: f.workspaceId, leadId: f.leadId, title: `Relance e-mail non envoyée : ${subject}`, description: `Déclaré non envoyé après vérification.\n\n${body}`, dueAt: now });
        return "ok" as const;
      });
      if (out !== "ok") throw stale();
      await audited(sent ? "mark_sent" : "mark_not_sent");
      return { message: sent ? "Relance marquée comme envoyée (confirmation humaine)." : "Relance marquée comme non envoyée : une tâche manuelle a été créée." };
    }
    case "replan": {
      if (f.failureKind === "status_progressed") throw new ReviewError("Le prospect a progressé : une replanification re-bloquerait aussitôt la relance. Appliquez le statut (décision documentée) ou annulez la relance.");
      const noExternalEffect = !isEmail || real.length === 0;
      if (!noExternalEffect) throw new ReviewError("Un e-mail incertain ne peut pas être replanifié : marquez-le envoyé ou non envoyé, ou renvoyez-le avec confirmation.");
      if (isEmail && legacy) throw new ReviewError("Une ancienne relance e-mail ne peut pas être replanifiée : vérifiez chez le fournisseur puis marquez-la envoyée ou non envoyée.");
      if (!f.sequenceId) throw new ReviewError("La séquence a été supprimée : annulez la relance.");
      if (legacy && !p.confirm) throw new ReviewError("Cochez la confirmation : une tâche ou un rappel déjà créé avant l'interruption pourrait être dupliqué.");
      const out = await runTx<"ok" | "stale" | "inactive">(async (tx) => {
        // tout état « pending » naît sous le verrou de la séquence
        const s = await tx.followUpSequence.updateMany({ where: { id: f.sequenceId!, workspaceId: p.workspaceId, active: true }, data: { updatedAt: new Date() } });
        if (s.count !== 1) throw new TxAbort("inactive" as const);
        const r = await tx.followUp.updateMany({ where: fState, data: { status: "pending", attemptCount: 0, technicalFailureCount: 0, retryAfter: null, failureKind: null, leaseToken: null, leaseUntil: null, result: "Replanifiée par un administrateur." } });
        if (r.count !== 1) throw new TxAbort("stale" as const);
        return "ok" as const;
      });
      if (out === "inactive") throw new ReviewError("La séquence est inactive : réactivez-la ou annulez la relance.");
      if (out !== "ok") throw stale();
      await audited("replan");
      return { message: "Relance replanifiée : elle sera exécutée au prochain passage." };
    }
    case "apply_status": {
      if (f.action !== "status_change" || f.status !== "needs_review" || !["status_progressed", "status_conflict"].includes(f.failureKind ?? "")) throw new ReviewError("Cette action concerne uniquement un changement de statut automatique non appliqué (progression ou conflit).");
      if (!step.status) throw new ReviewError("L'étape n'a pas de statut cible.");
      if (note.length < NOTE_MIN) throw new ReviewError(`Une note d'au moins ${NOTE_MIN} caractères justifiant l'application du statut malgré la progression ou le conflit est requise.`);
      if (!p.confirm) throw new ReviewError(`Cochez la confirmation : vous décidez d'appliquer le statut « ${step.status} » au prospect.`);
      const target = step.status;
      const out = await runTx<{ changed: boolean; terminal: boolean; from: string } | "stale">(async (tx) => {
        const r = await tx.followUp.updateMany({ where: fState, data: { status: "done", result: `Statut « ${target} » appliqué par un administrateur après examen (${f.failureKind}).`, executedAt: now, failureKind: null, leaseToken: null, leaseUntil: null } });
        if (r.count !== 1) throw new TxAbort("stale" as const);
        try {
          const sr = await applyLeadStatusChange(tx, { workspaceId: p.workspaceId, leadId: f.leadId, status: target, actorId: p.userId, lostReason: target === "lost" ? `Décision humaine après examen : ${note}`.slice(0, 300) : undefined });
          return { changed: sr.changed, terminal: sr.terminal, from: sr.from };
        } catch (e) {
          if (e instanceof LeadStatusConflict) throw new TxAbort("stale" as const);
          if (e instanceof LeadError) throw new TxAbort("stale" as const);
          throw e;
        }
      });
      if (out === "stale") throw stale();
      // effets hors transaction (connexion globale) : annulation des étapes restantes si le statut est terminal, puis audit — sans donnée personnelle
      if (out.changed && out.terminal) await cancelPendingFollowUps(p.workspaceId, f.leadId, `Statut « ${target} » : relances arrêtées.`);
      if (out.changed) await audit({ workspaceId: p.workspaceId, userId: p.userId, action: "lead.status_changed", entity: "Lead", entityId: f.leadId, meta: { from: out.from, to: target, source: "followup_review" } });
      await audited("apply_status", { from: out.from, to: target, changed: out.changed });
      return { message: out.changed ? `Statut « ${target} » appliqué au prospect (décision humaine documentée).` : "Le prospect avait déjà ce statut : la relance est finalisée sans modification." };
    }
    case "resend": {
      if (!isEmail || legacy) throw new ReviewError("Le renvoi n'est possible que pour un e-mail incertain d'une relance à examiner.");
      if (!verdictable || !last) throw new ReviewError("Le renvoi n'est possible que si le résultat de l'envoi est incertain et sans verdict humain.");
      if (!f.sequence || !f.sequence.active || !f.sequence.sendEmails) throw new ReviewError("La séquence est supprimée, inactive ou n'autorise plus l'envoi d'e-mails.");
      if (last.status === "attempting" && last.callStartedAt && now.getTime() - last.callStartedAt.getTime() < RESEND_MIN_WAIT_MS) throw new ReviewError("La tentative précédente a pu commencer il y a moins d'une minute et son résultat peut encore arriver : attendez au moins une minute avant de renvoyer.");
      if (!p.confirm) throw new ReviewError("Cochez la confirmation : vous avez vérifié que l'e-mail n'a pas été reçu et acceptez le risque de doublon.");
      const since = last.authorizedAt ?? last.createdAt;
      const overWindow = now.getTime() - since.getTime() > RESEND_WARN_MS;
      if (overWindow && (p.typed ?? "").trim().toUpperCase() !== RESEND_TYPED_WORD) throw new ReviewError(`Plus de 24 h se sont écoulées : la protection du fournisseur contre les doublons ne s'applique plus. Saisissez « ${RESEND_TYPED_WORD} » pour confirmer.`);
      // réservation manuelle : needs_review → running (nouveau jeton), hors plafond, puis chemin d'envoi normal (autorisation, contrôles, marque d'appel, résultat)
      const token = newLeaseToken();
      const claim = await db.followUp.updateMany({ where: { ...fState, status: "needs_review" }, data: { status: "running", leaseToken: token, leaseUntil: leaseEnd(now), failureKind: null } });
      if (claim.count !== 1) throw stale();
      await audited("resend", { overWindow });
      const row = await db.followUp.findUnique({ where: { id: f.id }, include: { lead: true, sequence: true } });
      if (!row) throw stale();
      const outcome = await runEmailFollowUp({ row, token, now, subject, body, manual: true });
      // audit du RÉSULTAT (en complément de l'audit d'intention) : identifiants et états seulement, jamais d'adresse
      const latest = await db.emailLog.findFirst({ where: { followUpId: f.id }, orderBy: { attemptNo: "desc" }, select: { id: true, attemptNo: true, status: true, httpStatus: true } });
      await audit({ workspaceId: p.workspaceId, userId: p.userId, action: "followup.resend_result", entity: "FollowUp", entityId: f.id, meta: { outcome, emailLogId: latest?.id ?? null, attemptNo: latest?.attemptNo ?? null, emailStatus: latest?.status ?? null, httpStatus: latest?.httpStatus ?? null } });
      return { message: resendMessage(outcome) };
    }
  }
}

/** Message affiché après un renvoi : décrit la transition RÉELLEMENT effectuée (jamais un état interne). Ne promet aucune absence de doublon. */
export function resendMessage(outcome: RunOutcome): string {
  switch (outcome) {
    case "done": return "E-mail renvoyé : accepté par le fournisseur. Un doublon reste possible si la tentative précédente avait en réalité abouti.";
    case "needs_review": return "Résultat du renvoi incertain : l'e-mail a peut-être été accepté. La relance reste à examiner ; aucun renvoi automatique.";
    case "blocked": return "Renvoi non effectué : l'e-mail n'a pas été envoyé (refus explicite du fournisseur ou prospect devenu non éligible) ; une tâche manuelle a été créée.";
    case "cancelled": return "Renvoi non effectué : la séquence ou le prospect n'est plus éligible, la relance a été annulée.";
    case "requeued": return "Renvoi abandonné avant l'appel au fournisseur (aucun e-mail envoyé) : la relance sera réexaminée.";
    case "exhausted": return "Renvoi non effectué : le plafond d'autorisations de la relance est atteint.";
    case "failed": return "Renvoi en échec : aucun e-mail n'a été envoyé.";
    default: return "Le renvoi n'a pas été finalisé : l'état de la relance a changé pendant l'opération ; vérifiez-la.";
  }
}

async function sentEffects(tx: Tx, row: { id: string; workspaceId: string; leadId: string }, subject: string, body: string, auto: boolean) {
  const convId = `fuv:${row.id}`;
  if (!(await tx.conversation.findUnique({ where: { id: convId }, select: { id: true } }))) {
    await tx.conversation.create({ data: { id: convId, workspaceId: row.workspaceId, leadId: row.leadId, channel: "email", direction: "outbound", subject, body } });
  }
  await createActivityOnce(tx, `fua:${row.id}`, { workspaceId: row.workspaceId, leadId: row.leadId, type: "email", data: { subject, auto } });
}

/** Réconciliation automatique : une relance « needs_review » dont une tentative est « sent » (acceptation tardive enregistrée) est finalisée SANS renvoi, si aucun verdict humain n'existe. */
export async function reconcileAcceptedReviews(now = new Date(), workspaceId?: string): Promise<number> {
  const rows = await db.followUp.findMany({ where: { status: "needs_review", action: "email", failureKind: "email_uncertain", ...(workspaceId ? { workspaceId } : {}) }, include: { lead: true }, take: 100 });
  let n = 0;
  for (const f of rows) {
    const logs = await db.emailLog.findMany({ where: { followUpId: f.id }, orderBy: { attemptNo: "asc" } });
    const sent = logs.find((l) => l.status === "sent" && !l.humanVerdict);
    if (!sent || logs.some((l) => l.humanVerdict)) continue;
    const step = (f.payload ?? {}) as Step;
    const subject = renderTemplate(step.subject ?? "Suivi de votre demande", f.lead);
    const body = renderTemplate(step.body ?? "", f.lead);
    const out = await runTx<boolean>(async (tx) => {
      const r = await tx.followUp.updateMany({ where: { id: f.id, status: "needs_review", failureKind: "email_uncertain" }, data: { status: "done", result: "E-mail envoyé (acceptation tardive du fournisseur enregistrée).", executedAt: now, failureKind: null } });
      if (r.count !== 1) return false;
      await sentEffects(tx, f, subject, body, true);
      return true;
    });
    if (out) n++;
  }
  return n;
}
