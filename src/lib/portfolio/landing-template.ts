import type { Section } from "../landing";

// Landing page commerciale générée depuis la FICHE d'un produit du portefeuille (générique : FreelanceNexa, DriverPilot, OperaPilot, futurs SaaS).
// Règle : seuls des faits de la fiche sont affichés. Fonctionnalités « non vérifiées » exclues des bénéfices ; tarif affiché seulement s'il est
// confirmé AVEC sa devise ; aucun témoignage, chiffre, logo client ni promesse de gain n'est produit. Les manques sont renvoyés dans `gaps`.

export type TemplateProduct = {
  slug: string; name: string; tagline: string | null; description: string | null; valueProposition: string | null; targetCustomers: string | null;
  problemsSolved: unknown; features: unknown; pricing: unknown; signupUrl: string | null; publicUrl: string | null; unconfirmed: unknown;
};
type Feature = { text: string; verified: boolean; note?: string };
type Plan = { name: string; amount: number | null; currency: string | null; interval: "month" | "year" | null; verified: boolean };

const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).replace(/\s+\S*$/, "")}…`);
const stripDot = (s: string) => s.trim().replace(/[.\s]+$/, "");
const NOT_AVAILABLE = /^(NON disponible|Non implémenté)/i;

export type LandingDraft = { name: string; sections: Section[]; seoTitle: string; seoDescription: string; consentText: string; formFieldKeys: string[]; gaps: string[]; pricingShown: boolean };

export function signupLink(product: Pick<TemplateProduct, "slug" | "signupUrl">): string | null {
  if (!product.signupUrl || !/^https?:\/\//i.test(product.signupUrl)) return null;
  try {
    const u = new URL(product.signupUrl);
    u.searchParams.set("utm_source", "seapilot"); u.searchParams.set("utm_medium", "landing_page"); u.searchParams.set("utm_content", product.slug);
    return u.toString();
  } catch { return null; }
}

export function planLabel(p: Plan): string {
  return `${p.name} : ${p.amount} ${p.currency} par ${p.interval === "year" ? "an" : "mois"}`;
}

export function buildProductLanding(p: TemplateProduct, sid: (prefix: string) => string): LandingDraft {
  const gaps: string[] = [];
  const features = arr<Feature>(p.features);
  const verified = features.filter((f) => f.verified && f.text.trim());
  const missing = features.filter((f) => !f.verified && NOT_AVAILABLE.test(f.note ?? ""));
  const problems = arr<string>(p.problemsSolved).map((x) => x.trim()).filter(Boolean);
  const plans = arr<Plan>((p.pricing as { plans?: unknown } | null)?.plans).filter((x) => x.verified && x.amount != null && x.amount > 0 && !!x.currency);
  const trial = verified.find((f) => /essai gratuit/i.test(f.text));
  const link = signupLink(p);
  const headline = stripDot(p.tagline || p.valueProposition || p.name);
  const sub = (p.valueProposition || p.description || "").trim();

  if (!p.tagline) gaps.push("Accroche absente de la fiche : le nom du produit sert de titre.");
  if (!sub) gaps.push("Proposition de valeur et description absentes de la fiche : sous-titre vide.");
  if (verified.length === 0) gaps.push("Aucune fonctionnalité vérifiée sur la fiche : aucun bénéfice affiché.");
  if (plans.length === 0) gaps.push("Tarif non confirmé (montant et devise) : aucun prix n'est affiché.");
  if (!link) gaps.push("URL d'inscription du produit absente ou invalide : seul le formulaire de contact est proposé.");
  if (problems.length === 0) gaps.push("Aucun problème client sur la fiche : section « problème » omise.");
  gaps.push("Aucune preuve (témoignage, chiffre, logo) : rien n'est inventé ; ajoutez-en seulement des réels.");
  gaps.push("Aucune page légale propre au produit n'est disponible : le formulaire renvoie à la politique de confidentialité de SEA Pilot (lien intégré au formulaire).");

  const sections: Section[] = [
    { type: "hero", id: sid("hero"), headline: clip(headline, 160), subheadline: clip(sub, 400), ctaLabel: trial ? "Essayer gratuitement" : "Nous contacter" },
  ];
  if (problems.length) sections.push({ type: "problem", id: sid("problem"), title: "Ce qui complique votre quotidien", items: problems.slice(0, 8).map((x) => clip(x, 240)) });
  if (p.description?.trim()) sections.push({ type: "solution", id: sid("solution"), title: `Avec ${p.name}`, body: clip(p.description.trim(), 1200) });
  if (verified.length) sections.push({ type: "benefits", id: sid("benefits"), title: "Ce que le produit fait aujourd'hui", items: verified.slice(0, 8).map((f) => ({ title: clip(f.text.trim(), 120), text: "" })) });

  const faq: { q: string; a: string }[] = [];
  if (p.targetCustomers?.trim()) faq.push({ q: `${p.name} est-il fait pour moi ?`, a: `${p.name} s'adresse à : ${stripDot(p.targetCustomers)}.` });
  if (verified.length) faq.push({ q: `Que puis-je faire avec ${p.name} ?`, a: `${verified.slice(0, 6).map((f) => stripDot(f.text)).join(" ; ")}.` });
  if (trial) faq.push({ q: "L'essai est-il gratuit ?", a: `${stripDot(trial.text)}.` });
  if (plans.length) faq.push({ q: "Combien coûte l'abonnement ?", a: `${plans.map(planLabel).join(" ; ")}.` });
  if (missing.length) faq.push({ q: "Quelles fonctions ne sont pas encore disponibles ?", a: `Pas encore disponible : ${missing.map((f) => stripDot(f.text)).join(" ; ")}.` });
  if (link) faq.push({ q: "Comment commencer ?", a: "Créez votre compte avec le lien en bas de page, ou laissez-nous vos coordonnées avec le formulaire." });
  if (faq.length) sections.push({ type: "faq", id: sid("faq"), title: "Questions fréquentes", items: faq.map((x) => ({ q: clip(x.q, 240), a: clip(x.a, 800) })) });

  sections.push({ type: "cta", id: sid("cta"), title: "Une question avant de commencer ?", text: link ? "Laissez vos coordonnées : nous vous répondons. Vous pouvez aussi créer votre compte directement avec le lien ci-dessous." : "Laissez vos coordonnées : nous vous répondons.", ctaLabel: "Envoyer" });
  sections.push({ type: "footer", id: sid("footer"), text: `${p.name}${p.tagline ? ` — ${stripDot(p.tagline)}` : ""}.`, links: link ? [{ label: `Créer mon compte ${p.name}`, url: link }] : [] });

  const seoTitle = clip(p.tagline ? `${p.name} : ${stripDot(p.tagline)}` : p.name, 60);
  const seoDescription = clip(sub.length >= 70 ? sub : [stripDot(p.tagline ?? ""), sub].filter(Boolean).join(". "), 160);
  return {
    name: `${p.name} — présentation`, sections, seoTitle, seoDescription, pricingShown: plans.length > 0, gaps,
    consentText: "Je souhaite aussi recevoir des informations sur ce produit (facultatif — je peux m'y opposer à tout moment). Mes coordonnées servent d'abord à répondre à ma demande.",
    formFieldKeys: ["name", "email", "message"],
  };
}
