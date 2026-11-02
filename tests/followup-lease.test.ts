import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { enrollLead, deleteSequence, processDueFollowUps, updateSequence } from "@/lib/followups";
import { LEASE_MS, MAX_AUTHORIZATIONS, MAX_TECHNICAL_FAILURES, SimulatedCrash, finishTx, requeueTx, technicalRetryDelayMs } from "@/lib/followup-runtime";
import { createLead, eraseLead, unsubscribeLead } from "@/lib/leads";
import { erasedEmailKey } from "@/lib/suppression";
import { MIN, dbFixture, err, later, noRetryDelay, resetEngineTestState, seqData, taskFixture } from "./followup-helpers";
import { makeWorkspace, resetDb } from "./helpers";

beforeEach(async () => { await resetDb(); noRetryDelay(); });
afterEach(resetEngineTestState);

const row = (id: string) => db.followUp.findUniqueOrThrow({ where: { id } });
const seqRef = (fu: { id: string; workspaceId: string; sequenceId: string | null }) => ({ id: fu.id, workspaceId: fu.workspaceId, sequenceId: fu.sequenceId, technicalFailureCount: 0 });

describe("bail : réservation, expiration, jeton périmé", () => {
  it("la réservation pose un jeton unique et un bail de 5 minutes ; ils sont effacés à la fin et l'autorisation est comptée une fois", async () => {
    const { workspaceId, fu } = await taskFixture();
    let seen: { token: string | null; until: Date | null } | null = null;
    const orig = db.$transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;
    vi.spyOn(db, "$transaction").mockImplementationOnce((async (fn: unknown, opts: unknown) => {
      const r = await db.followUp.findUniqueOrThrow({ where: { id: fu.id } });
      seen = { token: r.leaseToken, until: r.leaseUntil };
      return orig(fn, opts);
    }) as never);
    const before = Date.now();
    const s = await processDueFollowUps({ workspaceId });
    expect(s.done).toBe(1);
    expect(seen!.token).toMatch(/^[\w-]{16,}$/);
    expect(seen!.until!.getTime() - before).toBeGreaterThanOrEqual(LEASE_MS - 2_000);
    expect(seen!.until!.getTime() - before).toBeLessThanOrEqual(LEASE_MS + 5_000);
    const r = await row(fu.id);
    expect([r.status, r.leaseToken, r.leaseUntil, r.attemptCount, r.technicalFailureCount, r.failureKind]).toEqual(["done", null, null, 1, 0, null]);
    expect(r.lastAttemptAt).not.toBeNull();
  });

  it("quatre exécuteurs simultanés : chaque relance est exécutée une fois, une seule autorisation comptée", async () => {
    const f = await dbFixture([0, 0, 0, 0, 0, 0].map((d, i) => ({ day: d, action: "task", title: `T${i}` })));
    await Promise.all([1, 2, 3, 4].map(() => processDueFollowUps({ workspaceId: f.workspaceId })));
    expect(await db.task.count({ where: { leadId: f.lead.id } })).toBe(6);
    const all = await db.followUp.findMany({ where: { leadId: f.lead.id } });
    expect(all.every((x) => x.status === "done" && x.attemptCount === 1)).toBe(true);
  });

  it("bail expiré : un second exécuteur reprend la relance ; l'abandon est compté comme échec technique, pas comme autorisation", async () => {
    const { workspaceId, fu, lead } = await taskFixture();
    await db.followUp.update({ where: { id: fu.id }, data: { status: "running", leaseToken: "ancien-jeton", leaseUntil: new Date(Date.now() - 1000) } });
    const s = await processDueFollowUps({ workspaceId });
    expect(s.done).toBe(1);
    const r = await row(fu.id);
    expect([r.status, r.attemptCount, r.technicalFailureCount, r.leaseToken]).toEqual(["done", 1, 1, null]);
    expect(await db.task.count({ where: { leadId: lead.id } })).toBe(1);
  });

  it("bail non expiré : la relance n'est pas reprise", async () => {
    const { workspaceId, fu } = await taskFixture();
    await db.followUp.update({ where: { id: fu.id }, data: { status: "running", leaseToken: "actif", leaseUntil: later(MIN) } });
    expect((await processDueFollowUps({ workspaceId })).processed).toBe(0);
    expect((await row(fu.id)).leaseToken).toBe("actif");
  });

  it("jeton périmé : aucune finalisation ni remise en file par un ancien exécuteur ; le détenteur actuel finalise", async () => {
    const { workspaceId, fu } = await taskFixture();
    await db.followUp.update({ where: { id: fu.id }, data: { status: "running", leaseToken: "B", leaseUntil: later(MIN) } });
    expect(await finishTx(fu.id, "A-périmé", new Date(), { status: "done", result: "x" })).toBe("lost");
    expect(await requeueTx(seqRef({ ...fu, workspaceId }), "A-périmé", new Date(), "technical", "x")).toBe("lost");
    expect(await requeueTx(seqRef({ ...fu, workspaceId }), "A-périmé", new Date(), "aborted", "x")).toBe("lost");
    const r = await row(fu.id);
    expect([r.status, r.leaseToken, r.technicalFailureCount]).toEqual(["running", "B", 0]);
    expect(await finishTx(fu.id, "B", new Date(), { status: "done", result: "ok" })).toBe("applied");
  });

  it("anciennes lignes « running » sans jeton : jamais reprises, aucune donnée modifiée", async () => {
    const { workspaceId, fu, lead } = await taskFixture();
    await db.followUp.update({ where: { id: fu.id }, data: { status: "running" } });
    const before = await row(fu.id);
    const s = await processDueFollowUps({ workspaceId, now: later(30 * 86_400_000) });
    expect(s.processed).toBe(0);
    expect(await row(fu.id)).toEqual(before);
    expect(await db.task.count({ where: { leadId: lead.id } })).toBe(0);
  });
});

