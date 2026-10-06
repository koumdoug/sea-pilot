import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { requireCtx } from "@/lib/tenant";
import { providerStatus } from "@/lib/ai/providers";
import type { CampaignProposal } from "@/lib/ai/prompts";
import { launchBlockers, utmDefaults } from "@/lib/campaigns";
import { CAMPAIGN_OBJECTIVES, OBJECTIVE_LABEL, PLATFORMS, PLATFORM_LABEL } from "@/lib/constants";
import { pageUrl } from "@/lib/landing";
import { env } from "@/lib/env";
import { ActionForm, InlineAction, SelectField, SubmitButton, TextAreaField, TextField } from "@/components/forms";
import { Alert, Badge, Card, ConfigRequired, PageHeader, cx } from "@/components/ui";
import { adoptAngleAction, generateCampaignProposalAction, saveCampaignStepAction, transitionCampaignAction } from "../../actions";

export const metadata: Metadata = { title: "Campaign Builder" };

const STEPS = ["Objectif", "Audience", "Offre", "Message", "Plateforme", "Budget", "Landing page", "Créatifs", "Tracking", "Lancement"];
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");

export default async function BuildPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ step?: string }> }) {
  const ctx = await requireCtx({ action: "write" });
  const { id } = await params;
  const sp = await searchParams;
  const c = await db.campaign.findFirst({ where: { id, workspaceId: ctx.workspaceId }, include: { offer: true, audience: true, landingPage: true } });
  if (!c) notFound();
  if (!["draft", "ready", "paused"].includes(c.status)) redirect(`/campaigns/${c.id}`);
  const step = Math.min(10, Math.max(1, Number(sp.step) || c.builderStep));
  const hidden = (<><input type="hidden" name="id" value={c.id} /><input type="hidden" name="step" value={step} /></>);
  const prevHref = step > 1 ? `/campaigns/${c.id}/build?step=${step - 1}` : `/campaigns/${c.id}`;
  const msg = (c.message ?? {}) as { proposal?: CampaignProposal; proposalModel?: string; manual?: { angle?: string; valueProposition?: string; message?: string; cta?: string } };
  const ai = providerStatus();

  const [audiences, offers, pages, adCount] = await Promise.all([
    step === 2 ? db.audience.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { name: "asc" } }) : [],
    step === 3 ? db.offer.findMany({ where: { workspaceId: ctx.workspaceId, status: { not: "archived" } }, orderBy: { name: "asc" } }) : [],
    step >= 7 ? db.landingPage.findMany({ where: { workspaceId: ctx.workspaceId, status: { not: "archived" } }, orderBy: { name: "asc" } }) : [],
    step === 8 || step === 10 ? db.ad.count({ where: { workspaceId: ctx.workspaceId, campaignId: c.id } }) : 0,
  ]);

  return (
    <>
      <PageHeader title={c.name} subtitle={<><Link href={`/campaigns/${c.id}`} className="underline">← Fiche de la campagne</Link> · Campaign Builder, étape {step} sur 10</>} />
      <ol className="mb-5 flex flex-wrap gap-1.5" aria-label="Étapes du Campaign Builder">
        {STEPS.map((s, i) => (
          <li key={s}><Link href={`/campaigns/${c.id}/build?step=${i + 1}`} aria-current={i + 1 === step ? "step" : undefined}
            className={cx("inline-flex min-h-9 items-center rounded-full px-3 text-xs font-semibold", i + 1 === step ? "bg-brand-600 text-white" : i + 1 <= c.builderStep ? "bg-brand-50 text-brand-700" : "bg-slate-100 text-slate-500")}>{i + 1}. {s}</Link></li>
        ))}
      </ol>

      <Card className="max-w-3xl">
        {step === 1 && (
          <ActionForm action={saveCampaignStepAction}>{hidden}
            <h2 className="text-lg font-semibold">1. Objectif</h2>
            <TextField name="name" label="Nom" required defaultValue={c.name} />
            <SelectField name="objective" label="Objectif principal" required defaultValue={c.objective} options={CAMPAIGN_OBJECTIVES.map((o) => [o, OBJECTIVE_LABEL[o]] as const)} />
            <Nav prev={prevHref} />
          </ActionForm>
        )}
        {step === 2 && (
          <ActionForm action={saveCampaignStepAction}>{hidden}
            <h2 className="text-lg font-semibold">2. Audience</h2>
            {audiences.length === 0 ? <Alert tone="warning">Aucune audience. <Link href="/offers" className="underline">Créez-en une</Link> puis revenez ici.</Alert> : <SelectField name="audienceId" label="Audience ciblée" required defaultValue={c.audienceId} options={audiences.map((a) => [a.id, `${a.name} (${a.type.toUpperCase()})`] as const)} placeholder="Choisir…" />}
            {c.audience && <p className="text-sm text-slate-600">Besoins : {c.audience.needs ?? "—"} · Objections : {c.audience.objections ?? "—"}</p>}
            <Nav prev={prevHref} />
          </ActionForm>
        )}
        {step === 3 && (
          <ActionForm action={saveCampaignStepAction}>{hidden}
            <h2 className="text-lg font-semibold">3. Offre</h2>
            {offers.length === 0 ? <Alert tone="warning">Aucune offre. <Link href="/offers?new=1" className="underline">Créez-en une</Link> puis revenez ici.</Alert> : <SelectField name="offerId" label="Offre promue" required defaultValue={c.offerId} options={offers.map((o) => [o.id, o.name] as const)} placeholder="Choisir…" />}
            <Nav prev={prevHref} />
          </ActionForm>
        )}
        {step === 4 && (
          <div className="space-y-5">
            <h2 className="text-lg font-semibold">4. Message</h2>
            <section aria-labelledby="ia-h" className="space-y-3 rounded-lg border border-slate-200 p-3">
              <div className="flex items-center justify-between gap-2"><h3 id="ia-h" className="text-sm font-semibold">Proposition de l'IA</h3><Badge tone="purple">Hypothèses IA</Badge></div>
              {!ai.configured ? <ConfigRequired env={["OPENAI_API_KEY + OPENAI_MODEL", "ANTHROPIC_API_KEY", "GEMINI_API_KEY + GEMINI_MODEL"]}>Sans IA configurée, rédigez votre message manuellement ci-dessous.</ConfigRequired>
                : <ActionForm action={generateCampaignProposalAction} className="!space-y-0"><input type="hidden" name="id" value={c.id} /><SubmitButton variant="secondary" pendingLabel="Analyse en cours…">{msg.proposal ? "Régénérer la proposition" : "Analyser et proposer des angles"}</SubmitButton></ActionForm>}
              {msg.proposal && <Proposal p={msg.proposal} campaignId={c.id} model={msg.proposalModel} />}
            </section>
            <ActionForm action={saveCampaignStepAction}>{hidden}
              <h3 className="text-sm font-semibold">Votre message</h3>
              <TextField name="angle" label="Angle" defaultValue={msg.manual?.angle} maxLength={300} />
              <TextAreaField name="valueProposition" label="Proposition de valeur" rows={2} defaultValue={msg.manual?.valueProposition} />
              <TextAreaField name="message" label="Message publicitaire principal" rows={3} defaultValue={msg.manual?.message} />
              <TextField name="cta" label="Appel à l'action (CTA)" defaultValue={msg.manual?.cta} maxLength={80} />
              <Nav prev={prevHref} />
            </ActionForm>
          </div>
        )}
        {step === 5 && (
          <ActionForm action={saveCampaignStepAction}>{hidden}
            <h2 className="text-lg font-semibold">5. Plateforme</h2>
            <SelectField name="platform" label="Plateforme principale" required defaultValue={c.platform} options={PLATFORMS.map((p) => [p, PLATFORM_LABEL[p]] as const)} />
            <Nav prev={prevHref} />
          </ActionForm>
        )}
        {step === 6 && (
          <ActionForm action={saveCampaignStepAction}>{hidden}
            <h2 className="text-lg font-semibold">6. Budget et calendrier</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField name="budget" label={`Budget (${ctx.workspace.currency})`} type="number" required min={1} step="0.01" defaultValue={c.budget} />
              <SelectField name="budgetType" label="Type de budget" required defaultValue={c.budgetType} options={[["daily", "Par jour"], ["monthly", "Par mois"], ["total", "Total de la campagne"]]} />
              <TextField name="startDate" label="Début" type="date" defaultValue={iso(c.startDate)} />
              <TextField name="endDate" label="Fin" type="date" defaultValue={iso(c.endDate)} />
            </div>
            <Nav prev={prevHref} />
          </ActionForm>
        )}
        {step === 7 && (
          <ActionForm action={saveCampaignStepAction}>{hidden}
            <h2 className="text-lg font-semibold">7. Landing page</h2>
            <SelectField name="landingPageId" label="Page de destination" defaultValue={c.landingPageId} options={pages.map((p) => [p.id, `${p.name} — ${p.status === "published" ? "publiée" : "brouillon"}`] as const)} placeholder="— aucune —" help="Pour activer une campagne de leads ou de ventes, la page doit être publiée." />
            <p className="text-sm"><Link href="/landing-pages" className="text-brand-700 underline">Gérer mes landing pages</Link></p>
            <Nav prev={prevHref} />
          </ActionForm>
        )}
        {step === 8 && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">8. Créatifs</h2>
            <p className="text-sm">{adCount} annonce(s) rattachée(s) à cette campagne.</p>
            <Link href={`/ai-studio?campaignId=${c.id}`} className="inline-flex min-h-11 items-center rounded-lg border border-slate-300 px-4 text-sm font-semibold hover:bg-slate-50">Ouvrir l'AI Studio pour cette campagne</Link>
            <ActionForm action={saveCampaignStepAction}>{hidden}<Nav prev={prevHref} label="Étape suivante" /></ActionForm>
          </div>
        )}
        {step === 9 && <TrackingStep c={c} hidden={hidden} prev={prevHref} wsSlug={ctx.workspace.slug} pages={pages} />}
        {step === 10 && <LaunchStep c={c} pageStatus={pages.find((p) => p.id === c.landingPageId)?.status} adCount={adCount} prev={prevHref} />}
      </Card>
    </>
  );
}

