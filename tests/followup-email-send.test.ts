import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { processDueFollowUps, deleteSequence, updateSequence } from "@/lib/followups";
import { EmailError, setEmailProviderForTests } from "@/lib/email";
import { LEASE_MS, SimulatedCrash, finishTx, setTimingForTests } from "@/lib/followup-runtime";
import { setSendHooksForTests, type SendHooks } from "@/lib/followup-send";
import { reconcileAcceptedReviews } from "@/lib/followup-review";
import { saveConnection } from "@/lib/integrations/service";
import { unsubscribeLead } from "@/lib/leads";
import { FakeProvider, MIN, emailFixture, gate, later, noRetryDelay, resetEngineTestState, seqData, stallOnce } from "./followup-helpers";
import { resetDb } from "./helpers";

beforeEach(async () => { await resetDb(); noRetryDelay(); });
afterEach(resetEngineTestState);

const row = (id: string) => db.followUp.findUniqueOrThrow({ where: { id } });
const logs = (followUpId: string) => db.emailLog.findMany({ where: { followUpId }, orderBy: { attemptNo: "asc" } });
const afterLease = () => later(LEASE_MS + MIN);
const crashAt = (name: keyof SendHooks) => setSendHooksForTests({ [name]: () => { throw new SimulatedCrash(name); } });

describe("envoi : intention, autorisation, marque d'appel, résultat", () => {
  it("parcours normal : une tentative journalisée avec ses horodatages, clé d'idempotence, effets déterministes", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    const s = await processDueFollowUps({ workspaceId: f.workspaceId });
    expect(s.done).toBe(1);
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0].idempotencyKey).toBe(`fu:${f.fu.id}:1`);
    expect(p.calls[0].text).toContain("/unsubscribe/");
    const [e] = await logs(f.fu.id);
    expect(e.id).toBe(`el:${f.fu.id}:1`);
    expect([e.status, e.providerMessageId, e.httpStatus, e.attemptNo, e.idempotencyKey, e.followUpId, e.humanVerdict]).toEqual(["sent", "msg_1", 200, 1, `fu:${f.fu.id}:1`, f.fu.id, null]);
    expect(e.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(e.authorizedAt && e.callStartedAt && e.finishedAt).toBeTruthy();
    expect(e.callStartedAt!.getTime()).toBeGreaterThanOrEqual(e.authorizedAt!.getTime());
    const r = await row(f.fu.id);
    expect([r.status, r.attemptCount, r.leaseToken]).toEqual(["done", 1, null]);
    expect((await db.conversation.findMany({ where: { leadId: f.lead.id } })).map((c) => c.id)).toEqual([`fuv:${f.fu.id}`]);
    expect(await db.leadActivity.count({ where: { id: `fua:${f.fu.id}` } })).toBe(1);
  });

  it("l'appel fournisseur a lieu APRÈS la marque callStartedAt et HORS de toute transaction (sinon SQLite, à une seule connexion, resterait bloqué)", async () => {
    const f = await emailFixture();
    let seen: { callStartedAt: Date | null; status: string; running: string } | null = null;
    const p = new FakeProvider(async () => {
      const e = await db.emailLog.findUniqueOrThrow({ where: { id: `el:${f.fu.id}:1` } });
      const r = await db.followUp.findUniqueOrThrow({ where: { id: f.fu.id } });
      seen = { callStartedAt: e.callStartedAt, status: e.status, running: r.status };
      return { id: "m", httpStatus: 200 };
    });
    setEmailProviderForTests(p);
    await processDueFollowUps({ workspaceId: f.workspaceId });
    expect(seen).toMatchObject({ status: "attempting", running: "running" });
    expect(seen!.callStartedAt).not.toBeNull();
  });

  it("deux exécuteurs simultanés : un seul appel fournisseur", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    await Promise.all([1, 2, 3].map(() => processDueFollowUps({ workspaceId: f.workspaceId })));
    expect(p.calls).toHaveLength(1);
    expect(await logs(f.fu.id)).toHaveLength(1);
  });

  it("refus explicite (4xx) : « failed », relance bloquée avec tâche manuelle, jamais renvoyé", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(async () => { throw new EmailError("Resend HTTP 422", { kind: "rejected", status: 422 }); }); setEmailProviderForTests(p);
    const s = await processDueFollowUps({ workspaceId: f.workspaceId });
    expect(s.blocked).toBe(1);
    const [e] = await logs(f.fu.id);
    expect([e.status, e.httpStatus]).toEqual(["failed", 422]);
    expect((await row(f.fu.id)).status).toBe("blocked");
    expect((await db.task.findMany({ where: { leadId: f.lead.id } })).map((t) => t.id)).toEqual([`fut:${f.fu.id}`]);
    await processDueFollowUps({ workspaceId: f.workspaceId, now: later(86_400_000) });
    expect(p.calls).toHaveLength(1);
  });

  it.each([
    ["erreur réseau (Error)", () => new Error("réseau indisponible")],
    ["délai dépassé", () => new EmailError("délai dépassé", { kind: "uncertain" })],
    ["5xx", () => new EmailError("Resend HTTP 503", { kind: "uncertain", status: 503 })],
  ])("%s : « uncertain », relance « needs_review », aucune tâche, jamais de renvoi automatique", async (_n, mk) => {
    const f = await emailFixture();
    const p = new FakeProvider(async () => { throw mk(); }); setEmailProviderForTests(p);
    const s = await processDueFollowUps({ workspaceId: f.workspaceId });
    expect(s.needsReview).toBe(1);
    const [e] = await logs(f.fu.id);
    expect(e.status).toBe("uncertain");
    const r = await row(f.fu.id);
    expect([r.status, r.failureKind, r.leaseToken]).toEqual(["needs_review", "email_uncertain", null]);
    expect(await db.task.count({ where: { leadId: f.lead.id } })).toBe(0);
    expect(await db.notification.count({ where: { workspaceId: f.workspaceId, type: "followup_review" } })).toBe(1);
    await processDueFollowUps({ workspaceId: f.workspaceId, now: later(7 * 86_400_000) });
    await processDueFollowUps({ workspaceId: f.workspaceId, now: later(30 * 86_400_000) });
    expect(p.calls).toHaveLength(1);
    expect(await logs(f.fu.id)).toHaveLength(1);
  });
});

