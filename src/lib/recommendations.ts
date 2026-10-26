// Moteur de recommandations — règles transparentes sur les données réelles de l'espace de travail.
// Chaque recommandation expose : problème, preuve, impact potentiel (toujours une ESTIMATION), action recommandée, priorité.
// Règles de prudence : pas de priorité haute sur un échantillon insuffisant, pas de pause sans diagnostic du suivi,
// aucune recommandation d'augmenter le budget tant qu'aucun facteur de sécurité commercial n'a été validé (SCALING_SAFETY_FACTOR).
import { fmt, fmtDec, fmtNum, fmtPct, fmtRatio, type Kpis, type Goals } from "./kpi";
import { isAmbiguousMarginPct, isReliableMarginPct } from "./margin";

export type Priority = "high" | "medium" | "low";
export type Recommendation = {
  id: string;
  type: "cpl_high" | "ctr_low" | "underperforming" | "landing_weak" | "cpc_high" | "high_conversion" | "scaling" | "revenue_signal" | "tracking_check" | "lead_drop" | "stale_leads" | "no_tracking" | "cac_high" | "insufficient_data";
  priority: Priority;
  title: string;
  problem: string;
  evidence: string[];
  impact: string;
  action: string;
  campaignId?: string;
  landingPageId?: string;
};

export type RecCampaign = {
  id: string; name: string; status: string; kpis: Kpis;
  /** Marge de l'offre de la campagne, en POURCENT du prix de vente (0 < marge ≤ 100). Absente ou invalide : aucune rentabilité n'est supposée. */
  marginPct?: number | null;
};
export type RecPage = { id: string; name: string; views: number; leads: number };
export type RecInput = {
  /** GLOBAL : inclut les leads et dépenses non rattachés à une campagne */
  overall: Kpis;
  /** Périmètre rattaché aux campagnes (sert aux références par campagne) ; à défaut, `overall` */
  attributed?: Kpis | null;
  previous?: Kpis | null;
  campaigns: RecCampaign[];
  pages: RecPage[];
  goals: Goals;
  staleNewLeads: number; // leads « nouveaux » non traités depuis plus de 48 h
  currency?: string;
  periodDays: number;
  /** Injection pour les tests uniquement : facteur de sécurité appliqué au point mort. Absent = SCALING_SAFETY_FACTOR (null). */
  scalingSafetyFactor?: number | null;
};

/**
 * Facteur de sécurité commercial appliqué au point mort avant de recommander d'augmenter un budget (seuil = max(3, point mort × facteur)).
 * null = aucun facteur validé : AUCUNE recommandation d'augmentation de budget n'est émise. Ne pas renseigner de valeur sans décision commerciale.
 */
export const SCALING_SAFETY_FACTOR: number | null = null;
/** Un facteur n'est utilisable que fini et ≥ 1 (en dessous de 1, le « seuil » serait sous le point mort). */
const usableSafetyFactor = (f: unknown): number | null => (typeof f === "number" && Number.isFinite(f) && f >= 1 ? f : null);

/** Seuils explicites (testés). Ce sont des seuils opérationnels PROVISOIRES (« à valider »), pas des vérités statistiques universelles. */
export const REC_THRESHOLDS = {
  /** clients minimum pour qu'une campagne ait sa propre référence de CPL (CAC max × son taux de closing) */
  minCustomersOwnTarget: 5,
  /** échantillon suffisant pour une priorité élevée (cpl_high, cac_high, scaling) : au moins 30 leads ET 5 clients (proposition à valider) */
  minLeadsForPriority: 30,
  minCustomersForPriority: 5,
  /** « sans résultat » : au moins 5 leads attendus au rythme de référence (sinon, sans référence : 100 clics) */
  minExpectedLeadsNoResult: 5,
  minClicksNoReference: 100,
  /** suivi plausible : les visites mesurées représentent au moins 50 % des clics */
  trackingMinViewRatio: 0.5,
  trackingMinClicks: 30,
  /** landing page : taux de référence 2 % ; signalée seulement si l'écart est significatif (z ≥ 1,645, unilatéral 95 %) */
  landingReferenceRate: 0.02,
  landingMinViews: 50,
  landingMinZ: 1.645,
  /** scaling : ROAS minimal historique (conservé) ; avec une marge valide, le plancher théorique 100 / marge s'y ajoute */
  scalingMinRoas: 3,
  /** coût par lead : au moins 3 leads pour qu'il soit évalué */
  minLeadsForCpl: 3,
  /** CTR : au moins 1 000 impressions ET 30 clics, sinon aucune conclusion statistique (proposition à valider) */
  ctrMinImpressions: 1000,
  ctrMinClicks: 30,
  /** baisse de leads : au moins 10 leads sur la période précédente, sinon aucune conclusion (proposition à valider) */
  minPreviousLeadsForDrop: 10,
} as const;
const T = REC_THRESHOLDS;

