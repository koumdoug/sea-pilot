import { describe, expect, it } from "vitest";
import { defaultOfferId, selectableOffers } from "@/lib/offer-choices";

const offers = [
  { id: "a", status: "active" },
  { id: "d", status: "draft" },
  { id: "x", status: "archived" },
];

describe("choix d'offres AI Studio", () => {
  it("exclut les offres archivées par défaut, garde actives et brouillons", () => {
    expect(selectableOffers(offers).map((o) => o.id)).toEqual(["a", "d"]);
  });
  it("conserve l'offre archivée de la campagne sélectionnée", () => {
    expect(selectableOffers(offers, "x").map((o) => o.id)).toEqual(["a", "d", "x"]);
  });
  it("liste vide ou uniquement archivée : aucun choix, pas de présélection", () => {
    expect(selectableOffers([])).toEqual([]);
    const only = selectableOffers([{ id: "x", status: "archived" }]);
    expect(only).toEqual([]);
    expect(defaultOfferId(only)).toBeUndefined();
  });
  it("présélectionne l'offre de la campagne si proposée, sinon la première", () => {
    const c = selectableOffers(offers);
    expect(defaultOfferId(c, "d")).toBe("d");
    expect(defaultOfferId(c, "x")).toBe("a");
    expect(defaultOfferId(c)).toBe("a");
  });
});