describe("fournisseur Resend (réponses HTTP simulées)", () => {
  const cases: [string, () => Response | Promise<never>, string, string][] = [
    ["2xx au corps illisible : accepté", () => new Response("pas du json", { status: 200 }), "sent", "done"],
    ["429 : refus explicite", () => new Response("{}", { status: 429 }), "failed", "blocked"],
    ["422 : refus explicite", () => new Response("{}", { status: 422 }), "failed", "blocked"],
    ["409 (conflit d'idempotence) : incertain", () => new Response("{}", { status: 409 }), "uncertain", "needs_review"],
    ["500 : incertain", () => new Response("{}", { status: 500 }), "uncertain", "needs_review"],
    ["erreur réseau : incertain", () => Promise.reject(new TypeError("fetch failed")) as Promise<never>, "uncertain", "needs_review"],
  ];
  it.each(cases)("%s", async (_n, mk, logStatus, fuStatus) => {
    const f = await emailFixture();
    await saveConnection(f.workspaceId, "email", { credentials: { apiKey: "re_ws", from: "Acme <a@x.com>" } });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation((async () => mk()) as never);
    await processDueFollowUps({ workspaceId: f.workspaceId });
    expect(spy).toHaveBeenCalledTimes(1);
    const init = spy.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers["idempotency-key"]).toBe(`fu:${f.fu.id}:1`);
    expect((await logs(f.fu.id))[0].status).toBe(logStatus);
    expect((await row(f.fu.id)).status).toBe(fuStatus);
  });
});

