import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createLead } from "@/lib/leads";
import {
  addProspect, approveOutreachCampaign, attachProspectToCampaign, checkEligibility, ensureDefaultProducts, importProspects, logContact, logReply,
  optOutProspect, portfolioStats, PortfolioError, reassignProspect, recordProductEvent,
} from "@/lib/portfolio/service";
import { parseProspectCsv } from "@/lib/portfolio/rules";
import { can } from "@/lib/permissions";
import { makeWorkspace, resetDb } from "./helpers";

beforeEach(resetDb);

const collected = new Date("2026-10-01T00:00:00Z");
const later = new Date("2026-12-01T00:00:00Z");

async function setup() {
  const a = await makeWorkspace("Portfolio");
  await ensureDefaultProducts(a.workspaceId, a.userId);
  const products = await db.product.findMany({ where: { workspaceId: a.workspaceId } });
  const by = (slug: string) => products.find((p) => p.slug === slug)!;
  return { ...a, driver: by("driverpilot"), nexa: by("freelancenexa"), opera: by("operapilot") };
}

async function commercialise(workspaceId: string, productId: string, channel = "email") {
  await db.product.update({ where: { id: productId }, data: { status: "commercialisation" } });
  await db.outreachChannel.upsert({ where: { workspaceId_channel: { workspaceId, channel } }, create: { workspaceId, channel, enabled: true }, update: { enabled: true } });
}

const person = (over: Record<string, unknown> = {}) => ({
  name: "Marie Roy", company: "Plomberie Roy", email: "marie@roy.ca", source: "Site public de l'entreprise", collectedAt: collected, legalBasis: "implied_published", ...over,
});

describe("catalogue", () => {
  it("crée les trois fiches une seule fois, hors commercialisation, sans toucher une fiche modifiée", async () => {
    const { workspaceId, driver } = await setup();
    expect(await db.product.count({ where: { workspaceId } })).toBe(3);
    await db.product.update({ where: { id: driver.id }, data: { name: "DriverPilot (modifié)" } });
    const again = await ensureDefaultProducts(workspaceId);
    expect(again.created).toEqual([]);
    expect((await db.product.findUniqueOrThrow({ where: { id: driver.id } })).name).toBe("DriverPilot (modifié)");
    expect((await db.product.findMany({ where: { workspaceId } })).every((p) => p.status !== "commercialisation")).toBe(true);
  });
  it("seuls admin et propriétaire gèrent le catalogue et approuvent", () => {
    for (const r of ["admin", "owner"]) { expect(can(r, "manage_products")).toBe(true); expect(can(r, "approve_outreach")).toBe(true); }
    for (const r of ["member", "viewer"]) { expect(can(r, "manage_products")).toBe(false); expect(can(r, "approve_outreach")).toBe(false); }
  });
});

