import { describe, expect, it } from "vitest";
import { DEFAULT_CRITERIA, normalizeCriteria, qualifyLead, type OfferContext } from "@/lib/scoring";
import { applyAiAdjustments } from "@/lib/leads";

const offer: OfferContext = { name: "Rénovation de salle de bain", price: 5000, geoZone: "Lyon, Rhône", advantages: ["devis gratuit", "artisans certifiés"], keywords: ["rénovation", "salle", "bain", "carrelage"], audienceType: "b2c" };

describe("qualifyLead (règles)", () => {
  it("lead complet et urgent → chaud, avec raisons et prochaine action", () => {
    const q = qualifyLead({
      name: "Marie Durand", email: "marie@example.com", phone: "0600000000", company: "SCI Durand",
      message: "Bonjour, nous avons un projet de rénovation de salle de bain, c'est urgent, merci de me rappeler pour un devis cette semaine.",
      customFields: { budget: "6000", ville: "Lyon", urgence: "urgent", taille: "3" },
    }, offer);
    expect(q.level).toBe("hot");
    expect(q.score).toBeGreaterThanOrEqual(70);
    expect(q.reasons.length).toBeGreaterThan(0);
    expect(q.nextAction).toMatch(/Contacter/);
  });

  it("distingue les faits fournis des inférences", () => {
    const q = qualifyLead({ name: "Paul", email: "p@x.fr", message: "Je cherche un prix, c'est urgent", customFields: { budget: "3000" } }, offer);
    const budget = q.criteria.find((c) => c.key === "budget")!;
    const urgency = q.criteria.find((c) => c.key === "urgency")!;
    expect(budget.basis).toBe("fact"); // champ de formulaire
    expect(urgency.basis).toBe("inference"); // déduit d'un mot-clé
    expect(q.facts.some((f) => f.includes("budget : 3000"))).toBe(true);
    expect(q.inferences.every((i) => i.includes("inférence"))).toBe(true);
    expect(q.facts.join(" ")).not.toContain("inférence");
  });

  it("liste les informations manquantes au lieu de les inventer", () => {
    const q = qualifyLead({ name: "Anonyme", email: "a@b.co" }, offer);
    expect(q.missingInfo.join(" ")).toMatch(/budget/);
    expect(q.missingInfo.join(" ")).toMatch(/localisation/);
    expect(q.criteria.filter((c) => c.basis === "missing").every((c) => c.value === null)).toBe(true);
    expect(q.level).not.toBe("hot");
  });

  it("budget très inférieur au prix → critère budget faible", () => {
    const q = qualifyLead({ name: "X", email: "x@y.z", customFields: { budget: "500" } }, offer);
    expect(q.criteria.find((c) => c.key === "budget")!.value).toBeLessThan(0.5);
  });

  it("localisation hors zone → faible, dans la zone → forte", () => {
    const out = qualifyLead({ name: "X", email: "x@y.z", customFields: { ville: "Marseille" } }, offer).criteria.find((c) => c.key === "location")!;
    const inn = qualifyLead({ name: "X", email: "x@y.z", customFields: { ville: "Lyon" } }, offer).criteria.find((c) => c.key === "location")!;
    expect(out.value).toBeLessThan(0.5);
    expect(inn.value).toBe(1);
  });

  it("sans e-mail ni téléphone → non qualifié", () => {
    const q = qualifyLead({ name: "Sans contact", message: "Je veux un devis urgent pour une rénovation" }, offer);
    expect(q.level).toBe("unqualified");
    expect(q.nextAction).toMatch(/Aucun moyen de contact/);
  });

  it("« pas pressé » diminue l'urgence", () => {
    const q = qualifyLead({ name: "X", email: "x@y.z", message: "Je suis pas pressé, juste curiosité" }, offer);
    expect(q.criteria.find((c) => c.key === "urgency")!.value).toBeLessThan(0.3);
  });

  it("critères configurables : un critère désactivé est ignoré, les seuils sont respectés", () => {
    const criteria = DEFAULT_CRITERIA.map((c) => ({ ...c, enabled: c.key === "intent" }));
    const q = qualifyLead({ name: "X", email: "x@y.z", phone: "06", message: "devis svp" }, offer, criteria, { hot: 50, warm: 30 });
    expect(q.criteria).toHaveLength(1);
    expect(q.level).toBe("hot");
  });

  it("normalizeCriteria borne les poids et complète les critères manquants", () => {
    const c = normalizeCriteria([{ key: "budget", label: "x", weight: 999, enabled: true }]);
    expect(c.find((x) => x.key === "budget")!.weight).toBe(100);
    expect(c).toHaveLength(DEFAULT_CRITERIA.length);
    expect(normalizeCriteria("garbage")).toEqual(DEFAULT_CRITERIA);
  });

  it("score déterministe", () => {
    const l = { name: "X", email: "x@y.z", message: "besoin d'un devis" };
    expect(qualifyLead(l, offer).score).toBe(qualifyLead(l, offer).score);
  });
});

describe("ajustements IA : inférences vs faits", () => {
  const base = qualifyLead({ name: "X", email: "x@y.z", message: "Nous cherchons une solution, budget confortable" }, offer);

  it("une citation retrouvée mot pour mot est conservée ; le jugement reste une inférence", () => {
    const r = applyAiAdjustments(base, [{ key: "budget", value: 0.9, evidence: "Budget évoqué comme confortable", quote: "budget confortable" }], "Nous cherchons une solution, budget confortable");
    expect(r.quotes).toEqual(["budget confortable"]);
    const c = r.criteria.find((x) => x.key === "budget")!;
    expect(c.basis).toBe("inference");
    expect(c.value).toBe(0.9);
  });

  it("une citation inventée est écartée", () => {
    const r = applyAiAdjustments(base, [{ key: "budget", value: 1, evidence: "Gros budget", quote: "j'ai 100 000 euros" }], "Nous cherchons une solution, budget confortable");
    expect(r.quotes).toEqual([]);
    expect(r.criteria.find((x) => x.key === "budget")!.evidence).not.toContain("100 000");
  });

  it("borne les valeurs entre 0 et 1", () => {
    const r = applyAiAdjustments(base, [{ key: "need", value: 7, evidence: "e" }], "");
    expect(r.criteria.find((x) => x.key === "need")!.value).toBe(1);
  });
});