describe("interruptions", () => {
  it("interruption avant la réservation : rien n'est écrit, la relance reste en attente puis s'exécute normalement", async () => {
    const { workspaceId, fu, lead } = await taskFixture();
    vi.spyOn(db.followUp, "updateMany").mockImplementationOnce((() => { throw new SimulatedCrash("avant réservation"); }) as never);
    await expect(processDueFollowUps({ workspaceId })).rejects.toBeInstanceOf(SimulatedCrash);
    const r = await row(fu.id);
    expect([r.status, r.leaseToken, r.attemptCount]).toEqual(["pending", null, 0]);
    vi.restoreAllMocks();
    expect((await processDueFollowUps({ workspaceId })).done).toBe(1);
    expect(await db.task.count({ where: { leadId: lead.id } })).toBe(1);
  });

  it("interruption APRÈS la création de la tâche : la transaction est annulée en bloc (ni tâche, ni activité, ni autorisation comptée) ; la reprise ne crée qu'une tâche", async () => {
    const { workspaceId, fu, lead } = await taskFixture();
    const orig = db.$transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;
    vi.spyOn(db, "$transaction").mockImplementationOnce(((fn: (tx: unknown) => Promise<unknown>, opts: unknown) =>
      orig(async (tx: unknown) => { await fn(tx); throw new SimulatedCrash("après création de la tâche"); }, opts)) as never);
    await expect(processDueFollowUps({ workspaceId })).rejects.toBeInstanceOf(SimulatedCrash);
    expect(await db.task.count({ where: { leadId: lead.id } })).toBe(0);
    expect(await db.leadActivity.count({ where: { leadId: lead.id, type: "task" } })).toBe(0);
    const mid = await row(fu.id);
    expect([mid.status, mid.attemptCount]).toEqual(["running", 0]);
    expect(mid.leaseToken).not.toBeNull();
    vi.restoreAllMocks();
    const s = await processDueFollowUps({ workspaceId, now: later(LEASE_MS + MIN) });
    expect(s.done).toBe(1);
    expect(await db.task.count({ where: { leadId: lead.id } })).toBe(1);
    expect((await db.task.findFirstOrThrow({ where: { leadId: lead.id } })).id).toBe(`fut:${fu.id}`);
    const r = await row(fu.id);
    expect([r.status, r.attemptCount, r.technicalFailureCount]).toEqual(["done", 1, 1]);
  });

  it("interruption après création du rappel : même garantie (identifiant déterministe fun:)", async () => {
    const { workspaceId, fu } = await dbFixture([{ day: 0, action: "reminder", title: "Rappel {{nom}}" }]);
    const orig = db.$transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;
    vi.spyOn(db, "$transaction").mockImplementationOnce(((fn: (tx: unknown) => Promise<unknown>, opts: unknown) =>
      orig(async (tx: unknown) => { await fn(tx); throw new SimulatedCrash("après création du rappel"); }, opts)) as never);
    await expect(processDueFollowUps({ workspaceId })).rejects.toBeInstanceOf(SimulatedCrash);
    expect(await db.notification.count({ where: { workspaceId, type: "reminder" } })).toBe(0);
    vi.restoreAllMocks();
    await processDueFollowUps({ workspaceId, now: later(LEASE_MS + MIN) });
    const n = await db.notification.findMany({ where: { workspaceId, type: "reminder" } });
    expect(n.map((x) => x.id)).toEqual([`fun:${fu.id}`]);
  });

  it("identifiants déterministes : une tâche déjà créée par une exécution précédente n'est pas dupliquée", async () => {
    const { workspaceId, fu, lead } = await taskFixture();
    await db.task.create({ data: { id: `fut:${fu.id}`, workspaceId, leadId: lead.id, title: "déjà là", source: "followup" } });
    await processDueFollowUps({ workspaceId });
    expect(await db.task.count({ where: { leadId: lead.id } })).toBe(1);
    expect((await row(fu.id)).status).toBe("done");
  });
});

