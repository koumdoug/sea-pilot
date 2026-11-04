import { createHash, createHmac } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { env } from "./env";
import { log } from "./logger";

type Client = Pick<Prisma.TransactionClient, "emailSuppression">;

/** Normalisation UNIQUE des adresses de la liste (écriture, lecture, import) : espaces retirés, minuscules. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

// ── Formats de la colonne `EmailSuppression.email` (tous reconnus en lecture, à tout moment) ─────────────────────────
//  1. adresse normalisée EN CLAIR                       : désinscriptions et oppositions historiques (et valeur par défaut sans clé dédiée) ;
//  2. `erased:<SHA-256(espace|adresse)>`                : effacements sans clé dédiée (empreinte salée par l'espace, sans secret) ;
//  3. `h1:<kid>:<HMAC-SHA256(clé, "suppression|espace|adresse")>` : format courant avec clé dédiée ; `kid` = identifiant public (12 hex) de la clé.

/** Empreinte du format 2 (sans secret : insensible à toute rotation, mais une adresse devinée peut être confirmée en la recalculant). */
export const erasedEmailKey = (workspaceId: string, email: string) =>
  `erased:${createHash("sha256").update(`${workspaceId}|${normalizeEmail(email)}`).digest("hex")}`;

type KeyInfo = { kid: string; key: string };
export type SuppressionKeyring = { current: KeyInfo | null; all: KeyInfo[]; problems: string[] };

const MIN_KEY_LENGTH = 32;
const kidOf = (key: string) => createHash("sha256").update(`suppression-kid|${key}`).digest("hex").slice(0, 12);

/**
 * Clés configurées : SUPPRESSION_HMAC_KEY (courante) et SUPPRESSION_HMAC_KEY_PREVIOUS (anciennes, séparées par des virgules, lecture seule).
 * Une clé est refusée si elle a moins de 32 caractères ou si elle réutilise SESSION_SECRET ou ENCRYPTION_KEY (clés d'un autre usage).
 * Aucune valeur de clé n'est jamais journalisée : seuls l'identifiant public `kid` et le motif du refus le sont.
 */
export function suppressionKeyring(): SuppressionKeyring {
  const problems: string[] = [];
  const reserved: string[] = [];
  for (const read of [() => env.sessionSecret, () => env.encryptionKey]) { try { reserved.push(read()); } catch { /* secret de session absent : traité ailleurs */ } }
  const accept = (raw: string | undefined, label: string): KeyInfo | null => {
    if (!raw) return null;
    if (raw.length < MIN_KEY_LENGTH) { problems.push(`${label} ignorée : moins de ${MIN_KEY_LENGTH} caractères.`); return null; }
    if (reserved.includes(raw)) { problems.push(`${label} ignorée : identique à SESSION_SECRET ou ENCRYPTION_KEY (une clé dédiée est exigée).`); return null; }
    return { kid: kidOf(raw), key: raw };
  };
  const current = accept(env.suppressionKey, "SUPPRESSION_HMAC_KEY");
  const previous = env.suppressionKeysPrevious.map((k) => accept(k, "SUPPRESSION_HMAC_KEY_PREVIOUS")).filter((k): k is KeyInfo => !!k);
  const all: KeyInfo[] = [];
  for (const k of [current, ...previous]) if (k && !all.some((x) => x.kid === k.kid)) all.push(k);
  return { current, all, problems };
}

export const keyedEmailKey = (workspaceId: string, email: string, k: KeyInfo) =>
  `h1:${k.kid}:${createHmac("sha256", k.key).update(`suppression|${workspaceId}|${normalizeEmail(email)}`).digest("hex")}`;

const warned = new Set<string>();
/** Test uniquement : les avertissements ne sont émis qu'une fois par processus et par contenu ; ce point les réarme. */
export const resetSuppressionWarningsForTests = () => warned.clear();
const warnOnce = (event: string, data: Record<string, unknown>) => { const id = `${event}:${JSON.stringify(data)}`; if (!warned.has(id)) { warned.add(id); log.warn(event, data); } };

/**
 * Valeur à ÉCRIRE dans la liste. Avec une clé dédiée valide : toujours le format courant `h1:`. Sans clé (absente ou refusée) : comportement explicite et sûr,
 * jamais un blocage en moins — `fallback: "plain"` (désinscription, opposition : adresse en clair comme avant) ou `"sha"` (effacement : empreinte du format 2) — et un
 * avertissement `suppression.key_missing` (sans valeur de clé) est journalisé.
 */
