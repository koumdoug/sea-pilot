import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { env } from "./env";
import { TERMINAL_STATUSES } from "./constants";
import { audit } from "./audit";
import { log } from "./logger";
import { EmailError, prepareFollowUpEmail, storableProviderError, type PreparedEmail } from "./email";
import { isEmailSuppressed } from "./suppression";
import {
  SimulatedCrash, TxAbort, authorizeInTx, cancelInTx, createActivityOnce, createNotificationOnce, createTaskOnce,
  dbNow, finishTx, leaseEnd, requeueTx, runTx, sleep, timing, toNeedsReview, type FollowUpRow, type RunOutcome, type Tx,
} from "./followup-runtime";

/**
 * Envoi d'un e-mail de relance : intention enregistrée (T2) → fraîcheur (P1) → contrôle conditionnel du bail, de la séquence et du prospect (P3)
 * → garde locale (P4) → marque d'appel `callStartedAt` (P2′) → appel fournisseur (P5, HORS transaction) → résultat → finalisation (T3).
 *
 * Ce que chaque état persistant prouve (et ne prouve pas) :
 *  - `attempting` + `callStartedAt` NUL  : l'appel n'a pas été commencé PAR CONSTRUCTION DU CODE (l'appel n'a lieu qu'après P2′) → reprise contrôlée possible ;
 *  - `attempting` + `callStartedAt` posé : l'appel a POTENTIELLEMENT commencé ; ce n'est PAS une preuve de transmission des octets → jamais de renvoi automatique ;
 *  - `sent` / `failed` / `uncertain` : résultat fournisseur (accepté / refus explicite / indéterminé) ; `aborted` : aucun appel commencé.
 * Les écritures sur `EmailLog` ne dépendent pas du bail (un résultat tardif est toujours enregistré dans SA tentative) ; celles de `FollowUp` exigent le jeton.
 */

export type SendHooks = Partial<Record<"afterT2" | "beforeP1" | "afterP1" | "afterP3" | "afterP4" | "afterP2" | "afterSend" | "afterOutcome", () => void | Promise<void>>>;
let hooks: SendHooks = {};
/** Tests uniquement : points d'interruption (arrêt simulé, blocage) entre les étapes de l'envoi. */
export function setSendHooksForTests(h: SendHooks | null) {
  if (env.isProd) throw new Error("interdit en production");
  hooks = h ?? {};
}
const hook = async (name: keyof SendHooks) => { await hooks[name]?.(); };

/** Une clé d'idempotence n'est réutilisée (renvoi manuel) que dans la fenêtre documentée du fournisseur (24 h) avec une marge. */
export const IDEMPOTENCY_REUSE_MS = 23 * 3_600_000;

type Prior = { id: string; status: string; attemptNo: number | null; authorizedAt: Date | null; idempotencyKey: string | null; payloadHash: string | null };
type ProviderOutcome = { status: "sent" | "failed" | "uncertain"; providerMessageId?: string | null; httpStatus?: number | null; error?: string | null };
type T2Out =
  | { k: "authorized"; logId: string; attemptNo: number; authorizedAt: Date; idempotencyKey: string }
  | { k: "cancelled" | "exhausted" | "lost" | "send_disabled" | "lead_ineligible" | "lead_changed" | "suppressed" | "attempt_exists" };

const leadEligible = (email: string) => ({ deletedAt: null, unsubscribedAt: null, consentMarketing: true, email, status: { notIn: TERMINAL_STATUSES } }) satisfies Prisma.LeadWhereInput;

export function chooseIdempotencyKey(prior: Prior[], payloadHash: string, manual: boolean, followUpId: string, attemptNo: number, now: Date): string {
  const fresh = `fu:${followUpId}:${attemptNo}`;
  if (!manual) return fresh;
  const last = [...prior].reverse().find((p) => p.status !== "aborted");
  if (last?.idempotencyKey && last.payloadHash === payloadHash && last.authorizedAt && now.getTime() - last.authorizedAt.getTime() < IDEMPOTENCY_REUSE_MS) return last.idempotencyKey;
  return fresh;
}

