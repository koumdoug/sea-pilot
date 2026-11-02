import { vi } from "vitest";
import { db } from "@/lib/db";
import { createLead } from "@/lib/leads";
import { enrollLead } from "@/lib/followups";
import { setEmailProviderForTests, type EmailProvider, type OutgoingEmail, type SentEmail } from "@/lib/email";
import { setRetryTimingForTests, setTimingForTests } from "@/lib/followup-runtime";
import { setSendHooksForTests } from "@/lib/followup-send";
import { makeWorkspace } from "./helpers";

export const MIN = 60_000;
export const later = (ms: number) => new Date(Date.now() + ms);

/** Faux fournisseur d'e-mail : enregistre les appels et simule réponses, refus, incertitudes et arrêts. */
export class FakeProvider implements EmailProvider {
  readonly id = "fake";
  calls: OutgoingEmail[] = [];
  constructor(public behavior: (m: OutgoingEmail, n: number) => Promise<SentEmail> = async () => ({ id: "msg_1", httpStatus: 200 })) {}
  async send(m: OutgoingEmail): Promise<SentEmail> {
    this.calls.push(m);
    return this.behavior(m, this.calls.length);
  }
}

export function resetEngineTestState() {
  setEmailProviderForTests(null);
  setSendHooksForTests(null);
  setRetryTimingForTests(null);
  setTimingForTests(null);
  vi.restoreAllMocks();
  vi.useRealTimers();
}
/** Supprime l'attente des reprises transactionnelles (jitter 100–400 ms) pour les tests. */
export const noRetryDelay = () => setRetryTimingForTests({ sleep: async () => {}, jitter: () => 0 });

/** Point de blocage : `reached` se résout quand l'exécution atteint le point ; elle y reste jusqu'à `release()`. */
export function gate() {
  let release!: () => void;
  let reachedResolve!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  const reached = new Promise<void>((r) => (reachedResolve = r));
  return { hold, release, reached, reachedResolve };
}
/** Hook qui ne bloque que le PREMIER passage (la reprise par un second exécuteur ne doit pas s'y bloquer). */
export function stallOnce(g: ReturnType<typeof gate>) {
  let first = true;
  return async () => {
    if (!first) return;
    first = false;
    g.reachedResolve();
    await g.hold;
  };
}

export async function dbFixture(steps: unknown[], opts: { sendEmails?: boolean; consent?: boolean; email?: string | null; role?: string } = {}) {
  const w = await makeWorkspace("Acme", opts.role ? { role: opts.role } : {});
  const seq = await db.followUpSequence.create({ data: { workspaceId: w.workspaceId, name: "S", sendEmails: opts.sendEmails ?? false, steps: steps as never } });
  const { lead } = await createLead({ workspaceId: w.workspaceId, name: "Marie Durand", email: opts.email === undefined ? "m@y.com" : opts.email, consentMarketing: opts.consent ?? true });
  await enrollLead({ workspaceId: w.workspaceId, leadId: lead.id, sequenceId: seq.id, now: new Date(Date.now() - 1000) });
  const fus = await db.followUp.findMany({ where: { leadId: lead.id }, orderBy: { stepIndex: "asc" } });
  return { ...w, seq, lead, fus, fu: fus[0] };
}
export const emailFixture = (opts: Parameters<typeof dbFixture>[1] = {}) => dbFixture([{ day: 0, action: "email", subject: "Bonjour {{prenom}}", body: "Merci {{nom}}" }], { sendEmails: true, ...opts });
export const taskFixture = () => dbFixture([{ day: 0, action: "task", title: "Appeler {{nom}}" }]);

export const seqData = (seq: { name: string; description: string | null; steps: unknown; autoEnroll: boolean; sendEmails: boolean }, active: boolean) =>
  ({ name: seq.name, description: seq.description, steps: seq.steps as never, active, autoEnroll: seq.autoEnroll, sendEmails: seq.sendEmails });

export const err = (code: string, message = code) => Object.assign(new Error(message), { code });
