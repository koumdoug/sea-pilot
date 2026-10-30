import type { PlanId, SubscriptionStatus } from "./constants";
import { PLAN_IDS } from "./constants";

// Les montants ne sont PAS figés dans le code : ils sont portés par les prix Stripe (STRIPE_PRICE_*) ;
// PLAN_*_PRICE_LABEL permet d'afficher un libellé de tarif. Seules les capacités (limites) sont définies ici.

export type PlanLimits = {
  members: number;
  activeCampaigns: number;
  landingPages: number;
  leadsPerMonth: number;
  aiGenerationsPerDay: number;
  sequences: number;
  integrations: number;
  apiKeys: number;
};

/** Droits non chiffrés d'un forfait, appliqués côté serveur (l'interface ne fait que les afficher). */
export type PlanRights = {
  /** Accès à l'API publique par clé (`/api/v1/*`) : création ET utilisation des clés. */
  api: boolean;
};

export type Plan = { id: PlanId; name: string; tagline: string; limits: PlanLimits; rights: PlanRights; features: string[] };

export const UNLIMITED = -1;

/** Libellés français des limites (écran de facturation et messages de rétrogradation : jamais de clé technique). */
export const LIMIT_LABEL: Record<keyof PlanLimits, string> = {
  members: "Utilisateurs", activeCampaigns: "Campagnes actives", landingPages: "Landing pages", leadsPerMonth: "Leads ce mois-ci (seuil indicatif)",
  aiGenerationsPerDay: "Générations IA / jour", sequences: "Séquences de relance", integrations: "Intégrations", apiKeys: "Clés API",
};

/** Limites seulement informatives : affichées avec l'usage, mais jamais bloquantes (ni à la création, ni pour un changement de forfait). */
export const INFORMATIVE_LIMITS: readonly (keyof PlanLimits)[] = ["leadsPerMonth"];

const fr = (n: number) => new Intl.NumberFormat("fr-FR").format(n).replace(/ | /g, " ");

/** Libellé d'une limite : « 15 », « ∞ » (affichage de l'usage et du tableau comparatif). */
export const limitText = (n: number): string => (n === UNLIMITED ? "∞" : fr(n));

/**
 * Liste des avantages d'un forfait, DÉRIVÉE de ses limites : les chiffres affichés ne peuvent donc pas diverger de ceux qui sont appliqués.
 * `capabilities` : droits non chiffrés propres au forfait. Aucune promesse de service que le logiciel ne fournit pas.
 */
export function describePlan(limits: PlanLimits, capabilities: string[]): string[] {
  const out: string[] = [];
  out.push(`${fr(limits.members)} utilisateur${limits.members > 1 ? "s" : ""}`);
  if (limits.activeCampaigns === UNLIMITED && limits.landingPages === UNLIMITED) out.push("Campagnes et landing pages illimitées");
  else {
    out.push(limits.activeCampaigns === UNLIMITED ? "Campagnes illimitées" : `${fr(limits.activeCampaigns)} campagne${limits.activeCampaigns > 1 ? "s" : ""} active${limits.activeCampaigns > 1 ? "s" : ""}`);
    out.push(limits.landingPages === UNLIMITED ? "Landing pages illimitées" : `${fr(limits.landingPages)} landing page${limits.landingPages > 1 ? "s" : ""}`);
  }
  out.push(limits.leadsPerMonth === UNLIMITED ? "Leads illimités" : `${fr(limits.leadsPerMonth)} leads / mois (seuil indicatif)`);
  if (limits.sequences === UNLIMITED) out.push("Séquences illimitées");
  else if (limits.sequences > 0) out.push(`${fr(limits.sequences)} séquence${limits.sequences > 1 ? "s" : ""}`);
  // Une limite numérique est annoncée comme telle (jamais « toutes les intégrations » quand un nombre existe). Illimité : aucune ligne (le tableau comparatif affiche ∞).
  if (limits.integrations !== UNLIMITED && limits.integrations > 0) out.push(`${fr(limits.integrations)} intégration${limits.integrations > 1 ? "s" : ""}`);
  return [...out, ...capabilities];
}

