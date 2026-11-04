import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { createLead, eraseLead, unsubscribeLead } from "@/lib/leads";
import { isEmailSuppressed, keyedEmailKey, suppressionKeyring } from "@/lib/suppression";
import { setRetryTimingForTests } from "@/lib/followup-runtime";
import { makeWorkspace, resetDb } from "./helpers";

// Course DÉTERMINISTE sur PostgreSQL (ignorée sous SQLite) entre la création de la clé HMAC par un AUTRE client et la désinscription / l'effacement.
//  1. le client B ouvre une transaction et INSÈRE la clé HMAC sans valider (verrou d'unicité tenu, ligne invisible des autres connexions) ;
//  2. la désinscription (ou l'effacement) démarre ; pour la désinscription, son `upsert` (`update: {}`) ne voit pas la ligne (SELECT vide) puis tente d'insérer la MÊME clé : il attend B ;
//  3. B valide : pour le scénario de DÉSINSCRIPTION uniquement, l'INSERT de la 1re transaction échoue (violation d'unicité, P2002). Pour l'EFFACEMENT (`update` non vide), aucune collision n'est
//     observée (1 seule transaction) : ce scénario fixe le résultat sous concurrence ;
//  4. désinscription : `runTx` reprend la transaction ENTIÈRE ; la nouvelle tentative retrouve la ligne et réussit.
// Sans la reprise sur P2002, l'étape 3 fait échouer la DÉSINSCRIPTION (reproduction à chaque exécution) ; l'effacement n'est pas concerné dans ce scénario.
const isPg = /^postgres(ql)?:\/\//.test(process.env.DATABASE_URL ?? "");
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const KA = "cle-dediee-A-".padEnd(48, "a");
const X = "course.deterministe@exemple.test";
const HOLD_MS = 400;
const saved = { cur: process.env.SUPPRESSION_HMAC_KEY, prev: process.env.SUPPRESSION_HMAC_KEY_PREVIOUS };
const other = isPg ? new PrismaClient() : null; // second client Prisma : autre pool, autres connexions
const hmacKey = (workspaceId: string) => keyedEmailKey(workspaceId, X, suppressionKeyring().current!);

/** Client B : insère la clé HMAC dans une transaction qu'il garde ouverte `HOLD_MS` après l'insertion, puis valide. */
function holdKeyInsert(workspaceId: string, reason: string) {
  let inserted!: () => void;
  const wasInserted = new Promise<void>((r) => (inserted = r));
  const done = other!.$transaction(async (t) => {
    await t.emailSuppression.create({ data: { workspaceId, email: hmacKey(workspaceId), reason } });
    inserted();
    await sleep(HOLD_MS);
  }, { timeout: 30_000 });
  return { wasInserted, done };
}

/** Compte les transactions ouvertes par l'application (une par tentative de `runTx`), sans rien changer. */
function countTransactions() {
  const real = db.$transaction.bind(db) as unknown as (...a: unknown[]) => Promise<unknown>;
  const c = { n: 0 };
  vi.spyOn(db, "$transaction").mockImplementation(((...a: unknown[]) => { c.n++; return real(...a); }) as never);
  return c;
}

async function leadFixture() {
  const { workspaceId } = await makeWorkspace();
  const { lead } = await createLead({ workspaceId, name: "Course Déterministe", email: X, phone: "0600000000", consentMarketing: true });
  await db.followUp.create({ data: { workspaceId, leadId: lead.id, action: "email", status: "pending", dueAt: new Date(), payload: { day: 0, action: "email", subject: "s", body: "b" } } });
  return { workspaceId, lead };
}

