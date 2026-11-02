import { Prisma } from "@prisma/client";
import { db, isPostgres } from "./db";
import { randomToken } from "./crypto";

/**
 * Primitives du moteur de relances : bail, transactions courtes, autorisation métier plafonnée, replacement en file.
 *
 * Principes (voir docs/followup-reliability.md) :
 *  - une relance « running » appartient à UN exécuteur (jeton de bail) ; toute écriture finale est conditionnée par ce jeton ;
 *  - l'ordre de verrouillage est Sequence → FollowUp → Lead → données dérivées ; un état « pending » ne se crée jamais sans tenir la séquence ;
 *  - aucune transaction ne contient d'appel réseau ; une transaction annulée ne laisse aucun effet (reprise permise seulement dans ce cas).
 */

export const LEASE_MS = 5 * 60_000;
/** Plafond ABSOLU d'autorisations métier automatiques (tentative initiale + 2 reprises). */
export const MAX_AUTHORIZATIONS = 3;
/** Échecs techniques (transaction annulée avant tout effet, abandon constaté) avant intervention humaine. */
export const MAX_TECHNICAL_FAILURES = 12;
export const TX_OPTIONS = { timeout: 10_000, maxWait: 5_000 } as const;
/** Erreurs transactionnelles pour lesquelles la transaction a été annulée AVANT tout effet : seules reprises permises. */
export const TX_RETRY_CODES = ["P2034", "P2028", "P1008"] as const;
export const TX_MAX_RETRIES = 2;
export const BACKOFF_BASE_MS = 60_000;
export const BACKOFF_MAX_MS = 24 * 3_600_000;
/** Un envoi autorisé (T2) doit commencer dans ce délai, sinon il est abandonné avant l'appel. */
export const SEND_FRESH_MS = 10_000;
/** Garde locale entre le dernier contrôle et l'appel (horloge murale ET monotone). */
export const LOCAL_GUARD_MS = 2_000;
/** Report d'une relance dont l'envoi a été abandonné avant l'appel. */
export const ABORT_RETRY_MS = 60_000;

/** Délais effectifs de l'envoi (modifiables par les tests uniquement). */
export const timing = { sendFreshMs: SEND_FRESH_MS, localGuardMs: LOCAL_GUARD_MS };
export function setTimingForTests(t: Partial<typeof timing> | null) {
  if (process.env.NODE_ENV === "production") throw new Error("interdit en production");
  timing.sendFreshMs = t?.sendFreshMs ?? SEND_FRESH_MS;
  timing.localGuardMs = t?.localGuardMs ?? LOCAL_GUARD_MS;
}

export type Tx = Prisma.TransactionClient;
export type Db = Tx | typeof db;

export type FollowUpRow = Prisma.FollowUpGetPayload<{ include: { lead: true; sequence: true } }>;
export type Final = { status: "done" | "blocked" | "failed" | "cancelled" | "needs_review"; result: string; failureKind?: string | null };
export type RunOutcome = "done" | "blocked" | "failed" | "cancelled" | "needs_review" | "requeued" | "exhausted" | "lost";

/** Annule volontairement une transaction (rien n'est écrit) et en renvoie le résultat à l'appelant de `runTx`. */
export class TxAbort<T = unknown> extends Error {
  constructor(public readonly result: T) {
    super("transaction annulée volontairement");
    this.name = "TxAbort";
  }
}

/** Simule un arrêt brutal du processus (tests uniquement) : ne doit jamais être intercepté ni suivi d'un nettoyage. */
export class SimulatedCrash extends Error {
  constructor(where = "crash") {
    super(`arrêt simulé : ${where}`);
    this.name = "SimulatedCrash";
  }
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let sleepImpl: (ms: number) => Promise<void> = defaultSleep;
let jitterImpl: () => number = () => 100 + Math.floor(Math.random() * 301); // 100 à 400 ms
/** Tests uniquement : supprime les attentes des reprises. */
export function setRetryTimingForTests(t: { sleep?: (ms: number) => Promise<void>; jitter?: () => number } | null) {
  if (process.env.NODE_ENV === "production") throw new Error("interdit en production");
  sleepImpl = t?.sleep ?? defaultSleep;
  jitterImpl = t?.jitter ?? (() => 100 + Math.floor(Math.random() * 301));
}
export const sleep = (ms: number) => sleepImpl(ms);

export const newLeaseToken = () => randomToken(16);
export const leaseEnd = (now: Date) => new Date(now.getTime() + LEASE_MS);
/** Délai après le k-ième échec technique (k ≥ 1) : 1 min, 2, 4, … plafonné à 24 h. */
export const technicalRetryDelayMs = (k: number) => Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, k - 1), BACKOFF_MAX_MS);

export function prismaCode(e: unknown): string | undefined {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : undefined;
}

/**
 * Code d'erreur transactionnelle. Constat (Prisma 6.19.3, PostgreSQL 18, vérifié sur base jetable) : un verrou mortel (SQLSTATE 40P01) n'est PAS exposé sous le code
 * P2034 mais comme PrismaClientUnknownRequestError sans code, dont le message contient « 40P01 / deadlock detected ». Le moteur normalise donc les erreurs PostgreSQL
 * de verrou mortel (40P01) et de sérialisation (40001) en P2034 — la condition que P2034 désigne (conflit d'écriture ou verrou mortel) : la transaction a été annulée par la base.
 */
