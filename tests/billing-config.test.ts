import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state: { ws: string } = { ws: "" };
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (u: string) => { throw new Error("NEXT_REDIRECT:" + u); },
  unstable_rethrow: (e: unknown) => { if (e instanceof Error && e.message.startsWith("NEXT_REDIRECT")) throw e; },
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
}));
vi.mock("@/lib/tenant", async (orig) => {
  const actual = await orig<typeof import("@/lib/tenant")>();
  return {
    ...actual,
    requireCtx: async (opts: { action?: import("@/lib/permissions").Action } = {}) => {
      const { db } = await import("@/lib/db");
      const { assertCan, can } = await import("@/lib/permissions");
      const { entitlementForWorkspace } = await import("@/lib/free-access");
      const ws = await db.workspace.findUniqueOrThrow({ where: { id: state.ws }, include: { subscription: true } });
      const m = await db.membership.findFirstOrThrow({ where: { workspaceId: state.ws }, include: { user: true } });
      if (opts.action) assertCan("owner", opts.action);
      return { user: { id: m.userId, email: m.user.email, name: m.user.name }, workspace: ws, workspaceId: ws.id, role: "owner", subscription: ws.subscription, ent: await entitlementForWorkspace(ws.id, ws.subscription), can: (a: import("@/lib/permissions").Action) => can("owner", a) } as never;
    },
  };
});

import { db } from "@/lib/db";
import { stripeSetup, planCheckoutReady } from "@/lib/billing";
import { checkoutAction } from "../src/app/(app)/billing/actions";
import { makeWorkspace, resetDb } from "./helpers";

// Configuration du paiement : absente / invalide / valide, sans jamais exposer une valeur ; messages d'erreur de souscription adaptés à la cause.

const KEYS = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRICE_STARTER", "STRIPE_PRICE_GROWTH", "STRIPE_PRICE_PRO"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(async () => { for (const k of KEYS) saved[k] = process.env[k]; for (const k of KEYS) delete process.env[k]; await resetDb(); });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } vi.restoreAllMocks(); });

const valid = () => { process.env.STRIPE_SECRET_KEY = "sk_test_abc123"; process.env.STRIPE_WEBHOOK_SECRET = "whsec_abc123"; process.env.STRIPE_PRICE_STARTER = "price_s1"; process.env.STRIPE_PRICE_GROWTH = "price_g1"; process.env.STRIPE_PRICE_PRO = "price_p1"; };
const status = (name: string) => stripeSetup().variables.find((v) => v.name === name)!;
const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

