import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { changeLeadStatus, createLead, eraseLead, exportLeadData, qualifyLeadService, unsubscribeLead } from "@/lib/leads";
import { enrollLead } from "@/lib/followups";
import { duplicateCampaign, transitionCampaign, CampaignError } from "@/lib/campaigns";
import { makeWorkspace, resetDb } from "./helpers";

beforeEach(resetDb);

describe("création de lead", () => {
  it("conserve UTM, consentement, historique, événement, notification et qualification automatique", async () => {
    const { workspaceId } = await makeWorkspace();
    const { lead } = await createLead({
      workspaceId, name: "Marie Durand", email: "Marie@Example.com", phone: "0600000000", message: "Besoin urgent d'un devis cette semaine", customFields: { budget: "4000", ville: "Lyon" },
      utm: { source: "google", medium: "cpc", campaign: "promo", term: "devis", content: "a" }, consentMarketing: true, consentText: "Je consens", referrer: "https://google.com",
    });
    expect(lead.email).toBe("marie@example.com");
    expect([lead.utmSource, lead.utmMedium, lead.utmCampaign, lead.utmTerm, lead.utmContent]).toEqual(["google", "cpc", "promo", "devis", "a"]);
    expect(lead.consentMarketing).toBe(true);
    expect(lead.consentText).toBe("Je consens");
    expect(await db.leadActivity.count({ where: { leadId: lead.id, type: "created" } })).toBe(1);
    expect(await db.analyticsEvent.count({ where: { leadId: lead.id, type: "lead_created" } })).toBe(1);
    expect(await db.notification.count({ where: { workspaceId } })).toBe(1);
    expect(await db.consent.count({ where: { leadId: lead.id, granted: true } })).toBe(1);
    expect(lead.score).not.toBeNull(); // qualification automatique par règles
    expect(await db.aIQualification.count({ where: { leadId: lead.id } })).toBe(1);
  });

  it("sans consentement coché : aucun consentement marketing enregistré", async () => {
    const { workspaceId } = await makeWorkspace();
    const { lead } = await createLead({ workspaceId, name: "X", email: "x@y.com" });
    expect(lead.consentMarketing).toBe(false);
    expect(lead.consentAt).toBeNull();
  });

  it("anti double-soumission : même e-mail dans les 10 minutes", async () => {
    const { workspaceId } = await makeWorkspace();
    const a = await createLead({ workspaceId, name: "X", email: "dup@y.com" });
    const b = await createLead({ workspaceId, name: "X", email: "dup@y.com" });
    expect(b.duplicate).toBe(true);
    expect(b.lead.id).toBe(a.lead.id);
    expect(await db.lead.count({ where: { workspaceId } })).toBe(1);
  });

  it("rattachement à la campagne par utm_campaign (id ou nom) et par la landing page", async () => {
    const { workspaceId } = await makeWorkspace();
    const c = await db.campaign.create({ data: { workspaceId, name: "Promo Été" } });
    expect((await createLead({ workspaceId, name: "1", email: "1@a.com", utm: { campaign: c.id } })).lead.campaignId).toBe(c.id);
    expect((await createLead({ workspaceId, name: "2", email: "2@a.com", utm: { campaign: "promo-ete" } })).lead.campaignId).toBe(c.id);
    const lp = await db.landingPage.create({ data: { workspaceId, name: "LP", slug: "lp", sections: [], campaignId: c.id } });
    expect((await createLead({ workspaceId, name: "3", email: "3@a.com", landingPageId: lp.id })).lead.campaignId).toBe(c.id);
    expect((await createLead({ workspaceId, name: "4", email: "4@a.com", utm: { campaign: "inconnue" } })).lead.campaignId).toBeNull();
  });

  it("l'inscription automatique à une séquence active crée les relances", async () => {
    const { workspaceId } = await makeWorkspace();
    await db.followUpSequence.create({ data: { workspaceId, name: "Auto", autoEnroll: true, steps: [{ day: 0, action: "task", title: "Appeler" }, { day: 3, action: "reminder", title: "Rappel" }] } });
    const { lead } = await createLead({ workspaceId, name: "X", email: "auto@y.com" });
    expect(await db.followUp.count({ where: { leadId: lead.id, status: "pending" } })).toBe(2);
  });
});

