import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireCtx } from "@/lib/tenant";
import { loadAnalytics, defaultRange } from "@/lib/analytics";
import { CAMPAIGN_STATUS_LABEL, CAMPAIGN_TRANSITIONS, LEAD_STATUS_LABEL, OBJECTIVE_LABEL, PLATFORM_LABEL, type CampaignStatus } from "@/lib/constants";
import { utmDefaults } from "@/lib/campaigns";
import { fmtMoney, fmtNum, fmtPct, fmtRatio } from "@/lib/kpi";
import { pageUrl } from "@/lib/landing";
import { env } from "@/lib/env";
import { Badge, CAMPAIGN_STATUS_TONE, EmptyState, KeyValue, LinkButton, PageHeader, Section, StatTile, TableWrap, Td, Th, fmtDate } from "@/components/ui";
import { ActionForm, InlineAction, SelectField, SubmitButton, TextField } from "@/components/forms";
import { addKeywordAction, addMetricAction, deleteCampaignAction, deleteKeywordAction, deleteMetricAction, duplicateCampaignAction, transitionCampaignAction } from "../actions";

export const metadata: Metadata = { title: "Campagne" };
const TRANSITION_LABEL: Record<string, string> = { ready: "Marquer prête", active: "Activer", paused: "Mettre en pause", completed: "Terminer", archived: "Archiver", draft: "Repasser en brouillon" };

