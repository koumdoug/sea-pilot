// Jeu de données de DÉMONSTRATION : crée un espace « Demo Workspace » clairement marqué (isDemo = true).
// Les chiffres sont fictifs et reconnaissables ; ils ne se mélangent jamais aux données réelles d'un client.
//   npm run seed          (refuse de s'exécuter en production sauf SEED_ALLOW_PRODUCTION=1)
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/auth";
import { createWorkspace } from "../src/lib/workspaces";
import { DEFAULT_CONSENT, DEFAULT_FORM_FIELDS, defaultSections } from "../src/lib/landing";
import { DEFAULT_SEQUENCE_STEPS } from "../src/lib/followups";
import { createLead, changeLeadStatus } from "../src/lib/leads";
import { buildStrategy } from "../src/lib/strategy";

const db = new PrismaClient();
export const DEMO_EMAIL = "demo@seapilot.test";
export const DEMO_PASSWORD = "DemoPilot2026!";

async function main() {
  if (process.env.NODE_ENV === "production" && process.env.SEED_ALLOW_PRODUCTION !== "1") throw new Error("Seed de démonstration refusé en production (SEED_ALLOW_PRODUCTION=1 pour forcer).");
  const existing = await db.user.findUnique({ where: { email: DEMO_EMAIL } });
  if (existing) {
    const m = await db.membership.findMany({ where: { userId: existing.id }, select: { workspaceId: true } });
    await db.workspace.deleteMany({ where: { id: { in: m.map((x) => x.workspaceId) }, isDemo: true } });
    await db.user.delete({ where: { id: existing.id } });
  }
  const user = await db.user.create({ data: { email: DEMO_EMAIL, name: "Utilisateur Démo", passwordHash: await hashPassword(DEMO_PASSWORD) } });
  const ws = await createWorkspace(user.id, "Demo Workspace", { isDemo: true });
  const workspaceId = ws.id;
  await db.workspace.update({
    where: { id: workspaceId },
    data: { industry: "Rénovation (démo)", country: "France", language: "fr", currency: "EUR", companySize: "2-10", website: "https://exemple.test", description: "Entreprise fictive de rénovation de salles de bain — données de démonstration.", goalLeadsPerMonth: 100, goalSalesPerMonth: 10, adBudgetMonthly: 1500, maxCac: 130, revenueGoal: 12000, onboardingCompletedAt: new Date() },
  });

  const audience = await db.audience.create({ data: { workspaceId, name: "Propriétaires 35-60 ans (démo)", type: "b2c", customerType: "Propriétaires de maison", location: "Lyon et Rhône", needs: "Salle de bain moderne et sûre", problems: "Baignoire peu pratique, humidité", objections: "Prix\nDélais\nConfiance dans l'artisan" } });
  const offer = await db.offer.create({ data: { workspaceId, audienceId: audience.id, name: "Rénovation de salle de bain (démo)", description: "Rénovation clé en main avec devis gratuit.", price: 5200, marginPct: 28, currency: "EUR", geoZone: "Lyon et Rhône", advantages: ["Devis gratuit sous 48 h", "Artisans certifiés"], differentiation: "Un interlocuteur unique du début à la fin", status: "active" } });
  const page = await db.landingPage.create({ data: { workspaceId, name: "Devis salle de bain (démo)", slug: "devis-salle-de-bain-demo", status: "published", publishedAt: new Date(), offerId: offer.id, seoTitle: "Rénovation de salle de bain à Lyon — devis gratuit", seoDescription: "Page de démonstration SEA Pilot : rénovation de salle de bain clé en main, devis gratuit sous 48 h.", sections: defaultSections({ name: offer.name, headline: "Votre salle de bain rénovée, clé en main", subheadline: "Devis gratuit sous 48 h — données de démonstration", benefits: ["Devis gratuit sous 48 h", "Artisans certifiés", "Un interlocuteur unique"] }) as object[] } });
  await db.form.create({ data: { workspaceId, landingPageId: page.id, name: "Formulaire principal", fields: DEFAULT_FORM_FIELDS as object[], consentText: DEFAULT_CONSENT } });

  const camps = await Promise.all([
    db.campaign.create({ data: { workspaceId, name: "Recherche Google — salle de bain (démo)", platform: "google_ads", status: "active", budget: 900, budgetType: "monthly", objective: "leads", offerId: offer.id, audienceId: audience.id, landingPageId: page.id } }),
    db.campaign.create({ data: { workspaceId, name: "Meta — remarketing (démo)", platform: "meta_ads", status: "active", budget: 450, budgetType: "monthly", objective: "leads", offerId: offer.id, audienceId: audience.id, landingPageId: page.id } }),
    db.campaign.create({ data: { workspaceId, name: "TikTok — notoriété (démo)", platform: "tiktok_ads", status: "paused", budget: 250, budgetType: "monthly", objective: "awareness", offerId: offer.id, audienceId: audience.id } }),
  ]);
  await db.landingPage.update({ where: { id: page.id }, data: { campaignId: camps[0].id } });

  const day = (n: number) => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - n));
  for (let i = 0; i < 30; i++) {
    const wave = 1 + 0.25 * Math.sin(i / 3);
    const rows: [number, string, number, number, number][] = [[0, "google_ads", 34 * wave, 40 * wave, 1100 * wave], [1, "meta_ads", 14 * wave, 12 * wave, 1700 * wave], [2, "tiktok_ads", i < 12 ? 9 : 0, i < 12 ? 4 : 0, i < 12 ? 1300 : 0]];
    for (const [ci, platform, spend, clicks, impressions] of rows) {
      if (!spend) continue;
      await db.metric.create({ data: { workspaceId, campaignId: camps[ci].id, platform, date: day(i), spend: Math.round(spend * 100) / 100, clicks: Math.round(clicks), impressions: Math.round(impressions), source: "manual", dedupeKey: `seed:${camps[ci].id}:${i}` } });
    }
  }
  const people = ["Camille Martin", "Lucas Bernard", "Emma Petit", "Hugo Robert", "Léa Richard", "Nathan Durand", "Chloé Dubois", "Louis Moreau", "Manon Laurent", "Jules Simon", "Inès Michel", "Arthur Lefebvre"];
  const msgs = ["Nous voulons remplacer la baignoire par une douche, c'est urgent, devis cette semaine svp.", "Je cherche un prix pour rénover ma salle de bain.", "Projet dans quelques mois, juste pour information.", "Besoin d'un devis pour une rénovation complète, budget 6000 €."];
  let n = 0;
  for (const name of people) {
    n++;
    const camp = camps[n % 2];
    const { lead } = await createLead({
      workspaceId, name: `${name} (démo)`, email: `demo${n}@exemple.test`, phone: n % 3 ? "06 00 00 00 0" + (n % 10) : null, message: msgs[n % msgs.length], customFields: n % 2 ? { budget: String(3000 + n * 400), ville: "Lyon" } : { ville: "Marseille" },
      campaignId: camp.id, landingPageId: page.id, utm: { source: n % 2 ? "meta" : "google", medium: n % 2 ? "paid_social" : "cpc", campaign: camp.id }, consentMarketing: n % 3 === 0, consentText: DEFAULT_CONSENT, source: n % 2 ? "meta" : "google",
    });
    await db.lead.update({ where: { id: lead.id }, data: { createdAt: new Date(Date.now() - n * 2 * 86_400_000) } });
    if (n <= 3) await changeLeadStatus({ workspaceId, leadId: lead.id, status: "won", value: 4800 + n * 250 });
    else if (n <= 5) await changeLeadStatus({ workspaceId, leadId: lead.id, status: "proposal" });
    else if (n === 6) await changeLeadStatus({ workspaceId, leadId: lead.id, status: "lost", lostReason: "Budget insuffisant" });
  }
  await db.followUpSequence.create({ data: { workspaceId, name: "Relance standard J0 · J1 · J3 · J7 · J14", steps: DEFAULT_SEQUENCE_STEPS as object[], active: true, autoEnroll: false, sendEmails: false } });
  const sheet = buildStrategy({ companyName: ws.name, currency: "EUR", offer: { name: offer.name, price: offer.price, marginPct: offer.marginPct, advantages: ["Devis gratuit sous 48 h"], differentiation: offer.differentiation, geoZone: offer.geoZone }, audience: { name: audience.name, type: "b2c", location: audience.location }, goals: { leadsPerMonth: 100, salesPerMonth: 10, adBudgetMonthly: 1500, maxCac: 130, revenueGoal: 12000 } });
  await db.strategy.create({ data: { workspaceId, content: { sheet, narrative: null }, source: "rules" } });
  console.log(`Espace de démonstration créé : ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