describe("prospects : déduplication globale et attribution", () => {
  it("la même personne n'est créée qu'une fois ; l'autre produit est noté comme intérêt sans réattribution", async () => {
    const { workspaceId, driver, nexa } = await setup();
    const a = await addProspect(workspaceId, person({ productId: driver.id }));
    expect(a.kind).toBe("created");
    const b = await addProspect(workspaceId, person({ email: " MARIE@roy.ca ", productId: nexa.id }));
    expect(b).toMatchObject({ kind: "duplicate", interestAdded: true });
    const c = await addProspect(workspaceId, person({ productId: nexa.id }));
    expect(c).toMatchObject({ kind: "duplicate", interestAdded: false });
    expect(await db.prospect.count({ where: { workspaceId } })).toBe(1);
    const p = await db.prospect.findFirstOrThrow({ where: { workspaceId } });
    expect(p.productId).toBe(driver.id);
    expect(await db.prospectProduct.count({ where: { prospectId: p.id, productId: nexa.id } })).toBe(1);
  });
  it("exige provenance et date de collecte valides", async () => {
    const { workspaceId, driver } = await setup();
    await expect(addProspect(workspaceId, person({ source: " ", productId: driver.id }))).rejects.toThrow(PortfolioError);
    await expect(addProspect(workspaceId, person({ collectedAt: new Date("x"), productId: driver.id }))).rejects.toThrow(PortfolioError);
    await expect(addProspect(workspaceId, person({ email: null, productId: driver.id }))).rejects.toThrow(PortfolioError);
  });
  it("les créations concurrentes de la même personne ne produisent qu'une fiche", async () => {
    const { workspaceId, driver } = await setup();
    const rs = await Promise.all(Array.from({ length: 5 }, () => addProspect(workspaceId, person({ productId: driver.id }))));
    expect(rs.filter((r) => r.kind === "created")).toHaveLength(1);
    expect(await db.prospect.count({ where: { workspaceId } })).toBe(1);
  });
  it("une adresse déjà désinscrite arrive en « ne pas contacter »", async () => {
    const { workspaceId, driver } = await setup();
    await db.emailSuppression.create({ data: { workspaceId, email: "marie@roy.ca", reason: "unsubscribe" } });
    const r = await addProspect(workspaceId, person({ productId: driver.id }));
    expect(r.prospect.status).toBe("do_not_contact");
    expect(r.prospect.optedOutAt).not.toBeNull();
  });
  it("la réattribution exige un motif, détache de la campagne et garde l'ancien produit comme intérêt", async () => {
    const { workspaceId, driver, nexa } = await setup();
    const { prospect } = await addProspect(workspaceId, person({ productId: driver.id }));
    await expect(reassignProspect({ workspaceId, prospectId: prospect.id, toProductId: nexa.id, reason: "" })).rejects.toThrow(PortfolioError);
    const u = await reassignProspect({ workspaceId, prospectId: prospect.id, toProductId: nexa.id, reason: "Travailleur autonome, pas chauffeur" });
    expect(u.productId).toBe(nexa.id);
    expect(await db.prospectProduct.count({ where: { prospectId: prospect.id, productId: driver.id } })).toBe(1);
    const log = await db.auditLog.findFirst({ where: { workspaceId, action: "prospect.reassigned" } });
    expect(log).not.toBeNull();
  });
});

describe("import CSV", () => {
  it("importe, déduplique et rapporte les rejets ; un rejeu ne duplique rien", async () => {
    const { workspaceId, actor } = await (async () => { const s = await setup(); return { ...s, actor: s.userId }; })();
    const csv = "nom;entreprise;courriel;source;date de collecte;base légale;produit\n" +
      "Marie Roy;Plomberie Roy;marie@roy.ca;Site public;2026-10-01;adresse publiée;operapilot\n" +
      "Marie Roy;Plomberie Roy;MARIE@roy.ca;Registre;2026-10-02;adresse publiée;driverpilot\n" +
      "Paul Gagnon;Taxi G;paul@taxig.ca;Association;2026-10-01;consentement exprès;produit-inexistant\n";
    const parsed = parseProspectCsv(csv);
    expect(parsed.errors).toEqual([]);
    const first = await importProspects(workspaceId, parsed.rows, { batch: "b1", actorId: actor });
    expect(first).toMatchObject({ created: 1, duplicates: 1, interestsAdded: 1 });
    expect(first.rejected).toHaveLength(1);
    const second = await importProspects(workspaceId, parsed.rows, { batch: "b2", actorId: actor });
    expect(second.created).toBe(0);
    expect(await db.prospect.count({ where: { workspaceId } })).toBe(1);
  });
  it("aucune donnée ne passe d'un espace de travail à l'autre", async () => {
    const a = await setup();
    const b = await setup();
    await addProspect(a.workspaceId, person({ productId: a.driver.id }));
    const r = await addProspect(b.workspaceId, person({ productId: b.driver.id }));
    expect(r.kind).toBe("created");
    await expect(addProspect(b.workspaceId, person({ email: "x@y.co", productId: a.driver.id }))).rejects.toThrow(PortfolioError);
    expect(await db.prospect.count({ where: { workspaceId: a.workspaceId } })).toBe(1);
  });
});

