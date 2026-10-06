import Link from "next/link";
import type { Recommendation } from "@/lib/recommendations";
import { Badge, type Tone } from "./ui";

const PRIO: Record<string, { label: string; tone: Tone }> = { high: { label: "Priorité haute", tone: "red" }, medium: { label: "Priorité moyenne", tone: "orange" }, low: { label: "Opportunité", tone: "green" } };

export function RecommendationList({ items, compact = false, empty }: { items: Recommendation[]; compact?: boolean; empty: string }) {
  if (!items.length) return <p className="text-sm text-slate-500">{empty}</p>;
  return (
    <ul className="space-y-3">
      {items.map((r) => (
        <li key={r.id} className="rounded-lg border border-slate-200 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold text-ink">{r.title}</p>
            <Badge tone={PRIO[r.priority].tone}>{PRIO[r.priority].label}</Badge>
          </div>
          <p className="mt-1 text-sm text-slate-700">{r.problem}</p>
          {!compact && (
            <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-3">
              <div><dt className="text-xs font-semibold uppercase text-slate-500">Preuve</dt><dd><ul className="list-disc pl-4">{r.evidence.map((e) => <li key={e}>{e}</li>)}</ul></dd></div>
              <div><dt className="text-xs font-semibold uppercase text-slate-500">Impact potentiel</dt><dd>{r.impact}</dd></div>
              <div><dt className="text-xs font-semibold uppercase text-slate-500">Action recommandée</dt><dd>{r.action}</dd></div>
            </dl>
          )}
          {compact && <p className="mt-1 text-sm"><span className="font-medium">Action : </span>{r.action}</p>}
          {r.campaignId && <Link href={`/campaigns/${r.campaignId}`} className="mt-2 inline-block text-sm text-brand-700 underline">Voir la campagne</Link>}
          {r.landingPageId && <Link href={`/landing-pages/${r.landingPageId}`} className="mt-2 inline-block text-sm text-brand-700 underline">Voir la page</Link>}
        </li>
      ))}
    </ul>
  );
}
