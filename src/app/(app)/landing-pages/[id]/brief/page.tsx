import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCtx } from "@/lib/tenant";
import { providerStatus } from "@/lib/ai/providers";
import { loadBrief, listGeneratedBriefs } from "@/lib/content-brief-service";
import { INTENT_LABEL, KIND_LABEL, briefToMarkdown, groundingText, unsupportedFigures, type BriefItem, type BriefKind, type Reliability } from "@/lib/content-brief";
import { Alert, Badge, Card, ConfigRequired, PageHeader, Section, fmtDate, type Tone } from "@/components/ui";
import { ActionForm, SubmitButton } from "@/components/forms";
import { CopyButton } from "@/components/copy-button";
import { generateBriefAction } from "./actions";

export const metadata: Metadata = { title: "Brief de contenu" };
const KIND_TONE: Record<BriefKind, Tone> = { fact: "green", recommendation: "blue", hypothesis: "orange" };
const RELIABILITY: Record<Reliability, { tone: "success" | "warning" | "error"; text: string }> = {
  sufficient: { tone: "success", text: "Données suffisantes pour un brief fiable (hors données de mots-clés, que SEA Pilot ne fournit pas)." },
  partial: { tone: "warning", text: "Données partielles : le brief est utilisable mais certaines parties restent à compléter (voir « Données manquantes »)." },
  insufficient: { tone: "error", text: "Données insuffisantes : ajoutez un titre SEO ou un titre principal à la page pour déterminer le sujet." },
};

function Items({ items }: { items: BriefItem[] }) {
  return <ul className="space-y-2 text-sm">{items.map((x, i) => <li key={i}><Badge tone={KIND_TONE[x.kind]}>{KIND_LABEL[x.kind]}</Badge> {x.text} <span className="text-xs text-slate-500">— {x.source}</span></li>)}</ul>;
}

