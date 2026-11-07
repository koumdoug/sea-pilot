import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { addProspect, approveOutreachCampaign, attachProspectToCampaign, ensureDefaultProducts, optOutProspect, PortfolioError, recordProductEvent } from "@/lib/portfolio/service";
import { setRetryTimingForTests } from "@/lib/followup-runtime";
import { makeWorkspace, resetDb } from "./helpers";

// D2 — rattachement à une campagne, approbation de campagne et conversions : contrôles ET écriture dans une seule transaction, écriture CONDITIONNELLE, rejeu sans effet.
// Une modification « concurrente » est simulée DANS la transaction réelle, juste avant l'écriture visée (mêmes effets qu'une validation intercalée sous READ COMMITTED ; SQLite n'a qu'une
// connexion). La vraie concurrence entre connexions est exercée sur PostgreSQL dans tests/pg-portfolio-suppression-race.test.ts.

const EMAIL = "marie@roy.ca";
const collected = new Date("2026-10-01T00:00:00Z");
const person = (over: Record<string, unknown> = {}) => ({ name: "Marie Roy", company: "Plomberie Roy", email: EMAIL, source: "Site public de l'entreprise", collectedAt: collected, legalBasis: "implied_published", ...over });

type TxFn = (tx: unknown) => Promise<unknown>;
type AnyTx = { [model: string]: { [method: string]: (...a: unknown[]) => Promise<unknown> } };
/**
 * `tx.<model>.<method>` : `before(tx)` s'exécute (dans la MÊME transaction) juste avant l'appel réel, ou `fail` est levée à la place. Compte les transactions ouvertes.
 */
function intercept(model: string, method: string, o: { before?: (tx: AnyTx) => Promise<void>; fail?: (n: number) => unknown | null }) {
  const real = db.$transaction.bind(db) as unknown as (fn: TxFn, opts?: unknown) => Promise<unknown>;
  const state = { attempts: 0, calls: 0 };
  vi.spyOn(db, "$transaction").mockImplementation(((fn: TxFn, opts?: unknown) => {
    state.attempts++;
    return real((tx) => fn(new Proxy(tx as object, {
      get: (t, k, r) => (k === model
        ? new Proxy(Reflect.get(t, k, r) as object, {
            get: (m, name, rr) => (name === method
              ? async (...a: unknown[]) => {
                  state.calls++;
                  const e = o.fail?.(state.calls); if (e) throw e;
                  await o.before?.(tx as AnyTx);
                  return (m as Record<string, (...x: unknown[]) => unknown>)[method](...a);
                }
              : Reflect.get(m, name, rr)),
          })
        : Reflect.get(t, k, r)),
    })), opts);
  }) as never);
  return state;
}

beforeEach(async () => { await resetDb(); setRetryTimingForTests({ sleep: async () => {}, jitter: () => 0 }); });
afterEach(() => { vi.restoreAllMocks(); setRetryTimingForTests(null); });

async function setup() {
  const a = await makeWorkspace("Portfolio");
  await ensureDefaultProducts(a.workspaceId, a.userId);
  const products = await db.product.findMany({ where: { workspaceId: a.workspaceId } });
  const by = (slug: string) => products.find((x) => x.slug === slug)!;
  const driver = by("driverpilot"), nexa = by("freelancenexa");
  const { prospect } = await addProspect(a.workspaceId, person({ productId: driver.id }));
  const campaign = await db.outreachCampaign.create({ data: { workspaceId: a.workspaceId, productId: driver.id, name: "C1", channel: "email", status: "active" } });
  return { ...a, driver, nexa, prospect, campaign };
}
/** Campagne prête à être approuvée (produit commercialisé, canal activé, modèle approuvé). */
async function approvable(workspaceId: string, productId: string) {
  await db.product.update({ where: { id: productId }, data: { status: "commercialisation" } });
  await db.outreachChannel.upsert({ where: { workspaceId_channel: { workspaceId, channel: "email" } }, create: { workspaceId, channel: "email", enabled: true }, update: { enabled: true } });
  const tpl = await db.messageTemplate.create({ data: { workspaceId, productId, name: "T", channel: "email", body: "Bonjour", status: "approved" } });
  return db.outreachCampaign.create({ data: { workspaceId, productId, name: "À approuver", channel: "email", status: "pending_approval", templateId: tpl.id } });
}
const row = (id: string) => db.prospect.findUniqueOrThrow({ where: { id } });
const audits = (workspaceId: string, action: string) => db.auditLog.count({ where: { workspaceId, action } });

