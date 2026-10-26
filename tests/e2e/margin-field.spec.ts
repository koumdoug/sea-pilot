import { expect, test, type Locator, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

// Passes 1 et 2 — champ « Marge approximative (%) », validation à l'étape « Offre » et préservation des saisies après un rejet serveur.
// Navigateur réel (Google Chrome), serveur de production local, base SQLite e2e.db. Un SEUL compte est créé pour tout ce fichier
// (l'inscription est limitée à 5 par heure et par IP, et les autres fichiers e2e en utilisent déjà 3).
const db = new PrismaClient({ datasourceUrl: "file:./e2e.db" });
const stamp = Date.now();
const U = { name: "Marge Test", email: `marge.${stamp}@e2e.test`, password: "MotDePasse2026", company: `Société Marge ${stamp}` };
let page: Page;

test.beforeAll(async ({ browser }) => { page = await (await browser.newContext({ baseURL: "http://localhost:3101", viewport: { width: 1280, height: 800 } })).newPage(); });
test.afterAll(async () => { await page.context().close(); await db.$disconnect(); });

/** Chaque test est indépendant : le compte est créé une seule fois (inscription limitée à 5 par heure), puis la session est rétablie par connexion si besoin. */
async function ensureLoggedIn() {
  if (!(await db.user.findUnique({ where: { email: U.email } }))) {
    await page.goto("/register");
    await page.getByLabel(/^Votre nom/).fill(U.name);
    await page.getByLabel(/^Nom de votre entreprise/).fill(U.company);
    await page.getByLabel(/^Adresse e-mail professionnelle/).fill(U.email);
    await page.getByLabel(/^Mot de passe/).fill(U.password);
    await page.getByLabel(/J'accepte les/).check();
    await page.getByRole("button", { name: "Créer mon compte" }).click();
    await expect(page).toHaveURL(/\/onboarding$/);
    return;
  }
  await page.goto("/dashboard");
  if (/\/login/.test(page.url())) {
    await page.getByLabel(/^Adresse e-mail/).fill(U.email);
    await page.getByLabel(/^Mot de passe/).fill(U.password);
    await page.getByRole("button", { name: "Se connecter" }).click();
    await expect(page).not.toHaveURL(/\/login/);
  }
}
const setOnboardingDone = (done: boolean) => db.workspace.updateMany({ where: { name: U.company }, data: { onboardingCompletedAt: done ? new Date() : null } });
const margin = () => page.locator('input[name="marginPct"]').first();
/**
 * Cause d'un blocage du champ de marge : `customError` = contrôle d'unité personnalisé (setCustomValidity) ; `stepMismatch` = pas de saisie du navigateur.
 * Ne pas confondre : « .28 » sans case doit être bloqué par le contrôle d'unité (customError), PAS par le pas de saisie (stepMismatch).
 */
const flags = () => margin().evaluate((el) => { const v = (el as HTMLInputElement).validity; return { customError: v.customError, stepMismatch: v.stepMismatch, valid: v.valid }; });
/** Requêtes d'actions serveur (POST avec en-tête Next-Action) émises par la page. */
function countActionPosts() {
  const counter = { n: 0 };
  page.on("request", (r) => { if (r.method() === "POST" && r.headers()["next-action"]) counter.n++; });
  return counter;
}

type Validity = { step: string | null; valid: boolean; stepMismatch: boolean; rangeUnderflow: boolean; rangeOverflow: boolean };
async function validity(value: string): Promise<Validity> {
  return margin().evaluate((el, v) => {
    const i = el as HTMLInputElement;
    i.value = v;
    return { step: i.getAttribute("step"), valid: i.checkValidity(), stepMismatch: i.validity.stepMismatch, rangeUnderflow: i.validity.rangeUnderflow, rangeOverflow: i.validity.rangeOverflow };
  }, value);
}
async function assertMarginField() {
  for (const v of ["0.28", "0.3", "0.99", "28", "28.5", "28.55", "100", "1", "0"]) {
    const r = await validity(v);
    expect(r.stepMismatch, `${v} ne doit pas être bloqué par le pas de saisie`).toBe(false);
    expect(r.valid, `${v} doit être valide pour le navigateur`).toBe(true);
  }
  expect((await validity("-1")).rangeUnderflow, "-1 reste hors borne").toBe(true);
  expect((await validity("100.01")).rangeOverflow, "100.01 reste hors borne").toBe(true);
  expect((await validity("101")).valid).toBe(false);
}

const step = () => page.locator('[aria-current="step"]');
const next = () => page.getByRole("button", { name: /Continuer/ });
// Partie propre au message d'erreur (le texte d'aide permanent contient aussi « La marge s'exprime en pourcentage entier »).
const unitMessage = /serait lue comme/;
async function fillOnboardingStep0() {
  await page.getByLabel(/^Secteur d'activité/).fill("Rénovation");
  await page.getByLabel(/^Description de l'activité/).fill("Rénovation de salles de bain clé en main.");
}
async function fillOnboardingStep1(marginValue: string) {
  await page.getByLabel(/^Produit ou service/).fill("Salle de bain clé en main");
  await page.getByLabel(/^Prix \(devise/).fill("1000");
  await margin().fill(marginValue);
}
const ONBOARDING_FIELDS: [string, string][] = [
  ["industry", "Rénovation"], ["description", "Rénovation de salles de bain clé en main."], ["offerName", "Salle de bain clé en main"],
  ["price", "1000"], ["marginPct", "101"], ["customerType", "Propriétaires de maisons"],
];
const valueOf = (name: string): Locator => page.locator(`form input[name="${name}"], form textarea[name="${name}"], form select[name="${name}"]`).first(); // « form » : évite la balise <meta name="description">

test("C. offre : décimales, rejet, case de confirmation puis renvoi — sans recharger la page", async () => {
  await ensureLoggedIn();
  await setOnboardingDone(false);
  await page.goto("/onboarding");
  await expect(step()).toBeVisible();
  await assertMarginField(); // assistant d'onboarding

  await setOnboardingDone(true);
  await page.goto("/offers?new=1");
  await expect(page.getByRole("button", { name: "Créer l'offre" })).toBeVisible();
  await assertMarginField(); // formulaire d'offre

  const posts = countActionPosts();
  await page.getByLabel(/^Produit \/ service/).fill("Offre marge ambiguë");
  await margin().fill("0.28");
  await page.getByRole("button", { name: "Créer l'offre" }).click();
  // rejet : bloqué par le CONTRÔLE D'UNITÉ (customError) et non par le pas de saisie (stepMismatch) ; message visible, saisies conservées, rien n'est parti vers le serveur
  expect(await flags()).toMatchObject({ customError: true, stepMismatch: false, valid: false });
  await expect(page.getByText(unitMessage)).toBeVisible();
  await expect(page.getByLabel(/^Produit \/ service/)).toHaveValue("Offre marge ambiguë");
  await expect(margin()).toHaveValue("0.28");
  expect(posts.n, "le contrôle d'unité est fait avant l'envoi").toBe(0);

  // case cochée puis renvoi, SANS rechargement
  await page.getByLabel("Je confirme une marge inférieure à 1 %").check();
  await page.getByRole("button", { name: "Créer l'offre" }).click();
  await expect(page).toHaveURL(/\/offers\/[a-z0-9]+$/);
  expect(posts.n).toBe(1);
  const saved = await db.offer.findFirst({ where: { name: "Offre marge ambiguë", workspace: { name: U.company } } });
  expect(saved?.marginPct).toBe(0.28);
  page.removeAllListeners("request");
});

test("B. offre : un rejet serveur que le navigateur ne bloque pas conserve les champs, puis la correction est enregistrée une seule fois", async () => {
  await ensureLoggedIn();
  await setOnboardingDone(true);
  await page.goto("/offers?new=1");
  const posts = countActionPosts();
  await page.getByLabel(/^Produit \/ service/).fill("Offre à conserver");
  await page.getByLabel("Description").fill("Description conservée");
  await page.getByLabel(/^Prix/).fill("1000");
  await margin().fill("101");
  await margin().evaluate((el) => { (el as HTMLInputElement).form!.noValidate = true; });
  await page.getByRole("button", { name: "Créer l'offre" }).click();
  await expect(page.getByText("Entre 0 et 100")).toBeVisible();
  expect(posts.n).toBe(1);
  await expect(page.getByLabel(/^Produit \/ service/)).toHaveValue("Offre à conserver");
  await expect(page.getByLabel("Description")).toHaveValue("Description conservée");
  await expect(page.getByLabel(/^Prix/)).toHaveValue("1000");
  await expect(margin()).toHaveValue("101");

  // une nouvelle saisie n'est jamais écrasée : la correction part telle quelle, en une seule soumission
  await margin().fill("28");
  await page.getByRole("button", { name: "Créer l'offre" }).click();
  await expect(page).toHaveURL(/\/offers\/[a-z0-9]+$/);
  expect(posts.n).toBe(2);
  const rows = await db.offer.findMany({ where: { name: "Offre à conserver", workspace: { name: U.company } } });
  expect(rows).toHaveLength(1);
  expect(rows[0].marginPct).toBe(28);
  page.removeAllListeners("request");
});

test("A. onboarding : 0,28 à l'étape « Offre » bloque l'avancée avec un message visible ; avec la case, le parcours va jusqu'au bout", async () => {
  await ensureLoggedIn();
  await setOnboardingDone(false);
  await page.goto("/onboarding");
  await fillOnboardingStep0();
  await next().click();
  await expect(step()).toContainText("Offre");
  await fillOnboardingStep1("0.28");
  await next().click();

  // bloqué : l'utilisateur reste sur l'étape, message d'unité visible près du champ, aucun champ effacé
  await expect(step()).toContainText("Offre");
  expect(await flags(), "bloqué par le contrôle d'unité, pas par le pas de saisie").toMatchObject({ customError: true, stepMismatch: false, valid: false });
  await expect(page.locator('[data-step="1"]').getByText(unitMessage)).toBeVisible();
  expect(await margin().evaluate((el) => (el as HTMLInputElement).validationMessage)).toMatch(/pourcentage entier/);
  await expect(page.getByLabel(/^Produit ou service/)).toHaveValue("Salle de bain clé en main");
  await expect(page.getByLabel(/^Prix \(devise/)).toHaveValue("1000");
  await expect(margin()).toHaveValue("0.28");

  // la validité personnalisée est effacée dès que la valeur change, puis dès que la case change
  await margin().fill("0.3");
  expect(await margin().evaluate((el) => (el as HTMLInputElement).validationMessage)).toBe("");
  await expect(page.locator('[data-step="1"]').getByText(unitMessage)).toBeHidden();
  await next().click();
  await expect(step()).toContainText("Offre");
  expect(await margin().evaluate((el) => (el as HTMLInputElement).validationMessage)).toMatch(/pourcentage entier/);
  await page.getByLabel("Je confirme une marge inférieure à 1 %").check();
  expect(await margin().evaluate((el) => (el as HTMLInputElement).validationMessage)).toBe("");
  await expect(page.locator('[data-step="1"]').getByText(unitMessage)).toBeHidden();

  // avec la case : il avance et le parcours va jusqu'au bout
  await next().click();
  await expect(step()).toContainText("Client idéal");
  await page.getByLabel(/^Type de client/).fill("Propriétaires de maisons");
  await next().click();
  await expect(step()).toContainText("Objectifs");
  await page.getByRole("button", { name: "Générer ma stratégie" }).click();
  await expect(page).toHaveURL(/\/strategy\?welcome=1/, { timeout: 60_000 });
  const offer = await db.offer.findFirst({ where: { name: "Salle de bain clé en main", workspace: { name: U.company } }, orderBy: { createdAt: "desc" } });
  expect(offer?.marginPct).toBe(0.3);
});

test("B. onboarding : un rejet serveur que le navigateur ne bloque pas conserve les six champs ; la correction n'est soumise qu'une fois", async () => {
  await ensureLoggedIn();
  await setOnboardingDone(false);
  await page.goto("/onboarding");
  const posts = countActionPosts();
  await fillOnboardingStep0();
  await next().click();
  await fillOnboardingStep1("28");
  await next().click();
  await expect(step()).toContainText("Client idéal");
  await page.getByLabel(/^Type de client/).fill("Propriétaires de maisons");
  await next().click();
  await expect(step()).toContainText("Objectifs");

  // rejet serveur : marge 101 injectée à la dernière étape, validation native désactivée
  await margin().evaluate((el) => { const i = el as HTMLInputElement; i.value = "101"; i.form!.noValidate = true; });
  await page.getByRole("button", { name: "Générer ma stratégie" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /Certains champs sont invalides/ })).toBeVisible();
  expect(posts.n).toBe(1);
  await expect(step()).toContainText("Objectifs");
  for (const [name, expected] of ONBOARDING_FIELDS) await expect(valueOf(name), name).toHaveValue(expected);

  // nouvelle saisie jamais écrasée, une seule soumission par clic
  await margin().evaluate((el) => { (el as HTMLInputElement).value = "28"; });
  await page.getByRole("button", { name: "Générer ma stratégie" }).click();
  await expect(page).toHaveURL(/\/strategy\?welcome=1/, { timeout: 60_000 });
  expect(posts.n).toBe(2);
  const offers = await db.offer.findMany({ where: { name: "Salle de bain clé en main", workspace: { name: U.company }, marginPct: 28 } });
  expect(offers).toHaveLength(1);
  page.removeAllListeners("request");
});

// Comportement connu, à retirer lors du correctif générique de ActionForm.
// Vider le mot de passe après un rejet est souhaitable ; vider AUSSI l'adresse e-mail est un comportement temporaire, qui ne doit pas être
// considéré comme une spécification fonctionnelle permanente. Ce test garantit seulement que ce formulaire n'a pas changé pendant ces passes
// (mesure de référence faite sur le code d'origine, formulaire de connexion = autre ActionForm).
const LOGIN_AFTER_REJECT = { email: "", password: "" };
test("autre formulaire inchangé : la connexion refusée garde son comportement actuel", async ({ browser }) => {
  await ensureLoggedIn();
  const ctx = await browser.newContext({ baseURL: "http://localhost:3101" });
  const p = await ctx.newPage();
  await p.goto("/login");
  await p.getByLabel(/^Adresse e-mail/).fill(U.email);
  await p.getByLabel(/^Mot de passe/).fill("Mauvais-mot-de-passe-1");
  await p.getByRole("button", { name: "Se connecter" }).click();
  await expect(p.getByText("Identifiants invalides.")).toBeVisible(); // message exact (le rôle « alert » seul peut désigner l'annonceur de route de Next)
  await p.waitForTimeout(1000);
  const after = { email: await p.getByLabel(/^Adresse e-mail/).inputValue(), password: await p.getByLabel(/^Mot de passe/).inputValue() };
  test.info().annotations.push({ type: "mesure", description: JSON.stringify(after) });
  expect(after).toEqual(LOGIN_AFTER_REJECT);
  await ctx.close();
});

test("D1. offre : « .5 » tapé au clavier dans le prix est accepté et enregistré comme nombre", async () => {
  await ensureLoggedIn();
  await setOnboardingDone(true);
  await page.goto("/offers?new=1");
  await page.getByLabel(/^Produit \/ service/).fill("Offre prix décimal");
  const price = page.getByLabel(/^Prix/);
  await price.pressSequentially(".5"); // frappes réelles : Chrome conserve « .5 » tel quel dans le champ numérique
  expect(await price.inputValue()).toBe(".5");
  await margin().fill("28");
  const posts = countActionPosts();
  await page.getByRole("button", { name: "Créer l'offre" }).click();
  await expect(page).toHaveURL(/\/offers\/[a-z0-9]+$/);
  expect(posts.n).toBe(1);
  const saved = await db.offer.findFirst({ where: { name: "Offre prix décimal", workspace: { name: U.company } } });
  expect(typeof saved?.price).toBe("number");
  expect(saved?.price).toBe(0.5);
  expect(saved?.marginPct).toBe(28);
  page.removeAllListeners("request");
});

test("D2. onboarding : « .28 » tapé au clavier à l'étape Offre — bloqué sans case par le contrôle d'unité, accepté avec ; valeur enregistrée 0.28", async () => {
  await ensureLoggedIn();
  await setOnboardingDone(false);
  await page.goto("/onboarding");
  await fillOnboardingStep0();
  await next().click();
  await expect(step()).toContainText("Offre");
  await page.getByLabel(/^Produit ou service/).fill("Offre point vingt-huit");
  await page.getByLabel(/^Prix \(devise/).pressSequentially(".5");
  await margin().pressSequentially(".28");
  expect(await margin().inputValue()).toBe(".28");

  await next().click();
  // bloqué sans case : par le contrôle d'unité (customError), PAS par le pas de saisie (stepMismatch)
  await expect(step()).toContainText("Offre");
  expect(await flags()).toMatchObject({ customError: true, stepMismatch: false, valid: false });
  await expect(page.locator('[data-step="1"]').getByText(unitMessage)).toBeVisible();
  await expect(margin()).toHaveValue(".28");

  // avec la case : il avance et le parcours va jusqu'au bout, sans rechargement
  await page.getByLabel("Je confirme une marge inférieure à 1 %").check();
  await next().click();
  await expect(step()).toContainText("Client idéal");
  await page.getByLabel(/^Type de client/).fill("Propriétaires de maisons");
  await next().click();
  await expect(step()).toContainText("Objectifs");
  await page.getByRole("button", { name: "Générer ma stratégie" }).click();
  await expect(page).toHaveURL(/\/strategy\?welcome=1/, { timeout: 60_000 });
  const offer = await db.offer.findFirst({ where: { name: "Offre point vingt-huit", workspace: { name: U.company } }, orderBy: { createdAt: "desc" } });
  expect(typeof offer?.marginPct).toBe("number");
  expect(offer?.marginPct).toBe(0.28);
  expect(offer?.price).toBe(0.5);
});

// Lot 3A / R18 : (même compte que les tests ci-dessus : l'inscription est limitée à 5 par heure) le taux de conversion du tableau de bord est
// GLOBAL (leads et clics sans campagne inclus) : il est libellé comme tel et le taux rattaché aux campagnes est affiché à côté.
test("R18. tableau de bord : taux de conversion libellé « global » et taux rattaché aux campagnes affiché à côté", async () => {
  await ensureLoggedIn();
  await setOnboardingDone(true);
  const ws = await db.workspace.findFirstOrThrow({ where: { name: U.company } });
  const campaign = await db.campaign.create({ data: { workspaceId: ws.id, name: "Campagne R18", status: "active", platform: "google_ads" } });
  const day = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  await db.metric.create({ data: { workspaceId: ws.id, campaignId: campaign.id, platform: "google_ads", date: day, spend: 100, impressions: 5000, clicks: 200, dedupeKey: `r18-a-${stamp}` } });
  await db.metric.create({ data: { workspaceId: ws.id, campaignId: null, platform: "google_ads", date: day, spend: 20, impressions: 800, clicks: 40, dedupeKey: `r18-b-${stamp}` } });
  await db.lead.createMany({ data: [
    ...Array.from({ length: 10 }, (_, n) => ({ workspaceId: ws.id, name: `R18 rattaché ${n}`, email: `r18a${n}.${stamp}@e2e.test`, campaignId: campaign.id, source: "manuel" })),
    ...Array.from({ length: 20 }, (_, n) => ({ workspaceId: ws.id, name: `R18 sans campagne ${n}`, email: `r18b${n}.${stamp}@e2e.test`, source: "manuel" })),
  ] });
  await page.goto("/dashboard");
  // global : 30 leads / 240 clics = 12,5 % ; rattaché aux campagnes : 10 leads / 200 clics = 5,0 %
  await expect(page.getByText("Taux de conversion (global)")).toBeVisible();
  await expect(page.getByText("12,5 %", { exact: true })).toBeVisible();
  await expect(page.getByText(/rattaché aux campagnes : 5,0 %/)).toBeVisible();
  await expect(page.getByText("Taux de conversion", { exact: true }), "l'ancien libellé ambigu a disparu").toHaveCount(0);
});

// R10 : montants à la française sur les pages concernées. Données de test isolées : base e2e.db dédiée (recréée à chaque exécution), même compte que ci-dessus.
test("R10. montants : format français à deux chiffres (portefeuille, produit, prospect), « — » si absent, coût IA à quatre décimales", async () => {
  await ensureLoggedIn();
  await setOnboardingDone(true);
  const ws = await db.workspace.findFirstOrThrow({ where: { name: U.company } });
  const product = await db.product.create({ data: { workspaceId: ws.id, slug: `r10-${stamp}`, name: "Produit R10" } });
  const prospect = await db.prospect.create({ data: { workspaceId: ws.id, productId: product.id, name: "Prospect R10", dedupeKey: `r10-${stamp}`, source: "Test", collectedAt: new Date() } });
  const ev = { workspaceId: ws.id, productId: product.id, prospectId: prospect.id, occurredAt: new Date() };
  await db.productEvent.create({ data: { ...ev, type: "payment_confirmed", amount: 12.5, currency: "EUR", dedupeKey: `r10-pay-${stamp}` } });
  await db.productEvent.create({ data: { ...ev, type: "demo", amount: null, currency: null, dedupeKey: `r10-demo-${stamp}` } });
  await db.aIGeneration.create({ data: { workspaceId: ws.id, kind: "ad_copy", status: "ok", provider: "test", model: "m", promptTokens: 10, completionTokens: 5, costUsd: 0.0012 } });

  await page.goto("/portfolio");
  await expect(page.getByText(/12,50 EUR/).first()).toBeVisible();
  await expect(page.getByText(/12\.50/)).toHaveCount(0);

  await page.goto(`/products/${product.id}`);
  await expect(page.getByText(/12,50 EUR/).first()).toBeVisible(); // tuile « Payants » et tableau des événements
  await expect(page.getByText(/12\.50/)).toHaveCount(0);
  const rows = page.getByRole("table", { name: "Conversions récentes" }).locator("tbody tr"); // la page contient d'autres tableaux
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "12,50 EUR" })).toHaveCount(1);
  await expect(rows.filter({ hasNotText: "12,50 EUR" })).toContainText("—"); // valeur absente : toujours « — »

  await page.goto(`/prospects/${prospect.id}`);
  await expect(page.getByText(/12,50 EUR/).first()).toBeVisible();
  await expect(page.getByText(/12\.50/)).toHaveCount(0);

  await page.goto("/ai-studio");
  await expect(page.getByText(/≈ 0,0012 \$/)).toBeVisible(); // quatre décimales conservées, dollar conservé
  await expect(page.getByText(/0\.0012/)).toHaveCount(0);
});
