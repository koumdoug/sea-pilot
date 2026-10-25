import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { exportWorkspace } from "@/lib/data-export";
import { duplicateCampaign } from "@/lib/campaigns";
import { addProspect, ensureDefaultProducts, eraseProspect, logContact, recordProductEvent, importProspects } from "@/lib/portfolio/service";
import { parseProspectCsv } from "@/lib/portfolio/rules";
import { makeWorkspace, resetDb } from "./helpers";

beforeEach(resetDb);

const collected = new Date("2026-10-01T00:00:00Z");

async function setup() {
  const a = await makeWorkspace("Securite");
  await ensureDefaultProducts(a.workspaceId, a.userId);
  const driver = await db.product.findFirstOrThrow({ where: { workspaceId: a.workspaceId, slug: "driverpilot" } });
  await db.product.update({ where: { id: driver.id }, data: { status: "commercialisation" } });
  await db.outreachChannel.create({ data: { workspaceId: a.workspaceId, channel: "email", enabled: true } });
  const { prospect } = await addProspect(a.workspaceId, { name: "Marie Roy", company: "Plomberie Roy", email: "marie@roy.ca", source: "Site public", collectedAt: collected, legalBasis: "implied_published", productId: driver.id });
  return { ...a, driver, prospect };
}
const tpl = (workspaceId: string, productId: string, over: Record<string, string> = {}) =>
  db.messageTemplate.create({ data: { workspaceId, productId, name: "T", channel: "email", body: "Bonjour, message de test.", status: "approved", ...over } });

describe("H1 : un contact exige un modèle approuvé", () => {
  it("refuse un contact sans modèle (null ou absent), sans rien consigner", async () => {
    const { workspaceId, driver, prospect } = await setup();
    for (const templateId of [undefined, null]) {
      const r = await logContact({ workspaceId, prospectId: prospect.id, productId: driver.id, channel: "email", templateId });
      expect(r.eligibility.ok).toBe(false);
      expect(r.eligibility.reasons.join(" ")).toMatch(/Aucun modèle/);
    }
    expect(await db.prospectContact.count({ where: { workspaceId } })).toBe(0);
    expect((await db.prospect.findUniqueOrThrow({ where: { id: prospect.id } })).contactCount).toBe(0);
  });
  it("refuse un modèle en brouillon, archivé, d'un autre produit ou d'un autre canal", async () => {
    const { workspaceId, driver, prospect } = await setup();
    const nexa = await db.product.findFirstOrThrow({ where: { workspaceId, slug: "freelancenexa" } });
    const cases = [await tpl(workspaceId, driver.id, { status: "draft" }), await tpl(workspaceId, driver.id, { status: "archived" }), await tpl(workspaceId, nexa.id), await tpl(workspaceId, driver.id, { channel: "linkedin" })];
    for (const t of cases) expect((await logContact({ workspaceId, prospectId: prospect.id, productId: driver.id, channel: "email", templateId: t.id })).eligibility.ok).toBe(false);
    expect(await db.prospectContact.count({ where: { workspaceId } })).toBe(0);
  });
  it("refuse le modèle d'un autre espace de travail", async () => {
    const { workspaceId, driver, prospect } = await setup();
    const other = await setup();
    const foreign = await tpl(other.workspaceId, other.driver.id);
    expect((await logContact({ workspaceId, prospectId: prospect.id, productId: driver.id, channel: "email", templateId: foreign.id })).eligibility.ok).toBe(false);
  });
  it("accepte un modèle approuvé du même produit et du même canal", async () => {
    const { workspaceId, driver, prospect } = await setup();
    const t = await tpl(workspaceId, driver.id);
    const r = await logContact({ workspaceId, prospectId: prospect.id, productId: driver.id, channel: "email", templateId: t.id });
    expect(r.eligibility.ok).toBe(true);
    expect(await db.prospectContact.count({ where: { workspaceId } })).toBe(1);
  });
});

describe("M1 : le statut ne régresse jamais", () => {
  it.each(["demo", "trial", "customer", "replied"])("un prospect en « %s » reste en « %s » après un contact", async (status) => {
    const { workspaceId, driver, prospect } = await setup();
    await db.prospect.update({ where: { id: prospect.id }, data: { status } });
    const t = await tpl(workspaceId, driver.id);
    const r = await logContact({ workspaceId, prospectId: prospect.id, productId: driver.id, channel: "email", templateId: t.id });
    expect(r.eligibility.ok).toBe(true);
    expect(r.prospect?.status).toBe(status);
    expect(r.prospect?.contactCount).toBe(1);
  });
  it("un prospect « identifié » passe bien à « contacté »", async () => {
    const { workspaceId, driver, prospect } = await setup();
    const t = await tpl(workspaceId, driver.id);
    expect((await logContact({ workspaceId, prospectId: prospect.id, productId: driver.id, channel: "email", templateId: t.id })).prospect?.status).toBe("contacted");
  });
});