const ORDER: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

/** Marge valide : nombre fini, strictement positif, au plus 100 (pourcent). Sinon null — jamais de valeur par défaut inventée. */
export const validMarginPct = (m: unknown): number | null => (typeof m === "number" && Number.isFinite(m) && m > 0 && m <= 100 ? m : null);
/** Plancher théorique de rentabilité en ROAS : revenu × marge ≥ dépense ⇔ ROAS ≥ 100 / marge(%). Null si la marge n'est pas valide. */
export const roasFloorForMargin = (m: unknown): number | null => (isReliableMarginPct(m) ? 100 / m : null); // marge ambiguë (< 1 %) ou invalide : aucun point mort

export type Tracking = "unknown" | "missing" | "doubtful" | "plausible";
/** Plausibilité du suivi : les visites mesurées sur les landing pages comparées aux clics publicitaires. */
export function trackingState(pages: RecPage[], clicks: number): Tracking {
  if (clicks < T.trackingMinClicks) return "unknown";
  const views = pages.reduce((s, p) => s + p.views, 0);
  if (views === 0) return "missing";
  return views / clicks < T.trackingMinViewRatio ? "doubtful" : "plausible";
}

/**
 * Échantillon suffisant : au moins 30 leads ET 5 clients (conjonction stricte). Seuils opérationnels PROVISOIRES (« à valider »),
 * pas une preuve de significativité statistique : en dessous, une alerte financière reste basse et nomme le volume manquant.
 */
const sampleOk = (k: Kpis) => k.leads >= T.minLeadsForPriority && k.customers >= T.minCustomersForPriority;
/** Volume manquant pour atteindre l'échantillon suffisant, par exemple « 4 client(s) » ou « 20 lead(s) et 3 client(s) ». */
const missingSample = (k: Kpis) => [k.leads < T.minLeadsForPriority ? `${T.minLeadsForPriority - k.leads} lead(s)` : "", k.customers < T.minCustomersForPriority ? `${T.minCustomersForPriority - k.customers} client(s)` : ""].filter(Boolean).join(" et ");
const sampleText = (k: Kpis) => `Échantillon : ${k.leads} lead(s), ${k.customers} client(s)${sampleOk(k) ? "" : ` — insuffisant : il manque ${missingSample(k)} pour atteindre ${T.minLeadsForPriority} leads ET ${T.minCustomersForPriority} clients (seuils opérationnels provisoires) : résultat indicatif`}`;
const ROAS_EPS = 1e-9; // tolérance flottante : « au point mort » ne dépend pas d'un arrondi de la dernière décimale
/** Libellés de statut pour les textes de campagne non active. */
const STATUS_LABEL: Record<string, string> = { paused: "en pause", completed: "terminée", archived: "archivée", draft: "en brouillon", ready: "prête, non lancée" };
/** Formulation client du cas B : point mort atteint avec une marge valide, aucun facteur de sécurité validé. Ne pas modifier sans décision métier. */
const BREAK_EVEN_REACHED_TEXT = "Sur la période, la marge brute couvre les dépenses publicitaires de cette campagne. SEA Pilot n’émet pas encore de recommandation de hausse de budget : appuyez-vous sur vos marges réelles et sur l’évolution semaine après semaine.";

