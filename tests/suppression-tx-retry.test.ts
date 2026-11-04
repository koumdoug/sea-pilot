import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { createLead, eraseLead, unsubscribeLead } from "@/lib/leads";
import { isEmailSuppressed } from "@/lib/suppression";
import { TX_MAX_RETRIES, setRetryTimingForTests } from "@/lib/followup-runtime";
import { makeWorkspace, resetDb } from "./helpers";

// Reprise COMPLÈTE de la transaction sur P2002 (désinscription et effacement), simulée : fonctionne sous SQLite et PostgreSQL.
// La collision réelle avec le backfill est exercée sur PostgreSQL dans tests/pg-suppression-race.test.ts.
// Contrat réel de `runTx` : chaque tentative rappelle `db.$transaction` ; reprise (TX_MAX_RETRIES au plus) uniquement pour les codes autorisés, avec attente `sleep(jitter())`.

const X = "retry.simule@exemple.test";

/** Erreur Prisma réelle (même classe et même forme que celle de l'`upsert` en collision). */
const prismaError = (code: string) => new Prisma.PrismaClientKnownRequestError(`Erreur simulée ${code}`, { code, clientVersion: Prisma.prismaVersion.client });

/**
 * `emailSuppression.upsert` de la transaction lève `errorFor(tentative)` (ou s'exécute si `null`). Tout le reste de la transaction s'exécute RÉELLEMENT : une erreur levée dans le corps
 * fait annuler la transaction par Prisma, exactement comme la collision réelle (l'erreur survient après les premières écritures de la transaction).
 */
function failUpsert(errorFor: (attempt: number) => unknown | null) {
  const real = db.$transaction.bind(db) as unknown as (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) => Promise<unknown>;
  const state = { attempts: 0 };
  vi.spyOn(db, "$transaction").mockImplementation(((fn: (tx: unknown) => Promise<unknown>, opts?: unknown) => {
    const attempt = ++state.attempts;
    return real((tx) => fn(new Proxy(tx as object, {
      get: (t, k, r) => (k === "emailSuppression"
        ? new Proxy(Reflect.get(t, k, r) as object, { get: (o, m, rr) => (m === "upsert" ? (...a: unknown[]) => { const e = errorFor(attempt); if (e) throw e; return (o as { upsert: (...x: unknown[]) => unknown }).upsert(...a); } : Reflect.get(o, m, rr)) })
        : Reflect.get(t, k, r)),
    })), opts);
  }) as never);
  return state;
}

const sleeps: number[] = [];
async function fixture() {
  const { workspaceId } = await makeWorkspace();
  const { lead } = await createLead({ workspaceId, name: "Retry Simulé", email: X, consentMarketing: true });
  await db.followUp.create({ data: { workspaceId, leadId: lead.id, action: "email", status: "pending", dueAt: new Date(), payload: { day: 0, action: "email", subject: "s", body: "b" } } });
  return { workspaceId, lead };
}
const unsubConsents = (workspaceId: string, leadId: string) => db.consent.count({ where: { workspaceId, leadId, type: "marketing", granted: false } });
const unsubActivities = (workspaceId: string, leadId: string) => db.leadActivity.count({ where: { workspaceId, leadId, type: "unsubscribed" } });

beforeEach(async () => { await resetDb(); sleeps.length = 0; setRetryTimingForTests({ sleep: async (ms) => { sleeps.push(ms); }, jitter: () => 0 }); });
afterEach(() => { vi.restoreAllMocks(); setRetryTimingForTests(null); });

