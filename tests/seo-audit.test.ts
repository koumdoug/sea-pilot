import { describe, expect, it } from "vitest";
import type { Section } from "../src/lib/landing";
import { auditLandingPage, buildPageJsonLd, faqItems, improvementPriority, MIN_VIEWS_FOR_CONVERSION, pageWordCount, scoreTone, type SeoPageInput } from "../src/lib/seo";

const long = (n: number) => Array.from({ length: n }, (_, i) => `mot${i}`).join(" ");
const faq = (n: number, question = true): Section => ({ type: "faq", id: "f", title: "FAQ", items: Array.from({ length: n }, (_, i) => ({ q: `Question ${i}${question ? " ?" : ""}`, a: `Réponse ${i}` })) });

const good: SeoPageInput = {
  name: "Devis", status: "published", ogImage: "https://x.test/og.png",
  seoTitle: "Devis salle de bain à Lyon : réponse sous 24 h", // 48
  seoDescription: "Obtenez un devis gratuit pour votre salle de bain à Lyon, avec un artisan local et une réponse sous 24 heures.", // 107
  hasActiveForm: true,
  sections: [
    { type: "hero", id: "h", headline: "Votre salle de bain rénovée sans mauvaise surprise", subheadline: "Nous chiffrons votre projet gratuitement et revenons vers vous sous 24 heures.", ctaLabel: "Devis" },
    { type: "problem", id: "p", title: "Le problème", items: [long(60)] },
    { type: "solution", id: "s", title: "La solution", body: long(200) },
    { type: "benefits", id: "b", title: "Bénéfices", items: [{ title: "Prix fixe", text: long(40) }] },
    { type: "proof", id: "pr", title: "Preuves", stats: [{ value: "120", label: "chantiers" }] },
    faq(3),
    { type: "cta", id: "c", title: "Parlons-en", text: "", ctaLabel: "Envoyer" },
    { type: "footer", id: "ft", text: "", links: [{ label: "Mentions légales", url: "/privacy" }] },
  ],
};
const get = (a: ReturnType<typeof auditLandingPage>, id: string) => a.checks.find((c) => c.id === id)!;

