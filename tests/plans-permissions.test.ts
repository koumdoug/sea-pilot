import { describe, expect, it } from "vitest";
import { INFORMATIVE_LIMITS, LIMIT_LABEL, PLANS, UNLIMITED, comparePlans, downgradeBlockers, entitlement, limitReached } from "@/lib/plans";
import { assertCan, can, PermissionError } from "@/lib/permissions";
import { canTransition, launchBlockers, utmDefaults } from "@/lib/campaigns";

const DAY = 86_400_000;
const now = new Date("2026-06-15T12:00:00Z");
const sub = (o: Partial<Parameters<typeof entitlement>[0] & object> = {}) => ({ plan: "starter", status: "trialing", trialEndsAt: new Date(now.getTime() + 5 * DAY), currentPeriodEnd: null, cancelAtPeriodEnd: false, ...o }) as Parameters<typeof entitlement>[0];

describe("entitlement (accès selon l'abonnement)", () => {
  it("essai en cours → actif avec jours restants", () => {
    const e = entitlement(sub(), now);
    expect(e.active).toBe(true);
    expect(e.state).toBe("trial");
    expect(e.daysLeft).toBe(5);
  });
  it("essai expiré → bloqué", () => {
    const e = entitlement(sub({ trialEndsAt: new Date(now.getTime() - DAY) }), now);
    expect(e.active).toBe(false);
    expect(e.state).toBe("trial_expired");
  });
  it("abonnement actif → accès", () => {
    expect(entitlement(sub({ status: "active", currentPeriodEnd: new Date(now.getTime() + 20 * DAY) }), now)).toMatchObject({ active: true, state: "paid" });
  });
  it("résiliation programmée : accès jusqu'à la fin de période, puis bloqué", () => {
    const s = sub({ status: "active", cancelAtPeriodEnd: true, currentPeriodEnd: new Date(now.getTime() + 3 * DAY) });
    expect(entitlement(s, now)).toMatchObject({ active: true, state: "canceling" });
    expect(entitlement(s, new Date(now.getTime() + 4 * DAY))).toMatchObject({ active: false, state: "canceled" });
  });
  it("paiement en échec : 7 jours de grâce", () => {
    const s = sub({ status: "past_due", currentPeriodEnd: new Date(now.getTime() - 2 * DAY) });
    expect(entitlement(s, now).active).toBe(true);
    expect(entitlement(s, new Date(now.getTime() + 6 * DAY)).active).toBe(false);
  });
  it("canceled / incomplete / absent → bloqué", () => {
    expect(entitlement(sub({ status: "canceled" }), now).active).toBe(false);
    expect(entitlement(sub({ status: "incomplete" }), now).active).toBe(false);
    expect(entitlement(null, now).active).toBe(false);
  });
});

describe("limites de plan", () => {
  it("limitReached respecte les plans et l'illimité", () => {
    expect(limitReached(PLANS.starter, "activeCampaigns", 3)).toBe(true);
    expect(limitReached(PLANS.starter, "activeCampaigns", 2)).toBe(false);
    expect(PLANS.pro.limits.leadsPerMonth).toBe(UNLIMITED);
    expect(limitReached(PLANS.pro, "leadsPerMonth", 10_000_000)).toBe(false);
  });
  it("upgrade / downgrade / same", () => {
    expect(comparePlans("starter", "growth")).toBe("upgrade");
    expect(comparePlans("pro", "starter")).toBe("downgrade");
    expect(comparePlans("growth", "growth")).toBe("same");
  });
  it("le downgrade est bloqué si l'usage dépasse le plan cible", () => {
    expect(downgradeBlockers(PLANS.starter, { landingPages: 5, members: 1 })).toHaveLength(1);
    expect(downgradeBlockers(PLANS.starter, { landingPages: 2 })).toHaveLength(0);
  });
  it("le quota de leads est informatif : il ne bloque jamais un downgrade à lui seul", () => {
    expect(downgradeBlockers(PLANS.starter, { leadsPerMonth: 301 })).toEqual([]);
    expect(downgradeBlockers(PLANS.starter, { leadsPerMonth: 50_000 })).toEqual([]);
    expect(downgradeBlockers(PLANS.growth, { leadsPerMonth: 2_001 })).toEqual([]);
    expect(INFORMATIVE_LIMITS).toEqual(["leadsPerMonth"]);
  });
  it("les autres blocages de downgrade subsistent, y compris quand le quota de leads est dépassé", () => {
    const usage = { leadsPerMonth: 5_000, members: 2, activeCampaigns: 4, landingPages: 4, sequences: 2, integrations: 3, apiKeys: 2 };
    expect(downgradeBlockers(PLANS.starter, usage)).toHaveLength(6); // tout sauf les leads
    expect(downgradeBlockers(PLANS.starter, { leadsPerMonth: 5_000, members: 2 })).toHaveLength(1);
  });
  it("les messages de blocage sont en français, sans clé technique", () => {
    const m = downgradeBlockers(PLANS.starter, { members: 2, activeCampaigns: 4, landingPages: 4, sequences: 2, integrations: 3, apiKeys: 2 }).join(" | ");
    for (const key of ["members", "activeCampaigns", "landingPages", "sequences", "integrations", "apiKeys", "leadsPerMonth"]) expect(m).not.toContain(key);
    expect(m).toMatch(/Utilisateurs : 2 utilisé\(s\) pour une limite de 1/);
    expect(m).toMatch(/Landing pages : 4 utilisé\(s\) pour une limite de 3/);
  });
});

