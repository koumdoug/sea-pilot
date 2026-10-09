import { describe, expect, it } from "vitest";
import { contactEligibility, dedupeKeyOf, eventDedupeKey, normalizeEmail, normalizePhone, parseProspectCsv, type EligibilityInput } from "@/lib/portfolio/rules";
import { DEFAULT_PRODUCTS } from "@/lib/portfolio/catalog";

const base = (over: Partial<EligibilityInput> = {}, p: Partial<EligibilityInput["prospect"]> = {}): EligibilityInput => ({
  now: new Date("2026-10-10T12:00:00Z"),
  channel: "email",
  productId: "prod1",
  product: { status: "commercialisation" },
  prospect: {
    productId: "prod1", status: "identified", optedOutAt: null, legalBasis: "consent_express", audienceType: "b2b", email: "a@b.co", phone: null,
    contactCount: 0, lastContactedAt: null, source: "Annuaire public", collectedAt: new Date("2026-10-01"), campaignId: null, ...p,
  },
  suppressed: false,
  channelSetting: { enabled: true, minDaysBetweenContacts: 7, maxContactsPerProspect: 3 },
  ...over,
});

describe("déduplication", () => {
  it("normalise courriel et téléphone", () => {
    expect(normalizeEmail("  Jean@Exemple.COM ")).toBe("jean@exemple.com");
    expect(normalizeEmail("pas-un-courriel")).toBeNull();
    expect(normalizePhone("+1 (514) 555-0100")).toBe("5145550100");
    expect(normalizePhone("514-555-0100")).toBe("5145550100");
  });
  it("même personne = même clé, quel que soit le format", () => {
    expect(dedupeKeyOf({ name: "A", email: "X@y.co" })).toBe(dedupeKeyOf({ name: "B", email: " x@Y.co " }));
    expect(dedupeKeyOf({ name: "A", phone: "514 555 0100" })).toBe(dedupeKeyOf({ name: "Z", phone: "+1-514-555-0100" }));
    expect(dedupeKeyOf({ name: "Marie Roy", company: "Plomberie Roy" })).toBe(dedupeKeyOf({ name: "marie roy", company: "plomberie  roy" }));
  });
});

describe("éligibilité au contact", () => {
  it("autorise un prospect conforme", () => {
    expect(contactEligibility(base())).toEqual({ ok: true, reasons: [] });
  });
  it("refuse si le produit n'est pas en commercialisation", () => {
    for (const status of ["preparation", "validation", "suspended"]) {
      const r = contactEligibility(base({ product: { status } }));
      expect(r.ok).toBe(false);
    }
  });
  it("refuse quand le canal est désactivé ou absent (désactivé par défaut)", () => {
    expect(contactEligibility(base({ channelSetting: null })).ok).toBe(false);
    expect(contactEligibility(base({ channelSetting: { enabled: false, minDaysBetweenContacts: 7, maxContactsPerProspect: 3 } })).ok).toBe(false);
  });
  it("respecte la désinscription et la liste de suppression", () => {
    expect(contactEligibility(base({}, { optedOutAt: new Date() })).ok).toBe(false);
    expect(contactEligibility(base({}, { status: "do_not_contact" })).ok).toBe(false);
    expect(contactEligibility(base({ suppressed: true })).ok).toBe(false);
  });
  it("exige une base de contact documentée, une provenance et une date de collecte", () => {
    expect(contactEligibility(base({}, { legalBasis: "unknown" })).ok).toBe(false);
    expect(contactEligibility(base({}, { legalBasis: "none" })).ok).toBe(false);
    expect(contactEligibility(base({}, { source: "" })).ok).toBe(false);
    expect(contactEligibility(base({}, { collectedAt: null })).ok).toBe(false);
  });
  it("le consentement implicite par adresse publiée ne vaut que pour le B2B", () => {
    expect(contactEligibility(base({}, { legalBasis: "implied_published", audienceType: "b2b" })).ok).toBe(true);
    expect(contactEligibility(base({}, { legalBasis: "implied_published", audienceType: "b2c" })).ok).toBe(false);
  });
  it("n'autorise qu'un seul produit : prospect attribué ailleurs ou non attribué", () => {
    expect(contactEligibility(base({}, { productId: "autre" })).ok).toBe(false);
    expect(contactEligibility(base({}, { productId: null })).ok).toBe(false);
    expect(contactEligibility(base({ concurrentCampaign: true })).ok).toBe(false);
  });
  it("applique la fréquence et le maximum de contacts", () => {
    expect(contactEligibility(base({}, { lastContactedAt: new Date("2026-10-08T12:00:00Z"), contactCount: 1 })).ok).toBe(false);
    expect(contactEligibility(base({}, { lastContactedAt: new Date("2026-10-01T12:00:00Z"), contactCount: 1 })).ok).toBe(true);
    expect(contactEligibility(base({}, { lastContactedAt: new Date("2026-09-01T12:00:00Z"), contactCount: 3 })).ok).toBe(false);
  });
  it("exige un modèle approuvé du même produit et du même canal", () => {
    const ok = { status: "approved", productId: "prod1", channel: "email" };
    expect(contactEligibility(base({ template: ok })).ok).toBe(true);
    expect(contactEligibility(base({ template: { ...ok, status: "draft" } })).ok).toBe(false);
    expect(contactEligibility(base({ template: { ...ok, productId: "x" } })).ok).toBe(false);
    expect(contactEligibility(base({ template: { ...ok, channel: "linkedin" } })).ok).toBe(false);
    expect(contactEligibility(base({ template: null })).ok).toBe(false);
  });
  it("exige l'adresse ou le numéro selon le canal", () => {
    expect(contactEligibility(base({}, { email: null })).ok).toBe(false);
    expect(contactEligibility(base({ channel: "phone" }, { phone: null })).ok).toBe(false);
  });
});

