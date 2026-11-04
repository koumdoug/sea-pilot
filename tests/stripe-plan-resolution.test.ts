import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { handleStripeEvent, setStripeGateway, type StripeEvent } from "@/lib/billing";
import { entitlement } from "@/lib/plans";
import { fake } from "./stripe-fake";
import { makeWorkspace, resetDb } from "./helpers";

// T1 : `past_due` sans fin de période. T2 : prix Stripe inconnu. Stripe est simulé en mémoire (tests/stripe-fake.ts) : aucun appel réseau, aucun paiement.

const DAY = 86_400_000;
const inDays = (n: number) => Math.floor((Date.now() + n * DAY) / 1000);
let seq = 0;
const event = (type: string, object: Record<string, unknown>): StripeEvent => ({ id: `evt_plan_${++seq}_${Math.random().toString(36).slice(2, 7)}`, type, data: { object } });
const subPayload = (workspaceId: string, over: Record<string, unknown> = {}) => ({ id: "sub_1", customer: "cus_1", status: "active", metadata: { workspaceId, plan: "growth" }, items: { data: [{ price: { id: "price_growth_test" } }] }, current_period_end: inDays(30), ...over });
const sub = (workspaceId: string) => db.subscription.findUniqueOrThrow({ where: { workspaceId } });
async function setup() {
  const w = await makeWorkspace();
  await db.subscription.update({ where: { workspaceId: w.workspaceId }, data: { stripeCustomerId: "cus_1" } });
  return w;
}
/** Livre l'événement `updated` ; Stripe détient `remote` (c'est lui qui fait foi) ; retourne l'issue consignée au registre. */
async function deliver(workspaceId: string, remote: Parameters<typeof fake.set>[1], payload: Record<string, unknown> = {}) {
  fake.set("sub_1", remote);
  const ev = event("customer.subscription.updated", subPayload(workspaceId, payload));
  await handleStripeEvent(ev, fake);
  return db.stripeEvent.findUniqueOrThrow({ where: { id: ev.id } });
}

beforeEach(resetDb);
afterEach(() => { vi.restoreAllMocks(); setStripeGateway(null); });

describe("T1 — past_due : la grâce est datée par la fin de période, jamais renouvelée à chaque appel", () => {
  const base = { plan: "growth", trialEndsAt: null, cancelAtPeriodEnd: false };
  const end = new Date("2026-03-10T12:00:00Z");

  it("avec fin de période : accès pendant 7 jours après cette date, puis suspendu (délai normal inchangé)", () => {
    const s = { ...base, status: "past_due", currentPeriodEnd: end };
    expect(entitlement(s, new Date(end.getTime() - DAY)).active).toBe(true); //            avant la fin de période
    expect(entitlement(s, new Date(end.getTime() + 6 * DAY)).active).toBe(true); //        6 jours après
    expect(entitlement(s, new Date(end.getTime() + 7 * DAY - 1)).active).toBe(true); //    juste avant la limite
    expect(entitlement(s, new Date(end.getTime() + 7 * DAY))).toMatchObject({ active: false, state: "past_due", daysLeft: 0 }); // la limite exacte : suspendu
    expect(entitlement(s, new Date(end.getTime() + 30 * DAY)).active).toBe(false);
  });

  it("sans fin de période : accès suspendu, à tout instant — pas de grâce glissante qui s'étend à chaque appel", () => {
    const s = { ...base, status: "past_due", currentPeriodEnd: null };
    const t0 = new Date("2026-03-10T12:00:00Z").getTime();
    for (const offset of [0, 1, 12 * 3_600_000, DAY - 1, DAY, 8 * DAY, 400 * DAY]) {
      expect(entitlement(s, new Date(t0 + offset)), `décalage ${offset} ms`).toMatchObject({ active: false, state: "past_due", daysLeft: 0 });
    }
  });

  it("sans fin de période, la raison affichée est explicite et l'abonnement reste identifiable (géré, non annulé)", () => {
    const r = entitlement({ ...base, status: "past_due", currentPeriodEnd: null });
    expect(r.state).toBe("past_due");
    expect(r.reason).toMatch(/accès suspendu/i);
  });
});

