import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

// Suivi éditorial (/editorial) dans un vrai navigateur : parcours authentifié, données 100 % synthétiques, base SQLite e2e dédiée.
// Couvre : rendu sans erreur JS, liste vide, création/persistance, modification, associations, transitions, publication confirmée,
// file de travail, calendrier (lundi), sans échéance, lecture seule (côté serveur), mobile et accessibilité de base. Aucune IA.
const db = new PrismaClient({ datasourceUrl: "file:./e2e.db" });
const stamp = Date.now();
const owner = { name: "Edith Éditrice", company: "Atelier Édito", email: `edito.${stamp}@e2e.test`, password: "MotDePasse2026" };
const viewer = { name: "Victor Lecteur", company: "Lecture Seule", email: `viewer.${stamp}@e2e.test`, password: "MotDePasse2026" };
const S: { ws: string; pageId: string; pageName: string; productId: string; productName: string; foreignPageId: string } = { ws: "", pageId: "", pageName: "Page édito synthétique", productId: "", productName: "SaaS édito synthétique", foreignPageId: "" };
const TITLE = "Guide SEO synthétique";

// Les inscriptions par l'interface sont limitées à 5 par heure et par adresse (rate limit du serveur) et les autres specs en consomment déjà 5 :
// les comptes de cette spec sont donc créés directement dans la base e2e, puis la connexion passe par le vrai formulaire de connexion.
async function signIn(browser: Browser, u: typeof owner, membership: { workspaceId?: string; role: string }) {
  const user = await db.user.create({ data: { email: u.email, name: u.name, passwordHash: await bcrypt.hash(u.password, 4) } });
  let workspaceId = membership.workspaceId;
  if (!workspaceId) {
    workspaceId = (await db.workspace.create({ data: { name: u.company, slug: `edito-ws-${stamp}`, onboardingCompletedAt: new Date(), subscription: { create: { plan: "starter", status: "trialing", trialEndsAt: new Date(Date.now() + 14 * 86_400_000) } } } })).id;
  }
  await db.membership.create({ data: { userId: user.id, workspaceId, role: membership.role } });
  const ctx = await browser.newContext({ baseURL: "http://localhost:3101", viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  await p.goto("/login");
  await p.getByLabel(/^Adresse e-mail/).fill(u.email);
  await p.getByLabel(/^Mot de passe/).fill(u.password);
  await p.getByRole("button", { name: "Se connecter" }).click();
  await expect(p).toHaveURL(/\/dashboard/);
  return { ctx, page: p, workspaceId };
}const create = (p: Page) => p.locator("section", { has: p.getByRole("heading", { name: "Nouveau contenu" }) });
const article = (p: Page, title: string) => p.locator("article", { has: p.getByRole("heading", { name: title, exact: true }) });
async function fillFields(scope: Locator, f: { title?: string; priority?: string; due?: string; page?: string; product?: string }) {
  if (f.title !== undefined) await scope.getByLabel(/^Titre/).fill(f.title);
  if (f.priority) await scope.getByLabel(/^Priorité/).selectOption({ label: f.priority });
  if (f.due !== undefined) await scope.getByLabel("Échéance").fill(f.due);
  if (f.page) await scope.getByLabel("Landing page associée").selectOption({ label: f.page });
  if (f.product) await scope.getByLabel("Produit associé").selectOption({ label: f.product });
}
async function add(p: Page, f: Parameters<typeof fillFields>[1]) {
  await fillFields(create(p), f);
  await create(p).getByRole("button", { name: "Ajouter le contenu" }).click();
  // Le message de succès d'un ajout précédent reste affiché : on attend donc l'apparition RÉELLE du nouvel article.
  await expect(article(p, f.title!)).toBeVisible();
  await expect(create(p).getByLabel(/^Titre/)).toHaveValue("");
}

let page: Page;
const errors: string[] = [];
test.beforeAll(async ({ browser }) => {
  const o = await signIn(browser, owner, { role: "owner" });
  page = o.page;
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text()}`); });
  const ws = { id: o.workspaceId };
  S.ws = ws.id;
  S.pageId = (await db.landingPage.create({ data: { workspaceId: ws.id, name: S.pageName, slug: `edito-${stamp}`, status: "published", seoTitle: S.pageName, sections: [] } })).id;
  S.productId = (await db.product.create({ data: { workspaceId: ws.id, name: S.productName, slug: `edito-${stamp}` } })).id;
  // Espace étranger (aucun membre) : sa page ne doit JAMAIS pouvoir être associée par un formulaire falsifié.
  const other = await db.workspace.create({ data: { name: "Espace étranger synthétique", slug: `etranger-${stamp}` } });
  S.foreignPageId = (await db.landingPage.create({ data: { workspaceId: other.id, name: "Page étrangère secrète", slug: `secret-${stamp}`, status: "draft", sections: [] } })).id;
});
test.afterAll(async () => { await page.context().close(); await db.$disconnect(); });

test.describe.serial("suivi éditorial — navigateur", () => {
  test("ouverture : navigation, rendu, liste vide, aucune erreur JavaScript", async () => {
    await page.goto("/dashboard");
    await page.getByRole("link", { name: "Éditorial" }).first().click();
    await expect(page).toHaveURL(/\/editorial$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Suivi éditorial");
    await expect(page.getByRole("link", { name: "Éditorial" }).first()).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("Aucun contenu éditorial pour le moment")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Nouveau contenu" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("création invalide : titre blanc refusé côté serveur, rien n'est créé", async () => {
    await fillFields(create(page), { title: "   " });
    await create(page).getByRole("button", { name: "Ajouter le contenu" }).click();
    await expect(create(page).getByRole("alert").first()).toBeVisible();
    await expect(create(page).getByText("Titre requis")).toBeVisible();
    expect(await db.contentItem.count({ where: { workspaceId: S.ws } })).toBe(0);
  });

  test("création avec associations autorisées, persistance après rechargement", async () => {
    await add(page, { title: TITLE, priority: "Haute", due: "2020-01-06", page: S.pageName, product: S.productName });
    await page.reload();
    const a = article(page, TITLE);
    await expect(a).toBeVisible();
    await expect(a.getByText("Idée", { exact: true })).toBeVisible();
    await expect(a.getByText("Priorité haute")).toBeVisible();
    await expect(a.getByText("En retard")).toBeVisible(); // échéance passée, non publié
    await expect(a.locator("p", { hasText: `Produit : ${S.productName}` })).toBeVisible();
    await expect(a.getByRole("link", { name: S.pageName })).toBeVisible();
    await expect(a.getByRole("link", { name: "Ouvrir le brief de la page" })).toHaveAttribute("href", `/landing-pages/${S.pageId}/brief`);
    const row = await db.contentItem.findFirstOrThrow({ where: { workspaceId: S.ws, title: TITLE } });
    expect(row).toMatchObject({ state: "idea", priority: "high", landingPageId: S.pageId, productId: S.productId });
  });

  test("association à une page d'un autre espace (formulaire falsifié) : refusée", async () => {
    await create(page).getByLabel("Landing page associée").evaluate((el, v) => { const s = el as HTMLSelectElement; const o = document.createElement("option"); o.value = v; o.text = "falsifiée"; s.add(o); s.value = v; }, S.foreignPageId);
    await fillFields(create(page), { title: "Tentative falsifiée" });
    await create(page).getByRole("button", { name: "Ajouter le contenu" }).click();
    await expect(create(page).getByText("Landing page introuvable dans cet espace de travail.")).toBeVisible();
    await expect(page.getByText("Page étrangère secrète")).toHaveCount(0);
    expect(await db.contentItem.count({ where: { workspaceId: S.ws, title: "Tentative falsifiée" } })).toBe(0);
  });

  test("modification du titre, de la priorité et de l'échéance", async () => {
    const a = article(page, TITLE);
    await a.getByText("Modifier", { exact: true }).click();
    await fillFields(a, { title: `${TITLE} v2`, priority: "Basse", due: "2020-01-14" });
    await a.getByRole("button", { name: "Enregistrer" }).click();
    // Le titre change : l'article est retrouvé par son NOUVEAU titre (le message de succès reste affiché dans le même formulaire).
    await expect(article(page, `${TITLE} v2`).getByText("Contenu mis à jour.")).toBeVisible();
    await page.reload();
    const b = article(page, `${TITLE} v2`);
    await expect(b.getByText("Priorité basse")).toBeVisible();
    await expect(b.getByText("14 janv. 2020")).toBeVisible();
  });

  test("transitions d'état, puis publication impossible sans confirmation explicite", async () => {
    const t = `${TITLE} v2`;
    for (const [btn, label] of [[/Brief à préparer →/, "Brief à préparer"], [/Prêt à rédiger →/, "Prêt à rédiger"], [/En rédaction →/, "En rédaction"]] as const) {
      await article(page, t).getByRole("button", { name: btn }).click();
      await expect(article(page, t).getByText(label, { exact: true }).first()).toBeVisible();
    }
    const a = article(page, t);
    await a.getByText("Marquer comme publié…").click();
    const box = a.getByLabel(/Je confirme que ce contenu est publié/);
    await expect(box).toHaveAttribute("required", "");
    // Même en contournant la contrainte du navigateur, le SERVEUR refuse.
    await box.evaluate((el) => (el as HTMLInputElement).removeAttribute("required"));
    await a.getByRole("button", { name: "Confirmer la publication" }).click();
    await expect(a.getByText(/confirmation explicite/)).toBeVisible();
    expect((await db.contentItem.findFirstOrThrow({ where: { workspaceId: S.ws, title: t } })).state).toBe("writing");
  });

  test("publication confirmée : section Publiés, URL, résultats honnêtes ; « Publié » sans retour possible", async () => {
    const t = `${TITLE} v2`;
    const a = article(page, t);
    await a.getByLabel(/Je confirme que ce contenu est publié/).check();
    await a.getByLabel(/URL de publication/).fill("https://exemple.test/guide");
    await a.getByRole("button", { name: "Confirmer la publication" }).click();
    await expect(page.getByRole("heading", { name: "Publiés" })).toBeVisible();
    const p = article(page, t);
    await expect(p.getByText(/Publication confirmée le/)).toBeVisible();
    await expect(p.getByRole("link", { name: "https://exemple.test/guide" })).toHaveAttribute("rel", /noopener/);
    await expect(p.getByText("Aucune visite mesurée sur la landing page rattachée.")).toBeVisible();
    await expect(p.getByRole("button", { name: /←|→/ })).toHaveCount(0); // règle existante : « Publié » est terminal
    const row = await db.contentItem.findFirstOrThrow({ where: { workspaceId: S.ws, title: t } });
    expect(row.state).toBe("published"); expect(row.publishedConfirmedAt).not.toBeNull(); expect(row.publishedUrl).toBe("https://exemple.test/guide");
  });

  test("file de travail, calendrier hebdomadaire (lundi) et contenus sans échéance", async () => {
    await add(page, { title: "Sans date", priority: "Haute" });
    await add(page, { title: "Futur basse", priority: "Basse", due: "2099-03-04" });
    await add(page, { title: "Retard moyenne", priority: "Moyenne", due: "2020-02-03" });
    await add(page, { title: "Futur haute", priority: "Haute", due: "2099-03-05" });
    await page.reload();
    const queue = page.locator("section", { has: page.getByRole("heading", { name: "File de travail" }) });
    await expect(queue.locator("article h3")).toHaveCount(4);
    const titles = await queue.locator("article h3").allTextContents();
    expect(titles).toEqual(["Retard moyenne", "Futur haute", "Sans date", "Futur basse"]);
    const cal = page.locator("section", { has: page.getByRole("heading", { name: "Calendrier hebdomadaire" }) });
    await expect(cal.getByRole("heading", { name: "Semaine du lundi 3 févr. 2020" })).toBeVisible();
    await expect(cal.getByRole("heading", { name: "Semaine du lundi 2 mars 2099" })).toBeVisible(); // 4 et 5 mars 2099 : même semaine, lundi 2 mars
    await expect(cal.getByText("Sans date")).toHaveCount(0);
    await expect(page.locator("section", { has: page.getByRole("heading", { name: "Sans échéance" }) }).getByText("Sans date")).toBeVisible();
    await expect(page.getByText("Publiés", { exact: true }).first()).toBeVisible();
  });

  test("suppression : confirmation puis disparition (propriétaire)", async () => {
    page.once("dialog", (d) => d.accept());
    await article(page, "Futur basse").getByRole("button", { name: "Supprimer" }).click();
    await expect(article(page, "Futur basse")).toHaveCount(0);
    expect(await db.contentItem.count({ where: { workspaceId: S.ws, title: "Futur basse" } })).toBe(0);
  });

  test("aucune génération IA automatique", async () => {
    expect(await db.aIGeneration.count({ where: { workspaceId: S.ws } })).toBe(0);
  });

  test("rendu mobile et accessibilité de base", async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/editorial");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.locator("main")).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const unlabeled = await page.evaluate(() => [...document.querySelectorAll("main input:not([type=hidden]), main select, main textarea")].filter((el) => {
      const e = el as HTMLInputElement; return !(e.labels && e.labels.length) && !e.getAttribute("aria-label");
    }).length);
    expect(unlabeled).toBe(0);
    // Cibles tactiles : minimum 36 px, comme les boutons « sm » du projet (min-h-9).
    const tiny = await page.evaluate(() => [...document.querySelectorAll("main button, main summary")].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.height < 36; }).length);
    expect(tiny).toBe(0);
    // Clavier : un champ du formulaire de création reçoit le focus par Tab depuis le titre.
    await create(page).getByLabel(/^Titre/).focus();
    await page.keyboard.press("Tab");
    await expect(create(page).getByLabel(/^Priorité/)).toBeFocused();
    await page.setViewportSize({ width: 1280, height: 800 });
    expect(errors).toEqual([]);
  });

  test("lecteur : consultation seule (interface) ; le refus serveur est prouvé dans editorial-service.test.ts", async ({ browser }) => {
    const v = await signIn(browser, viewer, { workspaceId: S.ws, role: "viewer" });
    await v.page.goto("/editorial");
    await expect(v.page.getByRole("heading", { level: 1 })).toHaveText("Suivi éditorial");
    await expect(v.page.getByText("Votre rôle permet de consulter le suivi éditorial, pas de le modifier.")).toBeVisible();
    await expect(v.page.getByRole("heading", { name: "Nouveau contenu" })).toHaveCount(0);
    await expect(v.page.getByRole("button", { name: /Supprimer|Enregistrer|→|←|Confirmer la publication/ })).toHaveCount(0);
    await expect(v.page.getByText("Modifier", { exact: true })).toHaveCount(0);
    await expect(article(v.page, "Futur haute")).toBeVisible();
    // Le refus d'écriture côté serveur (rôle viewer) est prouvé par tests/editorial-service.test.ts ; ici on vérifie seulement que rien n'a changé.
    const row = await db.contentItem.findFirstOrThrow({ where: { workspaceId: S.ws, title: "Futur haute" } });
    expect(row.state).toBe("idea");
    await v.ctx.close();
  });
});
