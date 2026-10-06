// Moteur de recommandations — règles transparentes sur les données réelles de l'espace de travail.
// Chaque recommandation expose : problème, preuve, impact potentiel, action recommandée, priorité.
import { fmt, fmtPct, type Kpis, type Goals } from "./kpi";

export type Priority = "high" | "medium" | "low";
export type Recommendation = {
  id: string;
  type: "cpl_high" | "ctr_low" | "underperforming" | "landing_weak" | "cpc_high" | "high_conversion" | "scaling" | "lead_drop" | "stale_leads" | "no_tracking" | "cac_high";
  priority: Priority;
  title: string;
  problem: string;
  evidence: string[];
  impact: string;
  action: string;
  campaignId?: string;
  landingPageId?: string;
};

export type RecCampaign = { id: string; name: string; status: string; kpis: Kpis };
export type RecPage = { id: string; name: string; views: number; leads: number };
export type RecInput = {
  overall: Kpis;
  previous?: Kpis | null;
  campaigns: RecCampaign[];
  pages: RecPage[];
  goals: Goals;
  staleNewLeads: number; // leads « nouveaux » non traités depuis plus de 48 h
  currency?: string;
  periodDays: number;
};

const ORDER: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

export function buildRecommendations(i: RecInput): Recommendation[] {
  const out: Recommendation[] = [];
  const cur = i.currency ?? "EUR";
  const live = i.campaigns.filter((c) => c.status === "active" || c.status === "paused" || c.status === "completed" || c.kpis.spend > 0);
  const avgCpl = i.overall.cpl;
  const avgCpc = i.overall.cpc;
  const avgCvr = i.overall.cvr;

  // 1. Aucun suivi alors que de la dépense est enregistrée
  if (i.overall.spend > 0 && i.pages.every((p) => p.views === 0)) {
    out.push({
      id: "no_tracking", type: "no_tracking", priority: "medium", title: "Aucune visite mesurée sur vos landing pages",
      problem: "Des dépenses publicitaires sont enregistrées mais aucune visite de landing page n'est mesurée.",
      evidence: [`Dépense : ${fmt(i.overall.spend, cur)}`, "0 visite enregistrée par SEA Pilot sur la période"],
      impact: "Sans mesure des visites, impossible de savoir si le problème vient de la publicité ou de la page.",
      action: "Vérifiez que vos annonces pointent vers vos pages SEA Pilot publiées et que les paramètres UTM sont présents dans l'URL.",
    });
  }

  for (const c of live) {
    const k = c.kpis;
    // 2. CPL trop élevé
    const targetCpl = i.goals.maxCac && i.overall.closeRate ? i.goals.maxCac * i.overall.closeRate : null;
    if (k.cpl !== null && k.leads >= 3) {
      const ref = targetCpl ?? (i.campaigns.length >= 2 && avgCpl ? avgCpl * 1.5 : null);
      if (ref && k.cpl > (targetCpl ? ref : ref)) {
        out.push({
          id: `cpl_high:${c.id}`, type: "cpl_high", priority: k.cpl > ref * 1.5 ? "high" : "medium", campaignId: c.id,
          title: `CPL trop élevé — ${c.name}`,
          problem: `Le coût par lead de « ${c.name} » est supérieur à la référence ${targetCpl ? "déduite de votre CAC maximum" : "moyenne de vos campagnes"}.`,
          evidence: [`CPL : ${fmt(k.cpl, cur)}`, `Référence : ${fmt(ref, cur)}`, `${k.leads} leads sur ${fmt(k.spend, cur)} dépensés`],
          impact: `Ramener le CPL à ${fmt(ref, cur)} économiserait environ ${fmt((k.cpl - ref) * k.leads, cur)} pour le même volume de leads.`,
          action: "Resserrez l'audience, testez un nouveau message ou une nouvelle accroche et coupez les placements les moins performants.",
        });
      }
    }
    // 3. CTR faible
    if (k.ctr !== null && k.impressions >= 1000 && k.ctr < 0.005) {
      out.push({
        id: `ctr_low:${c.id}`, type: "ctr_low", priority: k.spend > 0 && k.ctr < 0.002 ? "high" : "medium", campaignId: c.id,
        title: `CTR faible — ${c.name}`,
        problem: "Peu d'internautes cliquent sur les annonces : l'accroche ou le ciblage ne retient pas l'attention.",
        evidence: [`CTR : ${fmtPct(k.ctr, 2)}`, `${k.impressions} impressions, ${k.clicks} clics`],
        impact: "Un CTR plus élevé baisse le coût par clic et améliore l'indice de qualité des annonces.",
        action: "Testez au moins 2 nouvelles accroches dans l'AI Studio et comparez-les à l'existante pendant 7 jours.",
      });
    }
    // 4. Campagne sous-performante : dépense et clics mais aucun lead
    if (k.spend > 0 && k.clicks >= 30 && k.leads === 0) {
      out.push({
        id: `underperforming:${c.id}`, type: "underperforming", priority: "high", campaignId: c.id,
        title: `Campagne sans résultat — ${c.name}`,
        problem: "La campagne dépense du budget et génère des clics, mais aucun lead.",
        evidence: [`Dépense : ${fmt(k.spend, cur)}`, `${k.clicks} clics, 0 lead`],
        impact: `Chaque jour supplémentaire brûle du budget sans résultat mesurable (${fmt(k.spend, cur)} déjà dépensés).`,
        action: "Mettez la campagne en pause, vérifiez le formulaire de la landing page (fonctionne-t-il ?) puis relancez avec un message corrigé.",
      });
    }
    // 5. CPC élevé (audience ou enchères trop chères)
    if (k.cpc !== null && avgCpc && i.campaigns.length >= 3 && k.clicks >= 30 && k.cpc > avgCpc * 1.5) {
      out.push({
        id: `cpc_high:${c.id}`, type: "cpc_high", priority: "medium", campaignId: c.id,
        title: `Audience coûteuse — ${c.name}`,
        problem: "Le coût par clic est nettement supérieur à celui de vos autres campagnes.",
        evidence: [`CPC : ${fmt(k.cpc, cur)}`, `CPC moyen : ${fmt(avgCpc, cur)}`],
        impact: "Un trafic moins cher permet d'obtenir plus de visiteurs pour le même budget.",
        action: "Élargissez ou changez l'audience, ou réduisez les enchères sur les segments les plus chers.",
      });
    }
    // 6. Forte conversion → opportunité
    if (k.cvr !== null && avgCvr && k.leads >= 5 && k.cvr > avgCvr * 1.5 && i.campaigns.length >= 2) {
      out.push({
        id: `high_conversion:${c.id}`, type: "high_conversion", priority: "low", campaignId: c.id,
        title: `Forte conversion — ${c.name}`,
        problem: "Cette campagne convertit mieux que la moyenne : opportunité à exploiter.",
        evidence: [`Conversion clic → lead : ${fmtPct(k.cvr)}`, `Moyenne : ${fmtPct(avgCvr)}`],
        impact: "Dupliquer ce qui fonctionne est le moyen le plus sûr d'augmenter le volume de leads.",
        action: "Dupliquez la campagne vers une autre plateforme ou une audience proche et reprenez le même message.",
      });
    }
    // 7. Scaling (ROAS fiable élevé)
    if (k.roiReliable && k.roas !== null && k.roas >= 3) {
      out.push({
        id: `scaling:${c.id}`, type: "scaling", priority: "medium", campaignId: c.id,
        title: `Opportunité de scaling — ${c.name}`,
        problem: "La campagne est rentable avec une marge de manœuvre.",
        evidence: [`ROAS : ${k.roas.toFixed(2)}`, `Revenu attribué : ${fmt(k.revenue, cur)} pour ${fmt(k.spend, cur)} dépensés`],
        impact: "Augmenter progressivement le budget peut multiplier le revenu tant que le ROAS reste supérieur à 2.",
        action: "Augmentez le budget de 15 à 20 % toutes les semaines en surveillant le ROAS et le CPL.",
      });
    }
  }

  // 8. CAC global trop élevé
  if (i.overall.cac !== null && i.goals.maxCac && i.overall.cac > i.goals.maxCac) {
    out.push({
      id: "cac_high", type: "cac_high", priority: i.overall.cac > i.goals.maxCac * 1.25 ? "high" : "medium",
      title: "Coût d'acquisition client trop élevé",
      problem: "Le coût d'acquisition client dépasse le maximum fixé à l'onboarding.",
      evidence: [`CAC : ${fmt(i.overall.cac, cur)}`, `Maximum visé : ${fmt(i.goals.maxCac, cur)}`, `${i.overall.customers} client(s) pour ${fmt(i.overall.spend, cur)}`],
      impact: "Au-delà de ce seuil, chaque nouveau client réduit la marge ou la rend négative.",
      action: "Concentrez le budget sur les campagnes au CAC le plus bas et améliorez le taux de closing des leads qualifiés.",
    });
  }

  // 9. Chute de leads vs période précédente
  if (i.previous && i.previous.leads >= 5 && i.overall.leads < i.previous.leads * 0.7) {
    const drop = Math.round((1 - i.overall.leads / i.previous.leads) * 100);
    out.push({
      id: "lead_drop", type: "lead_drop", priority: drop >= 50 ? "high" : "medium",
      title: "Baisse du nombre de leads",
      problem: `Le nombre de leads a baissé de ${drop} % par rapport à la période précédente.`,
      evidence: [`Période actuelle : ${i.overall.leads} leads`, `Période précédente : ${i.previous.leads} leads`, ...(i.overall.clicks < i.previous.clicks ? [`Clics en baisse : ${i.previous.clicks} → ${i.overall.clicks}`] : [`Clics : ${i.previous.clicks} → ${i.overall.clicks}`])],
      impact: "Une baisse prolongée réduit directement le pipeline de ventes des semaines suivantes.",
      action: i.overall.clicks < i.previous.clicks * 0.8 ? "Le trafic a baissé : vérifiez budgets, statut des campagnes et refus d'annonces." : "Le trafic est stable mais convertit moins : testez la landing page et le formulaire.",
    });
  }

  // 10. Landing page faible
  for (const p of i.pages) {
    if (p.views >= 50) {
      const rate = p.leads / p.views;
      if (rate < 0.02) {
        out.push({
          id: `landing_weak:${p.id}`, type: "landing_weak", priority: rate === 0 ? "high" : "medium", landingPageId: p.id,
          title: `Landing page peu convertissante — ${p.name}`,
          problem: "Beaucoup de visiteurs mais très peu laissent leurs coordonnées.",
          evidence: [`${p.views} visites`, `${p.leads} lead(s)`, `Taux de conversion : ${fmtPct(rate, 2)}`],
          impact: "Doubler le taux de conversion divise par deux le coût par lead à trafic constant.",
          action: "Réécrivez le titre autour d'un bénéfice concret, raccourcissez le formulaire et ajoutez une preuve sociale.",
        });
      }
    }
  }

  // 11. Leads non traités
  if (i.staleNewLeads > 0) {
    out.push({
      id: "stale_leads", type: "stale_leads", priority: i.staleNewLeads >= 5 ? "high" : "medium",
      title: `${i.staleNewLeads} lead(s) à contacter`,
      problem: "Des leads « nouveaux » n'ont pas été traités depuis plus de 48 heures.",
      evidence: [`${i.staleNewLeads} lead(s) au statut « Nouveau » depuis plus de 48 h`],
      impact: "La probabilité de conversion chute fortement après les premières heures.",
      action: "Qualifiez ces leads dans le CRM et activez une séquence de relance pour ne plus en laisser passer.",
    });
  }

  return out.sort((a, b) => ORDER[a.priority] - ORDER[b.priority]);
}
