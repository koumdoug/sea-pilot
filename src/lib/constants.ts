// Valeurs autorisées (pas d'enum Prisma : compatibilité SQLite/PostgreSQL). Toute écriture est validée par zod avec ces listes.

export const ROLES = ["owner", "admin", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const CAMPAIGN_STATUSES = ["draft", "ready", "active", "paused", "completed", "archived"] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export const CAMPAIGN_STATUS_LABEL: Record<CampaignStatus, string> = {
  draft: "Brouillon", ready: "Prête", active: "Active", paused: "En pause", completed: "Terminée", archived: "Archivée",
};
// Transitions autorisées du cycle de vie d'une campagne.
export const CAMPAIGN_TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  draft: ["ready", "archived"],
  ready: ["draft", "active", "archived"],
  active: ["paused", "completed"],
  paused: ["active", "completed", "archived"],
  completed: ["archived"],
  archived: ["draft"],
};

export const CAMPAIGN_OBJECTIVES = ["leads", "sales", "traffic", "awareness"] as const;
export const OBJECTIVE_LABEL: Record<string, string> = { leads: "Générer des leads", sales: "Générer des ventes", traffic: "Générer du trafic", awareness: "Notoriété" };

export const PLATFORMS = ["google_ads", "meta_ads", "tiktok_ads", "linkedin_ads", "email", "seo", "other"] as const;
export type Platform = (typeof PLATFORMS)[number];
export const PLATFORM_LABEL: Record<string, string> = {
  google_ads: "Google Ads", meta_ads: "Facebook / Instagram Ads", tiktok_ads: "TikTok Ads", linkedin_ads: "LinkedIn Ads", email: "E-mail", seo: "SEO / organique", other: "Autre",
};
export const AD_PLATFORMS = ["meta_ads", "google_ads", "tiktok_ads", "linkedin_ads"] as const;

export const LEAD_STATUSES = ["new", "contacted", "qualified", "proposal", "won", "lost", "disqualified"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export const LEAD_STATUS_LABEL: Record<LeadStatus, string> = {
  new: "Nouveau", contacted: "Contacté", qualified: "Qualifié", proposal: "Proposition", won: "Gagné", lost: "Perdu", disqualified: "Disqualifié",
};
// Colonnes du pipeline CRM : Lead → Qualified → Contacted → Proposal → Won/Lost
export const PIPELINE_COLUMNS: LeadStatus[] = ["new", "qualified", "contacted", "proposal", "won", "lost"];
export const TERMINAL_STATUSES: LeadStatus[] = ["won", "lost", "disqualified"];
/** Rang commercial des statuts non terminaux du pipeline : new < contacted < qualified < proposal. */
export const PIPELINE_RANK: Partial<Record<LeadStatus, number>> = { new: 0, contacted: 1, qualified: 2, proposal: 3 };
/**
 * Règle : une relance AUTOMATISÉE ne doit jamais écraser une progression commerciale déjà enregistrée. Renvoie la raison du blocage, ou null si le changement automatique est permis.
 *  - clôture (« lost », « disqualified ») d'un prospect déjà « qualified » ou « proposal » : la clôture « sans réponse » n'est plus vraie → "closure_after_progress" ;
 *  - retour en arrière dans le pipeline (statut cible de rang inférieur au statut réel) → "regression".
 * « contacted » n'est PAS une progression (c'est notre propre prise de contact). Les statuts terminaux ne passent jamais ici (la relance est annulée). « won » n'est jamais bloqué.
 * Justification documentée dans docs/followup-reliability.md §10. Ne s'applique ni au chemin manuel (décision explicite d'un utilisateur) ni à la décision humaine après examen.
 */
export function autoStatusChangeBlockedBy(current: string, target: string): "closure_after_progress" | "regression" | null {
  const rc = PIPELINE_RANK[current as LeadStatus];
  if (rc === undefined) return null;
  if (target === "lost" || target === "disqualified") return rc >= (PIPELINE_RANK.qualified as number) ? "closure_after_progress" : null;
  const rt = PIPELINE_RANK[target as LeadStatus];
  return rt !== undefined && rc > rt ? "regression" : null;
}

export const QUALIFICATION_LEVELS = ["hot", "warm", "cold", "unqualified"] as const;
export type QualificationLevel = (typeof QUALIFICATION_LEVELS)[number];
export const LEVEL_LABEL: Record<string, string> = { hot: "Chaud", warm: "Tiède", cold: "Froid", unqualified: "Non qualifié" };

export const AD_STATUSES = ["draft", "ready", "active", "paused", "archived"] as const;
export const PAGE_STATUSES = ["draft", "published", "archived"] as const;
export const FOLLOWUP_ACTIONS = ["email", "task", "reminder", "status_change"] as const;
export const FOLLOWUP_ACTION_LABEL: Record<string, string> = { email: "E-mail", task: "Tâche", reminder: "Rappel", status_change: "Changement de statut" };

export const PLAN_IDS = ["starter", "growth", "pro"] as const;
export type PlanId = (typeof PLAN_IDS)[number];
export const SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due", "unpaid", "canceled", "expired", "incomplete"] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const INTEGRATION_PROVIDERS = ["google_analytics", "meta_ads", "google_ads", "tiktok_ads", "email"] as const;
export type IntegrationProviderId = (typeof INTEGRATION_PROVIDERS)[number];

export const COMPANY_SIZES = ["1", "2-10", "11-50", "51-200", "200+"] as const;
export const LANGUAGES = [["fr", "Français"], ["en", "English"], ["es", "Español"], ["de", "Deutsch"], ["it", "Italiano"], ["pt", "Português"]] as const;
export const CURRENCIES = ["EUR", "USD", "CAD", "GBP", "CHF"] as const;

export const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"] as const;
export const SESSION_COOKIE = "seapilot_session";
export const WORKSPACE_COOKIE = "seapilot_ws";
