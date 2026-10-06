import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { changeLeadStatus, createLead, unsubscribeLead } from "@/lib/leads";
import { enrollLead, processDueFollowUps } from "@/lib/followups";
import { setEmailProviderForTests, type EmailProvider, type OutgoingEmail } from "@/lib/email";
import { makeWorkspace, resetDb } from "./helpers";

beforeEach(resetDb);
afterEach(() => setEmailProviderForTests(null));

const STEPS = [0, 1, 3, 7, 14].map((day) => ({ day, action: "task", title: `J${day}` }));

describe("idempotence : inscription et exécution", () => {
  it("deux inscriptions SIMULTANÉES au même lead ne créent qu'un jeu de relances", async () => {
    const { workspaceId } = await makeWorkspace();
    const seq = await db.followUpSequence.create({ data: { workspaceId, name: "S", steps: STEPS } });
    const { lead } = await createLead({ workspaceId, name: "X", email: "x@y.com" });
    const r = await Promise.all([1, 2, 3].map(() => enrollLead({ workspaceId, leadId: lead.id, sequenceId: seq.id })));
    expect(r.filter((x) => x.enrolled)).toHaveLength(1);
    expect(await db.followUp.count({ where: { leadId: lead.id } })).toBe(5);
  });

  it("crons simultanés sur plusieurs leads : chaque étape J0/J1/J3/J7/J14 exécutée exactement une fois", async () => {
    const { workspaceId } = await makeWorkspace();
    const seq = await db.followUpSequence.create({ data: { workspaceId, name: "S", steps: STEPS } });
    const leads = [];
    for (let i = 0; i < 4; i++) leads.push((await createLead({ workspaceId, name: `L${i}`, email: `l${i}@y.com` })).lead);
    const past = new Date(Date.now() - 20 * 86_400_000);
    for (const l of leads) await enrollLead({ workspaceId, leadId: l.id, sequenceId: seq.id, now: past });
    await Promise.all([1, 2, 3].map(() => processDueFollowUps({ workspaceId })));
    await processDueFollowUps({ workspaceId });
    for (const l of leads) {
      const titles = (await db.task.findMany({ where: { leadId: l.id } })).map((t) => t.title).sort();
      expect(titles).toEqual(["J0", "J1", "J14", "J3", "J7"]);
    }
    expect(await db.followUp.count({ where: { workspaceId, status: "done" } })).toBe(20);
  });

  it("erreur du fournisseur d'e-mail puis nouvelle exécution : pas de renvoi, pas de tâche en double", async () => {
    const { workspaceId } = await makeWorkspace();
    let calls = 0;
    const flaky: EmailProvider = { id: "flaky", async send() { calls++; throw new Error("réseau indisponible"); } };
    setEmailProviderForTests(flaky);
    const seq = await db.followUpSequence.create({ data: { workspaceId, name: "S", sendEmails: true, steps: [{ day: 0, action: "email", subject: "s", body: "b" }] } });
    const { lead } = await createLead({ workspaceId, name: "M", email: "m@y.com", consentMarketing: true });
    await enrollLead({ workspaceId, leadId: lead.id, sequenceId: seq.id });
    await processDueFollowUps({ workspaceId });
    await processDueFollowUps({ workspaceId });
    expect(calls).toBe(1);
    expect(await db.task.count({ where: { leadId: lead.id } })).toBe(1); // le travail n'est pas perdu : tâche manuelle
    expect(await db.emailLog.count({ where: { leadId: lead.id, status: "failed" } })).toBe(1);
    expect((await db.followUp.findFirstOrThrow({ where: { leadId: lead.id } })).status).toBe("blocked");
  });

  it("lead gagné / perdu / disqualifié / désinscrit entre deux exécutions : plus aucun effet", async () => {
    const { workspaceId } = await makeWorkspace();
    const spy: OutgoingEmail[] = [];
    setEmailProviderForTests({ id: "spy", async send(m) { spy.push(m); return { id: "x" }; } });
    const seq = await db.followUpSequence.create({ data: { workspaceId, name: "S", sendEmails: true, steps: [{ day: 0, action: "task", title: "J0" }, { day: 5, action: "email", subject: "s", body: "b" }, { day: 6, action: "task", title: "J6" }] } });
    const mk = async (n: string) => (await createLead({ workspaceId, name: n, email: `${n}@y.com`, consentMarketing: true })).lead;
    const leads = { won: await mk("won"), lost: await mk("lost"), disq: await mk("disq"), unsub: await mk("unsub") };
    const t0 = new Date(Date.now() - 2 * 86_400_000);
    for (const l of Object.values(leads)) await enrollLead({ workspaceId, leadId: l.id, sequenceId: seq.id, now: t0 });
    await processDueFollowUps({ workspaceId }); // J0 pour tous
    await changeLeadStatus({ workspaceId, leadId: leads.won.id, status: "won", value: 10 });
    await changeLeadStatus({ workspaceId, leadId: leads.lost.id, status: "lost" });
    await changeLeadStatus({ workspaceId, leadId: leads.disq.id, status: "disqualified" });
    await unsubscribeLead(workspaceId, leads.unsub.id);
    await db.followUp.updateMany({ where: { workspaceId, status: "pending" }, data: { dueAt: new Date(Date.now() - 1000) } }); // J5 et J6 deviennent échus
    await processDueFollowUps({ workspaceId });
    expect(spy).toHaveLength(0);
    for (const l of Object.values(leads)) expect(await db.task.count({ where: { leadId: l.id, title: "J6" } })).toBe(0);
    expect(await db.followUp.count({ where: { workspaceId, status: "pending" } })).toBe(0);
  });
});

