import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createLead, eraseLead, setEraseHookForTests, unsubscribeLead, KEEP_CONSENT_PROOF_AT_ERASURE } from "@/lib/leads";
import { erasedEmailKey, isEmailSuppressed } from "@/lib/suppression";
import { makeWorkspace, resetDb } from "./helpers";

beforeEach(resetDb);
afterEach(() => setEraseHookForTests(null));

const EMAIL = "martine.quasar@exemple.test";
const SECRETS = [EMAIL, "Martine Quasar", "0611223344", "Zeta Corp", "Besoin devis Quasar", "SECRETVILLE", "PARTIAILLEURS", "client-notes-quasar", "iphash-quasar", "sess-quasar", "https://ref.quasar.test"];

/** Un prospect riche (toutes les données liées) dans un espace, avec ses voisins : un autre prospect du même espace, et le même e-mail dans un autre espace. */
async function fixture() {
  const a = await makeWorkspace("Acme");
  const b = await makeWorkspace("Autre");
  const W = a.workspaceId;
  const { lead } = await createLead({
    workspaceId: W, name: "Martine Quasar", email: EMAIL, phone: "0611223344", company: "Zeta Corp", message: "Besoin devis Quasar",
    customFields: { ville: "SECRETVILLE" }, consentMarketing: true, consentText: "J'accepte de recevoir des offres", ipHash: "iphash-quasar", referrer: "https://ref.quasar.test", source: "form",
  });
  await db.lead.update({ where: { id: lead.id }, data: { lostReason: "PARTIAILLEURS" } });
  const customer = await db.customer.create({ data: { workspaceId: W, name: "Martine Quasar", email: EMAIL, phone: "0611223344", company: "Zeta Corp", notes: "client-notes-quasar", revenue: 500 } });
  await db.lead.update({ where: { id: lead.id }, data: { customerId: customer.id } });
  await db.contact.create({ data: { workspaceId: W, customerId: customer.id, name: "Collègue Quasar", email: "collegue@exemple.test" } });
  await db.contact.create({ data: { workspaceId: W, leadId: lead.id, name: "Martine Quasar", email: EMAIL } });
  await db.conversation.create({ data: { workspaceId: W, leadId: lead.id, body: "note Martine Quasar" } });
  await db.task.create({ data: { workspaceId: W, leadId: lead.id, title: "Appeler Martine Quasar" } });
  await db.notification.create({ data: { workspaceId: W, type: "reminder", title: "Rappeler Martine Quasar", href: `/leads/${lead.id}` } });
  await db.notification.create({ data: { workspaceId: W, type: "followup_review", title: "Une relance est à examiner", href: "/automations" } });
  const seq = await db.followUpSequence.create({ data: { workspaceId: W, name: "S", steps: [{ day: 0, action: "email", subject: "Bonjour {{prenom}}", body: "Merci" }], active: true } });
  const fu = (id: string, status: string, result: string | null) => db.followUp.create({ data: { id, workspaceId: W, leadId: lead.id, sequenceId: seq.id, action: "email", status, result, dueAt: new Date(), payload: { day: 0, action: "email", subject: "Bonjour {{prenom}}", body: "Merci" } } });
  await fu("fu_pending", "pending", null);
  await fu("fu_done", "done", "E-mail envoyé.");
  await fu("fu_blocked", "blocked", `Échec d'envoi : adresse ${EMAIL} refusée`);
  await db.emailLog.create({ data: { id: "el:fu_blocked:1", workspaceId: W, leadId: lead.id, to: EMAIL, subject: "Bonjour Martine Quasar", provider: "fake", status: "failed", error: `refus pour ${EMAIL}`, providerMessageId: "msg_quasar", httpStatus: 422, followUpId: "fu_blocked", attemptNo: 1, humanNote: "Vérifié pour Martine Quasar", humanVerdict: "confirmed_not_sent", contradictionAckNote: "ack Martine Quasar" } });
  await db.analyticsEvent.create({ data: { workspaceId: W, type: "form_submit", leadId: lead.id, sessionId: "sess-quasar", referrer: "https://ref.quasar.test", utmCampaign: "cmp1" } });
  await db.emailSuppression.create({ data: { workspaceId: W, email: EMAIL, reason: "unsubscribe" } }); // désinscription antérieure, en clair
  await db.auditLog.create({ data: { workspaceId: W, action: "lead.email_changed", entity: "Lead", entityId: lead.id, meta: { consentRevoked: true } } });

  // voisins : autre prospect de l'espace (autre client, mêmes types de données) et même adresse dans un autre espace
  const other = await createLead({ workspaceId: W, name: "Voisin Dupont", email: "voisin@exemple.test", phone: "0700000000", company: "Voisin SA", customFields: { ville: "Lyon" }, consentMarketing: true, ipHash: "iphash-voisin" });
  const otherCustomer = await db.customer.create({ data: { workspaceId: W, name: "Voisin Dupont", email: "voisin@exemple.test", revenue: 90 } });
  await db.lead.update({ where: { id: other.lead.id }, data: { customerId: otherCustomer.id } });
  await db.conversation.create({ data: { workspaceId: W, leadId: other.lead.id, body: "note voisin" } });
  const foreign = await createLead({ workspaceId: b.workspaceId, name: "Martine Quasar", email: EMAIL, phone: "0611223344", company: "Zeta Corp", customFields: { ville: "SECRETVILLE" }, consentMarketing: true });
  await db.conversation.create({ data: { workspaceId: b.workspaceId, leadId: foreign.lead.id, body: "note autre espace" } });
  return { W, WB: b.workspaceId, userId: a.userId, lead, customer, other: other.lead, otherCustomer, foreign: foreign.lead };
}

