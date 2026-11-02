import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state: { ws: string; role: string } = { ws: "", role: "admin" };
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (u: string) => { throw new Error("NEXT_REDIRECT:" + u); },
  unstable_rethrow: (e: unknown) => { if (e instanceof Error && e.message.startsWith("NEXT_REDIRECT")) throw e; },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));
vi.mock("@/lib/tenant", async (orig) => {
  const actual = await orig<typeof import("@/lib/tenant")>();
  return {
    ...actual,
    requireCtx: async (opts: { action?: import("@/lib/permissions").Action } = {}) => {
      const { db } = await import("@/lib/db");
      const { assertCan, can } = await import("@/lib/permissions");
      const ws = await db.workspace.findUniqueOrThrow({ where: { id: state.ws } });
      const m = await db.membership.findFirstOrThrow({ where: { workspaceId: state.ws }, include: { user: true } });
      if (opts.action) assertCan(state.role, opts.action);
      return { user: { id: m.userId, email: m.user.email, name: m.user.name }, workspace: ws, workspaceId: ws.id, role: state.role, subscription: null, ent: { active: true }, can: (a: import("@/lib/permissions").Action) => can(state.role, a) } as never;
    },
  };
});

import { db } from "@/lib/db";
import { sha256 } from "@/lib/crypto";
import { enrollLead, processDueFollowUps } from "@/lib/followups";
import { LEASE_MS, SimulatedCrash } from "@/lib/followup-runtime";
import { EmailError, setEmailProviderForTests } from "@/lib/email";
import { setSendHooksForTests } from "@/lib/followup-send";
import { LeadError, changeLeadStatus, unsubscribeLead, updateLeadDetails } from "@/lib/leads";
import { ReviewError, listContradictions, resendMessage, resolveFollowUp, type ResolveInput } from "@/lib/followup-review";
import type { RunOutcome } from "@/lib/followup-runtime";
import { POST as apiLeads } from "@/app/api/v1/leads/route";
import { resolveFollowUpAction } from "../src/app/(app)/automations/actions";
import { updateLeadAction } from "../src/app/(app)/leads/actions";
import { FakeProvider, MIN, dbFixture, emailFixture, gate, later, noRetryDelay, resetEngineTestState, stallOnce } from "./followup-helpers";
import { grantApiPlan, resetDb } from "./helpers";

beforeEach(async () => { await resetDb(); noRetryDelay(); state.role = "admin"; });
afterEach(resetEngineTestState);

const row = (id: string) => db.followUp.findUniqueOrThrow({ where: { id } });
const logs = (id: string) => db.emailLog.findMany({ where: { followUpId: id }, orderBy: { attemptNo: "asc" } });
const toFd = (o: Record<string, string>) => { const fd = new FormData(); for (const [k, v] of Object.entries(o)) fd.set(k, v); return fd; };
const NOTE = "Vérifié dans le tableau de bord du fournisseur (id msg_42).";
const PROOF = "Preuve : message livré, id msg_late, vérifié sur le tableau de bord.";
const details = (f: { workspaceId: string; lead: { id: string } }, email: string | null, extra: Partial<Parameters<typeof updateLeadDetails>[0]> = {}) =>
  updateLeadDetails({ workspaceId: f.workspaceId, leadId: f.lead.id, name: "Marie Durand", email, phone: null, company: null, value: null, ...extra });
const enrollAgain = (f: { workspaceId: string; lead: { id: string }; seq: { id: string } }) => enrollLead({ workspaceId: f.workspaceId, leadId: f.lead.id, sequenceId: f.seq.id, now: new Date(Date.now() - 1000) });

async function uncertainFixture() {
  const f = await emailFixture();
  state.ws = f.workspaceId;
  const p = new FakeProvider(async () => { throw new Error("réseau indisponible"); });
  setEmailProviderForTests(p);
  await processDueFollowUps({ workspaceId: f.workspaceId });
  return { ...f, p };
}
async function inFlightFixture() {
  const f = await emailFixture();
  state.ws = f.workspaceId;
  const p = new FakeProvider();
  setEmailProviderForTests(p);
  setSendHooksForTests({ afterP2: () => { throw new SimulatedCrash("afterP2"); } });
  await expect(processDueFollowUps({ workspaceId: f.workspaceId })).rejects.toBeInstanceOf(SimulatedCrash);
  setSendHooksForTests(null);
  await processDueFollowUps({ workspaceId: f.workspaceId, now: later(LEASE_MS + MIN) });
  return { ...f, p };
}
const input = async (f: { workspaceId: string; userId: string; fu: { id: string } }, action: ResolveInput["action"], extra: Partial<ResolveInput> = {}): Promise<ResolveInput> => {
  const r = await row(f.fu.id);
  const last = (await logs(f.fu.id)).filter((a) => a.status !== "aborted").at(-1);
  return { workspaceId: f.workspaceId, userId: f.userId, id: f.fu.id, action, seen: { attemptCount: r.attemptCount, emailStatus: last?.status ?? null }, ...extra };
};

