import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireCtx } from "@/lib/tenant";
import { providerStatus } from "@/lib/ai/providers";
import type { Research } from "@/lib/ai/prompts";
import { Alert, Badge, Card, ConfigRequired, KeyValue, PageHeader, Section, fmtDate } from "@/components/ui";
import { ActionForm, InlineAction, SubmitButton } from "@/components/forms";
import { deleteResearchAction, regenerateResearchAction } from "../actions";

export const metadata: Metadata = { title: "Étude de marché" };

type UserData = { competitors?: { name: string; url?: string; notes?: string }[]; notes?: string | null };

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return <Card><h3 className="mb-1 text-sm font-semibold">{title}</h3><ul className="list-disc space-y-0.5 pl-5 text-sm">{items.map((i) => <li key={i}>{i}</li>)}</ul></Card>;
}

export default async function ResearchDetail({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx();
  const { id } = await params;
  const r = await db.marketResearch.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
  if (!r) notFound();
  const ud = (r.userData ?? {}) as UserData;
  const c = r.content as Research | null;
  const ai = providerStatus();

  return (
    <>
      <PageHeader title={r.market} subtitle={<><Link href="/research" className="underline">← Toutes les études</Link> · créée le {fmtDate(r.createdAt)}</>}
        actions={ctx.can("delete") ? <InlineAction action={deleteResearchAction} variant="danger" hidden={{ id: r.id }} confirm="Supprimer cette étude ?">Supprimer</InlineAction> : undefined} />
      <Section title="Vos informations" actions={<Badge tone="green">Fournies par vous</Badge>} description="Ces éléments viennent de vous : ils ne sont ni générés ni vérifiés par SEA Pilot.">
        <KeyValue items={[["Produit / service", r.product], ["Zone", r.zone], ["Clientèle", r.clientele], ["Notes et sources", ud.notes ?? null]]} />
        {ud.competitors && ud.competitors.length > 0 && (
          <div className="mt-3"><h3 className="text-sm font-semibold">Concurrents connus</h3><ul className="mt-1 list-disc pl-5 text-sm">{ud.competitors.map((x) => <li key={x.name}><strong>{x.name}</strong>{x.url ? ` — ${x.url}` : ""}{x.notes ? ` — ${x.notes}` : ""}</li>)}</ul></div>
        )}
      </Section>

      <Section title="Analyse générée par l'IA" actions={<Badge tone="purple">Hypothèses IA — non vérifiées</Badge>} description="SEA Pilot n'a pas accès à des données de marché en direct : ce contenu est une analyse générée à partir de votre description. Vérifiez-le avant de décider.">
        {r.status === "failed" && r.error && <div className="mb-3"><Alert tone="error">{r.error}</Alert></div>}
        {!ai.configured && !c && <ConfigRequired env={["OPENAI_API_KEY + OPENAI_MODEL", "ANTHROPIC_API_KEY", "GEMINI_API_KEY + GEMINI_MODEL"]}>Aucun fournisseur d'IA configuré : l'analyse ne peut pas être générée.</ConfigRequired>}
        {ctx.can("ai") && ai.configured && <ActionForm action={regenerateResearchAction} className="mb-4 !space-y-0"><input type="hidden" name="id" value={r.id} /><SubmitButton variant={c ? "secondary" : "primary"} pendingLabel="Analyse en cours…">{c ? "Régénérer l'analyse" : "Lancer l'analyse"}</SubmitButton></ActionForm>}
        {c && (
          <div className="space-y-4">
            <Card><h3 className="text-sm font-semibold">Marché</h3><p className="mt-1 text-sm">{c.market.summary}</p>{c.market.maturity && <p className="mt-1 text-sm text-slate-600">Maturité : {c.market.maturity}</p>}</Card>
            <div className="grid gap-4 md:grid-cols-2">
              <List title="Tendances" items={c.trends} /><List title="Positionnement possible" items={c.positioning} />
              <List title="Opportunités" items={c.opportunities} /><List title="Menaces" items={c.threats} />
              <List title="Objections probables" items={c.objections} /><List title="Angles marketing" items={c.angles} />
              <List title="Idées d'offres" items={c.offerIdeas} />
            </div>
            {c.competitors.length > 0 && <Card><h3 className="mb-1 text-sm font-semibold">Concurrents (typologie, hypothèses)</h3><ul className="space-y-2 text-sm">{c.competitors.map((x) => <li key={x.name}><strong>{x.name}</strong> — {x.positioning}{x.strengths.length > 0 && <div className="text-emerald-800">Forces : {x.strengths.join(", ")}</div>}{x.weaknesses.length > 0 && <div className="text-red-800">Faiblesses : {x.weaknesses.join(", ")}</div>}</li>)}</ul></Card>}
            <p className="text-xs text-slate-500">Généré par {r.provider} · {r.model}</p>
          </div>
        )}
      </Section>
    </>
  );
}