/** Brief de contenu d'une landing page : faits, lacunes, plan, questions, appel à l'action ; génération IA explicite ; brief manuel en Markdown (repli sans IA). */
export default async function BriefPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx();
  const { id } = await params;
  const d = await loadBrief(ctx.workspaceId, id);
  if (!d) notFound();
  const { brief, pageContent } = d;
  const ai = providerStatus();
  const history = await listGeneratedBriefs(ctx.workspaceId, id, 3);
  const grounding = groundingText(brief, pageContent);
  const manual = briefToMarkdown(brief, null);
  const rel = RELIABILITY[brief.reliability];

  return (
    <>
      <PageHeader title="Brief de contenu" subtitle={<><Link href={`/landing-pages/${id}`} className="underline">← {d.input.page.name}</Link> · sujet : {brief.topic ?? "à définir"}</>} />
      <div className="mb-5"><Alert tone={rel.tone}>{rel.text}</Alert></div>

      <Section title="Faits issus de vos données" description="Lus dans SEA Pilot : page, offre, audience, campagne et mesures. Rien n'est estimé.">
        <Items items={brief.facts} />
      </Section>

      {brief.gaps.length > 0 && (
        <Section title="Données manquantes" description="Ce qui empêche une recommandation fiable.">
          <ul className="list-disc space-y-1 pl-5 text-sm text-slate-800">{brief.gaps.map((g) => <li key={g}>{g}</li>)}</ul>
        </Section>
      )}

      <Section title="Lacunes SEO à traiter" description="Issues du diagnostic de la page, par ordre d'impact.">
        {brief.recommendations.length === 0 ? <p className="text-sm text-slate-600">Aucune lacune détectée par le diagnostic.</p> : <Items items={brief.recommendations} />}
      </Section>

      <Section title="Sujet, intention et question principale">
        <ul className="space-y-2 text-sm">
          <li><Badge tone="gray">Sujet</Badge> {brief.topic ?? "à définir"} <span className="text-xs text-slate-500">— {brief.topicSource}</span></li>
          <li><Badge tone={KIND_TONE.hypothesis}>{KIND_LABEL.hypothesis}</Badge> {brief.intent.item.text}</li>
          <li>{brief.mainQuestion ? <><Badge tone={KIND_TONE.fact}>{KIND_LABEL.fact}</Badge> {brief.mainQuestion.text} <span className="text-xs text-slate-500">— {brief.mainQuestion.source}</span></> : <><Badge tone="gray">À définir</Badge> Aucune question principale identifiable.</>}</li>
        </ul>
      </Section>

      <Section title="Plan proposé">
        <ol className="list-decimal space-y-2 pl-5 text-sm">{brief.outline.map((o) => <li key={o.heading}><span className="font-medium">{o.heading}</span> <Badge tone={KIND_TONE[o.basedOn]}>{KIND_LABEL[o.basedOn]}</Badge><span className="block text-slate-600">{o.purpose}</span></li>)}</ol>
      </Section>

      <Section title="Questions à couvrir dans la FAQ">
        {brief.questions.length === 0 ? <p className="text-sm text-slate-600">Aucune question identifiée automatiquement. Ajoutez celles que vos clients posent réellement.</p> : <Items items={brief.questions} />}
      </Section>

      <Section title="Appel à l'action et objectif commercial">
        <p className="text-sm">{brief.cta.objective}</p>
        <p className="mt-1 text-sm text-slate-600">Libellé : {brief.cta.label ?? "à définir"} · Page : <span className="break-all">{brief.cta.target}</span></p>
      </Section>

      <Section title="Proposition de l'IA" description="Déclenchée uniquement par votre clic. Consomme votre quota quotidien de générations IA ; résultat journalisé dans l'historique d'AI Studio.">
        {!ai.configured ? <ConfigRequired env={["OPENAI_API_KEY + OPENAI_MODEL", "ANTHROPIC_API_KEY", "GEMINI_API_KEY + GEMINI_MODEL"]}>Aucun fournisseur d'IA n'est configuré : la génération est indisponible. Le brief ci-dessus et son export Markdown restent utilisables pour rédiger à la main.</ConfigRequired>
          : !ctx.can("ai") ? <Alert tone="info">Votre rôle ne permet pas d'utiliser l'IA. Le brief manuel reste disponible.</Alert>
          : brief.reliability === "insufficient" ? <Alert tone="warning">Génération désactivée : données insuffisantes (voir ci-dessus).</Alert>
          : (
            <ActionForm action={generateBriefAction}>
              <input type="hidden" name="pageId" value={id} />
              <SubmitButton pendingLabel="Génération en cours…">Générer une proposition avec l'IA</SubmitButton>
            </ActionForm>
          )}
        {history.length === 0 ? <p className="mt-3 text-sm text-slate-500">Aucune proposition générée pour cette page.</p> : (
          <ul className="mt-4 space-y-4">
            {history.map((g) => {
              const warn = unsupportedFigures(g.ai, grounding);
              return (
                <li key={g.generationId}><Card>
                  <div className="flex flex-wrap items-center gap-2 text-xs"><Badge tone="purple">Généré par l'IA — proposition à relire</Badge><span className="text-slate-500">{fmtDate(g.createdAt, true)} · {g.provider}/{g.model}</span></div>
                  <h3 className="mt-2 font-semibold">{g.ai.workingTitle}</h3>
                  <p className="text-sm text-slate-700">Intention : {INTENT_LABEL[g.ai.searchIntent]} — {g.ai.intentRationale}</p>
                  <p className="text-sm text-slate-700">Question principale : {g.ai.mainQuestion}</p>
                  {warn.length > 0 && <div className="mt-2"><Alert tone="warning" title="Chiffres à vérifier">L'IA cite des chiffres absents de vos données : {warn.join(", ")}. Ne les publiez pas sans source.</Alert></div>}
                  <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm">{g.ai.outline.map((o) => <li key={o.heading}>{o.heading}{o.points.length > 0 && <ul className="list-disc pl-5 text-slate-600">{o.points.map((p) => <li key={p}>{p}</li>)}</ul>}</li>)}</ol>
                  {g.ai.faq.length > 0 && <><h4 className="mt-3 text-sm font-semibold">FAQ proposée</h4><ul className="mt-1 space-y-1 text-sm">{g.ai.faq.map((x) => <li key={x.q}><span className="font-medium">{x.q}</span> {x.a}</li>)}</ul></>}
                  {g.ai.assumptions.length > 0 && <><h4 className="mt-3 text-sm font-semibold">Hypothèses à valider</h4><ul className="mt-1 list-disc pl-5 text-sm text-slate-700">{g.ai.assumptions.map((x) => <li key={x}>{x}</li>)}</ul></>}
                  <div className="mt-3"><CopyButton text={briefToMarkdown(brief, g.ai)} label="Copier le brief complet (Markdown)" /></div>
                </Card></li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section title="Brief manuel (sans IA)" description="Export Markdown du brief ci-dessus : à coller dans votre outil de rédaction et à compléter.">
        <textarea readOnly aria-label="Brief au format Markdown" className="h-56 w-full rounded-lg border border-slate-300 bg-slate-50 p-3 font-mono text-xs" value={manual} />
        <div className="mt-2"><CopyButton text={manual} label="Copier le brief (Markdown)" /></div>
      </Section>
    </>
  );
}
