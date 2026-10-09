import { describe, expect, it } from "vitest";
import { amountsIn, unconfirmedAmounts, priceRule } from "@/lib/price-guard";
import { adCopyPrompt, baseSystem } from "@/lib/ai/prompts";

describe("price guard", () => {
  it("détecte les montants usuels", () => {
    expect(amountsIn("Dès 49 $/mois").map((a) => a.value)).toEqual([49]);
    expect(amountsIn("Seulement 1 299,50 € HT").map((a) => a.value)).toEqual([1299.5]);
    expect(amountsIn("USD 20 puis 15€").map((a) => a.value)).toEqual([20, 15]);
  });
  it("ignore le texte sans montant", () => {
    expect(amountsIn("Gagnez 3 heures par jour, 24 clients")).toEqual([]);
  });
  it("signale un prix inventé quand aucun prix n'est fourni", () => {
    expect(unconfirmedAmounts("Essayez pour 49 $/mois", { price: null, texts: [] })).toHaveLength(1);
  });
  it("accepte le prix de l'offre ou un montant écrit par l'utilisateur", () => {
    expect(unconfirmedAmounts("Seulement 49 $", { price: 49 })).toEqual([]);
    expect(unconfirmedAmounts("Dès 29 €", { price: null, texts: ["Pack à 29 € par mois"] })).toEqual([]);
    expect(unconfirmedAmounts("49 $ ou 99 $", { price: 49 })).toHaveLength(1);
  });
  it("ne marque pas à tort un prix confirmé écrit dans un autre format", () => {
    expect(unconfirmedAmounts("Dès 49,90 €", { price: 49.9 })).toEqual([]);
    expect(unconfirmedAmounts("Pour 1 299 € seulement", { price: 1299 })).toEqual([]);
    expect(unconfirmedAmounts("$49 par mois", { price: 49 })).toEqual([]);
    expect(unconfirmedAmounts("49 dollars", { price: 49 })).toEqual([]);
    expect(unconfirmedAmounts("Réduction de 30 % et 5 étapes", { price: null })).toEqual([]);
  });
  it("le prompt interdit tout prix sans prix fourni, et n'autorise que celui de l'offre sinon", () => {
    expect(priceRule(null)).toMatch(/AUCUN prix/);
    expect(priceRule(0)).toMatch(/AUCUN prix/);
    expect(priceRule(49, "USD")).toMatch(/49 USD/);
    expect(adCopyPrompt({ platform: "meta_ads", count: 2 })).toMatch(/AUCUN prix/);
    expect(baseSystem({ name: "X", language: "fr", currency: "EUR" }, "r")).toMatch(/aucun prix/);
  });
});