describe("désinscription : reprise complète de la transaction sur P2002", () => {
  it("P2002 à la 1re tentative : 2 transactions, reprise COMPLÈTE (pas d'instruction isolée), succès, état final unique et complet", async () => {
    const { workspaceId, lead } = await fixture();
    const st = failUpsert((n) => (n === 1 ? prismaError("P2002") : null));
    expect(await unsubscribeLead(workspaceId, lead.id)).toBe(true);
    expect(st.attempts).toBe(2); //                                     une seule reprise, une transaction entière de plus
    expect(sleeps).toEqual([0]); //                                     le mécanisme de pause de runTx a été utilisé une fois
    const after = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.unsubscribedAt).not.toBeNull();
    expect((await db.followUp.findFirstOrThrow({ where: { leadId: lead.id } })).status).toBe("cancelled");
    // Preuve de l'annulation de la 1re tentative ET de la reprise complète : si les écritures de la 1re tentative (lead mis à jour AVANT l'upsert) avaient survécu,
    // la 2e verrait « déjà désinscrit » (first = faux) et ne créerait ni consentement ni activité. Ils existent, exactement une fois.
    expect(await unsubConsents(workspaceId, lead.id)).toBe(1);
    expect(await unsubActivities(workspaceId, lead.id)).toBe(1);
    expect(await isEmailSuppressed(db, workspaceId, X)).toBe(true);
    expect(await db.emailSuppression.count({ where: { workspaceId } })).toBe(1);
  });

  it("code de reprise historique conservé (P2034) : repris comme avant", async () => {
    const { workspaceId, lead } = await fixture();
    const st = failUpsert((n) => (n === 1 ? prismaError("P2034") : null));
    expect(await unsubscribeLead(workspaceId, lead.id)).toBe(true);
    expect(st.attempts).toBe(2);
  });

  it("erreur hors des codes autorisés (autre code Prisma, ou erreur quelconque) : jamais reprise, jamais avalée, transaction annulée", async () => {
    for (const err of [prismaError("P2003"), new Error("panne imprévue")]) {
      await resetDb(); sleeps.length = 0;
      const { workspaceId, lead } = await fixture();
      vi.restoreAllMocks(); setRetryTimingForTests({ sleep: async (ms) => { sleeps.push(ms); }, jitter: () => 0 });
      const st = failUpsert(() => err);
      await expect(unsubscribeLead(workspaceId, lead.id)).rejects.toBe(err);
      expect(st.attempts).toBe(1);
      expect(sleeps).toHaveLength(0);
      expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).unsubscribedAt).toBeNull(); // rien n'a été validé
      expect(await unsubConsents(workspaceId, lead.id)).toBe(0);
    }
  });

  it("P2002 PERSISTANTE : arrêtée au nombre maximal de tentatives, erreur relancée (jamais transformée en succès), aucun effet validé", async () => {
    const { workspaceId, lead } = await fixture();
    const st = failUpsert(() => prismaError("P2002"));
    await expect(unsubscribeLead(workspaceId, lead.id)).rejects.toMatchObject({ code: "P2002" });
    expect(st.attempts).toBe(1 + TX_MAX_RETRIES);
    expect(sleeps).toHaveLength(TX_MAX_RETRIES);
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).unsubscribedAt).toBeNull();
    expect((await db.followUp.findFirstOrThrow({ where: { leadId: lead.id } })).status).toBe("pending");
    expect(await unsubConsents(workspaceId, lead.id)).toBe(0);
    expect(await unsubActivities(workspaceId, lead.id)).toBe(0);
    expect(await db.emailSuppression.count({ where: { workspaceId } })).toBe(0);
  });
});

describe("effacement : reprise complète de la transaction sur P2002", () => {
  it("P2002 à la 1re tentative : 2 transactions, effacement complet, entrée de suppression unique avec la raison « erasure »", async () => {
    const { workspaceId, lead } = await fixture();
    const st = failUpsert((n) => (n === 1 ? prismaError("P2002") : null));
    expect(await eraseLead(workspaceId, lead.id)).toBe(true);
    expect(st.attempts).toBe(2);
    const after = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect([after.name, after.email]).toEqual(["Prospect effacé", null]);
    expect(after.deletedAt).not.toBeNull();
    const rows = await db.emailSuppression.findMany({ where: { workspaceId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("erasure");
    expect(await isEmailSuppressed(db, workspaceId, X)).toBe(true);
  });

  it("P2002 persistante : arrêtée au maximum, erreur relancée, prospect NON effacé (aucune donnée perdue à moitié)", async () => {
    const { workspaceId, lead } = await fixture();
    const st = failUpsert(() => prismaError("P2002"));
    await expect(eraseLead(workspaceId, lead.id)).rejects.toMatchObject({ code: "P2002" });
    expect(st.attempts).toBe(1 + TX_MAX_RETRIES);
    const after = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.email).toBe(X);
    expect(after.deletedAt).toBeNull();
    expect(await db.emailSuppression.count({ where: { workspaceId } })).toBe(0);
  });

  it("erreur hors des codes autorisés : jamais reprise ni avalée", async () => {
    const { workspaceId, lead } = await fixture();
    const err = prismaError("P2025");
    const st = failUpsert(() => err);
    await expect(eraseLead(workspaceId, lead.id)).rejects.toBe(err);
    expect(st.attempts).toBe(1);
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).email).toBe(X);
  });
});
