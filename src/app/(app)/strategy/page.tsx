import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/db";
import { requireCtx } from "@/lib/tenant";
import { providerStatus } from "@/lib/ai/providers";
import { CHANNEL_LABEL, INSUFFICIENT, type EconomicsKind, type StrategySheet } from "@/lib/strategy";
import type { StrategyNarrative } from "@/lib/ai/prompts";
import { Alert, Badge, Card, EmptyState, KeyValue, PageHeader, Section, fmtDate } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { PLATFORM_LABEL } from "@/lib/constants";
import { regenerateStrategyAction } from "./actions";

export const metadata: Metadata = { title: "Fiche stratégie d'acquisition" };
const KIND: Record<EconomicsKind, { label: string; tone: "gray" | "blue" | "orange" | "red" }> = { input: { label: "Saisi", tone: "gray" }, calculated: { label: "Calculé", tone: "blue" }, estimated: { label: "Estimé", tone: "orange" }, insufficient: { label: INSUFFICIENT, tone: "red" } };

export default async function StrategyPage({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const latest = await db.strategy.findFirst({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: "desc" } });
  const content = latest?.content as { sheet: StrategySheet; narrative: StrategyNarrative | null } | undefined;
  const sheet = content?.sheet;
  const narrative = content?.narrative;
  const ai = providerStatus();

  return (
    <>
      <PageHeader title="Fiche stratégie d'acquisition" subtitle={latest ? `Générée le ${fmtDate(latest.createdAt, true)} à partir de votre onboarding.` : undefined}
        actions={ctx.can("write") ? <ActionForm action={regenerateStrategyAction} className="!space-y-0"><SubmitButton variant="secondary" pendingLabel="Calcul…">Recalculer la fiche</SubmitButton></ActionForm> : undefined} />
      {sp.welcome && <div className="mb-5"><Alert tone="success" title="Votre espace est prêt !">Voici votre première fiche stratégie. Prochaine étape : <Link className="underline" href="/offers">affiner votre offre</Link>, puis <Link className="underline" href="/campaigns/new">créer votre première campagne</Link>.</Alert></div>}
      {!sheet ? <EmptyState title="Aucune fiche générée">Terminez l'onboarding ou cliquez sur « Recalculer la fiche ».</EmptyState> : (
        <>
          <Section title="Positionnement">
            <KeyValue items={[["Offre", sheet.positioning.offer], ["Cible", sheet.positioning.audience], ["Différenciation", sheet.positioning.differentiation ?? "Non renseignée"], ["Avantages", sheet.positioning.advantages.join(" · ") || "Non renseignés"], ["Fonctionnalités vérifiées", sheet.positioning.verifiedFeatures?.length ? sheet.positioning.verifiedFeatures.join(" · ") : "Aucune fonctionnalité vérifiée enregistrée"], ["Objections à traiter", sheet.positioning.objections.join(" · ") || "Non renseignées"]]} />
            {!!sheet.positioning.unverifiedFeatures?.length && <div className="mt-3"><Alert tone="warning" title="Fonctionnalités à confirmer">Ne les présentez pas comme existantes avant vérification : {sheet.positioning.unverifiedFeatures.join(" · ")}.</Alert></div>}
            {!!sheet.positioning.gaps?.length && <div className="mt-3 space-y-2">{sheet.positioning.gaps.map((g) => <Alert key={g} tone="info">{g}</Alert>)}</div>}
          </Section>

          <Section title="Économie du tunnel" description="Calculs réalisés à partir de VOS chiffres. « Saisi » = fourni par vous ; « Calculé » = formule appliquée à vos chiffres ; « Estimé » = dépend de votre marge approximative, ce n'est pas une marge mesurée ; « Données insuffisantes » = information absente, rien n'est supposé.">
            {sheet.economics.length === 0 ? <p className="text-sm text-slate-500">Renseignez prix, marge et objectifs pour obtenir ces calculs.</p> : (
              <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {sheet.economics.map((e) => (
                  <div key={e.label} className="rounded-lg border border-slate-200 p-3">
                    <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{e.label} <Badge tone={(KIND[e.kind] ?? KIND.calculated).tone}>{(KIND[e.kind] ?? KIND.calculated).label}</Badge></dt>
                    <dd className={e.kind === "insufficient" ? "mt-1 text-base font-semibold text-slate-600" : "mt-1 text-xl font-bold tabular-nums"}>{e.value}</dd>
                    {e.note && <p className="text-xs text-slate-500">{e.note}</p>}
                  </div>
                ))}
              </dl>
            )}
            <div className="mt-3 space-y-2">{sheet.alerts.map((a) => <Alert key={a.text} tone={a.level === "warning" ? "warning" : "info"}>{a.text}</Alert>)}</div>
          </Section>

          <Section title="Canaux recommandés" description="Hypothèses de départ à valider par des tests : aucune performance n'a été observée. La répartition indique une part du budget publicitaire, pas un résultat attendu.">
            {!sheet.channels.some((c) => c.kind === "paid") && sheet.channels.some((c) => c.kind) && <div className="mb-3"><Alert tone="info">Aucun canal payant recommandé : le budget publicitaire n'est pas renseigné ou est nul. Les canaux organiques ci-dessous ne demandent pas de budget média.</Alert></div>}
            <ul className="grid gap-3 sm:grid-cols-3">
              {sheet.channels.map((c) => (
                <li key={c.platform} className="rounded-lg border border-slate-200 p-3"><p className="font-semibold">{CHANNEL_LABEL[c.platform] ?? PLATFORM_LABEL[c.platform] ?? c.platform} {c.kind === "organic" ? <Badge tone="green">Organique</Badge> : <><Badge tone="blue">{c.share} % du budget</Badge> {c.kind === "paid" && <Badge tone="gray">Payant</Badge>}</>}</p><p className="mt-1 text-sm text-slate-700">{c.why}</p><p className="mt-1 text-xs text-slate-500">Hypothèse</p></li>
              ))}
            </ul>
          </Section>

          <Section title="Premières actions">
            <ol className="list-decimal space-y-1 pl-5 text-sm">{sheet.firstSteps.map((s) => <li key={s}>{s}</li>)}</ol>
          </Section>

          <Section title="Analyse IA" description="Texte généré par l'IA à partir de la fiche chiffrée ci-dessus : ce sont des hypothèses, pas des données vérifiées." actions={<Badge tone="purple">Généré par IA</Badge>}>
            {narrative ? (
              <div className="space-y-3 text-sm">
                <p>{narrative.summary}</p>
                {narrative.channelRationale.length > 0 && <div><p className="font-semibold">Justification des canaux</p><ul className="list-disc pl-5">{narrative.channelRationale.map((c) => <li key={c.platform}><strong>{c.platform}</strong> : {c.why}</li>)}</ul></div>}
                {narrative.risks.length > 0 && <div><p className="font-semibold">Risques</p><ul className="list-disc pl-5">{narrative.risks.map((r) => <li key={r}>{r}</li>)}</ul></div>}
                {narrative.firstSteps.length > 0 && <div><p className="font-semibold">Actions proposées</p><ol className="list-decimal pl-5">{narrative.firstSteps.map((r) => <li key={r}>{r}</li>)}</ol></div>}
                {([["Différenciation possible", narrative.differentiationHypotheses], ["Avantages possibles", narrative.advantageHypotheses], ["Objections probables et pistes de réponse", narrative.objectionHypotheses]] as const).map(([title, items]) => items && items.length > 0 && <div key={title}><p className="font-semibold">{title} <Badge tone="orange">Hypothèses à valider</Badge></p><ul className="list-disc pl-5">{items.map((r) => <li key={r}>{r}</li>)}</ul></div>)}
                {narrative.missingInfo && narrative.missingInfo.length > 0 && <div><p className="font-semibold">Informations à compléter</p><ul className="list-disc pl-5">{narrative.missingInfo.map((r) => <li key={r}>{r}</li>)}</ul></div>}
              </div>
            ) : ai.configured ? <p className="text-sm text-slate-500">Aucune analyse IA sur cette version : cliquez sur « Recalculer la fiche » pour la générer.</p>
              : <Alert tone="warning" title="Configuration requise">L'analyse IA nécessite un fournisseur d'IA configuré sur le serveur (voir le README). La fiche chiffrée ci-dessus fonctionne sans IA.</Alert>}
          </Section>

          <Card><h2 className="text-sm font-semibold">Hypothèses</h2><ul className="mt-1 list-disc pl-5 text-sm text-slate-700">{sheet.assumptions.map((a) => <li key={a}>{a}</li>)}</ul></Card>
        </>
      )}
    </>
  );
}
