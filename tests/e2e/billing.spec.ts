import { expect, test, type Browser, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

// Facturation dans un vrai navigateur (Stripe NON configuré sur le serveur e2e) : le forfait affiché, la bannière et la section Usage doivent suivre
// le forfait réellement attribué, sans rechargement manuel ; aucune souscription n'est simulée. Comptes créés dans la base e2e (la limite
// d'inscriptions par adresse est déjà consommée par les autres specs), connexion par le vrai formulaire. Données 100 % synthétiques.
const db = new PrismaClient({ datasourceUrl: "file:./e2e.db" });
const stamp = Date.now();
const U = { name: "Bianca Billing", email: `billing.${stamp}@e2e.test`, password: "MotDePasse2026" };
let page: Page;
let wsId = "";

async function signIn(browser: Browser) {
  const user = await db.user.create({ data: { email: U.email, name: U.name, passwordHash: await bcrypt.hash(U.password, 4) } });
  const ws = await db.workspace.create({ data: { name: "Billing SARL", slug: `billing-${stamp}`, onboardingCompletedAt: new Date(), subscription: { create: { plan: "starter", status: "trialing", trialEndsAt: new Date(Date.now() + 14 * 86_400_000) } } } });
  await db.membership.create({ data: { userId: user.id, workspaceId: ws.id, role: "owner" } });
  wsId = ws.id;
  const ctx = await browser.newContext({ baseURL: "http://localhost:3101", viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  await p.goto("/login");
  await p.getByLabel(/^Adresse e-mail/).fill(U.email);
  await p.getByLabel(/^Mot de passe/).fill(U.password);
  await p.getByRole("button", { name: "Se connecter" }).click();
  await expect(p).toHaveURL(/\/dashboard/);
  return p;
}
const planCard = (p: Page, name: string) => p.locator("li", { has: p.getByRole("heading", { name, exact: true }) });
const usageRow = (p: Page, label: string) => p.locator("section", { has: p.getByRole("heading", { name: "Usage", exact: true }) }).locator("li", { hasText: label }).first();

test.beforeAll(async ({ browser }) => { page = await signIn(browser); });
test.afterAll(async () => { await page.context().close(); await db.$disconnect(); });

test.describe.serial("facturation — navigateur", () => {
  test("Starter en essai : forfait, bannière et limites Starter ; aucune souscription possible sans Stripe", async () => {
    await page.goto("/billing");
    await expect(page.getByRole("heading", { name: /Plan Starter/ })).toBeVisible();
    await expect(usageRow(page, "Utilisateurs")).toContainText("1 / 1");
    await expect(usageRow(page, "Campagnes actives")).toContainText("/ 3");
    await expect(page.getByRole("button", { name: /Souscrire/ })).toHaveCount(0);
  });

  test("essai d'un autre forfait : l'écran (forfait, bannière, limites) suit sans rechargement", async () => {
    await page.goto("/billing");
    await planCard(page, "Growth").getByRole("button", { name: /Essayer/ }).click();
    await expect(page.getByRole("heading", { name: /Plan Growth/ })).toBeVisible();
    await expect(page.getByText(/Formule Growth/)).toBeVisible();
    await expect(usageRow(page, "Utilisateurs")).toContainText("/ 5");
    await expect(usageRow(page, "Campagnes actives")).toContainText("/ 15");
    expect((await db.subscription.findUniqueOrThrow({ where: { workspaceId: wsId } })).plan).toBe("growth");
  });

  test("paiement non configuré : variables listées une par une, conditions d'activation, aucune souscription possible", async () => {
    await page.goto("/billing");
    const box = page.locator("[role=alert], [role=status]", { hasText: "Paiement : configuration requise" }).first();
    await expect(box).toBeVisible();
    const items = box.locator("li", { hasText: /définie|manquante/ });
    await expect(items).toHaveCount(5);
    for (const name of ["STRIPE_SECRET_KEY", "STRIPE_PRICE_STARTER", "STRIPE_PRICE_GROWTH", "STRIPE_PRICE_PRO", "STRIPE_WEBHOOK_SECRET"]) await expect(items.filter({ hasText: name }).first()).toContainText("manquante");
    expect(await page.locator("body").innerText()).not.toContain("STRIPE_SECRET_KEYSTRIPE_PRICE");
    await expect(box.getByText(/\/api\/stripe\/webhook/).first()).toBeVisible();
    await expect(box.getByText("customer.subscription.updated").first()).toBeVisible();
    await expect(page.getByRole("button", { name: /Souscrire|Passer à|Rétrograder/ })).toHaveCount(0);
    await expect(page.getByText(/Souscription indisponible/).first()).toBeVisible();
  });

  test("tableau comparatif : les limites de chaque forfait, issues de la source centrale", async () => {
    await page.goto("/billing");
    const table = page.getByRole("table", { name: "Limites par forfait" });
    await expect(table).toBeVisible();
    await expect(table.getByRole("columnheader")).toHaveText(["Limite", "Starter", "Growth", "Pro"]);
    await expect(table.getByRole("row", { name: /Utilisateurs/ })).toContainText("1");
    const row = (label: string) => table.getByRole("row").filter({ has: page.getByRole("rowheader", { name: label }) });
    await expect(row("Utilisateurs").getByRole("cell")).toHaveText(["1", "5", "25"]);
    await expect(row("Campagnes actives").getByRole("cell")).toHaveText(["3", "15", "∞"]);
    await expect(row("Landing pages").getByRole("cell")).toHaveText(["3", "15", "∞"]);
  });

  test("abonnement payant confirmé : forfait, statut, bouton « Plan actuel » et limites Pro suivent l'état réel ; changement indisponible sans Stripe", async () => {
    await db.subscription.update({ where: { workspaceId: wsId }, data: { plan: "pro", status: "active", stripeSubscriptionId: "sub_e2e", stripeCustomerId: "cus_e2e", currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000), cancelAtPeriodEnd: false } });
    await page.goto("/billing");
    await expect(page.getByRole("heading", { name: /Plan Pro/ })).toBeVisible();
    await expect(page.getByText("Abonnement actif", { exact: true })).toBeVisible();
    await expect(planCard(page, "Pro").getByText("Plan actuel")).toBeVisible();
    await expect(planCard(page, "Growth").getByText(/Changement indisponible/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Passer à|Rétrograder|Souscrire|Essayer/ })).toHaveCount(0);
    await expect(usageRow(page, "Utilisateurs")).toContainText("/ 25");
    await expect(usageRow(page, "Campagnes actives")).toContainText("/ ∞");
    await expect(page.getByText(/Formule/)).toHaveCount(0); // plus aucune bannière d'essai
  });

  test("D1 — abonnement actif : portail et résiliation proposés ; abonnement terminé (identifiant Stripe conservé) : plus aucun bouton de gestion, état explicite", async () => {
    const live = { plan: "growth", status: "active", stripeSubscriptionId: "sub_e2e_d1", stripeCustomerId: "cus_e2e_d1", currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000), cancelAtPeriodEnd: false, canceledAt: null };
    await db.subscription.update({ where: { workspaceId: wsId }, data: live });
    await page.goto("/billing");
    await expect(page.getByRole("button", { name: "Moyen de paiement et factures" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Résilier" })).toBeVisible();
    await db.subscription.update({ where: { workspaceId: wsId }, data: { ...live, cancelAtPeriodEnd: true } });
    await page.goto("/billing");
    await expect(page.getByRole("button", { name: "Reprendre l'abonnement" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Résilier" })).toHaveCount(0);
    // L'abonnement se termine : l'identifiant Stripe reste en base, mais plus aucune action de gestion ne peut aboutir.
    await db.subscription.update({ where: { workspaceId: wsId }, data: { ...live, status: "canceled", cancelAtPeriodEnd: false, canceledAt: new Date() } });
    await page.goto("/billing");
    await expect(page.getByText("Abonnement terminé", { exact: true })).toBeVisible();
    await expect(page.getByText(/Cet abonnement est terminé : aucune action de gestion n'est possible/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Résilier|Reprendre l'abonnement|Moyen de paiement et factures|Terminer l'essai/ })).toHaveCount(0);
    await expect(page.getByText(/Souscription indisponible/).first()).toBeVisible(); // la souscription reste le seul chemin, indisponible ici faute de Stripe
  });
  test("essai expiré : statut explicite, aucun essai de forfait proposé, souscription indisponible sans Stripe", async () => {
    await db.subscription.update({ where: { workspaceId: wsId }, data: { plan: "starter", status: "trialing", stripeSubscriptionId: null, stripeCustomerId: null, trialEndsAt: new Date(Date.now() - 86_400_000) } });
    await page.goto("/billing");
    await expect(page.getByText("Essai expiré", { exact: true })).toBeVisible();
    await expect(page.getByText(/Essai gratuit terminé : l'accès est suspendu/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Essayer ce plan|Souscrire/ })).toHaveCount(0);
    await expect(planCard(page, "Starter").getByText("Dernier plan")).toBeVisible();
    await expect(page.getByText(/Souscription indisponible/).first()).toBeVisible();
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/billing\?blocked=1/); // l'accès au reste de l'application est bien suspendu
  });
  test("membre non propriétaire : message neutre « Paiement indisponible », aucun nom de variable serveur ni procédure technique", async ({ browser }) => {
    const m = { email: `member.${stamp}@e2e.test`, password: "MotDePasse2026" };
    const u = await db.user.create({ data: { email: m.email, name: "Membre Simple", passwordHash: await bcrypt.hash(m.password, 4) } });
    await db.membership.create({ data: { userId: u.id, workspaceId: wsId, role: "member" } });
    await db.subscription.update({ where: { workspaceId: wsId }, data: { plan: "starter", status: "trialing", stripeSubscriptionId: null, stripeCustomerId: null, trialEndsAt: new Date(Date.now() + 5 * 86_400_000) } });
    const ctx = await browser.newContext({ baseURL: "http://localhost:3101", viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    await p.goto("/login");
    await p.getByLabel(/^Adresse e-mail/).fill(m.email);
    await p.getByLabel(/^Mot de passe/).fill(m.password);
    await p.getByRole("button", { name: "Se connecter" }).click();
    await expect(p).toHaveURL(/\/dashboard/);
    await p.goto("/billing");
    await expect(p.getByText("Paiement indisponible", { exact: false }).first()).toBeVisible();
    const body = await p.locator("body").innerText();
    expect(body).not.toContain("STRIPE_SECRET_KEY");
    expect(body).not.toContain("STRIPE_WEBHOOK_SECRET");
    expect(body).not.toContain("/api/stripe/webhook");
    await expect(p.getByText("Paiement : configuration requise")).toHaveCount(0);
    await ctx.close();
  });
});