describe("T2 — prix Stripe : le forfait ne vient que d'un prix reconnu", () => {
  it("prix reconnu : forfait attribué d'après le prix (starter), même si les métadonnées disent autre chose", async () => {
    const { workspaceId } = await setup();
    const ledger = await deliver(workspaceId, { status: "active", items: { data: [{ price: { id: "price_starter_test" } }] }, metadata: { plan: "pro" } });
    expect(await sub(workspaceId)).toMatchObject({ status: "active", plan: "starter", stripeSubscriptionId: "sub_1" });
    expect(ledger.outcome).toBe("handled");
  });

  it("prix reconnu (growth) : comportement inchangé", async () => {
    const { workspaceId } = await setup();
    await deliver(workspaceId, { status: "active" });
    expect(await sub(workspaceId)).toMatchObject({ status: "active", plan: "growth", stripeSubscriptionId: "sub_1" });
  });

  it("prix inconnu, métadonnées `plan: pro` : aucun forfait attribué, état local intact, revue demandée", async () => {
    const { workspaceId } = await setup();
    const before = await sub(workspaceId);
    const ledger = await deliver(workspaceId, { status: "active", items: { data: [{ price: { id: "price_inconnu" } }] }, metadata: { plan: "pro" } }, { metadata: { workspaceId, plan: "pro" } });
    const after = await sub(workspaceId);
    expect(ledger.outcome).toBe("needs_review");
    expect(ledger.note).toMatch(/non reconnu/i);
    expect([after.plan, after.status, after.stripeSubscriptionId, after.currentPeriodEnd]).toEqual([before.plan, before.status, before.stripeSubscriptionId, before.currentPeriodEnd]);
    expect(entitlement(after).state).not.toBe("paid");
    expect(await db.auditLog.count({ where: { workspaceId, action: "billing.unknown_price" } })).toBe(1);
  });

  it("prix inconnu : un abonnement payant en place n'est pas remplacé ni dégradé", async () => {
    const { workspaceId } = await setup();
    await deliver(workspaceId, { status: "active" }); //                                              abonnement growth payé
    const paid = await sub(workspaceId);
    const ledger = await deliver(workspaceId, { status: "active", items: { data: [{ price: { id: "price_inconnu" } }] }, metadata: { plan: "pro" } });
    const after = await sub(workspaceId);
    expect(ledger.outcome).toBe("needs_review");
    expect([after.plan, after.status, after.currentPeriodEnd]).toEqual([paid.plan, paid.status, paid.currentPeriodEnd]);
    expect(entitlement(after).active).toBe(true);
    expect(entitlement(after).plan?.id).toBe("growth");
  });

  it("prix absent (aucune ligne) : même traitement, aucun repli sur le forfait local", async () => {
    const { workspaceId } = await setup();
    await db.subscription.update({ where: { workspaceId }, data: { plan: "pro" } }); //               forfait local : pro
    const ledger = await deliver(workspaceId, { status: "active", items: { data: [] }, metadata: {} });
    const after = await sub(workspaceId);
    expect(ledger.outcome).toBe("needs_review");
    expect(after.plan).toBe("pro"); //                                                                inchangé, pas « attribué » : aucun statut payé n'est enregistré
    expect(after.status).not.toBe("active");
  });

  it("prix inconnu : la lecture est enregistrée (stripeSyncedAt) pour que la réconciliation ne la relise pas à chaque passage", async () => {
    const { workspaceId } = await setup();
    await db.subscription.update({ where: { workspaceId }, data: { stripeSyncedAt: null } });
    await deliver(workspaceId, { status: "active", items: { data: [{ price: { id: "price_inconnu" } }] } });
    expect((await sub(workspaceId)).stripeSyncedAt).not.toBeNull();
  });

  it("prix inconnu mais statut non payant (résilié) : appliqué normalement, la résiliation n'est jamais bloquée", async () => {
    const { workspaceId } = await setup();
    await deliver(workspaceId, { status: "active" });
    const ledger = await deliver(workspaceId, { status: "canceled", items: { data: [{ price: { id: "price_inconnu" } }] } });
    expect(ledger.outcome).toBe("handled");
    expect(entitlement(await sub(workspaceId))).toMatchObject({ active: false, state: "canceled" });
  });
});
