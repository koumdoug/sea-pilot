import type { Entitlement } from "./plans";

// Bandeau d'accès de l'application (essai, résiliation, paiement, suspension). Texte pur et testable : aucune règle d'accès ni de facturation ici,
// seulement la présentation de l'état déjà calculé par `entitlement()` (durée de l'essai, plans et facturation inchangés).

/** « 1 jour », « 14 jours » (singulier pour 0 et 1). */
export const frDays = (n: number): string => `${n} jour${n > 1 ? "s" : ""}`;

/** En dessous de ce nombre de jours restants, le bandeau passe en avertissement. */
export const NEAR_EXPIRY_DAYS = 3;

export type AccessBanner = { tone: "info" | "warn"; lead: string; strong: string; rest: string; cta: { label: string; href: string } };

export function accessBanner(e: Entitlement): AccessBanner | null {
  const billing = "/billing";
  switch (e.state) {
    case "trial": {
      const n = e.daysLeft ?? 0;
      const strong = n <= 0 ? "dernier jour" : n === 1 ? "1 jour restant" : `${n} jours restants`;
      return { tone: n <= NEAR_EXPIRY_DAYS ? "warn" : "info", lead: "Essai gratuit — ", strong, rest: ` · Formule ${e.plan.name}`, cta: { label: "Choisir un plan", href: billing } };
    }
    case "past_due":
      return { tone: "warn", lead: `${e.reason ?? "Paiement en échec."} `, strong: "", rest: "", cta: { label: "Gérer la facturation", href: billing } };
    case "canceling": {
      const n = e.daysLeft ?? 0;
      return { tone: "info", lead: n <= 0 ? "Votre abonnement prend fin " : "Votre abonnement prend fin dans ", strong: n <= 0 ? "aujourd'hui" : frDays(n), rest: ". ", cta: { label: "Le reprendre", href: billing } };
    }
    case "paid":
    case "exempt":
      return null;
    default:
      return e.active ? null : { tone: "warn", lead: `${e.reason ?? "Accès suspendu."} `, strong: "", rest: "", cta: { label: "Voir les plans", href: billing } };
  }
}
