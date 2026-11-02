import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { deleteSequence, enrollLead, processDueFollowUps, updateSequence } from "@/lib/followups";
import { eraseLead, unsubscribeLead } from "@/lib/leads";
import { setEmailProviderForTests } from "@/lib/email";
import { setSendHooksForTests } from "@/lib/followup-send";
import { transactionErrorCode } from "@/lib/followup-runtime";
import { FakeProvider, MIN, dbFixture, emailFixture, gate, later, noRetryDelay, resetEngineTestState, seqData, stallOnce, taskFixture } from "./followup-helpers";
import { ReviewError, resolveFollowUp } from "@/lib/followup-review";
import { LEASE_MS } from "@/lib/followup-runtime";
import { makeWorkspace, resetDb } from "./helpers";

// Concurrence RÉELLE sur PostgreSQL : le pool de Prisma ouvre plusieurs connexions, donc vrais verrous de ligne, vraies attentes et vrais verrous mortels.
// SQLite sérialise toutes les requêtes : ces tests y sont ignorés (ils ne prouveraient rien). Lancer avec `npm run test:pg` (docs/validation-postgresql-stripe.md).
const isPg = /^postgres(ql)?:\/\//.test(process.env.DATABASE_URL ?? "");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const orig = () => db.$transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;

/** Garde la transaction OUVERTE (verrous tenus) `ms` après l'exécution de son corps, avant la validation. */
function holdAfterBody(ms: number) {
  let reached!: () => void;
  const wasReached = new Promise<void>((r) => (reached = r));
  const o = orig();
  vi.spyOn(db, "$transaction").mockImplementationOnce(((fn: (tx: unknown) => Promise<unknown>, opts: unknown) =>
    o(async (tx: unknown) => { const r = await fn(tx); reached(); await sleep(ms); return r; }, opts)) as never);
  return wasReached;
}

