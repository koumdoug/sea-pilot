import type { PlanId } from "./constants";
import { frDays } from "./access-banner";
import { LIVE_SUBSCRIPTION_STATES, PLANS, comparePlans, type Entitlement } from "./plans";

// Présentation de la facturation : état réel de l'abonnement et actions réellement disponibles pour chaque forfait. Fonctions pures :
// aucune règle d'accès ni de paiement ici (elles restent dans plans.ts et billing.ts) ; un bouton n'est proposé que s'il réalise une action.

type State = Entitlement["state"];

export const STATE_LABEL: Record<State, string> = {
  exempt: "Accès propriétaire gratuit", trial: "Essai gratuit", paid: "Abonnement actif", past_due: "Paiement en échec", canceling: "Résiliation programmée",
  trial_expired: "Essai expiré", canceled: "Abonnement terminé", incomplete: "Aucun abonnement actif",
};

export type BillingStatus = { label: string; tone: "green" | "orange" | "red" | "blue"; summary: string };

/** Statut réel : essai gratuit (jamais confondu avec un abonnement payé), abonnement actif, paiement en attente, expiré, accès propriétaire gratuit. */
export function billingStatus(e: Entitlement, sub: { trialEndsAt: Date | null; currentPeriodEnd: Date | null; hasStripeCustomer: boolean } | null, fmtDate: (d: Date | null | undefined) => string): BillingStatus {
  const name = e.plan.name;
  const end = (d: Date | null | undefined) => fmtDate(d);
  switch (e.state) {
    case "exempt":
      return { label: STATE_LABEL.exempt, tone: "green", summary: "Accès propriétaire gratuit : toutes les fonctions et les limites du plan Pro s'appliquent, sans abonnement ni paiement. Cet espace n'est jamais facturé et ne dépend d'aucun essai." };
    case "trial":
      return { label: STATE_LABEL.trial, tone: "blue", summary: `Essai gratuit du plan ${name} : aucun paiement n'a été effectué. Il reste ${frDays(e.daysLeft ?? 0)} (jusqu'au ${end(sub?.trialEndsAt)}). Ensuite, l'accès est suspendu tant qu'un abonnement n'est pas confirmé.` };
    case "paid":
      return { label: STATE_LABEL.paid, tone: "green", summary: `Abonnement ${name} actif. Prochain renouvellement : ${end(sub?.currentPeriodEnd)}.` };
    case "canceling":
      return { label: STATE_LABEL.canceling, tone: "orange", summary: `Abonnement ${name} résilié : accès jusqu'au ${end(sub?.currentPeriodEnd)}.` };
    case "past_due":
      return { label: STATE_LABEL.past_due, tone: e.active ? "orange" : "red", summary: e.reason ?? "Paiement en échec." };
    case "trial_expired":
      return { label: STATE_LABEL.trial_expired, tone: "red", summary: "Essai gratuit terminé : l'accès est suspendu. Un abonnement confirmé par le paiement est nécessaire pour le rétablir." };
    case "canceled":
      return { label: STATE_LABEL.canceled, tone: "red", summary: e.reason ?? "Abonnement terminé." };
    default:
      return sub?.hasStripeCustomer
        ? { label: "Paiement en attente", tone: "orange", summary: "Paiement en attente de confirmation par Stripe : aucun droit payant n'est accordé avant cette confirmation." }
        : { label: STATE_LABEL.incomplete, tone: "red", summary: e.reason ?? "Aucun abonnement actif." };
  }
}

/** Gestion de l'abonnement en cours (portail de paiement, résiliation, reprise, fin d'essai), selon l'ÉTAT réel : un identifiant Stripe seul ne suffit pas. */
export type ManageActions = { portal: boolean; cancel: "cancel" | "resume" | null; endTrial: boolean; note: string | null };

export function manageActions(i: { state: State; owner: boolean; hasStripeSubscription: boolean }): ManageActions {
  const none: ManageActions = { portal: false, cancel: null, endTrial: false, note: null };
  if (!i.owner || i.state === "exempt") return none;
  if (i.hasStripeSubscription) {
    if (LIVE_SUBSCRIPTION_STATES.includes(i.state)) return { portal: true, cancel: i.state === "canceling" ? "resume" : "cancel", endTrial: false, note: null };
    // Abonnement Stripe lié mais terminé ou non abouti : aucune action de gestion ne pourrait aboutir.
    if (i.state === "canceled" || i.state === "trial_expired") return { ...none, note: "Cet abonnement est terminé : aucune action de gestion n'est possible. Souscrivez à l'un des forfaits ci-dessous pour reprendre." };
    return none;
  }
  return { ...none, endTrial: i.state === "trial" };
}

export type PlanAction =
  | { kind: "current"; label: string }
  /** Essai du plan pendant l'essai gratuit : aucun paiement, les limites de ce plan s'appliquent jusqu'à la fin de l'essai. */
  | { kind: "try"; label: string }
  /** Ouverture d'une session de paiement Stripe : le forfait ne change qu'à la confirmation de Stripe. */
  | { kind: "checkout"; label: string }
  /** Changement d'un abonnement payant existant : appliqué à la confirmation de Stripe. */
  | { kind: "change"; label: string; confirm?: string }
  | { kind: "unavailable"; label: string }
  | { kind: "note"; label: string };

export type PlanActionInput = {
  planId: PlanId;
  /** Forfait réellement appliqué (celui des limites affichées). */
  currentPlanId: PlanId;
  state: State;
  owner: boolean;
  /** Un abonnement Stripe est lié à l'espace. */
  hasStripeSubscription: boolean;
  /** Le paiement de CE forfait est opérationnel (clé, prix, secret de webhook). */
  checkoutReady: boolean;
};

/** Actions proposées sur la carte d'un forfait, selon l'état réel. Jamais un bouton qui ne ferait rien ; jamais d'achat proposé sans configuration de paiement complète. */
export function planActions(i: PlanActionInput): PlanAction[] {
  const isCurrent = i.planId === i.currentPlanId;
  const name = PLANS[i.planId].name;
  if (i.state === "exempt") return isCurrent ? [{ kind: "current", label: "Plan actuel (accès propriétaire)" }] : [{ kind: "note", label: "Aucune souscription nécessaire : accès propriétaire gratuit." }];
  if (!i.owner) return isCurrent ? [{ kind: "current", label: "Plan actuel" }] : [];

  const out: PlanAction[] = [];
  const unavailable: PlanAction = { kind: "unavailable", label: "Souscription indisponible : le paiement n'est pas configuré sur ce serveur." };
  if (i.hasStripeSubscription && LIVE_SUBSCRIPTION_STATES.includes(i.state)) {
    if (isCurrent) return [{ kind: "current", label: "Plan actuel" }];
    if (!i.checkoutReady) return [{ kind: "unavailable", label: "Changement indisponible : le paiement n'est pas configuré pour ce forfait." }];
    const dir = comparePlans(i.currentPlanId, i.planId);
    return [dir === "upgrade"
      ? { kind: "change", label: `Passer à ${name}` }
      : { kind: "change", label: `Rétrograder vers ${name}`, confirm: `Passer au plan ${name} ? Votre usage doit respecter ses limites.` }];
  }
  if (isCurrent) out.push({ kind: "current", label: i.state === "trial" ? "Plan d'essai actuel" : "Dernier plan" });
  if (i.state === "trial" && !isCurrent) out.push({ kind: "try", label: "Essayer ce plan" });
  out.push(i.checkoutReady ? { kind: "checkout", label: `Souscrire à ${name}` } : unavailable);
  return out;
}
