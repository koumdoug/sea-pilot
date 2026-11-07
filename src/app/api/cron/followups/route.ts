import { env } from "@/lib/env";
import { safeEqual } from "@/lib/crypto";
import { processDueFollowUps, type ProcessSummary } from "@/lib/followups";
import { reconcileAcceptedReviews } from "@/lib/followup-review";
import { listSyncableIntegrations, syncIntegration } from "@/lib/integrations/service";
import { log, errMsg } from "@/lib/logger";
import { countStripeLinkedSubscriptions, reconcileDueSubscriptions, stripeConfigured, type ReconcileSummary } from "@/lib/billing";
import { purgeStripeEvents } from "@/lib/stripe-events";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Budget total de la tâche (la route est coupée à `maxDuration` = 300 s) : marge de 60 s pour la réponse et les fins de requêtes en cours. */
const CRON_BUDGET_MS = 240_000;
/** Part réservée à la réconciliation Stripe : la synchronisation des intégrations s'arrête assez tôt pour la lui laisser. */
const CRON_RECONCILE_BUDGET_MS = 90_000;
/** Durée maximale d'une synchronisation d'intégration (un appel externe) : aucune n'est commencée si elle ne peut pas se terminer dans le budget. */
const SYNC_ITEM_RESERVE_MS = 30_000;
/**
 * Budget des relances (bien inférieur au bail de 5 minutes) : aucune relance n'est commencée s'il reste moins de 30 s (appel fournisseur ≤ 20 s + écritures).
 * Ce qui n'a pas pu être traité reste en attente et est repris au passage suivant (`deferred`).
 */
const CRON_FOLLOWUPS_BUDGET_MS = 75_000;

/**
 * Tâche planifiée (toutes les 5 à 15 minutes) : exécute les relances échues, synchronise les plateformes publicitaires AUTORISÉES et réconcilie les abonnements Stripe.
 * Protégée par `Authorization: Bearer $CRON_SECRET`. Paramètres : `sync=0` (sans intégrations), `reconcile=0` (sans Stripe).
 * Passages concurrents sans danger : les relances se réservent atomiquement (bail), la réconciliation tient un bail par abonnement. Chaque traitement est ISOLÉ :
 * l'échec des relances n'empêche ni les synchronisations, ni la réconciliation Stripe, ni la purge. Tout ce qui n'a pas pu être traité dans le budget est DIFFÉRÉ
 * (jamais signalé comme réussi) ; `complete: false` l'indique dans la réponse et dans les journaux.
 */
