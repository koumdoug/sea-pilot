import { expect, test, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";

// Responsive (mobile / tablette / desktop) et accessibilité de base sur toutes les pages clés : aucun débordement horizontal,
// un seul h1, repère <main>, champs étiquetés, utilisables au clavier.
const db = new PrismaClient({ datasourceUrl: "file:./e2e.db" });
const email = `resp.${Date.now()}@e2e.test`;
const VIEWPORTS = [["mobile", 375, 812], ["tablette", 768, 1024], ["desktop", 1280, 800]] as const;
let pageSlug = "";
let wsSlug = "";

test.describe.serial("responsive & accessibilité", () => {
  test.setTimeout(300_000);
  let page: Page;
  test.beforeAll(async ({ browser }) => {
    page = await (await browser.newContext({ baseURL: "http://localhost:3101" })).newPage();
    await page.goto("/register");
    await page.getByLabel(/^Votre nom/).fill("Resp User");
    await page.getByLabel(/^Nom de votre entreprise/).fill("Responsive SARL");
    await page.getByLabel(/^Adresse e-mail professionnelle/).fill(email);
    await page.getByLabel(/^Mot de passe/).fill("MotDePasse2026");
    await page.getByLabel(/J'accepte les/).check();
    await page.getByRole("button", { name: "Créer mon compte" }).click();
    await expect(page).toHaveURL(/\/onboarding$/);
    const ws = await db.workspace.findFirstOrThrow({ where: { memberships: { some: { user: { email } } } } });
    wsSlug = ws.slug;
    await db.workspace.update({ where: { id: ws.id }, data: { onboardingCompletedAt: new Date(), maxCac: 100, goalLeadsPerMonth: 50 } });
    const workspaceId = ws.id;
    const aud = await db.audience.create({ data: { workspaceId, name: "Audience très longue pour tester le retour à la ligne dans les tableaux étroits", type: "b2c" } });
    const off = await db.offer.create({ data: { workspaceId, name: "Offre avec un nom particulièrement long afin de vérifier la gestion du débordement", price: 100, audienceId: aud.id, status: "active" } });
    const lp = await db.landingPage.create({ data: { workspaceId, name: "Page", slug: "page-resp", status: "published", seoTitle: "Titre SEO de la page", seoDescription: "Description de la page", offerId: off.id, sections: [{ type: "hero", id: "h", headline: "Titre", subheadline: "Sous-titre", ctaLabel: "Go" }, { type: "cta", id: "c", title: "Contact", text: "", ctaLabel: "Envoyer" }, { type: "faq", id: "f", title: "FAQ", items: [{ q: "Q ?", a: "R." }] }] } });
    pageSlug = lp.slug;
    await db.form.create({ data: { workspaceId, landingPageId: lp.id, name: "F", consentText: "Je consens", fields: [{ key: "name", label: "Nom", type: "text", required: true }, { key: "email", label: "E-mail", type: "email", required: true }] } });
    const camp = await db.campaign.create({ data: { workspaceId, name: "Campagne avec un nom vraiment très long pour le test de débordement horizontal", status: "active", budget: 500, offerId: off.id, audienceId: aud.id, landingPageId: lp.id } });
    for (let i = 0; i < 6; i++) await db.lead.create({ data: { workspaceId, name: `Prospect numéro ${i} avec un nom assez long`, email: `p${i}@exemple-de-domaine-long.test`, company: "Entreprise Très Longue SARL & Associés", campaignId: camp.id, status: ["new", "qualified", "contacted", "proposal", "won", "lost"][i], score: 40 + i * 10, qualificationLevel: "warm", value: i === 4 ? 1000 : null, utmSource: "google" } });
    for (let i = 0; i < 10; i++) await db.metric.create({ data: { workspaceId, campaignId: camp.id, platform: "google_ads", date: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - i)), spend: 20 + i, impressions: 1000, clicks: 40, dedupeKey: `r${i}` } });
    await db.followUpSequence.create({ data: { workspaceId, name: "Séquence", steps: [{ day: 0, action: "task", title: "t" }] } });
  });
  test.afterAll(async () => { await page.context().close(); await db.$disconnect(); });

  const PUBLIC = ["/", "/demo", "/login", "/register", "/privacy", "/terms"];
  const APP = ["/dashboard", "/strategy", "/research", "/offers", "/campaigns", "/campaigns/new", "/landing-pages", "/leads", "/leads?new=1", "/crm", "/crm?view=customers", "/crm?view=tasks", "/ai-studio", "/copilot", "/analytics", "/automations", "/integrations", "/settings", "/settings?tab=equipe", "/settings?tab=qualification", "/settings?tab=api", "/settings?tab=confidentialite", "/settings?tab=audit", "/billing"];

  async function audit(path: string, vp: string) {
    const res = await page.goto(path);
    expect(res!.status(), `${path} statut`).toBeLessThan(400);
    // laisse le temps aux composants client de s'hydrater
    await page.waitForLoadState("networkidle");
    const r = await page.evaluate(() => {
      const bad: string[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("input:not([type=hidden]), select, textarea"))) {
        if (el.closest("[aria-hidden='true']")) continue;
        const f = el as HTMLInputElement;
        if (!(f.labels && f.labels.length) && !el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby")) bad.push(`${el.tagName}[name=${el.getAttribute("name")}]`);
      }
      const btnNoName = Array.from(document.querySelectorAll("button, a[href]")).filter((b) => !(b.textContent ?? "").trim() && !b.getAttribute("aria-label") && !b.querySelector("img[alt]")).length;
      return {
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        h1: document.querySelectorAll("h1").length, main: document.querySelectorAll("main").length, lang: document.documentElement.lang, unlabeled: bad, btnNoName,
        title: document.title,
      };
    });
    expect(r.overflow, `${vp} ${path} : débordement horizontal de ${r.overflow}px`).toBeLessThanOrEqual(1);
    expect(r.h1, `${path} : un seul h1`).toBe(1);
    expect(r.main, `${path} : un repère main`).toBe(1);
    expect(r.lang).toBe("fr");
    expect(r.unlabeled, `${path} : champs sans étiquette`).toEqual([]);
    expect(r.btnNoName, `${path} : boutons/liens sans nom accessible`).toBe(0);
    expect(r.title.length, `${path} : title`).toBeGreaterThan(2);
  }

  for (const [vp, w, h] of VIEWPORTS) {
    test(`pages publiques — ${vp} ${w}px`, async () => {
      await page.context().clearCookies();
      await page.setViewportSize({ width: w, height: h });
      for (const p of [...PUBLIC, `/p/${wsSlug}/${pageSlug}`]) await audit(p, vp);
    });
  }

  for (const [vp, w, h] of VIEWPORTS) {
    test(`application — ${vp} ${w}px`, async () => {
      await page.setViewportSize({ width: w, height: h });
      await page.goto("/login");
      if (/\/login/.test(page.url())) {
        await page.getByLabel(/^Adresse e-mail/).fill(email);
        await page.getByLabel(/^Mot de passe/).fill("MotDePasse2026");
        await page.getByRole("button", { name: "Se connecter" }).click();
        await expect(page).toHaveURL(/\/dashboard/);
      }
      for (const p of APP) await audit(p, vp);
      const camp = await db.campaign.findFirstOrThrow({ where: { workspace: { slug: wsSlug } } });
      const lead = await db.lead.findFirstOrThrow({ where: { workspace: { slug: wsSlug } } });
      const lpg = await db.landingPage.findFirstOrThrow({ where: { workspace: { slug: wsSlug } } });
      const off = await db.offer.findFirstOrThrow({ where: { workspace: { slug: wsSlug } } });
      for (const p of [`/campaigns/${camp.id}`, `/leads/${lead.id}`, `/landing-pages/${lpg.id}`, `/offers/${off.id}`]) await audit(p, vp);
    });
  }

  test("navigation mobile : le menu s'ouvre, se ferme et se pilote au clavier", async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/dashboard");
    await expect(page.getByRole("navigation", { name: "Navigation principale" })).toBeHidden(); // tiroir fermé
    await page.getByRole("button", { name: "Ouvrir le menu" }).click();
    const nav = page.getByRole("dialog", { name: "Menu" }).getByRole("navigation", { name: "Navigation principale" });
    await expect(nav).toBeVisible();
    for (const label of ["Dashboard", "Research", "Offers", "Campaigns", "Landing Pages", "Leads", "CRM", "AI Studio", "Analytics", "Automations", "Integrations", "Settings", "Billing"]) await expect(nav.getByRole("link", { name: label })).toBeVisible();
    await nav.getByRole("link", { name: "Leads" }).click();
    await expect(page).toHaveURL(/\/leads/);
    await expect(page.getByRole("dialog", { name: "Menu" })).toBeHidden();
  });

  test("clavier : lien d'évitement et focus visible", async () => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/dashboard");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Aller au contenu" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#contenu$/);
  });
});