export function suppressionWriteKey(workspaceId: string, email: string, opts: { fallback: "plain" | "sha" }): string {
  const ring = suppressionKeyring();
  if (ring.current) return keyedEmailKey(workspaceId, email, ring.current);
  warnOnce("suppression.key_missing", { fallback: opts.fallback, problem: ring.problems[0] ?? "SUPPRESSION_HMAC_KEY non définie" });
  return opts.fallback === "sha" ? erasedEmailKey(workspaceId, email) : normalizeEmail(email);
}

/** Toutes les formes sous lesquelles une adresse peut figurer dans la liste de CET espace (en clair, empreinte du format 2, HMAC de chaque clé configurée). */
export function suppressionCandidates(workspaceId: string, email: string): string[] {
  const e = normalizeEmail(email);
  return [e, erasedEmailKey(workspaceId, e), ...suppressionKeyring().all.map((k) => keyedEmailKey(workspaceId, e, k))];
}

export type SuppressionStatus = "clear" | "listed" | "unknown_key";

/**
 * Décision pour une adresse :
 *  - `listed` : l'adresse figure dans la liste (n'importe quel format reconnu) ;
 *  - `unknown_key` : l'espace contient des entrées `h1:` d'une clé NON configurée (clé retirée, perdue ou mal saisie). Ces entrées ne peuvent pas être comparées sans la clé :
 *    refuser par précaution plutôt que de réautoriser silencieusement des adresses désinscrites (échec fermé, explicite) ;
 *  - `clear` : aucune entrée ne correspond et aucune entrée n'est illisible.
 * Isolation : toutes les requêtes sont limitées à l'espace de travail, et le HMAC lie l'adresse à l'espace.
 */
export async function suppressionStatus(c: Client, workspaceId: string, email: string): Promise<SuppressionStatus> {
  if (await c.emailSuppression.findFirst({ where: { workspaceId, email: { in: suppressionCandidates(workspaceId, email) } }, select: { id: true } })) return "listed";
  const ring = suppressionKeyring();
  const prefixes = ring.all.map((k) => `h1:${k.kid}:`);
  const orphan = await c.emailSuppression.findFirst({
    where: { workspaceId, email: { startsWith: "h1:" }, ...(prefixes.length ? { NOT: prefixes.map((p) => ({ email: { startsWith: p } })) } : {}) },
    select: { id: true },
  });
  if (!orphan) return "clear";
  warnOnce("suppression.unknown_key", { workspaceId, configuredKids: ring.all.map((k) => k.kid), problems: ring.problems });
  return "unknown_key";
}

/** Adresse à ne pas solliciter (inscrite, ou liste illisible faute de clé : échec fermé). */
export async function isEmailSuppressed(c: Client, workspaceId: string, email: string): Promise<boolean> {
  return (await suppressionStatus(c, workspaceId, email)) !== "clear";
}

export const UNKNOWN_KEY_REASON =
  "Liste de suppression protégée par une clé inconnue : envoi bloqué par précaution (configurer SUPPRESSION_HMAC_KEY, et SUPPRESSION_HMAC_KEY_PREVIOUS pour les anciennes clés).";

type BackfillStep = "afterCreate" | "afterVerify";
let backfillHook: ((step: BackfillStep, ctx: { workspaceId: string; keyed: string; plainId: string }) => void | Promise<void>) | null = null;
/** Test uniquement : exécuté entre les étapes du backfill (une exception simule un arrêt du processus). */
export const setBackfillHookForTests = (h: typeof backfillHook) => { backfillHook = h; };

export type BackfillSummary = {
  dryRun: boolean; scanned: number; created: number; alreadyKeyed: number; deletedPlain: number;
  /** Lignes en clair conservées faute d'entrée HMAC vérifiée ET exploitable avec la configuration de clés courante. */
  keptUnverified: number;
  /** Entrées `erased:` : non convertibles (adresse inconnue), valides telles quelles. */
  legacyHashedNotConvertible: number;
  /** Entrées `h1:` de forme invalide (identifiant ou empreinte illisibles) : inertes, jamais appariées à une adresse — à examiner. */
  malformedKeyed: number;
};

const HMAC_ENTRY = /^h1:[0-9a-f]{12}:[0-9a-f]{64}$/;
const isUniqueViolation = (e: unknown) => (e as { code?: string } | null)?.code === "P2002";