describe("changement d'adresse : la nouvelle adresse n'hérite jamais du consentement de l'ancienne", () => {
  it("interface (action de la fiche) : consentement révoqué, relances e-mail en attente annulées, étapes non e-mail conservées, trace sans adresse, aucun envoi", async () => {
    const f = await dbFixture([{ day: 0, action: "email", subject: "Bonjour", body: "Merci" }, { day: 0, action: "task", title: "Appeler" }], { sendEmails: true });
    state.ws = f.workspaceId;
    const p = new FakeProvider(); setEmailProviderForTests(p);
    const r = await updateLeadAction({}, toFd({ id: f.lead.id, name: "Marie Durand", email: "Nouvelle@Y.com" }));
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/consentement marketing de l'ancienne adresse est révoqué/);
    const l = await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } });
    expect([l.email, l.consentMarketing]).toEqual(["nouvelle@y.com", false]);
    const [e, t] = f.fus;
    expect([(await row(e.id)).status, (await row(e.id)).failureKind]).toEqual(["cancelled", "email_changed"]);
    expect((await row(t.id)).status).toBe("pending");
    const consents = await db.consent.findMany({ where: { leadId: f.lead.id }, orderBy: { createdAt: "asc" } });
    expect(consents.map((c) => [c.email, c.granted])).toEqual([["m@y.com", true], ["m@y.com", false]]);
    expect(consents[1].source).toBe("email_changed");
    expect(await db.leadActivity.count({ where: { leadId: f.lead.id, type: "consent" } })).toBe(1);
    const audits = await db.auditLog.findMany({ where: { workspaceId: f.workspaceId, action: "lead.email_changed" } });
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0].meta)).not.toMatch(/@y\.com/);
    await processDueFollowUps({ workspaceId: f.workspaceId });
    expect(p.calls).toHaveLength(0);
    expect((await row(t.id)).status).toBe("done");
  });

  it("réinscription après le changement : l'étape e-mail est bloquée (aucun consentement), tâche manuelle, aucun envoi", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    await details(f, "nouvelle@y.com");
    expect((await enrollAgain(f)).enrolled).toBe(true);
    const s = await processDueFollowUps({ workspaceId: f.workspaceId });
    expect(s.blocked).toBe(1);
    expect(p.calls).toHaveLength(0);
    const blocked = await db.followUp.findFirstOrThrow({ where: { leadId: f.lead.id, status: "blocked" } });
    expect(blocked.result).toMatch(/consenti/);
    expect(await db.emailLog.count({ where: { leadId: f.lead.id } })).toBe(0);
  });

  it("API : aucune route de l'API ne modifie l'adresse d'un prospect existant — un nouvel e-mail crée un autre prospect sans consentement hérité", async () => {
    const f = await emailFixture();
    await grantApiPlan(f.workspaceId);
    const key = "sp_" + "k".repeat(30);
    await db.apiKey.create({ data: { workspaceId: f.workspaceId, name: "k", prefix: key.slice(0, 10), keyHash: sha256(key) } });
    const res = await apiLeads(new Request("http://x/api/v1/leads", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ name: "Marie Durand", email: "autre@y.com" }) }));
    expect(res.status).toBeLessThan(300);
    const old = await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } });
    expect([old.email, old.consentMarketing]).toEqual(["m@y.com", true]);
    const neu = await db.lead.findFirstOrThrow({ where: { workspaceId: f.workspaceId, email: "autre@y.com" } });
    expect([neu.id === f.lead.id, neu.consentMarketing]).toEqual([false, false]);
  });

  it("changement d'adresse pendant l'attente (autorisé, appel non commencé) : aucun envoi ; la reprise est bloquée faute de consentement pour la nouvelle adresse", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    const g = gate();
    setSendHooksForTests({ afterT2: stallOnce(g) });
    const a = processDueFollowUps({ workspaceId: f.workspaceId });
    await g.reached;
    await details(f, "nouvelle@y.com");
    g.release();
    const sa = await a;
    expect(sa.requeued).toBe(1);
    expect(p.calls).toHaveLength(0);
    expect((await logs(f.fu.id))[0].status).toBe("aborted");
    setSendHooksForTests(null);
    const s2 = await processDueFollowUps({ workspaceId: f.workspaceId, now: later(2 * MIN) });
    expect(s2.blocked).toBe(1);
    expect(p.calls).toHaveLength(0);
    expect((await row(f.fu.id)).result).toMatch(/consenti/);
  });

  it("adresse présente dans la liste de suppression : même avec un consentement explicite pour cette adresse, aucun envoi", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    await db.emailSuppression.create({ data: { workspaceId: f.workspaceId, email: "supp@y.com", reason: "unsubscribe" } });
    const r = await details(f, "supp@y.com", { consentForEmail: true });
    expect(r).toMatchObject({ emailChanged: true, consentGranted: true });
    await enrollAgain(f);
    const s = await processDueFollowUps({ workspaceId: f.workspaceId });
    expect(s.blocked).toBe(1);
    expect(p.calls).toHaveLength(0);
    expect((await db.followUp.findFirstOrThrow({ where: { leadId: f.lead.id, status: "blocked" } })).result).toMatch(/suppression/);
  });

  it("prospect déjà désinscrit : la désinscription reste prioritaire ; aucun consentement ne peut être enregistré par cette voie ; aucun envoi", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    await unsubscribeLead(f.workspaceId, f.lead.id);
    await details(f, "nouvelle@y.com");
    await expect(details(f, "nouvelle@y.com", { consentForEmail: true })).rejects.toBeInstanceOf(LeadError);
    const l = await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } });
    expect([l.consentMarketing, l.unsubscribedAt === null]).toEqual([false, false]);
    expect((await enrollAgain(f)).enrolled).toBe(false);
    await processDueFollowUps({ workspaceId: f.workspaceId });
    expect(p.calls).toHaveLength(0);
  });

  it("nouvelle autorisation explicite pour la nouvelle adresse : consentement enregistré pour celle-ci, envoi uniquement vers elle", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    const r = await details(f, "nouvelle@y.com", { consentForEmail: true });
    expect(r).toMatchObject({ emailChanged: true, consentRevoked: true, consentGranted: true });
    const l = await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } });
    expect([l.email, l.consentMarketing]).toEqual(["nouvelle@y.com", true]);
    const last = await db.consent.findFirstOrThrow({ where: { leadId: f.lead.id, granted: true, email: "nouvelle@y.com" } });
    expect(last.source).toBe("manual_email_change");
    await enrollAgain(f);
    const s = await processDueFollowUps({ workspaceId: f.workspaceId });
    expect(s.done).toBe(1);
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0].to).toBe("nouvelle@y.com");
    expect((await db.emailLog.findFirstOrThrow({ where: { leadId: f.lead.id } })).to).toBe("nouvelle@y.com");
  });

  it("deux modifications concurrentes du prospect : aucune n'écrase l'autre, une seule révocation tracée, une seule annulation", async () => {
    const f = await emailFixture();
    const [a, b] = await Promise.all([details(f, "b@y.com"), details(f, "c@y.com")]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    const l = await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } });
    expect(["b@y.com", "c@y.com"]).toContain(l.email);
    expect(l.consentMarketing).toBe(false);
    expect(await db.consent.count({ where: { leadId: f.lead.id, granted: false, source: "email_changed" } })).toBe(1);
    expect(await db.followUp.count({ where: { leadId: f.lead.id, failureKind: "email_changed" } })).toBe(1);
  });

  it("écriture directe de l'adresse en base (chemin alternatif) : le moteur exige un consentement enregistré pour l'adresse EXACTE — aucun envoi", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    await db.lead.update({ where: { id: f.lead.id }, data: { email: "contourne@y.com" } }); // consentMarketing reste vrai
    const s = await processDueFollowUps({ workspaceId: f.workspaceId });
    expect(s.blocked).toBe(1);
    expect(p.calls).toHaveLength(0);
    expect((await row(f.fu.id)).result).toMatch(/Aucun consentement marketing enregistré pour cette adresse/);
  });

  it("même adresse à la casse près : aucun changement, consentement et relances intacts ; adresse supprimée : révocation", async () => {
    const f = await emailFixture();
    const r = await details(f, "  M@Y.COM ");
    expect(r).toMatchObject({ emailChanged: false, consentRevoked: false, cancelledFollowUps: 0 });
    expect((await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } })).consentMarketing).toBe(true);
    expect((await row(f.fu.id)).status).toBe("pending");
    const r2 = await details(f, null);
    expect(r2).toMatchObject({ emailChanged: true, consentRevoked: true, cancelledFollowUps: 1 });
  });
});

