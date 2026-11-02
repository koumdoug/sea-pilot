import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { createLead, eraseLead, unsubscribeLead } from "@/lib/leads";
import { backfillSuppressionKeys, erasedEmailKey, isEmailSuppressed, keyedEmailKey, setBackfillHookForTests, suppressionKeyring } from "@/lib/suppression";
import { makeWorkspace, resetDb } from "./helpers";

// Concurrence RÉELLE sur PostgreSQL : plusieurs connexions du pool, et un second client Prisma (autre pool) pour lire depuis l'extérieur. Ignoré sous SQLite.
const isPg = /^postgres(ql)?:\/\//.test(process.env.DATABASE_URL ?? "");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const orig = () => db.$transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;
const KA = "cle-dediee-A-".padEnd(48, "a");
const KB = "cle-dediee-B-".padEnd(48, "b");
const saved = { cur: process.env.SUPPRESSION_HMAC_KEY, prev: process.env.SUPPRESSION_HMAC_KEY_PREVIOUS };

/** Garde la PROCHAINE transaction ouverte (verrous tenus, écritures non validées) `ms` après l'exécution de son corps. */
function holdNextTx(ms: number) {
  let reached!: () => void;
  const wasReached = new Promise<void>((r) => (reached = r));
  const o = orig();
  vi.spyOn(db, "$transaction").mockImplementationOnce(((fn: (tx: unknown) => Promise<unknown>, opts: unknown) =>
    o(async (tx: unknown) => { const r = await fn(tx); reached(); await sleep(ms); return r; }, opts)) as never);
  return wasReached;
}

const X = "x.concurrent@exemple.test";
const Y = "y.concurrent@exemple.test";
const Z = "z.concurrent@exemple.test";
const key = (workspaceId: string, email: string) => keyedEmailKey(workspaceId, email, suppressionKeyring().current!);
const rows = (workspaceId: string) => db.emailSuppression.findMany({ where: { workspaceId } });
const plainRows = async (workspaceId: string) => (await rows(workspaceId)).filter((r) => !r.email.startsWith("h1:") && !r.email.startsWith("erased:"));
const keyedCount = async (workspaceId: string, email: string) => db.emailSuppression.count({ where: { workspaceId, email: key(workspaceId, email) } });

async function seed() {
  const w = await makeWorkspace();
  await db.emailSuppression.create({ data: { workspaceId: w.workspaceId, email: X, reason: "unsubscribe" } });
  await db.emailSuppression.create({ data: { workspaceId: w.workspaceId, email: Y, reason: "prospect_opt_out" } });
  await db.emailSuppression.create({ data: { workspaceId: w.workspaceId, email: erasedEmailKey(w.workspaceId, Z), reason: "erasure" } });
  return w;
}

