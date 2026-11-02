import { createHash } from "node:crypto";
import type { Lead } from "@prisma/client";
import { db } from "./db";
import { env } from "./env";
import { decryptJson, signToken } from "./crypto";
import { log, errMsg } from "./logger";
import { UNKNOWN_KEY_REASON, suppressionStatus } from "./suppression";

export type OutgoingEmail = { to: string; subject: string; text: string; from?: string; headers?: Record<string, string>; idempotencyKey?: string };
export type SentEmail = { id: string | null; httpStatus?: number };

export interface EmailProvider {
  readonly id: string;
  send(m: OutgoingEmail): Promise<SentEmail>;
}

/**
 * Erreur d'envoi typée :
 *  - "rejected"  : refus EXPLICITE du fournisseur (4xx) — le message n'a pas été accepté ;
 *  - "uncertain" : résultat indéterminé (5xx, délai dépassé, erreur réseau, réponse inexploitable) — le message a PEUT-ÊTRE été accepté.
 * Par défaut une erreur est incertaine : on ne présume jamais qu'un message n'est pas parti.
 */
export class EmailError extends Error {
  readonly kind: "rejected" | "uncertain";
  readonly status?: number;
  constructor(message: string, opts: { kind?: "rejected" | "uncertain"; status?: number } = {}) {
    super(message);
    this.kind = opts.kind ?? "uncertain";
    this.status = opts.status;
  }
}

/** Messages produits par NOTRE code (jamais un texte du fournisseur) : seuls autorisés tels quels dans un journal. */
const FIXED_PROVIDER_MESSAGES = [/^Resend HTTP \d{3}$/, /^Resend injoignable ou délai dépassé$/];

/**
 * Texte d'erreur STOCKABLE dans le journal : jamais un texte libre. Un message du fournisseur ou une exception peut citer l'adresse, le nom ou l'objet ;
 * seuls les messages fixes de ce module sont conservés, tout le reste est remplacé par un libellé neutre (nature du résultat et statut HTTP).
 */
export function storableProviderError(e: unknown): string {
  if (e instanceof EmailError) {
    if (FIXED_PROVIDER_MESSAGES.some((r) => r.test(e.message))) return e.message;
    const http = e.status ? ` (HTTP ${e.status})` : "";
    return e.kind === "rejected" ? `Refus du fournisseur${http}` : `Résultat indéterminé${http}`;
  }
  return "Résultat indéterminé (erreur technique du fournisseur)";
}

