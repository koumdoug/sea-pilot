import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { billingNeedsReview, verifyStripeSignature } from "@/lib/billing";
import { purgeStripeEvents } from "@/lib/stripe-events";
import { makeWorkspace, resetDb } from "./helpers";

// Lacunes des tests secondaires Stripe. Valeurs attendues : cahier des charges de la mission et docs/stripe-hardening.md (V9 : « processed 90 j, failed 180 j, jamais processing »).
// La doc ne dit rien de la tolérance de signature : 299 s accepté / 301 s refusé vient du cahier des charges (écart de documentation à signaler).
const DAY = 86_400_000;
beforeEach(resetDb);

describe("T1 — isolation de l'alerte de revue manuelle entre espaces", () => {
  it("un événement needs_review de l'espace B ne compte pas pour l'espace A", async () => {
    const a = await makeWorkspace("A"), b = await makeWorkspace("B");
    expect(await billingNeedsReview(a.workspaceId)).toBe(false);
    await db.stripeEvent.create({ data: { id: "evt_iso_b", type: "customer.subscription.updated", status: "processed", outcome: "needs_review", workspaceId: b.workspaceId, processedAt: new Date() } });
    expect(await billingNeedsReview(a.workspaceId)).toBe(false);
    expect(await billingNeedsReview(b.workspaceId)).toBe(true);
  });
  it("symétrique : un événement de A n'ouvre l'alerte que pour A", async () => {
    const a = await makeWorkspace("A"), b = await makeWorkspace("B");
    await db.stripeEvent.create({ data: { id: "evt_iso_a", type: "customer.subscription.updated", status: "processed", outcome: "needs_review", workspaceId: a.workspaceId, processedAt: new Date() } });
    expect([await billingNeedsReview(a.workspaceId), await billingNeedsReview(b.workspaceId)]).toEqual([true, false]);
  });
});

describe("T2 — rétention aux bornes (traités 90 j, échoués 180 j, jamais processing)", () => {
  it("traité à 89 j conservé, à 91 j purgé ; échoué à 179 j conservé, à 181 j purgé", async () => {
    const t0 = Date.now();
    await db.stripeEvent.create({ data: { id: "evt_p", type: "invoice.paid", status: "processed", processedAt: new Date(t0) } });
    await db.stripeEvent.create({ data: { id: "evt_f", type: "invoice.paid", status: "failed", error: "x" } }); // updatedAt = maintenant
    const at = (days: number) => purgeStripeEvents(new Date(t0 + days * DAY));
    const ids = async () => (await db.stripeEvent.findMany({ select: { id: true } })).map((e) => e.id).sort();
    expect(await at(89)).toEqual({ processed: 0, failed: 0 });
    expect(await ids()).toEqual(["evt_f", "evt_p"]);
    expect(await at(91)).toEqual({ processed: 1, failed: 0 });
    expect(await ids()).toEqual(["evt_f"]);
    expect(await at(179)).toEqual({ processed: 0, failed: 0 });
    expect(await ids()).toEqual(["evt_f"]);
    expect(await at(181)).toEqual({ processed: 0, failed: 1 });
    expect(await ids()).toEqual([]);
  });
  it("un événement processing au bail expiré n'est jamais purgé, quel que soit son âge ; un processing au bail valide non plus", async () => {
    const t0 = Date.now();
    await db.stripeEvent.create({ data: { id: "evt_expired", type: "invoice.paid", status: "processing", lockedUntil: new Date(t0 - DAY), leaseToken: "t1" } });
    await db.stripeEvent.create({ data: { id: "evt_valid", type: "invoice.paid", status: "processing", lockedUntil: new Date(t0 + 120_000), leaseToken: "t2" } });
    for (const days of [1, 91, 181, 400, 10_000]) expect(await purgeStripeEvents(new Date(t0 + days * DAY))).toEqual({ processed: 0, failed: 0 });
    expect((await db.stripeEvent.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map((e) => e.id)).toEqual(["evt_expired", "evt_valid"]);
  });
});

describe("T3 — vérification de la signature du webhook (tolérance 300 s)", () => {
  const SECRET = "whsec_FAKE_SECRET_FOR_TESTS_0123456789"; // factice
  const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
  const sec = NOW / 1000;
  const body = JSON.stringify({ id: "evt_sig", type: "invoice.paid", data: { object: {} } });
  const sig = (t: number, payload = body, key = SECRET) => createHmac("sha256", key).update(`${t}.${payload}`).digest("hex");
  const hdr = (t: number | string, ...v1: string[]) => `t=${t}${v1.map((s) => `,v1=${s}`).join("")}`;
  const ok = (header: string | null, payload = body, key = SECRET) => verifyStripeSignature(payload, header, key, 300, NOW);

  it("299 s d'ancienneté accepté, 301 s refusé (idem dans le futur)", () => {
    expect(ok(hdr(sec - 299, sig(sec - 299)))).toBe(true);
    expect(ok(hdr(sec - 301, sig(sec - 301)))).toBe(false);
    expect(ok(hdr(sec + 299, sig(sec + 299)))).toBe(true);
    expect(ok(hdr(sec + 301, sig(sec + 301)))).toBe(false);
  });
  it("la tolérance par défaut (sans argument) est la même : 299 s accepté, 301 s refusé", () => {
    const now = Date.now(), t = Math.floor(now / 1000);
    expect(verifyStripeSignature(body, hdr(t - 299, sig(t - 299)), SECRET, undefined, now)).toBe(true);
    expect(verifyStripeSignature(body, hdr(t - 301, sig(t - 301)), SECRET, undefined, now)).toBe(false);
  });
  it("deux signatures v1 dont une valide : acceptées, quel que soit l'ordre ; deux invalides : refusées", () => {
    const good = sig(sec), bad = "0".repeat(64);
    expect(ok(hdr(sec, bad, good))).toBe(true);
    expect(ok(hdr(sec, good, bad))).toBe(true);
    expect(ok(hdr(sec, bad, "1".repeat(64)))).toBe(false);
  });
  it("charge utile altérée, mauvaise clé, en-tête absent, vide ou incomplet : refusés", () => {
    const good = sig(sec);
    expect(ok(hdr(sec, good), body + " ")).toBe(false);
    expect(ok(hdr(sec, good), body.replace("invoice.paid", "invoice.void"))).toBe(false);
    expect(ok(hdr(sec, good), body, "whsec_AUTRE_CLE_FACTICE")).toBe(false);
    expect(ok(null)).toBe(false);
    expect(ok("")).toBe(false);
    expect(ok(`v1=${good}`)).toBe(false); //            horodatage absent
    expect(ok(`t=${sec}`)).toBe(false); //              aucune signature
    expect(ok(hdr("pas-un-nombre", good))).toBe(false);
  });
  it("la signature est liée à l'horodatage : une signature valide avec un autre t est refusée", () => {
    expect(ok(hdr(sec, sig(sec - 10)))).toBe(false);
  });
});