describe("attachProspectToCampaign — contrôles et écriture conditionnelle dans une transaction", () => {
  it("rattachement normal : campagne enregistrée, audit unique ; rejeu dans la même campagne : aucun nouvel audit", async () => {
    const { workspaceId, prospect, campaign } = await setup();
    await attachProspectToCampaign({ workspaceId, campaignId: campaign.id, prospectId: prospect.id });
    expect((await row(prospect.id)).campaignId).toBe(campaign.id);
    expect(await audits(workspaceId, "outreach.prospect_attached")).toBe(1);
    await attachProspectToCampaign({ workspaceId, campaignId: campaign.id, prospectId: prospect.id });
    expect((await row(prospect.id)).campaignId).toBe(campaign.id);
    expect(await audits(workspaceId, "outreach.prospect_attached")).toBe(1);
  });

  it("opposition intercalée entre la lecture et l'écriture : AUCUN rattachement, erreur d'opposition, aucun audit", async () => {
    const { workspaceId, prospect, campaign } = await setup();
    intercept("prospect", "updateMany", { before: async (tx) => { await tx.prospect.update({ where: { id: prospect.id }, data: { status: "do_not_contact", optedOutAt: new Date() } }); } });
    // L'erreur prouve que l'écriture conditionnelle n'a trouvé aucune ligne (count 0) : sans elle, la campagne aurait été écrite sur un prospect désinscrit.
    await expect(attachProspectToCampaign({ workspaceId, campaignId: campaign.id, prospectId: prospect.id })).rejects.toThrow(/opposé/);
    vi.restoreAllMocks();
    expect((await row(prospect.id)).campaignId).toBeNull();
    expect(await audits(workspaceId, "outreach.prospect_attached")).toBe(0);
  });

  it("autre campagne rejointe entre la lecture et l'écriture : refus « une seule à la fois »", async () => {
    const { workspaceId, prospect, driver, campaign } = await setup();
    const other = await db.outreachCampaign.create({ data: { workspaceId, productId: driver.id, name: "C2", channel: "email" } });
    intercept("prospect", "updateMany", { before: async (tx) => { await tx.prospect.update({ where: { id: prospect.id }, data: { campaignId: other.id } }); } });
    await expect(attachProspectToCampaign({ workspaceId, campaignId: campaign.id, prospectId: prospect.id })).rejects.toThrow(/une seule à la fois/);
    vi.restoreAllMocks();
    expect(await audits(workspaceId, "outreach.prospect_attached")).toBe(0);
  });

  it("prospect effacé entre la lecture et l'écriture : introuvable", async () => {
    const { workspaceId, prospect, campaign } = await setup();
    intercept("prospect", "updateMany", { before: async (tx) => { await tx.prospect.update({ where: { id: prospect.id }, data: { deletedAt: new Date() } }); } });
    await expect(attachProspectToCampaign({ workspaceId, campaignId: campaign.id, prospectId: prospect.id })).rejects.toThrow(/introuvable/);
  });

  it("prospect d'un autre espace, d'un autre produit, déjà désinscrit : refusé, rien d'écrit", async () => {
    const { workspaceId, prospect, campaign, nexa } = await setup();
    const foreign = await setup();
    await expect(attachProspectToCampaign({ workspaceId, campaignId: campaign.id, prospectId: foreign.prospect.id })).rejects.toBeInstanceOf(PortfolioError);
    const other = await db.outreachCampaign.create({ data: { workspaceId, productId: nexa.id, name: "Autre produit", channel: "email" } });
    await expect(attachProspectToCampaign({ workspaceId, campaignId: other.id, prospectId: prospect.id })).rejects.toThrow(/pas attribué/);
    await optOutProspect({ workspaceId, prospectId: prospect.id });
    await expect(attachProspectToCampaign({ workspaceId, campaignId: campaign.id, prospectId: prospect.id })).rejects.toThrow(/opposé/);
    expect((await row(prospect.id)).campaignId).toBeNull();
    expect((await row(foreign.prospect.id)).campaignId).toBeNull();
  });
});