/** SOURCE UNIQUE des forfaits : limites et droits. Aucune page ne répète ces valeurs ; les libellés affichés en sont dérivés (describePlan). */
const PLAN_SPECS: Record<PlanId, { name: string; tagline: string; limits: PlanLimits; rights: PlanRights; capabilities: string[] }> = {
  starter: {
    name: "Starter",
    tagline: "Pour la petite entreprise qui démarre son acquisition.",
    limits: { members: 1, activeCampaigns: 3, landingPages: 3, leadsPerMonth: 300, aiGenerationsPerDay: 30, sequences: 1, integrations: 2, apiKeys: 0 },
    rights: { api: false },
    capabilities: ["Qualification des leads", "Analytics et recommandations"],
  },
  growth: {
    name: "Growth",
    tagline: "Pour les équipes qui veulent automatiser leurs relances et suivre leurs campagnes.",
    limits: { members: 5, activeCampaigns: 15, landingPages: 15, leadsPerMonth: 2000, aiGenerationsPerDay: 150, sequences: 10, integrations: 5, apiKeys: 0 },
    rights: { api: false },
    capabilities: ["Séquences de relance"],
  },
  pro: {
    name: "Pro",
    tagline: "Pour les agences et les équipes.",
    limits: { members: 25, activeCampaigns: UNLIMITED, landingPages: UNLIMITED, leadsPerMonth: UNLIMITED, aiGenerationsPerDay: 600, sequences: UNLIMITED, integrations: UNLIMITED, apiKeys: 20 },
    rights: { api: true },
    capabilities: [],
  },
};

export const PLANS: Record<PlanId, Plan> = Object.fromEntries(
  (Object.keys(PLAN_SPECS) as PlanId[]).map((id) => {
    const s = PLAN_SPECS[id];
    // « Accès API » est DÉRIVÉ du droit appliqué par le serveur : la promesse ne peut pas diverger de la règle.
    return [id, { id, name: s.name, tagline: s.tagline, limits: s.limits, rights: s.rights, features: describePlan(s.limits, [...s.capabilities, ...(s.rights.api ? ["Accès API"] : [])]) }];
  }),
) as Record<PlanId, Plan>;

/** L'API publique par clé est-elle comprise dans ce forfait ? (règle unique : création des clés, appels `/api/v1/*`) */
export const planAllowsApi = (plan: Plan): boolean => plan.rights.api;

export const planOrNull = (id: string | null | undefined): Plan | null => (id && (PLAN_IDS as readonly string[]).includes(id) ? PLANS[id as PlanId] : null);

export type SubscriptionLike = {
  plan: string;
  status: string;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd?: boolean;
};

export type Entitlement = {
  /** L'espace de travail peut utiliser le produit. */
  active: boolean;
  state: "exempt" | "trial" | "paid" | "past_due" | "canceling" | "trial_expired" | "canceled" | "incomplete";
  plan: Plan;
  daysLeft: number | null;
  reason?: string;
};

const DAY = 86_400_000;
/** Délai accordé après la fin d'une période payée pour recevoir la confirmation du renouvellement (jamais appliqué à une résiliation programmée). */
export const RENEWAL_GRACE_MS = 3 * DAY;

/**
 * Règle d'accès selon l'abonnement :
 *  - trialing : accès jusqu'à trialEndsAt (ensuite « essai expiré », accès bloqué hors Billing)
 *  - active : accès ; si cancelAtPeriodEnd, accès jusqu'à currentPeriodEnd exactement ; sinon accès tant que la période payée n'est pas échue depuis plus de RENEWAL_GRACE_MS
 *    (délai de confirmation du renouvellement : au-delà, seule une réconciliation avec Stripe peut rétablir l'accès — jamais d'accès illimité sur un statut local ancien)
 *  - past_due : accès conservé (délai de grâce de 7 jours après la fin de période)
 *  - unpaid : accès SUSPENDU immédiatement (tous les essais de prélèvement ont échoué, ou abonnement en pause faute de moyen de paiement) ; l'abonnement reste géré
 *    (portail de paiement, résiliation) pour que le client puisse régulariser ; il reprend à la confirmation du paiement par Stripe
 *  - canceled / expired / incomplete : accès bloqué
 */
