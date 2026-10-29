import type { Section } from "./landing";

// Diagnostic SEO / « prêt pour les moteurs de réponse » des landing pages.
// LIMITES (affichées dans l'interface) : ce sont des contrôles DÉTERMINISTES sur le contenu et les métadonnées de la page.
// Ils ne mesurent NI le classement Google, NI les citations par ChatGPT/Perplexity/Gemini : aucune donnée externe n'est collectée.
// Seuls les chiffres de visites/leads sont mesurés (événements internes) ; le score est une heuristique de lecture.

export type SeoCategory = "technique" | "contenu" | "reponse" | "conversion";
export type SeoImpact = "high" | "medium" | "low";
export type SeoStatus = "pass" | "warn" | "fail" | "info";

export const CATEGORY_LABEL: Record<SeoCategory, string> = { technique: "SEO technique", contenu: "Contenu", reponse: "Moteurs de réponse (AEO/GEO)", conversion: "Conversion" };
export const IMPACT_LABEL: Record<SeoImpact, string> = { high: "Impact fort", medium: "Impact moyen", low: "Impact faible" };

export type SeoCheck = { id: string; category: SeoCategory; status: SeoStatus; impact: SeoImpact; label: string; detail: string; recommendation?: string; measured?: boolean };

export type SeoPageInput = {
  name: string;
  status: string;
  seoTitle?: string | null;
  seoDescription?: string | null;
  ogImage?: string | null;
  canonicalUrl?: string | null;
  sections: Section[];
  /** Un formulaire actif collectant un e-mail ou un téléphone est rattaché à la page. */
  hasActiveForm: boolean;
  /** Mesures internes (événements) : absentes = non fournies. */
  views?: number;
  leads?: number;
};

export type SeoAudit = { score: number; checks: SeoCheck[]; issues: SeoCheck[]; wordCount: number; faqCount: number };

const WEIGHT: Record<SeoImpact, number> = { high: 3, medium: 2, low: 1 };
const POINTS: Record<SeoStatus, number | null> = { pass: 1, warn: 0.5, fail: 0, info: null };
/** Un titre au-delà de ~60 caractères est tronqué dans les résultats de recherche ; une méta-description au-delà de ~160 aussi. */
export const TITLE_RANGE = [30, 60] as const;
export const DESCRIPTION_RANGE = [70, 160] as const;
/** Seuil de visites en dessous duquel un taux de conversion n'est pas interprété (trop peu de données). */
export const MIN_VIEWS_FOR_CONVERSION = 50;

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Texte visible d'une section, tel que rendu publiquement (sections vides ignorées par isRenderable côté page). */
function sectionText(s: Section): string[] {
  switch (s.type) {
    case "hero": return [s.headline, s.subheadline];
    case "problem": return [s.title, ...s.items];
    case "solution": return [s.title, s.body];
    case "benefits": return [s.title, ...s.items.flatMap((i) => [i.title, i.text])];
    case "proof": return [s.title, ...s.stats.flatMap((x) => [x.value, x.label])];
    case "testimonials": return [s.title, ...s.items.flatMap((x) => [x.quote, x.author, x.role])];
    case "faq": return [s.title, ...s.items.flatMap((x) => [x.q, x.a])];
    case "cta": return [s.title, s.text];
    case "footer": return [s.text, ...s.links.map((l) => l.label)];
  }
}

/** Texte visible de la page (toutes sections), pour les contrôles de cohérence. */
export function pageText(sections: Section[]): string {
  return sections.flatMap(sectionText).filter(Boolean).join("\n");
}

export function pageWordCount(sections: Section[]): number {
  return sections.reduce((n, s) => n + sectionText(s).reduce((m, t) => m + words(t), 0), 0);
}

export function faqItems(sections: Section[]): { q: string; a: string }[] {
  return sections.flatMap((s) => (s.type === "faq" ? s.items.filter((x) => x.q.trim() && x.a.trim()) : []));
}

