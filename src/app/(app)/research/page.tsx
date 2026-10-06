import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/db";
import { requireCtx } from "@/lib/tenant";
import { providerStatus } from "@/lib/ai/providers";
import { Alert, Badge, ConfigRequired, EmptyState, PageHeader, Section, LinkButton, fmtDate, type Tone } from "@/components/ui";
import { ActionForm, SubmitButton, TextAreaField, TextField } from "@/components/forms";
import { createResearchAction } from "./actions";

export const metadata: Metadata = { title: "Research" };
const TONE: Record<string, Tone> = { pending: "gray", done: "green", failed: "red" };
const LABEL: Record<string, string> = { pending: "En attente d'analyse", done: "Analysée", failed: "Échec" };

export default async function ResearchPage() {
  const ctx = await requireCtx();
  const list = await db.marketResearch.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { createdAt: "desc" }, take: 50 });
  const ai = providerStatus();
  return (
    <>
      <PageHeader title="Recherche de marché" subtitle="Structurez votre compréhension du marché. Vos données vérifiées et l'analyse générée par l'IA sont toujours séparées." actions={<LinkButton href="/strategy" variant="secondary">Fiche stratégie</LinkButton>} />
      {!ai.configured && <div className="mb-5"><ConfigRequired env={["OPENAI_API_KEY + OPENAI_MODEL", "ANTHROPIC_API_KEY", "GEMINI_API_KEY + GEMINI_MODEL"]}>L'analyse IA est indisponible sans fournisseur d'IA. Vous pouvez enregistrer votre étude et vos données vérifiées, puis lancer l'analyse plus tard.</ConfigRequired></div>}
      {ctx.can("write") && (
        <Section title="Nouvelle étude">
          <ActionForm action={createResearchAction}>
            <div className="grid gap-4 md:grid-cols-2">
              <TextField name="market" label="Marché" required placeholder="Ex. rénovation de salles de bain haut de gamme" />
              <TextField name="product" label="Produit / service" />
              <TextField name="zone" label="Zone géographique" />
              <TextField name="clientele" label="Clientèle visée" />
            </div>
            <TextAreaField name="competitors" label="Concurrents que vous connaissez (un par ligne : nom | site | notes)" rows={3} help="Données que VOUS avez vérifiées. Elles seront présentées comme telles, séparément de l'analyse IA." />
            <TextAreaField name="notes" label="Notes et sources vérifiées" rows={2} />
            <SubmitButton pendingLabel="Analyse en cours…">{ai.configured ? "Créer et analyser" : "Enregistrer l'étude"}</SubmitButton>
          </ActionForm>
        </Section>
      )}
      <h2 className="mb-2 text-base font-semibold">Vos études</h2>
      {list.length === 0 ? <EmptyState title="Aucune étude de marché">Créez votre première étude ci-dessus.</EmptyState> : (
        <ul className="grid gap-3 md:grid-cols-2">
          {list.map((r) => (
            <li key={r.id} className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex items-start justify-between gap-2"><Link href={`/research/${r.id}`} className="font-semibold text-brand-700 underline">{r.market}</Link><Badge tone={TONE[r.status]}>{LABEL[r.status]}</Badge></div>
              <p className="mt-1 text-xs text-slate-500">{fmtDate(r.createdAt)}{r.zone ? ` · ${r.zone}` : ""}</p>
              {r.status === "failed" && r.error && <div className="mt-2"><Alert tone="error">{r.error}</Alert></div>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
