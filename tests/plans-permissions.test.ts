import { describe, expect, it } from "vitest";
import { PLANS, UNLIMITED, comparePlans, downgradeBlockers, entitlement, limitReached } from "@/lib/plans";
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
