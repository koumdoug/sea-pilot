import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { sha256, randomToken } from "@/lib/crypto";
import { resetPasswordAction } from "@/app/(auth)/actions";
import { createCheckoutSession, createPortalSession, handleStripeEvent, setCancelAtPeriodEnd } from "@/lib/billing";
import { createLead, unsubscribeLead } from "@/lib/leads";
import { enrollLead, processDueFollowUps } from "@/lib/followups";
import { setEmailProviderForTests, type EmailProvider, type OutgoingEmail } from "@/lib/email";
import { verifyPassword } from "@/lib/auth";
import { POST as apiLead } from "@/app/api/v1/leads/route";
import { entitlement } from "@/lib/plans";
import { makeWorkspace, resetDb } from "./helpers";

beforeEach(resetDb);
afterEach(() => { vi.restoreAllMocks(); setEmailProviderForTests(null); delete process.env.STRIPE_SECRET_KEY; });

const fd = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };

describe("réinitialisation du mot de passe : jeton à usage unique", () => {
  async function tokenFor(userId: string, expiresIn = 3_600_000) {
    const t = randomToken(32);
    await db.passwordResetToken.create({ data: { userId, tokenHash: sha256(t), expiresAt: new Date(Date.now() + expiresIn) } });
    return t;
  }
  it("fonctionne une fois, refuse la réutilisation, le jeton expiré et un mot de passe faible", async () => {
    const { userId } = await makeWorkspace();
    const t = await tokenFor(userId);
    expect((await resetPasswordAction({}, fd({ token: t, password: "court1" }))).error).toBeTruthy();
    await expect(resetPasswordAction({}, fd({ token: t, password: "NouveauMdp2026" }))).rejects.toThrow(); // redirect vers /login
    const u = await db.user.findUniqueOrThrow({ where: { id: userId } });
    expect(await verifyPassword("NouveauMdp2026", u.passwordHash!)).toBe(true);
    expect((await resetPasswordAction({}, fd({ token: t, password: "AutreMdp2026x" }))).error).toMatch(/invalide ou expiré/);
    expect(await verifyPassword("NouveauMdp2026", (await db.user.findUniqueOrThrow({ where: { id: userId } })).passwordHash!)).toBe(true);
    const expired = await tokenFor(userId, -1000);
    expect((await resetPasswordAction({}, fd({ token: expired, password: "AutreMdp2026x" }))).error).toMatch(/invalide ou expiré/);
    expect((await resetPasswordAction({}, fd({ token: "n-existe-pas-du-tout", password: "AutreMdp2026x" }))).error).toMatch(/invalide ou expiré/);
  });
  it("un jeton émis pour un utilisateur invalide aussi les autres jetons en attente", async () => {
    const { userId } = await makeWorkspace();
    const t1 = await tokenFor(userId), t2 = await tokenFor(userId);
    await expect(resetPasswordAction({}, fd({ token: t1, password: "NouveauMdp2026" }))).rejects.toThrow();
    expect((await resetPasswordAction({}, fd({ token: t2, password: "AutreMdp2026x" }))).error).toMatch(/invalide ou expiré/);
  });
});

