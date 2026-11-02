import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { eraseLead } from "@/lib/leads";
import { processDueFollowUps } from "@/lib/followups";
import { EmailError, setEmailProviderForTests, storableProviderError } from "@/lib/email";
import { ERASED_RESULT_NOTE, recordProviderOutcome, setSendHooksForTests } from "@/lib/followup-send";
import { FakeProvider, emailFixture, noRetryDelay, resetEngineTestState } from "./followup-helpers";
import { resetDb } from "./helpers";

// Concurrence RÉELLE sur PostgreSQL (plusieurs connexions du pool) : résultat fournisseur tardif contre effacement. Ignoré sous SQLite (une seule connexion).
const isPg = /^postgres(ql)?:\/\//.test(process.env.DATABASE_URL ?? "");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const orig = () => db.$transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;
const PII = ["m@y.com", "Marie", "Durand"];
const LEAK = "refus : l'adresse m@y.com de Marie Durand est invalide";

/** Garde la PROCHAINE transaction ouverte (verrous tenus) `ms` après l'exécution de son corps. `reached` se résout quand son corps est exécuté. */
function holdNextTx(ms: number) {
  let reached!: () => void;
  const wasReached = new Promise<void>((r) => (reached = r));
  const o = orig();
  vi.spyOn(db, "$transaction").mockImplementationOnce(((fn: (tx: unknown) => Promise<unknown>, opts: unknown) =>
    o(async (tx: unknown) => { const r = await fn(tx); reached(); await sleep(ms); return r; }, opts)) as never);
  return wasReached;
}

const dump = async (workspaceId: string, leadId: string) => JSON.stringify({
  logs: await db.emailLog.findMany({ where: { workspaceId } }), fus: await db.followUp.findMany({ where: { leadId } }), tasks: await db.task.findMany({ where: { workspaceId } }),
  audit: await db.auditLog.findMany({ where: { workspaceId, action: { not: "workspace.created" } } }),
});