/**
 * Migration PROGRESSIVE des entrées en clair vers le format courant (jamais lancée automatiquement). Étapes :
 *  1. `dryRun` (défaut) : compte seulement ;
 *  2. `dryRun: false` : AJOUTE l'entrée HMAC à côté de l'entrée en clair (additif, réversible : rien n'est supprimé) ;
 *  3. `deletePlain: true` (avec `dryRun: false`) : supprime l'entrée en clair SEULEMENT si l'entrée HMAC est (a) lue en base APRÈS sa validation et (b) exploitable : la
 *     clé qui l'a produite figure toujours dans la configuration courante, donc la recherche d'envoi la retrouvera. Sinon le clair est conservé et compté (`keptUnverified`).
 * Ordre garanti dans un même appel : écriture validée (instruction autonome, attendue) → relecture → contrôle d'exploitabilité → suppression. Concurrence : le backfill gère SA PROPRE collision
 * (création autonome, `P2002` rattrapée : l'entrée existe, elle est relue). L'inverse n'est PAS sans conséquence : la DÉSINSCRIPTION concurrente écrit la même clé par un `upsert` à
 * `update: {}` DANS une transaction ; c'est la collision observée (tests/pg-suppression-race.test.ts) : elle fait échouer l'`upsert` et invalide la transaction PostgreSQL, qui est alors
 * REPRISE EN ENTIER (`SUPPRESSION_TX_CODES`, leads.ts), jamais poursuivie. L'effacement (`update` non vide) ne collisionne pas dans ce scénario ; il bénéficie de la même reprise par précaution.
 * Côté backfill : une suppression simultanée du clair ne provoque aucune erreur (`deleteMany`). Un arrêt entre deux étapes laisse clair ET HMAC : l'adresse reste bloquée, la reprise termine.
 * Le retour arrière n'est plus possible pour une adresse dont le prospect a été effacé (le HMAC n'est pas réversible) ; il l'est tant que la fiche conserve l'adresse.
 * Les entrées `erased:` ne peuvent PAS être converties : l'adresse n'est plus connue, elles restent valides telles quelles. Aucune adresse n'est journalisée (comptages seuls).
 */
export async function backfillSuppressionKeys(o: { workspaceId?: string; dryRun?: boolean; deletePlain?: boolean; limit?: number } = {}): Promise<BackfillSummary> {
  const ring = suppressionKeyring();
  if (!ring.current) throw new Error(`SUPPRESSION_HMAC_KEY absente ou refusée : aucune entrée n'est convertie.${ring.problems[0] ? ` ${ring.problems[0]}` : ""}`);
  const dryRun = o.dryRun ?? true;
  const scope = o.workspaceId ? { workspaceId: o.workspaceId } : {};
  const rows = await db.emailSuppression.findMany({ where: { ...scope, NOT: [{ email: { startsWith: "h1:" } }, { email: { startsWith: "erased:" } }] }, orderBy: { createdAt: "asc" }, take: o.limit ?? 500 });
  const keyedRows = await db.emailSuppression.findMany({ where: { ...scope, email: { startsWith: "h1:" } }, select: { email: true }, take: 20_000 });
  const out: BackfillSummary = {
    dryRun, scanned: rows.length, created: 0, alreadyKeyed: 0, deletedPlain: 0, keptUnverified: 0,
    legacyHashedNotConvertible: await db.emailSuppression.count({ where: { ...scope, email: { startsWith: "erased:" } } }),
    malformedKeyed: keyedRows.filter((k) => !HMAC_ENTRY.test(k.email)).length,
  };
  const find = (workspaceId: string, email: string) => db.emailSuppression.findUnique({ where: { workspaceId_email: { workspaceId, email } }, select: { id: true } });
  for (const r of rows) {
    const key = keyedEmailKey(r.workspaceId, r.email, ring.current);
    if (await find(r.workspaceId, key)) out.alreadyKeyed++;
    else if (!dryRun) {
      try { await db.emailSuppression.create({ data: { workspaceId: r.workspaceId, email: key, reason: r.reason } }); out.created++; }
      catch (e) { if (!isUniqueViolation(e)) throw e; out.alreadyKeyed++; } // créée entre-temps par un autre traitement : elle existe, la vérification ci-dessous la relit
    }
    if (!dryRun) await backfillHook?.("afterCreate", { workspaceId: r.workspaceId, keyed: key, plainId: r.id });
    if (!dryRun && o.deletePlain) {
      const proven = !!(await find(r.workspaceId, key));
      await backfillHook?.("afterVerify", { workspaceId: r.workspaceId, keyed: key, plainId: r.id });
      const usable = suppressionCandidates(r.workspaceId, r.email).includes(key); // la recherche d'envoi, avec la configuration de clés ACTUELLE, retrouvera cette entrée
      if (proven && usable) { await db.emailSuppression.deleteMany({ where: { id: r.id, workspaceId: r.workspaceId } }); out.deletedPlain++; }
      else out.keptUnverified++;
    }
  }
  log.info("suppression.backfill", { ...out, kid: ring.current.kid });
  return out;
}