describe("Stripe : checkout, portail, annulation, reprise (réponses simulées)", () => {
  it("checkout : prix du plan, rattachement à l'espace, essai restant honoré uniquement s'il dépasse 48 h", async () => {
    const { workspaceId } = await makeWorkspace();
    process.env.STRIPE_SECRET_KEY = "sk_test_placeholder_not_a_real_key";
    const calls: { url: string; body: URLSearchParams }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      calls.push({ url: String(url), body: new URLSearchParams(init?.body as string) });
      return new Response(JSON.stringify(String(url).endsWith("/customers") ? { id: "cus_x" } : { url: "https://checkout.example/session" }), { status: 200 });
    });
    expect(await createCheckoutSession({ workspaceId, plan: "growth", email: "a@b.c" })).toBe("https://checkout.example/session");
    const s = calls.find((c) => c.url.endsWith("/checkout/sessions"))!.body;
    expect([s.get("line_items[0][price]"), s.get("client_reference_id"), s.get("metadata[plan]"), s.get("mode")]).toEqual(["price_growth_test", workspaceId, "growth", "subscription"]);
    expect(s.get("subscription_data[trial_end]")).not.toBeNull();
    await db.subscription.update({ where: { workspaceId }, data: { trialEndsAt: new Date(Date.now() + 3_600_000) } });
    calls.length = 0;
    await createCheckoutSession({ workspaceId, plan: "pro", email: "a@b.c" });
    expect(calls.find((c) => c.url.endsWith("/checkout/sessions"))!.body.get("subscription_data[trial_end]")).toBeNull();
    await expect(createCheckoutSession({ workspaceId, plan: "inconnu", email: "a@b.c" })).rejects.toThrow();
  });

  it("portail : exige un client Stripe ; annulation puis reprise d'un abonnement payant", async () => {
    const { workspaceId } = await makeWorkspace();
    process.env.STRIPE_SECRET_KEY = "sk_test_placeholder_not_a_real_key";
    await expect(createPortalSession(workspaceId)).rejects.toThrow(/Aucun client Stripe/);
    await db.subscription.update({ where: { workspaceId }, data: { stripeCustomerId: "cus_1", stripeSubscriptionId: "sub_1", status: "active", currentPeriodEnd: new Date(Date.now() + 10 * 86_400_000) } });
    const bodies: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => { bodies.push(`${url} ${init?.body ?? ""}`); return new Response(JSON.stringify({ url: "https://portal.example" }), { status: 200 }); });
    expect(await createPortalSession(workspaceId)).toBe("https://portal.example");
    await setCancelAtPeriodEnd(workspaceId, true);
    expect(bodies.some((b) => b.includes("/subscriptions/sub_1") && b.includes("cancel_at_period_end=true"))).toBe(true);
    expect(entitlement(await db.subscription.findUniqueOrThrow({ where: { workspaceId } })).state).toBe("canceling");
    await setCancelAtPeriodEnd(workspaceId, false);
    expect(entitlement(await db.subscription.findUniqueOrThrow({ where: { workspaceId } })).state).toBe("paid");
  });

  it("une erreur Stripe est remontée sans modifier l'état local", async () => {
    const { workspaceId } = await makeWorkspace();
    process.env.STRIPE_SECRET_KEY = "sk_test_placeholder_not_a_real_key";
    await db.subscription.update({ where: { workspaceId }, data: { stripeSubscriptionId: "sub_1", status: "active" } });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: { message: "boom" } }), { status: 400 }));
    await expect(setCancelAtPeriodEnd(workspaceId, true)).rejects.toThrow("boom");
    expect((await db.subscription.findUniqueOrThrow({ where: { workspaceId } })).cancelAtPeriodEnd).toBe(false);
  });

  it("un événement Stripe ne peut pas modifier l'abonnement d'un autre espace", async () => {
    const a = await makeWorkspace("A");
    const b = await makeWorkspace("B");
    await db.subscription.update({ where: { workspaceId: a.workspaceId }, data: { stripeCustomerId: "cus_A", stripeSubscriptionId: "sub_A", status: "active", plan: "pro" } });
    await handleStripeEvent({ id: "e", type: "customer.subscription.deleted", data: { object: { id: "sub_B_inconnu", customer: "cus_B_inconnu", status: "canceled", metadata: { workspaceId: b.workspaceId } } } });
    expect((await db.subscription.findUniqueOrThrow({ where: { workspaceId: a.workspaceId } })).status).toBe("active");
  });
});

