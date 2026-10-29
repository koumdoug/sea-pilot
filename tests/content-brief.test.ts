import { describe, expect, it } from "vitest";
import type { Section } from "../src/lib/landing";
import { auditLandingPage } from "../src/lib/seo";
import { aiBriefSchema, briefToMarkdown, buildBrief, contentBriefPrompt, guessIntent, unsupportedFigures, type AiBrief, type BriefInput } from "../src/lib/content-brief";
import { EditorialError, calendarByWeek, canTransition, isOverdue, mondayOf, observedResults, transition, workQueue, type EditorialItem } from "../src/lib/editorial";

const hero = (headline = "Devis salle de bain à Lyon", subheadline = ""): Section => ({ type: "hero", id: "h", headline, subheadline, ctaLabel: "Obtenir mon devis" });
const input = (over: Partial<BriefInput> & { sections?: Section[]; seoTitle?: string | null } = {}): BriefInput => {
  const sections = over.sections ?? [hero()];
  const page = { id: "p1", name: "Devis Lyon", status: "published", seoTitle: over.seoTitle ?? null, seoDescription: null, sections, url: "https://app.test/p/ws/devis" };
  const hasActiveForm = over.hasActiveForm ?? true;
  return { page, hasActiveForm, audit: auditLandingPage({ ...page, hasActiveForm }), offer: null, audience: null, campaign: null, metrics: null, ...over };
};
const offer = { name: "Rénovation de salle de bain", description: "d", problem: "Chantiers qui dérapent", price: 4900, currency: "EUR" };
const audience = { name: "Propriétaires lyonnais", type: "b2c", needs: "Un prix fixe", problems: "Délais non tenus", objections: "Trop cher ; Peur des retards" };

describe("buildBrief — page lacunaire", () => {
  it("transforme les lacunes du diagnostic en recommandations sourcées et distingue les types", () => {
    const b = buildBrief(input());
    expect(b.topic).toBe("Devis salle de bain à Lyon");
    expect(b.recommendations.length).toBeGreaterThan(0);
    expect(b.recommendations.every((r) => r.kind === "recommendation" && r.source.startsWith("Diagnostic SEO") && r.checkId)).toBe(true);
    expect(b.recommendations.map((r) => r.checkId)).toEqual(expect.arrayContaining(["faq", "description", "length"]));
    expect(b.facts.every((f) => f.kind === "fact")).toBe(true);
    expect(b.intent.item.kind).toBe("hypothesis");
    expect(b.questions.filter((q) => q.kind === "hypothesis").length).toBeGreaterThan(0);
  });

  it("ne fabrique aucun volume, difficulté ni donnée concurrentielle ; signale leur absence", () => {
    const b = buildBrief(input({ offer, audience }));
    const all = JSON.stringify(b);
    expect(all).not.toMatch(/volume de recherche : \d|difficulté : \d|\d+ recherches/i);
    expect(b.gaps.some((g) => /mots-clés/.test(g) && /concurren/.test(g))).toBe(true);
  });

  it("données manquantes : chaque absence est listée, fiabilité dégradée, sujet indéterminé sans titre", () => {
    const empty = buildBrief(input({ sections: [{ type: "footer", id: "f", text: "", links: [] }], hasActiveForm: false }));
    expect(empty.topic).toBeNull();
    expect(empty.reliability).toBe("insufficient");
    expect(empty.gaps.join(" | ")).toMatch(/Aucune offre/);
    expect(empty.gaps.join(" | ")).toMatch(/Aucune audience/);
    expect(empty.gaps.join(" | ")).toMatch(/sujet/);
    expect(empty.gaps.join(" | ")).toMatch(/formulaire actif/);
    expect(empty.mainQuestion).toBeNull();
    const partial = buildBrief(input());
    expect(partial.reliability).toBe("partial");
  });

  it("fiabilité suffisante seulement avec sujet, offre, audience et contenu", () => {
    const long = Array.from({ length: 80 }, (_, i) => `mot${i}`).join(" ");
    const b = buildBrief(input({ offer, audience, sections: [hero(), { type: "solution", id: "s", title: "Solution", body: long }] }));
    expect(b.reliability).toBe("sufficient");
  });

  it("utilise les données réelles : offre, audience, objections → questions de FAQ sourcées", () => {
    const b = buildBrief(input({ offer, audience, campaign: { name: "Google Lyon", objective: "leads" }, metrics: { views: 120, ctaClicks: 30, leads: 6 } }));
    const facts = b.facts.map((f) => f.text).join("\n");
    expect(facts).toContain("4900 EUR");
    expect(facts).toContain("Propriétaires lyonnais");
    expect(facts).toContain("Google Lyon");
    expect(facts).toContain("120 visite(s), 30 clic(s) sur le bouton, 6 lead(s)");
    const objections = b.questions.filter((q) => q.kind === "fact").map((q) => q.text);
    expect(objections).toEqual(["Trop cher ?", "Peur des retards ?"]);
    expect(b.questions.some((q) => /Combien coûte/.test(q.text))).toBe(true);
  });

  it("ne propose pas la question du prix si elle est déjà traitée sur la page", () => {
    const b = buildBrief(input({ offer, sections: [hero("Salle de bain", "Dès 4900 € clé en main, sans surprise.")] }));
    expect(b.questions.some((q) => /Combien coûte/.test(q.text))).toBe(false);
  });

  it("question principale = première question réelle de la FAQ (fait), sinon absente", () => {
    const faq: Section = { type: "faq", id: "f", title: "FAQ", items: [{ q: "Quel délai ?", a: "Six semaines." }] };
    expect(buildBrief(input({ sections: [hero(), faq] })).mainQuestion).toMatchObject({ kind: "fact", text: "Quel délai ?" });
    expect(buildBrief(input()).mainQuestion).toBeNull();
  });

  it("appel à l'action : conversion prise en charge seulement avec un formulaire actif ; jamais de démo ou d'inscription inventée", () => {
    const withForm = buildBrief(input());
    expect(withForm.cta.supported).toBe(true);
    expect(withForm.cta.objective).toMatch(/Demande de contact/);
    expect(withForm.cta.objective).not.toMatch(/démo|inscription/i);
    expect(withForm.cta.target).toBe("https://app.test/p/ws/devis");
    const without = buildBrief(input({ hasActiveForm: false }));
    expect(without.cta.supported).toBe(false);
    expect(without.gaps.some((g) => /formulaire actif/.test(g))).toBe(true);
  });

  it("sans mesures fournies, aucun fait de trafic ; avec zéro visite, une lacune et pas de chiffre inventé", () => {
    expect(buildBrief(input()).facts.some((f) => /visite/.test(f.text))).toBe(false);
    const z = buildBrief(input({ metrics: { views: 0, ctaClicks: 0, leads: 0 } }));
    expect(z.facts.some((f) => /visite/.test(f.text))).toBe(false);
    expect(z.gaps.some((g) => /Aucune visite mesurée/.test(g))).toBe(true);
  });

  it("le plan ne cite des preuves que si elles existent déjà sur la page", () => {
    const noProof = buildBrief(input()).outline.find((o) => o.heading === "Preuves")!;
    expect(noProof.purpose).toMatch(/Ne rien inventer/);
    expect(noProof.basedOn).toBe("recommendation");
    const proof: Section = { type: "proof", id: "p", title: "Preuves", stats: [{ value: "120", label: "chantiers" }] };
    expect(buildBrief(input({ sections: [hero(), proof] })).outline.find((o) => o.heading === "Preuves")!.basedOn).toBe("fact");
  });
});