const snapshot = async (W: string) => JSON.stringify({
  leads: await db.lead.findMany({ where: { workspaceId: W }, orderBy: { id: "asc" } }),
  customers: await db.customer.findMany({ where: { workspaceId: W }, orderBy: { id: "asc" } }),
  contacts: await db.contact.findMany({ where: { workspaceId: W }, orderBy: { id: "asc" } }),
  conversations: await db.conversation.findMany({ where: { workspaceId: W }, orderBy: { id: "asc" } }),
  notifications: await db.notification.findMany({ where: { workspaceId: W }, orderBy: { id: "asc" } }),
  consents: await db.consent.findMany({ where: { workspaceId: W }, orderBy: { id: "asc" } }),
  suppression: await db.emailSuppression.findMany({ where: { workspaceId: W }, orderBy: { id: "asc" } }),
  emailLogs: await db.emailLog.findMany({ where: { workspaceId: W }, orderBy: { id: "asc" } }),
  followUps: await db.followUp.findMany({ where: { workspaceId: W }, orderBy: { id: "asc" } }),
  events: await db.analyticsEvent.findMany({ where: { workspaceId: W }, orderBy: { id: "asc" } }),
  tasks: await db.task.findMany({ where: { workspaceId: W }, orderBy: { id: "asc" } }),
  activities: await db.leadActivity.findMany({ where: { workspaceId: W }, orderBy: { id: "asc" } }),
});

