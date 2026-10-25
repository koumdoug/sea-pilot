import { computeKpis, fmtMoney, fmtNum, fmtRatio, type Totals } from "@/lib/kpi";
import { Card, TableWrap, Td, Th } from "./ui";

/**
 * Périmètres des indicateurs : GLOBAL = attribué aux campagnes + non attribué (même période, mêmes filtres).
 * Les ratios ne sont calculés que lorsqu'ils ont un sens pour le périmètre (jamais pour le lot non attribué).
 */
export function ScopeBreakdown({ attributed, unattributed, total, currency, period }: { attributed: Totals; unattributed: Totals; total: Totals; currency: string; period: string }) {
  const has = unattributed.leads > 0 || unattributed.spend > 0 || unattributed.clicks > 0 || unattributed.impressions > 0 || unattributed.customers > 0;
  if (!has) {
    return <p className="mt-3 text-xs text-slate-500">Périmètre : toutes les données de la période ({period}) sont rattachées à une campagne.</p>;
  }
  const ka = computeKpis(attributed);
  const kt = computeKpis(total);
  const row = (label: string, t: Totals, k: ReturnType<typeof computeKpis> | null, strong = false) => (
    <tr className={strong ? "font-semibold" : undefined}>
      <Td>{label}</Td>
      <Td className="text-right tabular-nums">{t.spend > 0 ? fmtMoney(t.spend, currency) : "—"}</Td>
      <Td className="text-right tabular-nums">{fmtNum(t.clicks)}</Td>
      <Td className="text-right tabular-nums">{fmtNum(t.leads)}</Td>
      <Td className="text-right tabular-nums">{k ? fmtMoney(k.cpl, currency) : "—"}</Td>
      <Td className="text-right tabular-nums">{fmtNum(t.customers)}</Td>
      <Td className="text-right tabular-nums">{k ? fmtMoney(k.cac, currency) : "—"}</Td>
      <Td className="text-right tabular-nums">{t.revenue > 0 ? fmtMoney(t.revenue, currency) : "—"}</Td>
      <Td className="text-right tabular-nums">{k ? fmtRatio(k.roas) : "—"}</Td>
    </tr>
  );
  return (
    <Card className="mt-5" aria-labelledby="scope-title">
      <h2 id="scope-title" className="text-base font-semibold">Périmètres : attribué aux campagnes et non attribué</h2>
      <p className="mt-1 text-sm text-slate-700">Les indicateurs ci-dessus sont <strong>globaux</strong> : ils incluent {fmtNum(unattributed.leads)} lead(s) et {unattributed.spend > 0 ? fmtMoney(unattributed.spend, currency) : "0 de dépense"} qui ne sont rattachés à aucune campagne.</p>
      <div className="mt-3">
        <TableWrap caption="Attribué, non attribué et global">
          <thead><tr><Th>Périmètre</Th><Th className="text-right">Dépense</Th><Th className="text-right">Clics</Th><Th className="text-right">Leads</Th><Th className="text-right">CPL</Th><Th className="text-right">Clients</Th><Th className="text-right">CAC</Th><Th className="text-right">CA</Th><Th className="text-right">ROAS</Th></tr></thead>
          <tbody>
            {row("Attribué aux campagnes", attributed, ka)}
            {row("Non attribué (sans campagne)", unattributed, null)}
            {row("Global (somme)", total, kt, true)}
          </tbody>
        </TableWrap>
      </div>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-slate-600">
        <li>Global = attribué + non attribué, sur la même période ({period}) et les mêmes filtres.</li>
        <li>Le CPL et le CAC globaux divisent toute la dépense par tous les leads et tous les clients, y compris ceux sans campagne (organiques, directs, saisis à la main) : ils peuvent être plus bas que les valeurs attribuées. Le non attribué n&apos;a pas de ratio : une dépense ou un lead sans campagne ne peut pas être imputé à l&apos;une d&apos;elles.</li>
        <li>Les leads sont comptés à leur date de création ; les clients sont les leads « gagnés » créés sur la période (la date du gain n&apos;est pas utilisée) ; les dépenses à leur date.</li>
        <li>ROAS et ROI portent sur le chiffre d&apos;affaires, pas sur la marge.</li>
      </ul>
    </Card>
  );
}