describe("automatisations idempotentes", () => {
  class Spy implements EmailProvider { readonly id = "spy"; sent: OutgoingEmail[] = []; async send(m: OutgoingEmail) { this.sent.push(m); return { id: "m" }; } }

  it("exécuter les relances 3 fois ne crée ni e-mail, ni tâche, ni changement de statut en double", async () => {
    const { workspaceId } = await makeWorkspace();
    const spy = new Spy(); setEmailProviderForTests(spy);
    const seq = await db.followUpSequence.create({ data: { workspaceId, name: "S", sendEmails: true, steps: [
      { day: 0, action: "email", subject: "Hello", body: "Corps" }, { day: 0, action: "task", title: "Appeler" }, { day: 0, action: "status_change", status: "contacted" }, { day: 30, action: "task", title: "Plus tard" },
    ] } });
    const { lead } = await createLead({ workspaceId, name: "Marie D", email: "m@y.com", consentMarketing: true });
    await enrollLead({ workspaceId, leadId: lead.id, sequenceId: seq.id });
    await enrollLead({ workspaceId, leadId: lead.id, sequenceId: seq.id }); // double inscription ignorée
    const runs = [await processDueFollowUps({ workspaceId }), await processDueFollowUps({ workspaceId }), await processDueFollowUps({ workspaceId })];
    expect(runs.map((r) => r.processed)).toEqual([3, 0, 0]);
    expect(spy.sent).toHaveLength(1);
    expect(await db.emailLog.count({ where: { workspaceId } })).toBe(1);
    expect(await db.task.count({ where: { leadId: lead.id } })).toBe(1);
    expect(await db.leadActivity.count({ where: { leadId: lead.id, type: "status_changed" } })).toBe(1);
    expect(await db.followUp.count({ where: { leadId: lead.id } })).toBe(4);
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe("contacted");
  });

  it("une relance interrompue (running) n'est pas rejouée par un autre exécuteur", async () => {
    const { workspaceId } = await makeWorkspace();
    const seq = await db.followUpSequence.create({ data: { workspaceId, name: "S", steps: [{ day: 0, action: "task", title: "t" }] } });
    const { lead } = await createLead({ workspaceId, name: "X", email: "x@y.com" });
    await enrollLead({ workspaceId, leadId: lead.id, sequenceId: seq.id });
    await db.followUp.updateMany({ where: { leadId: lead.id }, data: { status: "running" } });
    expect((await processDueFollowUps({ workspaceId })).processed).toBe(0);
    expect(await db.task.count({ where: { leadId: lead.id } })).toBe(0);
  });
});

describe("isolation : vecteurs supplémentaires", () => {
  it("un jeton/identifiant de l'espace A ne désinscrit pas un lead de l'espace B", async () => {
    const a = await makeWorkspace("A");
    const b = await makeWorkspace("B");
    const { lead } = await createLead({ workspaceId: b.workspaceId, name: "LB", email: "lb@b.com", consentMarketing: true });
    expect(await unsubscribeLead(a.workspaceId, lead.id)).toBe(false);
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).unsubscribedAt).toBeNull();
  });

  it("l'API key de A ne peut rattacher un lead ni à une campagne ni à une page de B", async () => {
    const a = await makeWorkspace("A");
    const b = await makeWorkspace("B");
    const campB = await db.campaign.create({ data: { workspaceId: b.workspaceId, name: "Camp B" } });
    const key = "sp_iso_" + "k".repeat(24);
    await db.apiKey.create({ data: { workspaceId: a.workspaceId, name: "k", prefix: key.slice(0, 10), keyHash: sha256(key) } });
    const res = await apiLead(new Request("http://x/api/v1/leads", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ name: "N", email: "n@a.com", campaign_id: campB.id, utm_campaign: campB.id }) }));
    expect(res.status).toBe(201);
    const l = await db.lead.findFirstOrThrow({ where: { email: "n@a.com" } });
    expect(l.workspaceId).toBe(a.workspaceId);
    expect(l.campaignId).toBeNull();
    expect(await db.lead.count({ where: { campaignId: campB.id } })).toBe(0);
  });

  it("chaque espace a son propre abonnement et ses propres limites", async () => {
    const a = await makeWorkspace("A");
    const b = await makeWorkspace("B");
    await db.subscription.update({ where: { workspaceId: a.workspaceId }, data: { status: "canceled" } });
    expect(entitlement(await db.subscription.findUniqueOrThrow({ where: { workspaceId: a.workspaceId } })).active).toBe(false);
    expect(entitlement(await db.subscription.findUniqueOrThrow({ where: { workspaceId: b.workspaceId } })).active).toBe(true);
  });
});