describe("approveOutreachCampaign — contrôles relus dans la transaction, transition conditionnelle", () => {
  it("approbation normale : campagne active, approbateur et date enregistrés, audit unique ; rejeu : aucun second audit", async () => {
    const { workspaceId, userId, driver } = await setup();
    const c = await approvable(workspaceId, driver.id);
    await approveOutreachCampaign({ workspaceId, campaignId: c.id, actorId: userId });
    const a = await db.outreachCampaign.findUniqueOrThrow({ where: { id: c.id } });
    expect([a.status, a.approvedById]).toEqual(["active", userId]);
    expect(a.approvedAt).not.toBeNull();
    await approveOutreachCampaign({ workspaceId, campaignId: c.id, actorId: userId });
    expect(await audits(workspaceId, "outreach.campaign_approved")).toBe(1);
  });

  it("quatre approbations simultanées : toutes réussissent, UNE seule transition, UN seul audit", async () => {
    const { workspaceId, userId, driver } = await setup();
    const c = await approvable(workspaceId, driver.id);
    await Promise.all([1, 2, 3, 4].map(() => approveOutreachCampaign({ workspaceId, campaignId: c.id, actorId: userId })));
    expect((await db.outreachCampaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("active");
    expect(await audits(workspaceId, "outreach.campaign_approved")).toBe(1);
  });

  it("approuvée par un autre traitement entre les contrôles et l'écriture : succès sans second audit de notre part", async () => {
    const { workspaceId, driver } = await setup();
    const c = await approvable(workspaceId, driver.id);
    intercept("outreachCampaign", "updateMany", { before: async (tx) => { await tx.outreachCampaign.update({ where: { id: c.id }, data: { status: "active", approvedAt: new Date() } }); } });
    await expect(approveOutreachCampaign({ workspaceId, campaignId: c.id })).resolves.toBeUndefined();
    expect(await audits(workspaceId, "outreach.campaign_approved")).toBe(0);
  });

  it("campagne mise en pause entre les contrôles et l'écriture : refus, jamais d'activation", async () => {
    const { workspaceId, driver } = await setup();
    const c = await approvable(workspaceId, driver.id);
    intercept("outreachCampaign", "updateMany", { before: async (tx) => { await tx.outreachCampaign.update({ where: { id: c.id }, data: { status: "paused" } }); } });
    await expect(approveOutreachCampaign({ workspaceId, campaignId: c.id })).rejects.toThrow(/a changé/);
    vi.restoreAllMocks();
    expect((await db.outreachCampaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("pending_approval");
    expect(await audits(workspaceId, "outreach.campaign_approved")).toBe(0);
  });

  it("conditions non remplies (modèle non approuvé, canal désactivé) : refus listant les causes, campagne inchangée ; campagne d'un autre espace : introuvable", async () => {
    const { workspaceId, driver } = await setup();
    const c = await approvable(workspaceId, driver.id);
    await db.outreachChannel.update({ where: { workspaceId_channel: { workspaceId, channel: "email" } }, data: { enabled: false } });
    await db.messageTemplate.updateMany({ where: { workspaceId }, data: { status: "draft" } });
    await expect(approveOutreachCampaign({ workspaceId, campaignId: c.id })).rejects.toThrow(/canal est désactivé.*modèle de message approuvé/);
    expect((await db.outreachCampaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("pending_approval");
    const other = await setup();
    await expect(approveOutreachCampaign({ workspaceId: other.workspaceId, campaignId: c.id })).rejects.toThrow(/introuvable/);
  });
});

describe("recordProductEvent — conversion ET changement de statut ensemble", () => {
  const ev = (workspaceId: string, productId: string, prospectId: string, over: Record<string, unknown> = {}) =>
    recordProductEvent({ workspaceId, productId, prospectId, type: "trial_started", occurredAt: new Date("2026-12-01T00:00:00Z"), ...over } as never);

  it("conversion normale : événement enregistré, statut du prospect mis à jour (campagne détachée), audit unique", async () => {
    const { workspaceId, driver, prospect, campaign } = await setup();
    await db.prospect.update({ where: { id: prospect.id }, data: { campaignId: campaign.id } });
    const r = await ev(workspaceId, driver.id, prospect.id);
    expect(r.created).toBe(true);
    expect(await row(prospect.id)).toMatchObject({ status: "trial", campaignId: null });
    expect(await audits(workspaceId, "product_event.recorded")).toBe(1);
  });

  it("échec du changement de statut : AUCUN événement conservé ; le rejeu enregistre ensuite la conversion ET applique le statut", async () => {
    const { workspaceId, driver, prospect } = await setup();
    intercept("prospect", "updateMany", { fail: () => new Error("mise à jour impossible") });
    await expect(ev(workspaceId, driver.id, prospect.id)).rejects.toThrow(/mise à jour impossible/);
    vi.restoreAllMocks();
    expect(await db.productEvent.count({ where: { workspaceId } })).toBe(0); // avant le correctif : l'événement restait, et le rejeu le prenait pour un doublon
    expect((await row(prospect.id)).status).toBe("identified");
    expect((await ev(workspaceId, driver.id, prospect.id)).created).toBe(true);
    expect((await row(prospect.id)).status).toBe("trial");
  });

  it("doublon : « non créé », aucun changement de statut ni audit supplémentaire", async () => {
    const { workspaceId, driver, prospect } = await setup();
    await ev(workspaceId, driver.id, prospect.id);
    await db.prospect.update({ where: { id: prospect.id }, data: { status: "customer" } });
    expect((await ev(workspaceId, driver.id, prospect.id)).created).toBe(false);
    expect((await row(prospect.id)).status).toBe("customer");
    expect(await audits(workspaceId, "product_event.recorded")).toBe(1);
  });

  it("prospect désinscrit : la conversion est comptée, son statut « ne pas contacter » est conservé", async () => {
    const { workspaceId, driver, prospect } = await setup();
    await optOutProspect({ workspaceId, prospectId: prospect.id });
    expect((await ev(workspaceId, driver.id, prospect.id, { type: "demo" })).created).toBe(true);
    expect((await row(prospect.id)).status).toBe("do_not_contact");
  });
});