describe("interruptions entre les étapes de l'envoi", () => {
  it.each(["afterT2", "beforeP1", "afterP1", "afterP3", "afterP4"] as const)("arrêt après l'étape « %s » (avant la marque d'appel) : aucun appel, reprise contrôlée, un seul envoi", async (point) => {
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    crashAt(point);
    await expect(processDueFollowUps({ workspaceId: f.workspaceId })).rejects.toBeInstanceOf(SimulatedCrash);
    expect(p.calls).toHaveLength(0);
    const [e1] = await logs(f.fu.id);
    expect([e1.status, e1.callStartedAt]).toEqual(["attempting", null]);
    expect((await row(f.fu.id)).status).toBe("running");
    setSendHooksForTests(null);
    const s = await processDueFollowUps({ workspaceId: f.workspaceId, now: afterLease() });
    expect(s.done).toBe(1);
    expect(p.calls).toHaveLength(1);
    const l = await logs(f.fu.id);
    expect(l.map((x) => [x.attemptNo, x.status])).toEqual([[1, "aborted"], [2, "sent"]]);
    expect(l[0].error).toBe("aborted:abandoned");
    const r = await row(f.fu.id);
    expect([r.status, r.attemptCount, r.technicalFailureCount]).toEqual(["done", 2, 1]);
  });

  it("arrêt APRÈS la marque callStartedAt, avant l'appel : appel potentiellement commencé → needs_review, aucun renvoi automatique", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    crashAt("afterP2");
    await expect(processDueFollowUps({ workspaceId: f.workspaceId })).rejects.toBeInstanceOf(SimulatedCrash);
    expect(p.calls).toHaveLength(0);
    setSendHooksForTests(null);
    const s = await processDueFollowUps({ workspaceId: f.workspaceId, now: afterLease() });
    expect(s.needsReview).toBe(1);
    expect(p.calls).toHaveLength(0);
    const [e] = await logs(f.fu.id);
    expect([e.status, e.callStartedAt === null]).toEqual(["attempting", false]);
    expect((await row(f.fu.id)).failureKind).toBe("email_uncertain");
  });

  it("arrêt PENDANT l'appel fournisseur : needs_review, un seul appel au total", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(async () => { throw new SimulatedCrash("pendant l'appel"); }); setEmailProviderForTests(p);
    await expect(processDueFollowUps({ workspaceId: f.workspaceId })).rejects.toBeInstanceOf(SimulatedCrash);
    expect(p.calls).toHaveLength(1);
    p.behavior = async () => ({ id: "ne devrait jamais être appelé" });
    const s = await processDueFollowUps({ workspaceId: f.workspaceId, now: afterLease() });
    expect(s.needsReview).toBe(1);
    expect(p.calls).toHaveLength(1);
  });

  it("arrêt après l'acceptation du fournisseur, avant l'écriture du résultat : needs_review, jamais renvoyé", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    crashAt("afterSend");
    await expect(processDueFollowUps({ workspaceId: f.workspaceId })).rejects.toBeInstanceOf(SimulatedCrash);
    expect(p.calls).toHaveLength(1);
    expect((await logs(f.fu.id))[0].status).toBe("attempting");
    setSendHooksForTests(null);
    expect((await processDueFollowUps({ workspaceId: f.workspaceId, now: afterLease() })).needsReview).toBe(1);
    expect(p.calls).toHaveLength(1);
  });

  it("arrêt après l'enregistrement de l'acceptation, avant la finalisation : la reprise finalise SANS renvoyer", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    crashAt("afterOutcome");
    await expect(processDueFollowUps({ workspaceId: f.workspaceId })).rejects.toBeInstanceOf(SimulatedCrash);
    expect((await logs(f.fu.id))[0].status).toBe("sent");
    expect((await row(f.fu.id)).status).toBe("running");
    setSendHooksForTests(null);
    const s = await processDueFollowUps({ workspaceId: f.workspaceId, now: afterLease() });
    expect(s.done).toBe(1);
    expect(p.calls).toHaveLength(1);
    const r = await row(f.fu.id);
    expect([r.status, r.attemptCount]).toEqual(["done", 1]);
    expect(await db.conversation.count({ where: { leadId: f.lead.id } })).toBe(1);
  });
});