describe("configuration du paiement : absente, invalide, valide", () => {
  it("absente : cinq variables « manquantes », aucun forfait souscriptible", () => {
    const s = stripeSetup();
    expect(s.variables.map((v) => [v.name, v.set, v.valid])).toEqual([["STRIPE_SECRET_KEY", false, false], ["STRIPE_PRICE_STARTER", false, false], ["STRIPE_PRICE_GROWTH", false, false], ["STRIPE_PRICE_PRO", false, false], ["STRIPE_WEBHOOK_SECRET", false, false]]);
    expect(s.anyReady).toBe(false);
    expect(s.issues).toEqual([]);
  });

  it("valide : tout est prêt pour les trois forfaits, aucune anomalie", () => {
    valid();
    const s = stripeSetup();
    expect(s.ready).toEqual({ starter: true, growth: true, pro: true });
    expect(s.issues).toEqual([]);
    expect(["starter", "growth", "pro"].every(planCheckoutReady)).toBe(true);
  });

  it("invalide : une valeur définie au mauvais format est signalée « invalide » (et non « manquante »), bloque les forfaits concernés, sans jamais exposer la valeur", () => {
    valid();
    process.env.STRIPE_SECRET_KEY = "pk_live_cleDeSecretEnRealiteUnePublique999"; // clé publique collée par erreur
    process.env.STRIPE_PRICE_GROWTH = "prod_pasUnPrix";
    process.env.STRIPE_WEBHOOK_SECRET = "texte quelconque";
    const s = stripeSetup();
    expect(status("STRIPE_SECRET_KEY")).toMatchObject({ set: true, valid: false });
    expect(status("STRIPE_PRICE_GROWTH")).toMatchObject({ set: true, valid: false });
    expect(status("STRIPE_WEBHOOK_SECRET")).toMatchObject({ set: true, valid: false });
    expect(status("STRIPE_PRICE_STARTER")).toMatchObject({ set: true, valid: true });
    expect(s.anyReady).toBe(false);
    expect(s.issues.join(" ")).toMatch(/STRIPE_SECRET_KEY est définie mais son format est inattendu/);
    const dump = JSON.stringify(s);
    for (const secret of ["pk_live_cleDeSecret", "prod_pasUnPrix", "texte quelconque", "price_s1"]) expect(dump).not.toContain(secret);
  });

  it("un prix invalide ne bloque que SON forfait ; deux forfaits sur le même prix restent signalés", () => {
    valid();
    process.env.STRIPE_PRICE_PRO = "mauvais";
    expect(stripeSetup().ready).toEqual({ starter: true, growth: true, pro: false });
    process.env.STRIPE_PRICE_PRO = "price_g1"; // même prix que Growth
    const s = stripeSetup();
    expect(s.ready).toEqual({ starter: true, growth: false, pro: false });
    expect(s.issues.join(" ")).toMatch(/même prix Stripe/);
  });

  it("clé restreinte (rk_) acceptée ; secret de webhook manquant avec clé valide : signalé et souscription désactivée", () => {
    valid();
    process.env.STRIPE_SECRET_KEY = "rk_live_restreinte1";
    expect(status("STRIPE_SECRET_KEY").valid).toBe(true);
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const s = stripeSetup();
    expect(s.anyReady).toBe(false);
    expect(s.issues.join(" ")).toMatch(/STRIPE_WEBHOOK_SECRET manque/);
  });
});

describe("souscription : message selon la cause, sans détail technique pour le client", () => {
  const checkout = async (plan = "growth") => { const w = await makeWorkspace(); state.ws = w.workspaceId; return checkoutAction({}, fd({ plan })); };

  it("configuration absente : refus propre, aucun appel à Stripe", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    const r = await checkout();
    expect(r.ok).toBeFalsy();
    expect(r.error).toMatch(/Paiement indisponible|configurez STRIPE/);
    expect(f).not.toHaveBeenCalled();
  });

  it("Stripe indisponible (500), limitation (429) ou coupure réseau : « temporairement indisponible », jamais le texte brut de Stripe", async () => {
    valid();
    for (const impl of [
      async () => new Response(JSON.stringify({ error: { message: "Detail interne Stripe 500" } }), { status: 500 }),
      async () => new Response(JSON.stringify({ error: { message: "Detail interne Stripe 429" } }), { status: 429 }),
      async () => { throw new Error("ECONNRESET detail reseau"); },
    ]) {
      vi.spyOn(globalThis, "fetch").mockImplementation(impl as never);
      const r = await checkout();
      expect(r.error).toMatch(/temporairement indisponible/);
      expect(r.error).not.toMatch(/Detail interne|ECONNRESET/);
      vi.restoreAllMocks();
      await db.workspace.deleteMany();
    }
  });

  it("identifiants refusés par Stripe (401) : message de configuration pour l'administrateur ; prix inconnu ou archivé (400) : refus de catalogue, détail Stripe non affiché", async () => {
    valid();
    vi.spyOn(globalThis, "fetch").mockImplementation((async () => new Response(JSON.stringify({ error: { message: "Invalid API Key provided: sk_test_***" } }), { status: 401 })) as never);
    let r = await checkout();
    expect(r.error).toMatch(/configuration du paiement doit être vérifiée/);
    expect(r.error).not.toMatch(/Invalid API Key/);
    vi.restoreAllMocks(); await db.workspace.deleteMany();
    vi.spyOn(globalThis, "fetch").mockImplementation((async (url: unknown) => String(url).endsWith("/customers") ? new Response(JSON.stringify({ id: "cus_1" }), { status: 200 }) : new Response(JSON.stringify({ error: { message: "No such price: 'price_g1'" } }), { status: 400 })) as never);
    r = await checkout();
    expect(r.error).toMatch(/refusé la demande de paiement/);
    expect(r.error).not.toMatch(/No such price/);
  });
});