function Nav({ prev, label = "Enregistrer et continuer" }: { prev: string; label?: string }) {
  return <div className="flex flex-wrap items-center justify-between gap-2 pt-2"><Link href={prev} className="inline-flex min-h-11 items-center rounded-lg border border-slate-300 px-4 text-sm font-semibold hover:bg-slate-50">← Retour</Link><SubmitButton>{label}</SubmitButton></div>;
}

function Proposal({ p, campaignId, model }: { p: CampaignProposal; campaignId: string; model?: string }) {
  return (
    <div className="space-y-3 text-sm">
      <div><p className="font-semibold">Angles proposés</p>
        <ul className="mt-1 space-y-2">{p.angles.map((a, i) => (
          <li key={a.angle} className="rounded border border-slate-200 p-2"><p className="font-medium">{a.angle}</p><p className="text-slate-700">{a.valueProposition}</p>{a.rationale && <p className="text-xs text-slate-500">{a.rationale}</p>}
            <div className="mt-1"><InlineAction action={adoptAngleAction} hidden={{ id: campaignId, index: String(i) }}>Utiliser cet angle</InlineAction></div></li>
        ))}</ul></div>
      {p.messages.length > 0 && <div><p className="font-semibold">Messages et variantes</p><ul className="list-disc pl-5">{p.messages.map((m) => <li key={m.text}>{m.text}{m.variants.length > 0 && <ul className="list-[circle] pl-5 text-slate-600">{m.variants.map((v) => <li key={v}>{v}</li>)}</ul>}</li>)}</ul></div>}
      {p.ctas.length > 0 && <div><p className="font-semibold">CTA</p><p>{p.ctas.join(" · ")}</p></div>}
      {p.objections.length > 0 && <div><p className="font-semibold">Objections à traiter</p><ul className="list-disc pl-5">{p.objections.map((o) => <li key={o}>{o}</li>)}</ul></div>}
      {(p.audience.description || p.audience.targeting.length > 0) && <div><p className="font-semibold">Audience suggérée</p><p>{p.audience.description}</p>{p.audience.targeting.length > 0 && <p className="text-slate-600">{p.audience.targeting.join(" · ")}</p>}</div>}
      {p.testHypotheses.length > 0 && <div><p className="font-semibold">Hypothèses de test</p><ul className="list-disc pl-5">{p.testHypotheses.map((h) => <li key={h.hypothesis}><strong>{h.hypothesis}</strong> — {h.test} (métrique : {h.metric})</li>)}</ul></div>}
      {model && <p className="text-xs text-slate-500">Généré par {model}</p>}
    </div>
  );
}

