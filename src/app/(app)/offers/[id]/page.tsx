import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireCtx } from "@/lib/tenant";
import { providerStatus } from "@/lib/ai/providers";
import { Badge, Card, ConfigRequired, EmptyState, PageHeader, Section, fmtDate } from "@/components/ui";
import { ActionForm, InlineAction, SelectField, SubmitButton } from "@/components/forms";
import { OfferForm } from "../offer-form";
import { createPageFromVariantAction, deleteOfferAction, deleteVariantAction, generateOfferVariantsAction } from "../actions";

export const metadata: Metadata = { title: "Offre" };

type Variant = { id: string; name: string; valueProposition: string; headline: string; subheadline: string; benefits: string[]; objections: { objection: string; answer: string }[]; guarantees: string[]; cta: string; bundles: string[]; upsells: string[]; createdAt: string; provider?: string; model?: string };

export default async function OfferPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx();
  const { id } = await params;
  const offer = await db.offer.findFirst({ where: { id, workspaceId: ctx.workspaceId } });
  if (!offer) notFound();
  const audiences = await db.audience.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { name: "asc" } });
  const variants = (Array.isArray(offer.variants) ? offer.variants : []) as unknown as Variant[];
  const ai = providerStatus();

  return (
    <>
      <PageHeader title={offer.name} subtitle={<Link href="/offers" className="underline">← Toutes les offres</Link>}
        actions={ctx.can("delete") ? <InlineAction action={deleteOfferAction} variant="danger" hidden={{ id: offer.id }} confirm="Supprimer cette offre ?">Supprimer</InlineAction> : undefined} />
      <Section title="Détails de l'offre">{ctx.can("write") ? <OfferForm offer={offer} audiences={audiences} currency={ctx.workspace.currency} /> : <p className="text-sm">{offer.description}</p>}</Section>

      <Section title="Offer Builder (IA)" description="Générez plusieurs variantes de proposition de valeur, titres, bénéfices, objections, garanties suggérées, bundles et upsells."
        actions={<Badge tone="purple">Généré par IA</Badge>}>
        {!ai.configured ? <ConfigRequired env={["OPENAI_API_KEY + OPENAI_MODEL", "ANTHROPIC_API_KEY", "GEMINI_API_KEY + GEMINI_MODEL"]}>Aucun fournisseur d'IA n'est configuré : la génération de variantes est indisponible. Vous pouvez néanmoins gérer votre offre manuellement.</ConfigRequired> : ctx.can("ai") ? (
          <ActionForm action={generateOfferVariantsAction} className="flex flex-wrap items-end gap-3 !space-y-0">
            <input type="hidden" name="id" value={offer.id} />
            <SelectField name="count" label="Nombre de variantes" defaultValue="3" required options={["1", "2", "3", "4", "5"]} />
            <SubmitButton pendingLabel="Génération en cours…">Générer des variantes</SubmitButton>
          </ActionForm>
        ) : <p className="text-sm text-slate-500">Votre rôle ne permet pas d'utiliser l'IA.</p>}

        <div className="mt-5">
          {variants.length === 0 ? <EmptyState title="Aucune variante générée">Les variantes apparaissent ici une fois générées.</EmptyState> : (
            <ul className="space-y-4">
              {variants.map((v) => (
                <li key={v.id}><Card as="article">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h3 className="text-base font-semibold">{v.name}</h3>
                    <span className="text-xs text-slate-500">Proposition IA · {fmtDate(v.createdAt, true)}{v.model ? ` · ${v.model}` : ""}</span>
                  </div>
                  <p className="mt-2 text-lg font-bold">{v.headline}</p>
                  <p className="text-sm text-slate-700">{v.subheadline}</p>
                  <dl className="mt-3 grid gap-3 text-sm md:grid-cols-2">
                    <div><dt className="font-semibold">Proposition de valeur</dt><dd>{v.valueProposition}</dd></div>
                    <div><dt className="font-semibold">CTA</dt><dd>{v.cta}</dd></div>
                    <div><dt className="font-semibold">Bénéfices</dt><dd><ul className="list-disc pl-5">{v.benefits.map((b) => <li key={b}>{b}</li>)}</ul></dd></div>
                    <div><dt className="font-semibold">Objections et réponses</dt><dd><ul className="list-disc pl-5">{v.objections.map((o) => <li key={o.objection}><em>{o.objection}</em> — {o.answer}</li>)}</ul></dd></div>
                    <div><dt className="font-semibold">Garanties suggérées</dt><dd><ul className="list-disc pl-5">{v.guarantees.map((b) => <li key={b}>{b}</li>)}</ul></dd></div>
                    <div><dt className="font-semibold">Bundles / upsells</dt><dd><ul className="list-disc pl-5">{[...v.bundles, ...v.upsells].map((b) => <li key={b}>{b}</li>)}</ul></dd></div>
                  </dl>
                  {ctx.can("write") && <div className="mt-3 flex flex-wrap gap-2">
                    <InlineAction action={createPageFromVariantAction} variant="primary" hidden={{ id: offer.id, variantId: v.id }}>Créer une landing page</InlineAction>
                    <InlineAction action={deleteVariantAction} variant="ghost" hidden={{ id: offer.id, variantId: v.id }} confirm="Supprimer cette variante ?">Supprimer</InlineAction>
                  </div>}
                </Card></li>
              ))}
            </ul>
          )}
        </div>
      </Section>
    </>
  );
}