describe("statuts et conversion", () => {
  it("won crée un client avec le revenu, déclenche l'événement et arrête les relances", async () => {
    const { workspaceId } = await makeWorkspace();
    const c = await db.campaign.create({ data: { workspaceId, name: "C" } });
    const seq = await db.followUpSequence.create({ data: { workspaceId, name: "S", steps: [{ day: 2, action: "task", title: "t" }] } });
    const { lead } = await createLead({ workspaceId, name: "Client", email: "c@y.com", campaignId: c.id });
    await enrollLead({ workspaceId, leadId: lead.id, sequenceId: seq.id });
    const won = await changeLeadStatus({ workspaceId, leadId: lead.id, status: "won", value: 1200 });
    expect(won.status).toBe("won");
    expect(won.value).toBe(1200);
    expect(won.wonAt).not.toBeNull();
    const cust = await db.customer.findFirstOrThrow({ where: { workspaceId } });
    expect(cust.revenue).toBe(1200);
    expect(cust.campaignId).toBe(c.id);
    expect(await db.analyticsEvent.count({ where: { leadId: lead.id, type: "customer_won" } })).toBe(1);
    expect(await db.followUp.count({ where: { leadId: lead.id, status: "pending" } })).toBe(0); // arrêt automatique
    // idempotence : repasser à « won » ne crée pas un second client
    await changeLeadStatus({ workspaceId, leadId: lead.id, status: "won", value: 1500 });
    expect(await db.customer.count({ where: { workspaceId } })).toBe(1);
    expect((await db.customer.findFirstOrThrow({ where: { workspaceId } })).revenue).toBe(1500);
  });

  it("lost et disqualified arrêtent les relances ; qualified pose qualifiedAt", async () => {
    const { workspaceId } = await makeWorkspace();
    const seq = await db.followUpSequence.create({ data: { workspaceId, name: "S", steps: [{ day: 5, action: "task", title: "t" }] } });
    const { lead } = await createLead({ workspaceId, name: "L", email: "l@y.com" });
    await enrollLead({ workspaceId, leadId: lead.id, sequenceId: seq.id });
    const q = await changeLeadStatus({ workspaceId, leadId: lead.id, status: "qualified" });
    expect(q.qualifiedAt).not.toBeNull();
    const lost = await changeLeadStatus({ workspaceId, leadId: lead.id, status: "lost", lostReason: "Trop cher" });
    expect(lost.lostReason).toBe("Trop cher");
    expect(await db.followUp.count({ where: { leadId: lead.id, status: "pending" } })).toBe(0);
    // un prospect clos ne peut plus être inscrit
    expect((await enrollLead({ workspaceId, leadId: lead.id, sequenceId: seq.id })).enrolled).toBe(false);
  });

  it("statut invalide refusé", async () => {
    const { workspaceId } = await makeWorkspace();
    const { lead } = await createLead({ workspaceId, name: "L", email: "l@y.com" });
    await expect(changeLeadStatus({ workspaceId, leadId: lead.id, status: "n-importe-quoi" })).rejects.toThrow();
  });
});

describe("qualification persistée", () => {
  it("enregistre score, niveau, faits, inférences, informations manquantes et prochaine action", async () => {
    const { workspaceId } = await makeWorkspace();
    const { lead } = await createLead({ workspaceId, name: "Q", email: "q@y.com", message: "Je cherche un prix, c'est urgent", customFields: { budget: "2000" }, source: "form" });
    const { qualification, record, method } = await qualifyLeadService({ workspaceId, leadId: lead.id, userId: null });
    expect(method).toBe("rules");
    expect(record.method).toBe("rules");
    expect(qualification.facts.length).toBeGreaterThan(0);
    expect(Array.isArray(record.missingInfo)).toBe(true);
    expect(record.nextAction.length).toBeGreaterThan(5);
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).score).toBe(qualification.score);
  });

  it("allowAi sans fournisseur configuré : repli sur les règles, sans erreur", async () => {
    const { workspaceId } = await makeWorkspace();
    const { lead } = await createLead({ workspaceId, name: "Q", email: "q@y.com" });
    const r = await qualifyLeadService({ workspaceId, leadId: lead.id, userId: null, allowAi: true });
    expect(r.method).toBe("rules");
  });
});

