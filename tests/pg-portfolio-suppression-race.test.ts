import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { addProspect, ensureDefaultProducts, eraseProspect, optOutProspect, reassignProspect } from "@/lib/portfolio/service";
import { backfillSuppressionKeys, isEmailSuppressed, keyedEmailKey, suppressionKeyring } from "@/lib/suppression";
import { setRetryTimingForTests } from "@/lib/followup-runtime";
import { makeWorkspace, resetDb } from "./helpers";

// Course DÉTERMINISTE sur PostgreSQL (ignorée sous SQLite) : un AUTRE client insère la ligne en conflit dans une transaction qu'il garde ouverte (ligne invisible des autres connexions,
// verrou d'unicité tenu) ; l'opération du portefeuille démarre, lit « absent », tente d'insérer la MÊME ligne et attend ; l'autre client valide : l'INSERT échoue (P2002).
// `runTx` doit alors reprendre la transaction ENTIÈRE, dont la nouvelle tentative retrouve la ligne. Sans cette reprise, l'opération échoue (reproduction à chaque exécution).
const isPg = /^postgres(ql)?:\/\//.test(process.env.DATABASE_URL ?? "");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const KA = "cle-dediee-A-".padEnd(48, "a");
const EMAIL = "marie@roy.ca";
const HOLD_MS = 400;
const collected = new Date("2026-10-01T00:00:00Z");
const saved = { cur: process.env.SUPPRESSION_HMAC_KEY, prev: process.env.SUPPRESSION_HMAC_KEY_PREVIOUS };
const other = isPg ? new PrismaClient() : null; // second client Prisma : autre pool, autres connexions
const hmacKey = (workspaceId: string) => keyedEmailKey(workspaceId, EMAIL, suppressionKeyring().current!);

/** Client B : exécute `write` dans une transaction qu'il garde ouverte `HOLD_MS` après l'écriture, puis valide. */
function holdWrite(write: (t: Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]) => Promise<unknown>) {
  let written!: () => void;
  const wasWritten = new Promise<void>((r) => (written = r));
  const done = other!.$transaction(async (t) => { await write(t); written(); await sleep(HOLD_MS); }, { timeout: 30_000 });
  return { wasWritten, done };
}
/** Compte les transactions ouvertes par l'application (une par tentative de `runTx`), sans rien changer. */
function countTransactions() {
  const real = db.$transaction.bind(db) as unknown as (...a: unknown[]) => Promise<unknown>;
  const c = { n: 0 };
  vi.spyOn(db, "$transaction").mockImplementation(((...a: unknown[]) => { c.n++; return real(...a); }) as never);
  return c;
}
async function setup() {
  const a = await makeWorkspace("Portfolio");
  await ensureDefaultProducts(a.workspaceId, a.userId);
  const products = await db.product.findMany({ where: { workspaceId: a.workspaceId } });
  const by = (slug: string) => products.find((x) => x.slug === slug)!;
  const driver = by("driverpilot"), nexa = by("freelancenexa");
  const { prospect } = await addProspect(a.workspaceId, { name: "Marie Roy", company: "Plomberie Roy", email: EMAIL, source: "Site public de l'entreprise", collectedAt: collected, legalBasis: "implied_published", productId: driver.id });
  return { ...a, driver, nexa, prospect };
}
const suppressions = (workspaceId: string) => db.emailSuppression.findMany({ where: { workspaceId } });
const audits = (workspaceId: string, action: string) => db.auditLog.count({ where: { workspaceId, action } });