async function sentEffects(tx: Tx, row: { id: string; workspaceId: string; leadId: string }, subject: string, body: string, auto: boolean) {
  const convId = `fuv:${row.id}`;
  if (!(await tx.conversation.findUnique({ where: { id: convId }, select: { id: true } }))) {
    await tx.conversation.create({ data: { id: convId, workspaceId: row.workspaceId, leadId: row.leadId, channel: "email", direction: "outbound", subject, body } });
  }
  await createActivityOnce(tx, `fua:${row.id}`, { workspaceId: row.workspaceId, leadId: row.leadId, type: "email", data: { subject, auto } });
}

/** Relance bloquée : tâche manuelle (identifiant déterministe) + finalisation, dans une transaction courte. */
export async function blockedWithTask(row: FollowUpRow, token: string, now: Date, title: string, description: string, result: string): Promise<RunOutcome> {
  const r = await finishTx(row.id, token, now, { status: "blocked", result }, (tx) => createTaskOnce(tx, row.id, { workspaceId: row.workspaceId, leadId: row.leadId, title, description, dueAt: now }));
  return r === "applied" ? "blocked" : "lost";
}

/**
 * Réconciliation au démarrage d'une relance e-mail qui a déjà des tentatives (reprise après expiration du bail) :
 *  1. toute tentative « attempting » dont l'appel n'a jamais été marqué est convertie en « aborted » (compare-and-set : une seule des deux écritures — celle-ci ou la marque d'appel — réussit) ;
 *  2. une tentative acceptée finalise la relance SANS renvoi ; une tentative incertaine ou potentiellement commencée → needs_review ; un refus explicite → blocked.
 * Renvoie null s'il n'y a aucune tentative ou si toutes sont « aborted » (une nouvelle tentative contrôlée est alors permise).
 */
async function reconcileAttempts(row: FollowUpRow, token: string, now: Date, subject: string, body: string): Promise<RunOutcome | null> {
  await db.emailLog.updateMany({ where: { followUpId: row.id, status: "attempting", callStartedAt: null }, data: { status: "aborted", error: "aborted:abandoned", finishedAt: new Date() } });
  const rows = await db.emailLog.findMany({ where: { followUpId: row.id }, orderBy: { attemptNo: "asc" } });
  if (!rows.length) return null;
  if (rows.some((r) => r.status === "sent")) {
    const r = await finishTx(row.id, token, now, { status: "done", result: "E-mail envoyé (acceptation du fournisseur confirmée)." }, (tx) => sentEffects(tx, row, subject, body, true));
    return r === "applied" ? "done" : "lost";
  }
  if (rows.some((r) => r.status === "uncertain" || (r.status === "attempting" && r.callStartedAt))) {
    const r = await toNeedsReview(row.id, row.workspaceId, token, now, "email_uncertain", "Résultat de l'envoi incertain : vérifiez chez le fournisseur avant tout renvoi.");
    return r === "applied" ? "needs_review" : "lost";
  }
  const failed = rows.find((r) => r.status === "failed");
  if (failed) {
    const reason = `Échec d'envoi : ${failed.error ?? "refus du fournisseur"}`;
    return blockedWithTask(row, token, now, `Relance e-mail non envoyée : ${subject}`, `${reason}\n\n${body}`, reason);
  }
  return null;
}

