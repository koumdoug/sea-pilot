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

export type Plan = { id: PlanId; name: string; tagline: string; limits: PlanLimits; features: string[] };

export const UNLIMITED = -1;

export const PLANS: Record<PlanId, Plan> = {
  starter: {
    id: "starter",
    name: "Starter",
    tagline: "Pour la petite entreprise qui démarre son acquisition.",
    limits: { members: 1, activeCampaigns: 3, landingPages: 3, leadsPerMonth: 300, aiGenerationsPerDay: 30, sequences: 1, integrations: 2, apiKeys: 1 },
    features: ["1 utilisateur", "3 campagnes actives", "3 landing pages", "300 leads / mois", "Qualification des leads", "Analytics et recommandations"],
  },
  growth: {
    id: "growth",
    name: "Growth",
    tagline: "Pour les entreprises qui veulent automatiser leur acquisition.",
    limits: { members: 5, activeCampaigns: 15, landingPages: 15, leadsPerMonth: 2000, aiGenerationsPerDay: 150, sequences: 10, integrations: 5, apiKeys: 5 },
    features: ["5 utilisateurs", "15 campagnes actives", "15 landing pages", "2 000 leads / mois", "Séquences de relance", "Toutes les intégrations"],
  },
  pro: {
    id: "pro",
    name: "Pro",
    tagline: "Pour les agences et les équipes.",
    limits: { members: 25, activeCampaigns: UNLIMITED, landingPages: UNLIMITED, leadsPerMonth: UNLIMITED, aiGenerationsPerDay: 600, sequences: UNLIMITED, integrations: UNLIMITED, apiKeys: 20 },
    features: ["25 utilisateurs", "Campagnes et landing pages illimitées", "Leads illimités", "Séquences illimitées", "Accès API", "Support prioritaire"],
  },
};

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

/**
 * Règle d'accès selon l'abonnement :
 *  - trialing : accès jusqu'à trialEndsAt (ensuite « essai expiré », accès bloqué hors Billing)
 *  - active : accès ; si cancelAtPeriodEnd, accès jusqu'à currentPeriodEnd
 *  - past_due : accès conservé (délai de grâce de 7 jours après la fin de période)
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
    return { active: true, state: "paid", plan, daysLeft: left(sub.currentPeriodEnd) };
  }
  if (status === "past_due") {
    const grace = sub.currentPeriodEnd ? sub.currentPeriodEnd.getTime() + 7 * DAY : now.getTime() + DAY;
    return grace > now.getTime() ? { active: true, state: "past_due", plan, daysLeft: null, reason: "Paiement en échec : mettez à jour votre moyen de paiement." } : { active: false, state: "past_due", plan, daysLeft: 0, reason: "Paiement en échec : accès suspendu." };
  }
  if (status === "canceled" || status === "expired") return { active: false, state: "canceled", plan, daysLeft: 0, reason: "Abonnement terminé. Réactivez un plan pour continuer." };
  return { active: false, state: "incomplete", plan, daysLeft: null, reason: "Abonnement incomplet." };
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

/** Un changement vers un plan inférieur est refusé si l'usage actuel dépasse les limites du plan cible. */
export function downgradeBlockers(target: Plan, usage: Partial<Record<keyof PlanLimits, number>>): string[] {
  const out: string[] = [];
  for (const k of Object.keys(target.limits) as (keyof PlanLimits)[]) {
    const lim = target.limits[k];
    const u = usage[k];
    if (lim !== UNLIMITED && u !== undefined && u > lim) out.push(`${k} : ${u} utilisé(s) pour une limite de ${lim}`);
  }
  return out;
}
