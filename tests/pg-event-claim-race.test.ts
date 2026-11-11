import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { EVENT_LEASE_MS, claimStripeEvent, completeStripeEvent, type EventClaim } from "@/lib/stripe-events";

// T4 — PG-ONLY : réclamation et finalisation du registre d'événements sous VRAIE concurrence (plusieurs connexions serveur). Ignoré sous SQLite (une seule connexion : il ne prouverait rien).
// Garde : refuse de s'exécuter si l'hôte de DATABASE_URL n'est ni 127.0.0.1 ni localhost (la suite supprime des lignes StripeEvent).
const isPg = /^postgres(ql)?:\/\//.test(process.env.DATABASE_URL ?? "");
if (isPg) {
  const host = new URL(process.env.DATABASE_URL as string).hostname;
  if (!["127.0.0.1", "localhost"].includes(host)) throw new Error(`Test PostgreSQL interrompu : l'hôte « ${host} » n'est ni 127.0.0.1 ni localhost.`);
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const other = isPg ? new PrismaClient() : null; //   second client Prisma : autre pool, autres connexions serveur
const watcher = isPg ? new PrismaClient() : null; // observe pg_stat_activity
const expire = (id: string) => db.stripeEvent.update({ where: { id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
const claimed = (r: EventClaim[]) => r.filter((x) => x.kind === "claimed").length;
const winner = (r: EventClaim[]) => (r.find((x) => x.kind === "claimed") as { leaseToken: string } | undefined)?.leaseToken;

describe.skipIf(!isPg)("PostgreSQL — registre d'événements Stripe sous concurrence réelle", () => {
  beforeEach(async () => { await db.stripeEvent.deleteMany(); });
  afterAll(async () => { await other?.$disconnect(); await watcher?.$disconnect(); });

  it("S1 : 2 réclamations simultanées d'un événement neuf, 100 fois : un seul gagnant, jeton enregistré = jeton du gagnant", async () => {
    for (let i = 0; i < 100; i++) {
      const id = `evt_s1_${i}`;
      const r = await Promise.all([claimStripeEvent(id, "invoice.paid"), claimStripeEvent(id, "invoice.paid")]);
      const row = await db.stripeEvent.findUniqueOrThrow({ where: { id } });
      expect([claimed(r), r.length - claimed(r), row.attempts, row.leaseToken], `itération ${i}`).toEqual([1, 1, 1, winner(r)]);
    }
  }, 120_000);

  it("S2 : 2 reprises simultanées d'un bail expiré, 100 fois : un seul gagnant, tentative +1, jeton remplacé", async () => {
    for (let i = 0; i < 100; i++) {
      const id = `evt_s2_${i}`;
      const first = await claimStripeEvent(id, "invoice.paid"); await expire(id);
      const r = await Promise.all([claimStripeEvent(id, "invoice.paid"), claimStripeEvent(id, "invoice.paid")]);
      const row = await db.stripeEvent.findUniqueOrThrow({ where: { id } });
      expect([claimed(r), row.attempts, row.status, row.leaseToken], `itération ${i}`).toEqual([1, 2, "processing", winner(r)]);
      expect(row.leaseToken).not.toBe((first as { leaseToken: string }).leaseToken);
    }
  }, 120_000);

  it("S3 : 12 reprises simultanées d'un bail expiré, 30 fois : un seul gagnant", async () => {
    for (let i = 0; i < 30; i++) {
      const id = `evt_s3_${i}`;
      await claimStripeEvent(id, "invoice.paid"); await expire(id);
      const r = await Promise.all(Array.from({ length: 12 }, () => claimStripeEvent(id, "invoice.paid")));
      const row = await db.stripeEvent.findUniqueOrThrow({ where: { id } });
      expect([claimed(r), row.attempts, row.leaseToken], `itération ${i}`).toEqual([1, 2, winner(r)]);
    }
  }, 120_000);

  it("S5 : 2 reprises simultanées d'un événement failed, 50 fois : un seul gagnant", async () => {
    for (let i = 0; i < 50; i++) {
      const id = `evt_s5_${i}`;
      await claimStripeEvent(id, "invoice.paid");
      await db.stripeEvent.update({ where: { id }, data: { status: "failed", lockedUntil: null, leaseToken: null } });
      const r = await Promise.all([claimStripeEvent(id, "invoice.paid"), claimStripeEvent(id, "invoice.paid")]);
      const row = await db.stripeEvent.findUniqueOrThrow({ where: { id } });
      expect([claimed(r), row.attempts, row.leaseToken], `itération ${i}`).toEqual([1, 2, winner(r)]);
    }
  }, 120_000);

  it("S4 : B tient un verrou de ligne non validé (reprise du bail) ; A (claimStripeEvent) attend sur le verrou puis constate le doublon, 20 fois", async () => {
    const pid = async (c: PrismaClient) => (await c.$queryRaw<{ pid: number }[]>`select pg_backend_pid() as pid`)[0].pid;
    expect(new Set([await pid(db as unknown as PrismaClient), await pid(other!), await pid(watcher!)]).size, "trois connexions serveur distinctes").toBe(3);
    for (let i = 0; i < 20; i++) {
      const id = `evt_s4_${i}`, bToken = `jeton-B-${i}`;
      await claimStripeEvent(id, "invoice.paid"); await expire(id);
      let locked!: () => void; const wasLocked = new Promise<void>((r) => (locked = r));
      const b = other!.$transaction(async (t) => { //  même condition de reprise que le code, pour tenir le verrou de ligne sans valider
        const now = new Date();
        const u = await t.stripeEvent.updateMany({ where: { id, status: "processing", lockedUntil: { lt: now } }, data: { lockedUntil: new Date(now.getTime() + EVENT_LEASE_MS), leaseToken: bToken, attempts: { increment: 1 } } });
        if (u.count !== 1) throw new Error("B n'a pas obtenu la reprise");
        locked(); await sleep(400);
      }, { timeout: 30_000 });
      await wasLocked;
      const a = claimStripeEvent(id, "invoice.paid");
      await sleep(150);
      const waiting = await watcher!.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and state = 'active'`;
      expect(Number(waiting[0].n), `itération ${i} : A doit attendre sur un verrou`).toBeGreaterThanOrEqual(1);
      await b;
      const ra = await a;
      const row = await db.stripeEvent.findUniqueOrThrow({ where: { id } });
      expect([ra.kind, row.leaseToken, row.attempts, row.status], `itération ${i}`).toEqual(["duplicate", bToken, 2, "processing"]);
    }
  }, 120_000);

  it("S6 : finalisation avec l'ancien jeton rejetée, finalisation avec le nouveau écrite, 30 fois, en même temps", async () => {
    for (let i = 0; i < 30; i++) {
      const id = `evt_s6_${i}`;
      const a = await claimStripeEvent(id, "invoice.paid"); await expire(id);
      const b = await claimStripeEvent(id, "invoice.paid");
      if (a.kind !== "claimed" || b.kind !== "claimed") throw new Error("prise en charge attendue");
      const [ra, rb] = await Promise.allSettled([
        completeStripeEvent(id, a.leaseToken, { outcome: "ignored", workspaceId: null, note: "A" }),
        completeStripeEvent(id, b.leaseToken, { outcome: "handled", workspaceId: null, note: "B" }),
      ]);
      const row = await db.stripeEvent.findUniqueOrThrow({ where: { id } });
      expect([ra.status, rb.status, row.note, row.outcome, row.leaseToken], `itération ${i}`).toEqual(["rejected", "fulfilled", "B", "handled", null]);
    }
  }, 120_000);
});