/** T2 : autorisation transactionnelle d'envoi + intention enregistrée (ligne de tentative). Aucun appel réseau. Reprise uniquement sur P2034 (annulation garantie). */
async function authorizeSend(row: FollowUpRow, token: string, now: Date, prep: Extract<PreparedEmail, { ok: true }>, manual: boolean): Promise<T2Out> {
  return runTx<T2Out>(async (tx) => {
    const a = await authorizeInTx(tx, row, token, now, { increment: !manual });
    if (a === "sequence_inactive") { await cancelInTx(tx, row.id, token, now, "Séquence désactivée ou supprimée avant exécution.", "sequence_inactive"); return { k: "cancelled" }; }
    if (a === "exhausted") return { k: "exhausted" };
    if (a === "lost") throw new TxAbort<T2Out>({ k: "lost" });
    // la séquence est verrouillée : lecture stable
    const seq = await tx.followUpSequence.findUnique({ where: { id: row.sequenceId! }, select: { sendEmails: true } });
    if (!seq?.sendEmails) throw new TxAbort<T2Out>({ k: "send_disabled" });
    // prospect : éligibilité vérifiée ET verrouillée sans modifier `updatedAt` (mise à jour conditionnelle à valeur inchangée)
    const l = await tx.lead.findFirst({ where: { id: row.leadId, workspaceId: row.workspaceId, deletedAt: null } });
    if (!l || !l.email || !l.consentMarketing || l.unsubscribedAt || (TERMINAL_STATUSES as string[]).includes(l.status)) throw new TxAbort<T2Out>({ k: "lead_ineligible" });
    if (l.email !== prep.to) throw new TxAbort<T2Out>({ k: "lead_changed" });
    const cas = await tx.lead.updateMany({ where: { id: l.id, workspaceId: row.workspaceId, updatedAt: l.updatedAt, ...leadEligible(l.email) }, data: { updatedAt: l.updatedAt } });
    if (cas.count !== 1) throw new TxAbort<T2Out>({ k: "lead_changed" });
    const consent = await tx.consent.findFirst({ where: { workspaceId: row.workspaceId, leadId: l.id, type: "marketing", email: l.email.toLowerCase() }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { granted: true } });
    if (!consent?.granted) throw new TxAbort<T2Out>({ k: "lead_ineligible" });
    if (await isEmailSuppressed(tx, row.workspaceId, l.email)) throw new TxAbort<T2Out>({ k: "suppressed" });
    // tentatives existantes (relance verrouillée : personne d'autre ne peut en créer)
    const prior = await tx.emailLog.findMany({ where: { followUpId: row.id }, orderBy: { attemptNo: "asc" }, select: { id: true, status: true, attemptNo: true, authorizedAt: true, idempotencyKey: true, payloadHash: true } });
    if (!manual && prior.some((p) => p.status !== "aborted")) throw new TxAbort<T2Out>({ k: "attempt_exists" });
    const attemptNo = Math.max(0, ...prior.map((p) => p.attemptNo ?? 0)) + 1;
    const authorizedAt = await dbNow(tx);
    const logId = `el:${row.id}:${attemptNo}`;
    const idempotencyKey = chooseIdempotencyKey(prior, prep.payloadHash, manual, row.id, attemptNo, authorizedAt);
    await tx.emailLog.create({
      data: {
        id: logId, workspaceId: row.workspaceId, leadId: l.id, to: l.email, subject: prep.subject, provider: prep.provider.id, status: "attempting",
        followUpId: row.id, attemptNo, idempotencyKey, payloadHash: prep.payloadHash, authorizedAt,
      },
    });
    return { k: "authorized", logId, attemptNo, authorizedAt, idempotencyKey };
  }, { codes: ["P2034"] });
}

/** Qui a refusé le contrôle juste avant l'appel : le bail (perdu), la séquence ou le prospect ? */
async function classifyDenied(row: FollowUpRow, token: string): Promise<"lost" | "sequence" | "lead"> {
  const f = await db.followUp.findUnique({ where: { id: row.id }, include: { sequence: true } });
  if (!f || f.leaseToken !== token || f.status !== "running") return "lost";
  if (!f.sequence || !f.sequence.active || !f.sequence.sendEmails) return "sequence";
  return "lead";
}