describe("acquittement des contradictions (action serveur et permissions existantes)", () => {
  const ack = (f: { fu: { id: string } }, attemptId: string, extra: Record<string, string> = {}) =>
    resolveFollowUpAction({}, toFd({ id: f.fu.id, action: "ack_contradiction", attemptCount: "0", attemptId, note: PROOF, confirm: "on", typed: "COMPRIS", ...extra }));

  it("relance « blocked » : la contradiction est listée avec l'identifiant de la relance ; l'acquittement par un administrateur ne modifie ni le résultat du fournisseur, ni la relance ; aucun renvoi", async () => {
    const f = await inFlightFixture();
    await resolveFollowUp(await input(f, "mark_not_sent", { confirm: true, note: NOTE }));
    await db.emailLog.updateMany({ where: { followUpId: f.fu.id, status: "attempting" }, data: { status: "sent", providerMessageId: "msg_late", finishedAt: new Date() } });
    const list = await listContradictions(f.workspaceId);
    expect(list).toHaveLength(1);
    expect(list[0].followUpId).toBe(f.fu.id);
    const r = await ack(f, list[0].id);
    expect(r.ok).toBe(true);
    const [e] = await logs(f.fu.id);
    expect([e.status, e.humanVerdict, e.contradictionAckById, e.providerMessageId]).toEqual(["sent", "confirmed_not_sent", f.userId, "msg_late"]);
    expect((await row(f.fu.id)).status).toBe("blocked");
    expect(await listContradictions(f.workspaceId)).toHaveLength(0);
    await expect(resolveFollowUp(await input(f, "resend", { confirm: true }))).rejects.toBeInstanceOf(ReviewError);
    expect(f.p.calls).toHaveLength(0);
  });

  it("relance « done » : verdict « envoyé » puis refus tardif ; acquittement possible, relance inchangée", async () => {
    const f = await inFlightFixture();
    await resolveFollowUp(await input(f, "mark_sent", { confirm: true, note: NOTE }));
    await db.emailLog.updateMany({ where: { followUpId: f.fu.id, status: "attempting" }, data: { status: "failed", httpStatus: 422, finishedAt: new Date() } });
    const [c] = await listContradictions(f.workspaceId);
    expect((await ack(f, c.id)).ok).toBe(true);
    expect([(await row(f.fu.id)).status, (await logs(f.fu.id))[0].status]).toEqual(["done", "failed"]);
  });

  it("relance encore en cours de résolution (needs_review) : acquittement possible sans changer la relance", async () => {
    const f = await inFlightFixture();
    await db.emailLog.updateMany({ where: { followUpId: f.fu.id }, data: { status: "sent", humanVerdict: "confirmed_not_sent", humanVerdictAt: new Date(), humanVerdictById: f.userId, humanNote: NOTE } });
    expect((await row(f.fu.id)).status).toBe("needs_review");
    const [c] = await listContradictions(f.workspaceId);
    expect((await ack(f, c.id)).ok).toBe(true);
    expect((await row(f.fu.id)).status).toBe("needs_review");
  });

  it("note trop courte, confirmation ou mot manquants : refus ; rôle « member » refusé côté serveur ; rien n'est écrit", async () => {
    const f = await inFlightFixture();
    await resolveFollowUp(await input(f, "mark_not_sent", { confirm: true, note: NOTE }));
    await db.emailLog.updateMany({ where: { followUpId: f.fu.id, status: "attempting" }, data: { status: "sent", finishedAt: new Date() } });
    const [c] = await listContradictions(f.workspaceId);
    expect((await ack(f, c.id, { note: "court" })).error).toMatch(/20/);
    expect((await ack(f, c.id, { typed: "" })).error).toMatch(/COMPRIS/);
    expect((await ack(f, c.id, { confirm: "" })).error).toMatch(/COMPRIS|confirmation/);
    state.role = "member";
    expect((await ack(f, c.id)).error).toMatch(/permission/);
    expect((await logs(f.fu.id))[0].contradictionAckAt).toBeNull();
  });

  it("deux administrateurs simultanés : un seul acquittement est enregistré, l'autre est refusé", async () => {
    const f = await inFlightFixture();
    await resolveFollowUp(await input(f, "mark_not_sent", { confirm: true, note: NOTE }));
    await db.emailLog.updateMany({ where: { followUpId: f.fu.id, status: "attempting" }, data: { status: "sent", finishedAt: new Date() } });
    const [c] = await listContradictions(f.workspaceId);
    const r = await Promise.all([ack(f, c.id), ack(f, c.id)]);
    expect(r.filter((x) => x.ok)).toHaveLength(1);
    expect(r.find((x) => !x.ok)!.error).toMatch(/déjà|a changé/);
  });
});

