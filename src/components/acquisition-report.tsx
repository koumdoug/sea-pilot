import Link from "next/link";
import { Alert, Badge, Section, TableWrap, Td, Th, type Tone } from "./ui";
import { fmtAmount, fmtNum, fmtPct } from "@/lib/kpi";
import type { Availability, Funnel } from "@/lib/portfolio/funnel";
import type { ReadinessCheck } from "@/lib/portfolio/pilot";

const AV: Record<Availability, { label: string; tone: Tone }> = { measured: { label: "Mesuré", tone: "green" }, manual: { label: "Saisie manuelle", tone: "orange" }, mixed: { label: "Mixte", tone: "blue" }, unavailable: { label: "Indisponible", tone: "gray" } };
const DAYS = [7, 30, 90];

/** Rapport d'acquisition d'un produit : chaque étape indique d'où vient la donnée ; une donnée non collectée s'affiche « indisponible », jamais 0. */
export function AcquisitionReport({ funnel, readiness, days, basePath, pilot }: { funnel: Funnel; readiness: { checks: ReadinessCheck[]; ready: boolean }; days: number; basePath: string; pilot: boolean }) {
  const f = funnel;
  return (
    <Section title="Parcours d'acquisition" description="Visites → leads → prospects → inscriptions → essais → paiements. Les conversions sont saisies à la main ou reçues du produit : SEA Pilot ne les observe pas lui-même."
      actions={<nav aria-label="Période" className="flex gap-2 text-sm">{DAYS.map((d) => <Link key={d} href={`${basePath}?days=${d}`} aria-current={d === days ? "true" : undefined} className={d === days ? "font-semibold underline" : "text-brand-700 underline"}>{d} j</Link>)}</nav>}>
      {pilot && <div className="mb-3"><Badge tone="purple">Produit pilote du premier parcours d'acquisition</Badge></div>}

      <h3 className="mb-1 text-sm font-semibold">Avant d'acquérir des prospects {readiness.ready ? <Badge tone="green">Capture possible</Badge> : <Badge tone="red">Parcours bloqué</Badge>}</h3>
      <ul className="mb-5 space-y-1 text-sm">
        {readiness.checks.map((c) => <li key={c.id} className="flex flex-wrap items-baseline gap-2"><Badge tone={c.ok ? "green" : c.blocking ? "red" : "orange"}>{c.ok ? "OK" : c.blocking ? "Bloquant" : "À faire"}</Badge><span className="font-medium">{c.label}</span><span className="text-slate-600">{c.detail}</span></li>)}
      </ul>

      <TableWrap caption={`Étapes du parcours sur ${days} jours`}>
        <thead><tr><Th>Étape</Th><Th>Valeur</Th><Th>Origine de la donnée</Th></tr></thead>
        <tbody>
          {f.stages.map((s) => (
            <tr key={s.id}>
              <Td className="font-medium">{s.label}</Td>
              <Td>{s.value === null ? <span className="text-slate-500">Indisponible</span> : fmtNum(s.value)}</Td>
              <Td><Badge tone={AV[s.availability].tone}>{AV[s.availability].label}</Badge> <span className="text-xs text-slate-600">{s.note}</span></Td>
            </tr>
          ))}
          <tr><Td className="font-medium">Revenus confirmés</Td><Td>{f.revenue ? f.revenue.map((r) => fmtAmount(r.amount, r.currency)).join(" · ") : <span className="text-slate-500">Indisponible</span>}</Td><Td className="text-xs text-slate-600">{f.revenue ? "Somme des paiements enregistrés, par devise (aucune conversion)." : "Aucun paiement enregistré : ce n'est pas un revenu nul."}</Td></tr>
          <tr><Td className="font-medium">Dépenses publicitaires</Td><Td>{f.spend.value === null ? <span className="text-slate-500">Indisponible</span> : fmtAmount(f.spend.value, f.spend.currency)}</Td><Td className="text-xs text-slate-600">{f.spend.note ?? "Campagnes liées au produit (saisies ou importées)."}</Td></tr>
          <tr><Td className="font-medium">Coût par lead</Td><Td>{f.cpl.value === null ? <span className="text-slate-500">Indisponible</span> : fmtAmount(f.cpl.value, f.spend.currency)}</Td><Td className="text-xs text-slate-600">{f.cpl.note ?? "Dépenses ÷ leads issus des campagnes liées."}</Td></tr>
          <tr><Td className="font-medium">Visite → lead</Td><Td>{f.rates.visitToLead === null ? <span className="text-slate-500">Indisponible</span> : fmtPct(f.rates.visitToLead)}</Td><Td className="text-xs text-slate-600">Leads captés par les pages liées ÷ pages vues.</Td></tr>
          <tr><Td className="font-medium">Leads qualifiés</Td><Td>{f.rates.qualifiedShare === null ? <span className="text-slate-500">Indisponible</span> : fmtPct(f.rates.qualifiedShare)}</Td><Td className="text-xs text-slate-600">Part des leads entrants.</Td></tr>
          <tr><Td className="font-medium">Payants ÷ inscriptions</Td><Td>{f.rates.paidPerSignup === null ? <span className="text-slate-500">Indisponible</span> : fmtPct(f.rates.paidPerSignup)}</Td><Td className="text-xs text-slate-600">Rapport de comptages sur la période, pas un suivi de cohorte.</Td></tr>
        </tbody>
      </TableWrap>

      <h3 className="mb-1 mt-5 text-sm font-semibold">Coût d'acquisition client (CAC)</h3>
      {f.cac.value === null ? <Alert tone="info">{f.cac.note}</Alert> : (
        <Alert tone={f.cac.status === "computed" ? "success" : "warning"} title={f.cac.status === "computed" ? `CAC calculé : ${fmtAmount(f.cac.value, f.cac.currency)}` : `CAC indicatif (données incomplètes) : ${fmtAmount(f.cac.value, f.cac.currency)} — ne pas utiliser pour décider`}>
          {f.cac.note}
          {f.cac.caveats.length > 0 && <ul className="mt-1 list-disc pl-5">{f.cac.caveats.map((c) => <li key={c}>{c}</li>)}</ul>}
        </Alert>
      )}

      <h3 className="mb-1 mt-5 text-sm font-semibold">Sources des leads entrants</h3>
      {f.sources.length === 0 ? <p className="text-sm text-slate-500">Aucun lead entrant sur la période.</p> : (
        <ul className="text-sm">{f.sources.map((s) => <li key={s.label}>{s.label} : {fmtNum(s.leads)} lead(s)</li>)}</ul>
      )}
    </Section>
  );
}