export class ResendProvider implements EmailProvider {
  readonly id = "resend";
  constructor(private apiKey: string, private from: string) {}
  async send(m: OutgoingEmail): Promise<SentEmail> {
    let res: Response;
    try {
      res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", ...(m.idempotencyKey ? { "idempotency-key": m.idempotencyKey } : {}) },
        body: JSON.stringify({ from: m.from ?? this.from, to: [m.to], subject: m.subject, text: m.text, headers: m.headers }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      // délai dépassé ou erreur réseau : la requête a pu atteindre le fournisseur
      throw new EmailError("Resend injoignable ou délai dépassé", { kind: "uncertain" });
    }
    if (!res.ok) {
      // 4xx = refus explicite ; 409 (conflit d'idempotence : un envoi identique est peut-être en cours) et tout le reste = incertain
      const rejected = res.status >= 400 && res.status < 500 && res.status !== 409;
      throw new EmailError(`Resend HTTP ${res.status}`, { kind: rejected ? "rejected" : "uncertain", status: res.status });
    }
    // 2xx = message accepté, même si le corps est illisible
    let id: string | null = null;
    try { id = ((await res.json()) as { id?: string }).id ?? null; } catch { /* corps illisible : accepté sans identifiant */ }
    return { id, httpStatus: res.status };
  }
}

/** Développement uniquement : écrit l'e-mail dans la console. Jamais utilisé en production. */
export class ConsoleProvider implements EmailProvider {
  readonly id = "console";
  async send(m: OutgoingEmail): Promise<SentEmail> {
    console.log(`\n[e-mail DEV — non envoyé] À: ${m.to}\nObjet: ${m.subject}\n${m.text}\n`);
    return { id: null };
  }
}

let testProvider: EmailProvider | null = null;
export function setEmailProviderForTests(p: EmailProvider | null) {
  if (env.isProd) throw new Error("interdit en production");
  testProvider = p;
}

/** Fournisseur de la plateforme (e-mails système : réinitialisation du mot de passe…). */
export function platformEmailProvider(): EmailProvider | null {
  if (testProvider) return testProvider;
  if (env.resendKey && env.emailFrom) return new ResendProvider(env.resendKey, env.emailFrom);
  if (!env.isProd) return new ConsoleProvider();
  return null;
}

/** Fournisseur de l'espace de travail : intégration « email » connectée (clé Resend du client), sinon rien — aucun envoi marketing via la clé de la plateforme. */
export async function workspaceEmailProvider(workspaceId: string): Promise<EmailProvider | null> {
  if (testProvider) return testProvider;
  const integ = await db.integration.findUnique({ where: { workspaceId_provider: { workspaceId, provider: "email" } } });
  if (!integ || integ.status !== "connected" || !integ.credentials) return null;
  try {
    const c = decryptJson<{ apiKey: string; from: string }>(integ.credentials);
    return new ResendProvider(c.apiKey, c.from);
  } catch (e) {
    log.error("email.credentials_unreadable", { workspaceId, error: errMsg(e) });
    return null;
  }
}

export const unsubscribeToken = (workspaceId: string, leadId: string) => signToken(`u|${workspaceId}|${leadId}`);
export const unsubscribeUrl = (workspaceId: string, leadId: string) => `${env.appUrl}/unsubscribe/${unsubscribeToken(workspaceId, leadId)}`;

export type MarketingResult = { sent: boolean; reason?: string };

export type PreparedEmail =
  | { ok: true; lead: Lead; to: string; provider: EmailProvider; subject: string; text: string; headers: Record<string, string>; payloadHash: string }
  | { ok: false; reason: string };

/**
 * Prépare un e-mail de relance SANS l'envoyer. Conditions obligatoires (sinon l'envoi est REFUSÉ, jamais simulé) :
 *  - fournisseur d'e-mail connecté pour l'espace de travail ;
 *  - le prospect a donné son consentement marketing ;
 *  - le prospect ne s'est pas désinscrit et n'est pas dans la liste de suppression.
 * Ces contrôles sont RÉPÉTÉS de façon atomique par le moteur (transaction d'autorisation puis contrôle juste avant l'appel).
 */
export async function prepareFollowUpEmail(p: { workspaceId: string; leadId: string; subject: string; body: string }): Promise<PreparedEmail> {
  const lead = await db.lead.findFirst({ where: { id: p.leadId, workspaceId: p.workspaceId, deletedAt: null } });
  if (!lead || !lead.email) return { ok: false, reason: "Le prospect n'a pas d'adresse e-mail." };
  if (!lead.consentMarketing) return { ok: false, reason: "Le prospect n'a pas consenti à recevoir des e-mails marketing." };
  // Le consentement est lié à l'ADRESSE : la dernière ligne de consentement marketing de cette adresse doit être accordée (une écriture directe de l'adresse ne contourne pas la règle).
  const consent = await db.consent.findFirst({ where: { workspaceId: p.workspaceId, leadId: lead.id, type: "marketing", email: lead.email.toLowerCase() }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { granted: true } });
  if (!consent?.granted) return { ok: false, reason: "Aucun consentement marketing enregistré pour cette adresse e-mail." };
  if (lead.unsubscribedAt) return { ok: false, reason: "Le prospect s'est désinscrit." };
  const suppression = await suppressionStatus(db, p.workspaceId, lead.email);
  if (suppression === "listed") return { ok: false, reason: "Adresse dans la liste de suppression." };
  if (suppression === "unknown_key") return { ok: false, reason: UNKNOWN_KEY_REASON };
  const provider = await workspaceEmailProvider(p.workspaceId);
  if (!provider) return { ok: false, reason: "Aucun fournisseur d'e-mail connecté (Intégrations → E-mail)." };

  const link = unsubscribeUrl(p.workspaceId, lead.id);
  const text = `${p.body}\n\n—\nPour ne plus recevoir nos messages : ${link}`;
  const headers = { "List-Unsubscribe": `<${env.appUrl}/api/unsubscribe/${unsubscribeToken(p.workspaceId, lead.id)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
  const payloadHash = createHash("sha256").update(JSON.stringify([lead.email, p.subject, text, headers])).digest("hex");
  return { ok: true, lead, to: lead.email, provider, subject: p.subject, text, headers, payloadHash };
}

/**
 * Envoi DIRECT d'un e-mail de relance, hors moteur (aucun bail, aucune porte de tentative) : conservé pour les usages ponctuels et les tests de l'intégration.
 * Le moteur de relances n'utilise PAS cette fonction (voir followup-send.ts : intention enregistrée, autorisation, marque d'appel, résultat).
 * Une erreur n'est classée « failed » que si le fournisseur a refusé explicitement ; toute autre erreur est « uncertain ».
 */
export async function sendFollowUpEmail(p: { workspaceId: string; leadId: string; subject: string; body: string }): Promise<MarketingResult> {
  const prep = await prepareFollowUpEmail(p);
  if (!prep.ok) return { sent: false, reason: prep.reason };
  const base = { workspaceId: p.workspaceId, leadId: prep.lead.id, to: prep.to, subject: p.subject, provider: prep.provider.id };
  try {
    const r = await prep.provider.send({ to: prep.to, subject: p.subject, text: prep.text, headers: prep.headers });
    await db.emailLog.create({ data: { ...base, status: "sent", providerMessageId: r.id, httpStatus: r.httpStatus ?? null, finishedAt: new Date() } });
    return { sent: true };
  } catch (e) {
    const rejected = e instanceof EmailError && e.kind === "rejected";
    await db.emailLog.create({ data: { ...base, status: rejected ? "failed" : "uncertain", error: storableProviderError(e), httpStatus: e instanceof EmailError ? e.status ?? null : null, finishedAt: new Date() } });
    return { sent: false, reason: `${rejected ? "Échec d'envoi" : "Résultat d'envoi incertain"} : ${errMsg(e)}` };
  }
}

/** E-mail système (non marketing) via le fournisseur de la plateforme. Retourne false si aucun fournisseur n'est configuré. */
export async function sendSystemEmail(m: OutgoingEmail): Promise<boolean> {
  const p = platformEmailProvider();
  if (!p) { log.error("email.no_platform_provider", {}); return false; }
  try { await p.send(m); return true; } catch (e) { log.error("email.system_failed", { error: errMsg(e) }); return false; }
}