export function transactionErrorCode(e: unknown): string | undefined {
  const c = prismaCode(e);
  if (c) return c;
  const m = e instanceof Error ? e.message : "";
  return /40P01|deadlock detected|40001|could not serialize access/i.test(m) ? "P2034" : undefined;
}

/**
 * Transaction interactive courte (timeout 10 s, maxWait 5 s). Reprise (2 au plus, attente aléatoire 100–400 ms) UNIQUEMENT sur les erreurs
 * dont la transaction a été annulée avant tout effet. `TxAbort` annule la transaction et renvoie son résultat.
 * Aucun appel à `db` (hors `tx`) dans `fn` : SQLite n'a qu'une connexion.
 */
export async function runTx<T>(fn: (tx: Tx) => Promise<T>, opts: { codes?: readonly string[] } = {}): Promise<T> {
  const codes = opts.codes ?? TX_RETRY_CODES;
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(fn, TX_OPTIONS);
    } catch (e) {
      if (e instanceof TxAbort) return e.result as T;
      const code = transactionErrorCode(e);
      if (code && codes.includes(code) && attempt < TX_MAX_RETRIES) {
        await sleepImpl(jitterImpl());
        continue;
      }
      throw e;
    }
  }
}

/**
 * Heure de référence d'une autorisation d'envoi : horloge de la BASE sous PostgreSQL (indépendante de l'hôte applicatif et de ses suspensions),
 * horloge de l'application sous SQLite (développement et tests uniquement).
 */
export async function dbNow(client: Pick<Tx, "$queryRaw"> = db): Promise<Date> {
  if (!isPostgres) return new Date();
  const r = await client.$queryRaw<{ t: Date }[]>`SELECT clock_timestamp() AS t`;
  return r[0].t;
}

export type AuthResult = "ok" | "sequence_inactive" | "exhausted" | "lost";

/**
 * Autorisation métier (première instruction d'une transaction d'exécution) :
 *  1. séquence : mise à jour conditionnelle sur `active = true` (verrou de la séquence : désactivation et suppression sont sérialisées avec elle) ;
 *  2. relance : renouvellement du bail ET incrément atomique de `attemptCount`, conditionnés par le jeton et par le plafond ;
 *  3. plafond atteint : passage explicite en « failed / exhausted » dans la même transaction.
 * `increment: false` pour une résolution humaine (renvoi manuel) : hors plafond.
 */
export async function authorizeInTx(tx: Tx, row: { id: string; workspaceId: string; sequenceId: string | null }, token: string, now: Date, opts: { increment?: boolean } = {}): Promise<AuthResult> {
  if (!row.sequenceId) return "sequence_inactive";
  const s = await tx.followUpSequence.updateMany({ where: { id: row.sequenceId, workspaceId: row.workspaceId, active: true }, data: { updatedAt: new Date() } });
  if (s.count !== 1) return "sequence_inactive";
  const inc = opts.increment !== false;
  const a = await tx.followUp.updateMany({
    where: { id: row.id, leaseToken: token, status: "running", ...(inc ? { attemptCount: { lt: MAX_AUTHORIZATIONS } } : {}) },
    data: { ...(inc ? { attemptCount: { increment: 1 } } : {}), lastAttemptAt: now, leaseUntil: leaseEnd(now) },
  });
  if (a.count === 1) return "ok";
  const ex = await tx.followUp.updateMany({
    where: { id: row.id, leaseToken: token, status: "running", attemptCount: { gte: MAX_AUTHORIZATIONS } },
    data: { status: "failed", failureKind: "exhausted", leaseToken: null, leaseUntil: null, retryAfter: null, executedAt: now, result: `Plafond de ${MAX_AUTHORIZATIONS} autorisations atteint : relance arrêtée.` },
  });
  return ex.count === 1 ? "exhausted" : "lost";
}

/** Annule la relance sous jeton (dans une transaction déjà ouverte). Renvoie vrai si l'écriture a eu lieu. */
export async function cancelInTx(tx: Tx, id: string, token: string, now: Date, result: string, failureKind: string | null = null): Promise<boolean> {
  const r = await tx.followUp.updateMany({
    where: { id, leaseToken: token, status: "running" },
    data: { status: "cancelled", result, executedAt: now, failureKind, leaseToken: null, leaseUntil: null, retryAfter: null },
  });
  return r.count === 1;
}

/**
 * Finalise une relance sous jeton, puis applique les effets dérivés dans la MÊME transaction (la relance est verrouillée d'abord : Sequence → FollowUp → dérivées).
 * Jeton périmé : tout est annulé (« lost »), aucun effet.
 */
