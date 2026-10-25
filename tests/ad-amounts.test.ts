import { describe, expect, it } from "vitest";
import { adBadge, adOfferLink, amountsIn, checkAdAmounts, currencyOf, offerFactsOf, offerIdFromGenerationInput, unconfirmedAmounts } from "@/lib/price-guard";

const offer = (price: number | null, currency: string | null | undefined, advantages: string[] = []) =>
  offerFactsOf({ price, currency, name: "Abonnement", description: null, problem: null, advantages, differentiation: null });

describe("rattachement annonce → offre (D1)", () => {
  const valid = new Set(["offA", "offC"]);
  const gens = new Map<string, string | null>([["g1", "offA"], ["g2", "offSupprimee"], ["g3", null], ["g4", "offAutreEspace"]]);
  const camps = new Map<string, string | null>([["c1", "offC"], ["c2", "offSupprimee"], ["c3", null]]);

  it("l'offre de la génération est prioritaire quand elle est valide", () => {
    expect(adOfferLink({ generationId: "g1", campaignId: "c1" }, gens, camps, valid)).toEqual({ offerId: "offA", via: "generation" });
  });
  it("offre de génération invalide (supprimée) : repli sur l'offre de campagne valide", () => {
    expect(adOfferLink({ generationId: "g2", campaignId: "c1" }, gens, camps, valid)).toEqual({ offerId: "offC", via: "campaign" });
  });
  it("offre d'un autre espace : jamais retenue, repli campagne", () => {
    expect(adOfferLink({ generationId: "g4", campaignId: "c1" }, gens, camps, valid)).toEqual({ offerId: "offC", via: "campaign" });
    expect(adOfferLink({ generationId: "g4", campaignId: "c3" }, gens, camps, valid)).toEqual({ offerId: null, via: "none" });
  });
  it("génération et campagne toutes deux invalides : aucun lien", () => {
    expect(adOfferLink({ generationId: "g2", campaignId: "c2" }, gens, camps, valid)).toEqual({ offerId: null, via: "none" });
  });
  it("génération absente ou supprimée (null) : repli campagne, sinon aucun lien", () => {
    expect(adOfferLink({ generationId: null, campaignId: "c1" }, gens, camps, valid)).toEqual({ offerId: "offC", via: "campaign" });
    expect(adOfferLink({ generationId: "inconnue", campaignId: "c1" }, gens, camps, valid)).toEqual({ offerId: "offC", via: "campaign" });
    expect(adOfferLink({ generationId: "g3", campaignId: null }, gens, camps, valid)).toEqual({ offerId: null, via: "none" });
  });
  it("JSON de génération invalide ou sans offerId", () => {
    expect(offerIdFromGenerationInput({ platform: "meta_ads", offerId: "offA" })).toBe("offA");
    for (const bad of [null, undefined, "texte", 12, [], {}, { offerId: 42 }, { offerId: "" }]) expect(offerIdFromGenerationInput(bad)).toBeNull();
  });
});

describe("devise d'un montant (D2)", () => {
  it("reconnaît les devises explicites", () => {
    const cases: [string, ReturnType<typeof currencyOf>][] = [
      ["49 €", "EUR"], ["49 EUR", "EUR"], ["49 euros", "EUR"], ["£49", "GBP"], ["49 GBP", "GBP"], ["49 CHF", "CHF"],
      ["49 CAD", "CAD"], ["CA$49", "CAD"], ["C$49", "CAD"], ["49 $ CA", "CAD"], ["49 $CAD", "CAD"], ["49 dollars canadiens", "CAD"],
      ["49 USD", "USD"], ["US$49", "USD"], ["49 $ US", "USD"], ["49 dollars américains", "USD"],
    ];
    for (const [text, cur] of cases) expect(amountsIn(text)[0]?.currency, text).toBe(cur);
  });
  it("« $ » ou « dollars » seul est ambigu", () => {
    for (const t of ["49 $", "$49", "49,00 $", "49 dollars"]) expect(amountsIn(t)[0].currency, t).toBe("DOLLAR");
  });
  it("lit les formats usuels sans régression", () => {
    expect(amountsIn("49,00 $")[0].value).toBe(49);
    expect(amountsIn("$49")[0].value).toBe(49);
    expect(amountsIn("1 299 $")[0].value).toBe(1299);
    expect(amountsIn("CA$49,90")[0].value).toBe(49.9);
    expect(amountsIn("49 €")[0].value).toBe(49);
  });
});