describe("effacement d'un prospect : données personnelles", () => {
  it("fiche : coordonnées, message, champs personnalisés, motif de perte, IP, référent et texte de consentement effacés ; statistiques conservées", async () => {
    const f = await fixture();
    expect(await eraseLead(f.W, f.lead.id, f.userId)).toBe(true);
    const l = await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } });
    expect([l.name, l.email, l.phone, l.company, l.message, l.customFields, l.lostReason, l.ipHash, l.referrer, l.landingUrl, l.consentText, l.consentMarketing]).toEqual(["Prospect effacé", null, null, null, null, null, null, null, null, null, null, false]);
    expect(l.deletedAt).not.toBeNull();
    expect([l.source, l.customerId]).toEqual(["form", f.customer.id]); // attribution et lien conservés
  });

  it("client lié : identité anonymisée, montant conservé, contacts du client supprimés", async () => {
    const f = await fixture();
    await eraseLead(f.W, f.lead.id, f.userId);
    const c = await db.customer.findUniqueOrThrow({ where: { id: f.customer.id } });
    expect([c.name, c.email, c.phone, c.company, c.notes, c.revenue]).toEqual(["Client effacé", null, null, null, null, 500]);
    expect(await db.contact.count({ where: { customerId: f.customer.id } })).toBe(0);
    expect(await db.contact.count({ where: { leadId: f.lead.id } })).toBe(0);
  });

  it("client partagé avec un autre prospect : conservé tant que l'autre prospect n'est pas effacé", async () => {
    const f = await fixture();
    await db.lead.update({ where: { id: f.other.id }, data: { customerId: f.customer.id } });
    await eraseLead(f.W, f.lead.id, f.userId);
    expect((await db.customer.findUniqueOrThrow({ where: { id: f.customer.id } })).name).toBe("Martine Quasar");
    await eraseLead(f.W, f.other.id, f.userId);
    expect((await db.customer.findUniqueOrThrow({ where: { id: f.customer.id } })).name).toBe("Client effacé");
  });

  it("notifications du prospect supprimées, les autres conservées", async () => {
    const f = await fixture();
    expect(await db.notification.count({ where: { workspaceId: f.W, href: `/leads/${f.lead.id}` } })).toBe(2); // « nouveau lead » + rappel
    await eraseLead(f.W, f.lead.id, f.userId);
    expect(await db.notification.count({ where: { workspaceId: f.W, href: { startsWith: `/leads/${f.lead.id}` } } })).toBe(0);
    expect(await db.notification.count({ where: { workspaceId: f.W, href: "/automations" } })).toBe(1);
    expect(await db.notification.count({ where: { workspaceId: f.W, href: `/leads/${f.other.id}` } })).toBe(1);
  });

  it("relances actives (en attente, bloquées) annulées, relances terminées conservées avec un résultat sans texte libre", async () => {
    const f = await fixture();
    await eraseLead(f.W, f.lead.id, f.userId);
    const rows = Object.fromEntries((await db.followUp.findMany({ where: { leadId: f.lead.id } })).map((r) => [r.id, r]));
    expect([rows.fu_pending.status, rows.fu_pending.failureKind]).toEqual(["cancelled", "revoked"]);
    expect(rows.fu_done.status).toBe("done");
    expect([rows.fu_blocked.status, rows.fu_blocked.failureKind]).toEqual(["cancelled", "revoked"]); // « bloquée » = encore active : annulée par la révocation
    for (const r of Object.values(rows)) if (r.result) expect(r.result).toBe("Résultat effacé (prospect effacé).");
    expect(JSON.stringify(rows)).not.toContain(EMAIL);
  });

  it("journal d'e-mails : adresse, objet, erreur et notes retirés ; résultat fournisseur et identifiants techniques conservés", async () => {
    const f = await fixture();
    await eraseLead(f.W, f.lead.id, f.userId);
    const e = await db.emailLog.findUniqueOrThrow({ where: { id: "el:fu_blocked:1" } });
    expect([e.to, e.subject, e.error, e.humanNote, e.contradictionAckNote]).toEqual(["[effacé]", "[effacé]", null, null, null]);
    expect([e.status, e.providerMessageId, e.httpStatus, e.followUpId, e.attemptNo, e.humanVerdict]).toEqual(["failed", "msg_quasar", 422, "fu_blocked", 1, "confirmed_not_sent"]);
  });

  it("consentement : preuve conservée mais pseudonymisée (adresse remplacée par une empreinte, IP retirée)", async () => {
    expect(KEEP_CONSENT_PROOF_AT_ERASURE).toBe(true);
    const f = await fixture();
    const before = await db.consent.findMany({ where: { leadId: f.lead.id } });
    expect(before.length).toBeGreaterThan(0);
    await eraseLead(f.W, f.lead.id, f.userId);
    const after = await db.consent.findMany({ where: { leadId: f.lead.id } });
    expect(after).toHaveLength(before.length);
    for (const c of after) { expect(c.email).toBe(erasedEmailKey(f.W, EMAIL)); expect(c.ipHash).toBeNull(); expect(c.type).toBe("marketing"); }
    expect(after.map((c) => c.granted).sort()).toEqual(before.map((c) => c.granted).sort());
  });

  it("liste de suppression : l'adresse reste bloquée sans être lisible, uniquement dans son espace ; l'ancienne ligne en clair est remplacée", async () => {
    const f = await fixture();
    await eraseLead(f.W, f.lead.id, f.userId);
    const rows = await db.emailSuppression.findMany({ where: { workspaceId: f.W } });
    expect(rows.map((r) => r.email)).toEqual([erasedEmailKey(f.W, EMAIL)]);
    expect(rows[0].reason).toBe("erasure");
    expect(JSON.stringify(rows)).not.toContain("exemple.test");
    expect(await isEmailSuppressed(db, f.W, EMAIL)).toBe(true);
    expect(await isEmailSuppressed(db, f.W, EMAIL.toUpperCase())).toBe(true);
    expect(await isEmailSuppressed(db, f.WB, EMAIL)).toBe(false);
    expect(erasedEmailKey(f.W, EMAIL)).not.toBe(erasedEmailKey(f.WB, EMAIL));
    expect(await db.emailSuppression.count({ where: { workspaceId: f.WB } })).toBe(0);
  });

  it("la recherche de suppression reconnaît aussi une ligne en clair (désinscription) : aucune régression", async () => {
    const { workspaceId } = await makeWorkspace();
    const { lead } = await createLead({ workspaceId, name: "U", email: "u@exemple.test", consentMarketing: true });
    await unsubscribeLead(workspaceId, lead.id);
    expect(await isEmailSuppressed(db, workspaceId, "U@Exemple.test")).toBe(true);
    expect(await isEmailSuppressed(db, workspaceId, "autre@exemple.test")).toBe(false);
  });

  it("événements analytiques : détachés du prospect et de la session, comptages conservés", async () => {
    const f = await fixture();
    const n = await db.analyticsEvent.count({ where: { workspaceId: f.W } });
    await eraseLead(f.W, f.lead.id, f.userId);
    expect(await db.analyticsEvent.count({ where: { workspaceId: f.W } })).toBe(n);
    expect(await db.analyticsEvent.count({ where: { workspaceId: f.W, leadId: f.lead.id } })).toBe(0);
    const ev = await db.analyticsEvent.findMany({ where: { workspaceId: f.W, type: "form_submit" } });
    expect(ev.map((e) => [e.sessionId, e.referrer, e.utmCampaign])).toEqual([[null, null, "cmp1"]]);
  });

  it("audit : événement d'effacement cohérent, sans donnée personnelle ; événements antérieurs conservés", async () => {
    const f = await fixture();
    await eraseLead(f.W, f.lead.id, f.userId);
    const a = await db.auditLog.findMany({ where: { workspaceId: f.W } });
    expect(a.map((x) => x.action).sort()).toEqual(["lead.email_changed", "lead.erased", "workspace.created"]);
    const erased = a.find((x) => x.action === "lead.erased")!;
    expect([erased.entityId, erased.userId, erased.meta]).toEqual([f.lead.id, f.userId, { customerAnonymized: true, consentProofKept: true }]);
    for (const s of SECRETS) expect(JSON.stringify(a)).not.toContain(s);
  });

  it("aucune donnée personnelle résiduelle dans aucune table liée", async () => {
    const f = await fixture();
    await eraseLead(f.W, f.lead.id, f.userId);
    const dump = [
      await db.lead.findMany({ where: { id: f.lead.id } }), await db.customer.findMany({ where: { id: f.customer.id } }), await db.contact.findMany({ where: { OR: [{ leadId: f.lead.id }, { customerId: f.customer.id }] } }),
      await db.conversation.findMany({ where: { leadId: f.lead.id } }), await db.task.findMany({ where: { leadId: f.lead.id } }), await db.notification.findMany({ where: { workspaceId: f.W, href: { startsWith: `/leads/${f.lead.id}` } } }),
      await db.emailLog.findMany({ where: { leadId: f.lead.id } }), await db.consent.findMany({ where: { leadId: f.lead.id } }), await db.followUp.findMany({ where: { leadId: f.lead.id } }),
      await db.emailSuppression.findMany({ where: { workspaceId: f.W } }), await db.leadActivity.findMany({ where: { leadId: f.lead.id } }), await db.aIQualification.findMany({ where: { leadId: f.lead.id } }),
      await db.analyticsEvent.findMany({ where: { workspaceId: f.W, utmCampaign: "cmp1" } }), await db.auditLog.findMany({ where: { workspaceId: f.W } }),
    ];
    const text = JSON.stringify(dump);
    for (const s of SECRETS) expect(text, s).not.toContain(s);
    expect(await db.leadActivity.count({ where: { leadId: f.lead.id } })).toBe(0);
    expect(await db.aIQualification.count({ where: { leadId: f.lead.id } })).toBe(0);
  });
});

