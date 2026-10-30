import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { BillingError, checkoutExpiry, CHECKOUT_PENDING_LEASE_MS, CHECKOUT_RESERVATION_MARGIN_MS, CHECKOUT_SESSION_TTL_MS, createCheckoutSession, STRIPE_MIN_EXPIRY_MS } from "@/lib/billing";
import { fake } from "./stripe-fake";
import { makeWorkspace, resetDb } from "./helpers";

// V4 — prévention des doubles paiements AVANT la création d'une session : la réservation exclusive précède les vérifications chez Stripe (abonnements et sessions du client),
// donc deux serveurs ne peuvent ni vérifier ni créer en même temps. V5 — marge d'expiration et cohérence réservation locale / session distante.

const DAY = 86_400_000;
const sub = (workspaceId: string) => db.subscription.findUniqueOrThrow({ where: { workspaceId } });
const checkout = (workspaceId: string, plan = "growth") => createCheckoutSession({ workspaceId, plan, email: "a@b.c" }, fake);
const configureStripe = () => { process.env.STRIPE_SECRET_KEY = "sk_test_placeholder"; process.env.STRIPE_WEBHOOK_SECRET = "whsec_placeholder"; };
/** Espace qui a déjà un client Stripe (cus_1) : les contrôles chez Stripe s'appliquent. */
async function withCustomer(customer = "cus_1") {
  const w = await makeWorkspace();
  await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { stripeCustomerId: customer } });
  return w;
}

beforeEach(resetDb);
afterEach(() => { delete process.env.STRIPE_SECRET_KEY; delete process.env.STRIPE_WEBHOOK_SECRET; });