export function buildRecommendations(i: RecInput): Recommendation[] {
  const out: Recommendation[] = [];
  const cur = i.currency ?? "EUR";
  const live = i.campaigns.filter((c) => c.status === "active" || c.status === "paused" || c.status === "completed" || c.kpis.spend > 0);
  const base = i.attributed ?? i.overall; // références calculées sur le périmètre rattaché aux campagnes quand il est fourni
  const avgCpl = i.overall.cpl;
  const avgCpc = i.overall.cpc;
  const avgCvr = i.overall.cvr;
  const tracking = trackingState(i.pages, i.overall.clicks);

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
  // 1 bis. Suivi incomplet : beaucoup moins de visites mesurées que de clics
  if (tracking === "doubtful" && i.overall.spend > 0) {
    const views = i.pages.reduce((s, p) => s + p.views, 0);
    out.push({
      id: "tracking_check", type: "tracking_check", priority: "medium", title: "Suivi des visites probablement incomplet",
      problem: "Les visites mesurées sont très inférieures aux clics publicitaires : une partie du trafic n'est pas mesurée ou n'arrive pas sur vos pages.",
      evidence: [`${fmtNum(views)} visite(s) mesurée(s) pour ${fmtNum(i.overall.clicks)} clic(s) (${fmtPct(views / i.overall.clicks, 0)})`, "Limite : un écart est normal (clics non aboutis, trafic hors SEA Pilot) ; sous 50 %, le suivi est jugé douteux"],
      impact: "Tant que le suivi est douteux, un CPL ou un « zéro lead » peut venir de la mesure et non de la campagne : toute décision de pause serait prématurée.",
      action: "Vérifiez que les annonces pointent vers vos pages SEA Pilot, que les paramètres UTM sont présents et que le formulaire envoie bien les leads, avant toute décision budgétaire.",
    });
  }

  for (const c of live) {
    const k = c.kpis;
    const gaps: string[] = []; // règles non évaluées faute de volume (carte « Données insuffisantes »)
    // 2. CPL trop élevé — référence propre à la campagne quand l'échantillon le permet
    if (k.spend > 0 && k.leads < T.minLeadsForCpl) gaps.push(`Coût par lead : il manque ${T.minLeadsForCpl - k.leads} lead(s) (minimum ${T.minLeadsForCpl} leads)`);
    if (k.cpl !== null && k.leads >= T.minLeadsForCpl) {
      let ref: number | null = null;
      let basis = "";
      if (i.goals.maxCac && k.customers >= T.minCustomersOwnTarget && k.closeRate) { ref = i.goals.maxCac * k.closeRate; basis = "propre à la campagne (CAC maximum × son taux de closing)"; }
      else if (i.goals.maxCac && base.customers >= T.minCustomersOwnTarget && base.closeRate) { ref = i.goals.maxCac * base.closeRate; basis = "du périmètre rattaché aux campagnes (CAC maximum × son taux de closing) — indicative, la campagne a trop peu de clients"; }
      else if (i.campaigns.length >= 2 && avgCpl) { ref = avgCpl * 1.5; basis = "moyenne de vos campagnes × 1,5 — indicative"; }
      if (ref && k.cpl > ref) {
        const sufficient = sampleOk(k);
        out.push({
          id: `cpl_high:${c.id}`, type: "cpl_high", priority: !sufficient ? "low" : k.cpl > ref * 1.5 ? "high" : "medium", campaignId: c.id,
          title: `CPL trop élevé — ${c.name}`,
          problem: `Le coût par lead de « ${c.name} » est supérieur à la référence ${basis}.`,
          evidence: [`CPL : ${fmt(k.cpl, cur)}`, `Référence : ${fmt(ref, cur)}`, `${k.leads} leads sur ${fmt(k.spend, cur)} dépensés`, sampleText(k)],
          impact: `Estimation indicative, non garantie : ramener le CPL à ${fmt(ref, cur)} économiserait environ ${fmt((k.cpl - ref) * k.leads, cur)} pour le même volume de leads.`,
          action: sufficient ? "Resserrez l'audience, testez un nouveau message ou une nouvelle accroche et coupez les placements les moins performants." : "Laissez la campagne accumuler des données avant de trancher ; en attendant, testez une nouvelle accroche sans réduire le budget.",
        });
      }
    }
    // 3. CTR faible
    const missImpressions = Math.max(0, T.ctrMinImpressions - k.impressions);
    const missClicks = Math.max(0, T.ctrMinClicks - k.clicks);
    if (missImpressions > 0 || missClicks > 0) gaps.push(`CTR : il manque ${[missImpressions > 0 ? `${fmtNum(missImpressions)} impression(s)` : "", missClicks > 0 ? `${fmtNum(missClicks)} clic(s)` : ""].filter(Boolean).join(" et ")} (minimum ${fmtNum(T.ctrMinImpressions)} impressions ET ${T.ctrMinClicks} clics)`);
    if (k.ctr !== null && missImpressions === 0 && missClicks === 0 && k.ctr < 0.005) {
      out.push({
        id: `ctr_low:${c.id}`, type: "ctr_low", priority: k.spend > 0 && k.ctr < 0.002 ? "high" : "medium", campaignId: c.id,
        title: `CTR faible — ${c.name}`,
        problem: "Peu d'internautes cliquent sur les annonces : l'accroche ou le ciblage ne retient pas l'attention.",
        evidence: [`CTR : ${fmtPct(k.ctr, 2)}`, `${fmtNum(k.impressions)} impressions, ${fmtNum(k.clicks)} clics`],
        impact: "Un CTR plus élevé baisse le coût par clic et améliore l'indice de qualité des annonces.",
        action: "Testez au moins 2 nouvelles accroches dans l'AI Studio et comparez-les à l'existante pendant 7 jours.",
      });
    }
    // 4. Campagne sans lead : seulement si assez de clics pour attendre des leads, et selon la plausibilité du suivi.
    //    Texte et priorité respectent le STATUT : une campagne non active ne reçoit jamais « Mettez la campagne en pause ».
    if (k.spend > 0 && k.leads === 0) {
      const refCvr = base.cvr !== null && base.cvr > 0 ? base.cvr : null; // taux nul = pas de référence : seuil absolu en clics
      const expected = refCvr !== null ? k.clicks * refCvr : null;
      const enough = expected !== null ? expected >= T.minExpectedLeadsNoResult : k.clicks >= T.minClicksNoReference;
      if (!enough) {
        const needed = refCvr !== null ? Math.ceil(T.minExpectedLeadsNoResult / refCvr - 1e-9) : T.minClicksNoReference;
        gaps.push(`Campagne sans résultat : il manque ${fmtNum(Math.max(1, needed - k.clicks))} clic(s) (${refCvr !== null ? `au rythme de référence, ${T.minExpectedLeadsNoResult} leads seraient attendus` : `minimum ${T.minClicksNoReference} clics sans référence de conversion`})`);
      }
      if (enough) {
        const active = c.status === "active";
        const trackingOk = tracking === "plausible";
        const views = i.pages.reduce((s, p) => s + p.views, 0);
        const evidence = [`Dépense : ${fmt(k.spend, cur)}`, `${fmtNum(k.clicks)} clics, 0 lead`, ...(expected !== null ? [`Au rythme de référence (${fmtPct(refCvr, 1)} de clics en leads), environ ${fmtDec(expected, 1)} lead(s) étaient attendus`] : []), `Suivi : ${fmtNum(views)} visite(s) mesurée(s) pour ${fmtNum(i.overall.clicks)} clic(s)`];
        let action: string;
        let priority: Priority;
        let problem: string;
        if (active) {
          if (!trackingOk) {
            priority = "medium";
            problem = "La campagne dépense du budget et génère des clics sans lead, mais le suivi n'est pas jugé fiable : le résultat peut venir de la mesure.";
            action = "Vérifiez d'abord le suivi (URL de destination, paramètres UTM, formulaire de la landing page) avant toute décision de pause.";
          } else {
            priority = "high";
            problem = "La campagne dépense du budget et génère des clics, mais aucun lead, alors que le suivi paraît plausible.";
            action = "Mettez la campagne en pause, vérifiez le formulaire de la landing page (fonctionne-t-il ?) puis relancez avec un message corrigé.";
          }
        } else {
          // Campagne non active (en pause, terminée, archivée, brouillon, prête) : aucune pause à recommander, priorité basse ; le suivi reste signalé s'il est douteux.
          const label = STATUS_LABEL[c.status] ?? `statut « ${c.status} »`;
          const relaunch = "ne la relancez qu'après avoir corrigé le message ou la landing page et vérifié que le formulaire fonctionne.";
          const trackingFirst = "Vérifiez d'abord le suivi (URL de destination, paramètres UTM, formulaire de la landing page) avant toute relance.";
          priority = "low";
          problem = `La campagne (${label}) avait dépensé du budget et généré des clics sans aucun lead${trackingOk ? "." : ", mais le suivi n'est pas jugé fiable : le résultat peut venir de la mesure."}`;
          action = c.status === "paused"
            ? (trackingOk ? `Elle est déjà en pause : ${relaunch}` : `Elle est déjà en pause. ${trackingFirst}`)
            : (trackingOk ? `Elle n'est pas diffusée (${label}) : aucune pause à faire ; ${relaunch}` : `Elle n'est pas diffusée (${label}) : aucune pause à faire. ${trackingFirst}`);
        }
        out.push({
          id: `underperforming:${c.id}`, type: "underperforming", priority, campaignId: c.id,
          title: `Campagne sans résultat — ${c.name}`, problem, evidence,
          impact: `${fmt(k.spend, cur)} dépensés sans résultat mesurable à ce jour (montant constaté, pas une prévision).`,
          action,
        });
      }
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
    // 7. Rentabilité : une seule recommandation par campagne, trois états cohérents (jamais deux messages contradictoires).
    //    marge absente / invalide / ambiguë : aucune affirmation de rentabilité ;
    //    A. ROAS < point mort : signal « Sous le point mort » (jamais de scaling) ;
    //    B. ROAS ≥ point mort, sans facteur de sécurité (ou seuil / échantillon non atteint) : scaling non recommandé ;
    //    C. facteur défini, seuil max(3, point mort × facteur) atteint ET échantillon suffisant : scaling.
    if (k.roiReliable && k.roas !== null) {
      const margin = validMarginPct(c.marginPct);
      const floor = roasFloorForMargin(c.marginPct);
      if (margin === null || floor === null || isAmbiguousMarginPct(c.marginPct)) {
        if (k.roas >= T.scalingMinRoas) {
          const ambiguous = isAmbiguousMarginPct(c.marginPct);
          out.push({
            id: `revenue_signal:${c.id}`, type: "revenue_signal", priority: "low", campaignId: c.id,
            title: `ROAS élevé, rentabilité non évaluable — ${c.name}`,
            problem: `Le chiffre d'affaires attribué dépasse nettement la dépense, mais la marge de l'offre n'est pas ${ambiguous ? "exploitable" : "renseignée (ou invalide)"} : on ne peut pas dire si la campagne est rentable.${ambiguous ? ` La marge saisie (${fmtDec(margin ?? 0, 2)} %) est inférieure à 1 % : possible erreur d'unité (28 se saisit 28, pas 0,28).` : ""}`,
            evidence: [`ROAS sur chiffre d'affaires : ${fmtRatio(k.roas)}`, `Chiffre d'affaires attribué : ${fmt(k.revenue, cur)} pour ${fmt(k.spend, cur)} dépensés`, `Limite : le chiffre d'affaires n'est pas un bénéfice ; marge de l'offre ${ambiguous ? "ambiguë (inférieure à 1 %)" : "absente ou invalide"}`],
            impact: "Sans marge exploitable, aucun seuil de rentabilité ne peut être calculé : une augmentation de budget reste un pari.",
            action: ambiguous ? "Vérifiez l'unité de la marge de l'offre (Offers) : elle s'exprime en pourcentage entier (28 pour 28 %)." : "Renseignez la marge approximative de l'offre (Offers) pour obtenir un signal de rentabilité fondé sur le point mort.",
          });
        }
      } else if (k.roas < floor - ROAS_EPS) {
        // A. sous le point mort : jamais d'affirmation sans réserve ; priorité selon le niveau de preuve
        out.push({
          id: `revenue_signal:${c.id}`, type: "revenue_signal", priority: sampleOk(k) ? "medium" : "low", campaignId: c.id,
          title: `Sous le point mort — ${c.name}`,
          problem: "Le ROAS de la campagne est inférieur au point mort théorique de son offre : à la marge renseignée, le chiffre d'affaires attribué ne couvre pas la dépense (estimation, à confirmer).",
          evidence: [`ROAS sur chiffre d'affaires : ${fmtRatio(k.roas)}`, `Marge de l'offre : ${fmtDec(margin, 1)} % → point mort théorique : ROAS ≥ ${fmtRatio(floor)}`, `Chiffre d'affaires attribué : ${fmt(k.revenue, cur)} pour ${fmt(k.spend, cur)} dépensés`, sampleText(k), "Limite : ROAS calculé sur le chiffre d'affaires ; la marge de l'offre est approximative"],
          impact: "Estimation : si la marge renseignée est exacte, chaque unité dépensée rapporte moins de marge qu'elle ne coûte ; à confirmer sur un échantillon plus large.",
          action: "Ne pas augmenter le budget. Améliorez le taux de closing, le panier moyen ou le coût d'acquisition, et vérifiez la marge renseignée dans l'offre.",
        });
      } else {
        const factor = usableSafetyFactor(i.scalingSafetyFactor === undefined ? SCALING_SAFETY_FACTOR : i.scalingSafetyFactor);
        const needed = factor === null ? null : Math.max(T.scalingMinRoas, floor * factor);
        const thresholdOk = needed !== null && k.roas >= needed - ROAS_EPS;
        const sampleEnough = sampleOk(k);
        if (needed !== null && thresholdOk && sampleEnough) {
          out.push({
            id: `scaling:${c.id}`, type: "scaling", priority: "medium", campaignId: c.id,
            title: `Opportunité de scaling — ${c.name}`,
            problem: "La campagne dépasse le point mort théorique de son offre avec la marge de sécurité commerciale définie.",
            evidence: [`ROAS sur chiffre d'affaires : ${fmtRatio(k.roas)}`, `Marge de l'offre : ${fmtDec(margin, 1)} % → point mort théorique : ROAS ≥ ${fmtRatio(floor)}`, `Facteur de sécurité : ×${fmtDec(factor ?? 0, 2)} → ROAS minimal pour envisager une hausse : ${fmtRatio(needed)}`, `Chiffre d'affaires attribué : ${fmt(k.revenue, cur)} pour ${fmt(k.spend, cur)} dépensés`, sampleText(k)],
            impact: "Estimation : augmenter progressivement le budget peut accroître le bénéfice tant que le ROAS reste au-dessus du seuil.",
            action: "Augmentez le budget de 15 à 20 % toutes les semaines en surveillant le ROAS et le CPL.",
          });
        } else {
          // B. au point mort ou au-dessus : scaling non recommandé, avec la raison exacte
          const sampleNote = sampleEnough ? "" : ` Échantillon insuffisant (moins de ${T.minLeadsForPriority} leads ou moins de ${T.minCustomersForPriority} clients) : il manque ${missingSample(k)} ; signal indicatif.`;
          const lead = needed === null
            ? BREAK_EVEN_REACHED_TEXT
            : !thresholdOk
              ? `Au point mort ou au-dessus, marge de sécurité non atteinte (ROAS minimal ${fmtRatio(needed)} pour un facteur de ×${fmtDec(factor ?? 0, 2)}) ; scaling non recommandé.`
              : "Au point mort ou au-dessus et marge de sécurité atteinte ; scaling non recommandé.";
          out.push({
            id: `revenue_signal:${c.id}`, type: "revenue_signal", priority: "low", campaignId: c.id,
            title: `Au point mort ou au-dessus — ${c.name}`,
            problem: `${lead}${sampleNote}`,
            evidence: [`ROAS sur chiffre d'affaires : ${fmtRatio(k.roas)}`, `Marge de l'offre : ${fmtDec(margin, 1)} % → point mort théorique : ROAS ≥ ${fmtRatio(floor)}`, `Chiffre d'affaires attribué : ${fmt(k.revenue, cur)} pour ${fmt(k.spend, cur)} dépensés`, sampleText(k), "Limite : ROAS calculé sur le chiffre d'affaires ; un ROAS au point mort ne dégage aucun bénéfice"],
            impact: "Estimation : sans marge de sécurité validée, le ROAS actuel ne garantit pas qu'une hausse de budget reste rentable.",
            action: "Ne pas augmenter le budget sur ce seul signal : fixez d'abord une marge de sécurité commerciale (facteur appliqué au point mort) et attendez un échantillon suffisant.",
          });
        }
      }
    }
    // 8 bis. UNE seule recommandation « Données insuffisantes » par campagne : liste les règles qui n'ont pas pu être évaluées faute de volume,
    //        avec le volume manquant. Elle ne répète jamais une règle déjà émise (une règle non évaluée n'a émis aucune alerte), ne masque aucune
    //        alerte technique et ne fusionne jamais deux campagnes. Campagne sans aucune donnée enregistrée : aucune carte.
    if (gaps.length > 0 && (k.spend > 0 || k.impressions > 0 || k.clicks > 0 || k.leads > 0)) {
      out.push({
        id: `insufficient_data:${c.id}`, type: "insufficient_data", priority: "low", campaignId: c.id,
        title: `Données insuffisantes — ${c.name}`,
        problem: `Certaines analyses de « ${c.name} » n'ont pas pu être faites faute de volume : aucune conclusion ne peut être tirée sur ces points à ce stade.`,
        evidence: gaps,
        impact: "Aucune décision de pause ou de budget ne devrait reposer sur ces indicateurs tant que le volume minimal n'est pas atteint (seuils opérationnels provisoires).",
        action: "Laissez la campagne accumuler des données avant de conclure ; les alertes techniques (suivi, leads à contacter) restent à traiter en priorité.",
      });
    }
  }

  // 8. CAC global trop élevé (CAC « mélangé » : dépenses et clients de tout le périmètre)
  if (i.overall.cac !== null && i.goals.maxCac && i.overall.cac > i.goals.maxCac) {
    out.push({
      id: "cac_high", type: "cac_high", priority: !sampleOk(i.overall) ? "low" : i.overall.cac > i.goals.maxCac * 1.25 ? "high" : "medium",
      title: "Coût d'acquisition client trop élevé",
      problem: "Le coût d'acquisition client dépasse le maximum fixé à l'onboarding.",
      evidence: [`CAC global : ${fmt(i.overall.cac, cur)}`, `Maximum visé : ${fmt(i.goals.maxCac, cur)}`, `${i.overall.customers} client(s) pour ${fmt(i.overall.spend, cur)}`, ...(i.attributed && i.attributed.cac !== null && i.attributed.cac !== i.overall.cac ? [`CAC rattaché aux campagnes : ${fmt(i.attributed.cac, cur)}`] : []), "Limite : le CAC global inclut les dépenses et les clients non rattachés à une campagne", sampleText(i.overall)],
      impact: "Au-delà de ce seuil, chaque nouveau client réduit la marge ou la rend négative.",
      action: sampleOk(i.overall) ? "Concentrez le budget sur les campagnes au CAC le plus bas et améliorez le taux de closing des leads qualifiés." : "Données encore insuffisantes pour conclure : laissez-les s'accumuler et ne modifiez pas le budget sur ce seul indicateur.",
    });
  }

  // 9. Chute de leads vs période précédente
  if (i.previous && i.previous.leads >= T.minPreviousLeadsForDrop && i.overall.leads < i.previous.leads * 0.7) {
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

  // 10. Landing page faible : signalée seulement si l'écart au taux de référence est statistiquement significatif
  for (const p of i.pages) {
    if (p.views >= T.landingMinViews) {
      const rate = p.leads / p.views;
      const expected = p.views * T.landingReferenceRate;
      const z = (expected - p.leads) / Math.sqrt(expected * (1 - T.landingReferenceRate));
      if (rate < T.landingReferenceRate && z >= T.landingMinZ) {
        out.push({
          id: `landing_weak:${p.id}`, type: "landing_weak", priority: rate === 0 ? "high" : "medium", landingPageId: p.id,
          title: `Landing page peu convertissante — ${p.name}`,
          problem: "Beaucoup de visiteurs mais très peu laissent leurs coordonnées.",
          evidence: [`${p.views} visites`, `${p.leads} lead(s)`, `Taux de conversion (leads de la page ÷ visites de la page) : ${fmtPct(rate, 2)}`, `Référence : ${fmtPct(T.landingReferenceRate, 0)} (environ ${fmtDec(expected, 1)} lead(s) attendus) ; écart significatif`],
          impact: "Estimation : doubler le taux de conversion diviserait par deux le coût par lead à trafic constant.",
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