describe("RGPD", () => {
  it("désinscription : consentement retiré, suppression enregistrée, relances annulées", async () => {
    const { workspaceId } = await makeWorkspace();
    const seq = await db.followUpSequence.create({ data: { workspaceId, name: "S", steps: [{ day: 1, action: "email", subject: "s", body: "b" }] } });
    const { lead } = await createLead({ workspaceId, name: "U", email: "u@y.com", consentMarketing: true });
    await enrollLead({ workspaceId, leadId: lead.id, sequenceId: seq.id });
    expect(await unsubscribeLead(workspaceId, lead.id)).toBe(true);
    const l = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(l.unsubscribedAt).not.toBeNull();
    expect(l.consentMarketing).toBe(false);
    expect(await db.emailSuppression.count({ where: { workspaceId, email: "u@y.com" } })).toBe(1);
    expect(await db.followUp.count({ where: { leadId: lead.id, status: "pending" } })).toBe(0);
    expect((await enrollLead({ workspaceId, leadId: lead.id, sequenceId: seq.id })).enrolled).toBe(false);
  });

  it("effacement : données personnelles supprimées, ligne anonymisée conservée pour les statistiques", async () => {
    const { workspaceId } = await makeWorkspace();
    const { lead } = await createLead({ workspaceId, name: "Personne", email: "p@y.com", phone: "0600", message: "secret", company: "ACME" });
    await db.conversation.create({ data: { workspaceId, leadId: lead.id, body: "note privée" } });
    expect(await eraseLead(workspaceId, lead.id)).toBe(true);
    const l = await db.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect([l.name, l.email, l.phone, l.company, l.message]).toEqual(["Prospect effacé", null, null, null, null]);
    expect(l.deletedAt).not.toBeNull();
    expect(await db.conversation.count({ where: { leadId: lead.id } })).toBe(0);
    expect(await db.aIQualification.count({ where: { leadId: lead.id } })).toBe(0);
    expect(await exportLeadData(workspaceId, lead.id)).toBeNull();
    // l'adresse est mise en liste de suppression pour éviter tout renvoi
    expect(await db.emailSuppression.count({ where: { workspaceId, email: "p@y.com" } })).toBe(1);
  });
});

describe("campagnes", () => {
  it("cycle de vie : on ne peut pas activer sans landing page publiée ; duplication en brouillon", async () => {
    const { workspaceId } = await makeWorkspace();
    const offer = await db.offer.create({ data: { workspaceId, name: "O" } });
    const aud = await db.audience.create({ data: { workspaceId, name: "A" } });
    const lp = await db.landingPage.create({ data: { workspaceId, name: "LP", slug: "lp", sections: [] } });
    const c = await db.campaign.create({ data: { workspaceId, name: "C", budget: 500, offerId: offer.id, audienceId: aud.id, landingPageId: lp.id } });
    await db.ad.create({ data: { workspaceId, campaignId: c.id, platform: "google_ads", headline: "H" } });
    await transitionCampaign({ workspaceId, campaignId: c.id, to: "ready" });
    await expect(transitionCampaign({ workspaceId, campaignId: c.id, to: "active" })).rejects.toThrow(/landing page publiée/);
    await db.landingPage.update({ where: { id: lp.id }, data: { status: "published" } });
    expect((await transitionCampaign({ workspaceId, campaignId: c.id, to: "active" })).status).toBe("active");
    await expect(transitionCampaign({ workspaceId, campaignId: c.id, to: "draft" })).rejects.toThrow(CampaignError);
    const copy = await duplicateCampaign(workspaceId, c.id);
    expect(copy.status).toBe("draft");
    expect(copy.duplicatedFromId).toBe(c.id);
    expect(await db.ad.count({ where: { campaignId: copy.id } })).toBe(1);
  });

  it("limite de campagnes actives selon le plan", async () => {
    const { workspaceId } = await makeWorkspace();
    const offer = await db.offer.create({ data: { workspaceId, name: "O" } });
    const aud = await db.audience.create({ data: { workspaceId, name: "A" } });
    for (let i = 0; i < 3; i++) await db.campaign.create({ data: { workspaceId, name: `Active ${i}`, status: "active", budget: 1, offerId: offer.id, audienceId: aud.id } });
    const lp = await db.landingPage.create({ data: { workspaceId, name: "LP", slug: "lp", sections: [], status: "published" } });
    const c = await db.campaign.create({ data: { workspaceId, name: "4e", status: "ready", budget: 100, offerId: offer.id, audienceId: aud.id, landingPageId: lp.id } });
    await expect(transitionCampaign({ workspaceId, campaignId: c.id, to: "active" })).rejects.toThrow(/Limite de campagnes actives/);
  });
});