describe("idempotence : changements d'état rejoués", () => {
  it("rejouer « gagné » (retry) ne duplique ni l'événement, ni l'historique, ni le client", async () => {
    const { workspaceId } = await makeWorkspace();
    const { lead } = await createLead({ workspaceId, name: "C", email: "c@y.com" });
    await changeLeadStatus({ workspaceId, leadId: lead.id, status: "won", value: 100 });
    await changeLeadStatus({ workspaceId, leadId: lead.id, status: "won", value: 100 });
    await changeLeadStatus({ workspaceId, leadId: lead.id, status: "won" });
    expect(await db.analyticsEvent.count({ where: { leadId: lead.id, type: "customer_won" } })).toBe(1);
    expect(await db.leadActivity.count({ where: { leadId: lead.id, type: "status_changed" } })).toBe(1);
    expect(await db.customer.count({ where: { workspaceId } })).toBe(1);
  });
  it("correction du montant d'un lead déjà gagné : revenu mis à jour, sans nouvel événement", async () => {
    const { workspaceId } = await makeWorkspace();
    const { lead } = await createLead({ workspaceId, name: "C", email: "c@y.com" });
    await changeLeadStatus({ workspaceId, leadId: lead.id, status: "won", value: 100 });
    await changeLeadStatus({ workspaceId, leadId: lead.id, status: "won", value: 250 });
    expect((await db.customer.findFirstOrThrow({ where: { workspaceId } })).revenue).toBe(250);
    expect(await db.analyticsEvent.count({ where: { leadId: lead.id, type: "customer_won" } })).toBe(1);
  });
  it("désinscrire deux fois : une seule trace, un seul retrait de consentement", async () => {
    const { workspaceId } = await makeWorkspace();
    const { lead } = await createLead({ workspaceId, name: "U", email: "u@y.com", consentMarketing: true });
    await unsubscribeLead(workspaceId, lead.id); await unsubscribeLead(workspaceId, lead.id);
    expect(await db.emailSuppression.count({ where: { workspaceId } })).toBe(1);
    expect(await db.consent.count({ where: { leadId: lead.id, granted: false } })).toBe(1);
    expect(await db.leadActivity.count({ where: { leadId: lead.id, type: "unsubscribed" } })).toBe(1);
  });
});