describe("conversions : clés anti double comptabilisation", () => {
  const d = new Date("2026-10-05T10:00:00Z");
  it("inscription, essai et résiliation : une seule fois par prospect et produit", () => {
    for (const type of ["signup", "trial_started", "cancellation"]) {
      expect(eventDedupeKey({ productId: "p", type, prospectId: "x", occurredAt: d })).toBe(eventDedupeKey({ productId: "p", type, prospectId: "x", occurredAt: new Date("2026-11-01") }));
    }
  });
  it("une référence externe identifie l'événement, même sans prospect", () => {
    expect(eventDedupeKey({ productId: "p", type: "payment_confirmed", externalRef: "INV-1", occurredAt: d })).toBe(eventDedupeKey({ productId: "p", type: "payment_confirmed", externalRef: "inv-1", occurredAt: new Date("2026-12-01") }));
  });
  it("deux paiements distincts d'un même prospect ne sont pas confondus", () => {
    const a = eventDedupeKey({ productId: "p", type: "payment_confirmed", prospectId: "x", occurredAt: d, amount: 9.99 });
    const b = eventDedupeKey({ productId: "p", type: "payment_confirmed", prospectId: "x", occurredAt: new Date("2026-11-05"), amount: 9.99 });
    expect(a).not.toBe(b);
  });
  it("refuse un événement sans prospect ni référence", () => {
    expect(() => eventDedupeKey({ productId: "p", type: "signup", occurredAt: d })).toThrow();
  });
});

describe("import CSV contrôlé", () => {
  const head = "nom;entreprise;courriel;source;date de collecte;base légale;produit\n";
  it("accepte les lignes valides et rejette les autres avec leur numéro de ligne", () => {
    const csv = head +
      "Marie Roy;Plomberie Roy;marie@roy.ca;Site public de l'entreprise;2026-10-01;adresse publiée;operapilot\n" +
      ";Sans nom;x@y.co;Source;2026-10-01;;driverpilot\n" +
      "Paul;Garage;pas-un-courriel;Source;2026-10-01;;driverpilot\n" +
      "Luc;Taxi;luc@taxi.ca;Source;pas-une-date;;driverpilot\n" +
      "Eve;Flotte;eve@flotte.ca;;2026-10-01;;driverpilot\n";
    const r = parseProspectCsv(csv);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ name: "Marie Roy", email: "marie@roy.ca", legalBasis: "implied_published", productSlug: "operapilot", audienceType: "b2b" });
    expect(r.errors.map((e) => e.line)).toEqual([3, 4, 5, 6]);
  });
  it("exige les colonnes nom, source et date de collecte", () => {
    expect(parseProspectCsv("nom;courriel\nA;a@b.co").errors[0].message).toMatch(/obligatoires/);
  });
  it("base légale absente = à confirmer (jamais supposée)", () => {
    const r = parseProspectCsv("nom;courriel;source;date de collecte\nA;a@b.co;Registre public;2026-10-01");
    expect(r.rows[0].legalBasis).toBe("unknown");
  });
  it("refuse une base légale inconnue plutôt que de la deviner", () => {
    const r = parseProspectCsv("nom;courriel;source;date de collecte;base légale\nA;a@b.co;Registre;2026-10-01;oui");
    expect(r.rows).toHaveLength(0);
    expect(r.errors[0].message).toMatch(/Base légale/);
  });
});

describe("catalogue initial", () => {
  it("ne contient aucun argument ni objection « approuvés » inventés, et signale les points à confirmer", () => {
    for (const p of DEFAULT_PRODUCTS) {
      expect(p.salesArguments.filter((a) => a.approved)).toEqual([]);
      expect(p.objections.filter((o) => o.approved)).toEqual([]);
      expect(p.unconfirmed.length).toBeGreaterThan(0);
      expect(p.status).not.toBe("commercialisation");
      for (const plan of p.pricing.plans) expect(plan.verified).toBe(false);
    }
  });
  it("n'annonce pas d'import Uber/Lyft ni d'IA réelle comme fonctions vérifiées", () => {
    const all = DEFAULT_PRODUCTS.flatMap((p) => p.features);
    expect(all.find((f) => /Import automatique/.test(f.text))?.verified).toBe(false);
    expect(all.find((f) => /Connecteurs IA réels/.test(f.text))?.verified).toBe(false);
  });
});
