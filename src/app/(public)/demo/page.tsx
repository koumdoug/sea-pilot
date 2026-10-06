import type { Metadata } from "next";
import Link from "next/link";
import { buildDemo, DEMO_COMPANY } from "@/lib/demo-data";
import { fmtMoney, fmtNum, fmtPct, fmtRatio } from "@/lib/kpi";
import { PLATFORM_LABEL } from "@/lib/constants";
import { Alert, Badge, Card, StatTile, TableWrap, Td, Th } from "@/components/ui";
import { Funnel, LineChart } from "@/components/charts";
import { RecommendationList } from "@/components/recommendation-list";
import { LevelBadge } from "@/components/lead-badges";

export const metadata: Metadata = { title: "Démo", description: "Explorez SEA Pilot avec un jeu de données fictif : dashboard, campagnes, lead, qualification IA et analytics.", alternates: { canonical: "/demo" } };

const HEALTH = { good: ["🟢", "Bon"], watch: ["🟠", "À surveiller"], bad: ["🔴", "Problème"], unknown: ["⚪", "Données insuffisantes"] } as const;
const BASIS = { fact: ["green", "Fait fourni"], inference: ["purple", "Inférence"], missing: ["gray", "Manquant"] } as const;

export default function DemoPage() {
  const d = buildDemo();
  const k = d.kpis;
  const [dot, hl] = HEALTH[d.health.status];
  const q = d.qualification;
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <Alert tone="warning" title="Données de démonstration">Tout ce qui suit est <strong>fictif</strong> ({DEMO_COMPANY}). Aucune de ces données ne provient d'une vraie campagne. Les calculs, eux, utilisent les vrais moteurs de SEA Pilot.</Alert>
      <h1 className="mt-6 text-3xl font-extrabold tracking-tight">Démo de SEA Pilot</h1>
      <p className="mt-1 text-slate-700">Dashboard, campagnes, lead, qualification IA et analytics sur 30 jours.</p>

      <section aria-labelledby="d-dash" className="mt-8"><h2 id="d-dash" className="text-xl font-bold">1. Dashboard <Badge tone="purple">Démo</Badge></h2>
        <Card className="mt-3"><p className="text-lg font-semibold">{dot} Santé de l'acquisition : {hl}</p><ul className="mt-1 list-disc pl-5 text-sm text-slate-700">{d.health.reasons.map((r) => <li key={r}>{r}</li>)}</ul></Card>
        <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-5">
          <StatTile label="Dépenses" value={fmtMoney(k.spend)} /><StatTile label="Impressions" value={fmtNum(k.impressions)} /><StatTile label="Clics" value={fmtNum(k.clicks)} /><StatTile label="CTR" value={fmtPct(k.ctr, 2)} /><StatTile label="CPC" value={fmtMoney(k.cpc)} />
          <StatTile label="Leads" value={fmtNum(k.leads)} /><StatTile label="CPL" value={fmtMoney(k.cpl)} /><StatTile label="Conversion" value={fmtPct(k.cvr)} /><StatTile label="Qualifiés" value={fmtNum(k.qualifiedLeads)} /><StatTile label="Clients" value={fmtNum(k.customers)} />
          <StatTile label="CAC" value={fmtMoney(k.cac)} hint="max visé : 130 €" /><StatTile label="CA attribué" value={fmtMoney(k.revenue)} /><StatTile label="ROAS" value={fmtRatio(k.roas)} /><StatTile label="ROI" value={fmtPct(k.roi, 0)} />
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Card><LineChart integer format={(n) => String(Math.round(n))} title="Leads par jour (démo)" labels={d.series.map((p) => p.date)} series={[{ name: "Leads", values: d.series.map((p) => p.leads) }]} /></Card>
          <Card><h3 className="mb-3 text-sm font-semibold">Entonnoir (démo)</h3><Funnel steps={[{ label: "Impressions", value: k.impressions }, { label: "Clics", value: k.clicks }, { label: "Leads", value: k.leads }, { label: "Qualifiés", value: k.qualifiedLeads }, { label: "Clients", value: k.customers }]} /></Card>
        </div>
      </section>

      <section aria-labelledby="d-camp" className="mt-10"><h2 id="d-camp" className="text-xl font-bold">2. Campagnes <Badge tone="purple">Démo</Badge></h2>
        <div className="mt-3"><TableWrap caption="Campagnes de démonstration"><thead><tr><Th>Campagne</Th><Th>Plateforme</Th><Th className="text-right">Dépense</Th><Th className="text-right">Leads</Th><Th className="text-right">CPL</Th><Th className="text-right">Clients</Th><Th className="text-right">ROAS</Th></tr></thead>
          <tbody>{d.campaigns.map((c) => <tr key={c.id}><Td>{c.name}</Td><Td>{PLATFORM_LABEL[c.platform]}</Td><Td className="text-right tabular-nums">{fmtMoney(c.totals.spend)}</Td><Td className="text-right tabular-nums">{c.totals.leads}</Td><Td className="text-right tabular-nums">{fmtMoney(c.kpis.cpl)}</Td><Td className="text-right tabular-nums">{c.totals.customers}</Td><Td className="text-right tabular-nums">{fmtRatio(c.kpis.roas)}</Td></tr>)}</tbody></TableWrap></div>
      </section>

      <section aria-labelledby="d-lead" className="mt-10"><h2 id="d-lead" className="text-xl font-bold">3. Lead et qualification IA <Badge tone="purple">Démo</Badge></h2>
        <Card className="mt-3">
          <p className="font-semibold">{d.lead.name}</p><p className="mt-1 whitespace-pre-line rounded bg-slate-50 p-3 text-sm">{d.lead.message}</p>
          <div className="mt-3 flex flex-wrap items-center gap-3"><span className="text-3xl font-extrabold">{q.score}<span className="text-base font-medium text-slate-500">/100</span></span><LevelBadge level={q.level} /></div>
          <p className="mt-2 rounded-lg bg-brand-50 p-3 text-sm"><strong className="text-brand-700">Prochaine action : </strong>{q.nextAction}</p>
          <div className="relative mt-3 overflow-x-auto"><table className="w-full min-w-[28rem] text-sm"><caption className="sr-only">Détail de la qualification</caption><thead><tr className="text-left text-xs uppercase text-slate-500"><th className="py-1 pr-2">Critère</th><th className="py-1 pr-2">Base</th><th className="py-1">Justification</th></tr></thead>
            <tbody>{q.criteria.map((c) => <tr key={c.key} className="border-t border-slate-100"><td className="py-1.5 pr-2 font-medium">{c.label}</td><td className="py-1.5 pr-2"><Badge tone={BASIS[c.basis][0]}>{BASIS[c.basis][1]}</Badge></td><td className="py-1.5">{c.evidence}</td></tr>)}</tbody></table></div>
        </Card>
      </section>

      <section aria-labelledby="d-an" className="mt-10"><h2 id="d-an" className="text-xl font-bold">4. Analytics et recommandations <Badge tone="purple">Démo</Badge></h2>
        <div className="mt-3"><RecommendationList items={d.recommendations} empty="Aucune recommandation." /></div>
      </section>

      <div className="mt-10 rounded-2xl bg-brand-50 p-6 text-center"><p className="text-lg font-semibold">Prêt à voir vos propres chiffres ?</p><Link href="/register" className="mt-3 inline-flex min-h-12 items-center rounded-lg bg-brand-600 px-6 font-semibold text-white hover:bg-brand-700">Commencer gratuitement</Link></div>
    </div>
  );
}