function TrackingStep({ c, hidden, prev, wsSlug, pages }: { c: { id: string; name: string; platform: string; landingPageId: string | null; tracking: unknown }; hidden: React.ReactNode; prev: string; wsSlug: string; pages: { id: string; slug: string; status: string }[] }) {
  const t = (c.tracking ?? {}) as { utmContent?: string | null; utmTerm?: string | null };
  const page = pages.find((p) => p.id === c.landingPageId);
  const utm = { ...utmDefaults(c), ...(t.utmContent ? { utm_content: t.utmContent } : {}), ...(t.utmTerm ? { utm_term: t.utmTerm } : {}) };
  const dest = page ? `${pageUrl(env.appUrl, wsSlug, page.slug)}?${new URLSearchParams(utm).toString()}` : null;
  return (
    <ActionForm action={saveCampaignStepAction}>{hidden}
      <h2 className="text-lg font-semibold">9. Tracking</h2>
      <p className="text-sm text-slate-700">Les paramètres UTM sont conservés sur chaque lead. <code>utm_campaign</code> contient l'identifiant de cette campagne : les leads lui sont rattachés automatiquement.</p>
      <div className="grid gap-4 sm:grid-cols-2"><TextField name="utmContent" label="utm_content (optionnel)" defaultValue={t.utmContent ?? ""} /><TextField name="utmTerm" label="utm_term (optionnel)" defaultValue={t.utmTerm ?? ""} /></div>
      {dest ? (<div><p className="text-sm font-medium">URL de destination à utiliser dans vos annonces</p><code className="mt-1 block break-all rounded bg-slate-100 p-2 text-xs">{dest}</code>{page?.status !== "published" && <p className="mt-1 text-xs text-amber-800">La page n'est pas encore publiée : l'URL fonctionnera après publication.</p>}</div>) : <Alert tone="warning">Aucune landing page choisie à l'étape 7 : pas d'URL de destination.</Alert>}
      <Nav prev={prev} />
    </ActionForm>
  );
}