describe("status_change : aucun écrasement d'une décision plus récente", () => {
  const crashAfterBody = () => {
    const orig = db.$transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;
    vi.spyOn(db, "$transaction").mockImplementationOnce(((fn: (tx: unknown) => Promise<unknown>, opts: unknown) =>
      orig(async (tx: unknown) => { await fn(tx); throw new SimulatedCrash("après le changement de statut"); }, opts)) as never);
  };
  const fixture = () => dbFixture([{ day: 0, action: "status_change", status: "lost" }]);

  it("arrêt simulé pendant l'application, statut modifié entre-temps, puis reprise : conflit à examiner, le statut plus récent est conservé", async () => {
    const f = await dbFixture([{ day: 0, action: "status_change", status: "qualified" }]);
    crashAfterBody();
    await expect(processDueFollowUps({ workspaceId: f.workspaceId })).rejects.toBeInstanceOf(SimulatedCrash);
    expect((await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } })).status).toBe("new"); // transaction annulée
    await changeLeadStatus({ workspaceId: f.workspaceId, leadId: f.lead.id, status: "contacted", actorId: f.userId });
    const s = await processDueFollowUps({ workspaceId: f.workspaceId, now: later(LEASE_MS + MIN) });
    expect(s.needsReview).toBe(1);
    const l = await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } });
    expect(l.status).toBe("contacted");
    const r = await row(f.fu.id);
    expect([r.status, r.failureKind, r.leaseToken]).toEqual(["needs_review", "status_conflict", null]);
    expect(await db.leadActivity.count({ where: { leadId: f.lead.id, type: "status_changed" } })).toBe(1); // celle de l'utilisateur seulement
    expect(await db.notification.count({ where: { id: `fur:${f.fu.id}:status_conflict` } })).toBe(1);
    expect((await processDueFollowUps({ workspaceId: f.workspaceId, now: later(2 * LEASE_MS) })).processed).toBe(0); // jamais reprise automatiquement
  });

  it("reprise sans modification intermédiaire : le statut est appliqué une seule fois, historique et dates cohérents", async () => {
    const f = await fixture();
    crashAfterBody();
    await expect(processDueFollowUps({ workspaceId: f.workspaceId })).rejects.toBeInstanceOf(SimulatedCrash);
    const s = await processDueFollowUps({ workspaceId: f.workspaceId, now: later(LEASE_MS + MIN) });
    expect(s.done).toBe(1);
    const l = await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } });
    expect(l.status).toBe("lost");
    expect(l.lostAt).not.toBeNull();
    expect(await db.leadActivity.count({ where: { leadId: f.lead.id, type: "status_changed" } })).toBe(1);
  });

  it("statut déjà égal à la cible (non terminal) : idempotent, aucun nouvel historique, même après une reprise", async () => {
    const f = await dbFixture([{ day: 0, action: "status_change", status: "contacted" }]);
    crashAfterBody();
    await expect(processDueFollowUps({ workspaceId: f.workspaceId })).rejects.toBeInstanceOf(SimulatedCrash);
    await changeLeadStatus({ workspaceId: f.workspaceId, leadId: f.lead.id, status: "contacted", actorId: f.userId });
    const s = await processDueFollowUps({ workspaceId: f.workspaceId, now: later(LEASE_MS + MIN) });
    expect(s.done).toBe(1);
    expect(await db.leadActivity.count({ where: { leadId: f.lead.id, type: "status_changed" } })).toBe(1);
    expect((await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } })).status).toBe("contacted");
  });

  it("statut devenu terminal entre-temps (décision humaine) : la relance est annulée sans effet, rien n'est écrasé", async () => {
    const f = await fixture();
    crashAfterBody();
    await expect(processDueFollowUps({ workspaceId: f.workspaceId })).rejects.toBeInstanceOf(SimulatedCrash);
    await changeLeadStatus({ workspaceId: f.workspaceId, leadId: f.lead.id, status: "lost", lostReason: "décision humaine" });
    const s = await processDueFollowUps({ workspaceId: f.workspaceId, now: later(LEASE_MS + MIN) });
    expect(s.cancelled).toBe(1);
    expect(await db.leadActivity.count({ where: { leadId: f.lead.id, type: "status_changed" } })).toBe(1);
    expect((await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } })).lostReason).toBe("décision humaine");
  });

  it("chemin manuel, deux changements concurrents : historique exact (chaque « from » est le statut réellement remplacé)", async () => {
    const f = await fixture();
    await Promise.all([
      changeLeadStatus({ workspaceId: f.workspaceId, leadId: f.lead.id, status: "contacted", actorId: f.userId }),
      changeLeadStatus({ workspaceId: f.workspaceId, leadId: f.lead.id, status: "qualified", actorId: f.userId }),
    ]);
    const acts = (await db.leadActivity.findMany({ where: { leadId: f.lead.id, type: "status_changed" } })).map((a) => a.data as { from: string; to: string });
    expect(acts).toHaveLength(2);
    const first = acts.find((a) => a.from === "new")!;
    const second = acts.find((a) => a !== first)!;
    expect(second.from).toBe(first.to);
    expect((await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } })).status).toBe(second.to);
  });
});

