import { db } from "./db";
import { env } from "./env";
import { decryptJson, signToken } from "./crypto";
import { log, errMsg } from "./logger";

export type OutgoingEmail = { to: string; subject: string; text: string; from?: string; headers?: Record<string, string> };
export type SentEmail = { id: string | null };

export interface EmailProvider {
  readonly id: string;
  send(m: OutgoingEmail): Promise<SentEmail>;
}

export class EmailError extends Error {}

export class ResendProvider implements EmailProvider {
  readonly id = "resend";
  constructor(private apiKey: string, private from: string) {}
  async send(m: OutgoingEmail): Promise<SentEmail> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: m.from ?? this.from, to: [m.to], subject: m.subject, text: m.text, headers: m.headers }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new EmailError(`Resend HTTP ${res.status}`);
    const j = (await res.json()) as { id?: string };
    return { id: j.id ?? null };
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

/**
 * Envoi d'un e-mail de relance. Conditions obligatoires (sinon l'envoi est REFUSÉ, jamais simulé) :
 *  - fournisseur d'e-mail connecté pour l'espace de travail ;
 *  - le prospect a donné son consentement marketing ;
 *  - le prospect ne s'est pas désinscrit et n'est pas dans la liste de suppression.
 */
export async function sendFollowUpEmail(p: { workspaceId: string; leadId: string; subject: string; body: string }): Promise<MarketingResult> {
  const lead = await db.lead.findFirst({ where: { id: p.leadId, workspaceId: p.workspaceId, deletedAt: null } });
  if (!lead || !lead.email) return { sent: false, reason: "Le prospect n'a pas d'adresse e-mail." };
  if (!lead.consentMarketing) return { sent: false, reason: "Le prospect n'a pas consenti à recevoir des e-mails marketing." };
  if (lead.unsubscribedAt) return { sent: false, reason: "Le prospect s'est désinscrit." };
  if (await db.emailSuppression.findUnique({ where: { workspaceId_email: { workspaceId: p.workspaceId, email: lead.email.toLowerCase() } } })) return { sent: false, reason: "Adresse dans la liste de suppression." };
  const provider = await workspaceEmailProvider(p.workspaceId);
  if (!provider) return { sent: false, reason: "Aucun fournisseur d'e-mail connecté (Intégrations → E-mail)." };

  const link = unsubscribeUrl(p.workspaceId, lead.id);
  const text = `${p.body}\n\n—\nPour ne plus recevoir nos messages : ${link}`;
  try {
    const r = await provider.send({ to: lead.email, subject: p.subject, text, headers: { "List-Unsubscribe": `<${env.appUrl}/api/unsubscribe/${unsubscribeToken(p.workspaceId, lead.id)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
    await db.emailLog.create({ data: { workspaceId: p.workspaceId, leadId: lead.id, to: lead.email, subject: p.subject, provider: provider.id, status: "sent", providerMessageId: r.id } });
    return { sent: true };
  } catch (e) {
    await db.emailLog.create({ data: { workspaceId: p.workspaceId, leadId: lead.id, to: lead.email, subject: p.subject, provider: provider.id, status: "failed", error: errMsg(e).slice(0, 200) } });
    return { sent: false, reason: `Échec d'envoi : ${errMsg(e)}` };
  }
}

/** E-mail système (non marketing) via le fournisseur de la plateforme. Retourne false si aucun fournisseur n'est configuré. */
export async function sendSystemEmail(m: OutgoingEmail): Promise<boolean> {
  const p = platformEmailProvider();
  if (!p) { log.error("email.no_platform_provider", {}); return false; }
  try { await p.send(m); return true; } catch (e) { log.error("email.system_failed", { error: errMsg(e) }); return false; }
}
