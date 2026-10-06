import { expect, test, type Page } from "@playwright/test";
import { createHmac } from "node:crypto";
import { PrismaClient } from "@prisma/client";

// Parcours complet d'un client : inscription → onboarding → landing page → campagne → lead réel via le formulaire public →
// qualification → CRM → analytics → relances → facturation/essai → API → sécurité (isolation, session, abonnement expiré).
const db = new PrismaClient({ datasourceUrl: "file:./e2e.db" });
const stamp = Date.now();
// Même algorithme que src/lib/crypto.ts (jeton signé HMAC-SHA256) avec le secret du serveur E2E.
const signToken = (payload: string) => { const p = Buffer.from(payload).toString("base64url"); return `${p}.${createHmac("sha256", "e2e-secret-e2e-secret-e2e-secret-0123456789").update(p).digest("base64url")}`; };
const A = { name: "Alice Martin", email: `alice.${stamp}@e2e.test`, password: "MotDePasse2026", company: "Atelier Alice" };
const B = { name: "Bruno Leroy", email: `bruno.${stamp}@e2e.test`, password: "MotDePasse2026", company: "Bureau Bruno" };
const state: { wsSlug?: string; pageSlug?: string; campaignId?: string; leadId?: string; apiKey?: string } = {};

const rx = (s: string) => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s*\\*)?$`);
const field = (p: Page, label: string) => p.getByLabel(rx(label));

async function register(u: typeof A) {
  await page.goto("/register");
  await field(page, "Votre nom").fill(u.name);
  await field(page, "Nom de votre entreprise").fill(u.company);
  await field(page, "Adresse e-mail professionnelle").fill(u.email);
  await field(page, "Mot de passe").fill(u.password);
  await page.getByLabel(/J'accepte les/).check();
  await page.getByRole("button", { name: "Créer mon compte" }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
}

let page: Page;
let request: Page["request"];
test.beforeAll(async ({ browser }) => { page = await (await browser.newContext({ baseURL: "http://localhost:3101", viewport: { width: 1280, height: 800 } })).newPage(); request = page.request; });
test.afterAll(async () => { await page.context().close(); await db.$disconnect(); });

test.describe.serial("parcours client SEA Pilot", () => {
  test("pages publiques : accueil, démo, légales, SEO", async () => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Transformez votre acquisition en système automatisé");
    await expect(page.getByRole("link", { name: "Commencer gratuitement" }).first()).toBeVisible();
    await expect(page).toHaveTitle(/SEA Pilot/);
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /SEA Pilot/);
    await expect(page.locator('meta[property="og:title"]')).toHaveCount(1);
    for (const id of ["#fonctionnement", "#fonctionnalites", "#tarifs", "#faq"]) await expect(page.locator(id)).toHaveCount(1);

    await page.goto("/demo");
    await expect(page.getByText("Données de démonstration").first()).toBeVisible();
    await expect(page.getByText("Santé de l'acquisition")).toBeVisible();
    await expect(page.getByText("Faits fournis", { exact: false }).first().or(page.getByText("Fait fourni").first())).toBeVisible();

    for (const p of ["/privacy", "/terms"]) { await page.goto(p); await expect(page.getByRole("heading", { level: 1 })).toBeVisible(); }
    expect((await request.get("/robots.txt")).ok()).toBe(true);
    expect(await (await request.get("/sitemap.xml")).text()).toContain("/demo");
  });

  test("routes protégées : redirection vers la connexion, API sans session refusée", async () => {
    for (const p of ["/dashboard", "/leads", "/settings", "/billing"]) {
      await page.goto(p);
      await expect(page).toHaveURL(/\/login/);
    }
    expect((await request.get("/api/export")).status()).toBe(401);
    expect((await request.post("/api/v1/leads", { data: { name: "x", email: "x@y.com" } })).status()).toBe(401);
  });

  test("inscription : validation, puis création du compte", async () => {
    await page.goto("/register");
    await field(page, "Votre nom").fill("A");
    await field(page, "Nom de votre entreprise").fill("X");
    await field(page, "Adresse e-mail professionnelle").fill("pas-un-email");
    await field(page, "Mot de passe").fill("court");
    await page.getByLabel(/J'accepte les/).check();
    await page.getByRole("button", { name: "Créer mon compte" }).click();
    await expect(page).toHaveURL(/\/register/); // la validation navigateur bloque l'envoi
    await register(A);
  });

  test("onboarding : 4 étapes puis fiche stratégie générée", async () => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/onboarding/); // onboarding non terminé : redirection
    await field(page, "Secteur d'activité").fill("Rénovation");
    await field(page, "Taille de l'entreprise (personnes)").selectOption("2-10");
    await field(page, "Description de l'activité").fill("Rénovation de salles de bain clé en main pour particuliers.");
    await page.getByRole("button", { name: /Continuer/ }).click();
    await field(page, "Produit ou service").fill("Rénovation de salle de bain");
    await field(page, "Prix (devise ci-dessus)").fill("5000");
    await field(page, "Marge approximative (%)").fill("25");
    await field(page, "Zone géographique desservie").fill("Lyon");
    await field(page, "Avantages (un par ligne)").fill("Devis gratuit\nArtisans certifiés");
    await page.getByRole("button", { name: /Continuer/ }).click();
    await field(page, "Type de client").fill("Propriétaires de maison");
    await field(page, "Objections fréquentes (une par ligne)").fill("Prix\nDélais");
    await page.getByRole("button", { name: /Continuer/ }).click();
    await field(page, "Leads par mois").fill("100");
    await field(page, "Ventes par mois").fill("10");
    await field(page, "Budget publicitaire mensuel").fill("1500");
    await field(page, "Coût d'acquisition client maximal").fill("130");
    await field(page, "Objectif de chiffre d'affaires mensuel").fill("12000");
    await page.getByRole("button", { name: "Générer ma stratégie" }).click();
    await expect(page).toHaveURL(/\/strategy/);
    await expect(page.getByRole("heading", { name: "Fiche stratégie d'acquisition" })).toBeVisible();
    await expect(page.getByText("Taux lead → vente nécessaire")).toBeVisible();
    await expect(page.getByText("Configuration requise").first()).toBeVisible(); // IA non configurée : annoncé clairement
    await expect(page.getByText("Rénovation de salle de bain").first()).toBeVisible();
  });

  test("dashboard : état vide honnête, aucune donnée inventée", async () => {
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Est-ce que mon acquisition fonctionne ?" })).toBeVisible();
    await expect(page.getByText("Données insuffisantes").first()).toBeVisible();
    await expect(page.getByText("Pas encore de données sur la période")).toBeVisible();
    await expect(page.getByText("Essai gratuit :")).toBeVisible();
    const cpl = page.locator("div", { hasText: /^CPL—/ }).first();
    await expect(cpl).toBeVisible();
  });

  test("landing page : création, SEO, publication", async () => {
    await page.goto("/landing-pages");
    await field(page, "Nom de la page").fill("Devis salle de bain Lyon");
    await field(page, "Partir d'une offre").selectOption({ label: "Rénovation de salle de bain" });
    await page.getByRole("button", { name: "Créer la page" }).click();
    await expect(page).toHaveURL(/\/landing-pages\/[a-z0-9]+$/);
    await expect(page.getByRole("heading", { name: "Devis salle de bain Lyon" })).toBeVisible();
    await field(page, "Meta description").fill("Rénovation de salle de bain à Lyon : devis gratuit sous 48 h.");
    // le formulaire expose les champs qualifiants : budget et ville
    await page.getByLabel("Budget estimé").check();
    await page.getByLabel("Ville", { exact: true }).check();
    await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await expect(page.getByText("Page enregistrée.")).toBeVisible();
    await page.getByRole("button", { name: "Publier" }).first().click();
    await expect(page.getByText("Publiée", { exact: true }).first()).toBeVisible();
    const ws = await db.workspace.findFirstOrThrow({ where: { name: A.company.length ? { not: "" } : undefined, memberships: { some: { user: { email: A.email } } } } });
    const lp = await db.landingPage.findFirstOrThrow({ where: { workspaceId: ws.id } });
    state.wsSlug = ws.slug; state.pageSlug = lp.slug;
    expect(lp.status).toBe("published");
  });

  test("campagne : Campaign Builder en 10 étapes jusqu'au statut prête puis active", async () => {
    await page.goto("/campaigns/new");
    await field(page, "Nom de la campagne").fill("Recherche Google Lyon");
    await page.getByRole("button", { name: "Continuer" }).click();
    await expect(page).toHaveURL(/build\?step=2/);
    state.campaignId = page.url().match(/campaigns\/([a-z0-9]+)\/build/)![1];
    const next = () => page.getByRole("button", { name: /Enregistrer et continuer|Étape suivante/ }).click();
    await next(); // 2. audience (préremplie par l'onboarding)
    await expect(page).toHaveURL(/step=3/);
    await next(); // 3. offre
    await expect(page.getByRole("heading", { name: "4. Message" })).toBeVisible();
    await expect(page.getByText("Configuration requise").first()).toBeVisible(); // IA non configurée : message manuel possible
    await field(page, "Angle").fill("Devis gratuit sous 48 h");
    await field(page, "Appel à l'action (CTA)").fill("Demander mon devis");
    await next();
    await next(); // 5. plateforme (Google Ads)
    await expect(page.getByRole("heading", { name: "6. Budget et calendrier" })).toBeVisible();
    await next(); // 6. budget prérempli depuis l'onboarding
    await field(page, "Page de destination").selectOption({ index: 1 });
    await next();
    await expect(page.getByRole("heading", { name: "8. Créatifs" })).toBeVisible();
    await next();
    await expect(page.getByRole("heading", { name: "9. Tracking" })).toBeVisible();
    await expect(page.locator("code").filter({ hasText: "utm_campaign=" }).first()).toContainText(state.campaignId!);
    await next();
    await expect(page.getByRole("heading", { name: "10. Lancement" })).toBeVisible();
    await page.getByRole("button", { name: "Marquer comme prête" }).click();
    await page.getByRole("button", { name: "Activer la campagne" }).click();
    await expect.poll(async () => (await db.campaign.findUniqueOrThrow({ where: { id: state.campaignId! } })).status).toBe("active");
    // le lien campagne ↔ page pour l'attribution
    await db.landingPage.updateMany({ where: { slug: state.pageSlug }, data: { campaignId: state.campaignId! } });
  });

  test("formulaire public : un vrai visiteur laisse un lead avec ses UTM (validation, succès)", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`/p/${state.wsSlug}/${state.pageSlug}?utm_source=google&utm_medium=cpc&utm_campaign=${state.campaignId}&utm_term=devis&utm_content=a`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Rénovation de salle de bain");
    await expect(page).toHaveTitle(/Devis salle de bain Lyon/);
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(1);
    await expect(page.locator('meta[property="og:title"]')).toHaveCount(1);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /index/);
    await expect.poll(async () => db.analyticsEvent.count({ where: { type: "page_view", landingPage: { slug: state.pageSlug } } })).toBe(1); // visite mesurée sans cookie

    await page.getByRole("button", { name: "Envoyer" }).click(); // champs obligatoires vides : le navigateur bloque
    await expect(page.getByText("Merci !", { exact: true })).toHaveCount(0);
    await field(page, "Nom complet").fill("Marie Durand");
    await field(page, "E-mail").fill("marie.durand@client.test");
    await field(page, "Téléphone").fill("06 12 34 56 78");
    await field(page, "Budget estimé").fill("6000");
    await field(page, "Ville").fill("Lyon");
    await field(page, "Décrivez votre besoin").fill("Nous voulons rénover notre salle de bain, c'est urgent : devis cette semaine svp.");
    await page.getByLabel(/informations et offres commerciales/).check();
    await page.getByRole("button", { name: "Envoyer" }).click();
    await expect(page.getByText("Merci !", { exact: true })).toBeVisible();
    await ctx.close();

    const lead = await db.lead.findFirstOrThrow({ where: { email: "marie.durand@client.test" } });
    state.leadId = lead.id;
    expect([lead.utmSource, lead.utmMedium, lead.utmCampaign, lead.utmTerm, lead.utmContent]).toEqual(["google", "cpc", state.campaignId, "devis", "a"]);
    expect(lead.campaignId).toBe(state.campaignId);
    expect(lead.consentMarketing).toBe(true);
    expect(lead.customFields).toMatchObject({ budget: "6000", ville: "Lyon" });
  });

  test("lead + qualification : faits / inférences, prochaine action, statut", async () => {
    await page.goto("/leads");
    await expect(page.getByRole("link", { name: "Marie Durand" })).toBeVisible();
    await page.getByRole("link", { name: "Marie Durand" }).click();
    await expect(page.getByRole("heading", { name: "Marie Durand" })).toBeVisible();
    await expect(page.getByText("Prochaine action recommandée")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Faits fournis par le prospect" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Inférences (non vérifiées)" })).toBeVisible();
    await expect(page.getByText("Fait fourni").first()).toBeVisible();
    await expect(page.getByText("google", { exact: true }).first()).toBeVisible(); // utm_source conservé
    await expect(page.getByText("Analyse IA : configuration requise côté serveur.")).toBeVisible();
    await page.getByRole("button", { name: "Requalifier" }).click();
    await expect.poll(() => db.aIQualification.count({ where: { leadId: state.leadId } })).toBeGreaterThanOrEqual(2);

    // notes et conversation
    await field(page, "Contenu").fill("Appel passé : rendez-vous pris jeudi.");
    await page.getByRole("button", { name: "Ajouter", exact: true }).first().click();
    await expect(page.getByText("Appel passé : rendez-vous pris jeudi.")).toBeVisible();
    // tâche
    await field(page, "Nouvelle tâche").fill("Préparer le devis");
    await page.getByRole("button", { name: "Ajouter", exact: true }).last().click();
    await expect(page.getByText("Préparer le devis")).toBeVisible();
  });

  test("CRM : pipeline, passage à gagné avec montant → client et revenu", async () => {
    await page.goto(`/leads/${state.leadId}`);
    await field(page, "Statut").selectOption("proposal");
    await page.getByRole("button", { name: "Mettre à jour" }).click();
    await expect(page.getByText("Statut mis à jour.")).toBeVisible();
    await page.goto("/crm");
    await expect(page.getByRole("region", { name: "Pipeline commercial" })).toContainText("Marie Durand");
    await page.goto(`/leads/${state.leadId}`);
    await field(page, "Statut").selectOption("won");
    await page.getByLabel(/Montant gagné/).fill("5400");
    await page.getByRole("button", { name: "Mettre à jour" }).click();
    await expect(page.getByText("Statut mis à jour.")).toBeVisible();
    await page.goto("/crm?view=customers");
    await expect(page.getByRole("link", { name: "Marie Durand" })).toBeVisible();
    await expect(page.getByText(/5\s?400/).first()).toBeVisible();
  });

  test("analytics : dépenses saisies → CPL, CAC, ROAS, ROI calculés ; recommandations", async () => {
    await page.goto(`/campaigns/${state.campaignId}`);
    await field(page, "Dépense (EUR)").fill("300");
    await field(page, "Impressions").fill("20000");
    await field(page, "Clics").fill("400");
    await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
    await expect(page.getByText("Données du jour enregistrées.")).toBeVisible();
    await page.goto("/analytics");
    const tile = (label: string) => page.locator("div", { has: page.locator(`p:text-is("${label}")`) }).filter({ has: page.locator("p.text-2xl") }).last();
    await expect(tile("CPL")).toContainText(/300/); // 300 € / 1 lead
    await expect(tile("CAC")).toContainText(/300/);
    await expect(tile("ROAS")).toContainText("18.00"); // 5400 / 300
    await expect(tile("ROI")).toContainText(/1\s?700/); // (5400-300)/300 = 1700 %
    await expect(page.getByRole("heading", { name: "Recommandations" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Détail par campagne" })).toBeVisible();
    // filtres
    await page.goto(`/analytics?campaign=${state.campaignId}&range=7`);
    await expect(tile("Leads")).toContainText("1");
    await page.goto("/dashboard");
    await expect(page.getByText("Santé de l'acquisition")).toBeVisible();
    await expect(page.getByText("Données insuffisantes")).toHaveCount(0);
  });

  test("automatisations : séquence J0-J14, inscription, exécution — jamais d'e-mail réel sans configuration", async () => {
    await page.goto("/leads?new=1#nouveau");
    await field(page, "Nom").first().fill("Paul Nouveau");
    await field(page, "E-mail").first().fill("paul@client.test");
    await page.getByRole("button", { name: "Créer le lead" }).click();
    await expect(page.getByRole("heading", { name: "Paul Nouveau" })).toBeVisible();
    const paulId = page.url().split("/").pop()!;

    await page.goto("/automations");
    await expect(page.getByText("Envoi d'e-mails : configuration requise")).toBeVisible();
    await page.getByRole("button", { name: "Créer la séquence recommandée" }).click();
    await expect(page.getByText("Relance standard J0 · J1 · J3 · J7 · J14").first()).toBeVisible();

    await page.goto(`/leads/${paulId}`);
    await field(page, "Inscrire à une séquence").selectOption({ index: 1 });
    await page.getByRole("button", { name: "Inscrire", exact: true }).click();
    await expect(page.getByText(/étape\(s\) planifiée\(s\)/)).toBeVisible();
    await page.goto("/automations");
    await page.getByRole("button", { name: /Exécuter les relances échues/ }).click();
    await expect(page.getByText(/relance\(s\) traitée\(s\)/)).toBeVisible();
    const fu = await db.followUp.findMany({ where: { leadId: paulId }, orderBy: { stepIndex: "asc" } });
    expect(fu[0].status).toBe("blocked"); // J0 e-mail : pas d'envoi automatique autorisé → tâche manuelle
    expect(await db.emailLog.count()).toBe(0);
    expect(await db.task.count({ where: { leadId: paulId, source: "followup" } })).toBe(1);
    expect(fu.filter((f) => f.status === "pending")).toHaveLength(4);
  });

  test("intégrations : « Configuration requise » affichée, jamais de fausse connexion", async () => {
    await page.goto("/integrations");
    for (const name of ["Google Analytics 4", "Meta Ads (Facebook / Instagram)", "Google Ads", "TikTok Ads"]) {
      const card = page.getByRole("heading", { name, exact: true }).locator("xpath=ancestor::section[1]");
      await expect(card.getByText("Configuration requise").first()).toBeVisible();
      await expect(card.getByText("Connecté", { exact: true })).toHaveCount(0);
    }
    await expect(page.getByRole("heading", { name: "E-mail (Resend)" })).toBeVisible();
    await expect(page.getByLabel(/Clé API Resend/)).toBeVisible();
    // la route OAuth d'un fournisseur non configuré renvoie une erreur explicite
    await page.goto("/api/integrations/meta_ads/connect");
    await expect(page).toHaveURL(/integrations\?error=needs_config/);
    await expect(page.getByText(/n'est pas configuré sur le serveur/)).toBeVisible();
  });

  test("facturation : essai, Stripe non configuré = pas de faux paiement, changement de plan d'essai", async () => {
    await page.goto("/billing");
    await expect(page.getByText("Essai gratuit", { exact: true })).toBeVisible();
    await expect(page.getByText("Paiement : configuration requise")).toBeVisible();
    await expect(page.getByRole("button", { name: /Souscrire/ })).toHaveCount(0);
    await page.getByRole("button", { name: "Essayer ce plan" }).first().click();
    await expect.poll(async () => (await db.subscription.findFirstOrThrow({ where: { workspace: { slug: state.wsSlug } } })).plan).not.toBe("starter");
    await expect(page.getByRole("progressbar").first()).toBeVisible();
  });

  test("réglages : clé API créée, utilisée pour envoyer un lead, révoquée", async () => {
    await page.goto("/settings?tab=api");
    await field(page, "Nom de la clé").fill("CRM externe");
    await page.getByRole("button", { name: "Créer la clé" }).click();
    const key = (await page.getByTestId("new-api-key").textContent())!.trim();
    expect(key).toMatch(/^sp_/);
    state.apiKey = key;
    const ok = await request.post("/api/v1/leads", { headers: { authorization: `Bearer ${key}` }, data: { name: "Lead API", email: "api@client.test", utm_source: "crm" } });
    expect(ok.status()).toBe(201);
    await page.reload();
    await expect(page.getByText(key)).toHaveCount(0); // la clé n'est plus jamais affichée
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Révoquer" }).click();
    await expect.poll(async () => (await request.post("/api/v1/leads", { headers: { authorization: `Bearer ${key}` }, data: { name: "x", email: "x2@client.test" } })).status()).toBe(401);
  });

  test("RGPD : export JSON, désinscription publique par lien signé, effacement", async () => {
    await page.goto("/settings?tab=confidentialite");
    const res = await page.request.get("/api/export?scope=workspace");
    expect(res.ok()).toBe(true);
    const exp = await res.json();
    expect(exp.leads.some((l: { email: string }) => l.email === "marie.durand@client.test")).toBe(true);
    expect(JSON.stringify(exp)).not.toContain("passwordHash");

    const lead = await db.lead.findFirstOrThrow({ where: { email: "marie.durand@client.test" } });
    const token = signToken(`u|${lead.workspaceId}|${lead.id}`);
    await page.context().clearCookies();
    await page.goto(`/unsubscribe/${token}`);
    await page.getByRole("button", { name: "Me désinscrire" }).click();
    await expect(page.getByText(/ne recevrez plus d'e-mails commerciaux/)).toBeVisible();
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead.id } })).unsubscribedAt).not.toBeNull();
    await page.goto("/unsubscribe/jeton-falsifie");
    await expect(page.getByText("invalide")).toBeVisible();
    expect((await request.post(`/api/unsubscribe/jeton-falsifie`)).status()).toBe(400);
  });

  test("sécurité : un second client ne voit jamais les données du premier", async () => {
    await register(B);
    await db.workspace.updateMany({ where: { memberships: { some: { user: { email: B.email } } } }, data: { onboardingCompletedAt: new Date() } }); // onboarding de B terminé (hors sujet ici)
    await page.goto(`/leads/${state.leadId}`);
    await expect(page.getByText("Page introuvable")).toBeVisible(); // 404 : l'existence même du lead n'est pas révélée
    await page.goto(`/campaigns/${state.campaignId}`);
    await expect(page.getByText("Page introuvable")).toBeVisible();
    await page.goto(`/p/${state.wsSlug}/${state.pageSlug}?preview=1`);
    await expect(page).toHaveURL(/\/p\//); // page publique : visible car publiée (c'est son rôle)
    // brouillon d'un autre espace : invisible
    await db.landingPage.updateMany({ where: { slug: state.pageSlug }, data: { status: "draft" } });
    await page.goto(`/p/${state.wsSlug}/${state.pageSlug}?preview=1`);
    await expect(page.getByText("Page introuvable")).toBeVisible();
    await db.landingPage.updateMany({ where: { slug: state.pageSlug }, data: { status: "published" } });
    // l'espace B est vide
    await page.goto("/leads");
    await expect(page.getByText("Marie Durand")).toHaveCount(0);
    await expect(page.getByText("Aucun lead pour le moment")).toBeVisible();
    // cookie d'espace forgé vers l'espace de A : ignoré (adhésion revérifiée côté serveur)
    const wsA = await db.workspace.findFirstOrThrow({ where: { slug: state.wsSlug } });
    await page.context().addCookies([{ name: "seapilot_ws", value: wsA.id, url: "http://localhost:3101" }]);
    await page.goto("/leads");
    await expect(page.getByText("Marie Durand")).toHaveCount(0);
  });

  test("abonnement : essai expiré = accès suspendu hors facturation ; session expirée = reconnexion", async () => {
    await page.goto("/dashboard");
    await db.subscription.updateMany({ where: { workspace: { memberships: { some: { user: { email: B.email } } } } }, data: { trialEndsAt: new Date(Date.now() - 86_400_000) } });
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/billing\?blocked=1/);
    await expect(page.getByText("Accès suspendu")).toBeVisible();
    await expect(page.getByText("Votre essai gratuit est terminé").first()).toBeVisible();
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Réglages" })).toBeVisible(); // réglages/export restent accessibles
    // session invalidée (utilisateur supprimé) → reconnexion
    await db.user.updateMany({ where: { email: B.email }, data: { deletedAt: new Date() } });
    await page.goto("/leads");
    await expect(page).toHaveURL(/\/login\?expired=1/);
    await expect(page.getByText("Votre session a expiré")).toBeVisible();
  });

  test("déconnexion", async () => {
    await page.goto("/login");
    await field(page, "Adresse e-mail").fill(A.email);
    await field(page, "Mot de passe").fill(A.password);
    await page.getByRole("button", { name: "Se connecter" }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    await page.getByRole("button", { name: "Se déconnecter" }).first().click();
    await expect(page).toHaveURL(/\/login/);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
    // mauvais mot de passe
    await field(page, "Adresse e-mail").fill(A.email);
    await field(page, "Mot de passe").fill("MauvaisMotDePasse1");
    await page.getByRole("button", { name: "Se connecter" }).click();
    await expect(page.getByText("Identifiants invalides.")).toBeVisible();
  });
});
