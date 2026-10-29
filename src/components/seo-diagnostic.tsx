import Link from "next/link";
import { Badge, Card, type Tone } from "./ui";
import { CATEGORY_LABEL, IMPACT_LABEL, scoreTone, type SeoAudit, type SeoCategory, type SeoStatus } from "@/lib/seo";

const STATUS: Record<SeoStatus, { label: string; tone: Tone }> = {
  pass: { label: "OK", tone: "green" }, warn: { label: "À améliorer", tone: "orange" }, fail: { label: "Manquant", tone: "red" }, info: { label: "Info", tone: "blue" },
};
const CATEGORIES: SeoCategory[] = ["technique", "contenu", "reponse", "conversion"];

/** Diagnostic SEO d'une landing page : actions classées par impact, puis détail par catégorie. Voir src/lib/seo.ts pour les limites. */
export function SeoDiagnostic({ audit, briefHref }: { audit: SeoAudit; briefHref?: string }) {
  return (
    <Card className="mb-5" id="diagnostic-seo" aria-labelledby="seo-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="seo-title" className="text-lg font-semibold">Diagnostic SEO et moteurs de réponse</h2>
        <Badge tone={scoreTone(audit.score)}>Score {audit.score}/100</Badge>
      </div>
      <p className="mt-1 text-sm text-slate-600">Contrôles automatiques du contenu et des métadonnées ({audit.wordCount} mots, {audit.faqCount} question(s) de FAQ). Ce score est une heuristique de lecture : il ne mesure ni votre position dans Google ni vos citations par ChatGPT, Perplexity ou Gemini. Seules les visites et conversions de la page sont des mesures réelles.</p>
      {audit.issues.length === 0 ? <p className="mt-3 text-sm text-emerald-800">Aucune action prioritaire détectée.</p> : (
        <>
          <h3 className="mt-4 text-sm font-semibold">À faire, par ordre d'impact</h3>
          <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm">
            {audit.issues.map((c) => (
              <li key={c.id}><span className="font-medium">{c.label}</span> <Badge tone={c.impact === "high" ? "red" : c.impact === "medium" ? "orange" : "gray"}>{IMPACT_LABEL[c.impact]}</Badge>{c.measured && <> <Badge tone="purple">Mesuré</Badge></>}
                <span className="block text-slate-700">{c.detail}{c.recommendation ? ` ${c.recommendation}` : ""}</span></li>
            ))}
          </ol>
        </>
      )}
      {briefHref && <p className="mt-4"><Link href={briefHref} className="font-semibold text-brand-700 underline">Préparer un brief de contenu à partir de ces lacunes →</Link></p>}
      <details className="mt-4">
        <summary className="cursor-pointer text-sm font-semibold">Tous les contrôles ({audit.checks.length})</summary>
        {CATEGORIES.map((cat) => {
          const rows = audit.checks.filter((c) => c.category === cat);
          if (rows.length === 0) return null;
          return (
            <div key={cat} className="mt-3">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{CATEGORY_LABEL[cat]}</h4>
              <ul className="mt-1 space-y-1 text-sm">{rows.map((c) => <li key={c.id} className="flex flex-wrap items-baseline gap-2"><Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge><span className="font-medium">{c.label}</span><span className="text-slate-600">{c.detail}</span></li>)}</ul>
            </div>
          );
        })}
      </details>
    </Card>
  );
}