/** Abandon AVANT l'appel : tentative « aborted » (aucun appel commencé), puis sort de la relance selon la cause — jamais de réactivation d'une relance annulée. */
async function abortAttempt(row: FollowUpRow, token: string, now: Date, logId: string, cause: "freshness" | "local_delay" | "lead_changed" | "sequence" | "lead" | "lost"): Promise<RunOutcome> {
  await db.emailLog.updateMany({ where: { id: logId, status: "attempting", callStartedAt: null }, data: { status: "aborted", error: `aborted:${cause}`, finishedAt: new Date() } });
  if (cause === "lost") return "lost";
  if (cause === "sequence") {
    const r = await finishTx(row.id, token, now, { status: "cancelled", result: "Séquence désactivée ou supprimée avant l'envoi.", failureKind: "sequence_inactive" });
    return r === "applied" ? "cancelled" : "lost";
  }
  return requeueTx(row, token, now, "aborted", `Envoi abandonné avant l'appel (${cause}) : nouvelle tentative planifiée.`);
}

function classifySendError(e: unknown): ProviderOutcome {
  if (e instanceof SimulatedCrash) throw e;
  if (e instanceof EmailError) {
    return e.kind === "rejected"
      ? { status: "failed", httpStatus: e.status ?? null, error: storableProviderError(e) }
      : { status: "uncertain", httpStatus: e.status ?? null, error: storableProviderError(e) };
  }
  return { status: "uncertain", error: storableProviderError(e) };
}

/** Libellé neutre d'un résultat enregistré APRÈS l'effacement du prospect (aucun détail du fournisseur conservé). */
export const ERASED_RESULT_NOTE = "Résultat enregistré après effacement du prospect (détail non conservé).";

/**
 * Écrit le résultat fournisseur dans SA tentative, de façon conditionnelle et atomique (une instruction chacune) :
 *  1. prospect non effacé : résultat complet (le texte d'erreur est déjà filtré par storableProviderError) ;
 *  2. sinon (prospect effacé, avant OU pendant l'écriture) : uniquement les champs techniques, le détail est remplacé par un libellé neutre.
 * L'adresse, l'objet et les notes ne sont JAMAIS réécrits ici ; le texte stocké ne peut de toute façon pas contenir de donnée personnelle (filtre à la source),
 * ce qui rend l'issue indépendante de l'ordre d'exécution d'un effacement concurrent. Idempotent : la ligne n'est modifiée que tant qu'elle est « attempting ».
 */
export async function recordProviderOutcome(client: Pick<Tx, "emailLog">, logId: string, o: ProviderOutcome): Promise<boolean> {
  const technical = { status: o.status, providerMessageId: o.providerMessageId ?? null, httpStatus: o.httpStatus ?? null, finishedAt: new Date() };
  const full = await client.emailLog.updateMany({ where: { id: logId, status: "attempting", lead: { is: { deletedAt: null } } }, data: { ...technical, error: o.error ?? null } });
  if (full.count > 0) return true;
  const erased = await client.emailLog.updateMany({ where: { id: logId, status: "attempting" }, data: { ...technical, error: o.error ? ERASED_RESULT_NOTE : null } });
  return erased.count > 0;
}

/** Résultat fournisseur dans SA tentative : conditionnel (`status = attempting`), indépendant du bail et de tout verdict humain. Réessayé en cas d'erreur de base. */
async function writeOutcome(logId: string, o: ProviderOutcome, ctx: { followUpId: string; workspaceId: string }): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    try {
      await recordProviderOutcome(db, logId, o);
      return true;
    } catch (e) {
      if (e instanceof SimulatedCrash) throw e;
      await sleep(200 * (i + 1));
    }
  }
  // Seule trace restante si la base reste indisponible : le message est peut-être parti. Ligne laissée « attempting » (envoi potentiellement effectué).
  log.error("email.outcome_unlogged", { followUpId: ctx.followUpId, emailLogId: logId, outcome: o.status, providerMessageId: o.providerMessageId ?? null });
  return false;
}