export async function finishTx(id: string, token: string, now: Date, fin: Final, effects?: (tx: Tx) => Promise<void>): Promise<"applied" | "lost"> {
  return runTx<"applied" | "lost">(async (tx) => {
    const r = await tx.followUp.updateMany({
      where: { id, leaseToken: token, status: "running" },
      data: { status: fin.status, result: fin.result, executedAt: now, failureKind: fin.failureKind ?? null, leaseToken: null, leaseUntil: null, retryAfter: null },
    });
    if (r.count !== 1) throw new TxAbort("lost" as const);
    if (effects) await effects(tx);
    return "applied" as const;
  });
}

/** Tâche manuelle d'une relance : identifiant déterministe (au plus une par relance), sûre en cas de reprise. */
export async function createTaskOnce(tx: Tx, followUpId: string, data: { workspaceId: string; leadId: string; title: string; description: string | null; dueAt: Date }) {
  const id = `fut:${followUpId}`;
  if (await tx.task.findUnique({ where: { id }, select: { id: true } })) return;
  await tx.task.create({ data: { id, ...data, source: "followup" } });
}
export async function createNotificationOnce(tx: Tx, id: string, data: { workspaceId: string; type: string; title: string; href?: string | null; body?: string | null }) {
  if (await tx.notification.findUnique({ where: { id }, select: { id: true } })) return;
  await tx.notification.create({ data: { id, ...data } });
}
export async function createActivityOnce(tx: Tx, id: string, data: { workspaceId: string; leadId: string; type: string; data?: Prisma.InputJsonValue }) {
  if (await tx.leadActivity.findUnique({ where: { id }, select: { id: true } })) return;
  await tx.leadActivity.create({ data: { id, ...data } });
}

/** Relance à examiner par un humain (e-mail incertain, échec technique persistant…). Conserve toutes les traces. */
export async function toNeedsReview(id: string, workspaceId: string, token: string, now: Date, kind: string, result: string): Promise<"applied" | "lost"> {
  return finishTx(id, token, now, { status: "needs_review", result, failureKind: kind }, async (tx) => {
    await createNotificationOnce(tx, `fur:${id}:${kind}`, { workspaceId, type: "followup_review", title: "Une relance est à examiner", body: result, href: "/automations" });
  });
}

/**
 * Remet une relance en file (« pending ») : TOUJOURS sous le verrou de la séquence, sinon une désactivation concurrente pourrait laisser une relance
 * « pending » dans une séquence inactive.
 *  - kind "aborted" : envoi abandonné AVANT l'appel (rien n'est parti) ; le plafond d'autorisations est vérifié ici (épuisé → failed) ;
 *  - kind "technical" : échec technique avant tout effet ; compteur technique +1, report progressif (jusqu'à 24 h), seuil → needs_review.
 */
export async function requeueTx(row: { id: string; workspaceId: string; sequenceId: string | null; technicalFailureCount: number }, token: string, now: Date, kind: "aborted" | "technical", result: string): Promise<RunOutcome> {
  return runTx<RunOutcome>(async (tx) => {
    let seqOk = false;
    if (row.sequenceId) {
      const s = await tx.followUpSequence.updateMany({ where: { id: row.sequenceId, workspaceId: row.workspaceId, active: true }, data: { updatedAt: new Date() } });
      seqOk = s.count === 1;
    }
    if (!seqOk) return (await cancelInTx(tx, row.id, token, now, "Séquence désactivée ou supprimée avant exécution.", "sequence_inactive")) ? "cancelled" : "lost";

    if (kind === "aborted") {
      const ex = await tx.followUp.updateMany({
        where: { id: row.id, leaseToken: token, status: "running", attemptCount: { gte: MAX_AUTHORIZATIONS } },
        data: { status: "failed", failureKind: "exhausted", leaseToken: null, leaseUntil: null, retryAfter: null, executedAt: now, result: `Plafond de ${MAX_AUTHORIZATIONS} autorisations atteint : relance arrêtée.` },
      });
      if (ex.count === 1) return "exhausted";
      const r = await tx.followUp.updateMany({
        where: { id: row.id, leaseToken: token, status: "running", attemptCount: { lt: MAX_AUTHORIZATIONS } },
        data: { status: "pending", leaseToken: null, leaseUntil: null, retryAfter: new Date(now.getTime() + ABORT_RETRY_MS), failureKind: null, result },
      });
      return r.count === 1 ? "requeued" : "lost";
    }

    const k = row.technicalFailureCount + 1;
    if (k >= MAX_TECHNICAL_FAILURES) {
      const r = await tx.followUp.updateMany({
        where: { id: row.id, leaseToken: token, status: "running" },
        data: { status: "needs_review", failureKind: "technical_persistent", technicalFailureCount: { increment: 1 }, leaseToken: null, leaseUntil: null, retryAfter: null, executedAt: now, result: `Échec technique persistant (${k} échecs) : intervention requise.` },
      });
      return r.count === 1 ? "needs_review" : "lost";
    }
    const r = await tx.followUp.updateMany({
      where: { id: row.id, leaseToken: token, status: "running" },
      data: { status: "pending", leaseToken: null, leaseUntil: null, retryAfter: new Date(now.getTime() + technicalRetryDelayMs(k)), technicalFailureCount: { increment: 1 }, failureKind: "technical", result },
    });
    return r.count === 1 ? "requeued" : "lost";
  });
}