describe("fonctionnalités affichées des forfaits", () => {
  it("les seuils de leads sont présentés comme indicatifs ; Pro reste illimité", () => {
    expect(PLANS.starter.features).toContain("300 leads / mois (seuil indicatif)");
    expect(PLANS.growth.features).toContain("2 000 leads / mois (seuil indicatif)");
    expect(PLANS.pro.features).toContain("Leads illimités");
    expect(PLANS.starter.features).not.toContain("300 leads / mois");
    expect(PLANS.growth.features).not.toContain("2 000 leads / mois");
  });
  it("« Support prioritaire » n'est promis par aucun forfait (données canoniques de l'accueil et de la facturation)", () => {
    for (const p of Object.values(PLANS)) {
      expect([p.tagline, ...p.features].join(" | ")).not.toMatch(/support/i);
    }
  });
  it("les autres fonctionnalités Pro sont conservées", () => {
    expect(PLANS.pro.features).toEqual(["25 utilisateurs", "Campagnes et landing pages illimitées", "Leads illimités", "Séquences illimitées", "Accès API"]);
  });
  it("les libellés de limites couvrent toutes les limites, sans clé technique", () => {
    for (const k of Object.keys(PLANS.starter.limits) as (keyof typeof PLANS.starter.limits)[]) {
      expect(LIMIT_LABEL[k]).toBeTruthy();
      expect(LIMIT_LABEL[k]).not.toBe(k);
    }
  });
});

describe("permissions", () => {
  it("viewer en lecture seule", () => {
    expect(can("viewer", "read")).toBe(true);
    expect(can("viewer", "write")).toBe(false);
    expect(can("viewer", "ai")).toBe(false);
  });
  it("member écrit mais ne gère ni intégrations ni facturation", () => {
    expect(can("member", "write")).toBe(true);
    expect(can("member", "manage_integrations")).toBe(false);
    expect(can("member", "manage_billing")).toBe(false);
  });
  it("admin gère les intégrations, seul l'owner gère la facturation et la suppression", () => {
    expect(can("admin", "manage_integrations")).toBe(true);
    expect(can("admin", "manage_billing")).toBe(false);
    expect(can("owner", "manage_billing")).toBe(true);
    expect(can("owner", "delete_workspace")).toBe(true);
    expect(can("admin", "delete_workspace")).toBe(false);
  });
  it("rôle inconnu ou absent → refus", () => {
    expect(can("hacker", "read")).toBe(false);
    expect(can(null, "read")).toBe(false);
    expect(() => assertCan("viewer", "write")).toThrow(PermissionError);
  });
});

describe("cycle de vie des campagnes", () => {
  it("transitions autorisées et interdites", () => {
    expect(canTransition("draft", "ready")).toBe(true);
    expect(canTransition("ready", "active")).toBe(true);
    expect(canTransition("active", "paused")).toBe(true);
    expect(canTransition("draft", "active")).toBe(false);
    expect(canTransition("completed", "active")).toBe(false);
    expect(canTransition("archived", "draft")).toBe(true);
  });
  it("blocages avant lancement", () => {
    const c = { name: "C", platform: "google_ads", budget: 100, objective: "leads", offerId: "o", audienceId: "a", landingPageId: null };
    expect(launchBlockers(c, false, "ready")).toEqual([]);
    expect(launchBlockers(c, false, "active")).toContain("landing page");
    expect(launchBlockers({ ...c, landingPageId: "p" }, false, "active")).toContain("landing page publiée");
    expect(launchBlockers({ ...c, landingPageId: "p" }, true, "active")).toEqual([]);
    expect(launchBlockers({ ...c, budget: 0, offerId: null }, true, "ready")).toEqual(expect.arrayContaining(["budget", "offre"]));
  });
  it("UTM par défaut selon la plateforme", () => {
    expect(utmDefaults({ id: "c1", name: "N", platform: "google_ads" })).toEqual({ utm_source: "google", utm_medium: "cpc", utm_campaign: "c1" });
  });
});
