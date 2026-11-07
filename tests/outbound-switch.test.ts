import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { processDueFollowUps } from "@/lib/followups";
import { sendFollowUpEmail, setEmailProviderForTests } from "@/lib/email";
import { LEASE_MS } from "@/lib/followup-runtime";
import { POST as cron } from "@/app/api/cron/followups/route";
import { FakeProvider, MIN, dbFixture, emailFixture, later, noRetryDelay, resetEngineTestState } from "./followup-helpers";
import { resetDb } from "./helpers";

// Interrupteur global des envois (OUTBOUND_SENDING_DISABLED) : les relances e-mail restent EN ATTENTE, intactes ; le reste continue ; la levée de l'interrupteur les fait repartir.

const SECRET = "cron-secret-for-tests-only";
const row = (id: string) => db.followUp.findUniqueOrThrow({ where: { id } });
const post = () => cron(new Request("http://x/api/cron/followups?sync=0&reconcile=0&purge=0", { method: "POST", headers: { authorization: `Bearer ${SECRET}` } }));

beforeEach(async () => { await resetDb(); noRetryDelay(); });
afterEach(() => { resetEngineTestState(); delete process.env.OUTBOUND_SENDING_DISABLED; delete process.env.CRON_SECRET; });

describe("lecture de la variable : un doute suspend les envois", () => {
  const read = (v: string | undefined) => { if (v === undefined) delete process.env.OUTBOUND_SENDING_DISABLED; else process.env.OUTBOUND_SENDING_DISABLED = v; return env.outboundSendingDisabled; };
  it("absente, vide, blanche ou explicitement négative : envois actifs", () => {
    for (const v of [undefined, "", "   ", "0", "false", "FALSE", "no", "Non", "off", " off ", '"false"']) expect(read(v), JSON.stringify(v)).toBe(false);
  });
  it("toute autre valeur (y compris une faute de frappe) : envois suspendus", () => {
    for (const v of ["1", "true", "TRUE", " yes ", "on", "oui", "flase", "disabled", '"true"']) expect(read(v), JSON.stringify(v)).toBe(true);
  });
});

describe("relances automatiques", () => {
  it("interrupteur actif : la relance e-mail échue reste intacte (pending, aucune tentative, aucun journal, aucun appel fournisseur), puis repart à la levée", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    process.env.OUTBOUND_SENDING_DISABLED = "true";
    const s = await processDueFollowUps({ workspaceId: f.workspaceId });
    expect(s.processed).toBe(0);
    expect(p.calls).toHaveLength(0);
    expect(await row(f.fu.id)).toMatchObject({ status: "pending", attemptCount: 0, leaseToken: null, technicalFailureCount: 0, result: null });
    expect(await db.emailLog.count({ where: { followUpId: f.fu.id } })).toBe(0);
    expect(await db.task.count({ where: { workspaceId: f.workspaceId } })).toBe(0); // pas de tâche manuelle de substitution : la relance est simplement retenue
    delete process.env.OUTBOUND_SENDING_DISABLED;
    const again = await processDueFollowUps({ workspaceId: f.workspaceId });
    expect(again.done).toBe(1);
    expect(p.calls).toHaveLength(1);
    expect((await row(f.fu.id)).status).toBe("done");
  });

  it("interrupteur actif : les actions qui n'envoient rien (tâche) continuent", async () => {
    const f = await dbFixture([{ day: 0, action: "task", title: "Appeler {{nom}}" }]);
    process.env.OUTBOUND_SENDING_DISABLED = "1";
    const s = await processDueFollowUps({ workspaceId: f.workspaceId });
    expect(s.done).toBe(1);
    expect((await row(f.fu.id)).status).toBe("done");
    expect(await db.task.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
  });

  it("interrupteur actif : une réservation d'e-mail expirée n'est PAS reprise (jeton, compteurs et état inchangés)", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    await db.followUp.update({ where: { id: f.fu.id }, data: { status: "running", leaseToken: "jeton-ancien", leaseUntil: new Date(Date.now() - MIN) } });
    process.env.OUTBOUND_SENDING_DISABLED = "true";
    await processDueFollowUps({ workspaceId: f.workspaceId, now: later(LEASE_MS + MIN) });
    expect(p.calls).toHaveLength(0);
    expect(await row(f.fu.id)).toMatchObject({ status: "running", leaseToken: "jeton-ancien", technicalFailureCount: 0 });
  });

  it("sans interrupteur : comportement inchangé (l'e-mail part)", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    expect((await processDueFollowUps({ workspaceId: f.workspaceId })).done).toBe(1);
    expect(p.calls).toHaveLength(1);
  });
});

describe("envoi direct, tâche planifiée", () => {
  it("sendFollowUpEmail (envoi direct) refuse sans rien écrire", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    process.env.OUTBOUND_SENDING_DISABLED = "true";
    expect(await sendFollowUpEmail({ workspaceId: f.workspaceId, leadId: f.lead.id, subject: "s", body: "b" })).toMatchObject({ sent: false, reason: expect.stringContaining("suspendus") });
    expect(p.calls).toHaveLength(0);
    expect(await db.emailLog.count({ where: { workspaceId: f.workspaceId } })).toBe(0);
  });

  it("la tâche planifiée le signale (outboundSendingDisabled, complete=false) et ne touche pas aux e-mails ; sans interrupteur le champ est absent", async () => {
    process.env.CRON_SECRET = SECRET;
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    process.env.OUTBOUND_SENDING_DISABLED = "true";
    const body = await (await post()).json();
    expect(body.outboundSendingDisabled).toBe(true);
    expect(body.complete).toBe(false);
    expect(p.calls).toHaveLength(0);
    expect((await row(f.fu.id)).status).toBe("pending");
    delete process.env.OUTBOUND_SENDING_DISABLED;
    const normal = await (await post()).json();
    expect(normal).not.toHaveProperty("outboundSendingDisabled");
    expect(p.calls).toHaveLength(1);
  });
});
