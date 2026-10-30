import { afterAll, describe, expect, it } from "vitest";
import { customerIdempotencyKey, liveStripeGateway } from "@/lib/billing";

// Contrat de l'adaptateur Stripe RÉEL (`liveStripeGateway`) contre l'API Stripe en MODE TEST. Ignoré par défaut : il ne s'exécute que si un environnement de test isolé est fourni
// par l'opérateur (aucun secret n'est stocké dans le dépôt, aucune clé n'est jamais affichée) :
//   STRIPE_TEST_SECRET_KEY=sk_test_…   (jamais sk_live : refusé)
//   STRIPE_TEST_PRICE_ID=price_…       (un prix récurrent du compte de TEST, pour les sessions Checkout)
//   npx vitest run tests/stripe-test-mode.contract.test.ts
// Aucun paiement n'est effectué : les sessions Checkout sont créées puis expirées sans jamais être payées. Procédure complète : docs/validation-postgresql-stripe.md.

const key = process.env.STRIPE_TEST_SECRET_KEY ?? "";
const price = process.env.STRIPE_TEST_PRICE_ID ?? "";
if (key.startsWith("sk_live")) throw new Error("Refus : une clé de production (sk_live) ne doit JAMAIS être utilisée pour ces tests.");
const enabled = key.startsWith("sk_test_");

const created: string[] = [];
const stripeTest = async (method: string, path: string) => (await fetch(`https://api.stripe.com/v1${path}`, { method, headers: { authorization: `Bearer ${key}` } })).json();

describe.skipIf(!enabled)("adaptateur Stripe réel — mode test", () => {
  const prev = process.env.STRIPE_SECRET_KEY;
  const run = `contract-${Date.now()}`;
  let customer = "";

  it("création de client : idempotente pour les mêmes paramètres, nouveau client si l'adresse change (clé d'idempotence liée à l'e-mail)", async () => {
    process.env.STRIPE_SECRET_KEY = key;
    const a = await liveStripeGateway.createCustomer({ email: `${run}@example.test`, workspaceId: run });
    const b = await liveStripeGateway.createCustomer({ email: `${run}@example.test`, workspaceId: run });
    const c = await liveStripeGateway.createCustomer({ email: `${run}-autre@example.test`, workspaceId: run });
    created.push(a.id, c.id);
    customer = a.id;
    expect(b.id).toBe(a.id);
    expect(c.id).not.toBe(a.id);
    expect(customerIdempotencyKey(run, `${run}@example.test`)).not.toBe(customerIdempotencyKey(run, `${run}-autre@example.test`));
  });

  it("lecture : client sans abonnement → liste vide ; abonnement inconnu → null (404) ; session inconnue → null", async () => {
    expect(await liveStripeGateway.listCustomerSubscriptions(customer)).toEqual([]);
    expect(await liveStripeGateway.getSubscription("sub_inexistant_contract")).toBeNull();
    expect(await liveStripeGateway.getCheckoutSession("cs_test_inexistant_contract")).toBeNull();
  });

  it.skipIf(!price)("session Checkout : création (expires_at 40 min), idempotence, liste des sessions ouvertes, expiration ; jamais payée", async () => {
    const expires = String(Math.floor((Date.now() + 40 * 60_000) / 1000));
    const body = { mode: "subscription", customer, "line_items[0][price]": price, "line_items[0][quantity]": "1", success_url: "https://example.test/ok", cancel_url: "https://example.test/ko", expires_at: expires, client_reference_id: run, "metadata[workspaceId]": run };
    const s = await liveStripeGateway.createCheckoutSession(body, `checkout:${run}`);
    expect(s.id).toMatch(/^cs_test_/); expect(s.url).toMatch(/^https:\/\//);
    expect((await liveStripeGateway.createCheckoutSession(body, `checkout:${run}`)).id).toBe(s.id); // même clé : même session
    expect((await liveStripeGateway.getCheckoutSession(s.id))?.status).toBe("open");
    expect((await liveStripeGateway.listOpenCheckoutSessions(customer)).map((x) => x.id)).toContain(s.id);
    await liveStripeGateway.expireCheckoutSession(s.id);
    expect((await liveStripeGateway.getCheckoutSession(s.id))?.status).toBe("expired");
    expect((await liveStripeGateway.listOpenCheckoutSessions(customer)).map((x) => x.id)).not.toContain(s.id);
  });

  it.skipIf(!price)("expires_at trop proche (< 30 minutes) : Stripe refuse avec un message mentionnant expires_at (détecté par la gestion de dérive d'horloge)", async () => {
    const body = { mode: "subscription", customer, "line_items[0][price]": price, "line_items[0][quantity]": "1", success_url: "https://example.test/ok", cancel_url: "https://example.test/ko", expires_at: String(Math.floor((Date.now() + 20 * 60_000) / 1000)) };
    await expect(liveStripeGateway.createCheckoutSession(body, `checkout:${run}:court`)).rejects.toThrow(/expires_at/i);
  });

  afterAll(async () => {
    for (const id of created) await stripeTest("DELETE", `/customers/${id}`).catch(() => undefined); // nettoyage des objets de TEST créés par ce fichier
    if (prev === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = prev;
  });
});

describe("garde du fichier de contrat", () => {
  it("sans clé de test explicite, aucun appel n'est tenté (le fichier est ignoré)", () => {
    expect(enabled).toBe(key.startsWith("sk_test_"));
    if (!enabled) expect(key).toBe(process.env.STRIPE_TEST_SECRET_KEY ?? "");
  });
});
