import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireCtx } from "@/lib/tenant";
import { env } from "@/lib/env";
import { INFORMATIVE_LIMITS, LIMIT_LABEL, PLANS, UNLIMITED, limitText, type PlanLimits } from "@/lib/plans";
import { PLAN_IDS } from "@/lib/constants";
import { STRIPE_WEBHOOK_EVENTS, billingNeedsReview, stripeSetup, workspaceUsage } from "@/lib/billing";
import { billingStatus, manageActions, planActions, type PlanAction } from "@/lib/billing-ui";
import { Alert, Badge, Card, PageHeader, RowTh, Section, TableWrap, Td, Th, fmtDate } from "@/components/ui";
import { InlineAction } from "@/components/forms";
import { cancelAction, changePlanAction, checkoutAction, portalAction, selectTrialPlanAction } from "./actions";

export const metadata: Metadata = { title: "Billing" };
/** Libellés du tableau comparatif (limites par forfait) : mêmes limites que l'usage, le quota de leads y est exprimé par mois. */
const TABLE_LABEL: Record<keyof PlanLimits, string> = { ...LIMIT_LABEL, leadsPerMonth: "Leads par mois (seuil indicatif)" };

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ blocked?: string; success?: string; canceled?: string }> }) {
  const ctx = await requireCtx({ allowInactive: true });
  const sp = await searchParams;
  const e = ctx.ent;
  // Le paramètre d'URL ne décide JAMAIS de l'accès : seul l'état serveur (ctx.ent) compte. Un lien « blocked » périmé (accès rétabli, propriétaire exempté) est nettoyé.
  if (sp.blocked && e.active) redirect("/billing");
  const sub = ctx.subscription;
  const usage = await workspaceUsage(ctx.workspaceId);
  const owner = ctx.can("manage_billing");
  const paid = !!sub?.stripeSubscriptionId;
  const setup = stripeSetup();
  const status = billingStatus(e, sub ? { trialEndsAt: sub.trialEndsAt, currentPeriodEnd: sub.currentPeriodEnd, hasStripeCustomer: !!sub.stripeCustomerId } : null, fmtDate);
  const exempt = e.state === "exempt";
  const review = owner && !exempt && (await billingNeedsReview(ctx.workspaceId));
  const manage = manageActions({ state: e.state, owner, hasStripeSubscription: paid });
  const hasTry = (id: (typeof PLAN_IDS)[number]) => planActions({ planId: id, currentPlanId: e.plan.id, state: e.state, owner, hasStripeSubscription: paid, checkoutReady: setup.ready[id] }).some((a) => a.kind === "try");

  const render = (id: (typeof PLAN_IDS)[number], a: PlanAction, i: number) => {
    const dir = id === e.plan.id ? "same" : PLAN_IDS.indexOf(id) > PLAN_IDS.indexOf(e.plan.id) ? "upgrade" : "downgrade";
    switch (a.kind) {
      case "current": return <Badge key={i} tone="blue">{a.label}</Badge>;
      case "try": return <InlineAction key={i} action={selectTrialPlanAction} size="md" variant="secondary" hidden={{ plan: id }}>{a.label}</InlineAction>;
      case "checkout": return <InlineAction key={i} action={checkoutAction} size="md" variant="primary" hidden={{ plan: id }}>{a.label}</InlineAction>;
      case "change": return <InlineAction key={i} action={changePlanAction} size="md" variant={dir === "upgrade" ? "primary" : "secondary"} hidden={{ plan: id }} confirm={a.confirm}>{a.label}</InlineAction>;
      default: return <span key={i} className="text-xs text-slate-500">{a.label}</span>;
    }
  };

  return (
    <>
      <PageHeader title="Facturation" subtitle="Forfait, essai, abonnement et usage de votre espace." />
      {sp.blocked && !e.active && <div className="mb-4"><Alert tone="warning" title="Accès suspendu">{e.reason ?? "Votre abonnement n'est plus actif."} Les leads reçus par vos pages publiques continuent d'être enregistrés ; vous y accéderez dès la réactivation.</Alert></div>}
      {review && <div className="mb-4"><Alert tone="warning" title="Vérification de facturation en cours">Plusieurs abonnements, un client Stripe inattendu ou un prix d'abonnement non reconnu ont été détectés pour votre espace. Votre abonnement est en cours de vérification : aucune modification automatique n'a été appliquée à votre forfait ni à vos droits, et ils ne sont pas garantis avant la fin de cette vérification. Contactez le support pour régulariser.</Alert></div>}
      {sp.success && <div className="mb-4"><Alert tone="success">Paiement transmis. Votre forfait ne change qu'à la confirmation de Stripe, en quelques secondes : actualisez la page si besoin.</Alert></div>}
      {sp.canceled && <div className="mb-4"><Alert tone="info">Paiement annulé : aucun prélèvement n'a été effectué et votre forfait n'a pas changé.</Alert></div>}

      <Card className="mb-5">
        <div className="flex flex-wrap items-center gap-3"><h2 className="text-lg font-semibold">Plan {e.plan.name}</h2><Badge tone={status.tone}>{status.label}</Badge></div>
        <p className="mt-1 text-sm text-slate-700">{status.summary}</p>
        {(manage.portal || manage.cancel) && <div className="mt-3 flex flex-wrap gap-2">
          {manage.portal && <InlineAction action={portalAction} size="md" variant="secondary">Moyen de paiement et factures</InlineAction>}
          {manage.cancel === "resume" && <InlineAction action={cancelAction} size="md" variant="primary" hidden={{ cancel: "0" }}>Reprendre l'abonnement</InlineAction>}
          {manage.cancel === "cancel" && <InlineAction action={cancelAction} size="md" variant="danger" hidden={{ cancel: "1" }} confirm="Résilier à la fin de la période en cours ?">Résilier</InlineAction>}
        </div>}
        {manage.endTrial && <div className="mt-3"><InlineAction action={cancelAction} size="md" variant="ghost" hidden={{ cancel: "1" }} confirm="Terminer l'essai maintenant ? L'accès sera suspendu.">Terminer l'essai</InlineAction></div>}
        {manage.note && <p className="mt-3 text-sm font-medium text-slate-700">{manage.note}</p>}
      </Card>

      {!exempt && !setup.anyReady && !owner && (
        <div className="mb-5"><Alert tone="info" title="Paiement indisponible">Le paiement en ligne est temporairement indisponible. Votre forfait actuel et vos données sont conservés. Contactez le propriétaire de l'espace pour toute question de facturation.</Alert></div>
      )}
      {!exempt && !setup.anyReady && owner && (
        <div className="mb-5"><Alert tone="warning" title="Paiement : configuration requise">
          <p>La souscription est indisponible : le paiement en ligne n'est pas (entièrement) configuré sur ce serveur. Aucun clic ne peut activer un forfait payant et aucun paiement n'est simulé. Votre forfait actuel et vos données sont conservés{e.state === "trial" ? ", et l'essai gratuit reste utilisable" : ""}.</p>
          <p className="mt-2 font-medium">Variables serveur attendues :</p>
          <ul className="mt-1 space-y-1">{setup.variables.map((v) => <li key={v.name} className="flex items-center gap-2"><code className="rounded bg-white/70 px-1 py-0.5 text-xs">{v.name}</code><Badge tone={v.valid ? "green" : "orange"}>{v.valid ? "définie" : v.set ? "invalide" : "manquante"}</Badge></li>)}</ul>
          {setup.issues.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5">{setup.issues.map((m) => <li key={m}>{m}</li>)}</ul>}
          <p className="mt-2 font-medium">Pour activer le paiement :</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5">
            <li>Créer dans Stripe un prix récurrent pour chaque forfait et renseigner son identifiant dans la variable correspondante (un prix distinct par forfait).</li>
            <li>Définir <code className="text-xs">STRIPE_SECRET_KEY</code> sur le serveur.</li>
            <li>Déclarer dans Stripe un point de terminaison de webhook vers <code className="text-xs">/api/stripe/webhook</code> de votre domaine, puis renseigner son secret dans <code className="text-xs">STRIPE_WEBHOOK_SECRET</code>.</li>
            <li>Abonner ce point de terminaison aux événements : {STRIPE_WEBHOOK_EVENTS.map((ev, i) => <span key={ev}>{i > 0 && ", "}<code className="text-xs">{ev}</code></span>)}.</li>
          </ol>
          <p className="mt-2 text-xs">Le forfait n'est jamais modifié sur un simple clic : il change uniquement quand Stripe confirme l'abonnement.</p>
        </Alert></div>
      )}
      {!owner && <div className="mb-5"><Alert tone="info">Seul le propriétaire de l'espace peut modifier l'abonnement.</Alert></div>}

      <h2 className="mb-3 text-lg font-semibold">Forfaits</h2>
      <ul className="mb-5 grid gap-4 lg:grid-cols-3">
        {PLAN_IDS.map((id) => {
          const p = PLANS[id];
          const acts = planActions({ planId: id, currentPlanId: e.plan.id, state: e.state, owner, hasStripeSubscription: paid, checkoutReady: setup.ready[id] });
          const label = env.planPriceLabel(id);
          return (
            <li key={id}><Card className={`flex h-full flex-col ${id === e.plan.id ? "ring-2 ring-brand-600" : ""}`}>
              <h3 className="text-lg font-bold">{p.name}</h3>
              <p className="mt-1 text-sm text-slate-600">{p.tagline}</p>
              <p className="mt-3 text-sm font-semibold">{label ?? "Tarif affiché lors de la souscription"}</p>
              <ul className="mt-3 flex-1 list-disc space-y-1 pl-5 text-sm">{p.features.map((f) => <li key={f}>{f}</li>)}</ul>
              {acts.length > 0 && <div className="mt-4 flex flex-wrap items-start gap-2">{acts.map((a, i) => render(id, a, i))}</div>}
              {hasTry(id) && <p className="mt-2 text-xs text-slate-500">Essai : aucun paiement ; les limites de ce plan s'appliquent jusqu'à la fin de l'essai.</p>}
            </Card></li>
          );
        })}
      </ul>

      <Section title="Comparaison des forfaits" description="Limites appliquées à chaque forfait : mêmes valeurs que celles qui s'appliquent réellement à votre espace.">
        <TableWrap caption="Limites par forfait">
          <thead><tr><Th>Limite</Th>{PLAN_IDS.map((id) => <Th key={id}>{PLANS[id].name}</Th>)}</tr></thead>
          <tbody>{(Object.keys(PLANS.starter.limits) as (keyof PlanLimits)[]).map((k) => (
            <tr key={k}><RowTh>{TABLE_LABEL[k]}</RowTh>{PLAN_IDS.map((id) => <Td key={id} className="tabular-nums">{limitText(PLANS[id].limits[k])}</Td>)}</tr>
          ))}</tbody>
        </TableWrap>
      </Section>

      <Section title="Usage" description={`Utilisation actuelle par rapport aux limites de votre forfait ${e.plan.name}. Les leads sont comptés par mois calendaire (UTC), hors prospects effacés ; leur seuil est indicatif et n'interrompt pas la capture.`}>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(Object.keys(e.plan.limits) as (keyof PlanLimits)[]).filter((k) => k !== "aiGenerationsPerDay").map((k) => {
            const lim = e.plan.limits[k];
            const used = usage[k];
            const pct = lim === UNLIMITED ? 0 : lim === 0 ? (used > 0 ? 100 : 0) : Math.min(100, (used / lim) * 100); // limite 0 (droit non inclus) : jamais de division par zéro
            return (
              <li key={k} className="rounded-lg border border-slate-200 p-3 text-sm"><div className="flex justify-between"><span>{LIMIT_LABEL[k]}</span><span className="tabular-nums font-medium">{used} / {limitText(lim)}</span></div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={used} aria-valuemin={0} aria-valuemax={lim === UNLIMITED ? undefined : lim} aria-label={LIMIT_LABEL[k]}><div className={`h-full ${pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-brand-600"}`} style={{ width: `${pct}%` }} /></div>
                {lim !== UNLIMITED && used > lim && (INFORMATIVE_LIMITS.includes(k)
                  ? <p className="mt-1 text-xs text-amber-700">Seuil indicatif dépassé ce mois-ci : la capture de vos leads n'est pas interrompue.</p>
                  : <p className="mt-1 text-xs text-red-700">Limite dépassée : passez à un plan supérieur.</p>)}</li>
            );
          })}
        </ul>
      </Section>
    </>
  );
}