/** Après un résultat dont la finalisation a été refusée (jeton périmé) : une révocation validée entre-temps est tracée (sans donnée personnelle). */
async function auditIfRevoked(row: FollowUpRow, logId: string, attemptNo: number, o: ProviderOutcome) {
  if (o.status === "failed") return;
  const f = await db.followUp.findUnique({ where: { id: row.id }, select: { status: true, failureKind: true, executedAt: true } });
  if (f?.status !== "cancelled" || f.failureKind !== "revoked") return;
  await audit({
    workspaceId: row.workspaceId, action: o.status === "sent" ? "email.sent_after_revocation" : "email.possibly_sent_after_revocation", entity: "EmailLog", entityId: logId,
    meta: { followUpId: row.id, attemptNo, httpStatus: o.httpStatus ?? null, providerMessageId: o.providerMessageId ?? null, revokedAt: f.executedAt?.toISOString() ?? null },
  });
}

async function sendAuthorized(p: { row: FollowUpRow; token: string; now: Date; subject: string; body: string; prep: Extract<PreparedEmail, { ok: true }>; t2: Extract<T2Out, { k: "authorized" }>; manual: boolean }): Promise<RunOutcome> {
  const { row, token, now, subject, body, prep, t2, manual } = p;
  const { logId, attemptNo } = t2;
  const idemKey = t2.idempotencyKey;
  await hook("afterT2");

  const w0 = Date.now(), m0 = performance.now();
  await hook("beforeP1");
  // P1 — fraîcheur de l'autorisation (horloge de la base sous PostgreSQL)
  if ((await dbNow()).getTime() - t2.authorizedAt.getTime() > timing.sendFreshMs) return abortAttempt(row, token, now, logId, "freshness");
  await hook("afterP1");

  // P3 — UNE instruction : bail (jeton), séquence active avec envoi autorisé, prospect éligible et adresse inchangée ; renouvelle le bail
  const go = await db.followUp.updateMany({
    where: { id: row.id, leaseToken: token, status: "running", sequence: { is: { active: true, sendEmails: true } }, lead: { is: leadEligible(prep.to) } },
    data: { leaseUntil: leaseEnd(now) },
  });
  if (go.count !== 1) return abortAttempt(row, token, now, logId, await classifyDenied(row, token));
  await hook("afterP3");

  // P4 — garde locale : horloge murale ET monotone (la monotone seule ne compte pas une suspension de la machine)
  if (Date.now() - w0 > timing.localGuardMs || performance.now() - m0 > timing.localGuardMs) return abortAttempt(row, token, now, logId, "local_delay");
  await hook("afterP4");

  // P2′ — marque d'appel, compare-and-set contre toute conversion en « aborted » par une reprise, avec dernier contrôle d'éligibilité du prospect
  const mark = await db.emailLog.updateMany({ where: { id: logId, status: "attempting", callStartedAt: null, lead: { is: leadEligible(prep.to) } }, data: { callStartedAt: new Date() } });
  if (mark.count !== 1) {
    const cur = await db.emailLog.findUnique({ where: { id: logId }, select: { status: true } });
    if (!cur || cur.status !== "attempting") return "lost"; // la reprise a converti la tentative : on s'arrête sans rien écrire
    return abortAttempt(row, token, now, logId, "lead_changed");
  }
  await hook("afterP2");

  // P5 — appel fournisseur, HORS transaction
  let outcome: ProviderOutcome;
  try {
    const r = await prep.provider.send({ to: prep.to, subject: prep.subject, text: prep.text, headers: prep.headers, idempotencyKey: idemKey });
    outcome = { status: "sent", providerMessageId: r.id, httpStatus: r.httpStatus ?? null };
  } catch (e) {
    outcome = classifySendError(e);
  }
  await hook("afterSend");
  await writeOutcome(logId, outcome, { followUpId: row.id, workspaceId: row.workspaceId });
  await hook("afterOutcome");

  // T3 — finalisation de la relance sous jeton ; le résultat est aussi réécrit ici (idempotent) au cas où l'écriture précédente aurait échoué
  const rewrite = async (tx: Tx) => { await recordProviderOutcome(tx, logId, outcome); };
  let fin: { status: "done" | "blocked" | "needs_review"; result: string; failureKind?: string };
  let effects: (tx: Tx) => Promise<void>;
  if (outcome.status === "sent") {
    fin = { status: "done", result: manual ? "E-mail renvoyé après vérification humaine." : "E-mail envoyé." };
    effects = async (tx) => { await rewrite(tx); await sentEffects(tx, row, subject, body, !manual); };
  } else if (outcome.status === "failed") {
    const reason = `Échec d'envoi : ${outcome.error ?? "refus du fournisseur"}`;
    fin = { status: "blocked", result: reason };
    effects = async (tx) => { await rewrite(tx); await createTaskOnce(tx, row.id, { workspaceId: row.workspaceId, leadId: row.leadId, title: `Relance e-mail non envoyée : ${subject}`, description: `${reason}\n\n${body}`, dueAt: now }); };
  } else {
    fin = { status: "needs_review", result: "Résultat de l'envoi incertain : vérifiez chez le fournisseur avant tout renvoi.", failureKind: "email_uncertain" };
    effects = async (tx) => { await rewrite(tx); await createNotificationOnce(tx, `fur:${row.id}:email_uncertain:${attemptNo}`, { workspaceId: row.workspaceId, type: "followup_review", title: "Une relance est à examiner", body: fin.result, href: "/automations" }); };
  }
  const done = await finishTx(row.id, token, now, fin, effects);
  if (done === "lost") { await auditIfRevoked(row, logId, attemptNo, outcome); return "lost"; }
  return fin.status;
}

