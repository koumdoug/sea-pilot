import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { reconcileSubscription, SyncBusyError } from "@/lib/billing";
import { entitlement } from "@/lib/plans";
import { fake } from "./stripe-fake";
import { makeWorkspace, resetDb } from "./helpers";

// V2 — ordre des lectures et des écritures de synchronisation. Ici, de VRAIES courses : les lectures Stripe sont suspendues (barrières de promesses) après avoir
// capturé un état, d'autres synchronisations s'exécutent pendant la suspension, puis la lecture ancienne reprend et tente d'écrire. Aucune estampille fabriquée.
// Limite assumée : un seul processus Node (les « serveurs » sont des appels concurrents sur la même base). La course entre PROCESSUS est à valider sur PostgreSQL
// (docs/validation-postgresql-stripe.md).

const DAY = 86_400_000;
const inDays = (n: number) => Math.floor((Date.now() + n * DAY) / 1000);
const sub = (workspaceId: string) => db.subscription.findUniqueOrThrow({ where: { workspaceId } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Espace payé et synchronisé : base « actif », Stripe « actif » (forfait Growth, sub_1). */
async function paidWorkspace() {
  const w = await makeWorkspace();
  await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { plan: "growth", status: "active", stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1", currentPeriodEnd: new Date(Date.now() + 20 * DAY), stripeSyncedAt: new Date(Date.now() - 2 * DAY) } });
  fake.set("sub_1", { status: "active", current_period_end: inDays(20) });
  return w;
}

beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

describe("V2 — lectures et écritures strictement ordonnées par un bail (jeton de clôture)", () => {
  it("scénario contrôlé : A lit un état ancien et reste suspendue, B lit l'état récent et écrit, A reprend : l'état de B reste intact", async () => {
    const { workspaceId } = await paidWorkspace();
    const hold = fake.holdNextRead();
    const a = reconcileSubscription(workspaceId, fake); // 1-2. A démarre, capture « actif » chez Stripe, reste suspendue
    await hold.entered;
    fake.set("sub_1", { status: "canceled" }); //             Stripe change d'état pendant la suspension de A
    // A est suspendue au-delà de son bail (processus gelé, très lent) : le bail expire et peut être repris.
    await db.subscription.update({ where: { workspaceId }, data: { stripeSyncLeaseUntil: new Date(Date.now() - 1000) } });
    const rb = await reconcileSubscription(workspaceId, fake); // 4-6. B démarre, lit « canceled », écrit
    expect(rb?.outcome).toBe("handled");
    expect((await sub(workspaceId)).status).toBe("canceled");
    hold.release(); //                                          7. A reprend avec son état ancien (« actif ») et tente d'écrire
    const ra = await a;
    expect(ra?.outcome).toBe("ignored"); //                      A a perdu son bail : rien n'est écrit
    expect(ra?.note).toMatch(/bail/);
    const s = await sub(workspaceId); //                         8. l'état de B est intact
    expect(s.status).toBe("canceled");
    expect(entitlement(s).active).toBe(false);
    expect(s.stripeSyncLeaseId).toBeNull(); // B a libéré son bail ; celui de A n'a rien laissé
  });

  it("sans expiration du bail : B ATTEND A (aucun chevauchement) ; B lit donc après la fin de A, et l'état final est le plus récent", async () => {
    const { workspaceId } = await paidWorkspace();
    const hold = fake.holdNextRead();
    const a = reconcileSubscription(workspaceId, fake);
    await hold.entered; //                                       A a capturé « actif », elle est suspendue en tenant le bail
    fake.set("sub_1", { status: "canceled" });
    const b = reconcileSubscription(workspaceId, fake, { waitMs: 10_000 });
    await sleep(350); //                                          B tente d'obtenir le bail pendant qu'A le détient
    expect(fake.calls.filter((c) => c.startsWith("getSubscription"))).toHaveLength(1); // B n'a PAS encore lu Stripe
    hold.release();
    await a; await b;
    expect(fake.calls.filter((c) => c.startsWith("getSubscription"))).toHaveLength(2);
    expect((await sub(workspaceId)).status).toBe("canceled"); // A a écrit « actif » (sa lecture), puis B a écrit « canceled » (lecture postérieure)
    expect(fake.maxConcurrentReads).toBe(1);
  });

  it("bail détenu et non expiré : une autre synchronisation échoue proprement (SyncBusyError), rien n'est modifié", async () => {
    const { workspaceId } = await paidWorkspace();
    const hold = fake.holdNextRead();
    const a = reconcileSubscription(workspaceId, fake);
    await hold.entered;
    fake.set("sub_1", { status: "canceled" });
    await expect(reconcileSubscription(workspaceId, fake, { waitMs: 250 })).rejects.toBeInstanceOf(SyncBusyError);
    expect((await sub(workspaceId)).status).toBe("active");
    hold.release(); await a;
  });

  it("deux « serveurs » et plus : six synchronisations simultanées, jamais deux lectures en même temps, état final = Stripe", async () => {
    const { workspaceId } = await paidWorkspace();
    fake.lagMs = 15; fake.set("sub_1", { status: "past_due" });
    const r = await Promise.all(Array.from({ length: 6 }, () => reconcileSubscription(workspaceId, fake, { waitMs: 10_000 })));
    expect(r.filter((x) => x?.outcome === "handled")).toHaveLength(1); // la première applique le changement, les suivantes constatent qu'il est déjà appliqué
    expect(fake.maxConcurrentReads).toBe(1);
    expect((await sub(workspaceId)).status).toBe("past_due");
  });

  it("erreur réseau pendant la lecture : état inchangé, bail libéré, synchronisation suivante normale", async () => {
    const { workspaceId } = await paidWorkspace();
    fake.set("sub_1", { status: "canceled" });
    fake.failNext("getSubscription");
    await expect(reconcileSubscription(workspaceId, fake)).rejects.toThrow(/réseau/);
    const s = await sub(workspaceId);
    expect([s.status, s.stripeSyncLeaseId, s.stripeSyncLeaseUntil]).toEqual(["active", null, null]);
    expect((await reconcileSubscription(workspaceId, fake))?.outcome).toBe("handled");
    expect((await sub(workspaceId)).status).toBe("canceled");
  });

  it("interruption avant l'écriture (base indisponible à l'écriture) : rien n'est écrit, bail libéré, reprise possible", async () => {
    const { workspaceId } = await paidWorkspace();
    fake.set("sub_1", { status: "canceled" });
    const orig = db.subscription.updateMany.bind(db.subscription);
    let failed = false;
    vi.spyOn(db.subscription, "updateMany").mockImplementation((async (args: { where?: { updatedAt?: unknown } }) => {
      if (!failed && args?.where?.updatedAt) { failed = true; throw new Error("base interrompue avant l'écriture"); }
      return orig(args as never);
    }) as never);
    await expect(reconcileSubscription(workspaceId, fake)).rejects.toThrow(/interrompue/);
    const s = await sub(workspaceId);
    expect([s.status, s.stripeSyncLeaseId]).toEqual(["active", null]);
    expect((await reconcileSubscription(workspaceId, fake))?.outcome).toBe("handled"); // reprise
    expect((await sub(workspaceId)).status).toBe("canceled");
  });

  it("bail repris dans la fenêtre entre la vérification et l'écriture : le jeton de clôture de l'écriture empêche l'écrasement", async () => {
    const { workspaceId } = await paidWorkspace();
    fake.set("sub_1", { status: "canceled" });
    const orig = db.subscription.updateMany.bind(db.subscription);
    let stolen = false;
    vi.spyOn(db.subscription, "updateMany").mockImplementation((async (args: { where?: { updatedAt?: unknown } }) => {
      // Un autre serveur reprend le bail juste avant l'écriture (SQL direct : la version `updatedAt` n'est pas modifiée, seul le jeton de clôture protège).
      if (!stolen && args?.where?.updatedAt) { stolen = true; await db.$executeRaw`UPDATE "Subscription" SET "stripeSyncLeaseId" = 'autre_serveur' WHERE "workspaceId" = ${workspaceId}`; }
      return orig(args as never);
    }) as never);
    const r = await reconcileSubscription(workspaceId, fake);
    expect(stolen).toBe(true);
    expect(r?.outcome).toBe("ignored");
    expect((await sub(workspaceId)).status).toBe("active"); // rien n'a été écrit par le détenteur dépossédé
  });

  it("reprise après interruption : un bail laissé par un processus mort (échu) n'empêche pas la synchronisation suivante ; non échu, il l'empêche", async () => {
    const { workspaceId } = await paidWorkspace();
    fake.set("sub_1", { status: "canceled" });
    await db.subscription.update({ where: { workspaceId }, data: { stripeSyncLeaseId: "processus_mort", stripeSyncLeaseUntil: new Date(Date.now() + 60_000) } });
    await expect(reconcileSubscription(workspaceId, fake, { waitMs: 150 })).rejects.toBeInstanceOf(SyncBusyError);
    await db.subscription.update({ where: { workspaceId }, data: { stripeSyncLeaseUntil: new Date(Date.now() - 1000) } });
    expect((await reconcileSubscription(workspaceId, fake))?.outcome).toBe("handled");
    expect((await sub(workspaceId)).status).toBe("canceled");
  });
});

describe("V8 — modification locale concurrente : jamais écrasée par un instantané ancien", () => {
  async function trialLinked() {
    const w = await makeWorkspace();
    await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1" } });
    fake.set("sub_1", { status: "incomplete" }); // paiement non abouti : le forfait local n'est pas touché par la synchronisation
    return w;
  }

  it("modification locale ENTRE la relecture et l'écriture : l'écriture conditionnelle échoue, l'état est relu et recalculé (forfait d'essai choisi conservé)", async () => {
    const { workspaceId } = await trialLinked();
    const orig = db.subscription.updateMany.bind(db.subscription);
    let bumped = false;
    vi.spyOn(db.subscription, "updateMany").mockImplementation((async (args: { where?: { updatedAt?: unknown } }) => {
      if (!bumped && args?.where?.updatedAt) { bumped = true; await db.subscription.update({ where: { workspaceId }, data: { plan: "growth" } }); } // l'utilisateur change son forfait d'essai
      return orig(args as never);
    }) as never);
    await reconcileSubscription(workspaceId, fake);
    expect(bumped).toBe(true);
    expect((await sub(workspaceId)).plan).toBe("growth"); // avec un instantané ancien, le forfait aurait été remis à « starter »
  });

  it("modification locale PENDANT la suspension de la lecture Stripe : l'écriture part de l'état local courant", async () => {
    const { workspaceId } = await trialLinked();
    const hold = fake.holdNextRead();
    const a = reconcileSubscription(workspaceId, fake);
    await hold.entered;
    await db.subscription.update({ where: { workspaceId }, data: { plan: "pro" } });
    hold.release(); await a;
    expect(await sub(workspaceId)).toMatchObject({ plan: "pro", status: "trialing" });
  });
});