describe("auditLandingPage", () => {
  it("une page complète obtient un score élevé sans action prioritaire", () => {
    const a = auditLandingPage(good);
    expect(a.score).toBeGreaterThanOrEqual(90);
    expect(a.issues).toEqual([]);
    expect(scoreTone(a.score)).toBe("green");
  });

  it("une page vide cumule les manques à fort impact en tête des actions", () => {
    const a = auditLandingPage({ name: "Brouillon", status: "draft", hasActiveForm: false, sections: [{ type: "footer", id: "f", text: "", links: [] }] });
    expect(a.score).toBeLessThan(35);
    expect(scoreTone(a.score)).toBe("red");
    expect(get(a, "title").status).toBe("fail");
    expect(get(a, "description").status).toBe("fail");
    expect(get(a, "h1").status).toBe("fail");
    expect(get(a, "form").status).toBe("fail");
    expect(get(a, "indexable").status).toBe("warn");
    expect(a.issues[0].impact).toBe("high");
    const impacts = a.issues.map((i) => i.impact);
    expect(impacts).toEqual([...impacts].sort((x, y) => ["high", "medium", "low"].indexOf(x) - ["high", "medium", "low"].indexOf(y)));
  });

  it.each([[29, "warn"], [30, "pass"], [60, "pass"], [61, "warn"]])("titre de %i caractères → %s", (len, status) => {
    expect(get(auditLandingPage({ ...good, seoTitle: "a".repeat(len) }), "title").status).toBe(status);
  });
  it.each([[69, "warn"], [70, "pass"], [160, "pass"], [161, "warn"]])("méta-description de %i caractères → %s", (len, status) => {
    expect(get(auditLandingPage({ ...good, seoDescription: "a".repeat(len) }), "description").status).toBe(status);
  });
  it("espaces seuls = absent", () => {
    expect(get(auditLandingPage({ ...good, seoTitle: "   ", seoDescription: "  " }), "title").status).toBe("fail");
    expect(get(auditLandingPage({ ...good, seoDescription: "  " }), "description").status).toBe("fail");
  });

  it("une canonique personnalisée est signalée comme exclue du sitemap", () => {
    const c = get(auditLandingPage({ ...good, canonicalUrl: "https://autre.test/page" }), "canonical");
    expect(c.status).toBe("info");
    expect(c.detail).toMatch(/sitemap/);
  });

  it("FAQ : 0 → manquant, 1-2 → à améliorer, 3 → OK ; seules les entrées complètes comptent", () => {
    const without = good.sections.filter((s) => s.type !== "faq");
    expect(get(auditLandingPage({ ...good, sections: without }), "faq").status).toBe("fail");
    expect(get(auditLandingPage({ ...good, sections: [...without, faq(2)] }), "faq").status).toBe("warn");
    expect(get(auditLandingPage({ ...good, sections: [...without, faq(3)] }), "faq").status).toBe("pass");
    const half: Section = { type: "faq", id: "f", title: "FAQ", items: [{ q: "Question ?", a: "" }, { q: "", a: "Réponse" }, { q: "OK ?", a: "Oui" }] };
    expect(faqItems([half])).toEqual([{ q: "OK ?", a: "Oui" }]);
    expect(get(auditLandingPage({ ...good, sections: [...without, half] }), "faq").status).toBe("warn");
  });
  it("les questions sans point d'interrogation sont signalées", () => {
    const sections = [...good.sections.filter((s) => s.type !== "faq"), faq(3, false)];
    expect(get(auditLandingPage({ ...good, sections }), "faq-form").status).toBe("warn");
    expect(get(auditLandingPage({ ...good, sections: good.sections.filter((s) => s.type !== "faq") }), "faq-form")).toBeUndefined();
  });

  it("volume de contenu : compte les mots visibles", () => {
    const short: SeoPageInput = { ...good, sections: [{ type: "hero", id: "h", headline: "Un titre assez long pour le H1 ici", subheadline: long(40), ctaLabel: "Go" }] };
    expect(pageWordCount(short.sections)).toBeGreaterThan(40);
    expect(get(auditLandingPage(short), "length").status).toBe("fail");
    expect(get(auditLandingPage(good), "length").status).toBe("pass");
  });

  it("conversion mesurée : seuil de données minimal, jamais d'interprétation en dessous", () => {
    const few = auditLandingPage({ ...good, views: MIN_VIEWS_FOR_CONVERSION - 1, leads: 0 });
    expect(get(few, "traffic").status).toBe("info");
    expect(get(few, "traffic").measured).toBe(true);
    expect(get(few, "traffic").recommendation).toBeUndefined();
    const low = auditLandingPage({ ...good, views: 200, leads: 1 });
    expect(get(low, "traffic").status).toBe("warn");
    expect(get(low, "traffic").detail).toMatch(/0\.5 %/);
    expect(get(auditLandingPage({ ...good, views: 200, leads: 8 }), "traffic").status).toBe("pass");
    expect(get(auditLandingPage({ ...good, views: 0, leads: 0 }), "traffic").status).toBe("info");
  });
  it("sans mesures fournies ou page non publiée : aucune ligne « mesuré »", () => {
    expect(auditLandingPage(good).checks.some((c) => c.measured)).toBe(false);
    expect(auditLandingPage({ ...good, status: "draft", views: 500, leads: 0 }).checks.some((c) => c.measured)).toBe(false);
  });

  it("le score reste borné et l'audit est déterministe", () => {
    const a = auditLandingPage(good), b = auditLandingPage(good);
    expect(a).toEqual(b);
    for (const p of [good, { ...good, sections: [] }]) { const s = auditLandingPage(p).score; expect(s).toBeGreaterThanOrEqual(0); expect(s).toBeLessThanOrEqual(100); }
  });
});

describe("buildPageJsonLd", () => {
  const base = { title: "T", description: "D", url: "https://app.test/p/ws/x", orgName: "Acme" };
  it("WebPage seul sans FAQ", () => {
    const ld = buildPageJsonLd({ ...base, sections: good.sections.filter((s) => s.type !== "faq") }) as { "@graph": { "@type": string }[] };
    expect(ld["@graph"].map((x) => x["@type"])).toEqual(["WebPage"]);
  });
  it("ajoute FAQPage avec les vraies questions affichées, sans entrée vide", () => {
    const half: Section = { type: "faq", id: "f", title: "FAQ", items: [{ q: "Q1 ?", a: "R1" }, { q: "Q2 ?", a: "" }] };
    const ld = buildPageJsonLd({ ...base, sections: [half] }) as { "@graph": { "@type": string; mainEntity?: { name: string; acceptedAnswer: { text: string } }[] }[] };
    const f = ld["@graph"].find((x) => x["@type"] === "FAQPage")!;
    expect(f.mainEntity).toEqual([{ "@type": "Question", name: "Q1 ?", acceptedAnswer: { "@type": "Answer", text: "R1" } }]);
  });
  it("omet la description absente (pas de valeur undefined sérialisée)", () => {
    const s = JSON.stringify(buildPageJsonLd({ ...base, description: null, sections: [] }));
    expect(s).not.toContain("description");
    expect(s).toContain('"publisher"');
  });
});

describe("improvementPriority", () => {
  it("à score égal, la page qui a du trafic passe avant", () => {
    expect(improvementPriority(40, 500)).toBeGreaterThan(improvementPriority(40, 0));
  });
  it("à trafic égal, le score le plus bas passe avant ; valeurs négatives tolérées", () => {
    expect(improvementPriority(30, 10)).toBeGreaterThan(improvementPriority(70, 10));
    expect(improvementPriority(50, -5)).toBe(improvementPriority(50, 0));
  });
});
