// Règles pures (sans base de données) du portefeuille multi-produits : déduplication, éligibilité au contact, import CSV, conversions.
// Tout ce qui décide « a-t-on le droit de contacter cette personne ? » vit ici, testé unitairement.
import { parseCsv } from "../csv";
import { slugify } from "../workspaces";

export const PRODUCT_STATUSES = ["preparation", "validation", "commercialisation", "suspended"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
export const PRODUCT_STATUS_LABEL: Record<string, string> = { preparation: "Préparation", validation: "Validation", commercialisation: "Commercialisation", suspended: "Suspendu" };

export const PROSPECT_STATUSES = ["identified", "contacted", "replied", "demo", "trial", "customer", "lost", "do_not_contact"] as const;
export type ProspectStatus = (typeof PROSPECT_STATUSES)[number];
export const PROSPECT_STATUS_LABEL: Record<string, string> = {
  identified: "Identifié", contacted: "Contacté", replied: "A répondu", demo: "Démonstration", trial: "Essai", customer: "Client", lost: "Perdu", do_not_contact: "Ne pas contacter",
};

export const LEGAL_BASES = ["consent_express", "implied_published", "implied_relationship", "none", "unknown"] as const;
export type LegalBasis = (typeof LEGAL_BASES)[number];
export const LEGAL_BASIS_LABEL: Record<string, string> = {
  consent_express: "Consentement exprès documenté",
  implied_published: "Consentement implicite : adresse professionnelle publiée sans mention contraire",
  implied_relationship: "Consentement implicite : relation d'affaires existante",
  none: "Aucune base de contact",
  unknown: "À confirmer",
};

export const OUTREACH_CHANNELS = ["email", "linkedin", "phone", "social"] as const;
export type OutreachChannelId = (typeof OUTREACH_CHANNELS)[number];
export const CHANNEL_LABEL: Record<string, string> = { email: "Courriel", linkedin: "LinkedIn", phone: "Téléphone", social: "Réseaux / communautés", in_person: "En personne" };

export const EVENT_TYPES = ["signup", "trial_started", "demo", "payment_confirmed", "cancellation"] as const;
export type ProductEventType = (typeof EVENT_TYPES)[number];
export const EVENT_LABEL: Record<string, string> = { signup: "Inscription", trial_started: "Début d'essai", demo: "Démonstration", payment_confirmed: "Paiement confirmé", cancellation: "Résiliation" };

// ───────────── Déduplication globale ─────────────
export const normalizeEmail = (e?: string | null): string | null => {
  const v = e?.trim().toLowerCase();
  return v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
};

export function normalizePhone(p?: string | null): string | null {
  const d = (p ?? "").replace(/\D/g, "");
  const n = d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
  return n.length >= 7 ? n : null;
}

/** Clé d'identité d'une personne, commune à tous les produits : e-mail, sinon téléphone, sinon société + nom. */
export function dedupeKeyOf(p: { email?: string | null; phone?: string | null; company?: string | null; name: string }): string {
  const e = normalizeEmail(p.email);
  if (e) return `e:${e}`;
  const t = normalizePhone(p.phone);
  if (t) return `p:${t}`;
  return `n:${slugify(p.company ?? "")}|${slugify(p.name)}`;
}

export const domainOf = (url?: string | null): string | null => {
  const v = url?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  return v && v.includes(".") ? v : null;
};

// ───────────── Éligibilité au contact ─────────────
export type EligibilityInput = {
  now?: Date;
  channel: string;
  /** produit pour lequel on veut contacter */
  productId: string;
  product: { status: string; deletedAt?: Date | null } | null;
  prospect: {
    productId: string | null; status: string; optedOutAt: Date | null; legalBasis: string; audienceType: string; email: string | null; phone: string | null;
    contactCount: number; lastContactedAt: Date | null; source: string | null; collectedAt: Date | null; campaignId: string | null; deletedAt?: Date | null;
  };
  /** adresse présente dans la liste de suppression du workspace (désinscription) */
  suppressed: boolean;
  channelSetting: { enabled: boolean; minDaysBetweenContacts: number; maxContactsPerProspect: number } | null;
  template?: { status: string; productId: string; channel: string } | null;
  /** ids des campagnes de prospection actives d'AUTRES produits qui ciblent déjà ce prospect */
  concurrentCampaign?: boolean;
};

export type Eligibility = { ok: boolean; reasons: string[] };

export function contactEligibility(i: EligibilityInput): Eligibility {
  const r: string[] = [];
  const now = i.now ?? new Date();
  const p = i.prospect;
  if (!i.product || i.product.deletedAt) r.push("Produit introuvable.");
  else if (i.product.status !== "commercialisation") r.push(`Le produit n'est pas en commercialisation (statut : ${PRODUCT_STATUS_LABEL[i.product.status] ?? i.product.status}).`);
  if (p.deletedAt) r.push("Prospect supprimé.");
  if (p.productId !== i.productId) r.push(p.productId ? "Ce prospect est attribué à un autre produit : réattribution explicite requise." : "Ce prospect n'est attribué à aucun produit.");
  if (p.optedOutAt || p.status === "do_not_contact") r.push("Le prospect s'est opposé à tout contact.");
  if (i.suppressed) r.push("L'adresse figure dans la liste de désinscription.");
  if (i.concurrentCampaign) r.push("Une campagne d'un autre produit cible déjà cette personne.");
  if (!p.source?.trim()) r.push("Provenance non renseignée.");
  if (!p.collectedAt) r.push("Date de collecte non renseignée.");
  if (p.legalBasis === "none" || p.legalBasis === "unknown" || !(LEGAL_BASES as readonly string[]).includes(p.legalBasis)) r.push("Base de contact non documentée.");
  if (p.legalBasis === "implied_published" && p.audienceType !== "b2b") r.push("Un consentement implicite par adresse publiée ne vaut que pour un contact professionnel (B2B).");
  if (!(OUTREACH_CHANNELS as readonly string[]).includes(i.channel)) r.push("Canal inconnu.");
  if (!i.channelSetting?.enabled) r.push(`Le canal « ${CHANNEL_LABEL[i.channel] ?? i.channel} » est désactivé.`);
  if (i.channel === "email" && !p.email) r.push("Aucune adresse courriel.");
  if (i.channel === "phone" && !p.phone) r.push("Aucun numéro de téléphone.");
  if (i.channelSetting) {
    if (p.contactCount >= i.channelSetting.maxContactsPerProspect) r.push(`Nombre maximal de contacts atteint (${i.channelSetting.maxContactsPerProspect}).`);
    if (p.lastContactedAt && now.getTime() - p.lastContactedAt.getTime() < i.channelSetting.minDaysBetweenContacts * 86_400_000) r.push(`Dernier contact trop récent (minimum ${i.channelSetting.minDaysBetweenContacts} jours).`);
  }
  if (i.template !== undefined) {
    if (!i.template) r.push("Aucun modèle de message sélectionné.");
    else {
      if (i.template.status !== "approved") r.push("Le modèle de message n'est pas approuvé.");
      if (i.template.productId !== i.productId) r.push("Le modèle appartient à un autre produit.");
      if (i.template.channel !== i.channel) r.push("Le modèle ne correspond pas au canal.");
    }
  }
  return { ok: r.length === 0, reasons: r };
}

// ───────────── Conversions : anti double comptabilisation ─────────────
export function eventDedupeKey(e: { productId: string; type: string; prospectId?: string | null; externalRef?: string | null; occurredAt: Date; amount?: number | null }): string {
  const day = e.occurredAt.toISOString().slice(0, 10);
  const ref = e.externalRef?.trim();
  if (ref) return `${e.productId}:${e.type}:ref:${ref.toLowerCase()}`;
  if (!e.prospectId) throw new Error("Une conversion exige un prospect ou une référence externe.");
  if (e.type === "payment_confirmed") return `${e.productId}:payment_confirmed:p:${e.prospectId}:${day}:${(e.amount ?? 0).toFixed(2)}`;
  if (e.type === "demo") return `${e.productId}:demo:p:${e.prospectId}:${day}`;
  return `${e.productId}:${e.type}:p:${e.prospectId}`; // inscription, essai, résiliation : une seule fois par prospect et produit
}

// ───────────── Import CSV contrôlé ─────────────
export const MAX_IMPORT_ROWS = 500;

export type ImportRow = {
  line: number; name: string; company?: string; jobTitle?: string; email?: string; phone?: string; website?: string; audienceType: "b2b" | "b2c";
  segment?: string; source: string; sourceUrl?: string; collectedAt: Date; legalBasis: LegalBasis; legalBasisNote?: string; productSlug?: string; notes?: string;
};
export type ImportParse = { rows: ImportRow[]; errors: { line: number; message: string }[] };

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const COLS: Record<string, string[]> = {
  name: ["name", "nom", "contact", "nomcomplet"], company: ["company", "entreprise", "societe", "organisation"], jobTitle: ["jobtitle", "titre", "poste", "fonction", "role"],
  email: ["email", "courriel", "mail", "adressecourriel"], phone: ["phone", "telephone", "tel", "cellulaire"], website: ["website", "site", "siteweb", "domaine", "url"],
  audienceType: ["audience", "type", "audiencetype", "typeclient", "b2bb2c"], segment: ["segment"], source: ["source", "provenance"], sourceUrl: ["sourceurl", "urlsource", "lien", "lienpublic"],
  collectedAt: ["collectedat", "datecollecte", "datedecollecte", "date", "collecte"], legalBasis: ["legalbasis", "baselegale", "basedecontact", "consentement"],
  legalBasisNote: ["legalbasisnote", "notebase", "preuve"], productSlug: ["product", "produit", "slug"], notes: ["notes", "note", "commentaire"],
};
const BASIS_ALIAS: Record<string, LegalBasis> = {
  consentexpres: "consent_express", consentementexpres: "consent_express", express: "consent_express", consentexpress: "consent_express",
  impliciteadressepubliee: "implied_published", impliedpublished: "implied_published", publie: "implied_published", publiee: "implied_published", adressepubliee: "implied_published",
  implicitedrelation: "implied_relationship", impliedrelationship: "implied_relationship", relation: "implied_relationship", relationexistante: "implied_relationship",
  aucune: "none", none: "none", inconnu: "unknown", unknown: "unknown", aconfirmer: "unknown",
};

export function parseProspectCsv(text: string): ImportParse {
  const table = parseCsv(text);
  const errors: ImportParse["errors"] = [];
  if (table.length < 2) return { rows: [], errors: [{ line: 1, message: "Le fichier doit contenir un en-tête et au moins une ligne." }] };
  if (table.length - 1 > MAX_IMPORT_ROWS) return { rows: [], errors: [{ line: 1, message: `Maximum ${MAX_IMPORT_ROWS} lignes par import.` }] };
  const head = table[0].map(fold);
  const idx: Record<string, number> = {};
  for (const [k, names] of Object.entries(COLS)) idx[k] = head.findIndex((h) => names.includes(h));
  const missing = ["name", "source", "collectedAt"].filter((k) => idx[k] < 0);
  if (missing.length) return { rows: [], errors: [{ line: 1, message: `Colonnes obligatoires manquantes : ${missing.join(", ")} (attendu : nom, source, date de collecte ; courriel ou téléphone ; base légale recommandée).` }] };
  if (idx.email < 0 && idx.phone < 0) return { rows: [], errors: [{ line: 1, message: "Une colonne courriel ou téléphone est requise." }] };

  const get = (r: string[], k: string) => (idx[k] >= 0 ? (r[idx[k]] ?? "").trim() : "");
  const rows: ImportRow[] = [];
  table.slice(1).forEach((r, i) => {
    const line = i + 2;
    const name = get(r, "name");
    const source = get(r, "source");
    const email = get(r, "email");
    const phone = get(r, "phone");
    const when = new Date(get(r, "collectedAt"));
    if (!name) return void errors.push({ line, message: "Nom manquant." });
    if (!source) return void errors.push({ line, message: "Provenance (source) manquante." });
    if (Number.isNaN(when.getTime()) || when.getTime() > Date.now() + 86_400_000) return void errors.push({ line, message: "Date de collecte invalide (format AAAA-MM-JJ, pas dans le futur)." });
    if (email && !normalizeEmail(email)) return void errors.push({ line, message: "Adresse courriel invalide." });
    if (!email && !phone) return void errors.push({ line, message: "Courriel ou téléphone requis." });
    const basisRaw = fold(get(r, "legalBasis"));
    const legalBasis = basisRaw ? BASIS_ALIAS[basisRaw] : "unknown";
    if (!legalBasis) return void errors.push({ line, message: `Base légale non reconnue : « ${get(r, "legalBasis")} ».` });
    const at = fold(get(r, "audienceType"));
    rows.push({
      line, name: name.slice(0, 120), company: get(r, "company").slice(0, 160) || undefined, jobTitle: get(r, "jobTitle").slice(0, 120) || undefined,
      email: email ? normalizeEmail(email)! : undefined, phone: phone.slice(0, 40) || undefined, website: get(r, "website").slice(0, 200) || undefined,
      audienceType: at === "b2c" ? "b2c" : "b2b", segment: get(r, "segment").slice(0, 120) || undefined, source: source.slice(0, 160),
      sourceUrl: get(r, "sourceUrl").slice(0, 400) || undefined, collectedAt: when, legalBasis, legalBasisNote: get(r, "legalBasisNote").slice(0, 400) || undefined,
      productSlug: get(r, "productSlug") ? slugify(get(r, "productSlug")) : undefined, notes: get(r, "notes").slice(0, 1000) || undefined,
    });
  });
  return { rows, errors };
}