describe("exécutions concurrentes, résultat tardif, révocations", () => {
  it("résultat fournisseur TARDIF : enregistré dans sa tentative sans réactiver la relance ; la réconciliation finalise sans renvoyer", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    const g = gate();
    setSendHooksForTests({ afterSend: stallOnce(g) });
    const a = processDueFollowUps({ workspaceId: f.workspaceId });
    await g.reached; // A a appelé le fournisseur et reste bloqué avant l'écriture du résultat
    const b = await processDueFollowUps({ workspaceId: f.workspaceId, now: afterLease() });
    expect(b.needsReview).toBe(1);
    g.release();
    const sa = await a;
    expect(sa.lost).toBe(1);
    const [e] = await logs(f.fu.id);
    expect([e.status, e.providerMessageId]).toEqual(["sent", "msg_1"]);
    expect((await row(f.fu.id)).status).toBe("needs_review"); // non réactivée, non finalisée par l'ancien exécuteur
    expect(await reconcileAcceptedReviews()).toBe(1);
    expect((await row(f.fu.id)).status).toBe("done");
    expect(p.calls).toHaveLength(1);
    expect(await db.conversation.count({ where: { leadId: f.lead.id } })).toBe(1);
  });

  it("reprise concurrente : la conversion en « aborted » et la marque d'appel sont exclusives — aucun double envoi", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    const g = gate();
    setSendHooksForTests({ afterP4: stallOnce(g) });
    const a = processDueFollowUps({ workspaceId: f.workspaceId });
    await g.reached; // A : autorisé et contrôlé, pas encore de marque d'appel
    const b = await processDueFollowUps({ workspaceId: f.workspaceId, now: afterLease() });
    expect(b.done).toBe(1);
    g.release();
    const sa = await a;
    expect(sa.lost).toBe(1);
    expect(p.calls).toHaveLength(1);
    expect((await logs(f.fu.id)).map((x) => [x.attemptNo, x.status])).toEqual([[1, "aborted"], [2, "sent"]]);
    expect((await row(f.fu.id)).status).toBe("done");
  });

  it("révocation (désinscription) pendant que l'envoi est autorisé mais pas commencé : aucun appel, tentative « aborted », relance restée annulée", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    const g = gate();
    setSendHooksForTests({ afterT2: stallOnce(g) });
    const a = processDueFollowUps({ workspaceId: f.workspaceId });
    await g.reached;
    await unsubscribeLead(f.workspaceId, f.lead.id);
    g.release();
    await a;
    expect(p.calls).toHaveLength(0);
    const [e] = await logs(f.fu.id);
    expect([e.status, e.callStartedAt]).toEqual(["aborted", null]);
    const r = await row(f.fu.id);
    expect([r.status, r.failureKind]).toEqual(["cancelled", "revoked"]);
    expect(await db.task.count({ where: { leadId: f.lead.id } })).toBe(0);
  });

  it("révocation APRÈS la marque d'appel : l'envoi autorisé part, le résultat est enregistré, la relance reste annulée, l'événement d'audit est conservé sans donnée personnelle", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    const g = gate();
    setSendHooksForTests({ afterP2: stallOnce(g) });
    const a = processDueFollowUps({ workspaceId: f.workspaceId });
    await g.reached;
    await unsubscribeLead(f.workspaceId, f.lead.id);
    g.release();
    const sa = await a;
    expect(sa.lost).toBe(1);
    expect(p.calls).toHaveLength(1);
    expect((await logs(f.fu.id))[0].status).toBe("sent");
    const r = await row(f.fu.id);
    expect([r.status, r.failureKind]).toEqual(["cancelled", "revoked"]);
    expect(await db.conversation.count({ where: { leadId: f.lead.id } })).toBe(0);
    const ev = await db.auditLog.findMany({ where: { workspaceId: f.workspaceId, action: "email.sent_after_revocation" } });
    expect(ev).toHaveLength(1);
    expect(ev[0].entityId).toBe(`el:${f.fu.id}:1`);
    expect(JSON.stringify(ev[0].meta)).not.toContain("m@y.com");
  });

  it("séquence désactivée pendant l'attente : aucun appel, relance annulée (« sequence_inactive »), aucune relance pending restante", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    const g = gate();
    setSendHooksForTests({ afterT2: stallOnce(g) });
    const a = processDueFollowUps({ workspaceId: f.workspaceId });
    await g.reached;
    expect(await updateSequence(f.workspaceId, f.seq.id, seqData(f.seq, false))).toBe(true);
    g.release();
    await a;
    expect(p.calls).toHaveLength(0);
    expect((await logs(f.fu.id))[0].status).toBe("aborted");
    const r = await row(f.fu.id);
    expect([r.status, r.failureKind]).toEqual(["cancelled", "sequence_inactive"]);
    expect(await db.followUp.count({ where: { sequenceId: f.seq.id, status: "pending" } })).toBe(0);
  });

  it("séquence supprimée pendant l'attente : aucun appel, relance annulée", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    const g = gate();
    setSendHooksForTests({ afterT2: stallOnce(g) });
    const a = processDueFollowUps({ workspaceId: f.workspaceId });
    await g.reached;
    await deleteSequence(f.workspaceId, f.seq.id);
    g.release();
    await a;
    expect(p.calls).toHaveLength(0);
    const r = await row(f.fu.id);
    expect([r.status, r.failureKind]).toEqual(["cancelled", "sequence_inactive"]);
  });

  it("adresse du prospect modifiée entre l'autorisation et l'appel : aucun envoi à l'ancienne adresse ; tentative « aborted », relance remise en file", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    const g = gate();
    setSendHooksForTests({ afterT2: stallOnce(g) });
    const a = processDueFollowUps({ workspaceId: f.workspaceId });
    await g.reached;
    await db.lead.update({ where: { id: f.lead.id }, data: { email: "nouvelle@y.com" } });
    g.release();
    const sa = await a;
    expect(sa.requeued).toBe(1);
    expect(p.calls).toHaveLength(0);
    expect((await logs(f.fu.id))[0].status).toBe("aborted");
    const r = await row(f.fu.id);
    expect([r.status, r.attemptCount]).toEqual(["pending", 1]);
    expect(r.retryAfter!.getTime()).toBeGreaterThan(Date.now());
  });

  it("prospect devenu client entre l'autorisation et l'appel : aucun envoi", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    const g = gate();
    setSendHooksForTests({ afterT2: stallOnce(g) });
    const a = processDueFollowUps({ workspaceId: f.workspaceId });
    await g.reached;
    await db.lead.update({ where: { id: f.lead.id }, data: { status: "won" } });
    g.release();
    await a;
    expect(p.calls).toHaveLength(0);
  });

  it("une relance annulée n'est jamais réactivée par une finalisation tardive (jeton effacé)", async () => {
    const f = await emailFixture();
    await db.followUp.update({ where: { id: f.fu.id }, data: { status: "cancelled", failureKind: "revoked", leaseToken: null } });
    expect(await finishTx(f.fu.id, "ancien", new Date(), { status: "done", result: "x" })).toBe("lost");
    expect((await row(f.fu.id)).status).toBe("cancelled");
  });
});