describe("confirmation des montants avec la devise de l'offre (D2)", () => {
  it("même montant, même devise : confirmé", () => {
    for (const [text, cur] of [["49 €", "EUR"], ["49 CAD", "CAD"], ["CA$49", "CAD"], ["US$49", "USD"], ["£49", "GBP"]] as const)
      expect(checkAdAmounts(text, offer(49, cur)), text).toMatchObject({ state: "confirmed", unconfirmed: [] });
  });
  it("même montant, devises différentes : jamais confirmé (49 CAD vs 49 EUR)", () => {
    const r = checkAdAmounts("Dès 49 € / mois", offer(49, "CAD"));
    expect(r.state).toBe("currency_mismatch");
    expect(r.unconfirmed).toEqual(["49 €"]);
    expect(checkAdAmounts("49 USD", offer(49, "CAD")).state).toBe("currency_mismatch");
    expect(checkAdAmounts("49 $ CA", offer(49, "USD")).state).toBe("currency_mismatch");
  });
  it("« $ » seul face à une offre en dollars : devise ambiguë, pas confirmé", () => {
    for (const cur of ["CAD", "USD"]) {
      const r = checkAdAmounts("Dès 49 $ / mois", offer(49, cur));
      expect(r.state, cur).toBe("currency_ambiguous");
      expect(r.unconfirmed).toHaveLength(1);
    }
  });
  it("« $ » face à une offre en euros ou livres : contradiction, pas ambiguïté", () => {
    expect(checkAdAmounts("49 $", offer(49, "EUR")).state).toBe("currency_mismatch");
    expect(checkAdAmounts("49 $", offer(49, "GBP")).state).toBe("currency_mismatch");
  });
  it("montant différent : « non confirmé » même si la devise est bonne", () => {
    expect(checkAdAmounts("Dès 29 CAD", offer(49, "CAD")).state).toBe("unconfirmed");
  });
  it("devise de l'offre inconnue (null) : rien ne peut être confirmé sur la devise", () => {
    expect(checkAdAmounts("49 €", offer(49, null)).state).toBe("currency_ambiguous");
  });
  it("montant écrit par l'utilisateur dans l'offre : confirmé avec sa devise", () => {
    const f = offer(null, "CAD", ["Essai à 10 CAD pendant 7 jours"]);
    expect(checkAdAmounts("Essai à 10 CAD", f).state).toBe("confirmed");
    expect(checkAdAmounts("Essai à 10 €", f).state).toBe("currency_mismatch");
    expect(checkAdAmounts("Essai à 10 $", f).state).toBe("currency_ambiguous");
  });
  it("le même « $ » écrit par l'utilisateur dans son texte reste confirmé", () => {
    expect(checkAdAmounts("Essai à 10 $", offer(null, "CAD", ["Essai à 10 $"])).state).toBe("confirmed");
  });
  it("annonce sans montant : aucun signalement", () => {
    expect(checkAdAmounts("Gagnez du temps chaque semaine", offer(49, "CAD")).state).toBe("no_amount");
    expect(checkAdAmounts("Gagnez 30 % de temps", offer(49, "CAD")).state).toBe("no_amount");
  });
  it("prix nul ou offre sans prix : tout montant est non confirmé", () => {
    expect(checkAdAmounts("Dès 49 CAD", offer(null, "CAD")).state).toBe("unconfirmed");
    expect(checkAdAmounts("Dès 49 CAD", offer(0, "CAD")).state).toBe("unconfirmed");
  });
  it("plusieurs montants : le pire verdict l'emporte et seuls les montants fautifs sont listés", () => {
    const r = checkAdAmounts("49 CAD aujourd'hui au lieu de 99 CAD, ou 49 €", offer(49, "CAD"));
    expect(r.state).toBe("unconfirmed");
    expect(r.unconfirmed).toEqual(["99 CAD", "49 €"]);
    expect(checkAdAmounts("49 CAD ou 49 CA$", offer(49, "CAD")).state).toBe("confirmed");
  });
  it("sans devise fournie (appel historique) : comparaison sur la valeur seule, contrat inchangé", () => {
    expect(unconfirmedAmounts("Seulement 49 $", { price: 49 })).toEqual([]);
    expect(unconfirmedAmounts("49 $ ou 99 $", { price: 49 })).toEqual(["99 $"]);
  });
});

describe("plages (« de 29 à 49 $ »)", () => {
  it("la borne basse est détectée et hérite de la devise de la borne haute", () => {
    const a = amountsIn("De 29 à 49 $ par mois");
    expect(a.map((x) => x.value)).toEqual([29, 49]);
    expect(a.map((x) => x.currency)).toEqual(["DOLLAR", "DOLLAR"]);
    expect(amountsIn("de 29 à 49 CAD").map((x) => x.currency)).toEqual(["CAD", "CAD"]);
    expect(amountsIn("29-49 €").map((x) => x.value)).toEqual([29, 49]);
  });
  it("une borne basse inventée est signalée même si la borne haute est le vrai prix", () => {
    const r = checkAdAmounts("De 29 à 49 CAD par mois", offer(49, "CAD"));
    expect(r.state).toBe("unconfirmed");
    expect(r.unconfirmed).toEqual(["29 CAD"]);
  });
  it("aucune régression : montants séparés, heures et nombres hors plage", () => {
    expect(amountsIn("29 $ à 49 $").map((x) => x.value)).toEqual([29, 49]);
    expect(amountsIn("Ouvert de 9 à 17 h, dès 49 $").map((x) => x.value)).toEqual([49]);
    expect(amountsIn("Gagnez 3 heures, 24 clients").map((x) => x.value)).toEqual([]);
  });
});

describe("annonce sans offre fiable et libellés du badge", () => {
  it("sans offre : avertissement explicite, jamais confirmé", () => {
    const r = checkAdAmounts("Dès 49 CAD / mois", null);
    expect(r).toMatchObject({ state: "unlinked", unconfirmed: ["49 CAD"] });
    expect(adBadge(r)?.label).toBe("offre d'origine introuvable");
    expect(checkAdAmounts("Gagnez du temps", null).state).toBe("no_amount");
  });
  it("libellés par état", () => {
    expect(adBadge(checkAdAmounts("Dès 49 CAD", offer(null, "CAD")))?.label).toBe("montant non confirmé");
    expect(adBadge(checkAdAmounts("49 €", offer(49, "CAD")))?.label).toBe("devise différente de l'offre");
    expect(adBadge(checkAdAmounts("49 $", offer(49, "CAD")))?.label).toBe("devise ambiguë");
    expect(adBadge(checkAdAmounts("49 CAD", offer(49, "CAD")))).toBeNull();
    expect(adBadge(checkAdAmounts("Rien à signaler", offer(49, "CAD")))).toBeNull();
    expect(adBadge(null)).toBeNull();
  });
});
