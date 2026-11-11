import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { claimStripeEvent, purgeStripeEvents } from "@/lib/stripe-events";

// T5 — PG-ONLY : purge et réclamation simultanées. Invariant : un événement `processing` n'est jamais supprimé. Ignoré sous SQLite (une seule connexion).
// Garde : refuse de s'exécuter si l'hôte de DATABASE_URL n'est ni 127.0.0.1 ni localhost.
const isPg = /^postgres(ql)?:\/\//.test(process.env.DATABASE_URL ?? "");
if (isPg) {
  const host = new URL(process.env.DATABASE_URL as string).hostname;
  if (!["127.0.0.1", "localhost"].includes(host)) throw new Error(`Test PostgreSQL interrompu : l'hôte « ${host} » n'est ni 127.0.0.1 ni localhost.`);
}
const DAY = 86_400_000;
const age = (id: string, days: number) => db.stripeEvent.update({ where: { id }, data: { updatedAt: new Date(Date.now() - days * DAY) } });

describe.skipIf(!isPg)("PostgreSQL — purge contre reprise d'un même événement", () => {
  beforeEach(async () => { await db.stripeEvent.deleteMany(); });

  it("processing au bail expiré, très ancien : 50 × (purge ‖ reprise) : jamais supprimé, repris une fois", async () => {
    for (let i = 0; i < 50; i++) {
      const id = `evt_pp_${i}`;
      await claimStripeEvent(id, "invoice.paid");
      await db.stripeEvent.update({ where: { id }, data: { lockedUntil: new Date(Date.now() - 1000), processedAt: new Date(Date.now() - 400 * DAY) } });
      await age(id, 400);
      const [, r] = await Promise.all([purgeStripeEvents(new Date(Date.now() + 1000 * DAY)), claimStripeEvent(id, "invoice.paid")]);
      const row = await db.stripeEvent.findUnique({ where: { id } });
      expect([r.kind, row?.status, row?.attempts], `itération ${i}`).toEqual(["claimed", "processing", 2]);
    }
  }, 120_000);
});
