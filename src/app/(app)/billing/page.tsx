import type { Metadata } from "next";
import { requireCtx } from "@/lib/tenant";
import { env } from "@/lib/env";
import { PLANS, UNLIMITED, comparePlans, type PlanLimits } from "@/lib/plans";
import { PLAN_IDS } from "@/lib/constants";
import { planCheckoutReady, stripeConfigured, workspaceUsage } from "@/lib/billing";
import { Alert, Badge, Card, ConfigRequired, PageHeader, Section, fmtDate } from "@/components/ui";
import { InlineAction } from "@/components/forms";
import { cancelAction, changePlanAction, checkoutAction, portalAction, selectTrialPlanAction } from "./actions";

export const metadata: Metadata = { title: "Billing" };
const LIMIT_LABEL: Record<keyof PlanLimits, string> = { members: "Utilisateurs", activeCampaigns: "Campagnes actives", landingPages: "Landing pages", leadsPerMonth: "Leads ce mois-ci", aiGenerationsPerDay: "Générations IA / jour", sequences: "Séquences de relance", integrations: "Intégrations", apiKeys: "Clés API" };
const STATE_LABEL: Record<string, string> = { trial: "Essai gratuit", paid: "Abonnement actif", past_due: "Paiement en échec", canceling: "Résiliation programmée", trial_expired: "Essai terminé", canceled: "Abonnement terminé", incomplete: "Incomplet" };

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ blocked?: string; success?: string; canceled?: string }> }) {
  const ctx = await requireCtx({ allowInactive: true });
  const sp = await searchParams;
  const e = ctx.ent;
  const sub = ctx.subscription;
  const usage = await workspaceUsage(ctx.workspaceId);
  const owner = ctx.can("manage_billing");
  const paid = !!sub?.stripeSubscriptionId;
  const stripeOk = stripeConfigured();

  return (
    <>
      <PageHeader title="Facturation" subtitle="Plan, essai, abonnement et usage de votre espace." />
      {sp.blocked && <div className="mb-4"><Alert tone="warning" title="Accès suspendu">{e.reason ?? "Votre abonnement n'est plus actif."} Les leads reçus par vos pages publiques continuent d'être enregistrés ; vous y accéderez dès la réactivation.</Alert></div>}
      {sp.success && <div className="mb-4"><Alert tone="success">Paiement reçu. L'activation de l'abonnement est confirmée par Stripe en quelques secondes : actualisez la page si besoin.</Alert></div>}
      {sp.canceled && <div className="mb-4"><Alert tone="info">Paiement annulé : aucun prélèvement n'a été effectué.</Alert></div>}

      <Card className="mb-5">
        <div className="flex flex-wrap items-center gap-3"><h2 className="text-lg font-semibold">Plan {e.plan.name}</h2><Badge tone={e.active ? (e.state === "past_due" ? "orange" : "green") : "red"}>{STATE_LABEL[e.state]}</Badge></div>
        <p className="mt-1 text-sm text-slate-700">
          {e.state === "trial" && `Essai gratuit : il reste ${e.daysLeft} jour(s) (jusqu'au ${fmtDate(sub?.trialEndsAt)}).`}
          {e.state === "paid" && `Prochain renouvellement : ${fmtDate(sub?.currentPeriodEnd)}.`}
          {e.state === "canceling" && `Abonnement résilié : accès jusqu'au ${fmtDate(sub?.currentPeriodEnd)}.`}
        </p>
        {owner && paid && <div className="mt-3 flex flex-wrap gap-2">
          <InlineAction action={portalAction} size="md" variant="secondary">Moyen de paiement et factures</InlineAction>
          {sub?.cancelAtPeriodEnd ? <InlineAction action={cancelAction} size="md" variant="primary" hidden={{ cancel: "0" }}>Reprendre l'abonnement</InlineAction> : <InlineAction action={cancelAction} size="md" variant="danger" hidden={{ cancel: "1" }} confirm="Résilier à la fin de la période en cours ?">Résilier</InlineAction>}
        </div>}
        {owner && !paid && e.state === "trial" && <div className="mt-3"><InlineAction action={cancelAction} size="md" variant="ghost" hidden={{ cancel: "1" }} confirm="Terminer l'essai maintenant ? L'accès sera suspendu.">Terminer l'essai</InlineAction></div>}
      </Card>

      {!stripeOk && <div className="mb-5"><ConfigRequired title="Paiement : configuration requise" env={["STRIPE_SECRET_KEY", "STRIPE_PRICE_STARTER", "STRIPE_PRICE_GROWTH", "STRIPE_PRICE_PRO", "STRIPE_WEBHOOK_SECRET"]}>Le paiement en ligne n'est pas configuré sur ce serveur : aucun abonnement payant ne peut être souscrit pour l'instant. L'essai gratuit reste utilisable.</ConfigRequired></div>}
      {!owner && <div className="mb-5"><Alert tone="info">Seul le propriétaire de l'espace peut modifier l'abonnement.</Alert></div>}

      <h2 className="mb-3 text-lg font-semibold">Plans</h2>
      <ul className="mb-8 grid gap-4 lg:grid-cols-3">
        {PLAN_IDS.map((id) => {
          const p = PLANS[id];
          const current = sub?.plan === id;
          const dir = comparePlans(sub?.plan ?? "starter", id);
          const label = env.planPriceLabel(id);
          return (
            <li key={id}><Card className={`flex h-full flex-col ${current ? "ring-2 ring-brand-600" : ""}`}>
              <div className="flex items-center justify-between"><h3 className="text-lg font-bold">{p.name}</h3>{current && <Badge tone="blue">Plan actuel</Badge>}</div>
              <p className="mt-1 text-sm text-slate-600">{p.tagline}</p>
              <p className="mt-3 text-sm font-semibold">{label ?? "Tarif affiché lors de la souscription"}</p>
              <ul className="mt-3 flex-1 list-disc space-y-1 pl-5 text-sm">{p.features.map((f) => <li key={f}>{f}</li>)}</ul>
              {owner && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {!paid && e.state === "trial" && !current && <InlineAction action={selectTrialPlanAction} size="md" variant="secondary" hidden={{ plan: id }}>Essayer ce plan</InlineAction>}
                  {!paid && (e.state === "trial" || !e.active || e.state === "incomplete") && planCheckoutReady(id) && <InlineAction action={checkoutAction} size="md" variant="primary" hidden={{ plan: id }}>Souscrire à {p.name}</InlineAction>}
                  {!paid && !planCheckoutReady(id) && <span className="text-xs text-slate-500">Souscription indisponible (Stripe non configuré pour ce plan).</span>}
                  {paid && !current && <InlineAction action={changePlanAction} size="md" variant={dir === "upgrade" ? "primary" : "secondary"} hidden={{ plan: id }} confirm={dir === "downgrade" ? `Passer au plan ${p.name} ? Votre usage doit respecter ses limites.` : undefined}>{dir === "upgrade" ? "Passer à ce plan" : "Rétrograder"}</InlineAction>}
                </div>
              )}
            </Card></li>
          );
        })}
      </ul>

      <Section title="Usage" description="Utilisation actuelle par rapport aux limites du plan.">
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(Object.keys(e.plan.limits) as (keyof PlanLimits)[]).filter((k) => k !== "aiGenerationsPerDay").map((k) => {
            const lim = e.plan.limits[k];
            const used = usage[k];
            const pct = lim === UNLIMITED ? 0 : Math.min(100, (used / lim) * 100);
            return (
              <li key={k} className="rounded-lg border border-slate-200 p-3 text-sm"><div className="flex justify-between"><span>{LIMIT_LABEL[k]}</span><span className="tabular-nums font-medium">{used} / {lim === UNLIMITED ? "∞" : lim}</span></div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={used} aria-valuemin={0} aria-valuemax={lim === UNLIMITED ? undefined : lim} aria-label={LIMIT_LABEL[k]}><div className={`h-full ${pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-brand-600"}`} style={{ width: `${pct}%` }} /></div>
                {lim !== UNLIMITED && used > lim && <p className="mt-1 text-xs text-red-700">Limite dépassée : passez à un plan supérieur.</p>}</li>
            );
          })}
        </ul>
      </Section>
    </>
  );
}