export default async function CampaignDetail({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx();
  const { id } = await params;
  const c = await db.campaign.findFirst({ where: { id, workspaceId: ctx.workspaceId }, include: { offer: true, audience: true, landingPage: true } });
  if (!c) notFound();
  const cur = ctx.workspace.currency;
  const { from, to } = defaultRange(90);
  const [a, metrics, ads, keywords, leads] = await Promise.all([
    loadAnalytics(ctx.workspaceId, { from, to, campaignId: c.id }),
    db.metric.findMany({ where: { workspaceId: ctx.workspaceId, campaignId: c.id }, orderBy: { date: "desc" }, take: 14 }),
    db.ad.findMany({ where: { workspaceId: ctx.workspaceId, campaignId: c.id }, orderBy: { createdAt: "desc" }, take: 10 }),
    db.keyword.findMany({ where: { workspaceId: ctx.workspaceId, campaignId: c.id }, orderBy: { createdAt: "desc" } }),
    db.lead.findMany({ where: { workspaceId: ctx.workspaceId, campaignId: c.id, deletedAt: null }, orderBy: { createdAt: "desc" }, take: 8 }),
  ]);
  const k = a.kpis;
  const transitions = CAMPAIGN_TRANSITIONS[c.status as CampaignStatus] ?? [];
  const editable = ["draft", "ready", "paused"].includes(c.status);
  const utm = utmDefaults(c);
  const dest = c.landingPage ? `${pageUrl(env.appUrl, ctx.workspace.slug, c.landingPage.slug)}?${new URLSearchParams(utm).toString()}` : null;
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHeader
        title={c.name}
        subtitle={<><Link href="/campaigns" className="underline">← Campagnes</Link> · <Badge tone={CAMPAIGN_STATUS_TONE[c.status]}>{CAMPAIGN_STATUS_LABEL[c.status as CampaignStatus]}</Badge> · {PLATFORM_LABEL[c.platform] ?? c.platform}</>}
        actions={ctx.can("write") ? <>
          {editable && <LinkButton href={`/campaigns/${c.id}/build`} variant="secondary">Modifier (Builder)</LinkButton>}
          {transitions.filter((t) => t !== "draft").map((t) => <InlineAction key={t} action={transitionCampaignAction} size="md" variant={t === "active" ? "primary" : "secondary"} hidden={{ id: c.id, to: t }}>{TRANSITION_LABEL[t]}</InlineAction>)}
          <InlineAction action={duplicateCampaignAction} size="md" hidden={{ id: c.id }}>Dupliquer</InlineAction>
        </> : undefined}
      />

      <section aria-label="Indicateurs sur 90 jours" className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <StatTile label="Dépense" value={a.hasSpendData ? fmtMoney(k.spend, cur) : "—"} hint="90 derniers jours" />
        <StatTile label="Clics" value={a.hasSpendData ? fmtNum(k.clicks) : "—"} />
        <StatTile label="CTR" value={fmtPct(k.ctr, 2)} />
        <StatTile label="CPC" value={fmtMoney(k.cpc, cur)} />
        <StatTile label="Leads" value={fmtNum(k.leads)} />
        <StatTile label="CPL" value={fmtMoney(k.cpl, cur)} />
        <StatTile label="Qualifiés" value={fmtNum(k.qualifiedLeads)} />
        <StatTile label="Clients" value={fmtNum(k.customers)} />
        <StatTile label="CAC" value={fmtMoney(k.cac, cur)} />
        <StatTile label="CA attribué" value={k.revenue > 0 ? fmtMoney(k.revenue, cur) : "—"} />
        <StatTile label="ROAS" value={fmtRatio(k.roas)} />
        <StatTile label="ROI" value={k.roi === null ? "—" : fmtPct(k.roi, 0)} />
      </section>

      <Section title="Paramètres">
        <KeyValue items={[
          ["Objectif", OBJECTIVE_LABEL[c.objective] ?? c.objective], ["Budget", c.budget ? `${fmtMoney(c.budget, cur)} (${{ daily: "par jour", monthly: "par mois", total: "total" }[c.budgetType as "daily"]})` : "—"],
          ["Audience", c.audience?.name], ["Offre", c.offer?.name], ["Landing page", c.landingPage ? <Link key="lp" href={`/landing-pages/${c.landingPage.id}`} className="underline">{c.landingPage.name}</Link> : "—"],
          ["Calendrier", c.startDate || c.endDate ? `${fmtDate(c.startDate)} → ${fmtDate(c.endDate)}` : "Non planifié"],
        ]} />
        {dest && <div className="mt-3"><p className="text-xs font-medium uppercase text-slate-500">URL de destination avec UTM</p><code className="block break-all rounded bg-slate-100 p-2 text-xs">{dest}</code></div>}
        {ctx.can("delete") && c.status === "draft" && <div className="mt-3"><InlineAction action={deleteCampaignAction} variant="danger" hidden={{ id: c.id }} confirm="Supprimer cette campagne brouillon ?">Supprimer le brouillon</InlineAction></div>}
      </Section>

      <Section title="Dépenses et performances publicitaires" description="Saisie manuelle par jour. Les plateformes connectées dans « Integrations » alimentent ce tableau automatiquement.">
        {ctx.can("write") && (
          <ActionForm action={addMetricAction} className="mb-4 grid items-end gap-3 sm:grid-cols-5 !space-y-0" resetOnSuccess>
            <input type="hidden" name="campaignId" value={c.id} />
            <TextField name="date" label="Date" type="date" required defaultValue={today} max={today} />
            <TextField name="spend" label={`Dépense (${cur})`} type="number" step="0.01" min={0} required />
            <TextField name="impressions" label="Impressions" type="number" min={0} step={1} />
            <TextField name="clicks" label="Clics" type="number" min={0} step={1} />
            <SubmitButton>Enregistrer</SubmitButton>
          </ActionForm>
        )}
        {metrics.length === 0 ? <p className="text-sm text-slate-500">Aucune donnée de dépense pour cette campagne.</p> : (
          <TableWrap caption="Dernières données publicitaires">
            <thead><tr><Th>Date</Th><Th className="text-right">Dépense</Th><Th className="text-right">Impressions</Th><Th className="text-right">Clics</Th><Th>Source</Th><Th><span className="sr-only">Actions</span></Th></tr></thead>
            <tbody>{metrics.map((m) => (
              <tr key={m.id}><Td>{fmtDate(m.date)}</Td><Td className="text-right tabular-nums">{fmtMoney(m.spend, cur)}</Td><Td className="text-right tabular-nums">{fmtNum(m.impressions)}</Td><Td className="text-right tabular-nums">{fmtNum(m.clicks)}</Td>
                <Td><Badge>{m.source === "manual" ? "Manuel" : m.source === "csv" ? "Import CSV" : m.source.replace("integration:", "")}</Badge></Td>
                <Td>{ctx.can("delete") && (m.source === "manual" || m.source === "csv") && <InlineAction action={deleteMetricAction} variant="ghost" hidden={{ id: m.id }} confirm="Supprimer cette ligne ?">Supprimer</InlineAction>}</Td></tr>
            ))}</tbody>
          </TableWrap>
        )}
      </Section>

      <div className="grid gap-5 lg:grid-cols-2">
        <Section title="Annonces" actions={<LinkButton href={`/ai-studio?campaignId=${c.id}`} size="sm" variant="secondary">AI Studio</LinkButton>}>
          {ads.length === 0 ? <p className="text-sm text-slate-500">Aucune annonce. Générez-en dans l'AI Studio.</p> : <ul className="space-y-2 text-sm">{ads.map((ad) => <li key={ad.id} className="rounded border border-slate-200 p-2"><p className="font-medium">{ad.headline}{ad.isWinner && <Badge tone="green" className="ml-2">Gagnante</Badge>}</p><p className="text-slate-600">{ad.primaryText ?? ad.description}</p></li>)}</ul>}
        </Section>
        <Section title="Mots-clés">
          {ctx.can("write") && (
            <ActionForm action={addKeywordAction} className="mb-3 flex flex-wrap items-end gap-2 !space-y-0" resetOnSuccess>
              <input type="hidden" name="campaignId" value={c.id} />
              <TextField name="text" label="Mot-clé" required className="min-w-40 flex-1" />
              <SelectField name="matchType" label="Type" required defaultValue="phrase" options={[["broad", "Large"], ["phrase", "Expression"], ["exact", "Exact"], ["negative", "Négatif"]]} />
              <SubmitButton>Ajouter</SubmitButton>
            </ActionForm>
          )}
          {keywords.length === 0 ? <p className="text-sm text-slate-500">Aucun mot-clé.</p> : <ul className="flex flex-wrap gap-2">{keywords.map((kw) => <li key={kw.id} className="flex items-center gap-1 rounded-full bg-slate-100 py-1 pl-3 pr-1 text-sm">{kw.matchType === "negative" ? "−" : ""}{kw.text} <span className="text-xs text-slate-500">({kw.matchType})</span>{ctx.can("write") && <InlineAction action={deleteKeywordAction} variant="ghost" hidden={{ id: kw.id }}>✕</InlineAction>}</li>)}</ul>}
        </Section>
      </div>

      <Section title="Derniers leads" actions={<LinkButton href={`/leads?campaign=${c.id}`} size="sm" variant="secondary">Tous les leads</LinkButton>}>
        {leads.length === 0 ? <EmptyState title="Aucun lead pour cette campagne">Les leads arrivent via la landing page liée (UTM <code>utm_campaign={c.id}</code>) ou l'API.</EmptyState> : (
          <TableWrap caption="Leads de la campagne"><thead><tr><Th>Nom</Th><Th>Statut</Th><Th>Score</Th><Th>Date</Th></tr></thead>
            <tbody>{leads.map((l) => <tr key={l.id}><Td><Link href={`/leads/${l.id}`} className="text-brand-700 underline">{l.name}</Link></Td><Td>{LEAD_STATUS_LABEL[l.status as keyof typeof LEAD_STATUS_LABEL]}</Td><Td>{l.score ?? "—"}</Td><Td>{fmtDate(l.createdAt, true)}</Td></tr>)}</tbody></TableWrap>
        )}
      </Section>
    </>
  );
}
