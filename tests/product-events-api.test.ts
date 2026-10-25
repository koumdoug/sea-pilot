import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { sha256 } from "@/lib/crypto";
import { addProspect, ensureDefaultProducts, optOutProspect } from "@/lib/portfolio/service";
import { POST } from "@/app/api/v1/product-events/route";
import { makeWorkspace, resetDb } from "./helpers";

beforeEach(resetDb);

async function setup(name = "Events") {
  const a = await makeWorkspace(name);
  await ensureDefaultProducts(a.workspaceId, a.userId);
  const key = `sp_${Math.random().toString(36).slice(2)}${Date.now()}`;
  await db.apiKey.create({ data: { workspaceId: a.workspaceId, name: "k", prefix: key.slice(0, 10), keyHash: sha256(key) } });
  const driver = await db.product.findFirstOrThrow({ where: { workspaceId: a.workspaceId, slug: "driverpilot" } });
  const { prospect } = await addProspect(a.workspaceId, { name: "Marie Roy", email: "marie@roy.ca", source: "Site public", collectedAt: new Date("2026-10-01"), legalBasis: "implied_published", productId: driver.id });
  return { ...a, key, driver, prospect };
}
const call = (key: string | null, body: unknown) =>
  POST(new Request("http://x/api/v1/product-events", { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) }));

describe("API des conversions (webhook prêt, non connecté)", () => {
  it("refuse sans clé, avec une clé invalide ou révoquée", async () => {
    const s = await setup();
    expect((await call(null, { product: "driverpilot", type: "signup", external_ref: "u1" })).status).toBe(401);
    expect((await call("sp_inconnue", { product: "driverpilot", type: "signup", external_ref: "u1" })).status).toBe(401);
    await db.apiKey.updateMany({ where: { keyHash: sha256(s.key) }, data: { revokedAt: new Date() } });
    expect((await call(s.key, { product: "driverpilot", type: "signup", external_ref: "u1" })).status).toBe(401);
  });

  it("enregistre une conversion rattachée au prospect retrouvé par courriel, par slug de produit", async () => {
    const s = await setup();
    const res = await call(s.key, { product: "driverpilot", type: "trial_started", email: "MARIE@roy.ca", external_ref: "usr_1" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ created: true, matchedProspect: true });
    const ev = await db.productEvent.findFirstOrThrow({ where: { workspaceId: s.workspaceId } });
    expect(ev).toMatchObject({ source: "webhook", productId: s.driver.id, prospectId: s.prospect.id, type: "trial_started" });
    expect((await db.prospect.findUniqueOrThrow({ where: { id: s.prospect.id } })).status).toBe("trial");
  });

  it("est idempotent : un rejeu ne compte jamais deux fois", async () => {
    const s = await setup();
    const payload = { product: s.driver.id, type: "payment_confirmed", email: "marie@roy.ca", amount: 9.99, currency: "CAD", external_ref: "inv_001" };
    expect((await call(s.key, payload)).status).toBe(201);
    const again = await call(s.key, { ...payload, occurred_at: "2027-01-01T00:00:00.000Z" });
    expect(again.status).toBe(200);
    expect((await again.json()).created).toBe(false);
    const rs = await Promise.all([call(s.key, payload), call(s.key, payload)]);
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(await db.productEvent.count({ where: { workspaceId: s.workspaceId } })).toBe(1);
  });

  it("accepte une conversion sans prospect connu si une référence externe la rend traçable", async () => {
    const s = await setup();
    const r = await call(s.key, { product: "driverpilot", type: "signup", email: "inconnu@x.ca", external_ref: "usr_42" });
    expect(r.status).toBe(201);
    expect((await r.json()).matchedProspect).toBe(false);
    expect((await call(s.key, { product: "driverpilot", type: "signup", email: "inconnu@x.ca" })).status).toBe(422); // ni prospect ni référence
  });

  it("valide le corps : paiement sans montant ou devise, type inconnu, produit introuvable", async () => {
    const s = await setup();
    expect((await call(s.key, { product: "driverpilot", type: "payment_confirmed", external_ref: "i1" })).status).toBe(422);
    expect((await call(s.key, { product: "driverpilot", type: "payment_confirmed", amount: 10, external_ref: "i2" })).status).toBe(422);
    expect((await call(s.key, { product: "driverpilot", type: "inconnu", external_ref: "i3" })).status).toBe(400);
    expect((await call(s.key, { product: "nexiste-pas", type: "signup", external_ref: "i4" })).status).toBe(404);
    expect(await db.productEvent.count({ where: { workspaceId: s.workspaceId } })).toBe(0);
  });

  it("isolation : une clé ne voit ni les produits ni les prospects d'un autre espace", async () => {
    const a = await setup("A");
    const b = await setup("B");
    expect((await call(a.key, { product: b.driver.id, type: "signup", external_ref: "x" })).status).toBe(404);
    expect((await call(a.key, { product: "driverpilot", type: "signup", prospect_id: b.prospect.id })).status).toBe(404);
    const r = await call(a.key, { product: "driverpilot", type: "signup", email: "marie@roy.ca", external_ref: "x" });
    expect(r.status).toBe(201);
    expect(await db.productEvent.count({ where: { workspaceId: b.workspaceId } })).toBe(0);
  });

  it("un prospect opposé garde son statut « ne pas contacter » ; la conversion est comptée", async () => {
    const s = await setup();
    await optOutProspect({ workspaceId: s.workspaceId, prospectId: s.prospect.id });
    expect((await call(s.key, { product: "driverpilot", type: "payment_confirmed", email: "marie@roy.ca", amount: 5, currency: "CAD", external_ref: "inv_9" })).status).toBe(201);
    expect((await db.prospect.findUniqueOrThrow({ where: { id: s.prospect.id } })).status).toBe("do_not_contact");
    expect(await db.productEvent.count({ where: { workspaceId: s.workspaceId } })).toBe(1);
  });
});
