import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createLead } from "@/lib/leads";
import { DEFAULT_SEQUENCE_STEPS, enrollLead, processDueFollowUps, renderTemplate, stepsSchema } from "@/lib/followups";
import { setEmailProviderForTests, type EmailProvider, type OutgoingEmail } from "@/lib/email";
import { makeWorkspace, resetDb } from "./helpers";

beforeEach(resetDb);
afterEach(() => setEmailProviderForTests(null));

class Spy implements EmailProvider {
  readonly id = "spy";
  sent: OutgoingEmail[] = [];
  async send(m: OutgoingEmail) { this.sent.push(m); return { id: "m1" }; }
}

const emailSeq = (workspaceId: string, sendEmails: boolean) =>
  db.followUpSequence.create({ data: { workspaceId, name: "Mail", sendEmails, steps: [{ day: 0, action: "email", subject: "Bonjour {{prenom}}", body: "Merci {{nom}}" }] } });

describe("séquence par défaut", () => {
  it("J0, J1, J3, J7, J14 et valide", () => {
    expect(DEFAULT_SEQUENCE_STEPS.map((s) => s.day)).toEqual([0, 1, 3, 7, 14]);
    expect(stepsSchema.safeParse(DEFAULT_SEQUENCE_STEPS).success).toBe(true);
  });
  it("variables de gabarit", () => {
    expect(renderTemplate("Salut {{prenom}} de {{entreprise}} ({{nom}})", { name: "Marie Durand", company: "ACME" })).toBe("Salut Marie de ACME (Marie Durand)");
  });
});

describe("planification", () => {
  it("l'inscription planifie une relance par étape aux bons jours, sans doublon", async () => {
    const { workspaceId } = await makeWorkspace();
    const seq = await db.followUpSequence.create({ data: { workspaceId, name: "S", steps: DEFAULT_SEQUENCE_STEPS } });
    const { lead } = await createLead({ workspaceId, name: "X", email: "x@y.com" });
    const t0 = new Date("2026-06-01T10:00:00Z");
    expect((await enrollLead({ workspaceId, leadId: lead.id, sequenceId: seq.id, now: t0 })).count).toBe(5);
    const fu = await db.followUp.findMany({ where: { leadId: lead.id }, orderBy: { dueAt: "asc" } });
    expect(fu.map((f) => Math.round((f.dueAt.getTime() - t0.getTime()) / 86_400_000))).toEqual([0, 1, 3, 7, 14]);
    expect((await enrollLead({ workspaceId, leadId: lead.id, sequenceId: seq.id })).reason).toMatch(/Déjà inscrit/);
  });
});