describe("V4 — la souscription est refusée tant qu'un abonnement ou une session payée existe chez Stripe", () => {
  it("webhook retardé APRÈS l'expiration de la réservation locale : la session payée est vue chez Stripe, aucune seconde session, l'état local est réparé", async () => {
    const { workspaceId } = await makeWorkspace(); configureStripe();
    await checkout(workspaceId); //                                         session cs_fake_1 ouverte
    const paidSub = fake.completeSession("cs_fake_1"); //                    le client paie ; le webhook n'est PAS livré
    await db.subscription.update({ where: { workspaceId }, data: { checkoutReservedUntil: new Date(Date.now() - 1000) } }); // la réservation locale a expiré
    await expect(checkout(workspaceId, "pro")).rejects.toThrow(/déjà actif chez Stripe/);
    expect(fake.sessionsCreated).toBe(1);
    expect(await sub(workspaceId)).toMatchObject({ status: "active", stripeSubscriptionId: paidSub, checkoutSessionId: null, checkoutReservedUntil: null });
  });

  it("session payée mais événement non encore reçu, réservation encore valide : refus explicite, aucune nouvelle session", async () => {
    const { workspaceId } = await makeWorkspace(); configureStripe();
    await checkout(workspaceId);
    fake.completeSession("cs_fake_1");
    await expect(checkout(workspaceId, "pro")).rejects.toThrow(/paiement vient d'être effectué/);
    expect(fake.sessionsCreated).toBe(1);
  });

  it("deux demandes Checkout simultanées (client déjà connu) : une seule session est créée chez Stripe", async () => {
    const { workspaceId } = await withCustomer(); configureStripe(); fake.lagMs = 15;
    const r = await Promise.allSettled([checkout(workspaceId), checkout(workspaceId), checkout(workspaceId)]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    for (const x of r.filter((x) => x.status === "rejected")) expect((x as PromiseRejectedResult).reason).toBeInstanceOf(BillingError);
    expect(fake.sessionsCreated).toBe(1);
  });

  it("deux clients Stripe concurrents sur un même espace : un seul client est créé", async () => {
    const { workspaceId } = await makeWorkspace(); configureStripe(); fake.lagMs = 15;
    await Promise.allSettled([checkout(workspaceId), checkout(workspaceId), checkout(workspaceId), checkout(workspaceId)]);
    expect(fake.customersCreated).toBe(1);
    expect((await sub(workspaceId)).stripeCustomerId).toBe("cus_fake_1");
  });

  it("deux abonnements déjà présents chez Stripe : refus, revue manuelle journalisée, aucune annulation ni remboursement automatique", async () => {
    const { workspaceId } = await withCustomer(); configureStripe();
    fake.set("sub_a", { status: "active" }); fake.set("sub_b", { status: "unpaid" });
    await expect(checkout(workspaceId)).rejects.toThrow(/Plusieurs abonnements/);
    expect(fake.sessionsCreated).toBe(0);
    expect(await db.auditLog.count({ where: { workspaceId, action: "billing.duplicate_subscription" } })).toBe(1);
    expect(fake.calls.some((c) => c.startsWith("expireCheckoutSession"))).toBe(false); // rien n'est annulé automatiquement
    expect(await sub(workspaceId)).toMatchObject({ checkoutReservationId: null, checkoutSessionId: null }); // récupérable : aucune réservation ne reste bloquée
  });

  it("un seul abonnement existant : message adapté au statut, état local réparé ; un abonnement terminé n'interdit pas une nouvelle souscription", async () => {
    configureStripe();
    const cases: [string, RegExp][] = [["active", /déjà actif chez Stripe/], ["trialing", /déjà actif chez Stripe/], ["past_due", /déjà actif chez Stripe/], ["unpaid", /régularisez-le/], ["paused", /régularisez-le/], ["incomplete", /en cours de confirmation/]];
    for (const [status, msg] of cases) {
      fake.reset();
      const { workspaceId } = await withCustomer();
      fake.set("sub_x", { status });
      await expect(checkout(workspaceId)).rejects.toThrow(msg);
      expect(fake.sessionsCreated).toBe(0);
      await db.subscription.deleteMany({ where: { workspaceId } }); await db.workspace.delete({ where: { id: workspaceId } });
    }
    fake.reset();
    const { workspaceId } = await withCustomer();
    fake.set("sub_old", { status: "canceled" });
    await expect(checkout(workspaceId)).resolves.toMatch(/checkout\.example/);
  });

  it("session expirée chez Stripe : la nouvelle souscription est possible, sans appel d'expiration inutile", async () => {
    const { workspaceId } = await withCustomer(); configureStripe();
    fake.sessions.set("cs_old", { status: "expired", url: "x", customer: "cus_1" });
    await expect(checkout(workspaceId)).resolves.toMatch(/checkout\.example/);
    expect(fake.expired).toEqual([]);
  });

  it("session ouverte inconnue de la base (autre onglet, session orpheline) : elle est expirée chez Stripe avant la nouvelle", async () => {
    const { workspaceId } = await withCustomer(); configureStripe();
    fake.sessions.set("cs_orphan", { status: "open", url: "x", customer: "cus_1" });
    await expect(checkout(workspaceId)).resolves.toMatch(/checkout\.example/);
    expect(fake.expired).toEqual(["cs_orphan"]);
  });

  it("interruption APRÈS la création chez Stripe (réponse perdue) : la session orpheline est expirée à la tentative suivante, qui n'est pas bloquée", async () => {
    const { workspaceId } = await makeWorkspace(); configureStripe();
    fake.throwAfterCreateOnce = true;
    await expect(checkout(workspaceId)).rejects.toThrow(/Connexion interrompue/);
    expect(fake.sessions.get("cs_fake_1")?.status).toBe("open"); // Stripe a bien créé la session, l'utilisateur n'a jamais reçu son URL
    expect(await sub(workspaceId)).toMatchObject({ checkoutReservationId: null });
    await expect(checkout(workspaceId)).resolves.toBe("https://checkout.example/cs_fake_2");
    expect(fake.expired).toEqual(["cs_fake_1"]);
  });

  it("reprise après EXPIRATION DU BAIL (serveur mort sans libérer) : bloqué tant que le bail court, repris ensuite, session orpheline expirée", async () => {
    const { workspaceId } = await withCustomer(); configureStripe();
    fake.sessions.set("cs_orphan", { status: "open", url: "x", customer: "cus_1" });
    await db.subscription.update({ where: { workspaceId }, data: { checkoutReservationId: "serveur_mort", checkoutReservedUntil: new Date(Date.now() + CHECKOUT_PENDING_LEASE_MS) } });
    await expect(checkout(workspaceId)).rejects.toThrow(/en cours de préparation/);
    await db.subscription.update({ where: { workspaceId }, data: { checkoutReservedUntil: new Date(Date.now() - 1) } }); // frontière : le bail vient d'expirer
    await expect(checkout(workspaceId)).resolves.toMatch(/checkout\.example/);
    expect(fake.expired).toEqual(["cs_orphan"]);
  });

  it("réservation reprise pendant la création : la session créée est expirée (jamais payable sans avoir été remise), la réservation de l'autre est intacte", async () => {
    const { workspaceId } = await withCustomer(); configureStripe();
    fake.afterCreate = async () => { await db.subscription.update({ where: { workspaceId }, data: { checkoutReservationId: "autre_demande" } }); };
    await expect(checkout(workspaceId)).rejects.toThrow(/avant d'aboutir/);
    expect(fake.expired).toEqual(["cs_fake_1"]);
    expect((await sub(workspaceId)).checkoutReservationId).toBe("autre_demande");
  });

  it("Stripe indisponible pendant les vérifications : refus, aucune session, réservation libérée (jamais de souscription à l'aveugle)", async () => {
    const { workspaceId } = await withCustomer(); configureStripe(); fake.unavailable = true;
    await expect(checkout(workspaceId)).rejects.toThrow(/Vérification de votre abonnement impossible/);
    expect(fake.sessionsCreated).toBe(0);
    expect(await sub(workspaceId)).toMatchObject({ checkoutReservationId: null, checkoutSessionId: null });
  });
});

describe("V5 — marge d'expiration et cohérence réservation locale / session Stripe", () => {
  it("constantes : 40 min de session (10 min de marge sur le minimum imposé par Stripe), réservation locale 5 min au-delà, bail d'avant-création plus long qu'une chaîne d'appels Stripe", () => {
    expect(STRIPE_MIN_EXPIRY_MS).toBe(30 * 60_000);
    expect(CHECKOUT_SESSION_TTL_MS).toBeGreaterThanOrEqual(35 * 60_000);
    expect(CHECKOUT_SESSION_TTL_MS).toBeLessThanOrEqual(45 * 60_000);
    expect(CHECKOUT_SESSION_TTL_MS - STRIPE_MIN_EXPIRY_MS).toBeGreaterThanOrEqual(10 * 60_000);
    expect(CHECKOUT_RESERVATION_MARGIN_MS).toBeGreaterThanOrEqual(5 * 60_000);
    expect(CHECKOUT_PENDING_LEASE_MS).toBeGreaterThanOrEqual(4 * 25_000 + 60_000); // au moins quatre appels Stripe au délai maximal + marge
    const e = checkoutExpiry(1_000_000);
    expect([e.expiresAt - 1_000_000, e.reservedUntil - e.expiresAt]).toEqual([CHECKOUT_SESSION_TTL_MS, CHECKOUT_RESERVATION_MARGIN_MS]);
  });

  it("la réservation locale survit à l'expiration de la session distante (jamais éteinte avant elle)", async () => {
    const { workspaceId } = await makeWorkspace(); configureStripe();
    await checkout(workspaceId);
    const s = await sub(workspaceId), remote = fake.sessions.get("cs_fake_1")!;
    expect(s.checkoutReservedUntil!.getTime()).toBeGreaterThanOrEqual(remote.expiresAt! + 5 * 60_000 - 1000);
  });

  it("dérive d'horloge : tolérée jusqu'à 10 minutes (Stripe en avance), refusée au-delà avec un message clair et sans réservation bloquante", async () => {
    const { workspaceId } = await makeWorkspace(); configureStripe();
    fake.stripeClockDriftMs = 9.5 * 60_000; // frontière basse : acceptée
    await expect(checkout(workspaceId)).resolves.toMatch(/checkout\.example/);
    const w2 = await makeWorkspace();
    fake.stripeClockDriftMs = 10.5 * 60_000; // frontière haute : refusée par Stripe
    await expect(checkout(w2.workspaceId)).rejects.toThrow(/décalée de plus de 10 minutes/);
    expect(await sub(w2.workspaceId)).toMatchObject({ checkoutReservationId: null, checkoutSessionId: null });
    fake.stripeClockDriftMs = 0; // l'horloge est corrigée : l'espace n'est pas bloqué
    await expect(checkout(w2.workspaceId)).resolves.toMatch(/checkout\.example/);
  });

  it("expiration anticipée côté Stripe (sans événement reçu) : la tentative suivante reprend directement, sans appel d'expiration", async () => {
    const { workspaceId } = await makeWorkspace(); configureStripe();
    await checkout(workspaceId);
    fake.sessions.get("cs_fake_1")!.status = "expired"; // Stripe l'a expirée avant l'heure prévue ; le webhook n'est pas arrivé
    await expect(checkout(workspaceId, "pro")).resolves.toBe("https://checkout.example/cs_fake_2");
    expect(fake.expired).toEqual([]);
  });

  it("frontières temporelles de la réservation : active jusqu'à reservedUntil (refus), reprenable à la milliseconde suivante", async () => {
    const { workspaceId } = await makeWorkspace(); configureStripe();
    await db.subscription.update({ where: { workspaceId }, data: { checkoutReservationId: "x", checkoutReservedUntil: new Date(Date.now() + 60 * 1000) } });
    await expect(checkout(workspaceId)).rejects.toThrow(/en cours de préparation/);
    await db.subscription.update({ where: { workspaceId }, data: { checkoutReservedUntil: new Date(Date.now() - 1) } });
    await expect(checkout(workspaceId)).resolves.toMatch(/checkout\.example/);
    expect(DAY).toBeGreaterThan(CHECKOUT_SESSION_TTL_MS); // la session reste très en deçà du maximum de 24 h imposé par Stripe
  });
});