describe("effacement d'un prospect : périmètre", () => {
  it("un autre prospect du même espace reste strictement intact (fiche, client, notes, notifications, consentements)", async () => {
    const f = await fixture();
    const pick = async () => JSON.stringify({
      lead: await db.lead.findUnique({ where: { id: f.other.id } }), customer: await db.customer.findUnique({ where: { id: f.otherCustomer.id } }),
      conv: await db.conversation.findMany({ where: { leadId: f.other.id } }), notif: await db.notification.findMany({ where: { href: `/leads/${f.other.id}` } }),
      consent: await db.consent.findMany({ where: { leadId: f.other.id } }), act: await db.leadActivity.findMany({ where: { leadId: f.other.id } }), ev: await db.analyticsEvent.findMany({ where: { leadId: f.other.id } }),
    });
    const before = await pick();
    await eraseLead(f.W, f.lead.id, f.userId);
    expect(await pick()).toBe(before);
  });

  it("un autre espace reste strictement intact, même avec la même adresse e-mail", async () => {
    const f = await fixture();
    const before = await snapshot(f.WB);
    await eraseLead(f.W, f.lead.id, f.userId);
    expect(await snapshot(f.WB)).toBe(before);
    expect(await eraseLead(f.W, f.foreign.id)).toBe(false); // un prospect d'un autre espace n'est pas atteignable
    expect(await snapshot(f.WB)).toBe(before);
  });

  it("un second effacement est sans effet de bord (idempotent) et la clé de suppression reste unique", async () => {
    const f = await fixture();
    await eraseLead(f.W, f.lead.id, f.userId);
    expect(await eraseLead(f.W, f.lead.id, f.userId)).toBe(true);
    expect(await db.emailSuppression.count({ where: { workspaceId: f.W } })).toBe(1);
    expect((await db.customer.findUniqueOrThrow({ where: { id: f.customer.id } })).revenue).toBe(500);
  });
});

describe("effacement d'un prospect : atomicité", () => {
  for (const step of ["afterRevoke", "afterConsent", "afterCustomer", "beforeCommit"]) {
    it(`erreur à l'étape « ${step} » : aucune modification n'est validée`, async () => {
      const f = await fixture();
      const before = await snapshot(f.W);
      const auditBefore = await db.auditLog.count({ where: { workspaceId: f.W } });
      setEraseHookForTests((s) => { if (s === step) throw new Error("panne simulée"); });
      await expect(eraseLead(f.W, f.lead.id, f.userId)).rejects.toThrow("panne simulée");
      setEraseHookForTests(null);
      expect(await snapshot(f.W)).toBe(before);
      expect(await db.auditLog.count({ where: { workspaceId: f.W } })).toBe(auditBefore); // aucun « lead.erased » sans effacement
      // l'effacement peut ensuite être rejoué normalement
      expect(await eraseLead(f.W, f.lead.id, f.userId)).toBe(true);
      expect((await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } })).email).toBeNull();
    });
  }
});
