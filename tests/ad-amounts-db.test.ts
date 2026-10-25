import { beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { adAmountChecks } from "@/lib/ad-amounts";
import { makeWorkspace, resetDb } from "./helpers";

beforeEach(resetDb);

async function offerIn(workspaceId: string, over: { price?: number | null; currency?: string; name?: string } = {}) {
  return db.offer.create({ data: { workspaceId, name: over.name ?? "Offre", price: over.price === undefined ? 49 : over.price, currency: over.currency ?? "CAD", status: "active" } });
}
async function adIn(workspaceId: string, over: { headline?: string; source?: string; generationId?: string | null; campaignId?: string | null } = {}) {
  return db.ad.create({
    data: { workspaceId, platform: "meta_ads", headline: over.headline ?? "Dès 49 CAD par mois", source: over.source ?? "ai", generationId: over.generationId ?? null, campaignId: over.campaignId ?? null, status: "draft" },
  });
}
const gen = (workspaceId: string, input: unknown) => db.aIGeneration.create({ data: { workspaceId, kind: "ad_copy", input: input as object } });

/** Charge exactement ce que charge la page AI Studio : annonces avec campagne, et offres de l'espace. */
async function run(workspaceId: string) {
  const [ads, offers] = await Promise.all([
    db.ad.findMany({ where: { workspaceId }, include: { campaign: { select: { offerId: true } } } }),
    db.offer.findMany({ where: { workspaceId } }),
  ]);
  return adAmountChecks(workspaceId, ads, offers);
}

describe("verdict des montants des annonces IA (base réelle de test)", () => {
  it("prix et devise égaux à ceux de l'offre de la génération : confirmé, sans campagne", async () => {
    const { workspaceId } = await makeWorkspace();
    const o = await offerIn(workspaceId, { price: 49, currency: "CAD" });
    const g = await gen(workspaceId, { platform: "meta_ads", offerId: o.id });
    const a = await adIn(workspaceId, { generationId: g.id });
    expect((await run(workspaceId)).get(a.id)).toMatchObject({ state: "confirmed", unconfirmed: [] });
  });

  it("montant incorrect : non confirmé ; devise différente : signalée ; « $ » seul : ambiguë", async () => {
    const { workspaceId } = await makeWorkspace();
    const o = await offerIn(workspaceId, { price: 49, currency: "CAD" });
    const g = await gen(workspaceId, { offerId: o.id });
    const wrong = await adIn(workspaceId, { generationId: g.id, headline: "Dès 29 CAD" });
    const cur = await adIn(workspaceId, { generationId: g.id, headline: "Dès 49 €" });
    const amb = await adIn(workspaceId, { generationId: g.id, headline: "Dès 49 $" });
    const r = await run(workspaceId);
    expect(r.get(wrong.id)?.state).toBe("unconfirmed");
    expect(r.get(cur.id)?.state).toBe("currency_mismatch");
    expect(r.get(amb.id)?.state).toBe("currency_ambiguous");
  });

  it("l'offre de la génération est prioritaire sur celle de la campagne", async () => {
    const { workspaceId } = await makeWorkspace();
    const gOffer = await offerIn(workspaceId, { price: 49, currency: "CAD" });
    const cOffer = await offerIn(workspaceId, { price: 99, currency: "CAD" });
    const camp = await db.campaign.create({ data: { workspaceId, name: "C", offerId: cOffer.id } });
    const g = await gen(workspaceId, { offerId: gOffer.id });
    const a = await adIn(workspaceId, { generationId: g.id, campaignId: camp.id, headline: "Dès 49 CAD" });
    const b = await adIn(workspaceId, { generationId: g.id, campaignId: camp.id, headline: "Dès 99 CAD" });
    const r = await run(workspaceId);
    expect(r.get(a.id)?.state).toBe("confirmed");
    expect(r.get(b.id)?.state).toBe("unconfirmed"); // 99 est le prix de la campagne, pas celui de l'offre de la génération
  });

  it("offre de génération supprimée : repli sur l'offre valide de la campagne", async () => {
    const { workspaceId } = await makeWorkspace();
    const gOffer = await offerIn(workspaceId, { price: 49, currency: "CAD" });
    const cOffer = await offerIn(workspaceId, { price: 59, currency: "CAD" });
    const camp = await db.campaign.create({ data: { workspaceId, name: "C", offerId: cOffer.id } });
    const g = await gen(workspaceId, { offerId: gOffer.id });
    await db.offer.delete({ where: { id: gOffer.id } });
    const a = await adIn(workspaceId, { generationId: g.id, campaignId: camp.id, headline: "Dès 59 CAD" });
    expect((await run(workspaceId)).get(a.id)?.state).toBe("confirmed");
  });

  it("générations et campagnes invalides ou absentes : offre introuvable, jamais confirmé", async () => {
    const { workspaceId } = await makeWorkspace();
    const o = await offerIn(workspaceId, { price: 49, currency: "CAD" });
    const gDeleted = await gen(workspaceId, { offerId: o.id });
    const gBad = await gen(workspaceId, "pas un objet");
    const gNoOffer = await gen(workspaceId, { platform: "meta_ads" });
    const camp = await db.campaign.create({ data: { workspaceId, name: "C" } }); // campagne sans offre
    await db.offer.delete({ where: { id: o.id } });
    const ids = [
      (await adIn(workspaceId, { generationId: gDeleted.id })).id,
      (await adIn(workspaceId, { generationId: gBad.id })).id,
      (await adIn(workspaceId, { generationId: gNoOffer.id, campaignId: camp.id })).id,
      (await adIn(workspaceId, {})).id,
    ];
    const r = await run(workspaceId);
    for (const id of ids) expect(r.get(id)).toMatchObject({ state: "unlinked", unconfirmed: ["49 CAD"] });
  });

  it("génération supprimée (annonce détachée) : repli campagne, sinon introuvable", async () => {
    const { workspaceId } = await makeWorkspace();
    const o = await offerIn(workspaceId, { price: 49, currency: "CAD" });
    const camp = await db.campaign.create({ data: { workspaceId, name: "C", offerId: o.id } });
    const g = await gen(workspaceId, { offerId: o.id });
    const withCamp = await adIn(workspaceId, { generationId: g.id, campaignId: camp.id });
    const alone = await adIn(workspaceId, { generationId: g.id });
    await db.aIGeneration.delete({ where: { id: g.id } }); // clé étrangère SetNull
    const r = await run(workspaceId);
    expect(r.get(withCamp.id)?.state).toBe("confirmed");
    expect(r.get(alone.id)?.state).toBe("unlinked");
  });

  it("isolation : l'offre ou la génération d'un autre espace ne peut jamais confirmer un montant", async () => {
    const a = await makeWorkspace("A");
    const b = await makeWorkspace("B");
    const foreignOffer = await offerIn(a.workspaceId, { price: 49, currency: "CAD" });
    const foreignGen = await gen(a.workspaceId, { offerId: foreignOffer.id });
    await offerIn(b.workspaceId, { price: 10, currency: "CAD" });
    // annonce de B qui référence la génération (et donc l'offre) de A
    const adB = await adIn(b.workspaceId, { generationId: foreignGen.id, headline: "Dès 49 CAD" });
    // annonce de B dont la génération (de B) pointe vers une offre de A
    const gB = await gen(b.workspaceId, { offerId: foreignOffer.id });
    const adB2 = await adIn(b.workspaceId, { generationId: gB.id, headline: "Dès 49 CAD" });
    const r = await run(b.workspaceId);
    expect(r.get(adB.id)?.state).toBe("unlinked");
    expect(r.get(adB2.id)?.state).toBe("unlinked");
    // et A n'est pas affecté
    const adA = await adIn(a.workspaceId, { generationId: foreignGen.id });
    expect((await run(a.workspaceId)).get(adA.id)?.state).toBe("confirmed");
  });

  it("annonce manuelle : non contrôlée ; annonce sans montant : aucun signalement ; statut inchangé", async () => {
    const { workspaceId } = await makeWorkspace();
    const o = await offerIn(workspaceId, { price: 49, currency: "CAD" });
    const g = await gen(workspaceId, { offerId: o.id });
    const manual = await adIn(workspaceId, { source: "user", headline: "Dès 5 CAD" });
    const none = await adIn(workspaceId, { generationId: g.id, headline: "Gagnez du temps" });
    const r = await run(workspaceId);
    expect(r.has(manual.id)).toBe(false);
    expect(r.get(none.id)?.state).toBe("no_amount");
    expect((await db.ad.findUniqueOrThrow({ where: { id: manual.id } })).status).toBe("draft");
  });

  it("lecture seule : aucune annonce ni génération n'est modifiée", async () => {
    const { workspaceId } = await makeWorkspace();
    const o = await offerIn(workspaceId, { price: null });
    const g = await gen(workspaceId, { offerId: o.id });
    await adIn(workspaceId, { generationId: g.id, headline: "Dès 49 $" });
    const before = JSON.stringify(await db.ad.findMany({ where: { workspaceId } }));
    await run(workspaceId);
    expect(JSON.stringify(await db.ad.findMany({ where: { workspaceId } }))).toBe(before);
    expect(await db.ad.count({ where: { workspaceId } })).toBe(1);
  });
});