describe.skipIf(!isPg)("PostgreSQL — portefeuille : clé de suppression / intérêt créés par un autre client pendant l'opération", () => {
  beforeEach(async () => {
    await resetDb();
    process.env.SUPPRESSION_HMAC_KEY = KA; delete process.env.SUPPRESSION_HMAC_KEY_PREVIOUS;
    setRetryTimingForTests({ sleep: async () => {}, jitter: () => 0 });
  });
  afterEach(() => {
    vi.restoreAllMocks(); setRetryTimingForTests(null);
    for (const [k, v] of [["SUPPRESSION_HMAC_KEY", saved.cur], ["SUPPRESSION_HMAC_KEY_PREVIOUS", saved.prev]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  afterAll(async () => { await other?.$disconnect(); });

  it("désinscription : collision reprise en entier (5 fois), prospect bloqué, UNE entrée HMAC, adresse bloquée, audit unique", async () => {
    for (let i = 0; i < 5; i++) {
      await resetDb();
      const { workspaceId, prospect } = await setup();
      const tx = countTransactions();
      const b = holdWrite((t) => t.emailSuppression.create({ data: { workspaceId, email: hmacKey(workspaceId), reason: "unsubscribe" } }));
      await b.wasWritten;
      const u = optOutProspect({ workspaceId, prospectId: prospect.id });
      await b.done;
      expect((await u).status).toBe("do_not_contact");
      expect(tx.n, `itération ${i} : la collision a bien eu lieu (1re tentative échouée + reprise)`).toBe(2);
      vi.restoreAllMocks();
      const p = await db.prospect.findUniqueOrThrow({ where: { id: prospect.id } });
      expect(p).toMatchObject({ status: "do_not_contact" });
      expect(p.optedOutAt).not.toBeNull();
      const s = await suppressions(workspaceId);
      expect(s).toHaveLength(1);
      expect(s[0].email).toBe(hmacKey(workspaceId)); // la ligne concurrente est conservée telle quelle (raison inchangée)
      expect(await isEmailSuppressed(db, workspaceId, EMAIL)).toBe(true);
      expect(await audits(workspaceId, "prospect.opted_out")).toBe(1);
    }
  }, 120_000);

  it("effacement : collision reprise en entier (5 fois), fiche anonymisée, UNE entrée HMAC, adresse bloquée, audit unique", async () => {
    for (let i = 0; i < 5; i++) {
      await resetDb();
      const { workspaceId, prospect } = await setup();
      const tx = countTransactions();
      const b = holdWrite((t) => t.emailSuppression.create({ data: { workspaceId, email: hmacKey(workspaceId), reason: "unsubscribe" } }));
      await b.wasWritten;
      const e = eraseProspect({ workspaceId, prospectId: prospect.id });
      await b.done;
      expect(await e).toBe(true);
      expect(tx.n, `itération ${i} : la collision a bien eu lieu`).toBe(2);
      vi.restoreAllMocks();
      const p = await db.prospect.findUniqueOrThrow({ where: { id: prospect.id } });
      expect(p).toMatchObject({ name: "Prospect effacé", email: null, company: null, status: "do_not_contact" });
      expect(p.deletedAt).not.toBeNull();
      expect(await suppressions(workspaceId)).toHaveLength(1);
      expect(await isEmailSuppressed(db, workspaceId, EMAIL)).toBe(true);
      expect(await audits(workspaceId, "prospect.erased")).toBe(1);
    }
  }, 120_000);

  it("réattribution : intérêt créé en même temps par un autre client, collision reprise en entier, un seul intérêt, prospect déplacé", async () => {
    for (let i = 0; i < 5; i++) {
      await resetDb();
      const { workspaceId, prospect, driver, nexa } = await setup();
      const tx = countTransactions();
      const b = holdWrite((t) => t.prospectProduct.create({ data: { workspaceId, prospectId: prospect.id, productId: driver.id, note: "créé ailleurs" } }));
      await b.wasWritten;
      const r = reassignProspect({ workspaceId, prospectId: prospect.id, toProductId: nexa.id, reason: "Travailleur autonome" });
      await b.done;
      expect((await r).productId).toBe(nexa.id);
      expect(tx.n, `itération ${i} : la collision a bien eu lieu`).toBe(2);
      vi.restoreAllMocks();
      const interests = await db.prospectProduct.findMany({ where: { prospectId: prospect.id } });
      expect(interests.map((x) => x.productId)).toEqual([driver.id]);
      expect(await audits(workspaceId, "prospect.reassigned")).toBe(1);
    }
  }, 120_000);

  it("désinscription contre le VRAI backfill (8 itérations, décalages différents) : aucune erreur, une seule entrée HMAC, prospect bloqué, adresse bloquée", async () => {
    for (let i = 0; i < 8; i++) {
      await resetDb();
      const { workspaceId, prospect } = await setup();
      await db.emailSuppression.create({ data: { workspaceId, email: EMAIL, reason: "unsubscribe" } }); // entrée en clair historique : cible du backfill
      const [, u] = await Promise.all([
        backfillSuppressionKeys({ workspaceId, dryRun: false, deletePlain: true }),
        sleep(i * 3).then(() => optOutProspect({ workspaceId, prospectId: prospect.id })),
      ]);
      expect(u.status).toBe("do_not_contact");
      expect(await db.emailSuppression.count({ where: { workspaceId, email: hmacKey(workspaceId) } })).toBe(1);
      expect(await isEmailSuppressed(db, workspaceId, EMAIL)).toBe(true);
      expect((await db.prospect.findUniqueOrThrow({ where: { id: prospect.id } })).optedOutAt).not.toBeNull();
    }
  }, 120_000);

  it("deux effacements simultanés du même prospect : tous deux réussissent, une seule anonymisation auditée, une entrée de suppression", async () => {
    for (let i = 0; i < 5; i++) {
      await resetDb();
      const { workspaceId, prospect } = await setup();
      const [a, b] = await Promise.all([eraseProspect({ workspaceId, prospectId: prospect.id }), eraseProspect({ workspaceId, prospectId: prospect.id })]);
      expect([a, b]).toEqual([true, true]);
      expect((await db.prospect.findUniqueOrThrow({ where: { id: prospect.id } })).name).toBe("Prospect effacé");
      expect(await suppressions(workspaceId)).toHaveLength(1);
      expect(await audits(workspaceId, "prospect.erased")).toBe(1);
    }
  }, 120_000);

  it("deux désinscriptions simultanées du même prospect : une seule entrée, un seul audit, aucune erreur", async () => {
    for (let i = 0; i < 5; i++) {
      await resetDb();
      const { workspaceId, prospect } = await setup();
      const [a, b] = await Promise.all([optOutProspect({ workspaceId, prospectId: prospect.id }), optOutProspect({ workspaceId, prospectId: prospect.id })]);
      expect([a.status, b.status]).toEqual(["do_not_contact", "do_not_contact"]);
      expect(await suppressions(workspaceId)).toHaveLength(1);
      expect(await audits(workspaceId, "prospect.opted_out")).toBe(1);
    }
  }, 120_000);
});