describe.skipIf(!isPg)("PostgreSQL — verrous du moteur de relances (séquence → relance → prospect)", () => {
  beforeEach(async () => { await resetDb(); noRetryDelay(); });
  afterEach(resetEngineTestState);

  it("8 exécuteurs simultanés sur 12 relances : chaque effet une seule fois, une seule autorisation par relance", async () => {
    const f = await dbFixture(Array.from({ length: 12 }, (_, i) => ({ day: 0, action: "task", title: `T${i}` })));
    const r = await Promise.all(Array.from({ length: 8 }, () => processDueFollowUps({ workspaceId: f.workspaceId })));
    expect(r.reduce((a, s) => a + s.done, 0)).toBe(12);
    expect(await db.task.count({ where: { leadId: f.lead.id } })).toBe(12);
    const all = await db.followUp.findMany({ where: { leadId: f.lead.id } });
    expect(all.every((x) => x.status === "done" && x.attemptCount === 1 && x.leaseToken === null)).toBe(true);
  });

  it("désactivation VALIDÉE avant l'autorisation : le worker attend le verrou de la séquence, puis n'a aucun effet (le prédicat est réévalué)", async () => {
    const f = await taskFixture();
    const editorHold = gate();
    const editor = db.$transaction(async (tx) => {
      await tx.followUpSequence.update({ where: { id: f.seq.id }, data: { active: false } });
      editorHold.reachedResolve();
      await editorHold.hold;
    }, { timeout: 20_000, maxWait: 5_000 });
    await editorHold.reached;
    let settled = false;
    const worker = processDueFollowUps({ workspaceId: f.workspaceId }).then((s) => { settled = true; return s; });
    await sleep(400);
    expect(settled).toBe(false); // bloqué sur le verrou de la séquence, pas sur autre chose
    editorHold.release();
    await editor;
    const s = await worker;
    expect(s.cancelled).toBe(1);
    expect(await db.task.count({ where: { leadId: f.lead.id } })).toBe(0);
    const r = await db.followUp.findUniqueOrThrow({ where: { id: f.fu.id } });
    expect([r.status, r.failureKind]).toEqual(["cancelled", "sequence_inactive"]);
  });

  it("autorisation validée AVANT la désactivation : la désactivation attend la fin de la transaction du worker ; la relance s'est exécutée, les autres sont annulées", async () => {
    const f = await dbFixture([{ day: 0, action: "task", title: "J0" }, { day: 5, action: "task", title: "J5" }, { day: 6, action: "task", title: "J6" }]);
    const reached = holdAfterBody(600);
    const worker = processDueFollowUps({ workspaceId: f.workspaceId });
    await reached; // T1 a pris le verrou de la séquence et créé la tâche ; validation retardée
    const t0 = Date.now();
    const editor = updateSequence(f.workspaceId, f.seq.id, seqData(f.seq, false)).then((ok) => ({ ok, at: Date.now() }));
    const [s, e] = await Promise.all([worker, editor]);
    expect(e.ok).toBe(true);
    expect(e.at - t0).toBeGreaterThanOrEqual(400); // elle a attendu
    expect(s.done).toBe(1);
    const st = (await db.followUp.findMany({ where: { leadId: f.lead.id }, orderBy: { stepIndex: "asc" } })).map((x) => x.status);
    expect(st).toEqual(["done", "cancelled", "cancelled"]);
    expect(await db.task.count({ where: { leadId: f.lead.id } })).toBe(1);
  });

  it("inscription concurrente d'une désactivation : aucune relance « pending » ne subsiste dans la séquence inactive (invariant I1)", async () => {
    const f = await dbFixture([{ day: 5, action: "task", title: "T" }]);
    await db.followUp.updateMany({ where: { leadId: f.lead.id }, data: { status: "cancelled" } });
    const reached = holdAfterBody(600);
    const enroll = enrollLead({ workspaceId: f.workspaceId, leadId: f.lead.id, sequenceId: f.seq.id });
    await reached;
    const t0 = Date.now();
    const editor = updateSequence(f.workspaceId, f.seq.id, seqData(f.seq, false)).then(() => Date.now());
    const [r, at] = await Promise.all([enroll, editor]);
    expect(r.enrolled).toBe(true); // l'inscription a eu lieu AVANT la désactivation (sérialisées par le verrou de la séquence)
    expect(at - t0).toBeGreaterThanOrEqual(400);
    expect(await db.followUp.count({ where: { sequenceId: f.seq.id, status: "pending" } })).toBe(0);
    expect(await db.followUp.count({ where: { sequenceId: f.seq.id, status: "cancelled" } })).toBe(2);
  });

  it("désactivation validée AVANT l'inscription : l'inscription est refusée, aucune relance créée", async () => {
    const f = await dbFixture([{ day: 5, action: "task", title: "T" }]);
    await db.followUp.updateMany({ where: { leadId: f.lead.id }, data: { status: "cancelled" } });
    const hold = gate();
    const editor = db.$transaction(async (tx) => {
      await tx.followUpSequence.update({ where: { id: f.seq.id }, data: { active: false } });
      hold.reachedResolve(); await hold.hold;
    }, { timeout: 20_000, maxWait: 5_000 });
    await hold.reached;
    const enroll = enrollLead({ workspaceId: f.workspaceId, leadId: f.lead.id, sequenceId: f.seq.id });
    await sleep(300); // la lecture préalable voit encore « active » : seule la transaction décide
    hold.release();
    await editor;
    const r = await enroll;
    expect(r.enrolled).toBe(false);
    expect(await db.followUp.count({ where: { sequenceId: f.seq.id, status: "pending" } })).toBe(0);
  });

  it("20 rondes de workers, de suppression de séquence : aucun verrou mortel non traité, aucune tâche pour une relance annulée, aucune relance « pending » restante", async () => {
    for (let i = 0; i < 20; i++) {
      await resetDb();
      const f = await dbFixture([0, 0, 0].map((d, k) => ({ day: d, action: "task", title: `T${k}` })));
      const out = await Promise.allSettled([processDueFollowUps({ workspaceId: f.workspaceId }), processDueFollowUps({ workspaceId: f.workspaceId }), deleteSequence(f.workspaceId, f.seq.id)]);
      expect(out.filter((o) => o.status === "rejected")).toEqual([]);
      const fus = await db.followUp.findMany({ where: { leadId: f.lead.id } });
      expect(fus.every((x) => x.status === "done" || x.status === "cancelled")).toBe(true);
      expect(await db.task.count({ where: { leadId: f.lead.id } })).toBe(fus.filter((x) => x.status === "done").length);
      expect(await db.followUpSequence.count({ where: { id: f.seq.id } })).toBe(0);
    }
  }, 120_000);

  it("20 rondes de workers, de désinscription et de désactivation : tout se termine, aucun effet après la révocation", async () => {
    for (let i = 0; i < 20; i++) {
      await resetDb();
      const f = await dbFixture([0, 0, 0, 0].map((d, k) => ({ day: d, action: "task", title: `T${k}` })));
      const out = await Promise.allSettled([processDueFollowUps({ workspaceId: f.workspaceId }), unsubscribeLead(f.workspaceId, f.lead.id), updateSequence(f.workspaceId, f.seq.id, seqData(f.seq, false)), processDueFollowUps({ workspaceId: f.workspaceId })]);
      expect(out.filter((o) => o.status === "rejected")).toEqual([]);
      const fus = await db.followUp.findMany({ where: { leadId: f.lead.id } });
      expect(fus.every((x) => x.status === "done" || x.status === "cancelled")).toBe(true);
      expect(fus.every((x) => x.leaseToken === null)).toBe(true);
      expect(await db.task.count({ where: { leadId: f.lead.id } })).toBe(fus.filter((x) => x.status === "done").length);
    }
  }, 120_000);

  it("effacement concurrent d'une autorisation d'envoi validée : l'effacement attend la transaction, puis l'envoi est abandonné avant l'appel", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    const reached = holdAfterBody(600);
    const worker = processDueFollowUps({ workspaceId: f.workspaceId });
    await reached;
    const t0 = Date.now();
    const erase = eraseLead(f.workspaceId, f.lead.id, f.userId).then((ok) => ({ ok, at: Date.now() }));
    const [, e] = await Promise.all([worker, erase]);
    expect(e.ok).toBe(true);
    expect(e.at - t0).toBeGreaterThanOrEqual(400);
    expect(p.calls).toHaveLength(0);
    const r = await db.followUp.findUniqueOrThrow({ where: { id: f.fu.id } });
    expect([r.status, r.failureKind]).toEqual(["cancelled", "revoked"]);
    // la ligne de tentative créée avant l'effacement est conservée mais anonymisée ; aucun appel fournisseur n'a commencé
    const logs = await db.emailLog.findMany({ where: { leadId: f.lead.id }, select: { to: true, subject: true, callStartedAt: true, status: true } });
    expect(logs.every((x) => x.to === "[effacé]" && x.subject === "[effacé]" && x.callStartedAt === null && x.status !== "sent")).toBe(true);
  });

  it("reprise concurrente et marque d'appel : exclusivité réelle sur deux connexions", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    const g = gate();
    setSendHooksForTests({ afterP4: stallOnce(g) });
    const a = processDueFollowUps({ workspaceId: f.workspaceId });
    await g.reached;
    const b = await processDueFollowUps({ workspaceId: f.workspaceId, now: new Date(Date.now() + 6 * 60_000) });
    g.release();
    const sa = await a;
    expect(b.done + sa.done).toBe(1);
    expect(p.calls).toHaveLength(1);
  });

  it("statut du prospect modifié PENDANT l'écriture conditionnelle (verrou de ligne réel) : le worker attend, constate le conflit et n'écrase rien (relance à examiner)", async () => {
    const f = await dbFixture([{ day: 0, action: "status_change", status: "lost" }]);
    const hold = gate();
    const external = db.$transaction(async (tx) => {
      await tx.lead.update({ where: { id: f.lead.id }, data: { status: "qualified" } });
      hold.reachedResolve();
      await hold.hold;
    }, { timeout: 20_000, maxWait: 5_000 });
    await hold.reached;
    let settled = false;
    const worker = processDueFollowUps({ workspaceId: f.workspaceId }).then((s) => { settled = true; return s; });
    await sleep(500);
    expect(settled).toBe(false); // bloqué sur le verrou du prospect : sa lecture « new » est périmée à la validation de l'autre transaction
    hold.release();
    await external;
    const s = await worker;
    expect(s.needsReview).toBe(1);
    const l = await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } });
    expect([l.status, l.lostAt]).toEqual(["qualified", null]);
    const r = await db.followUp.findUniqueOrThrow({ where: { id: f.fu.id } });
    expect([r.status, r.failureKind]).toEqual(["needs_review", "status_conflict"]);
    expect(await db.leadActivity.count({ where: { leadId: f.lead.id, type: "status_changed" } })).toBe(0);
  });

  it("renvoi manuel : deux clics sur deux connexions (en parallèle, puis pendant que le premier renvoi est en vol chez le fournisseur) — un seul renvoi", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(async () => { throw new Error("réseau indisponible"); }); setEmailProviderForTests(p);
    await processDueFollowUps({ workspaceId: f.workspaceId }); // tentative incertaine : needs_review
    const click = async () => {
      const r = await db.followUp.findUniqueOrThrow({ where: { id: f.fu.id } });
      return resolveFollowUp({ workspaceId: f.workspaceId, userId: f.userId, id: f.fu.id, action: "resend", seen: { attemptCount: r.attemptCount, emailStatus: "uncertain" }, confirm: true });
    };
    const g = gate();
    p.behavior = async () => { g.reachedResolve(); await g.hold; return { id: "msg_2", httpStatus: 200 }; };
    const both = Promise.allSettled([click(), click()]); // vrai parallélisme : un seul passe la réservation conditionnelle
    await g.reached;
    const late = await click().then(() => "accepté", (e: unknown) => e); // troisième clic pendant que le renvoi est en vol
    expect(late).toBeInstanceOf(ReviewError);
    g.release();
    const [a, b] = await both;
    expect([a.status, b.status].filter((x) => x === "fulfilled")).toHaveLength(1);
    expect(p.calls).toHaveLength(2); // l'envoi initial incertain + UN renvoi
    expect((await db.emailLog.findMany({ where: { followUpId: f.fu.id }, orderBy: { attemptNo: "asc" } })).map((x) => [x.attemptNo, x.status])).toEqual([[1, "uncertain"], [2, "sent"]]);
    expect((await db.followUp.findUniqueOrThrow({ where: { id: f.fu.id } })).status).toBe("done");
  });

  it("renvoi manuel en vol PENDANT l'arrivée du résultat tardif de la tentative précédente : aucun blocage, les deux acceptations sont tracées, la relance est finalisée une seule fois (le doublon n'est pas empêché techniquement)", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(); setEmailProviderForTests(p);
    const gA = gate();
    setSendHooksForTests({ afterSend: stallOnce(gA) });
    const a = processDueFollowUps({ workspaceId: f.workspaceId });
    await gA.reached; // A : accepté par le fournisseur (msg_1), résultat non encore enregistré
    await processDueFollowUps({ workspaceId: f.workspaceId, now: later(LEASE_MS + MIN) }); // reprise : needs_review
    setSendHooksForTests(null);
    const gR = gate();
    p.behavior = async () => { gR.reachedResolve(); await gR.hold; return { id: "msg_2", httpStatus: 200 }; };
    const resend = resolveFollowUp({ workspaceId: f.workspaceId, userId: f.userId, id: f.fu.id, action: "resend", seen: { attemptCount: 1, emailStatus: "attempting" }, confirm: true, now: later(2 * MIN) });
    await gR.reached; // le renvoi est en vol
    gA.release(); // le résultat tardif arrive maintenant
    const sa = await a;
    gR.release();
    await resend;
    expect(sa.lost).toBe(1);
    expect((await db.emailLog.findMany({ where: { followUpId: f.fu.id }, orderBy: { attemptNo: "asc" } })).map((x) => [x.attemptNo, x.status, x.providerMessageId])).toEqual([[1, "sent", "msg_1"], [2, "sent", "msg_2"]]);
    expect((await db.followUp.findUniqueOrThrow({ where: { id: f.fu.id } })).status).toBe("done");
    expect(await db.conversation.count({ where: { leadId: f.lead.id } })).toBe(1);
    expect(p.calls).toHaveLength(2);
  });

  it("une tentative incertaine ne déclenche JAMAIS de renvoi automatique : 6 exécuteurs parallèles, à plusieurs dates", async () => {
    const f = await emailFixture();
    const p = new FakeProvider(async () => { throw new Error("délai dépassé"); }); setEmailProviderForTests(p);
    await processDueFollowUps({ workspaceId: f.workspaceId });
    for (const d of [3_600_000, 86_400_000, 30 * 86_400_000]) await Promise.all(Array.from({ length: 6 }, () => processDueFollowUps({ workspaceId: f.workspaceId, now: later(d) })));
    expect(p.calls).toHaveLength(1);
    expect((await db.followUp.findUniqueOrThrow({ where: { id: f.fu.id } })).status).toBe("needs_review");
  });

  it("verrou mortel réel : PostgreSQL en annule un ; Prisma 6.19.3 l'expose SANS code (PrismaClientUnknownRequestError, SQLSTATE 40P01) : le moteur le normalise en P2034", async () => {
    const a = await makeWorkspace("DeadA");
    const b = await makeWorkspace("DeadB");
    const gA = gate(), gB = gate();
    const t1 = db.$transaction(async (tx) => { await tx.workspace.update({ where: { id: a.workspaceId }, data: { name: "x1" } }); gA.reachedResolve(); await gB.reached; await tx.workspace.update({ where: { id: b.workspaceId }, data: { name: "y1" } }); }, { timeout: 20_000, maxWait: 5_000 });
    const t2 = db.$transaction(async (tx) => { await tx.workspace.update({ where: { id: b.workspaceId }, data: { name: "y2" } }); gB.reachedResolve(); await gA.reached; await tx.workspace.update({ where: { id: a.workspaceId }, data: { name: "x2" } }); }, { timeout: 20_000, maxWait: 5_000 });
    const res = await Promise.allSettled([t1, t2]);
    const rejected = res.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect((rejected[0].reason as { code?: string }).code).toBeUndefined();
    expect(String((rejected[0].reason as Error).message)).toMatch(/40P01|deadlock detected/);
    expect(transactionErrorCode(rejected[0].reason)).toBe("P2034");
  });
});