async function handle(req: Request) {
  const secret = env.cronSecret;
  if (!secret) return Response.json({ error: "CRON_SECRET non configuré." }, { status: 503 });
  const given = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!given || !safeEqual(given, secret)) return Response.json({ error: "Non autorisé." }, { status: 401 });

  const startedAt = Date.now();
  const url = new URL(req.url);

  let followups: ProcessSummary | { crashed: true };
  try {
    await reconcileAcceptedReviews();
    followups = await processDueFollowUps({ deadlineAt: startedAt + CRON_FOLLOWUPS_BUDGET_MS });
  } catch (e) {
    log.error("cron.followups_failed", { error: errMsg(e) });
    followups = { crashed: true };
  }

  const syncs = { ok: 0, errors: 0, skippedInactive: 0, skippedOverLimit: 0, deferred: 0, planFailed: false };
  if (url.searchParams.get("sync") !== "0") {
    try {
      // Seules les synchronisations que le forfait autorise sont lancées (abonnement actif, dans la limite d'intégrations) ; les connexions sont conservées.
      const plan = await listSyncableIntegrations();
      syncs.skippedInactive = plan.skippedInactive; syncs.skippedOverLimit = plan.skippedOverLimit;
      for (let i = 0; i < plan.allowed.length; i++) {
        if (Date.now() - startedAt + CRON_RECONCILE_BUDGET_MS + SYNC_ITEM_RESERVE_MS > CRON_BUDGET_MS) { syncs.deferred = plan.allowed.length - i; break; }
        const it = plan.allowed[i];
        try { await syncIntegration(it.workspaceId, it.provider); syncs.ok++; } catch (e) { syncs.errors++; log.warn("cron.sync_failed", { provider: it.provider, error: errMsg(e) }); }
      }
    } catch (e) {
      syncs.planFailed = true;
      log.error("cron.sync_plan_failed", { error: errMsg(e) });
    }
  }

  // Réconciliation des abonnements payants avec Stripe (événements perdus) : une panne de Stripe n'empêche pas le reste de la tâche et ne modifie aucun droit.
  // Étapes volontairement désactivées par paramètre, dans un ordre fixe. Distinct de `syncSkipped` (intégrations écartées par le forfait ou la limite).
  const disabledStages = (["sync", "reconcile", "purge"] as const).filter((k) => url.searchParams.get(k) === "0");
  const reconcileDisabled = disabledStages.includes("reconcile"); // désactivation VOLONTAIRE : la tâche n'est pas complète (≠ Stripe non configuré : réconciliation sans objet) ; elle garde la priorité sur le contrôle ci-dessous
  let billing: ReconcileSummary | { skipped: true; reason: string; linkedSubscriptions?: number | null } = { skipped: true, reason: reconcileDisabled ? "désactivée par paramètre" : "Stripe non configuré" };
  // Stripe absent : mode essai (aucun abonnement lié) = sans objet, `complete` inchangé. Des abonnements liés à Stripe sans clé = configuration probablement accidentelle : incomplet.
  // Si le contrôle lui-même échoue, jamais de succès affiché : `linkedSubscriptions: null` (inconnu) et incomplet. Aucune requête quand Stripe est configuré ou que `reconcile=0`.
  let stripeAbsentIncomplete = false;
  if (!reconcileDisabled && !stripeConfigured()) {
    try {
      const linked = await countStripeLinkedSubscriptions();
      if (linked > 0) { stripeAbsentIncomplete = true; billing = { skipped: true, reason: "Stripe non configuré", linkedSubscriptions: linked }; log.error("cron.stripe_not_configured_with_subscriptions", { count: linked }); }
    } catch (e) {
      stripeAbsentIncomplete = true; billing = { skipped: true, reason: "Stripe non configuré", linkedSubscriptions: null };
      log.error("cron.stripe_not_configured_check_failed", { error: errMsg(e) });
    }
  }
  if (!reconcileDisabled && stripeConfigured()) {
    const budgetMs = Math.min(CRON_RECONCILE_BUDGET_MS, CRON_BUDGET_MS - (Date.now() - startedAt));
    try { billing = await reconcileDueSubscriptions({ budgetMs }); }
    catch (e) { log.error("cron.reconcile_failed", { error: errMsg(e) }); billing = { checked: 0, updated: 0, failed: 1, busy: 0, needsReview: 0, unknownPrice: 0, openPriceReviews: null, unlinkedPriceReviews: null, reviewCountersAvailable: false, deferred: 0, remaining: 0, complete: false, stoppedBy: null }; }
  }
  // Purge du registre des événements Stripe (rétention 90 jours, jamais d'événement en cours) ; une erreur de purge n'affecte rien d'autre.
  let ledgerPurged: { processed: number; failed: number } | { skipped: true } = { skipped: true };
  if (url.searchParams.get("purge") !== "0") { try { ledgerPurged = await purgeStripeEvents(); } catch (e) { log.warn("cron.ledger_purge_failed", { error: errMsg(e) }); } }

  const followupsComplete = !("crashed" in followups) && followups.deferred === 0;
  const outboundDisabled = env.outboundSendingDisabled; // interrupteur global des envois : les relances e-mail sont volontairement en attente, la tâche n'est donc pas complète
  if (outboundDisabled) log.warn("cron.outbound_sending_disabled", {});
  const complete = !outboundDisabled && followupsComplete && syncs.deferred === 0 && !syncs.planFailed && !reconcileDisabled && !stripeAbsentIncomplete && ("skipped" in billing || billing.complete);
  log.info("cron.summary", { complete, disabledStages, followups, syncs, billing, elapsedMs: Date.now() - startedAt });
  return Response.json({ followups, syncs: syncs.ok + syncs.errors, syncErrors: syncs.errors, syncSkipped: { inactive: syncs.skippedInactive, overLimit: syncs.skippedOverLimit }, syncDeferred: syncs.deferred, syncPlanFailed: syncs.planFailed, billing, ledgerPurged, disabledStages, ...(outboundDisabled ? { outboundSendingDisabled: true } : {}), complete });
}

export const GET = handle;
export const POST = handle;