export function entitlement(sub: SubscriptionLike | null, now = new Date()): Entitlement {
  const fallback = PLANS.starter;
  if (!sub) return { active: false, state: "incomplete", plan: fallback, daysLeft: null, reason: "Aucun abonnement." };
  const plan = planOrNull(sub.plan) ?? fallback;
  const status = sub.status as SubscriptionStatus;
  const left = (d: Date | null) => (d ? Math.max(0, Math.ceil((d.getTime() - now.getTime()) / DAY)) : null);

  if (status === "trialing") {
    if (sub.trialEndsAt && sub.trialEndsAt.getTime() > now.getTime()) return { active: true, state: "trial", plan, daysLeft: left(sub.trialEndsAt) };
    return { active: false, state: "trial_expired", plan, daysLeft: 0, reason: "Votre essai gratuit est terminé. Choisissez un plan pour continuer." };
  }
  if (status === "active") {
    if (sub.cancelAtPeriodEnd) {
      const ok = !sub.currentPeriodEnd || sub.currentPeriodEnd.getTime() > now.getTime();
      return ok ? { active: true, state: "canceling", plan, daysLeft: left(sub.currentPeriodEnd) } : { active: false, state: "canceled", plan, daysLeft: 0, reason: "Abonnement résilié." };
    }
    // Période payée échue sans aucune confirmation de renouvellement ni de résiliation (événements Stripe perdus) : un statut local ancien
    // n'ouvre pas un accès illimité. La période payée est respectée jusqu'à son terme, plus un délai pour le renouvellement ; passé ce délai,
    // seule une synchronisation avec Stripe (réconciliation) peut rétablir l'accès.
    if (sub.currentPeriodEnd && sub.currentPeriodEnd.getTime() + RENEWAL_GRACE_MS <= now.getTime()) return { active: false, state: "canceled", plan, daysLeft: 0, reason: "La période payée est échue et le renouvellement n'a pas été confirmé par Stripe. Si vous avez payé, l'accès sera rétabli dès la synchronisation ; sinon, souscrivez à un forfait." };
    return { active: true, state: "paid", plan, daysLeft: left(sub.currentPeriodEnd) };
  }
  if (status === "past_due") {
    const grace = sub.currentPeriodEnd ? sub.currentPeriodEnd.getTime() + 7 * DAY : now.getTime() + DAY;
    return grace > now.getTime() ? { active: true, state: "past_due", plan, daysLeft: null, reason: "Paiement en échec : mettez à jour votre moyen de paiement." } : { active: false, state: "past_due", plan, daysLeft: 0, reason: "Paiement en échec : accès suspendu." };
  }
  if (status === "unpaid") return { active: false, state: "past_due", plan, daysLeft: 0, reason: "Paiement impayé : tous les essais de prélèvement ont échoué et l'accès est suspendu. Régularisez votre moyen de paiement (Moyen de paiement et factures) ou résiliez." };
  if (status === "canceled" || status === "expired") return { active: false, state: "canceled", plan, daysLeft: 0, reason: "Abonnement terminé. Réactivez un plan pour continuer." };
  return { active: false, state: "incomplete", plan, daysLeft: null, reason: "Abonnement incomplet." };
}

/**
 * États dans lesquels un abonnement Stripe existe encore chez Stripe : résiliation, reprise, portail de paiement et changement de forfait y sont possibles.
 * Un identifiant Stripe enregistré ne prouve JAMAIS qu'un abonnement est actif : « terminé », « paiement incomplet » ou « essai expiré » ne le sont pas.
 */
export const LIVE_SUBSCRIPTION_STATES: readonly Entitlement["state"][] = ["paid", "canceling", "past_due"];

/** Règle unique (interface ET serveur) : un abonnement Stripe est lié et son état réel est vivant. */
export function isLiveSubscription(sub: (SubscriptionLike & { stripeSubscriptionId?: string | null }) | null, now = new Date()): boolean {
  return !!sub?.stripeSubscriptionId && LIVE_SUBSCRIPTION_STATES.includes(entitlement(sub, now).state);
}

/** Accès gratuit du propriétaire de la plateforme (liste d'exceptions serveur) : toutes les fonctions, limites du plan le plus élevé. Aucun paiement requis. */
export function exemptEntitlement(): Entitlement {
  return { active: true, state: "exempt", plan: PLANS.pro, daysLeft: null };
}

export function limitOf(plan: Plan, key: keyof PlanLimits): number {
  return plan.limits[key];
}

/** true si `used` atteint déjà la limite (la création d'un élément supplémentaire est refusée). */
export function limitReached(plan: Plan, key: keyof PlanLimits, used: number): boolean {
  const l = plan.limits[key];
  return l !== UNLIMITED && used >= l;
}

export type PlanChange = "upgrade" | "downgrade" | "same";
export function comparePlans(from: string, to: string): PlanChange {
  const a = PLAN_IDS.indexOf(from as PlanId), b = PLAN_IDS.indexOf(to as PlanId);
  return a === b ? "same" : b > a ? "upgrade" : "downgrade";
}

/** Un changement vers un plan inférieur est refusé si l'usage actuel dépasse une limite ferme du plan cible (les limites informatives ne comptent pas). */
export function downgradeBlockers(target: Plan, usage: Partial<Record<keyof PlanLimits, number>>): string[] {
  const out: string[] = [];
  for (const k of Object.keys(target.limits) as (keyof PlanLimits)[]) {
    if (INFORMATIVE_LIMITS.includes(k)) continue;
    const lim = target.limits[k];
    const u = usage[k];
    if (lim !== UNLIMITED && u !== undefined && u > lim) out.push(`${LIMIT_LABEL[k]} : ${u} utilisé(s) pour une limite de ${lim}`);
  }
  return out;
}
