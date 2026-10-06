import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { decryptJson } from "@/lib/crypto";
import { PROVIDERS, emailProvider, metaAds } from "@/lib/integrations/providers";
import { disconnectIntegration, linkAdCampaign, listIntegrations, makeOAuthState, readOAuthState, saveConnection, saveIntegrationConfig, stateOf, syncIntegration, refreshIntegration } from "@/lib/integrations/service";
import { IntegrationError } from "@/lib/integrations/types";
import { sendFollowUpEmail } from "@/lib/email";
import { createLead } from "@/lib/leads";
import { loadAnalytics } from "@/lib/analytics";
import { makeWorkspace, resetDb } from "./helpers";

beforeEach(resetDb);
afterEach(() => { vi.restoreAllMocks(); delete process.env.META_APP_ID; delete process.env.META_APP_SECRET; });

describe("états honnêtes", () => {
  it("sans identifiants plateforme : « configuration requise », jamais « connecté »", async () => {
    const { workspaceId } = await makeWorkspace();
    const list = await listIntegrations(workspaceId);
    expect(list.map((i) => i.provider)).toEqual(["google_analytics", "meta_ads", "google_ads", "tiktok_ads", "email"]);
    for (const i of list.filter((x) => x.provider !== "email")) expect(i.state).toBe("needs_config");
    expect(list.find((i) => i.provider === "email")!.state).toBe("disconnected");
    expect(stateOf(false, { status: "connected" })).toBe("needs_config");
  });

  it("l'état OAuth est signé, daté et lié à l'utilisateur", () => {
    const s = makeOAuthState("ws1", "u1", "meta_ads");
    expect(readOAuthState(s)).toEqual({ workspaceId: "ws1", userId: "u1", provider: "meta_ads" });
    expect(readOAuthState(s.slice(0, -2) + "zz")).toBeNull();
    expect(readOAuthState("n.importe")).toBeNull();
  });
});

describe("cycle connect / status / refresh / disconnect", () => {
  it("les identifiants sont chiffrés en base, jamais en clair, et supprimés à la déconnexion", async () => {
    const { workspaceId } = await makeWorkspace();
    await saveConnection(workspaceId, "email", { credentials: { apiKey: "re_secret_123", from: "A <a@x.com>" }, accountName: "A <a@x.com>" });
    const row = await db.integration.findFirstOrThrow({ where: { workspaceId, provider: "email" } });
    expect(row.status).toBe("connected");
    expect(row.credentials).not.toContain("re_secret_123");
    expect(decryptJson<{ apiKey: string }>(row.credentials!).apiKey).toBe("re_secret_123");
    await disconnectIntegration(workspaceId, "email");
    const after = await db.integration.findFirstOrThrow({ where: { workspaceId, provider: "email" } });
    expect([after.status, after.credentials]).toEqual(["disconnected", null]);
  });

  it("e-mail : la clé est vérifiée auprès du fournisseur (mock) — refus si invalide", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    f.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    await expect(emailProvider.connectWithKey!({ apiKey: "re_bad", from: "A <a@x.com>" })).rejects.toThrow(/refusée/);
    f.mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const ok = await emailProvider.connectWithKey!({ apiKey: "re_ok", from: "A <a@x.com>" });
    expect(ok.credentials).toEqual({ apiKey: "re_ok", from: "A <a@x.com>" });
    await expect(emailProvider.connectWithKey!({ apiKey: "", from: "" })).rejects.toThrow(IntegrationError);
    await expect(emailProvider.connectWithKey!({ apiKey: "k", from: "pas-une-adresse" })).rejects.toThrow(/invalide/);
  });

  it("refresh : bascule en « expired » sur 401 et conserve le message d'erreur", async () => {
    const { workspaceId } = await makeWorkspace();
    process.env.META_APP_ID = "app"; process.env.META_APP_SECRET = "sec";
    await saveConnection(workspaceId, "meta_ads", { credentials: { accessToken: "tok" }, config: { adAccountId: "act_1" } });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));
    await expect(refreshIntegration(workspaceId, "meta_ads")).rejects.toThrow(IntegrationError);
    const row = await db.integration.findFirstOrThrow({ where: { workspaceId, provider: "meta_ads" } });
    expect(row.status).toBe("expired");
    expect(row.lastError).toMatch(/expiré/);
    const view = (await listIntegrations(workspaceId)).find((i) => i.provider === "meta_ads")!;
    expect(view.state).toBe("expired");
  });

  it("saveIntegrationConfig exige une connexion préalable", async () => {
    const { workspaceId } = await makeWorkspace();
    await expect(saveIntegrationConfig(workspaceId, "meta_ads", { adAccountId: "act_1" })).rejects.toThrow(/Connectez/);
  });
});