describe("plafond de trois autorisations métier", () => {
  it("relance en attente avec 3 autorisations : état terminal explicite « failed / exhausted », aucun effet", async () => {
    const { workspaceId, fu, lead } = await taskFixture();
    await db.followUp.update({ where: { id: fu.id }, data: { attemptCount: MAX_AUTHORIZATIONS } });
    const s = await processDueFollowUps({ workspaceId });
    expect(s.failed).toBe(1);
    const r = await row(fu.id);
    expect([r.status, r.failureKind, r.leaseToken, r.leaseUntil, r.retryAfter, r.attemptCount]).toEqual(["failed", "exhausted", null, null, null, 3]);
    expect(await db.task.count({ where: { leadId: lead.id } })).toBe(0);
  });

  it("bail expiré avec 3 autorisations : failed / exhausted (jamais bloquée en « running »)", async () => {
    const { workspaceId, fu } = await taskFixture();
    await db.followUp.update({ where: { id: fu.id }, data: { status: "running", leaseToken: "x", leaseUntil: new Date(Date.now() - 1000), attemptCount: 3 } });
    await processDueFollowUps({ workspaceId });
    const r = await row(fu.id);
    expect([r.status, r.failureKind, r.leaseToken]).toEqual(["failed", "exhausted", null]);
  });

  it("2 autorisations : la troisième est permise (jamais plus de 3) ; le compteur ne dépasse pas 3", async () => {
    const { workspaceId, fu } = await taskFixture();
    await db.followUp.update({ where: { id: fu.id }, data: { attemptCount: 2 } });
    await processDueFollowUps({ workspaceId });
    const r = await row(fu.id);
    expect([r.status, r.attemptCount]).toEqual(["done", 3]);
  });

  it("le plafond est indépendant du compteur technique", async () => {
    const { workspaceId, fu } = await taskFixture();
    await db.followUp.update({ where: { id: fu.id }, data: { technicalFailureCount: 5, attemptCount: 0 } });
    await processDueFollowUps({ workspaceId });
    const r = await row(fu.id);
    expect([r.status, r.attemptCount, r.technicalFailureCount]).toEqual(["done", 1, 5]);
  });
});

