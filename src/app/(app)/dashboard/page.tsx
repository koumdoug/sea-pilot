import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/db";
import { requireCtx } from "@/lib/tenant";
import { loadInsights } from "@/lib/insights";
import { defaultRange } from "@/lib/analytics";
import { fmtMoney, fmtNum, fmtPct, fmtRatio } from "@/lib/kpi";
import { Alert, Badge, Card, EmptyState, LinkButton, PageHeader, StatTile, TableWrap, Td, Th, fmtDate, type Tone } from "@/components/ui";
import { Funnel, LineChart } from "@/components/charts";
import { InlineAction } from "@/components/forms";
import { markNotificationsReadAction } from "./actions";
import { RecommendationList } from "@/components/recommendation-list";
import { PLATFORM_LABEL } from "@/lib/constants";

export const metadata: Metadata = { title: "Dashboard" };

const HEALTH: Record<string, { label: string; tone: Tone; dot: string }> = {
  good: { label: "Bon", tone: "green", dot: "🟢" },
  watch: { label: "À surveiller", tone: "orange", dot: "🟠" },
  bad: { label: "Problème", tone: "red", dot: "🔴" },
  unknown: { label: "Données insuffisantes", tone: "gray", dot: "⚪" },
};

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const days = [7, 30, 90].includes(Number(sp.days)) ? Number(sp.days) : 30;
  const cur = ctx.workspace.currency;
  const { from, to } = defaultRange(days);
  const { analytics: a, health, recommendations } = await loadInsights(ctx.workspaceId, { from, to }, cur);
  const k = a.kpis;

  const [offers, pages, campaigns, leadsAll, notifications] = await Promise.all([
    db.offer.count({ where: { workspaceId: ctx.workspaceId } }),
    db.landingPage.count({ where: { workspaceId: ctx.workspaceId, status: "published" } }),
    db.campaign.count({ where: { workspaceId: ctx.workspaceId } }),
    db.lead.count({ where: { workspaceId: ctx.workspaceId, deletedAt: null } }),
    db.notification.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: "desc" }, take: 8 }),
  ]);
  const checklist: [string, boolean, string][] = [
    ["Définir votre offre", offers > 0, "/offers"],
    ["Publier une landing page", pages > 0, "/landing-pages"],
    ["Créer une campagne", campaigns > 0, "/campaigns/new"],
    ["Recevoir un premier lead", leadsAll > 0, "/leads"],
    ["Enregistrer vos dépenses publicitaires", a.hasSpendData, "/analytics#donnees"],
  ];
  const doneCount = checklist.filter((c) => c[1]).length;
  const h = HEALTH[health.status];
  const noData = a.totals.leads === 0 && a.totals.spend === 0 && a.totals.impressions === 0;

  return (
    <>
      <PageHeader
        title="Est-ce que mon acquisition fonctionne ?"
        subtitle={`Période : du ${fmtDate(from)} au ${fmtDate(to)}. Tous les chiffres proviennent de vos données réelles ; une valeur « — » signifie qu'elle ne peut pas être calculée.`}
        actions={<div className="flex gap-1" role="group" aria-label="Période">{[7, 30, 90].map((d) => <LinkButton key={d} href={`/dashboard?days=${d}`} variant={d === days ? "primary" : "secondary"} size="sm" aria-current={d === days ? "true" : undefined}>{d} j</LinkButton>)}</div>}
      />

      <Card className="mb-5" aria-labelledby="health-title">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-2xl" aria-hidden="true">{h.dot}</span>
          <div>
            <h2 id="health-title" className="text-lg font-semibold">Santé de l'acquisition : <Badge tone={h.tone}>{h.label}</Badge></h2>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-slate-700">{health.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          </div>
        </div>
        {a.notes.length > 0 && <div className="mt-3 space-y-2">{a.notes.map((n) => <Alert key={n} tone="info">{n}</Alert>)}</div>}
      </Card>

      {doneCount < checklist.length && (
        <Card className="mb-5">
          <h2 className="text-base font-semibold">Pour mesurer votre acquisition ({doneCount}/{checklist.length})</h2>
          <ul className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {checklist.map(([label, ok, href]) => (
              <li key={label}><Link href={href} className="flex min-h-11 items-center gap-2 rounded-lg border border-slate-200 px-3 text-sm hover:bg-slate-50"><span aria-hidden="true">{ok ? "✅" : "⬜"}</span><span className={ok ? "text-slate-500 line-through" : "font-medium"}>{label}</span></Link></li>
            ))}
          </ul>
        </Card>
      )}

      <section aria-label="Indicateurs clés" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatTile label="Dépenses publicitaires" value={a.hasSpendData ? fmtMoney(k.spend, cur) : "—"} hint={a.hasSpendData ? undefined : "aucune dépense saisie"} />
        <StatTile label="Impressions" value={a.hasSpendData ? fmtNum(k.impressions) : "—"} />
        <StatTile label="Clics" value={a.hasSpendData ? fmtNum(k.clicks) : "—"} />
        <StatTile label="CTR" value={fmtPct(k.ctr, 2)} />
        <StatTile label="CPC" value={fmtMoney(k.cpc, cur)} />
        <StatTile label="Leads" value={fmtNum(k.leads)} />
        <StatTile label="CPL" value={fmtMoney(k.cpl, cur)} />
        <StatTile label="Taux de conversion" value={fmtPct(k.cvr)} hint="leads ÷ clics" />
        <StatTile label="Prospects qualifiés" value={fmtNum(k.qualifiedLeads)} hint={k.qualificationRate !== null ? `${fmtPct(k.qualificationRate, 0)} des leads` : undefined} />
        <StatTile label="Clients" value={fmtNum(k.customers)} />
        <StatTile label="CAC" value={fmtMoney(k.cac, cur)} tone={k.cac !== null && ctx.workspace.maxCac && k.cac > ctx.workspace.maxCac ? "red" : undefined} hint={ctx.workspace.maxCac ? `max visé : ${fmtMoney(ctx.workspace.maxCac, cur)}` : undefined} />
        <StatTile label="CA attribué" value={k.revenue > 0 ? fmtMoney(k.revenue, cur) : "—"} />
        <StatTile label="ROAS" value={fmtRatio(k.roas)} />
        <StatTile label="ROI" value={k.roi === null ? "—" : fmtPct(k.roi, 0)} hint={k.roi === null ? "calculable avec dépenses + CA de tous les clients" : undefined} tone={k.roi !== null ? (k.roi < 0 ? "red" : "green") : undefined} />
        <StatTile label="Visites landing pages" value={fmtNum(a.pageviews)} />
      </section>

      {noData ? (
        <div className="mt-5">
          <EmptyState title="Pas encore de données sur la période" action={<LinkButton href="/campaigns/new">Créer ma première campagne</LinkButton>}>
            Dès que vous recevrez des leads et que vous enregistrerez vos dépenses publicitaires, vos indicateurs apparaîtront ici. Rien n'est simulé.
          </EmptyState>
        </div>
      ) : (
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <Card><LineChart integer format={(n) => String(Math.round(n))} title="Leads par jour" labels={a.series.map((p) => p.date)} series={[{ name: "Leads", values: a.series.map((p) => p.leads) }]} /></Card>
          <Card><LineChart title={`Dépenses par jour (${cur})`} labels={a.series.map((p) => p.date)} series={[{ name: "Dépenses", values: a.series.map((p) => p.spend), color: "#f59e0b" }]} /></Card>
          <Card><h2 className="mb-3 text-sm font-semibold">Entonnoir d'acquisition</h2>
            <Funnel steps={[...(a.hasSpendData ? [{ label: "Impressions", value: k.impressions }, { label: "Clics", value: k.clicks }] : []), { label: "Leads", value: k.leads }, { label: "Leads qualifiés", value: k.qualifiedLeads }, { label: "Clients", value: k.customers }]} /></Card>
          <Card>
            <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold">Recommandations prioritaires</h2><Link href="/analytics#recommandations" className="text-sm text-brand-700 underline">Tout voir</Link></div>
            <RecommendationList items={recommendations.slice(0, 3)} compact empty="Aucun problème détecté sur les données disponibles." />
          </Card>
        </div>
      )}

      {a.campaigns.length > 0 && (
        <div className="mt-5">
          <h2 className="mb-2 text-base font-semibold">Campagnes</h2>
          <TableWrap caption="Performance par campagne">
            <thead><tr><Th>Campagne</Th><Th>Plateforme</Th><Th className="text-right">Dépense</Th><Th className="text-right">Leads</Th><Th className="text-right">CPL</Th><Th className="text-right">Clients</Th><Th className="text-right">ROAS</Th></tr></thead>
            <tbody>{a.campaigns.slice(0, 8).map((c) => (
              <tr key={c.id}><Td><Link href={`/campaigns/${c.id}`} className="font-medium text-brand-700 underline">{c.name}</Link></Td><Td>{PLATFORM_LABEL[c.platform] ?? c.platform}</Td>
                <Td className="text-right tabular-nums">{c.totals.spend > 0 ? fmtMoney(c.totals.spend, cur) : "—"}</Td><Td className="text-right tabular-nums">{c.totals.leads}</Td>
                <Td className="text-right tabular-nums">{fmtMoney(c.kpis.cpl, cur)}</Td><Td className="text-right tabular-nums">{c.totals.customers}</Td><Td className="text-right tabular-nums">{fmtRatio(c.kpis.roas)}</Td></tr>
            ))}</tbody>
          </TableWrap>
        </div>
      )}

      <Card className="mt-5" id="notifications">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-semibold">Notifications</h2>
          {notifications.some((n) => !n.readAt) && <InlineAction action={markNotificationsReadAction} size="sm">Tout marquer comme lu</InlineAction>}
        </div>
        {notifications.length === 0 ? <p className="text-sm text-slate-500">Aucune notification.</p> : (
          <ul className="divide-y divide-slate-100">
            {notifications.map((n) => (
              <li key={n.id} className="flex items-start justify-between gap-3 py-2 text-sm">
                <div className="min-w-0">{n.href ? <Link href={n.href} className={n.readAt ? "text-slate-600" : "font-semibold text-ink"}>{n.title}</Link> : <span className={n.readAt ? "text-slate-600" : "font-semibold"}>{n.title}</span>}{n.body && <p className="truncate text-xs text-slate-500">{n.body}</p>}</div>
                <time className="shrink-0 text-xs text-slate-500" dateTime={n.createdAt.toISOString()}>{fmtDate(n.createdAt, true)}</time>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