describe("synchronisation Meta Ads (réponses simulées)", () => {
  const insights = { data: [
    { campaign_id: "111", campaign_name: "Soldes", date_start: "2026-06-01", spend: "12.50", impressions: "1000", clicks: "40" },
    { campaign_id: "111", campaign_name: "Soldes", date_start: "2026-06-02", spend: "7.50", impressions: "800", clicks: "30" },
  ] };

  it("fetchMetrics interroge /insights au niveau campagne et mappe les champs", async () => {
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(insights), { status: 200 }));
    const rows = await metaAds.fetchMetrics!({ accessToken: "tok" }, { adAccountId: "act_9" }, { from: "2026-06-01", to: "2026-06-30" });
    expect(String(f.mock.calls[0][0])).toContain("/act_9/insights");
    expect(String(f.mock.calls[0][0])).toContain("level=campaign");
    expect(rows).toEqual([
      { externalCampaignId: "111", campaignName: "Soldes", date: "2026-06-01", spend: 12.5, impressions: 1000, clicks: 40, externalAccountId: "act_9" },
      { externalCampaignId: "111", campaignName: "Soldes", date: "2026-06-02", spend: 7.5, impressions: 800, clicks: 30, externalAccountId: "act_9" },
    ]);
  });

  it("syncIntegration est idempotent et alimente analytics après association à une campagne", async () => {
    const { workspaceId } = await makeWorkspace();
    process.env.META_APP_ID = "app"; process.env.META_APP_SECRET = "sec";
    await saveConnection(workspaceId, "meta_ads", { credentials: { accessToken: "tok" }, config: { adAccountId: "act_9" } });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(insights), { status: 200 }));
    const range = { from: "2026-06-01", to: "2026-06-30" };
    expect(await syncIntegration(workspaceId, "meta_ads", range)).toEqual({ rows: 2, campaigns: 1 });
    await syncIntegration(workspaceId, "meta_ads", range); // seconde synchro : aucun doublon
    expect(await db.metric.count({ where: { workspaceId } })).toBe(2);
    const ac = await db.adCampaign.findFirstOrThrow({ where: { workspaceId } });
    expect(ac.campaignId).toBeNull();

    const camp = await db.campaign.create({ data: { workspaceId, name: "Soldes interne", platform: "meta_ads" } });
    await linkAdCampaign(workspaceId, ac.id, camp.id);
    expect((await db.metric.findMany({ where: { workspaceId } })).every((m) => m.campaignId === camp.id)).toBe(true);
    const a = await loadAnalytics(workspaceId, { from: new Date("2026-06-01T00:00:00Z"), to: new Date("2026-06-30T23:59:59Z"), campaignId: camp.id });
    expect(a.totals.spend).toBeCloseTo(20);
    expect((await db.integration.findFirstOrThrow({ where: { workspaceId, provider: "meta_ads" } })).lastSyncAt).not.toBeNull();
  });

  it("une erreur d'API passe l'intégration en erreur sans corrompre les données existantes", async () => {
    const { workspaceId } = await makeWorkspace();
    process.env.META_APP_ID = "app"; process.env.META_APP_SECRET = "sec";
    await saveConnection(workspaceId, "meta_ads", { credentials: { accessToken: "tok" }, config: { adAccountId: "act_9" } });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 500 }));
    await expect(syncIntegration(workspaceId, "meta_ads")).rejects.toThrow(/HTTP 500/);
    expect((await db.integration.findFirstOrThrow({ where: { workspaceId, provider: "meta_ads" } })).status).toBe("error");
  });

  it("tous les fournisseurs publicitaires exposent la même interface", () => {
    for (const id of ["meta_ads", "google_ads", "tiktok_ads"]) { expect(PROVIDERS[id].fetchMetrics).toBeTypeOf("function"); expect(PROVIDERS[id].authUrl).toBeTypeOf("function"); expect(PROVIDERS[id].check).toBeTypeOf("function"); }
    expect(PROVIDERS.google_analytics.refresh).toBeTypeOf("function");
  });
});

describe("envoi d'e-mail via l'intégration de l'espace", () => {
  it("utilise la clé Resend de l'espace (mock), vérifie consentement et ajoute la désinscription", async () => {
    const { workspaceId } = await makeWorkspace();
    await saveConnection(workspaceId, "email", { credentials: { apiKey: "re_ws", from: "Acme <a@x.com>" } });
    const { lead } = await createLead({ workspaceId, name: "Marie", email: "m@y.com", consentMarketing: true });
    const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }));
    const r = await sendFollowUpEmail({ workspaceId, leadId: lead.id, subject: "Hello", body: "Corps" });
    expect(r.sent).toBe(true);
    const [url, init] = f.mock.calls[0];
    expect(String(url)).toBe("https://api.resend.com/emails");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer re_ws");
    expect(JSON.parse(init!.body as string).text).toContain("/unsubscribe/");
    expect((await db.emailLog.findFirstOrThrow({ where: { workspaceId } })).providerMessageId).toBe("msg_1");

    await db.emailSuppression.create({ data: { workspaceId, email: "m@y.com" } });
    expect((await sendFollowUpEmail({ workspaceId, leadId: lead.id, subject: "H", body: "B" })).reason).toMatch(/suppression/);
  });

  it("l'espace B ne peut pas envoyer avec la clé de l'espace A", async () => {
    const a = await makeWorkspace("A");
    const b = await makeWorkspace("B");
    await saveConnection(a.workspaceId, "email", { credentials: { apiKey: "re_a", from: "A <a@x.com>" } });
    const { lead } = await createLead({ workspaceId: b.workspaceId, name: "M", email: "m@y.com", consentMarketing: true });
    const f = vi.spyOn(globalThis, "fetch");
    const r = await sendFollowUpEmail({ workspaceId: b.workspaceId, leadId: lead.id, subject: "H", body: "B" });
    expect(r.sent).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});