describe("échecs techniques et reprises transactionnelles", () => {
  it.each(["P2034", "P2028", "P1008"])("erreur %s : deux reprises immédiates (transaction annulée), puis report progressif sans consommer une autorisation", async (code) => {
    const { workspaceId, fu, lead } = await taskFixture();
    const spy = vi.spyOn(db, "$transaction")
      .mockRejectedValueOnce(err(code)).mockRejectedValueOnce(err(code)).mockRejectedValueOnce(err(code));
    const s = await processDueFollowUps({ workspaceId });
    expect(s.requeued).toBe(1);
    expect(spy).toHaveBeenCalledTimes(4); // 1 essai + 2 reprises + la remise en file
    const r = await row(fu.id);
    expect([r.status, r.attemptCount, r.technicalFailureCount, r.failureKind, r.leaseToken]).toEqual(["pending", 0, 1, "technical", null]);
    expect(r.retryAfter!.getTime() - Date.now()).toBeGreaterThan(50_000);
    expect(r.retryAfter!.getTime() - Date.now()).toBeLessThan(70_000);
    expect(await db.task.count({ where: { leadId: lead.id } })).toBe(0);
    vi.restoreAllMocks();
    expect((await processDueFollowUps({ workspaceId })).processed).toBe(0); // reportée : pas avant retryAfter
    expect((await processDueFollowUps({ workspaceId, now: later(2 * MIN) })).done).toBe(1);
    const e = await row(fu.id);
    expect([e.status, e.attemptCount, e.technicalFailureCount]).toEqual(["done", 1, 1]);
  });

  it("verrou mortel PostgreSQL sans code Prisma (SQLSTATE 40P01 dans le message) : normalisé en P2034, la transaction est reprise puis aboutit", async () => {
    const { workspaceId, fu, lead } = await taskFixture();
    const deadlock = new Error('Error occurred during query execution: ConnectorError { kind: QueryError(PostgresError { code: "40P01", message: "deadlock detected" }) }');
    const spy = vi.spyOn(db, "$transaction").mockRejectedValueOnce(deadlock).mockRejectedValueOnce(deadlock);
    const s = await processDueFollowUps({ workspaceId });
    expect(s.done).toBe(1);
    expect(spy).toHaveBeenCalledTimes(3); // 1 essai + 2 reprises (la troisième exécution est la vraie)
    expect(await db.task.count({ where: { leadId: lead.id } })).toBe(1);
    expect((await row(fu.id)).attemptCount).toBe(1);
  });

  it("une erreur NON transactionnelle n'est pas reprise dans la transaction (un seul essai) mais reportée", async () => {
    const { workspaceId, fu } = await taskFixture();
    const spy = vi.spyOn(db, "$transaction").mockRejectedValueOnce(new Error("panne inattendue"));
    const s = await processDueFollowUps({ workspaceId });
    expect(s.requeued).toBe(1);
    expect(spy).toHaveBeenCalledTimes(2);
    expect((await row(fu.id)).technicalFailureCount).toBe(1);
  });

  it("erreur métier (statut cible invalide) : échec définitif de nature « business », aucune autorisation comptée, aucun échec technique", async () => {
    const { workspaceId, fu } = await dbFixture([{ day: 0, action: "status_change", status: "contacted" }]);
    await db.followUp.update({ where: { id: fu.id }, data: { payload: { day: 0, action: "status_change", status: "bogus" } } });
    const s = await processDueFollowUps({ workspaceId });
    expect(s.failed).toBe(1);
    const r = await row(fu.id);
    expect([r.status, r.failureKind, r.attemptCount, r.technicalFailureCount]).toEqual(["failed", "business", 0, 0]);
  });

  it("backoff : 1 min, 2, 4, … plafonné à 24 h", () => {
    const d = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map(technicalRetryDelayMs);
    expect(d.slice(0, 4)).toEqual([60_000, 120_000, 240_000, 480_000]);
    expect(d[10]).toBe(61_440_000);
    expect(d[11]).toBe(86_400_000);
    expect(d[13]).toBe(86_400_000);
    expect(Math.max(...d)).toBe(86_400_000);
  });

  it(`au ${MAX_TECHNICAL_FAILURES}e échec technique : passage à « needs_review » (intervention humaine), plus aucune reprise automatique`, async () => {
    const { workspaceId, fu, lead } = await taskFixture();
    await db.followUp.update({ where: { id: fu.id }, data: { status: "running", leaseToken: "x", leaseUntil: new Date(Date.now() - 1000), technicalFailureCount: MAX_TECHNICAL_FAILURES - 1 } });
    const s = await processDueFollowUps({ workspaceId });
    expect(s.needsReview).toBe(1);
    const r = await row(fu.id);
    expect([r.status, r.failureKind, r.technicalFailureCount, r.leaseToken]).toEqual(["needs_review", "technical_persistent", MAX_TECHNICAL_FAILURES, null]);
    expect(await db.task.count({ where: { leadId: lead.id } })).toBe(0);
    expect((await processDueFollowUps({ workspaceId, now: later(86_400_000) })).processed).toBe(0);
  });
});

