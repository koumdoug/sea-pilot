import { z } from "zod";
import type { Section } from "./landing";
import { faqItems, pageText, type SeoAudit } from "./seo";
import { wrap } from "./ai/prompts";

// Brief de contenu à partir d'une landing page et de son diagnostic SEO.
// Chaque élément est typé : FAIT (donnée de SEA Pilot, sourcée), RECOMMANDATION (règle déterministe issue du diagnostic),
// HYPOTHÈSE (supposition à valider — jamais présentée comme un résultat). Aucun volume de recherche, aucune difficulté de mot-clé,
// aucune donnée concurrentielle n'est produit : SEA Pilot n'en collecte pas.

export type BriefKind = "fact" | "recommendation" | "hypothesis";
export const KIND_LABEL: Record<BriefKind, string> = { fact: "Fait", recommendation: "Recommandation", hypothesis: "Hypothèse" };
export type BriefItem = { kind: BriefKind; text: string; source: string; checkId?: string };
export type SearchIntent = "informational" | "commercial" | "transactional" | "navigational";
export const INTENT_LABEL: Record<SearchIntent, string> = { informational: "Informationnelle", commercial: "Comparaison / considération", transactional: "Transactionnelle", navigational: "Navigationnelle" };
export type Reliability = "sufficient" | "partial" | "insufficient";

export type BriefInput = {
  page: { id: string; name: string; status: string; seoTitle?: string | null; seoDescription?: string | null; sections: Section[]; url: string };
  audit: SeoAudit;
  hasActiveForm: boolean;
  offer?: { name: string; description?: string | null; problem?: string | null; price?: number | null; currency: string } | null;
  audience?: { name: string; type: string; needs?: string | null; problems?: string | null; objections?: string | null } | null;
  campaign?: { name: string; objective?: string | null } | null;
  /** Mesures internes (événements) : absentes si non fournies. */
  metrics?: { views: number; ctaClicks: number; leads: number } | null;
};

export type ContentBrief = {
  topic: string | null;
  topicSource: string;
  intent: { value: SearchIntent | null; item: BriefItem };
  mainQuestion: BriefItem | null;
  facts: BriefItem[];
  gaps: string[];
  recommendations: BriefItem[];
  outline: { heading: string; purpose: string; basedOn: BriefKind }[];
  questions: BriefItem[];
  cta: { label: string | null; objective: string; target: string; supported: boolean };
  reliability: Reliability;
};

const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const splitList = (s?: string | null) => (s ?? "").split(/[\n;]+/).map((x) => x.trim()).filter(Boolean);