describe.skipIf(!isPg)("PostgreSQL — course déterministe : clé HMAC créée par un autre client pendant la désinscription / l'effacement", () => {
  beforeEach(async () => {
    await resetDb();
    process.env.SUPPRESSION_HMAC_KEY = KA; delete process.env.SUPPRESSION_HMAC_KEY_PREVIOUS;
    setRetryTimingForTests({ sleep: async () => {}, jitter: () => 0 }); // la collision est déjà résolue au moment de la reprise : aucune attente utile
  });
  afterEach(() => {
    vi.restoreAllMocks(); setRetryTimingForTests(null);
    for (const [k, v] of [["SUPPRESSION_HMAC_KEY", saved.cur], ["SUPPRESSION_HMAC_KEY_PREVIOUS", saved.prev]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });
  afterAll(async () => { await other?.$disconnect(); });

  it("désinscription : la collision est reprise en entier, 5 fois de suite, état final complet et entrée HMAC unique", async () => {
    for (let i = 0; i < 5; i++) {
      await resetDb();
      const { workspaceId, lead } = await leadFixture();
      const tx = countTransactions();
      const b = holdKeyInsert(workspaceId, "unsubscribe");
      await b.wasInserted;
      const u = unsubscribeLead(workspaceId, lead.id); //   démarre pendant que B tient la clé non validée
      await b.done; //                                      B valide : la 1re tentative d'U rencontre la collision
      expect(await u).toBe(true); //                        aucune erreur non traitée
      expect(tx.n, `itération ${i} : la collision a bien eu lieu (1re tentative échouée + reprise)`).toBe(2);
      vi.restoreAllMocks();
      const after = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(after.unsubscribedAt).not.toBeNull();
      expect(after.consentMarketing).toBe(false);
      expect((await db.followUp.findFirstOrThrow({ where: { leadId: lead.id } })).status).toBe("cancelled"); // relances révoquées
      expect(await db.consent.count({ where: { workspaceId, leadId: lead.id, type: "marketing", granted: false } })).toBe(1); // créé une seule fois
      expect(await db.leadActivity.count({ where: { workspaceId, leadId: lead.id, type: "unsubscribed" } })).toBe(1);
      expect(await db.emailSuppression.count({ where: { workspaceId, email: hmacKey(workspaceId) } })).toBe(1); // exactement une entrée HMAC
      expect(await db.emailSuppression.count({ where: { workspaceId } })).toBe(1);
      expect(await isEmailSuppressed(db, workspaceId, X)).toBe(true);
    }
  }, 120_000);

  it("effacement : clé HMAC créée par un autre client pendant l'effacement, 5 fois de suite : succès, données effacées, entrée HMAC unique avec la raison « erasure »", async () => {
    for (let i = 0; i < 5; i++) {
      await resetDb();
      const { workspaceId, lead } = await leadFixture();
      const tx = countTransactions();
      const b = holdKeyInsert(workspaceId, "unsubscribe"); //   la ligne concurrente porte une AUTRE raison : l'effacement doit la remplacer
      await b.wasInserted;
      const e = eraseLead(workspaceId, lead.id);
      await b.done;
      expect(await e).toBe(true);
      // CONSTAT (PostgreSQL 18.6, Prisma 6.19.3, vérifié par ce scénario) : l'upsert de l'effacement a un `update` NON vide ; il ne collisionne pas ici (1 seule transaction, sans reprise),
      // contrairement à celui de la désinscription (`update: {}`), qui collisionne (2 transactions). Le test fixe donc le RÉSULTAT sous concurrence (1 ou 2 transactions selon le mode d'exécution de l'upsert) ;
      // la reprise sur P2002 de l'effacement, devenue une précaution, est couverte par tests/suppression-tx-retry.test.ts.
      expect([1, 2], `itération ${i} : nombre de transactions`).toContain(tx.n);
      vi.restoreAllMocks();
      const after = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect([after.name, after.email, after.phone]).toEqual(["Prospect effacé", null, null]); // données personnelles effacées
      expect(after.deletedAt).not.toBeNull();
      expect((await db.followUp.findFirstOrThrow({ where: { leadId: lead.id } })).status).toBe("cancelled");
      const rows = await db.emailSuppression.findMany({ where: { workspaceId } });
      expect(rows).toHaveLength(1); //                       entrée HMAC unique
      expect(rows[0]).toMatchObject({ email: hmacKey(workspaceId), reason: "erasure" }); // raison « erasure » conservée
      expect(await db.consent.count({ where: { workspaceId, email: X } })).toBe(0); //     l'adresse en clair n'existe plus nulle part
      expect(await isEmailSuppressed(db, workspaceId, X)).toBe(true);
    }
  }, 120_000);
});