describe("contact : éligibilité, consignation, désinscription", () => {
  it("refuse tant que le produit n'est pas commercialisé et que le canal est désactivé, sans rien consigner", async () => {
    const { workspaceId, driver } = await setup();
    const { prospect } = await addProspect(workspaceId, person({ productId: driver.id }));
    const r = await logContact({ workspaceId, prospectId: prospect.id, productId: driver.id, channel: "email" });
    expect(r.eligibility.ok).toBe(false);
    expect(await db.prospectContact.count({ where: { workspaceId } })).toBe(0);
    expect((await db.prospect.findUniqueOrThrow({ where: { id: prospect.id } })).contactCount).toBe(0);
    expect(await db.auditLog.count({ where: { workspaceId, action: "prospect.contact_refused" } })).toBe(1);
  });
  it("consigne un contact conforme puis applique la fréquence minimale", async () => {
    const { workspaceId, driver } = await setup();
    await commercialise(workspaceId, driver.id);
    const { prospect } = await addProspect(workspaceId, person({ productId: driver.id }));
    const now = new Date("2026-11-01T10:00:00Z");
    const tpl = await db.messageTemplate.create({ data: { workspaceId, productId: driver.id, name: "T", channel: "email", body: "Bonjour, message approuvé.", status: "approved" } });
    const ok = await logContact({ workspaceId, prospectId: prospect.id, productId: driver.id, channel: "email", templateId: tpl.id, summary: "Premier message", now });
    expect(ok.eligibility.ok).toBe(true);
    expect(ok.prospect).toMatchObject({ contactCount: 1, status: "contacted" });
    const tooSoon = await logContact({ workspaceId, prospectId: prospect.id, productId: driver.id, channel: "email", templateId: tpl.id, now: new Date("2026-11-03T10:00:00Z") });
    expect(tooSoon.eligibility.ok).toBe(false);
    const later7 = await logContact({ workspaceId, prospectId: prospect.id, productId: driver.id, channel: "email", templateId: tpl.id, now: new Date("2026-11-09T10:00:00Z") });
    expect(later7.eligibility.ok).toBe(true);
  });
  it("une personne attribuée à un produit ne peut pas être contactée pour un autre", async () => {
    const { workspaceId, driver, nexa } = await setup();
    await commercialise(workspaceId, driver.id);
    await commercialise(workspaceId, nexa.id);
    const { prospect } = await addProspect(workspaceId, person({ productId: driver.id }));
    const r = await checkEligibility({ workspaceId, prospectId: prospect.id, productId: nexa.id, channel: "email" });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/autre produit/);
  });
  it("une désinscription bloque tous les produits, est idempotente et alimente la liste de suppression", async () => {
    const { workspaceId, driver, nexa } = await setup();
    await commercialise(workspaceId, driver.id);
    await commercialise(workspaceId, nexa.id);
    const { prospect } = await addProspect(workspaceId, person({ productId: driver.id }));
    await optOutProspect({ workspaceId, prospectId: prospect.id });
    await optOutProspect({ workspaceId, prospectId: prospect.id });
    expect(await db.emailSuppression.count({ where: { workspaceId, email: "marie@roy.ca" } })).toBe(1);
    expect(await db.auditLog.count({ where: { workspaceId, action: "prospect.opted_out" } })).toBe(1);
    for (const productId of [driver.id, nexa.id]) {
      expect((await checkEligibility({ workspaceId, prospectId: prospect.id, productId, channel: "email" })).ok).toBe(false);
    }
  });
  it("une réponse avec opposition désinscrit ; une réponse simple passe le prospect à « a répondu »", async () => {
    const { workspaceId, driver } = await setup();
    const a = await addProspect(workspaceId, person({ productId: driver.id }));
    const r1 = await logReply({ workspaceId, prospectId: a.prospect.id, channel: "email", summary: "Intéressé" });
    expect(r1.status).toBe("replied");
    const r2 = await logReply({ workspaceId, prospectId: a.prospect.id, channel: "email", optOut: true });
    expect(r2.status).toBe("do_not_contact");
  });
});