/** Exécute une relance e-mail réservée (jeton `token`). `manual` : renvoi humain (hors plafond, tentatives antérieures non « aborted » permises). */
export async function runEmailFollowUp(p: { row: FollowUpRow; token: string; now: Date; subject: string; body: string; manual?: boolean }): Promise<RunOutcome> {
  const { row, token, now, subject, body } = p;
  const manual = !!p.manual;
  if (!manual) {
    const rec = await reconcileAttempts(row, token, now, subject, body);
    if (rec) return rec;
  }
  if (!row.sequence?.sendEmails) {
    // Envoi réel non autorisé pour cette séquence : une tâche manuelle est créée, rien n'est simulé.
    return blockedWithTask(row, token, now, `Envoyer manuellement : ${subject}`, body, "Envoi automatique d'e-mails non activé pour cette séquence : tâche manuelle créée.");
  }
  const prep = await prepareFollowUpEmail({ workspaceId: row.workspaceId, leadId: row.leadId, subject, body });
  if (!prep.ok) return blockedWithTask(row, token, now, `Relance e-mail non envoyée : ${subject}`, `${prep.reason}\n\n${body}`, prep.reason);

  const t2 = await authorizeSend(row, token, now, prep, manual);
  switch (t2.k) {
    case "authorized": return sendAuthorized({ row, token, now, subject, body, prep, t2, manual });
    case "cancelled": return "cancelled";
    case "exhausted": return "exhausted";
    case "lost": return "lost";
    case "send_disabled": return blockedWithTask(row, token, now, `Envoyer manuellement : ${subject}`, body, "Envoi automatique d'e-mails non activé pour cette séquence : tâche manuelle créée.");
    case "lead_ineligible":
    case "suppressed": {
      const again = await prepareFollowUpEmail({ workspaceId: row.workspaceId, leadId: row.leadId, subject, body });
      const reason = again.ok ? "Le prospect n'est plus éligible à l'envoi." : again.reason;
      return blockedWithTask(row, token, now, `Relance e-mail non envoyée : ${subject}`, `${reason}\n\n${body}`, reason);
    }
    case "lead_changed": return requeueTx(row, token, now, "aborted", "Prospect modifié pendant l'autorisation : nouvelle tentative planifiée.");
    case "attempt_exists": {
      const r = await toNeedsReview(row.id, row.workspaceId, token, now, "email_uncertain", "Une tentative d'envoi existe déjà : vérifiez chez le fournisseur avant tout renvoi.");
      return r === "applied" ? "needs_review" : "lost";
    }
  }
}
