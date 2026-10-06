import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/db";
import { requireCtx } from "@/lib/tenant";
import { loadInsights } from "@/lib/insights";
import { defaultRange } from "@/lib/analytics";
import { PLATFORMS, PLATFORM_LABEL } from "@/lib/constants";
import { fmtMoney, fmtNum, fmtPct, fmtRatio } from "@/lib/kpi";
import { Alert, Card, EmptyState, PageHeader, Section, StatTile, TableWrap, Td, Th, fmtDate } from "@/components/ui";
import { BarList, Funnel, LineChart } from "@/components/charts";
import { RecommendationList } from "@/components/recommendation-list";
import { ActionForm, SubmitButton, TextAreaField } from "@/components/forms";
import { importCsvAction } from "./actions";

export const metadata: Metadata = { title: "Analytics" };
type SP = { range?: string; from?: string; to?: string; campaign?: string; platform?: string; source?: string; audience?: string };

function parseRange(sp: SP) {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (sp.from && sp.to && iso.test(sp.from) && iso.test(sp.to)) {
    const from = new Date(`${sp.from}T00:00:00.000Z`), to = new Date(`${sp.to}T23:59:59.999Z`);
    if (to >= from && to.getTime() - from.getTime() <= 400 * 86_400_000) return { from, to, label: "custom" };
  }
  const days = [7, 30, 90, 365].includes(Number(sp.range)) ? Number(sp.range) : 30;
  return { ...defaultRange(days), label: String(days) };
}

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const cur = ctx.workspace.currency;
  const { from, to, label } = parseRange(sp);
  const [campaigns, audiences, sources] = await Promise.all([
    db.campaign.findMany({ where: { workspaceId: ctx.workspaceId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.audience.findMany({ where: { workspaceId: ctx.workspaceId }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
    db.lead.findMany({ where: { workspaceId: ctx.workspaceId, deletedAt: null, utmSource: { not: null } }, distinct: ["utmSource"], select: { utmSource: true }, take: 50 }),
  ]);
  const valid = <T extends { id: string }>(list: T[], v?: string) => (v && list.some((x) => x.id === v) ? v : undefined);
  const filters = {
    from, to, campaignId: valid(campaigns, sp.campaign), audienceId: valid(audiences, sp.audience),
    platform: (PLATFORMS as readonly string[]).includes(sp.platform ?? "") ? sp.platform : undefined, source: sp.source && sources.some((s) => s.utmSource === sp.source) ? sp.source : undefined,
  };
  const { analytics: a, health, recommendations } = await loadInsights(ctx.workspaceId, filters, cur);
  const k = a.kpis;
  const labels = a.series.map((p) => p.date);
  const empty = k.leads === 0 && k.spend === 0;

  return (
    <>
      <PageHeader title="Analytics" subtitle={`Du ${fmtDate(from)} au ${fmtDate(to)}. Aucune donnée inventée : un indicateur non calculable s'affiche « — » avec son explication.`} />

      <form method="get" action="/analytics" className="mb-5 grid gap-3 rounded-xl border border-slate-200 bg-white p-3 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-8" role="search" aria-label="Filtres analytics">
        <F label="Période"><select name="range" defaultValue={label === "custom" ? "" : label} className={sel}><option value="7">7 jours</option><option value="30">30 jours</option><option value="90">90 jours</option><option value="365">12 mois</option>{label === "custom" && <option value="">Personnalisée</option>}</select></F>
        <F label="Du"><input type="date" name="from" defaultValue={sp.from} className={sel} /></F>
        <F label="Au"><input type="date" name="to" defaultValue={sp.to} className={sel} /></F>
        <F label="Campagne"><select name="campaign" defaultValue={sp.campaign ?? ""} className={sel}><option value="">Toutes</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></F>
        <F label="Plateforme"><select name="platform" defaultValue={sp.platform ?? ""} className={sel}><option value="">Toutes</option>{PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}</select></F>
        <F label="Source (UTM)"><select name="source" defaultValue={sp.source ?? ""} className={sel}><option value="">Toutes</option>{sources.map((s) => <option key={s.utmSource!} value={s.utmSource!}>{s.utmSource}</option>)}</select></F>
        <F label="Audience"><select name="audience" defaultValue={sp.audience ?? ""} className={sel}><option value="">Toutes</option>{audiences.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></F>
        <div className="flex items-end gap-2"><button className="min-h-11 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700">Appliquer</button><Link href="/analytics" className="inline-flex min-h-11 items-center px-2 text-sm underline">Reset</Link></div>
      </form>

      {a.notes.length > 0 && <div className="mb-4 space-y-2">{a.notes.map((n) => <Alert key={n} tone="info">{n}</Alert>)}</div>}

      <section aria-label="Indicateurs" className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <StatTile label="Spend" value={a.hasSpendData ? fmtMoney(k.spend, cur) : "—"} /><StatTile label="Leads" value={fmtNum(k.leads)} /><StatTile label="Qualified leads" value={fmtNum(k.qualifiedLeads)} />
        <StatTile label="Customers" value={fmtNum(k.customers)} /><StatTile label="Revenue" value={k.revenue > 0 ? fmtMoney(k.revenue, cur) : "—"} /><StatTile label="ROI" value={k.roi === null ? "—" : fmtPct(k.roi, 0)} hint={k.roi === null ? "dépenses + CA de tous les clients requis" : undefined} />
        <StatTile label="CTR" value={fmtPct(k.ctr, 2)} /><StatTile label="CPC" value={fmtMoney(k.cpc, cur)} /><StatTile label="CPL" value={fmtMoney(k.cpl, cur)} />
        <StatTile label="CVR (clic → lead)" value={fmtPct(k.cvr)} /><StatTile label="CAC" value={fmtMoney(k.cac, cur)} /><StatTile label="ROAS" value={fmtRatio(k.roas)} />
      </section>

      {empty ? <div className="mt-5"><EmptyState title="Aucune donnée pour ces filtres">Élargissez la période, retirez des filtres, ou enregistrez vos premières dépenses et leads.</EmptyState></div> : (
        <div className="mt-5 grid gap-5 lg:grid-cols-2">
          <Card><LineChart integer format={(n) => String(Math.round(n))} title="Leads par jour" labels={labels} series={[{ name: "Leads", values: a.series.map((p) => p.leads) }, { name: "Clients", values: a.series.map((p) => p.customers), color: "#10b981" }]} /></Card>
          <Card><LineChart title={`Dépenses par jour (${cur})`} labels={labels} series={[{ name: "Dépenses", values: a.series.map((p) => p.spend), color: "#f59e0b" }]} format={(n) => String(Math.round(n))} /></Card>
          <Card><LineChart title="Clics par jour" labels={labels} series={[{ name: "Clics", values: a.series.map((p) => p.clicks), color: "#8b5cf6" }]} format={(n) => String(Math.round(n))} /></Card>
          <Card><h2 className="mb-3 text-sm font-semibold">Entonnoir</h2><Funnel steps={[...(a.hasSpendData ? [{ label: "Impressions", value: k.impressions }, { label: "Clics", value: k.clicks }] : []), { label: "Leads", value: k.leads }, { label: "Leads qualifiés", value: k.qualifiedLeads }, { label: "Clients", value: k.customers }]} /></Card>
          <Card><BarList title="Leads par campagne" rows={a.campaigns.map((c) => ({ label: c.name, value: c.totals.leads }))} empty="Aucun lead rattaché à une campagne." /></Card>
          <Card><BarList title="Leads par source (UTM)" rows={a.sources.map((s) => ({ label: s.source, value: s.leads, hint: s.customers ? `${s.customers} client(s)` : undefined }))} color="#10b981" /></Card>
        </div>
      )}

      {a.campaigns.length > 0 && (
        <div className="mt-5">
          <h2 className="mb-2 text-base font-semibold">Détail par campagne</h2>
          <TableWrap caption="Performance par campagne">
            <thead><tr><Th>Campagne</Th><Th className="text-right">Dépense</Th><Th className="text-right">Clics</Th><Th className="text-right">CTR</Th><Th className="text-right">CPC</Th><Th className="text-right">Leads</Th><Th className="text-right">CPL</Th><Th className="text-right">Clients</Th><Th className="text-right">CAC</Th><Th className="text-right">CA</Th><Th className="text-right">ROAS</Th></tr></thead>
            <tbody>{a.campaigns.map((c) => (
              <tr key={c.id}><Td><Link href={`/campaigns/${c.id}`} className="font-medium text-brand-700 underline">{c.name}</Link></Td>
                <Td className="text-right tabular-nums">{c.totals.spend > 0 ? fmtMoney(c.totals.spend, cur) : "—"}</Td><Td className="text-right tabular-nums">{c.totals.clicks || "—"}</Td><Td className="text-right tabular-nums">{fmtPct(c.kpis.ctr, 2)}</Td><Td className="text-right tabular-nums">{fmtMoney(c.kpis.cpc, cur)}</Td>
                <Td className="text-right tabular-nums">{c.totals.leads}</Td><Td className="text-right tabular-nums">{fmtMoney(c.kpis.cpl, cur)}</Td><Td className="text-right tabular-nums">{c.totals.customers}</Td><Td className="text-right tabular-nums">{fmtMoney(c.kpis.cac, cur)}</Td>
                <Td className="text-right tabular-nums">{c.totals.revenue > 0 ? fmtMoney(c.totals.revenue, cur) : "—"}</Td><Td className="text-right tabular-nums">{fmtRatio(c.kpis.roas)}</Td></tr>
            ))}</tbody>
          </TableWrap>
        </div>
      )}

      <div id="recommandations" className="mt-8 scroll-mt-4">
        <Section title="Recommandations" description={`Calculées par des règles transparentes sur vos données. Santé actuelle : ${{ good: "bonne", watch: "à surveiller", bad: "problème", unknown: "données insuffisantes" }[health.status]}.`}>
          <RecommendationList items={recommendations} empty="Aucune recommandation : aucun problème détecté sur les données disponibles (ou données insuffisantes)." />
        </Section>
      </div>

      <div id="donnees" className="scroll-mt-4">
        <Section title="Données publicitaires" description="Importez vos dépenses par jour et par campagne depuis un export CSV (Google Ads, Meta Ads, TikTok…). Colonnes : date (AAAA-MM-JJ), campagne, dépense, impressions, clics. Les campagnes doivent exister dans SEA Pilot. Les plateformes connectées dans Integrations alimentent ces chiffres automatiquement.">
          {ctx.can("write") ? (
            <ActionForm action={importCsvAction} resetOnSuccess>
              <div><label htmlFor="csv-file" className="mb-1 block text-sm font-medium">Fichier CSV</label><input id="csv-file" type="file" name="file" accept=".csv,text/csv" className="block w-full text-sm" /></div>
              <TextAreaField name="text" label="… ou collez le contenu" rows={4} placeholder={"date,campagne,dépense,impressions,clics\n2026-06-01,Ma campagne,45.20,12000,310"} />
              <SubmitButton pendingLabel="Import…">Importer</SubmitButton>
            </ActionForm>
          ) : <p className="text-sm text-slate-500">Votre rôle ne permet pas l'import.</p>}
          <p className="mt-3 text-xs text-slate-500">Vous pouvez aussi saisir les dépenses jour par jour depuis la fiche d'une campagne. Un import sur une date déjà importée remplace la valeur de ce jour.</p>
        </Section>
      </div>
    </>
  );
}

const sel = "min-h-11 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm";
function F({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="min-w-0"><label className="mb-1 block text-xs font-medium text-slate-600">{label}{children}</label></div>;
}