const INFO_RE = /\b(comment|pourquoi|qu'est|qu’est|guide|quel(?:le)?s?|conseils?|astuces?|exemples?)\b/i;
const TRANS_RE = /\b(devis|prix|tarifs?|acheter|commander|réserver|réservation|inscription|essai|démo|demo)\b/i;
const COMM_RE = /\b(meilleur(?:e)?s?|comparatif|avis|vs|alternative)\b/i;

/** Intention probable d'après les mots du sujet : une HYPOTHÈSE de lecture, pas une donnée de recherche. */
export function guessIntent(topic: string | null): SearchIntent | null {
  if (!topic) return null;
  if (COMM_RE.test(topic)) return "commercial"; // la comparaison (« meilleur », « avis »…) prime sur le mot « devis »
  if (TRANS_RE.test(topic)) return "transactional";
  if (INFO_RE.test(topic)) return "informational";
  return null;
}

export function buildBrief(i: BriefInput): ContentBrief {
  const hero = i.page.sections.find((s) => s.type === "hero");
  const headline = hero?.type === "hero" ? hero.headline.trim() : "";
  const seoTitle = (i.page.seoTitle ?? "").trim();
  const topic = seoTitle || headline || null;
  const topicSource = seoTitle ? "Titre SEO de la page" : headline ? "Titre principal (H1) de la page" : "Aucun titre SEO ni H1 : sujet indéterminé";
  const text = pageText(i.page.sections);
  const faq = faqItems(i.page.sections);
  const facts: BriefItem[] = [];
  const f = (t: string, source: string) => facts.push({ kind: "fact", text: t, source });
  const gaps: string[] = [];

  f(`Page « ${i.page.name} » — statut : ${i.page.status === "published" ? "publiée" : i.page.status === "archived" ? "archivée" : "brouillon"}.`, "Landing page");
  if (seoTitle) f(`Titre SEO actuel : « ${clip(seoTitle)} » (${seoTitle.length} caractères).`, "Landing page");
  if (i.page.seoDescription?.trim()) f(`Méta-description actuelle : « ${clip(i.page.seoDescription.trim())} ».`, "Landing page");
  if (headline) f(`Titre principal : « ${clip(headline)} ».`, "Landing page");
  f(`${i.audit.wordCount} mots visibles sur la page ; ${faq.length} question(s) de FAQ ; score de diagnostic ${i.audit.score}/100 (heuristique).`, "Diagnostic SEO");
  if (i.offer) {
    f(`Offre rattachée : « ${i.offer.name} »${i.offer.price != null ? ` au prix de ${i.offer.price} ${i.offer.currency}` : ""}.`, "Offre");
    if (i.offer.problem?.trim()) f(`Problème client décrit dans l'offre : « ${clip(i.offer.problem.trim(), 200)} ».`, "Offre");
  } else gaps.push("Aucune offre rattachée à la page : objectif commercial, prix et problème client inconnus.");
  if (i.audience) {
    f(`Public cible : « ${i.audience.name} » (${i.audience.type === "b2b" ? "entreprises" : "particuliers"}).`, "Audience");
    if (i.audience.needs?.trim()) f(`Besoins déclarés : ${clip(i.audience.needs.trim(), 200)}.`, "Audience");
    if (i.audience.problems?.trim()) f(`Problèmes déclarés : ${clip(i.audience.problems.trim(), 200)}.`, "Audience");
  } else gaps.push("Aucune audience renseignée (via l'offre) : le public cible n'est pas déterminé.");
  if (i.campaign) f(`Campagne rattachée : « ${i.campaign.name} »${i.campaign.objective ? ` — objectif : ${i.campaign.objective}` : ""}.`, "Campagne");
  if (i.metrics) {
    if (i.metrics.views > 0) f(`Mesures internes : ${i.metrics.views} visite(s), ${i.metrics.ctaClicks} clic(s) sur le bouton, ${i.metrics.leads} lead(s).`, "Analytics SEA Pilot");
    else gaps.push("Aucune visite mesurée sur la page : impossible de savoir ce qui fonctionne déjà.");
  }
  if (!topic) gaps.push("Aucun titre SEO ni titre principal : le sujet du contenu n'est pas déterminé.");
  if (!text.trim() || (i.audit.wordCount < 60)) gaps.push("Le contenu actuel de la page est trop court pour servir de base factuelle : le brief devra être complété à la main.");
  gaps.push("Aucune donnée de mots-clés ni de concurrents : SEA Pilot ne fournit ni volume de recherche, ni difficulté, ni analyse concurrentielle. Ne choisissez pas un mot-clé sur la base de ce brief seul.");

  const recommendations: BriefItem[] = i.audit.issues.map((c) => ({ kind: "recommendation" as const, text: `${c.label} : ${c.recommendation ?? c.detail}`, source: `Diagnostic SEO — impact ${c.impact === "high" ? "fort" : c.impact === "medium" ? "moyen" : "faible"}`, checkId: c.id }));

  const intentGuess = guessIntent(topic);
  const intent = { value: intentGuess, item: { kind: "hypothesis" as const, source: "Lecture du sujet (aucune donnée de recherche)", text: intentGuess ? `Intention probable : ${INTENT_LABEL[intentGuess].toLowerCase()} — à confirmer en observant ce que vos clients demandent vraiment.` : "Intention non déterminable d'après le sujet seul." } };
  if (!intentGuess && topic) gaps.push("L'intention de recherche du lecteur ne peut pas être déduite du sujet : à préciser.");

  const mainQuestion: BriefItem | null = faq[0] ? { kind: "fact", text: faq[0].q, source: "Première question de la FAQ de la page" } : null;
  if (!mainQuestion) gaps.push("Aucune question principale identifiable : la FAQ est vide. Saisissez-la ou laissez l'IA proposer une hypothèse.");

  const questions: BriefItem[] = [];
  for (const o of splitList(i.audience?.objections)) questions.push({ kind: "fact", text: `${o.endsWith("?") ? o : `${o} ?`}`, source: "Objection déclarée dans l'audience — à traiter dans la FAQ" });
  const solution = i.page.sections.some((s) => s.type === "solution" && s.body.trim());
  if (!solution) questions.push({ kind: "hypothesis", text: `Comment fonctionne ${i.offer?.name ?? "votre offre"}, concrètement ?`, source: "Aucune section « Solution » renseignée : question probable, à valider" });
  if (i.offer?.price != null && !text.includes(String(i.offer.price))) questions.push({ kind: "hypothesis", text: `Combien coûte ${i.offer.name} ?`, source: "Le prix de l'offre n'apparaît pas sur la page : question probable, à valider" });
  if (i.audience && !text.toLowerCase().includes(i.audience.name.toLowerCase())) questions.push({ kind: "hypothesis", text: `Cette offre est-elle faite pour ${i.audience.name} ?`, source: "L'audience n'est pas nommée sur la page : question probable, à valider" });

  const hasProof = i.page.sections.some((s) => (s.type === "proof" && s.stats.some((x) => x.value)) || (s.type === "testimonials" && s.items.some((x) => x.quote)));
  const outline: ContentBrief["outline"] = [
    { heading: topic ? `Introduction : répondre directement à « ${clip(mainQuestion?.text ?? topic, 80)} »` : "Introduction : réponse directe (sujet à définir)", purpose: "Donner la réponse dans les deux premières phrases (lecture rapide et reprise par les moteurs de réponse).", basedOn: mainQuestion ? "fact" : "recommendation" },
    { heading: "Le problème du lecteur", purpose: i.offer?.problem || i.audience?.problems ? "S'appuyer sur le problème décrit dans l'offre et l'audience." : "Décrire le problème avec les mots des clients (à recueillir : aucun problème n'est renseigné).", basedOn: i.offer?.problem || i.audience?.problems ? "fact" : "recommendation" },
    { heading: "La solution, étape par étape", purpose: "Expliquer comment l'offre résout le problème, sans promesse non démontrée.", basedOn: "recommendation" },
    { heading: "Preuves", purpose: hasProof ? "Reprendre les chiffres et témoignages réels déjà présents sur la page." : "À fournir par vous (cas clients, chiffres réels). Ne rien inventer : laissez la section vide plutôt que fictive.", basedOn: hasProof ? "fact" : "recommendation" },
    { heading: "Questions fréquentes", purpose: `Traiter ${questions.length > 0 ? `les ${questions.length} question(s) ci-dessous` : "3 à 6 questions réelles de vos clients"}, réponse directe de 1 à 3 phrases.`, basedOn: "recommendation" },
    { heading: "Appel à l'action", purpose: "Renvoyer vers la landing page pour déclencher la conversion.", basedOn: "recommendation" },
  ];

  const ctaSection = i.page.sections.find((s) => s.type === "cta");
  const label = ctaSection?.type === "cta" ? ctaSection.ctaLabel : hero?.type === "hero" ? hero.ctaLabel : null;
  const cta = i.hasActiveForm
    ? { label, objective: "Demande de contact : le formulaire de la page capture un e-mail ou un téléphone (conversion mesurée par SEA Pilot).", target: i.page.url, supported: true }
    : { label, objective: "Aucune conversion prise en charge : la page n'a pas de formulaire actif.", target: i.page.url, supported: false };
  if (!i.hasActiveForm) gaps.push("La page n'a pas de formulaire actif : le contenu ne pourrait pas produire de lead.");

  const reliability: Reliability = !topic ? "insufficient" : (!i.offer || !i.audience || i.audit.wordCount < 60) ? "partial" : "sufficient";
  return { topic, topicSource, intent, mainQuestion, facts, gaps, recommendations, outline, questions, cta, reliability };
}

// ── Génération IA (explicite, via generate()) ──

const s = (max: number) => z.string().trim().min(1).max(max);
export const aiBriefSchema = z.object({
  workingTitle: s(160),
  searchIntent: z.enum(["informational", "commercial", "transactional", "navigational"]),
  intentRationale: s(400),
  audience: z.string().trim().max(300).default(""),
  mainQuestion: s(300),
  outline: z.array(z.object({ heading: s(160), points: z.array(s(300)).max(6).default([]) })).min(1).max(10),
  secondaryQuestions: z.array(s(240)).max(10).default([]),
  faq: z.array(z.object({ q: s(240), a: s(600) })).max(8).default([]),
  seoNotes: z.array(s(300)).max(8).default([]),
  cta: s(300),
  assumptions: z.array(s(300)).max(8).default([]),
});
export type AiBrief = z.infer<typeof aiBriefSchema>;

export function contentBriefPrompt(b: ContentBrief): string {
  return [
    "Prépare un BRIEF DE CONTENU (article ou page de blog) qui soutient la landing page décrite ci-dessous et traite ses lacunes.",
    "Utilise UNIQUEMENT les faits fournis. N'invente aucun chiffre, prix, statistique, volume de recherche, difficulté de mot-clé, nom de concurrent, témoignage ou résultat.",
    "Tout ce qui n'est pas dans les faits doit figurer dans « assumptions » (hypothèses à valider), jamais dans le texte comme un fait.",
    "Les réponses de la FAQ doivent rester générales et prudentes si les faits ne les couvrent pas.",
    wrap("faits", b.facts.map((x) => `${x.text} [${x.source}]`)),
    wrap("lacunes_de_donnees", b.gaps),
    wrap("recommandations_seo", b.recommendations.map((x) => x.text)),
    wrap("questions_a_couvrir", b.questions.map((x) => x.text)),
    wrap("appel_a_l_action", { libelle: b.cta.label, objectif: b.cta.objective, page: b.cta.target }),
    'Réponds par un JSON : {"workingTitle","searchIntent" (informational|commercial|transactional|navigational),"intentRationale","audience","mainQuestion","outline":[{"heading","points":[]}],"secondaryQuestions":[],"faq":[{"q","a"}],"seoNotes":[],"cta","assumptions":[]}.',
  ].join("\n\n");
}

const FIGURE_RE = /\d[\d\s.,]*\s?(?:%|€|\$|k€|M€)|\b\d{2,}(?:[.,]\d+)?\b/g;
/** Chiffres cités par l'IA qui n'existent dans aucune donnée fournie : à vérifier avant tout usage (l'IA peut inventer). */
export function unsupportedFigures(ai: AiBrief, allowedText: string): string[] {
  const norm = (x: string) => x.replace(/\s/g, "");
  const allowed = norm(allowedText);
  const out = new Set<string>();
  const strings = [ai.workingTitle, ai.intentRationale, ai.audience, ai.mainQuestion, ai.cta, ...ai.outline.flatMap((o) => [o.heading, ...o.points]), ...ai.secondaryQuestions, ...ai.faq.flatMap((x) => [x.q, x.a]), ...ai.seoNotes];
  for (const t of strings) for (const m of t.match(FIGURE_RE) ?? []) { const k = norm(m).replace(/[.,]$/, ""); if (k && !allowed.includes(k)) out.add(m.trim()); }
  return [...out];
}

/** Texte de référence pour contrôler les chiffres de l'IA : faits du brief + contenu de la page. */
export const groundingText = (b: ContentBrief, pageContent: string) => [...b.facts.map((x) => x.text), ...b.questions.map((x) => x.text), pageContent].join("\n");

// ── Export Markdown (brief manuel, utilisable sans IA) ──

export function briefToMarkdown(b: ContentBrief, ai?: AiBrief | null): string {
  const L: string[] = [`# Brief de contenu — ${ai?.workingTitle ?? b.topic ?? "sujet à définir"}`, ""];
  const items = (xs: BriefItem[]) => xs.map((x) => `- [${KIND_LABEL[x.kind]}] ${x.text} _(source : ${x.source})_`);
  L.push("## Faits issus de vos données", ...items(b.facts), "");
  if (b.gaps.length) L.push("## Données manquantes", ...b.gaps.map((g) => `- ${g}`), "");
  L.push("## Intention et question principale", `- [${KIND_LABEL[b.intent.item.kind]}] ${b.intent.item.text}`, b.mainQuestion ? `- [Fait] Question principale : ${b.mainQuestion.text}` : "- Question principale : à définir", "");
  if (b.recommendations.length) L.push("## Lacunes SEO à traiter", ...items(b.recommendations), "");
  L.push("## Plan proposé", ...b.outline.map((o, i) => `${i + 1}. ${o.heading} — ${o.purpose}`), "");
  if (b.questions.length) L.push("## Questions à couvrir", ...items(b.questions), "");
  L.push("## Appel à l'action", `- ${b.cta.objective}`, `- Libellé : ${b.cta.label ?? "à définir"} — Page : ${b.cta.target}`, "");
  if (ai) {
    L.push("## Proposition générée par l'IA (à relire : ce sont des hypothèses)", `- Intention : ${INTENT_LABEL[ai.searchIntent]} — ${ai.intentRationale}`, `- Question principale : ${ai.mainQuestion}`, "");
    L.push(...ai.outline.flatMap((o, i) => [`${i + 1}. ${o.heading}`, ...o.points.map((p) => `   - ${p}`)]), "");
    if (ai.faq.length) L.push("### FAQ proposée", ...ai.faq.flatMap((x) => [`- **${x.q}** ${x.a}`]), "");
    if (ai.seoNotes.length) L.push("### Notes SEO / moteurs de réponse", ...ai.seoNotes.map((x) => `- ${x}`), "");
    if (ai.assumptions.length) L.push("### Hypothèses à valider", ...ai.assumptions.map((x) => `- ${x}`), "");
  }
  return L.join("\n");
}
