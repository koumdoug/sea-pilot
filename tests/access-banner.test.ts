// Bandeau d'accès : formulation naturelle, singulier/pluriel, essai proche de son terme, essai expiré, abonnement actif, accès propriétaire gratuit.
// La durée de l'essai et les règles d'accès (entitlement) ne sont pas modifiées : on vérifie seulement leur présentation.
import { describe, expect, it } from "vitest";
import { entitlement, exemptEntitlement } from "@/lib/plans";
import { accessBanner, frDays, NEAR_EXPIRY_DAYS } from "@/lib/access-banner";

const NOW = new Date("2026-10-29T12:00:00Z");
const DAY = 86_400_000;
const sub = (o: object) => ({ plan: "starter", status: "trialing", trialEndsAt: null, currentPeriodEnd: null, ...o }) as never;
const full = (b: ReturnType<typeof accessBanner>) => (b ? `${b.lead}${b.strong}${b.rest}` : null);

describe("frDays : singulier et pluriel", () => {
  it("0 et 1 → singulier, 2 et plus → pluriel", () => {
    expect(frDays(0)).toBe("0 jour"); expect(frDays(1)).toBe("1 jour"); expect(frDays(2)).toBe("2 jours"); expect(frDays(14)).toBe("14 jours");
  });
});

describe("bandeau d'essai gratuit", () => {
  it("14 jours restants : formulation exacte, ton informatif", () => {
    const e = entitlement(sub({ trialEndsAt: new Date(NOW.getTime() + 14 * DAY) }), NOW);
    const b = accessBanner(e)!;
    expect(e.state).toBe("trial"); expect(e.daysLeft).toBe(14);
    expect(full(b)).toBe("Essai gratuit — 14 jours restants · Formule Starter");
    expect(b.tone).toBe("info");
    expect(b.cta).toEqual({ label: "Choisir un plan", href: "/billing" });
  });
  it("un seul jour restant : singulier ; moins de 24 h compte comme 1 jour ; avertissement dès le seuil de proximité", () => {
    for (const ms of [1 * DAY, 12 * 3_600_000, 60_000]) {
      const b = accessBanner(entitlement(sub({ trialEndsAt: new Date(NOW.getTime() + ms) }), NOW))!;
      expect(full(b), String(ms)).toBe("Essai gratuit — 1 jour restant · Formule Starter");
      expect(b.tone).toBe("warn");
    }
  });
  it("essai proche de son terme : avertissement jusqu'à NEAR_EXPIRY_DAYS inclus, informatif au-delà", () => {
    expect(accessBanner(entitlement(sub({ trialEndsAt: new Date(NOW.getTime() + NEAR_EXPIRY_DAYS * DAY) }), NOW))!.tone).toBe("warn");
    expect(accessBanner(entitlement(sub({ trialEndsAt: new Date(NOW.getTime() + (NEAR_EXPIRY_DAYS + 1) * DAY) }), NOW))!.tone).toBe("info");
    expect(full(accessBanner(entitlement(sub({ trialEndsAt: new Date(NOW.getTime() + 2 * DAY) }), NOW))!)).toBe("Essai gratuit — 2 jours restants · Formule Starter");
  });
  it("le nom de la formule suit le plan réel", () => {
    expect(full(accessBanner(entitlement(sub({ plan: "growth", trialEndsAt: new Date(NOW.getTime() + 10 * DAY) }), NOW))!)).toMatch(/Formule Growth$/);
  });
  it("durée de l'essai inchangée : entitlement() garde ses règles (essai actif jusqu'à la date de fin, expiré ensuite)", () => {
    expect(entitlement(sub({ trialEndsAt: new Date(NOW.getTime() + 1) }), NOW)).toMatchObject({ active: true, state: "trial" });
    expect(entitlement(sub({ trialEndsAt: new Date(NOW.getTime()) }), NOW)).toMatchObject({ active: false, state: "trial_expired", daysLeft: 0 });
  });
});

describe("autres états", () => {
  it("essai expiré : avertissement avec la raison et lien vers les plans, sans « jours restants »", () => {
    const e = entitlement(sub({ trialEndsAt: new Date(NOW.getTime() - DAY) }), NOW);
    const b = accessBanner(e)!;
    expect(e.state).toBe("trial_expired");
    expect(b.tone).toBe("warn");
    expect(full(b)).toMatch(/Votre essai gratuit est terminé/);
    expect(full(b)).not.toMatch(/restant/);
    expect(b.cta.label).toBe("Voir les plans");
  });
  it("abonnement actif : aucun bandeau", () => {
    expect(accessBanner(entitlement(sub({ status: "active", currentPeriodEnd: new Date(NOW.getTime() + 20 * DAY) }), NOW))).toBeNull();
  });
  it("accès propriétaire gratuit : aucun bandeau", () => {
    expect(accessBanner(exemptEntitlement())).toBeNull();
  });
  it("résiliation programmée : singulier / pluriel / jour même", () => {
    const at = (days: number) => accessBanner(entitlement(sub({ status: "active", cancelAtPeriodEnd: true, currentPeriodEnd: new Date(NOW.getTime() + days * DAY) }), NOW))!;
    expect(full(at(5))).toBe("Votre abonnement prend fin dans 5 jours. ");
    expect(full(at(1))).toBe("Votre abonnement prend fin dans 1 jour. ");
    expect(full(at(0.2))).toBe("Votre abonnement prend fin dans 1 jour. "); // moins de 24 h : arrondi au jour supérieur par entitlement()
    expect(at(5).cta.label).toBe("Le reprendre");
  });
  it("paiement en échec et abonnement terminé : avertissement avec la raison", () => {
    const pd = accessBanner(entitlement(sub({ status: "past_due", currentPeriodEnd: new Date(NOW.getTime() - DAY) }), NOW))!;
    expect(pd.tone).toBe("warn"); expect(pd.cta.label).toBe("Gérer la facturation");
    const c = accessBanner(entitlement(sub({ status: "canceled" }), NOW))!;
    expect(full(c)).toMatch(/Abonnement terminé/); expect(c.cta.label).toBe("Voir les plans");
  });
  it("aucun abonnement : « Aucun abonnement. » avec lien vers les plans", () => {
    expect(full(accessBanner(entitlement(null, NOW)))).toMatch(/Aucun abonnement/);
  });
});
