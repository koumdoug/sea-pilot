// Moteur de qualification des leads — déterministe, sans appel externe.
// Chaque critère distingue la BASE du jugement :
//   fact       = valeur fournie telle quelle par le prospect (champ de formulaire, coordonnées)
//   inference  = interprétation (mots-clés, déduction) — jamais présentée comme un fait
//   missing    = information absente (listée dans « informations manquantes »)

export type CriterionKey = "need" | "budget" | "urgency" | "fit" | "location" | "size" | "intent";

export type Criterion = { key: CriterionKey; label: string; weight: number; enabled: boolean };

export const DEFAULT_CRITERIA: Criterion[] = [
  { key: "need", label: "Besoin exprimé", weight: 20, enabled: true },
  { key: "budget", label: "Budget", weight: 20, enabled: true },
  { key: "urgency", label: "Urgence", weight: 15, enabled: true },
  { key: "fit", label: "Adéquation avec l'offre", weight: 15, enabled: true },
  { key: "location", label: "Localisation", weight: 10, enabled: true },
  { key: "size", label: "Taille de l'entreprise", weight: 5, enabled: true },
  { key: "intent", label: "Intention d'achat", weight: 15, enabled: true },
];

export type LeadInput = {
  name: string;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  message?: string | null;
  customFields?: Record<string, unknown> | null;
  source?: string | null;
  medium?: string | null;
};

export type OfferContext = {
  name?: string | null;
  price?: number | null;
  geoZone?: string | null;
  advantages?: string[];
  keywords?: string[];
  audienceType?: string | null; // b2b | b2c
  country?: string | null;
};

export type Basis = "fact" | "inference" | "missing";
export type CriterionResult = { key: CriterionKey; label: string; weight: number; value: number | null; basis: Basis; evidence: string };

export type Qualification = {
  score: number;
  level: "hot" | "warm" | "cold" | "unqualified";
  criteria: CriterionResult[];
  facts: string[];
  inferences: string[];
  reasons: string[];
  missingInfo: string[];
  nextAction: string;
};

export type Thresholds = { hot: number; warm: number };
export const DEFAULT_THRESHOLDS: Thresholds = { hot: 70, warm: 40 };

const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const has = (text: string, words: string[]) => words.find((w) => text.includes(norm(w)));

const NEED_WORDS = ["besoin", "cherche", "recherche", "projet", "problème", "probleme", "souhaite", "voudrais", "aimerais", "need", "looking for", "want", "require", "help with", "solution"];
const INTENT_WORDS = ["devis", "tarif", "prix", "rendez-vous", "rdv", "démo", "demo", "acheter", "commander", "réserver", "reserver", "contrat", "souscrire", "quote", "pricing", "book", "buy", "appointment", "call me", "rappel"];
const URGENT_WORDS = ["urgent", "urgence", "asap", "rapidement", "au plus vite", "dès que possible", "des que possible", "cette semaine", "demain", "immédiat", "immediat", "immediately", "this week", "right away"];
const NOT_URGENT_WORDS = ["pas pressé", "pas presse", "plus tard", "dans quelques mois", "juste curiosité", "juste curiosite", "just curious", "no rush", "just browsing", "pour information", "just looking"];
const BUDGET_WORDS = ["budget", "€", "eur", "$", "usd", "cad", "k€", "dollars", "euros"];
const LOW_BUDGET_WORDS = ["gratuit", "pas de budget", "no budget", "free", "le moins cher"];

function field(cf: Record<string, unknown> | null | undefined, ...keys: string[]): string | null {
  if (!cf) return null;
  for (const k of Object.keys(cf)) {
    if (keys.some((x) => norm(k).includes(x))) {
      const v = cf[k];
      if (v !== null && v !== undefined && String(v).trim()) return String(v).trim();
    }
  }
  return null;
}

function parseAmount(s: string): number | null {
  const m = s.replace(/\s/g, "").match(/(\d+(?:[.,]\d+)?)(k)?/i);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  return Number.isFinite(n) ? n * (m[2] ? 1000 : 1) : null;
}

function overlap(a: string[], b: string[]): string[] {
  const set = new Set(b.map(norm));
  return a.map(norm).filter((w) => w.length > 3 && set.has(w));
}

function tokens(s: string): string[] {
  return norm(s).split(/[^a-z0-9]+/).filter((w) => w.length > 3);
}