describe("exécution — jamais d'e-mail réel sans consentement ni configuration", () => {
  it("séquence sans autorisation d'envoi : aucune e-mail, tâche manuelle créée", async () => {
    const { workspaceId } = await makeWorkspace();
    const spy = new Spy(); setEmailProviderForTests(spy);
    const seq = await emailSeq(workspaceId, false);
    const { lead } = await createLead({ workspaceId, name: "Marie D", email: "m@y.com", consentMarketing: true });
    await enrollLead({ workspaceId, leadId: lead.id, sequenceId: seq.id });
    const s = await processDueFollowUps({ workspaceId });
    expect(s.blocked).toBe(1);
    expect(spy.sent).toHaveLength(0);
    expect(await db.task.count({ where: { leadId: lead.id, source: "followup" } })).toBe(1);
  });

  it("autorisation + fournisseur + consentement : e-mail envoyé avec lien de désinscription, journalisé", async () => {
    const { workspaceId } = await makeWorkspace();
    const spy = new Spy(); setEmailProviderForTests(spy);
    const seq = await emailSeq(workspaceId, true);
    const { lead } = await createLead({ workspaceId, name: "Marie D", email: "m@y.com", consentMarketing: true });
    await enrollLead({ workspaceId, leadId: lead.id, sequenceId: seq.id });
    const s = await processDueFollowUps({ workspaceId });
    expect(s.done).toBe(1);
    expect(spy.sent).toHaveLength(1);
    expect(spy.sent[0].subject).toBe("Bonjour Marie");
    expect(spy.sent[0].text).toContain("/unsubscribe/");
    expect(spy.sent[0].headers?.["List-Unsubscribe"]).toContain("/api/unsubscribe/");
    expect(await db.emailLog.count({ where: { leadId: lead.id, status: "sent" } })).toBe(1);
    expect(await db.conversation.count({ where: { leadId: lead.id, channel: "email", direction: "outbound" } })).toBe(1);
  });

  it("sans consentement du prospect : bloqué même si la séquence autorise l'envoi", async () => {
    const { workspaceId } = await makeWorkspace();
    const spy = new Spy(); setEmailProviderForTests(spy);
    const seq = await emailSeq(workspaceId, true);
    const { lead } = await createLead({ workspaceId, name: "Sans Consentement", email: "n@y.com", consentMarketing: false });
    await enrollLead({ workspaceId, leadId: lead.id, sequenceId: seq.id });
    const s = await processDueFollowUps({ workspaceId });
    expect(s.blocked).toBe(1);
    expect(spy.sent).toHaveLength(0);
    const f = await db.followUp.findFirstOrThrow({ where: { leadId: lead.id } });
    expect(f.result).toMatch(/consenti/);
  });

  it("sans fournisseur d'e-mail connecté : bloqué (pas de simulation d'envoi)", async () => {
    const { workspaceId } = await makeWorkspace();
    const seq = await emailSeq(workspaceId, true);
    const { lead } = await createLead({ workspaceId, name: "Marie D", email: "m@y.com", consentMarketing: true });
    await enrollLead({ workspaceId, leadId: lead.id, sequenceId: seq.id });
    const s = await processDueFollowUps({ workspaceId });
    expect(s.blocked).toBe(1);
    expect((await db.followUp.findFirstOrThrow({ where: { leadId: lead.id } })).result).toMatch(/fournisseur d'e-mail/);
    expect(await db.emailLog.count({ where: { workspaceId } })).toBe(0);
  });

  it("prospect devenu client ou désinscrit entre-temps : étape annulée, rien d'envoyé", async () => {
    const { workspaceId } = await makeWorkspace();
    const spy = new Spy(); setEmailProviderForTests(spy);
    const seq = await emailSeq(workspaceId, true);
    const { lead } = await createLead({ workspaceId, name: "Marie D", email: "m@y.com", consentMarketing: true });
    await enrollLead({ workspaceId, leadId: lead.id, sequenceId: seq.id });
    await db.lead.update({ where: { id: lead.id }, data: { status: "won" } }); // contourne le service pour tester la garde à l'exécution
    const s = await processDueFollowUps({ workspaceId });
    expect(s.cancelled).toBe(1);
    expect(spy.sent).toHaveLength(0);
  });

  it("tâche, rappel et changement de statut", async () => {
    const { workspaceId } = await makeWorkspace();
    const seq = await db.followUpSequence.create({ data: { workspaceId, name: "S", steps: [
      { day: 0, action: "task", title: "Appeler {{nom}}" }, { day: 0, action: "reminder", title: "Rappel {{nom}}" }, { day: 0, action: "status_change", status: "contacted" },
    ] } });
    const { lead } = await createLead({ workspaceId, name: "Paul Martin", email: "p@y.com" });
    await enrollLead({ workspaceId, leadId: lead.id, sequenceId: seq.id });
    const s = await processDueFollowUps({ workspaceId });
    expect(s.done).toBe(3);
    expect((await db.task.findFirstOrThrow({ where: { leadId: lead.id } })).title).toBe("Appeler Paul Martin");
    expect(await db.notification.count({ where: { workspaceId, type: "reminder" } })).toBe(1);
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe("contacted");
  });

  it("seules les relances échues sont traitées, et une relance n'est exécutée qu'une fois", async () => {
    const { workspaceId } = await makeWorkspace();
    const seq = await db.followUpSequence.create({ data: { workspaceId, name: "S", steps: [{ day: 0, action: "task", title: "now" }, { day: 5, action: "task", title: "later" }] } });
    const { lead } = await createLead({ workspaceId, name: "X", email: "x@y.com" });
    await enrollLead({ workspaceId, leadId: lead.id, sequenceId: seq.id });
    const [a, b] = await Promise.all([processDueFollowUps({ workspaceId }), processDueFollowUps({ workspaceId })]);
    expect(a.done + b.done).toBe(1);
    expect(await db.task.count({ where: { leadId: lead.id } })).toBe(1);
    expect(await db.followUp.count({ where: { leadId: lead.id, status: "pending" } })).toBe(1);
  });

  it("la clôture automatique J14 passe le lead à « perdu » avec un motif", async () => {
    const { workspaceId } = await makeWorkspace();
    const seq = await db.followUpSequence.create({ data: { workspaceId, name: "S", steps: [{ day: 14, action: "status_change", status: "lost" }] } });
    const { lead } = await createLead({ workspaceId, name: "X", email: "x@y.com" });
    await enrollLead({ workspaceId, leadId: lead.id, sequenceId: seq.id, now: new Date(Date.now() - 15 * 86_400_000) });
    await processDueFollowUps({ workspaceId });
    const l = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(l.status).toBe("lost");
    expect(l.lostReason).toMatch(/Aucune réponse/);
  });
});
