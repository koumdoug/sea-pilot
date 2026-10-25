// Lot B1-1 : saisie de la marge (unité : POURCENT entier, 28 = 28 %). Une valeur strictement comprise entre 0 et 1
// (par exemple 0,28) est probablement une fraction saisie par erreur : elle exige une confirmation explicite.
import { describe, expect, it } from "vitest";
import { isAmbiguousMarginPct, marginInputError, MARGIN_AMBIGUOUS_BELOW } from "@/lib/margin";
import { validMarginPct } from "@/lib/recommendations";

describe("marge : ambiguïté d'unité", () => {
  it("seuil d'ambiguïté : 1 %", () => expect(MARGIN_AMBIGUOUS_BELOW).toBe(1));
  it("0,28 et 0,99 sont ambigus ; 1, 25, 28, 30, 100 ne le sont pas", () => {
    for (const m of [0.28, 0.01, 0.99]) expect(isAmbiguousMarginPct(m), String(m)).toBe(true);
    for (const m of [1, 25, 28, 30, 100]) expect(isAmbiguousMarginPct(m), String(m)).toBe(false);
  });
  it("0, négatif, > 100, NaN, absent, texte : pas « ambigus » (ils sont invalides ou absents)", () => {
    for (const m of [0, -5, 150, Number.NaN, undefined, null, "0.28"]) expect(isAmbiguousMarginPct(m), String(m)).toBe(false);
  });
  it("validMarginPct garde son contrat : 0,1 reste valide (l'ambiguïté est un avertissement, pas une transformation)", () => {
    expect(validMarginPct(0.28)).toBe(0.28);
  });
});

describe("marge : validation de la saisie (serveur, formulaire d'offre et onboarding)", () => {
  it("champ vide : accepté (marge non renseignée, jamais convertie en 0)", () => expect(marginInputError(undefined, false)).toBeNull());
  it("25, 28, 30 et 100 : acceptés sans confirmation", () => {
    for (const m of [25, 28, 30, 100]) expect(marginInputError(m, false), String(m)).toBeNull();
  });
  it("0 : accepté tel quel (valeur stockée inchangée) ; le moteur ne s'en sert pas pour affirmer une rentabilité", () => {
    expect(marginInputError(0, false)).toBeNull();
  });
  it("0,28 sans confirmation : refusé avec un message d'unité explicite", () => {
    const e = marginInputError(0.28, false)!;
    expect(e).toMatch(/pourcentage/i);
    expect(e).toMatch(/28 pour 28 %/);
    expect(e).toMatch(/confirm/i);
  });
  it("0,28 avec confirmation : accepté (la valeur n'est pas transformée)", () => {
    expect(marginInputError(0.28, true)).toBeNull();
  });
  it("supérieur à 100, négatif, NaN, infini : refusés, confirmation sans effet", () => {
    for (const m of [100.1, 150, 1000, -1, Number.NaN, Infinity]) {
      expect(marginInputError(m, false), String(m)).toMatch(/entre 0 et 100/i);
      expect(marginInputError(m, true), `${m} confirmé`).toMatch(/entre 0 et 100/i);
    }
  });
});