describe("renvoi manuel : messages exacts, audit du résultat, concurrence", () => {
  it("les messages décrivent la transition réellement effectuée : aucun état interne n'est exposé", () => {
    const all: RunOutcome[] = ["done", "blocked", "failed", "cancelled", "needs_review", "requeued", "exhausted", "lost"];
    for (const o of all) expect(resendMessage(o)).not.toMatch(/needs_review|requeued|exhausted|\blost\b|\bblocked\b|\bdone\b|\bfailed\b|\bcancelled\b/);
    expect(resendMessage("done")).toMatch(/doublon reste possible/);
  });

  it("deux clics concurrents sur « Renvoyer » : un seul renvoi, une seule tentative supplémentaire, l'autre clic est refusé", async () => {
    const f = await uncertainFixture();
    f.p.behavior = async () => ({ id: "msg_2", httpStatus: 200 });
    const [a, b] = await Promise.allSettled([resolveFollowUp(await input(f, "resend", { confirm: true })), resolveFollowUp(await input(f, "resend", { confirm: true }))]);
    expect([a.status, b.status].filter((s) => s === "fulfilled")).toHaveLength(1);
    expect((([a, b].find((x) => x.status === "rejected")) as PromiseRejectedResult).reason).toBeInstanceOf(ReviewError);
    expect(f.p.calls).toHaveLength(2);
    expect((await logs(f.fu.id)).map((x) => x.attemptNo)).toEqual([1, 2]);
    expect(await db.auditLog.count({ where: { workspaceId: f.workspaceId, action: "followup.resend_result" } })).toBe(1);
  });

  it("tentative précédente potentiellement commencée : renvoi permis (confirmation) ; deux envois peuvent aboutir — le message ne promet aucune absence de doublon", async () => {
    const f = await inFlightFixture();
    await expect(resolveFollowUp(await input(f, "resend", { confirm: true }))).rejects.toThrow(/moins d'une minute/); // résultat tardif encore possible : renvoi immédiat refusé
    expect(f.p.calls).toHaveLength(0);
    const r = await resolveFollowUp(await input(f, "resend", { confirm: true, now: later(2 * MIN) }));
    expect(r.message).toMatch(/doublon reste possible/);
    expect(f.p.calls).toHaveLength(1);
    expect((await logs(f.fu.id)).map((x) => [x.attemptNo, x.status])).toEqual([[1, "attempting"], [2, "sent"]]);
    expect((await row(f.fu.id)).status).toBe("done");
  });

  it("refus explicite au renvoi : tentative « failed », relance bloquée, tâche, audit du résultat sans adresse", async () => {
    const f = await uncertainFixture();
    f.p.behavior = async () => { throw new EmailError("Resend HTTP 422", { kind: "rejected", status: 422 }); };
    const r = await resolveFollowUp(await input(f, "resend", { confirm: true }));
    expect(r.message).toMatch(/n'a pas été envoyé/);
    const l = await logs(f.fu.id);
    expect([l[1].status, l[1].httpStatus]).toEqual(["failed", 422]);
    expect((await row(f.fu.id)).status).toBe("blocked");
    const a = await db.auditLog.findFirstOrThrow({ where: { workspaceId: f.workspaceId, action: "followup.resend_result" } });
    expect(a.meta).toMatchObject({ outcome: "blocked", attemptNo: 2, emailStatus: "failed", httpStatus: 422 });
    expect(JSON.stringify(a.meta)).not.toMatch(/@y\.com/);
    expect(await db.auditLog.count({ where: { workspaceId: f.workspaceId, action: "followup.resolved" } })).toBe(1); // l'audit d'intention est conservé
  });

  it("réponse incertaine au renvoi : la relance reste à examiner, message d'incertitude, aucun nouveau renvoi automatique", async () => {
    const f = await uncertainFixture();
    f.p.behavior = async () => { throw new Error("délai dépassé"); };
    const r = await resolveFollowUp(await input(f, "resend", { confirm: true }));
    expect(r.message).toMatch(/incertain/);
    expect((await logs(f.fu.id)).map((x) => x.status)).toEqual(["uncertain", "uncertain"]);
    expect((await row(f.fu.id)).status).toBe("needs_review");
    const callsBefore = f.p.calls.length;
    await processDueFollowUps({ workspaceId: f.workspaceId, now: later(7 * 86_400_000) });
    expect(f.p.calls).toHaveLength(callsBefore);
  });

  it("résultat fournisseur tardif ARRIVANT APRÈS le renvoi : enregistré dans sa tentative, relance non réactivée ni écrasée, les deux acceptations sont tracées (doublon possible documenté)", async () => {
    const f = await emailFixture();
    state.ws = f.workspaceId;
    const p = new FakeProvider(); setEmailProviderForTests(p);
    const g = gate();
    setSendHooksForTests({ afterSend: stallOnce(g) });
    const a = processDueFollowUps({ workspaceId: f.workspaceId });
    await g.reached; // A : accepté par le fournisseur, résultat non enregistré
    await processDueFollowUps({ workspaceId: f.workspaceId, now: later(LEASE_MS + MIN) }); // reprise : needs_review
    setSendHooksForTests(null);
    p.behavior = async () => ({ id: "msg_2", httpStatus: 200 });
    await resolveFollowUp(await input(f, "resend", { confirm: true, now: later(2 * MIN) }));
    g.release();
    const sa = await a;
    expect(sa.lost).toBe(1);
    const l = await logs(f.fu.id);
    expect(l.map((x) => [x.attemptNo, x.status, x.providerMessageId])).toEqual([[1, "sent", "msg_1"], [2, "sent", "msg_2"]]);
    expect((await row(f.fu.id)).status).toBe("done");
    expect(await db.conversation.count({ where: { leadId: f.lead.id } })).toBe(1);
  });

  it("résultat tardif ARRIVANT AVANT le renvoi : le renvoi est refusé (l'état a changé), aucun doublon", async () => {
    const f = await emailFixture();
    state.ws = f.workspaceId;
    const p = new FakeProvider(); setEmailProviderForTests(p);
    const g = gate();
    setSendHooksForTests({ afterSend: stallOnce(g) });
    const a = processDueFollowUps({ workspaceId: f.workspaceId });
    await g.reached;
    await processDueFollowUps({ workspaceId: f.workspaceId, now: later(LEASE_MS + MIN) });
    setSendHooksForTests(null);
    const stale = await input(f, "resend", { confirm: true }); // état vu : tentative « attempting »
    g.release();
    await a; // résultat tardif « sent » enregistré
    await expect(resolveFollowUp(stale)).rejects.toBeInstanceOf(ReviewError);
    expect(p.calls).toHaveLength(1);
  });
});