describe("duplication de campagne : le produit est conservé", () => {
  it("la copie garde le produit de la campagne d'origine", async () => {
    const { workspaceId, driver, userId } = await setup();
    const c = await db.campaign.create({ data: { workspaceId, name: "Pub", productId: driver.id } });
    const copy = await duplicateCampaign(workspaceId, c.id, userId);
    expect(copy.productId).toBe(driver.id);
  });
});

describe("H2 : export et effacement des prospects", () => {
  it("l'export de l'espace contient les données du portefeuille, sans fuite d'un autre espace", async () => {
    const a = await setup();
    const b = await setup();
    const t = await tpl(a.workspaceId, a.driver.id);
    await logContact({ workspaceId: a.workspaceId, prospectId: a.prospect.id, productId: a.driver.id, channel: "email", templateId: t.id });
    await recordProductEvent({ workspaceId: a.workspaceId, productId: a.driver.id, prospectId: a.prospect.id, type: "signup", occurredAt: new Date("2026-11-01") });
    const ex = await exportWorkspace(a.workspaceId);
    expect(ex.products).toHaveLength(3);
    expect(ex.prospects.map((p) => p.email)).toEqual(["marie@roy.ca"]);
    expect(ex.prospectContacts).toHaveLength(1);
    expect(ex.messageTemplates).toHaveLength(1);
    expect(ex.outreachChannels).toHaveLength(1);
    expect(ex.productEvents).toHaveLength(1);
    expect(JSON.stringify(ex)).not.toContain(b.workspaceId);
  });
  it("l'effacement supprime les données personnelles, garde l'adresse en suppression et est idempotent", async () => {
    const { workspaceId, driver, prospect, userId } = await setup();
    const t = await tpl(workspaceId, driver.id);
    await logContact({ workspaceId, prospectId: prospect.id, productId: driver.id, channel: "email", templateId: t.id, summary: "Contenu personnel" });
    await recordProductEvent({ workspaceId, productId: driver.id, prospectId: prospect.id, type: "signup", occurredAt: new Date("2026-11-01"), note: "note avec nom" });
    expect(await eraseProspect({ workspaceId, prospectId: prospect.id, actorId: userId })).toBe(true);
    expect(await eraseProspect({ workspaceId, prospectId: prospect.id, actorId: userId })).toBe(true); // rejeu
    const p = await db.prospect.findUniqueOrThrow({ where: { id: prospect.id } });
    expect(p).toMatchObject({ name: "Prospect effacé", company: null, email: null, phone: null, notes: null, sourceUrl: null, status: "do_not_contact" });
    expect(p.deletedAt).not.toBeNull();
    expect(await db.prospectContact.count({ where: { workspaceId } })).toBe(0);
    expect((await db.productEvent.findFirstOrThrow({ where: { workspaceId } })).note).toBeNull();
    expect(await db.emailSuppression.count({ where: { workspaceId, email: "marie@roy.ca" } })).toBe(1);
    expect(await db.auditLog.count({ where: { workspaceId, action: "prospect.erased" } })).toBe(1);
    expect(JSON.stringify(await exportWorkspace(workspaceId))).not.toContain("marie@roy.ca");
  });
  it("une personne effacée ne peut ni être recontactée ni être réimportée comme contactable", async () => {
    const { workspaceId, driver, prospect } = await setup();
    await eraseProspect({ workspaceId, prospectId: prospect.id });
    const again = await addProspect(workspaceId, { name: "Marie Roy", email: "marie@roy.ca", source: "Autre liste", collectedAt: collected, legalBasis: "consent_express", productId: driver.id });
    expect(again.kind).toBe("created");
    expect(again.prospect.status).toBe("do_not_contact");
    const t = await tpl(workspaceId, driver.id);
    expect((await logContact({ workspaceId, prospectId: again.prospect.id, productId: driver.id, channel: "email", templateId: t.id })).eligibility.ok).toBe(false);
    const csv = parseProspectCsv("nom;courriel;source;date de collecte;produit\nMarie Roy;marie@roy.ca;Liste;2026-10-01;driverpilot");
    const sum = await importProspects(workspaceId, csv.rows, { batch: "b", actorId: null });
    expect(sum.created + sum.duplicates).toBe(1);
  });
  it("l'effacement est borné à l'espace de travail", async () => {
    const a = await setup();
    const b = await setup();
    expect(await eraseProspect({ workspaceId: b.workspaceId, prospectId: a.prospect.id })).toBe(false);
    expect((await db.prospect.findUniqueOrThrow({ where: { id: a.prospect.id } })).name).toBe("Marie Roy");
  });
});