describe.skipIf(!isPg)("PostgreSQL — backfill de la liste de suppression contre la concurrence", () => {
  beforeEach(async () => { await resetDb(); process.env.SUPPRESSION_HMAC_KEY = KA; delete process.env.SUPPRESSION_HMAC_KEY_PREVIOUS; });
  afterEach(() => {
    setBackfillHookForTests(null); vi.restoreAllMocks();
    for (const [k, v] of [["SUPPRESSION_HMAC_KEY", saved.cur], ["SUPPRESSION_HMAC_KEY_PREVIOUS", saved.prev]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it("deux backfills simultanés sur les mêmes entrées : aucune erreur, une seule entrée HMAC par adresse, plus de clair, adresses toujours bloquées", async () => {
    for (let i = 0; i < 6; i++) {
      await resetDb();
      const { workspaceId } = await seed();
      const [a, b] = await Promise.all([
        backfillSuppressionKeys({ workspaceId, dryRun: false, deletePlain: true }),
        backfillSuppressionKeys({ workspaceId, dryRun: false, deletePlain: true }),
      ]);
      expect(a.created + b.created).toBe(2); // chaque adresse est créée par l'un ou l'autre, jamais deux fois
      expect(await keyedCount(workspaceId, X)).toBe(1);
      expect(await keyedCount(workspaceId, Y)).toBe(1);
      expect(await plainRows(workspaceId)).toHaveLength(0);
      expect(await db.emailSuppression.count({ where: { workspaceId, email: erasedEmailKey(workspaceId, Z) } })).toBe(1);
      for (const e of [X, Y, Z]) expect(await isEmailSuppressed(db, workspaceId, e)).toBe(true);
    }
  }, 120_000);

  it("désinscription concurrente avec le backfill de la même adresse : aucune erreur, adresse bloquée, une seule entrée HMAC", async () => {
    for (let i = 0; i < 8; i++) {
      await resetDb();
      const { workspaceId } = await seed();
      const { lead } = await createLead({ workspaceId, name: "Concurrent", email: X, consentMarketing: true });
      const [, u] = await Promise.all([
        backfillSuppressionKeys({ workspaceId, dryRun: false, deletePlain: true }),
        sleep(i * 3).then(() => unsubscribeLead(workspaceId, lead.id)),
      ]);
      expect(u).toBe(true);
      expect(await keyedCount(workspaceId, X)).toBe(1);
      expect(await isEmailSuppressed(db, workspaceId, X)).toBe(true);
      expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).unsubscribedAt).not.toBeNull();
    }
  }, 120_000);

  it("trois désinscriptions simultanées de la même adresse (deux prospects, double clic), avec et sans clé dédiée : aucune erreur, une seule entrée", async () => {
    for (const withKey of [true, false]) {
      if (!withKey) delete process.env.SUPPRESSION_HMAC_KEY;
      for (let i = 0; i < 8; i++) {
        await resetDb();
        const { workspaceId } = await makeWorkspace();
        const a = await createLead({ workspaceId, name: "A", email: X, consentMarketing: true });
        const b = await createLead({ workspaceId, name: "B", email: X, consentMarketing: true });
        const r = await Promise.allSettled([unsubscribeLead(workspaceId, a.lead.id), unsubscribeLead(workspaceId, b.lead.id), unsubscribeLead(workspaceId, a.lead.id)]);
        expect(r.map((x) => x.status), `passage ${i}, clé ${withKey}`).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
        expect(await db.emailSuppression.count({ where: { workspaceId } })).toBe(1);
        expect(await isEmailSuppressed(db, workspaceId, X)).toBe(true);
      }
    }
  }, 180_000);

  it("effacement concurrent (transaction d'effacement tenue ouverte) : le backfill attend, puis termine sans erreur ; adresse bloquée, ni clair ni doublon", async () => {
    const { workspaceId, userId } = await seed();
    const { lead } = await createLead({ workspaceId, name: "Efface", email: X, consentMarketing: true });
    const reached = holdNextTx(700);
    const erase = eraseLead(workspaceId, lead.id, userId);
    await reached; // l'effacement a écrit l'entrée HMAC et supprimé le clair, sans valider
    const t0 = Date.now();
    const back = backfillSuppressionKeys({ workspaceId, dryRun: false, deletePlain: true }).then((s) => ({ s, at: Date.now() }));
    const [ok, b] = await Promise.all([erase, back]);
    expect(ok).toBe(true);
    expect(b.at - t0).toBeGreaterThanOrEqual(400); // le backfill a réellement attendu le verrou de l'effacement
    expect(await keyedCount(workspaceId, X)).toBe(1);
    expect(await keyedCount(workspaceId, Y)).toBe(1);
    expect((await plainRows(workspaceId)).map((r) => r.email)).toEqual([]);
    for (const e of [X, Y, Z]) expect(await isEmailSuppressed(db, workspaceId, e)).toBe(true);
  }, 60_000);

  it("effacement concurrent, sans blocage, répété : jamais d'erreur, jamais d'adresse libérée", async () => {
    for (let i = 0; i < 8; i++) {
      await resetDb();
      const { workspaceId, userId } = await seed();
      const { lead } = await createLead({ workspaceId, name: "Efface", email: X, consentMarketing: true });
      const [ok] = await Promise.all([eraseLead(workspaceId, lead.id, userId), sleep(i * 3).then(() => backfillSuppressionKeys({ workspaceId, dryRun: false, deletePlain: true }))]);
      expect(ok).toBe(true);
      expect(await keyedCount(workspaceId, X)).toBe(1);
      expect(await isEmailSuppressed(db, workspaceId, X)).toBe(true);
    }
  }, 120_000);

  it("arrêt simulé après la création du HMAC et avant la suppression du clair : aucune adresse libérée ; la reprise termine le travail", async () => {
    const { workspaceId } = await seed();
    setBackfillHookForTests((step) => { if (step === "afterCreate") throw new Error("arrêt simulé"); });
    await expect(backfillSuppressionKeys({ workspaceId, dryRun: false, deletePlain: true })).rejects.toThrow("arrêt simulé");
    setBackfillHookForTests(null);
    expect(await keyedCount(workspaceId, X)).toBe(1); // le HMAC est enregistré…
    expect((await plainRows(workspaceId)).map((r) => r.email).sort()).toEqual([X, Y]); // …et le clair est encore là
    for (const e of [X, Y, Z]) expect(await isEmailSuppressed(db, workspaceId, e)).toBe(true);
    const resumed = await backfillSuppressionKeys({ workspaceId, dryRun: false, deletePlain: true }); // reprise
    expect(resumed.deletedPlain).toBe(2);
    expect(await plainRows(workspaceId)).toHaveLength(0);
    expect(await keyedCount(workspaceId, X)).toBe(1);
    for (const e of [X, Y, Z]) expect(await isEmailSuppressed(db, workspaceId, e)).toBe(true);
  });

  it("l'entrée HMAC est visible depuis une AUTRE connexion (validée) avant toute suppression du clair", async () => {
    const { workspaceId } = await seed();
    const other = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
    try {
      const seen: { keyed: boolean; plain: boolean }[] = [];
      setBackfillHookForTests(async (step, ctx) => {
        if (step !== "afterVerify") return;
        seen.push({
          keyed: !!(await other.emailSuppression.findUnique({ where: { workspaceId_email: { workspaceId, email: ctx.keyed } }, select: { id: true } })),
          plain: !!(await other.emailSuppression.findUnique({ where: { id: ctx.plainId }, select: { id: true } })),
        });
      });
      await backfillSuppressionKeys({ workspaceId, dryRun: false, deletePlain: true });
      expect(seen).toEqual([{ keyed: true, plain: true }, { keyed: true, plain: true }]);
    } finally { await other.$disconnect(); }
  });

  it("échec de vérification (l'entrée HMAC disparaît avant la vérification) : le clair n'est PAS supprimé", async () => {
    const { workspaceId } = await seed();
    setBackfillHookForTests(async (step, ctx) => { if (step === "afterCreate") await db.emailSuppression.deleteMany({ where: { workspaceId, email: ctx.keyed } }); });
    const s = await backfillSuppressionKeys({ workspaceId, dryRun: false, deletePlain: true });
    expect(s.deletedPlain).toBe(0);
    expect((await plainRows(workspaceId)).map((r) => r.email).sort()).toEqual([X, Y]);
    expect(await isEmailSuppressed(db, workspaceId, X)).toBe(true);
  });

  it("échec de vérification (la clé configurée change pendant le backfill : l'entrée créée n'est plus exploitable) : le clair n'est PAS supprimé", async () => {
    const { workspaceId } = await seed();
    setBackfillHookForTests((step) => { if (step === "afterCreate") process.env.SUPPRESSION_HMAC_KEY = KB; });
    const s = await backfillSuppressionKeys({ workspaceId, dryRun: false, deletePlain: true });
    setBackfillHookForTests(null);
    expect(s.deletedPlain).toBe(0);
    expect((await plainRows(workspaceId)).map((r) => r.email).sort()).toEqual([X, Y]);
    expect(await isEmailSuppressed(db, workspaceId, X)).toBe(true); // jamais libérée
  });
});