describe("guessIntent", () => {
  it.each([["Devis salle de bain Lyon", "transactional"], ["Meilleur logiciel de devis", "commercial"], ["Comment rénover une salle de bain", "informational"], ["Salle de bain", null], [null, null]])("%s → %s", (t, e) => {
    expect(guessIntent(t as string | null)).toBe(e);
  });
});

describe("unsupportedFigures", () => {
  const ai = (over: Partial<AiBrief>): AiBrief => aiBriefSchema.parse({ workingTitle: "T", searchIntent: "informational", intentRationale: "r", mainQuestion: "Q ?", outline: [{ heading: "H", points: [] }], cta: "c", ...over });
  it("signale les chiffres que les données ne contiennent pas, pas ceux qui y figurent", () => {
    const a = ai({ faq: [{ q: "Prix ?", a: "Dès 4 900 € et 85 % de clients satisfaits." }], seoNotes: ["Visez 2000 mots"] });
    const u = unsupportedFigures(a, "Prix : 4900 EUR\n4 900 €");
    expect(u.some((x) => x.includes("85"))).toBe(true);
    expect(u.some((x) => x.includes("2000"))).toBe(true);
    expect(u.some((x) => x.includes("4 900"))).toBe(false);
  });
  it("aucun avertissement sans chiffre ; petits nombres ignorés", () => {
    expect(unsupportedFigures(ai({ outline: [{ heading: "3 étapes", points: ["Étape 1"] }] }), "")).toEqual([]);
  });
});

