import { createHash } from "node:crypto";
import { expect, test, type Browser } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

// Validation navigateur des quotas atomiques, de l'abonnement OAuth et de la politique des clés API (base e2e dédiée, données 100 % synthétiques, aucun fournisseur
// ni Stripe). Comptes créés dans la base e2e puis connexion par le vrai formulaire. Le parcours « propriétaire exempté » exige que le serveur e2e connaisse
// FREE_ACCESS_USER_IDS=e2e-free-owner (variable d'environnement du processus de test) ; sinon il échoue explicitement.
const db = new PrismaClient({ datasourceUrl: "file:./e2e.db" });
const stamp = Date.now();
const PASSWORD = "MotDePasse2026";
const DAY = 86_400_000;
let n = 0;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

type Opts = { plan?: "starter" | "growth" | "pro"; status?: "trialing" | "active" | "canceled"; role?: string; userId?: string; workspaceId?: string; id?: string };
async function session(browser: Browser, o: Opts = {}) {
  const i = ++n;
  const email = `quota.${stamp}.${i}@e2e.test`;
  const user = await db.user.create({ data: { ...(o.userId ? { id: o.userId } : {}), email, name: `Utilisateur ${i}`, passwordHash: await bcrypt.hash(PASSWORD, 4) } });
  let workspaceId = o.workspaceId ?? "";
  if (!workspaceId) {
    const status = o.status ?? "trialing";
    const ws = await db.workspace.create({ data: { name: `Quota ${i} SARL`, slug: `quota-${stamp}-${i}`, onboardingCompletedAt: new Date(), subscription: { create: status === "trialing"
      ? { plan: o.plan ?? "starter", status, trialEndsAt: new Date(Date.now() + 10 * DAY) }
      : { plan: o.plan ?? "starter", status, stripeSubscriptionId: `sub_q${stamp}${i}`, stripeCustomerId: `cus_q${stamp}${i}`, currentPeriodEnd: new Date(Date.now() + (status === "canceled" ? -DAY : 20 * DAY)) } } } });
    workspaceId = ws.id;
  }
  await db.membership.create({ data: { userId: user.id, workspaceId, role: o.role ?? "owner" } });
  const ctx = await browser.newContext({ baseURL: "http://localhost:3101", viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  await page.goto("/login");
  await page.getByLabel(/^Adresse e-mail/).fill(email);
  await page.getByLabel(/^Mot de passe/).fill(PASSWORD);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await expect(page).toHaveURL(/\/(dashboard|billing)/);
  return { page, ctx, workspaceId, userId: user.id, email };
}
const setPlan = (workspaceId: string, plan: string) => db.subscription.update({ where: { workspaceId }, data: { plan } });
let p = 0;
const seedPage = async (workspaceId: string, status = "draft") => {
  const k = ++p;
  const page = await db.landingPage.create({ data: { workspaceId, name: `Page semée ${k}`, slug: `semee-${stamp}-${k}`, status, sections: [] } });
  await db.form.create({ data: { workspaceId, landingPageId: page.id, name: "F", fields: [], consentText: "ok" } });
  return page;
};
const live = (workspaceId: string) => db.landingPage.count({ where: { workspaceId, status: { not: "archived" } } });

test.afterAll(async () => { await db.$disconnect(); });

test.describe.serial("quotas, OAuth et clés API — navigateur", () => {
  test("membres : Starter refuse l'ajout au plafond (1 utilisateur) ; Growth l'accepte", async ({ browser }) => {
    const s = await session(browser, { plan: "starter" });
    const spare = await db.user.create({ data: { email: `spare.${stamp}@e2e.test`, name: "Personne Ajoutée", passwordHash: "x" } });
    await s.page.goto("/settings?tab=equipe");
    await s.page.getByLabel(/^Adresse e-mail du compte/).fill(spare.email);
    await s.page.getByRole("button", { name: "Ajouter", exact: true }).click();
    await expect(s.page.getByText(/Limite d'utilisateurs atteinte/)).toBeVisible();
    expect(await db.membership.count({ where: { workspaceId: s.workspaceId } })).toBe(1);
    await setPlan(s.workspaceId, "growth");
    await s.page.getByLabel(/^Adresse e-mail du compte/).fill(spare.email);
    await s.page.getByRole("button", { name: "Ajouter", exact: true }).click();
    await expect(s.page.getByText(/a été ajouté/)).toBeVisible();
    expect(await db.membership.count({ where: { workspaceId: s.workspaceId } })).toBe(2);
    await s.ctx.close();
  });

  test("landing pages : création et copie refusées au plafond, archivage libère une place ; page et formulaire toujours ensemble", async ({ browser }) => {
    const s = await session(browser, { plan: "starter" });
    await seedPage(s.workspaceId); await seedPage(s.workspaceId);
    await s.page.goto("/landing-pages");
    await s.page.getByLabel(/^Nom de la page/).fill("Troisième page");
    await s.page.getByRole("button", { name: "Créer la page" }).click();
    await expect(s.page).toHaveURL(/\/landing-pages\/[a-z0-9]+$/);
    expect(await live(s.workspaceId)).toBe(3);
    await s.page.goto("/landing-pages");
    await s.page.getByLabel(/^Nom de la page/).fill("Quatrième page");
    await s.page.getByRole("button", { name: "Créer la page" }).click();
    await expect(s.page.getByText(/Limite de landing pages atteinte/)).toBeVisible();
    await s.page.getByRole("button", { name: "Dupliquer" }).first().click();
    await expect(s.page.getByText(/Limite de landing pages atteinte/).first()).toBeVisible();
    expect(await live(s.workspaceId)).toBe(3);
    await s.page.getByRole("button", { name: "Archiver" }).first().click();
    await expect.poll(() => live(s.workspaceId)).toBe(2);
    await s.page.getByRole("button", { name: "Dupliquer" }).first().click();
    await expect(s.page).toHaveURL(/\/landing-pages\/[a-z0-9]+$/);
    expect(await live(s.workspaceId)).toBe(3);
    const orphans = await db.landingPage.findMany({ where: { workspaceId: s.workspaceId }, include: { forms: true } });
    expect(orphans.filter((x) => x.forms.length === 0)).toHaveLength(0);
    await s.ctx.close();
  });

  test("variante d'offre et produit : refusés au plafond, acceptés après libération d'une place", async ({ browser }) => {
    const s = await session(browser, { plan: "starter" });
    const pages = [await seedPage(s.workspaceId), await seedPage(s.workspaceId), await seedPage(s.workspaceId)];
    const offer = await db.offer.create({ data: { workspaceId: s.workspaceId, name: "Offre e2e", variants: [{ id: "v_abcdef", name: "Variante e2e", guarantees: ["Garantie"], bundles: ["Pack"], upsells: ["Option"], headline: "Titre variante", subheadline: "Sous-titre", benefits: ["a", "b"], objections: [{ objection: "Cher ?", answer: "Non" }], valueProposition: "Valeur", cta: "Essayer" }] } });
    await s.page.goto(`/offers/${offer.id}`);
    await s.page.getByRole("button", { name: "Créer une landing page" }).click();
    await expect(s.page.getByText(/Limite de landing pages atteinte/)).toBeVisible();
    await s.page.goto("/portfolio");
    await s.page.getByRole("button", { name: /Créer les fiches DriverPilot, FreelanceNexa et OperaPilot/ }).click();
    await s.page.getByRole("link", { name: "FreelanceNexa" }).first().click();
    await s.page.getByRole("button", { name: /Créer la landing page de FreelanceNexa/ }).click();
    await expect(s.page.getByText(/Limite de landing pages atteinte/)).toBeVisible();
    expect(await live(s.workspaceId)).toBe(3);
    await db.landingPage.update({ where: { id: pages[0].id }, data: { status: "archived" } });
    await s.page.getByRole("button", { name: /Créer la landing page de FreelanceNexa/ }).click();
    await expect(s.page).toHaveURL(/\/landing-pages\/[a-z0-9]+$/);
    await db.landingPage.update({ where: { id: pages[1].id }, data: { status: "archived" } });
    await s.page.goto(`/offers/${offer.id}`);
    await s.page.getByRole("button", { name: "Créer une landing page" }).click();
    await expect(s.page).toHaveURL(/\/landing-pages\/[a-z0-9]+$/);
    expect(await live(s.workspaceId)).toBe(3);
    await s.ctx.close();
  });

  test("campagnes : activation refusée au plafond (Starter = 3 actives), acceptée après passage à Growth", async ({ browser }) => {
    const s = await session(browser, { plan: "starter" });
    const lp = await db.landingPage.create({ data: { workspaceId: s.workspaceId, name: "Page pub", slug: `pub-${stamp}`, status: "published", sections: [] } });
    const offer = await db.offer.create({ data: { workspaceId: s.workspaceId, name: "O" } });
    const aud = await db.audience.create({ data: { workspaceId: s.workspaceId, name: "A" } });
    const base = { workspaceId: s.workspaceId, platform: "google_ads", budget: 100, objective: "leads", offerId: offer.id, audienceId: aud.id, landingPageId: lp.id };
    for (let i = 0; i < 3; i++) await db.campaign.create({ data: { ...base, name: `Active ${i}`, status: "active" } });
    const c = await db.campaign.create({ data: { ...base, name: "Quatrième campagne", status: "ready" } });
    await s.page.goto(`/campaigns/${c.id}`);
    await s.page.getByRole("button", { name: "Activer", exact: true }).click();
    await expect(s.page.getByText(/Limite de campagnes actives atteinte/)).toBeVisible();
    expect((await db.campaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("ready");
    await setPlan(s.workspaceId, "growth");
    await s.page.getByRole("button", { name: "Activer", exact: true }).click();
    await expect.poll(async () => (await db.campaign.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("active");
    await s.ctx.close();
  });

  test("clés API : retrait d'un membre → ses clés restent actives et fonctionnent, alerte réservée aux gestionnaires, révocation manuelle", async ({ browser, request }) => {
    const s = await session(browser, { plan: "pro", status: "active" });
    const admin = await session(browser, { workspaceId: s.workspaceId, role: "admin" });
    const secret = `sp_e2e_${stamp}_` + "x".repeat(24);
    await db.apiKey.create({ data: { workspaceId: s.workspaceId, name: "Clé de l'ancien admin", prefix: secret.slice(0, 10), keyHash: sha256(secret), createdById: admin.userId } });
    await admin.ctx.close();
    await s.page.goto("/settings?tab=api");
    await expect(s.page.getByText("Clés créées par un ancien membre")).toHaveCount(0); // son auteur est encore membre
    await s.page.goto("/settings?tab=equipe");
    await s.page.locator("tr", { hasText: admin.email }).getByRole("button", { name: "Retirer" }).click();
    await expect.poll(() => db.membership.count({ where: { workspaceId: s.workspaceId, userId: admin.userId } })).toBe(0);
    await s.page.goto("/settings?tab=api");
    await expect(s.page.getByText("Clés créées par un ancien membre").first()).toBeVisible();
    await expect(s.page.locator("tr", { hasText: "Clé de l'ancien admin" }).getByText("Active")).toBeVisible();
    expect((await request.post("/api/v1/leads", { headers: { authorization: `Bearer ${secret}` }, data: { name: "Lead", email: `lead.${stamp}@client.test` } })).status()).toBe(201);
    const audit = await db.auditLog.findFirst({ where: { workspaceId: s.workspaceId, action: "apikey.creator_removed" } });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit!.meta)).not.toContain(secret);
    expect(JSON.stringify(audit)).not.toContain(secret.slice(0, 10)); // ni le préfixe
    // un simple membre ne voit pas l'alerte
    const m = await session(browser, { workspaceId: s.workspaceId, role: "member" });
    await m.page.goto("/settings?tab=api");
    await expect(m.page.getByText("Clés créées par un ancien membre")).toHaveCount(0);
    await m.ctx.close();
    // révocation manuelle existante : la clé est refusée et l'alerte disparaît
    await s.page.goto("/settings?tab=api");
    await s.page.getByRole("button", { name: "Révoquer" }).first().click();
    await expect.poll(async () => (await request.post("/api/v1/leads", { headers: { authorization: `Bearer ${secret}` }, data: { name: "x", email: `x.${stamp}@client.test` } })).status()).toBe(401);
    await s.page.goto("/settings?tab=api");
    await expect(s.page.getByText("Clés créées par un ancien membre")).toHaveCount(0);
    await s.ctx.close();
  });

  test("OAuth : abonnement actif → la demande passe le contrôle d'abonnement (arrêt sur « non configuré ») ; inactif → refus error=inactive, accès suspendu hors facturation", async ({ browser }) => {
    const ok = await session(browser, { plan: "growth", status: "active" });
    const r1 = await ok.page.request.get("/api/integrations/meta_ads/connect", { maxRedirects: 0 });
    expect([302, 307]).toContain(r1.status());
    expect(r1.headers().location).toContain("error=needs_config");
    expect(r1.headers().location).not.toContain("inactive");
    await ok.ctx.close();

    const off = await session(browser, { plan: "growth", status: "canceled" });
    const r2 = await off.page.request.get("/api/integrations/meta_ads/connect", { maxRedirects: 0 });
    expect(r2.headers().location).toContain("/integrations?error=inactive");
    await off.page.goto("/integrations?error=inactive");
    await expect(off.page).toHaveURL(/\/billing/); // l'écran des intégrations reste suspendu pour un abonnement inactif
    await off.ctx.close();
  });

  test("propriétaire exempté (FREE_ACCESS_USER_IDS) : accès complet sans abonnement actif, OAuth accepté, droits Pro ; non exempté : bloqué", async ({ browser }) => {
    // Non exécuté (et non simulé) si le serveur e2e n'a pas reçu l'identifiant exempté : lancer avec FREE_ACCESS_USER_IDS=e2e-free-owner.
    test.skip(process.env.FREE_ACCESS_USER_IDS !== "e2e-free-owner", "FREE_ACCESS_USER_IDS=e2e-free-owner requis pour ce parcours");
    const free = await session(browser, { plan: "starter", status: "canceled", userId: "e2e-free-owner" });
    await free.page.goto("/dashboard");
    await expect(free.page, "le serveur e2e doit être lancé avec FREE_ACCESS_USER_IDS=e2e-free-owner").toHaveURL(/\/dashboard/);
    const r = await free.page.request.get("/api/integrations/meta_ads/connect", { maxRedirects: 0 });
    expect(r.headers().location).toContain("error=needs_config");
    expect(r.headers().location).not.toContain("inactive");
    await free.page.goto("/settings?tab=api");
    await expect(free.page.getByRole("button", { name: "Créer la clé" })).toBeVisible(); // droits Pro malgré l'abonnement Starter résilié
    for (let i = 0; i < 5; i++) await seedPage(free.workspaceId);
    await free.page.goto("/landing-pages");
    await free.page.getByLabel(/^Nom de la page/).fill("Au-delà du plafond Starter");
    await free.page.getByRole("button", { name: "Créer la page" }).click();
    await expect(free.page).toHaveURL(/\/landing-pages\/[a-z0-9]+$/);
    await free.ctx.close();

    const other = await session(browser, { plan: "starter", status: "canceled" });
    await other.page.goto("/dashboard");
    await expect(other.page).toHaveURL(/\/billing/);
    await other.ctx.close();
  });
});