describe("expiration de l'autorisation d'envoi et tentatives « aborted »", () => {
  it("autorisation périmée (> 10 s) : aucun appel, tentative « aborted », relance remise en file, puis nouvelle tentative contrôlée", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    setTimingForTests({ sendFreshMs: 50 }); // délai réel dépassé pendant le blocage (horloge de la base sous PostgreSQL, de l'application sous SQLite)
    setSendHooksForTests({ beforeP1: () => new Promise<void>((r) => setTimeout(r, 150)) });
    const s = await processDueFollowUps({ workspaceId: f.workspaceId });
    expect(s.requeued).toBe(1);
    expect(p.calls).toHaveLength(0);
    let l = await logs(f.fu.id);
    expect([l[0].status, l[0].error]).toEqual(["aborted", "aborted:freshness"]);
    const mid = await row(f.fu.id);
    expect([mid.status, mid.attemptCount]).toEqual(["pending", 1]);
    setSendHooksForTests(null);
    setTimingForTests(null);
    expect((await processDueFollowUps({ workspaceId: f.workspaceId })).processed).toBe(0); // reportée : pas avant retryAfter
    const s2 = await processDueFollowUps({ workspaceId: f.workspaceId, now: new Date(Date.now() + 2 * MIN) });
    expect(s2.done).toBe(1);
    expect(p.calls).toHaveLength(1);
    l = await logs(f.fu.id);
    expect(l.map((x) => [x.attemptNo, x.status])).toEqual([[1, "aborted"], [2, "sent"]]);
    expect((await row(f.fu.id)).attemptCount).toBe(2);
  });

  it("garde locale (délai dépassé entre le dernier contrôle et l'appel, horloges murale et monotone) : aucun appel", async () => {
    setTimingForTests({ localGuardMs: 50 });
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    setSendHooksForTests({ afterP3: () => new Promise<void>((r) => setTimeout(r, 150)) });
    const s = await processDueFollowUps({ workspaceId: f.workspaceId });
    expect(s.requeued).toBe(1);
    expect(p.calls).toHaveLength(0);
    expect((await logs(f.fu.id))[0].error).toBe("aborted:local_delay");
  });

  it("trois envois abandonnés avant l'appel : plafond atteint → « failed / exhausted » (jamais bloquée en attente)", async () => {
    setTimingForTests({ sendFreshMs: 50 });
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    for (let k = 1; k <= 3; k++) {
      setSendHooksForTests({ beforeP1: () => new Promise<void>((r) => setTimeout(r, 150)) });
      await processDueFollowUps({ workspaceId: f.workspaceId, now: new Date(Date.now() + k * 2 * MIN) });
    }
    expect(p.calls).toHaveLength(0);
    const r = await row(f.fu.id);
    expect([r.status, r.failureKind, r.attemptCount, r.leaseToken, r.retryAfter]).toEqual(["failed", "exhausted", 3, null, null]);
    expect((await logs(f.fu.id)).map((x) => x.status)).toEqual(["aborted", "aborted", "aborted"]);
  });
});