describe("campagnes de prospection", () => {
  it("l'approbation exige produit commercialisé, canal activé et modèle approuvé ; un prospect n'est que dans une campagne", async () => {
    const { workspaceId, driver, nexa } = await setup();
    const c = await db.outreachCampaign.create({ data: { workspaceId, productId: driver.id, name: "Test", channel: "email", status: "pending_approval" } });
    await expect(approveOutreachCampaign({ workspaceId, campaignId: c.id })).rejects.toThrow(/Approbation impossible/);
    await commercialise(workspaceId, driver.id);
    const tpl = await db.messageTemplate.create({ data: { workspaceId, productId: driver.id, name: "T", channel: "email", body: "Bonjour", status: "approved" } });
    await db.outreachCampaign.update({ where: { id: c.id }, data: { templateId: tpl.id } });
    await approveOutreachCampaign({ workspaceId, campaignId: c.id });
    expect((await db.outreachCampaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("active");

    const { prospect } = await addProspect(workspaceId, person({ productId: driver.id }));
    await attachProspectToCampaign({ workspaceId, campaignId: c.id, prospectId: prospect.id });
    const c2 = await db.outreachCampaign.create({ data: { workspaceId, productId: driver.id, name: "Autre", channel: "email" } });
    await expect(attachProspectToCampaign({ workspaceId, campaignId: c2.id, prospectId: prospect.id })).rejects.toThrow(/une seule à la fois/);
    const c3 = await db.outreachCampaign.create({ data: { workspaceId, productId: nexa.id, name: "Autre produit", channel: "email" } });
    await expect(attachProspectToCampaign({ workspaceId, campaignId: c3.id, prospectId: prospect.id })).rejects.toThrow(/pas attribué/);
  });
});

describe("conversions et indicateurs", () => {
  it("ne comptabilise jamais deux fois la même conversion (rejeu, double saisie, concurrence)", async () => {
    const { workspaceId, driver } = await setup();
    const { prospect } = await addProspect(workspaceId, person({ productId: driver.id }));
    const rec = (over: Record<string, unknown> = {}) => recordProductEvent({ workspaceId, productId: driver.id, prospectId: prospect.id, type: "signup", occurredAt: later, ...over } as never);
    const rs = await Promise.all([rec(), rec(), rec()]);
    expect(rs.filter((r) => r.created)).toHaveLength(1);
    const pay = { type: "payment_confirmed", amount: 9.99, currency: "CAD", externalRef: "INV-2026-001" };
    expect((await rec(pay)).created).toBe(true);
    expect((await rec({ ...pay, occurredAt: new Date("2027-01-01") })).created).toBe(false);
    expect(await db.productEvent.count({ where: { workspaceId } })).toBe(2);
  });
  it("exige montant, devise et traçabilité", async () => {
    const { workspaceId, driver } = await setup();
    const { prospect } = await addProspect(workspaceId, person({ productId: driver.id }));
    const base = { workspaceId, productId: driver.id, occurredAt: later };
    await expect(recordProductEvent({ ...base, prospectId: prospect.id, type: "payment_confirmed" })).rejects.toThrow(PortfolioError);
    await expect(recordProductEvent({ ...base, prospectId: prospect.id, type: "payment_confirmed", amount: 10 })).rejects.toThrow(/devise/);
    await expect(recordProductEvent({ ...base, type: "signup" })).rejects.toThrow(/traçabilité/);
  });
  it("attribue prospects, conversions et revenus au bon produit, sans mélanger les devises", async () => {
    const { workspaceId, driver, nexa } = await setup();
    const a = await addProspect(workspaceId, person({ productId: driver.id }));
    const b = await addProspect(workspaceId, person({ name: "Paul", email: "paul@x.ca", company: "X", productId: nexa.id }));
    await recordProductEvent({ workspaceId, productId: driver.id, prospectId: a.prospect.id, type: "payment_confirmed", amount: 30, currency: "CAD", externalRef: "A1", occurredAt: later });
    await recordProductEvent({ workspaceId, productId: driver.id, prospectId: a.prospect.id, type: "payment_confirmed", amount: 5, currency: "USD", externalRef: "A2", occurredAt: later });
    await recordProductEvent({ workspaceId, productId: nexa.id, prospectId: b.prospect.id, type: "trial_started", occurredAt: later });
    const s = await portfolioStats(workspaceId);
    const d = s.find((x) => x.productId === driver.id)!;
    const n = s.find((x) => x.productId === nexa.id)!;
    expect(d.events.payment_confirmed).toBe(2);
    expect(d.revenue.sort((x, y) => x.currency.localeCompare(y.currency))).toEqual([{ currency: "CAD", amount: 30 }, { currency: "USD", amount: 5 }]);
    expect(d.prospects.customer).toBe(1);
    expect(n.events.trial_started).toBe(1);
    expect(n.revenue).toEqual([]);
    expect(n.prospects.trial).toBe(1);
  });
  it("les leads entrants gardent leur compatibilité : produit déduit de la campagne, null sinon", async () => {
    const { workspaceId, driver } = await setup();
    const camp = await db.campaign.create({ data: { workspaceId, name: "Pub", productId: driver.id } });
    const withProduct = await createLead({ workspaceId, name: "Lead A", email: "lead-a@x.ca", campaignId: camp.id });
    expect(withProduct.lead.productId).toBe(driver.id);
    const legacy = await createLead({ workspaceId, name: "Lead B", email: "lead-b@x.ca" });
    expect(legacy.lead.productId).toBeNull();
    const s = (await portfolioStats(workspaceId)).find((x) => x.productId === driver.id)!;
    expect(s.inboundLeads).toBe(1);
  });
});