/** Évalue un critère. Retourne value ∈ [0,1] (ou null si l'information est absente). */
function evaluate(key: CriterionKey, lead: LeadInput, ctx: OfferContext): Pick<CriterionResult, "value" | "basis" | "evidence"> {
  const msg = norm(lead.message ?? "");
  const cf = lead.customFields ?? null;
  const missing = (evidence: string) => ({ value: null, basis: "missing" as const, evidence });

  switch (key) {
    case "need": {
      const declared = field(cf, "besoin", "need", "projet", "project", "probleme", "problem");
      if (declared) return { value: declared.length >= 15 ? 1 : 0.7, basis: "fact", evidence: `Besoin déclaré : « ${declared.slice(0, 120)} »` };
      if (!msg) return missing("Aucun message ni besoin renseigné.");
      const w = has(msg, NEED_WORDS);
      if (msg.length >= 80 || w) return { value: msg.length >= 80 && w ? 0.9 : 0.65, basis: "inference", evidence: w ? `Le message évoque un besoin (« ${w} »).` : "Message détaillé, besoin implicite." };
      return { value: 0.3, basis: "inference", evidence: "Message très court, besoin peu explicite." };
    }
    case "budget": {
      const declared = field(cf, "budget");
      const text = declared ?? (has(msg, BUDGET_WORDS) ? lead.message ?? "" : "");
      if (has(msg, LOW_BUDGET_WORDS)) return { value: 0.1, basis: "inference", evidence: "Le prospect évoque un budget très limité ou la gratuité." };
      if (!text) return missing("Budget non communiqué.");
      const amount = parseAmount(declared ?? text);
      const basis: Basis = declared ? "fact" : "inference";
      if (amount !== null && ctx.price && ctx.price > 0) {
        const ratio = amount / ctx.price;
        return { value: ratio >= 1 ? 1 : ratio >= 0.6 ? 0.6 : 0.25, basis, evidence: `Budget ${declared ? "déclaré" : "mentionné"} : ${amount} (prix de l'offre : ${ctx.price}).` };
      }
      return { value: 0.6, basis, evidence: declared ? `Budget déclaré : « ${declared} » (aucun prix d'offre pour comparer).` : "Un budget est évoqué dans le message." };
    }
    case "urgency": {
      const declared = field(cf, "urgence", "urgency", "delai", "timeline", "quand", "when");
      const text = norm(declared ?? "") + " " + msg;
      if (has(text, NOT_URGENT_WORDS)) return { value: 0.2, basis: declared ? "fact" : "inference", evidence: "Le prospect indique ne pas être pressé." };
      const w = has(text, URGENT_WORDS);
      if (w) return { value: 1, basis: declared ? "fact" : "inference", evidence: `Urgence exprimée (« ${w} »).` };
      if (declared) return { value: 0.5, basis: "fact", evidence: `Délai déclaré : « ${declared} ».` };
      return missing("Échéance non précisée.");
    }
    case "fit": {
      const lt = tokens(`${lead.message ?? ""} ${lead.company ?? ""} ${field(cf, "besoin", "need", "service", "produit", "product") ?? ""}`);
      const kw = [...(ctx.keywords ?? []), ...(ctx.advantages ?? []).flatMap(tokens), ...tokens(ctx.name ?? "")];
      if (!kw.length) return missing("Aucune offre configurée pour mesurer l'adéquation.");
      if (!lt.length) return missing("Pas assez de contenu pour juger l'adéquation.");
      const common = [...new Set(overlap(lt, kw))];
      if (common.length >= 2) return { value: 1, basis: "inference", evidence: `Termes communs avec l'offre : ${common.slice(0, 4).join(", ")}.` };
      if (common.length === 1) return { value: 0.65, basis: "inference", evidence: `Un terme commun avec l'offre : ${common[0]}.` };
      return { value: 0.3, basis: "inference", evidence: "Aucun terme commun avec l'offre." };
    }
    case "location": {
      const loc = field(cf, "ville", "city", "pays", "country", "localisation", "location", "code postal", "postal", "zip", "region");
      if (!loc) return missing("Localisation non communiquée.");
      const zone = norm(ctx.geoZone ?? ctx.country ?? "");
      if (!zone) return { value: 0.6, basis: "fact", evidence: `Localisation déclarée : « ${loc} » (zone de service non définie).` };
      const inZone = norm(loc).split(/[^a-z0-9]+/).some((t) => t.length > 2 && zone.includes(t)) || zone.includes(norm(loc));
      return inZone ? { value: 1, basis: "fact", evidence: `« ${loc} » est dans la zone de service (${ctx.geoZone ?? ctx.country}).` } : { value: 0.2, basis: "fact", evidence: `« ${loc} » semble hors de la zone de service (${ctx.geoZone ?? ctx.country}).` };
    }
    case "size": {
      const size = field(cf, "taille", "size", "employes", "employees", "effectif", "salaries");
      if (size) {
        const n = parseAmount(size);
        return { value: n === null ? 0.5 : n >= 10 ? 1 : n >= 2 ? 0.7 : 0.4, basis: "fact", evidence: `Taille déclarée : « ${size} ».` };
      }
      if (ctx.audienceType === "b2c") return { value: 0.5, basis: "inference", evidence: "Cible B2C : la taille d'entreprise n'est pas déterminante." };
      if (lead.company) return { value: 0.5, basis: "inference", evidence: "Entreprise renseignée, taille inconnue." };
      return missing("Entreprise et taille non renseignées.");
    }
    case "intent": {
      let v = 0.2;
      const ev: string[] = [];
      let basis: Basis = "inference";
      const w = has(msg, INTENT_WORDS);
      if (w) { v += 0.4; ev.push(`demande explicite (« ${w} »)`); }
      if (lead.phone) { v += 0.25; ev.push("téléphone fourni"); basis = "fact"; }
      if (lead.email && lead.company) { v += 0.1; ev.push("coordonnées professionnelles"); }
      if (lead.medium && /cpc|paid|ppc|ads/i.test(lead.medium)) { v += 0.05; ev.push("issu d'une publicité"); }
      return { value: Math.min(1, v), basis: ev.length ? basis : "inference", evidence: ev.length ? `Signaux d'intention : ${ev.join(", ")}.` : "Aucun signal d'intention explicite." };
    }
  }
}