/** Graphe JSON-LD de la page publique : WebPage, plus FAQPage UNIQUEMENT si de vraies questions/réponses sont affichées sur la page. */
export function buildPageJsonLd(p: { title: string; description?: string | null; url: string; orgName: string; sections: Section[] }): Record<string, unknown> {
  const graph: Record<string, unknown>[] = [
    { "@type": "WebPage", name: p.title, ...(p.description ? { description: p.description } : {}), url: p.url, publisher: { "@type": "Organization", name: p.orgName } },
  ];
  const faq = faqItems(p.sections);
  if (faq.length > 0) graph.push({ "@type": "FAQPage", mainEntity: faq.map((x) => ({ "@type": "Question", name: x.q, acceptedAnswer: { "@type": "Answer", text: x.a } })) });
  return { "@context": "https://schema.org", "@graph": graph };
}

function rangeCheck(len: number, [min, max]: readonly [number, number]): "ok" | "short" | "long" { return len < min ? "short" : len > max ? "long" : "ok"; }

export function auditLandingPage(p: SeoPageInput): SeoAudit {
  const checks: SeoCheck[] = [];
  const add = (c: SeoCheck) => checks.push(c);
  const title = (p.seoTitle ?? "").trim();
  const desc = (p.seoDescription ?? "").trim();
  const hero = p.sections.find((s) => s.type === "hero");
  const headline = hero?.type === "hero" ? hero.headline.trim() : "";
  const sub = hero?.type === "hero" ? hero.subheadline.trim() : "";
  const wc = pageWordCount(p.sections);
  const faq = faqItems(p.sections);
  const published = p.status === "published";

  // — SEO technique
  if (!published) add({ id: "indexable", category: "technique", status: "warn", impact: "high", label: "Page indexable", detail: p.status === "archived" ? "La page est archivée : elle n'est pas accessible." : "La page n'est pas publiée : les moteurs ne peuvent pas l'indexer.", recommendation: "Publiez la page lorsque le contenu est prêt." });
  else add({ id: "indexable", category: "technique", status: "pass", impact: "high", label: "Page indexable", detail: "Publiée : balise robots « index, follow »." });

  if (!title) add({ id: "title", category: "technique", status: "fail", impact: "high", label: "Titre SEO", detail: `Aucun titre SEO : le nom interne « ${p.name} » sert de titre dans les résultats.`, recommendation: "Rédigez un titre de 30 à 60 caractères avec le mot-clé principal en premier." });
  else {
    const r = rangeCheck(title.length, TITLE_RANGE);
    add({ id: "title", category: "technique", status: r === "ok" ? "pass" : "warn", impact: "high", label: "Titre SEO", detail: `${title.length} caractères (idéal ${TITLE_RANGE[0]}–${TITLE_RANGE[1]}).`, ...(r === "long" ? { recommendation: "Raccourcissez : le titre risque d'être tronqué dans les résultats." } : r === "short" ? { recommendation: "Précisez le titre : le mot-clé et la promesse doivent y figurer." } : {}) });
  }

  if (!desc) add({ id: "description", category: "technique", status: "fail", impact: "high", label: "Méta-description", detail: "Aucune méta-description : le moteur choisira un extrait au hasard.", recommendation: "Rédigez 70 à 160 caractères qui promettent un bénéfice et incitent au clic." });
  else {
    const r = rangeCheck(desc.length, DESCRIPTION_RANGE);
    add({ id: "description", category: "technique", status: r === "ok" ? "pass" : "warn", impact: "high", label: "Méta-description", detail: `${desc.length} caractères (idéal ${DESCRIPTION_RANGE[0]}–${DESCRIPTION_RANGE[1]}).`, ...(r === "long" ? { recommendation: "Raccourcissez : la fin sera coupée dans les résultats." } : r === "short" ? { recommendation: "Développez : exploitez l'espace pour le bénéfice principal." } : {}) });
  }

  if (!headline) add({ id: "h1", category: "technique", status: "fail", impact: "high", label: "Titre principal (H1)", detail: "Aucune section Hero avec un titre : la page n'a pas de H1.", recommendation: "Ajoutez une section Hero avec un titre clair (20 à 70 caractères)." });
  else add({ id: "h1", category: "technique", status: headline.length >= 20 && headline.length <= 70 ? "pass" : "warn", impact: "high", label: "Titre principal (H1)", detail: `${headline.length} caractères.`, ...(headline.length < 20 || headline.length > 70 ? { recommendation: "Visez 20 à 70 caractères, orientés vers le bénéfice." } : {}) });

  if (p.canonicalUrl) add({ id: "canonical", category: "technique", status: "info", impact: "medium", label: "URL canonique personnalisée", detail: "La page déclare une canonique externe : elle est exclue du sitemap de SEA Pilot.", recommendation: "Vérifiez que cette URL est bien celle que vous voulez voir indexée." });
  else add({ id: "canonical", category: "technique", status: "pass", impact: "medium", label: "URL canonique", detail: "Canonique automatique sur l'adresse de la page ; présente dans le sitemap si publiée." });

  add(p.ogImage
    ? { id: "og-image", category: "technique", status: "pass", impact: "low", label: "Image de partage", detail: "Image Open Graph définie." }
    : { id: "og-image", category: "technique", status: "warn", impact: "low", label: "Image de partage", detail: "Aucune image Open Graph : les partages sociaux seront sans visuel.", recommendation: "Ajoutez une image 1200×630 dans les réglages SEO." });

  // — Contenu
  add({ id: "length", category: "contenu", status: wc >= 300 ? "pass" : wc >= 150 ? "warn" : "fail", impact: "medium", label: "Volume de contenu", detail: `${wc} mots visibles (sections vides comprises dans le calcul).`, ...(wc < 300 ? { recommendation: "Développez le problème, la solution et les bénéfices : visez 300 mots utiles au minimum." } : {}) });
  const h2 = p.sections.filter((s) => s.type !== "hero" && s.type !== "footer" && s.type !== "cta").length;
  add({ id: "structure", category: "contenu", status: h2 >= 3 ? "pass" : h2 >= 1 ? "warn" : "fail", impact: "medium", label: "Structure (sous-titres H2)", detail: `${h2} section(s) de contenu avec sous-titre.`, ...(h2 < 3 ? { recommendation: "Ajoutez des sections (problème, solution, bénéfices, preuve) pour structurer la lecture." } : {}) });
  const links = p.sections.reduce((n, s) => n + (s.type === "footer" ? s.links.filter((l) => l.label && l.url).length : 0), 0);
  add({ id: "links", category: "contenu", status: links > 0 ? "pass" : "warn", impact: "low", label: "Liens du pied de page", detail: `${links} lien(s).`, ...(links === 0 ? { recommendation: "Ajoutez des liens utiles (mentions légales, page produit, ressource liée) pour le maillage." } : {}) });
  const proof = p.sections.some((s) => (s.type === "proof" && s.stats.some((x) => x.value)) || (s.type === "testimonials" && s.items.some((x) => x.quote)));
  add({ id: "proof", category: "contenu", status: proof ? "pass" : "warn", impact: "low", label: "Preuve (chiffres, témoignages)", detail: proof ? "Preuve renseignée." : "Aucune preuve affichée.", ...(!proof ? { recommendation: "Ajoutez des chiffres ou témoignages RÉELS fournis par vos clients — jamais inventés." } : {}) });

  // — Moteurs de réponse : préparation du contenu, pas mesure de citation
  add({ id: "faq", category: "reponse", status: faq.length >= 3 ? "pass" : faq.length >= 1 ? "warn" : "fail", impact: "medium", label: "FAQ (questions/réponses)", detail: faq.length > 0 ? `${faq.length} question(s) ; balisage FAQPage ajouté automatiquement à la page publique.` : "Aucune FAQ : les moteurs de réponse n'ont pas de question/réponse directe à reprendre.", ...(faq.length < 3 ? { recommendation: "Ajoutez 3 à 6 questions réelles de vos clients, avec des réponses directes de 1 à 3 phrases." } : {}) });
  const asked = faq.filter((x) => x.q.trim().endsWith("?")).length;
  if (faq.length > 0) add({ id: "faq-form", category: "reponse", status: asked === faq.length ? "pass" : "warn", impact: "low", label: "Questions formulées comme de vraies questions", detail: `${asked}/${faq.length} se terminent par « ? ».`, ...(asked < faq.length ? { recommendation: "Formulez chaque entrée comme la question posée par un client." } : {}) });
  add({ id: "answer-first", category: "reponse", status: sub.length >= 40 ? "pass" : "warn", impact: "medium", label: "Réponse directe en tête de page", detail: sub.length >= 40 ? "Le sous-titre du Hero énonce l'offre." : "Le sous-titre du Hero est absent ou trop court pour servir de réponse directe.", ...(sub.length < 40 ? { recommendation: "Résumez en une à deux phrases qui vous aidez et comment, dès le Hero." } : {}) });
  add({ id: "jsonld", category: "reponse", status: "pass", impact: "low", label: "Données structurées", detail: faq.length > 0 ? "JSON-LD WebPage + FAQPage généré à partir du contenu affiché." : "JSON-LD WebPage généré ; FAQPage s'ajoutera dès qu'une FAQ sera renseignée." });

  // — Conversion
  add(p.hasActiveForm
    ? { id: "form", category: "conversion", status: "pass", impact: "high", label: "Formulaire de capture", detail: "Un formulaire actif collecte un e-mail ou un téléphone." }
    : { id: "form", category: "conversion", status: "fail", impact: "high", label: "Formulaire de capture", detail: "Aucun formulaire actif : le trafic ne peut pas devenir un lead.", recommendation: "Activez un formulaire avec e-mail ou téléphone dans la section « Appel à l'action »." });
  const cta = p.sections.some((s) => s.type === "cta");
  add({ id: "cta", category: "conversion", status: cta ? "pass" : "warn", impact: "medium", label: "Appel à l'action final", detail: cta ? "Section d'appel à l'action présente." : "Pas de section d'appel à l'action.", ...(!cta ? { recommendation: "Ajoutez la section « Appel à l'action + formulaire » en bas de page." } : {}) });

  // — Mesures internes (les seules données réellement mesurées)
  if (published && p.views !== undefined) {
    if (p.views === 0) add({ id: "traffic", category: "conversion", status: "info", impact: "medium", label: "Trafic mesuré", detail: "Aucune visite enregistrée : la page n'a pas encore de trafic mesurable.", recommendation: "Diffusez la page (campagne, lien partagé) avec des paramètres UTM pour mesurer l'origine.", measured: true });
    else if (p.views < MIN_VIEWS_FOR_CONVERSION) add({ id: "traffic", category: "conversion", status: "info", impact: "medium", label: "Conversion mesurée", detail: `${p.views} visite(s) et ${p.leads ?? 0} lead(s) : trop peu de données pour interpréter un taux (seuil ${MIN_VIEWS_FOR_CONVERSION} visites).`, measured: true });
    else {
      const rate = (p.leads ?? 0) / p.views;
      add({ id: "traffic", category: "conversion", status: rate >= 0.02 ? "pass" : "warn", impact: "high", label: "Conversion mesurée", detail: `${p.views} visites, ${p.leads ?? 0} lead(s) : ${(rate * 100).toFixed(1)} %.`, ...(rate < 0.02 ? { recommendation: "Conversion inférieure à 2 % : retravaillez le Hero, l'offre et le formulaire (moins de champs)." } : {}), measured: true });
    }
  }

  let got = 0, total = 0;
  for (const c of checks) { const pts = POINTS[c.status]; if (pts === null) continue; got += pts * WEIGHT[c.impact]; total += WEIGHT[c.impact]; }
  const score = total === 0 ? 0 : Math.round((100 * got) / total);
  const order: Record<SeoStatus, number> = { fail: 0, warn: 1, info: 2, pass: 3 };
  const issues = checks.filter((c) => c.status === "fail" || c.status === "warn" || (c.status === "info" && c.recommendation))
    .sort((a, b) => WEIGHT[b.impact] - WEIGHT[a.impact] || order[a.status] - order[b.status]);
  return { score, checks, issues, wordCount: wc, faqCount: faq.length };
}

export const scoreTone = (score: number): "green" | "orange" | "red" => (score >= 80 ? "green" : score >= 60 ? "orange" : "red");

/** Ordre de travail : les pages au score le plus faible ET qui reçoivent du trafic mesuré passent d'abord. */
export function improvementPriority(score: number, views: number): number {
  return Math.round((100 - score) * (1 + Math.log10(1 + Math.max(0, views))));
}
