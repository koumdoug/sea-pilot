import type { Metadata } from "next";
import { db } from "@/lib/db";
import { requireCtx } from "@/lib/tenant";
import { providerStatus } from "@/lib/ai/providers";
import type { CopilotAnswer } from "@/lib/ai/prompts";
import { Alert, Badge, Card, ConfigRequired, EmptyState, PageHeader, fmtDate } from "@/components/ui";
import { ActionForm, SubmitButton, TextAreaField } from "@/components/forms";
import { askCopilotAction } from "./actions";

export const metadata: Metadata = { title: "AI Copilot" };

const EXAMPLES = ["Pourquoi mes leads ont diminué cette semaine ?", "Quelle campagne dois-je arrêter ?", "Comment améliorer mon CPL ?"];

export default async function CopilotPage() {
  const ctx = await requireCtx();
  const ai = providerStatus();
  const history = await db.aIGeneration.findMany({ where: { workspaceId: ctx.workspaceId, kind: "copilot", status: "ok" }, orderBy: { createdAt: "desc" }, take: 10 });

  return (
    <>
      <PageHeader title="AI Copilot" subtitle="Posez une question sur vos résultats. Le Copilot répond uniquement à partir des données de votre espace (30 derniers jours) et signale ce qui manque." />
      {!ai.configured ? <ConfigRequired env={["OPENAI_API_KEY + OPENAI_MODEL", "ANTHROPIC_API_KEY", "GEMINI_API_KEY + GEMINI_MODEL"]}>Le Copilot nécessite un fournisseur d'IA. En attendant, vos <a className="underline" href="/analytics#recommandations">recommandations automatiques</a> sont calculées sans IA.</ConfigRequired>
        : !ctx.can("ai") ? <Alert tone="info">Votre rôle ne permet pas d'utiliser l'IA.</Alert> : (
          <Card className="mb-5">
            <ActionForm action={askCopilotAction}>
              <TextAreaField name="question" label="Votre question" required rows={3} maxLength={600} placeholder={EXAMPLES[0]} />
              <ul className="flex flex-wrap gap-2 text-xs text-slate-600" aria-label="Exemples de questions">{EXAMPLES.map((e) => <li key={e} className="rounded-full bg-slate-100 px-3 py-1">{e}</li>)}</ul>
              <SubmitButton pendingLabel="Analyse de vos données…">Demander</SubmitButton>
            </ActionForm>
          </Card>
        )}
      {history.length === 0 ? <EmptyState title="Aucune question posée">Les réponses s'affichent ici et restent consultables.</EmptyState> : (
        <ul className="space-y-4">
          {history.map((g) => {
            const a = g.output as unknown as CopilotAnswer;
            const q = (g.input as { question?: string } | null)?.question;
            return (
              <li key={g.id}><Card as="article">
                <div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold">{q}</p><span className="text-xs text-slate-500">{fmtDate(g.createdAt, true)} · {g.model}</span></div>
                <div className="mt-3 space-y-3 text-sm">
                  <div><p className="text-xs font-semibold uppercase text-slate-500">Analyse</p><p>{a.analysis}</p></div>
                  {a.explanation && <div><p className="text-xs font-semibold uppercase text-slate-500">Explication</p><p>{a.explanation}</p></div>}
                  {a.proposals.length > 0 && <div><p className="text-xs font-semibold uppercase text-slate-500">Propositions</p><ul className="list-disc pl-5">{a.proposals.map((p) => <li key={p}>{p}</li>)}</ul></div>}
                  {a.action && <div className="rounded-lg border border-brand-100 bg-brand-50 p-3"><p className="font-semibold text-brand-700">Action concrète</p><p>{a.action}</p></div>}
                  {a.dataGaps.length > 0 && <div><p className="text-xs font-semibold uppercase text-slate-500">Données manquantes <Badge tone="orange">à compléter</Badge></p><ul className="list-disc pl-5 text-slate-700">{a.dataGaps.map((p) => <li key={p}>{p}</li>)}</ul></div>}
                </div>
              </Card></li>
            );
          })}
        </ul>
      )}
    </>
  );
}