describe("prompt et export", () => {
  it("le prompt encadre les données, interdit l'invention, et ne contient aucun secret ni donnée hors brief", () => {
    const p = contentBriefPrompt(buildBrief(input({ offer, audience })));
    expect(p).toContain('<donnees nom="faits">');
    expect(p).toMatch(/N'invente aucun chiffre/);
    expect(p).toMatch(/assumptions/);
    expect(p).toContain("4900 EUR");
  });
  it("Markdown : types visibles, section IA présente seulement si fournie et marquée comme hypothèses", () => {
    const b = buildBrief(input({ offer, audience }));
    const md = briefToMarkdown(b);
    expect(md).toContain("[Fait]");
    expect(md).toContain("[Recommandation]");
    expect(md).toContain("[Hypothèse]");
    expect(md).not.toContain("Proposition générée par l'IA");
    const withAi = briefToMarkdown(b, aiBriefSchema.parse({ workingTitle: "Titre IA", searchIntent: "transactional", intentRationale: "r", mainQuestion: "Q ?", outline: [{ heading: "H1", points: ["p"] }], cta: "c" }));
    expect(withAi).toContain("Proposition générée par l'IA (à relire : ce sont des hypothèses)");
    expect(withAi).toContain("# Brief de contenu — Titre IA");
  });
  it("schéma IA : refuse une intention hors liste et un plan vide", () => {
    const base = { workingTitle: "T", searchIntent: "informational", intentRationale: "r", mainQuestion: "Q", outline: [{ heading: "H", points: [] }], cta: "c" };
    expect(aiBriefSchema.safeParse(base).success).toBe(true);
    expect(aiBriefSchema.safeParse({ ...base, searchIntent: "magic" }).success).toBe(false);
    expect(aiBriefSchema.safeParse({ ...base, outline: [] }).success).toBe(false);
  });
});

// ── Règles du suivi éditorial (logique pure, non branchée à une interface : voir docs/lot2-modele-editorial.md) ──
const item = (o: Partial<EditorialItem> = {}): EditorialItem => ({ id: "1", title: "T", state: "idea", priority: "medium", dueAt: null, publishedConfirmedAt: null, landingPageId: null, ...o });
const d = (s: string) => new Date(`${s}T12:00:00Z`);

describe("suivi éditorial — états et faux statuts de publication", () => {
  it("avance ou recule d'un cran seulement ; pas de saut ; publié est terminal", () => {
    expect(canTransition("idea", "brief_todo")).toBe(true);
    expect(canTransition("brief_todo", "idea")).toBe(true);
    expect(canTransition("idea", "ready")).toBe(false);
    expect(canTransition("idea", "idea")).toBe(false);
    expect(canTransition("published", "writing")).toBe(false);
  });
  it("« Publié » exige une confirmation explicite ; sans elle, refus et item inchangé", () => {
    const w = item({ state: "writing" });
    expect(() => transition(w, "published")).toThrow(EditorialError);
    expect(() => transition(w, "published", { confirmedPublished: false })).toThrow(/confirmation explicite/);
    expect(w.state).toBe("writing");
    const p = transition(w, "published", { confirmedPublished: true, now: d("2026-03-02") });
    expect(p.state).toBe("published");
    expect(p.publishedConfirmedAt).toEqual(d("2026-03-02"));
  });
  it("on ne publie pas depuis « Idée » même avec confirmation", () => {
    expect(() => transition(item(), "published", { confirmedPublished: true })).toThrow(EditorialError);
  });
  it("revenir en arrière efface la date de confirmation", () => {
    expect(transition(item({ state: "writing" }), "ready").publishedConfirmedAt).toBeNull();
  });
});

describe("suivi éditorial — calendrier, file de travail, résultats", () => {
  const now = d("2026-03-10");
  it("file de travail : retard, puis priorité, puis échéance ; publiés exclus", () => {
    const q = workQueue([
      item({ id: "pub", state: "published" }),
      item({ id: "later-high", priority: "high", dueAt: d("2026-03-30") }),
      item({ id: "late-low", priority: "low", dueAt: d("2026-03-01") }),
      item({ id: "none-high", priority: "high" }),
      item({ id: "soon-high", priority: "high", dueAt: d("2026-03-12") }),
    ], now).map((i) => i.id);
    expect(q).toEqual(["late-low", "soon-high", "later-high", "none-high"]);
    expect(isOverdue(item({ state: "published", dueAt: d("2026-01-01") }), now)).toBe(false);
  });
  it("calendrier par semaine (lundi) ; sans échéance à part", () => {
    expect(mondayOf(d("2026-03-08"))).toBe("2026-03-02"); // dimanche
    expect(mondayOf(d("2026-03-09"))).toBe("2026-03-09"); // lundi
    const c = calendarByWeek([item({ id: "a", dueAt: d("2026-03-11") }), item({ id: "b", dueAt: d("2026-03-04") }), item({ id: "c" }), item({ id: "d", dueAt: d("2026-03-09") })]);
    expect(c.weeks.map((w) => [w.monday, w.items.map((i) => i.id)])).toEqual([["2026-03-02", ["b"]], ["2026-03-09", ["a", "d"]]]);
    expect(c.undated.map((i) => i.id)).toEqual(["c"]);
  });
  it("résultats observés : jamais pour un contenu non publié ; jamais sans mesure ; pas d'attribution inventée", () => {
    expect(observedResults(item({ state: "writing" }), { views: 100, leads: 5 }).available).toBe(false);
    const pub = item({ state: "published", publishedConfirmedAt: now });
    expect(observedResults(pub, null).available).toBe(false);
    expect(observedResults(pub, { views: 0, leads: 0 }).available).toBe(false);
    const r = observedResults(pub, { views: 100, leads: 5 });
    expect(r.available).toBe(true);
    expect(r.text).toMatch(/non attribuées à ce contenu/);
  });
});