const MISSING_LABEL: Record<CriterionKey, string> = {
  need: "le besoin précis", budget: "le budget", urgency: "l'échéance / l'urgence", fit: "des détails sur le service recherché", location: "la localisation", size: "la taille de l'entreprise", intent: "l'intention d'achat",
};

export function nextAction(level: Qualification["level"], missing: CriterionKey[], lead: LeadInput): string {
  const contact = lead.phone ? "téléphone" : lead.email ? "e-mail" : null;
  if (!contact) return "Aucun moyen de contact : compléter la fiche avant toute action.";
  const ask = missing.slice(0, 3).map((k) => MISSING_LABEL[k]);
  switch (level) {
    case "hot": return `Contacter ce prospect rapidement (${contact}) et proposer un rendez-vous${ask.length ? ` ; en profiter pour confirmer ${ask.join(", ")}` : ""}.`;
    case "warm": return `Envoyer un message personnalisé (${contact}) pour obtenir ${ask.length ? ask.join(", ") : "une confirmation du besoin"}, puis relancer sous 3 jours.`;
    case "cold": return "Inscrire dans une séquence de relance douce et réévaluer à la prochaine interaction.";
    default: return "Ne pas investir de temps commercial : vérifier la pertinence avant tout contact.";
  }
}

/** Qualification complète d'un lead à partir de critères configurables. */
export function qualifyLead(lead: LeadInput, ctx: OfferContext = {}, criteria: Criterion[] = DEFAULT_CRITERIA, th: Thresholds = DEFAULT_THRESHOLDS): Qualification {
  const active = criteria.filter((c) => c.enabled && c.weight > 0);
  const results: CriterionResult[] = active.map((c) => ({ key: c.key, label: c.label, weight: c.weight, ...evaluate(c.key, lead, ctx) }));
  const total = results.reduce((s, r) => s + r.weight, 0) || 1;
  const raw = results.reduce((s, r) => s + r.weight * (r.value ?? 0), 0) / total;
  let score = Math.round(raw * 100);

  const noContact = !lead.email && !lead.phone;
  let level: Qualification["level"] = score >= th.hot ? "hot" : score >= th.warm ? "warm" : "cold";
  if (noContact) { level = "unqualified"; score = Math.min(score, th.warm - 1); }

  const facts: string[] = [`Nom : ${lead.name}`];
  if (lead.company) facts.push(`Entreprise : ${lead.company}`);
  if (lead.email) facts.push(`E-mail fourni : ${lead.email}`);
  if (lead.phone) facts.push(`Téléphone fourni : ${lead.phone}`);
  if (lead.message) facts.push(`Message : « ${lead.message.slice(0, 200)}${lead.message.length > 200 ? "…" : ""} »`);
  for (const [k, v] of Object.entries(lead.customFields ?? {})) if (v !== null && v !== undefined && String(v).trim()) facts.push(`${k} : ${String(v).slice(0, 120)}`);

  const inferences = results.filter((r) => r.basis === "inference").map((r) => `${r.label} — ${r.evidence} (inférence)`);
  const reasons = results.filter((r) => r.value !== null).sort((a, b) => b.weight * (b.value ?? 0) - a.weight * (a.value ?? 0)).slice(0, 4).map((r) => `${r.label} : ${r.evidence}`);
  const missingKeys = results.filter((r) => r.basis === "missing").map((r) => r.key);
  const missingInfo = missingKeys.map((k) => `Information manquante : ${MISSING_LABEL[k]}`);
  if (noContact) missingInfo.unshift("Aucun e-mail ni téléphone");

  return { score, level, criteria: results, facts, inferences, reasons, missingInfo, nextAction: nextAction(level, missingKeys, lead) };
}

export function normalizeCriteria(raw: unknown): Criterion[] {
  if (!Array.isArray(raw)) return DEFAULT_CRITERIA;
  const byKey = new Map(raw.filter((c) => c && typeof c === "object").map((c) => [(c as Criterion).key, c as Criterion]));
  return DEFAULT_CRITERIA.map((d) => {
    const c = byKey.get(d.key);
    return c ? { key: d.key, label: d.label, weight: Math.max(0, Math.min(100, Number(c.weight) || 0)), enabled: !!c.enabled } : d;
  });
}
