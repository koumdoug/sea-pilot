import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { registerUser } from "@/lib/workspaces";
import { readSessionToken, signSessionToken, passwordProblem } from "@/lib/auth";
import { resolveWorkspaceFor } from "@/lib/tenant";
import { changeLeadStatus, createLead, eraseLead, qualifyLeadService, LeadError } from "@/lib/leads";
import { CampaignError, duplicateCampaign, transitionCampaign } from "@/lib/campaigns";
import { enrollLead } from "@/lib/followups";
import { linkAdCampaign } from "@/lib/integrations/service";
import { sha256 } from "@/lib/crypto";
import { POST as apiLead } from "@/app/api/v1/leads/route";
import { makeWorkspace, resetDb } from "./helpers";

beforeEach(resetDb);

describe("inscription et espace de travail", () => {
  it("crée utilisateur + workspace + adhésion owner + essai + configuration de qualification", async () => {
    const r = await registerUser({ name: "Alice", email: "Alice@Example.com", password: "Motdepasse123", workspaceName: "Acme Corp" });
    if ("error" in r) throw new Error("unexpected");
    expect(r.user.email).toBe("alice@example.com");
    expect(r.user.passwordHash).not.toContain("Motdepasse123");
    const m = await db.membership.findFirstOrThrow({ where: { userId: r.user.id } });
    expect(m.role).toBe("owner");
    const sub = await db.subscription.findUniqueOrThrow({ where: { workspaceId: r.workspace.id } });
    expect(sub.status).toBe("trialing");
    expect(sub.trialEndsAt!.getTime()).toBeGreaterThan(Date.now() + 13 * 86_400_000);
    expect(await db.qualificationConfig.findUnique({ where: { workspaceId: r.workspace.id } })).not.toBeNull();
    expect(r.workspace.slug).toBe("acme-corp");
  });

  it("refuse un e-mail déjà utilisé (insensible à la casse) et génère des slugs uniques", async () => {
    await registerUser({ name: "A", email: "a@x.com", password: "Motdepasse123", workspaceName: "Acme" });
    expect(await registerUser({ name: "B", email: "A@X.COM", password: "Motdepasse123", workspaceName: "Acme" })).toEqual({ error: "EMAIL_TAKEN" });
    const r = await registerUser({ name: "C", email: "c@x.com", password: "Motdepasse123", workspaceName: "Acme" });
    if ("error" in r) throw new Error("unexpected");
    expect(r.workspace.slug).toBe("acme-2");
  });

  it("politique de mot de passe", () => {
    expect(passwordProblem("court1")).toMatch(/10 caractères/);
    expect(passwordProblem("uniquementlettres")).toMatch(/lettre et un chiffre/);
    expect(passwordProblem("1234567890123")).toMatch(/lettre et un chiffre/);
    expect(passwordProblem("Motdepasse123")).toBeNull();
  });

  it("jeton de session : signé, vérifié, falsification refusée", async () => {
    const t = await signSessionToken("user-1");
    expect(await readSessionToken(t)).toBe("user-1");
    expect(await readSessionToken(t.slice(0, -3) + "abc")).toBeNull();
    expect(await readSessionToken("n.importe.quoi")).toBeNull();
  });
});