describe("séquence : désactivation, suppression, inscription", () => {
  it("séquence désactivée directement en base : la relance n'a aucun effet (annulée à l'exécution)", async () => {
    const { workspaceId, fu, seq, lead } = await taskFixture();
    await db.followUpSequence.update({ where: { id: seq.id }, data: { active: false } });
    await processDueFollowUps({ workspaceId });
    const r = await row(fu.id);
    expect([r.status, r.failureKind]).toEqual(["cancelled", "sequence_inactive"]);
    expect(await db.task.count({ where: { leadId: lead.id } })).toBe(0);
  });

  it("désactivation : annule les relances pending et blocked ; conserve running, needs_review et done ; refuse ensuite toute inscription", async () => {
    const f = await dbFixture([0, 0, 0, 0, 0].map((d, i) => ({ day: d, action: "task", title: `T${i}` })));
    const [a, b, c, d, e] = f.fus;
    await db.followUp.update({ where: { id: b.id }, data: { status: "blocked" } });
    await db.followUp.update({ where: { id: c.id }, data: { status: "running", leaseToken: "t", leaseUntil: later(MIN) } });
    await db.followUp.update({ where: { id: d.id }, data: { status: "needs_review" } });
    await db.followUp.update({ where: { id: e.id }, data: { status: "done" } });
    expect(await updateSequence(f.workspaceId, f.seq.id, seqData(f.seq, false))).toBe(true);
    const st = Object.fromEntries((await db.followUp.findMany({ where: { leadId: f.lead.id } })).map((x) => [x.id, x.status]));
    expect([st[a.id], st[b.id], st[c.id], st[d.id], st[e.id]]).toEqual(["cancelled", "cancelled", "running", "needs_review", "done"]);
    const other = (await createLead({ workspaceId: f.workspaceId, name: "Autre", email: "o@y.com" })).lead;
    expect((await enrollLead({ workspaceId: f.workspaceId, leadId: other.id, sequenceId: f.seq.id })).enrolled).toBe(false);
    expect(await updateSequence(f.workspaceId, "inconnue", seqData(f.seq, false))).toBe(false);
  });

  it("suppression : pending et blocked annulées, séquence supprimée ; la relance « running » passe à sequenceId NULL puis est annulée sans effet ; needs_review reste visible", async () => {
    const f = await dbFixture([0, 0, 0].map((d, i) => ({ day: d, action: "task", title: `T${i}` })));
    const [p, r, n] = f.fus;
    await db.followUp.update({ where: { id: r.id }, data: { status: "running", leaseToken: "t", leaseUntil: new Date(Date.now() - 1000) } });
    await db.followUp.update({ where: { id: n.id }, data: { status: "needs_review" } });
    await deleteSequence(f.workspaceId, f.seq.id);
    expect(await db.followUpSequence.count({ where: { id: f.seq.id } })).toBe(0);
    expect((await row(p.id)).status).toBe("cancelled");
    expect((await row(r.id)).sequenceId).toBeNull();
    expect((await row(n.id)).sequenceId).toBeNull();
    await processDueFollowUps({ workspaceId: f.workspaceId });
    const rr = await row(r.id);
    expect([rr.status, rr.failureKind]).toEqual(["cancelled", "sequence_inactive"]);
    expect(await db.task.count({ where: { leadId: f.lead.id } })).toBe(0);
    expect((await row(n.id)).status).toBe("needs_review");
  });

  it("inscription : pending, running et needs_review bloquent la réinscription ; done, blocked, failed et cancelled l'autorisent", async () => {
    const f = await dbFixture([{ day: 5, action: "task", title: "T" }]);
    const again = () => enrollLead({ workspaceId: f.workspaceId, leadId: f.lead.id, sequenceId: f.seq.id });
    expect((await again()).reason).toMatch(/Déjà inscrit/); // pending
    await db.followUp.update({ where: { id: f.fu.id }, data: { status: "running", leaseToken: "t", leaseUntil: later(MIN) } });
    expect((await again()).reason).toMatch(/Déjà inscrit/);
    await db.followUp.update({ where: { id: f.fu.id }, data: { status: "needs_review", leaseToken: null, leaseUntil: null } });
    expect((await again()).reason).toMatch(/à examiner/);
    let gen = 0;
    for (const st of ["done", "blocked", "failed", "cancelled"]) {
      await db.followUp.updateMany({ where: { leadId: f.lead.id, status: { in: ["needs_review", "pending", "done", "blocked", "failed", "cancelled"] } }, data: { status: st } });
      const r = await again();
      expect(r.enrolled).toBe(true);
      gen++;
      await db.followUp.updateMany({ where: { leadId: f.lead.id, status: "pending" }, data: { status: st } });
    }
    expect(await db.followUp.count({ where: { leadId: f.lead.id } })).toBe(1 + gen);
  });

  it("le verrou du prospect (inscription, autorisation) ne modifie jamais Lead.updatedAt", async () => {
    const f = await dbFixture([{ day: 5, action: "task", title: "T" }]);
    const l0 = await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } });
    await db.followUp.updateMany({ where: { leadId: f.lead.id }, data: { status: "cancelled" } });
    expect((await enrollLead({ workspaceId: f.workspaceId, leadId: f.lead.id, sequenceId: f.seq.id })).enrolled).toBe(true);
    expect((await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } })).updatedAt.getTime()).toBe(l0.updatedAt.getTime());
  });
});

