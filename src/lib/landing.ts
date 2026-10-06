import { z } from "zod";

// Contenu des landing pages : uniquement du TEXTE structuré (rendu par React, donc échappé : pas de HTML libre → pas de XSS).
// Les URL sont limitées à http(s) / chemins relatifs.

const text = (max: number) => z.string().trim().max(max);
export const safeUrl = z
  .string()
  .trim()
  .max(500)
  .refine((u) => u === "" || /^https?:\/\//i.test(u) || u.startsWith("/") || u.startsWith("#"), "URL http(s) attendue")
  .refine((u) => !/^\s*(javascript|data|vbscript):/i.test(u), "URL interdite");

const id = z.string().trim().min(1).max(40);

export const sectionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hero"), id, headline: text(160), subheadline: text(400).default(""), ctaLabel: text(60).default("Obtenir mon devis") }),
  z.object({ type: z.literal("problem"), id, title: text(160), items: z.array(text(240)).max(8).default([]) }),
  z.object({ type: z.literal("solution"), id, title: text(160), body: text(1200).default("") }),
  z.object({ type: z.literal("benefits"), id, title: text(160), items: z.array(z.object({ title: text(120), text: text(400).default("") })).max(8).default([]) }),
  // preuve et témoignages : fournis par l'utilisateur, jamais générés
  z.object({ type: z.literal("proof"), id, title: text(160), stats: z.array(z.object({ value: text(40), label: text(120) })).max(6).default([]) }),
  z.object({ type: z.literal("testimonials"), id, title: text(160), items: z.array(z.object({ quote: text(500), author: text(120), role: text(120).default("") })).max(6).default([]) }),
  z.object({ type: z.literal("faq"), id, title: text(160), items: z.array(z.object({ q: text(240), a: text(800) })).max(12).default([]) }),
  z.object({ type: z.literal("cta"), id, title: text(160), text: text(400).default(""), ctaLabel: text(60).default("Envoyer ma demande") }),
  z.object({ type: z.literal("footer"), id, text: text(400).default(""), links: z.array(z.object({ label: text(60), url: safeUrl })).max(6).default([]) }),
]);
export const sectionsSchema = z.array(sectionSchema).min(1).max(20);
export type Section = z.infer<typeof sectionSchema>;
export type SectionType = Section["type"];
export const SECTION_LABEL: Record<SectionType, string> = {
  hero: "Hero", problem: "Problème", solution: "Solution", benefits: "Bénéfices", proof: "Preuve", testimonials: "Témoignages", faq: "FAQ", cta: "Appel à l'action + formulaire", footer: "Pied de page",
};

export const themeSchema = z.object({ primary: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#2563eb") });
export type Theme = z.infer<typeof themeSchema>;

export const FIELD_TYPES = ["text", "email", "tel", "textarea", "select"] as const;
export const formFieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,30}$/),
  label: text(80).min(1),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().default(false),
  options: z.array(text(80)).max(20).optional(),
});
export const formFieldsSchema = z.array(formFieldSchema).min(1).max(12).refine((f) => f.some((x) => x.key === "email") || f.some((x) => x.key === "phone"), "Le formulaire doit demander un e-mail ou un téléphone");
export type FormField = z.infer<typeof formFieldSchema>;

export const DEFAULT_FORM_FIELDS: FormField[] = [
  { key: "name", label: "Nom complet", type: "text", required: true },
  { key: "email", label: "E-mail professionnel", type: "email", required: true },
  { key: "phone", label: "Téléphone", type: "tel", required: false },
  { key: "company", label: "Entreprise", type: "text", required: false },
  { key: "message", label: "Décrivez votre besoin", type: "textarea", required: false },
];
export const DEFAULT_CONSENT = "Je souhaite aussi recevoir des informations et offres commerciales par e-mail (facultatif — désinscription possible à tout moment).";

let n = 0;
export const sid = (p: string) => `${p}-${(++n).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function defaultSections(o: { name: string; headline?: string; subheadline?: string; benefits?: string[] }): Section[] {
  const benefits = (o.benefits?.length ? o.benefits : ["Un premier échange sans engagement", "Une réponse rapide", "Un accompagnement personnalisé"]).slice(0, 6);
  return [
    { type: "hero", id: sid("hero"), headline: o.headline ?? o.name, subheadline: o.subheadline ?? "Décrivez-nous votre besoin : nous revenons vers vous rapidement.", ctaLabel: "Obtenir une réponse" },
    { type: "problem", id: sid("problem"), title: "Le problème", items: [] },
    { type: "solution", id: sid("solution"), title: "Notre solution", body: "" },
    { type: "benefits", id: sid("benefits"), title: "Ce que vous obtenez", items: benefits.map((b) => ({ title: b, text: "" })) },
    { type: "faq", id: sid("faq"), title: "Questions fréquentes", items: [] },
    { type: "cta", id: sid("cta"), title: "Parlons de votre projet", text: "Laissez-nous vos coordonnées, nous vous recontactons.", ctaLabel: "Envoyer ma demande" },
    { type: "footer", id: sid("footer"), text: "", links: [] },
  ];
}

/** Sections « vides » (sans texte utile) non affichées sur la page publique. */
export function isRenderable(s: Section): boolean {
  switch (s.type) {
    case "problem": return s.items.some(Boolean);
    case "solution": return !!s.body;
    case "benefits": return s.items.some((i) => i.title);
    case "proof": return s.stats.some((x) => x.value);
    case "testimonials": return s.items.some((x) => x.quote);
    case "faq": return s.items.some((x) => x.q && x.a);
    default: return true;
  }
}

export function parseSections(raw: unknown): Section[] {
  const r = sectionsSchema.safeParse(raw);
  return r.success ? r.data : [];
}

export function pageUrl(base: string, wsSlug: string, pageSlug: string): string {
  return `${base}/p/${wsSlug}/${pageSlug}`;
}

/** Champs proposables dans un formulaire. Les champs « qualifiants » alimentent la qualification des leads. */
export const FIELD_LIBRARY: (FormField & { column?: boolean })[] = [
  { key: "name", label: "Nom complet", type: "text", required: true },
  { key: "email", label: "E-mail", type: "email", required: true },
  { key: "phone", label: "Téléphone", type: "tel", required: false },
  { key: "company", label: "Entreprise", type: "text", required: false },
  { key: "message", label: "Décrivez votre besoin", type: "textarea", required: false },
  { key: "budget", label: "Budget estimé", type: "text", required: false },
  { key: "urgence", label: "Échéance du projet", type: "select", required: false, options: ["Dès que possible", "Sous 1 mois", "Sous 3 mois", "Pas de date précise"] },
  { key: "ville", label: "Ville", type: "text", required: false },
  { key: "taille", label: "Nombre de personnes dans l'entreprise", type: "text", required: false },
];