describe.skipIf(!isPg)("PostgreSQL — résultat fournisseur tardif contre effacement", () => {
  beforeEach(async () => { await resetDb(); noRetryDelay(); });
  afterEach(resetEngineTestState);

  it("effacement PENDANT le traitement du résultat : l'effacement attend la transaction de finalisation, puis anonymise ; aucune donnée personnelle ne subsiste", async () => {
    const f = await emailFixture();
    setEmailProviderForTests(new FakeProvider(async () => { throw new EmailError(LEAK, { kind: "rejected", status: 422 }); }));
    let reached: Promise<void> = Promise.resolve();
    setSendHooksForTests({ afterOutcome: () => { reached = holdNextTx(700); } }); // la transaction de finalisation T3 est la prochaine
    const worker = processDueFollowUps({ workspaceId: f.workspaceId });
    await vi.waitFor(async () => { expect(await db.emailLog.count({ where: { leadId: f.lead.id, status: "failed" } })).toBe(1); }, { timeout: 5000 });
    await sleep(50); await reached;
    const t0 = Date.now();
    const erase = eraseLead(f.workspaceId, f.lead.id, f.userId).then((ok) => ({ ok, at: Date.now() }));
    const [, e] = await Promise.all([worker, erase]);
    expect(e.ok).toBe(true);
    expect(e.at - t0).toBeGreaterThanOrEqual(400); // l'effacement a réellement attendu les verrous de la finalisation
    const log = await db.emailLog.findFirstOrThrow({ where: { leadId: f.lead.id } });
    expect([log.to, log.subject, log.status, log.httpStatus]).toEqual(["[effacé]", "[effacé]", "failed", 422]);
    for (const s of PII) expect(await dump(f.workspaceId, f.lead.id), s).not.toContain(s);
  }, 60_000);

  it("course effacement / résultat (12 passages, décalages variables) : l'état final est toujours anonymisé et sans donnée personnelle", async () => {
    for (let i = 0; i < 12; i++) {
      await resetDb(); noRetryDelay();
      const f = await emailFixture();
      const delay = Math.floor(Math.random() * 30);
      setEmailProviderForTests(new FakeProvider(async () => { await sleep(delay); throw new EmailError(LEAK, { kind: i % 2 ? "rejected" : "uncertain", status: i % 2 ? 422 : 502 }); }));
      const worker = processDueFollowUps({ workspaceId: f.workspaceId });
      const erase = sleep(Math.floor(Math.random() * 60)).then(() => eraseLead(f.workspaceId, f.lead.id, f.userId));
      const [, ok] = await Promise.all([worker, erase]);
      expect(ok).toBe(true);
      const logs = await db.emailLog.findMany({ where: { leadId: f.lead.id } });
      for (const l of logs) expect([l.to, l.subject]).toEqual(["[effacé]", "[effacé]"]);
      for (const s of PII) expect(await dump(f.workspaceId, f.lead.id), `${s} (passage ${i})`).not.toContain(s);
      expect((await db.followUp.findUniqueOrThrow({ where: { id: f.fu.id } })).leaseToken).toBeNull();
      resetEngineTestState();
    }
  }, 120_000);

  it("deux résultats concurrents pour la même tentative : un seul est appliqué, le second ne réécrit rien", async () => {
    const f = await emailFixture();
    const mk = (id: string) => db.emailLog.create({ data: { id, workspaceId: f.workspaceId, leadId: f.lead.id, to: "m@y.com", subject: "S", provider: "fake", status: "attempting", followUpId: f.fu.id, attemptNo: 1 } });
    for (let i = 0; i < 6; i++) {
      const id = `el:race:${i}`;
      await mk(id);
      const [a, b] = await Promise.all([
        recordProviderOutcome(db, id, { status: "sent", providerMessageId: `msg_${i}`, httpStatus: 200 }),
        recordProviderOutcome(db, id, { status: "uncertain", httpStatus: 502, error: storableProviderError(new Error(LEAK)) }),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1); // exactement un gagnant
      const row = await db.emailLog.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe(a ? "sent" : "uncertain");
      expect(row.providerMessageId).toBe(a ? `msg_${i}` : null); // aucun mélange des deux résultats
      expect(row.httpStatus).toBe(a ? 200 : 502);
      expect(await recordProviderOutcome(db, id, { status: "failed", httpStatus: 400 })).toBe(false); // idempotent : plus « attempting »
    }
  });

  it("résultat reçu pour un prospect déjà effacé : champs techniques seulement, détail remplacé par un libellé neutre ; accepté, refusé et incertain", async () => {
    const f = await emailFixture();
    await eraseLead(f.workspaceId, f.lead.id, f.userId);
    const cases = [
      { id: "el:late:sent", o: { status: "sent" as const, providerMessageId: "msg_late", httpStatus: 200 }, err: null },
      { id: "el:late:failed", o: { status: "failed" as const, httpStatus: 422, error: "Refus du fournisseur (HTTP 422)" }, err: ERASED_RESULT_NOTE },
      { id: "el:late:uncertain", o: { status: "uncertain" as const, httpStatus: 502, error: "Résultat indéterminé (HTTP 502)" }, err: ERASED_RESULT_NOTE },
    ];
    for (const c of cases) {
      await db.emailLog.create({ data: { id: c.id, workspaceId: f.workspaceId, leadId: f.lead.id, to: "[effacé]", subject: "[effacé]", provider: "fake", status: "attempting" } });
      expect(await recordProviderOutcome(db, c.id, c.o)).toBe(true);
      const row = await db.emailLog.findUniqueOrThrow({ where: { id: c.id } });
      expect([row.status, row.httpStatus, row.error, row.providerMessageId, row.to, row.subject]).toEqual([c.o.status, c.o.httpStatus, c.err, c.o.providerMessageId ?? null, "[effacé]", "[effacé]"]);
    }
  });
});