function LaunchStep({ c, pageStatus, adCount, prev }: { c: { id: string; name: string; platform: string; budget: number | null; objective: string; offerId: string | null; audienceId: string | null; landingPageId: string | null; status: string }; pageStatus?: string; adCount: number; prev: string }) {
  const readyBlock = launchBlockers(c, pageStatus === "published", "ready");
  const activeBlock = launchBlockers(c, pageStatus === "published", "active");
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">10. Lancement</h2>
      <ul className="space-y-1 text-sm">
        <Check ok={readyBlock.length === 0} label={readyBlock.length ? `À compléter : ${readyBlock.join(", ")}` : "Informations de base complètes"} />
        <Check ok={pageStatus === "published" || !["leads", "sales"].includes(c.objective)} label={pageStatus === "published" ? "Landing page publiée" : "Landing page publiée requise pour activer"} />
        <Check ok={adCount > 0} label={adCount > 0 ? `${adCount} annonce(s) prête(s)` : "Aucune annonce créée (recommandé : AI Studio)"} soft />
      </ul>
      <Alert tone="info">SEA Pilot suit et analyse vos campagnes ; la diffusion publicitaire elle-même se configure dans la plateforme choisie ({PLATFORM_LABEL[c.platform] ?? c.platform}). Passer en « Active » indique que la campagne est en cours de diffusion.</Alert>
      <div className="flex flex-wrap gap-2">
        <Link href={prev} className="inline-flex min-h-11 items-center rounded-lg border border-slate-300 px-4 text-sm font-semibold hover:bg-slate-50">← Retour</Link>
        {c.status === "draft" && <InlineAction action={transitionCampaignAction} variant="secondary" size="md" hidden={{ id: c.id, to: "ready" }}>Marquer comme prête</InlineAction>}
        {(c.status === "ready" || c.status === "paused") && activeBlock.length === 0 && <InlineAction action={transitionCampaignAction} variant="primary" size="md" hidden={{ id: c.id, to: "active" }}>Activer la campagne</InlineAction>}
        <Link href={`/campaigns/${c.id}`} className="inline-flex min-h-11 items-center rounded-lg px-4 text-sm font-semibold text-brand-700 underline">Voir la fiche</Link>
      </div>
      {activeBlock.length > 0 && <p className="text-sm text-amber-800">Pour activer : {activeBlock.join(", ")}.</p>}
    </div>
  );
}

function Check({ ok, label, soft }: { ok: boolean; label: string; soft?: boolean }) {
  return <li className="flex items-center gap-2"><span aria-hidden="true">{ok ? "✅" : soft ? "⚠️" : "⬜"}</span>{label}</li>;
}