describe("révocation : désinscription et effacement", () => {
  it("la désinscription annule pending, blocked, needs_review et running (jeton effacé) ; une relance en cours ne peut plus être finalisée", async () => {
    const f = await dbFixture([0, 0, 0, 0, 0].map((d, i) => ({ day: d, action: "task", title: `T${i}` })));
    const [p, b, n, r, dn] = f.fus;
    await db.followUp.update({ where: { id: b.id }, data: { status: "blocked" } });
    await db.followUp.update({ where: { id: n.id }, data: { status: "needs_review" } });
    await db.followUp.update({ where: { id: r.id }, data: { status: "running", leaseToken: "T", leaseUntil: later(MIN) } });
    await db.followUp.update({ where: { id: dn.id }, data: { status: "done" } });
    expect(await unsubscribeLead(f.workspaceId, f.lead.id)).toBe(true);
    for (const x of [p, b, n, r]) {
      const v = await row(x.id);
      expect([v.status, v.failureKind, v.leaseToken, v.leaseUntil]).toEqual(["cancelled", "revoked", null, null]);
    }
    expect((await row(dn.id)).status).toBe("done");
    expect(await finishTx(r.id, "T", new Date(), { status: "done", result: "x" })).toBe("lost");
    expect(await db.emailSuppression.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
    expect(await db.consent.count({ where: { leadId: f.lead.id, granted: false } })).toBe(1);
  });

  it("désinscription rejouée : répare une liste de suppression manquante sans dupliquer le consentement ni l'historique", async () => {
    const f = await dbFixture([{ day: 0, action: "task", title: "T" }]);
    await unsubscribeLead(f.workspaceId, f.lead.id);
    await db.emailSuppression.deleteMany({ where: { workspaceId: f.workspaceId } });
    await unsubscribeLead(f.workspaceId, f.lead.id);
    expect(await db.emailSuppression.count({ where: { workspaceId: f.workspaceId } })).toBe(1);
    expect(await db.consent.count({ where: { leadId: f.lead.id, granted: false } })).toBe(1);
    expect(await db.leadActivity.count({ where: { leadId: f.lead.id, type: "unsubscribed" } })).toBe(1);
  });

  it("effacement : relances révoquées (y compris en cours), envoi en cours tracé avant la suppression des journaux, aucune donnée personnelle dans la trace", async () => {
    const f = await dbFixture([{ day: 0, action: "task", title: "T" }, { day: 0, action: "task", title: "U" }]);
    await db.followUp.update({ where: { id: f.fus[1].id }, data: { status: "running", leaseToken: "T", leaseUntil: later(MIN) } });
    await db.emailLog.create({ data: { id: "el:x:1", workspaceId: f.workspaceId, leadId: f.lead.id, to: "m@y.com", subject: "S", provider: "fake", status: "attempting", followUpId: f.fus[1].id, attemptNo: 1, callStartedAt: new Date() } });
    expect(await eraseLead(f.workspaceId, f.lead.id, f.userId)).toBe(true);
    for (const x of f.fus) expect([(await row(x.id)).status, (await row(x.id)).failureKind]).toEqual(["cancelled", "revoked"]);
    const a = await db.auditLog.findMany({ where: { workspaceId: f.workspaceId, action: "email.in_flight_at_revocation" } });
    expect(a).toHaveLength(1);
    expect(JSON.stringify(a[0].meta)).not.toContain("m@y.com");
    expect(await db.emailLog.findMany({ where: { leadId: f.lead.id }, select: { to: true, subject: true, status: true } })).toEqual([{ to: "[effacé]", subject: "[effacé]", status: "attempting" }]); // journal anonymisé et conservé : un résultat tardif reste enregistrable
    expect(await db.emailSuppression.count({ where: { workspaceId: f.workspaceId, email: erasedEmailKey(f.workspaceId, "m@y.com") } })).toBe(1); // adresse pseudonymisée, jamais en clair
    expect(await db.emailSuppression.count({ where: { workspaceId: f.workspaceId, email: "m@y.com" } })).toBe(0);
  });
});

describe("transactions : ordre et ouverture", () => {
  it("aucune relance exécutée pour un espace sans abonnement actif, y compris une reprise de bail expiré", async () => {
    const { workspaceId, fu } = await taskFixture();
    await db.followUp.update({ where: { id: fu.id }, data: { status: "running", leaseToken: "x", leaseUntil: new Date(Date.now() - 1000) } });
    await db.subscription.update({ where: { workspaceId }, data: { status: "expired", trialEndsAt: new Date(Date.now() - 86_400_000) } });
    expect(await processDueFollowUps({ workspaceId })).toMatchObject({ processed: 0 });
    expect((await row(fu.id)).status).toBe("running");
  });

  it("un délai global est respecté : aucune relance n'est commencée s'il reste moins de 30 s", async () => {
    const f = await dbFixture([0, 0, 0].map((d, i) => ({ day: d, action: "task", title: `T${i}` })));
    const s = await processDueFollowUps({ workspaceId: f.workspaceId, deadlineAt: Date.now() + 10_000 });
    expect(s).toMatchObject({ processed: 0, deferred: 3 });
    expect(await db.followUp.count({ where: { leadId: f.lead.id, status: "pending" } })).toBe(3);
    expect((await processDueFollowUps({ workspaceId: f.workspaceId })).done).toBe(3);
  });

  it("makeWorkspace/étapes : un autre espace n'est jamais touché", async () => {
    const a = await taskFixture();
    const b = await makeWorkspace("Autre");
    const s = await processDueFollowUps({ workspaceId: b.workspaceId });
    expect(s.processed).toBe(0);
    expect((await row(a.fu.id)).status).toBe("pending");
  });
});