describe("isolation multi-tenant", () => {
  it("un identifiant d'espace envoyé par le navigateur est ignoré s'il n'a pas d'adhésion", async () => {
    const a = await makeWorkspace("A");
    const b = await makeWorkspace("B");
    const res = await resolveWorkspaceFor(a.userId, b.workspaceId); // A tente de forcer l'espace de B
    expect(res!.workspaceId).toBe(a.workspaceId);
    expect(await resolveWorkspaceFor("inconnu", a.workspaceId)).toBeNull();
  });

  it("les espaces supprimés ne sont plus résolus", async () => {
    const a = await makeWorkspace("A");
    await db.workspace.update({ where: { id: a.workspaceId }, data: { deletedAt: new Date() } });
    expect(await resolveWorkspaceFor(a.userId, a.workspaceId)).toBeNull();
  });

  it("les services refusent d'agir sur les données d'un autre espace", async () => {
    const a = await makeWorkspace("A");
    const b = await makeWorkspace("B");
    const { lead } = await createLead({ workspaceId: a.workspaceId, name: "Prospect A", email: "p@a.com" });
    const campaign = await db.campaign.create({ data: { workspaceId: a.workspaceId, name: "Camp A", budget: 100 } });
    const seq = await db.followUpSequence.create({ data: { workspaceId: a.workspaceId, name: "S", steps: [{ day: 0, action: "task", title: "t" }] } });

    await expect(changeLeadStatus({ workspaceId: b.workspaceId, leadId: lead.id, status: "won" })).rejects.toThrow(LeadError);
    await expect(qualifyLeadService({ workspaceId: b.workspaceId, leadId: lead.id, userId: null })).rejects.toThrow(LeadError);
    expect(await eraseLead(b.workspaceId, lead.id)).toBe(false);
    await expect(transitionCampaign({ workspaceId: b.workspaceId, campaignId: campaign.id, to: "archived" })).rejects.toThrow(CampaignError);
    await expect(duplicateCampaign(b.workspaceId, campaign.id)).rejects.toThrow(CampaignError);
    expect((await enrollLead({ workspaceId: b.workspaceId, leadId: lead.id, sequenceId: seq.id })).enrolled).toBe(false);
    await expect(linkAdCampaign(b.workspaceId, "x", campaign.id)).rejects.toThrow();

    // Rien n'a bougé côté A
    const after = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(after.status).not.toBe("won");
    expect(after.deletedAt).toBeNull();
    expect(await db.campaign.count({ where: { workspaceId: b.workspaceId } })).toBe(0);
  });

  it("un lead ne peut pas être rattaché à la campagne d'un autre espace", async () => {
    const a = await makeWorkspace("A");
    const b = await makeWorkspace("B");
    const campA = await db.campaign.create({ data: { workspaceId: a.workspaceId, name: "Camp A" } });
    const { lead } = await createLead({ workspaceId: b.workspaceId, name: "X", email: "x@b.com", campaignId: campA.id, utm: { campaign: campA.id } });
    expect(lead.campaignId).toBeNull();
  });

  it("l'API v1 écrit uniquement dans l'espace de la clé et rejette les clés invalides ou révoquées", async () => {
    const a = await makeWorkspace("A");
    const b = await makeWorkspace("B");
    const key = "sp_testkey_A_" + "x".repeat(20);
    await db.apiKey.create({ data: { workspaceId: a.workspaceId, name: "k", prefix: key.slice(0, 10), keyHash: sha256(key) } });
    const call = (k: string | null, body: unknown) => apiLead(new Request("http://x/api/v1/leads", { method: "POST", headers: { "content-type": "application/json", ...(k ? { authorization: `Bearer ${k}` } : {}) }, body: JSON.stringify(body) }));

    expect((await call(null, { name: "N", email: "n@x.com" })).status).toBe(401);
    expect((await call("sp_mauvaise", { name: "N", email: "n@x.com" })).status).toBe(401);
    expect((await call(key, { name: "N" })).status).toBe(400); // ni e-mail ni téléphone
    const ok = await call(key, { name: "Via API", email: "api@x.com", message: "devis", utm_source: "google", consent_marketing: true });
    expect(ok.status).toBe(201);
    const created = await db.lead.findFirstOrThrow({ where: { email: "api@x.com" } });
    expect(created.workspaceId).toBe(a.workspaceId);
    expect(created.utmSource).toBe("google");
    expect(created.consentMarketing).toBe(true);
    expect(await db.lead.count({ where: { workspaceId: b.workspaceId } })).toBe(0);

    await db.apiKey.updateMany({ where: { keyHash: sha256(key) }, data: { revokedAt: new Date() } });
    expect((await call(key, { name: "N", email: "n2@x.com" })).status).toBe(401);
  });

  it("l'API v1 refuse un espace dont l'abonnement est inactif", async () => {
    const a = await makeWorkspace("A");
    const key = "sp_testkey_inactive_" + "y".repeat(12);
    await db.apiKey.create({ data: { workspaceId: a.workspaceId, name: "k", prefix: key.slice(0, 10), keyHash: sha256(key) } });
    await db.subscription.update({ where: { workspaceId: a.workspaceId }, data: { status: "canceled" } });
    const res = await apiLead(new Request("http://x/api/v1/leads", { method: "POST", headers: { authorization: `Bearer ${key}` }, body: JSON.stringify({ name: "N", email: "n@x.com" }) }));
    expect(res.status).toBe(402);
  });
});
