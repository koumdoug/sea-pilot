import type { Metadata } from "next";
import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireCtx } from "@/lib/tenant";
import { providerStatus } from "@/lib/ai/providers";
import { AD_PLATFORMS, PLATFORM_LABEL } from "@/lib/constants";
import { Badge, ConfigRequired, EmptyState, PageHeader, Section, fmtDate } from "@/components/ui";
import { ActionForm, InlineAction, SelectField, SubmitButton, TextAreaField, TextField } from "@/components/forms";
import { CopyButton } from "@/components/copy-button";
import { deleteAdAction, duplicateAdAction, generateAdsAction, toggleWinnerAction, updateAdAction } from "./actions";

export const metadata: Metadata = { title: "AI Studio" };

export default async function AiStudioPage({ searchParams }: { searchParams: Promise<{ campaignId?: string; platform?: string; winners?: string }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const ai = providerStatus();
  const where: Prisma.AdWhereInput = { workspaceId: ctx.workspaceId };
  if (sp.campaignId) where.campaignId = sp.campaignId;
  if (sp.platform && (AD_PLATFORMS as readonly string[]).includes(sp.platform)) where.platform = sp.platform;
  if (sp.winners === "1") where.isWinner = true;
  const [ads, campaigns, offers, audiences, gens] = await Promise.all([
    db.ad.findMany({ where, orderBy: { createdAt: "desc" }, take: 60, include: { campaign: { select: { name: true } } } }),
    db.campaign.findMany({ where: { workspaceId: ctx.workspaceId, status: { not: "archived" } }, orderBy: { name: "asc" }, select: { id: true, name: true, offerId: true } }),
    db.offer.findMany({ where: { workspaceId: ctx.workspaceId, status: { not: "archived" } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.audience.findMany({ where: { workspaceId: ctx.workspaceId }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.aIGeneration.findMany({ where: { workspaceId: ctx.workspaceId, kind: "ad_copy" }, orderBy: { createdAt: "desc" }, take: 8 }),
  ]);
  const selectedCampaign = campaigns.find((c) => c.id === sp.campaignId);

  return (
    <>
      <PageHeader title="AI Studio" subtitle="Générez des annonces pour Facebook/Instagram, Google, TikTok et LinkedIn. Chaque génération est enregistrée ; vous pouvez copier, modifier, dupliquer et marquer la gagnante." />
      {!ai.configured ? <div className="mb-5"><ConfigRequired env={["OPENAI_API_KEY + OPENAI_MODEL", "ANTHROPIC_API_KEY", "GEMINI_API_KEY + GEMINI_MODEL"]}>Aucun fournisseur d'IA n'est configuré : la génération est indisponible. {ai.problem} Vous pouvez néanmoins créer et gérer vos annonces existantes ci-dessous.</ConfigRequired></div>
        : ctx.can("ai") && (
          <Section title="Générer des annonces" actions={<Badge tone="purple">{ai.provider} · {ai.model}</Badge>}>
            <ActionForm action={generateAdsAction}>
              <div className="grid gap-4 md:grid-cols-3">
                <SelectField name="platform" label="Plateforme" required defaultValue="meta_ads" options={AD_PLATFORMS.map((p) => [p, PLATFORM_LABEL[p]] as const)} />
                <SelectField name="campaignId" label="Campagne (optionnel)" defaultValue={sp.campaignId} options={campaigns.map((c) => [c.id, c.name] as const)} placeholder="— aucune —" />
                <SelectField name="offerId" label="Offre" defaultValue={selectedCampaign?.offerId} options={offers.map((o) => [o.id, o.name] as const)} placeholder="— celle de la campagne —" />
                <SelectField name="audienceId" label="Audience" options={audiences.map((a) => [a.id, a.name] as const)} placeholder="— celle de la campagne —" />
                <TextField name="tone" label="Ton souhaité" placeholder="Ex. chaleureux, direct, expert" />
                <SelectField name="count" label="Nombre de variantes (A/B)" required defaultValue="3" options={["1", "2", "3", "4", "5", "6", "8"]} />
              </div>
              <SubmitButton pendingLabel="Génération en cours…">Générer</SubmitButton>
            </ActionForm>
          </Section>
        )}

      <form method="get" action="/ai-studio" className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3" role="search">
        <div className="max-w-full"><label htmlFor="fp" className="mb-1 block text-xs font-medium text-slate-600">Plateforme</label><select id="fp" name="platform" defaultValue={sp.platform ?? ""} className="min-h-11 max-w-full rounded-lg border border-slate-300 bg-white px-2 text-sm"><option value="">Toutes</option>{AD_PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABEL[p]}</option>)}</select></div>
        <div className="max-w-full"><label htmlFor="fc" className="mb-1 block text-xs font-medium text-slate-600">Campagne</label><select id="fc" name="campaignId" defaultValue={sp.campaignId ?? ""} className="min-h-11 max-w-full rounded-lg border border-slate-300 bg-white px-2 text-sm"><option value="">Toutes</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
        <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" name="winners" value="1" defaultChecked={sp.winners === "1"} className="size-4" />Gagnantes uniquement</label>
        <button className="min-h-11 rounded-lg bg-brand-600 px-4 text-sm font-semibold text-white hover:bg-brand-700">Filtrer</button>
      </form>

      <h2 className="mb-2 text-base font-semibold">Bibliothèque d'annonces ({ads.length})</h2>
      {ads.length === 0 ? <EmptyState title="Aucune annonce">Générez vos premières variantes ci-dessus.</EmptyState> : (
        <ul className="grid gap-4 lg:grid-cols-2">
          {ads.map((a) => {
            const copy = [a.hook, a.headline, a.primaryText, a.description, a.cta && `CTA : ${a.cta}`].filter(Boolean).join("\n");
            return (
              <li key={a.id} className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge tone="blue">{PLATFORM_LABEL[a.platform] ?? a.platform}</Badge>{a.variantLabel && <Badge>Variante {a.variantLabel}</Badge>}{a.source === "ai" && <Badge tone="purple">IA</Badge>}{a.isWinner && <Badge tone="green">🏆 Gagnante</Badge>}
                  <span className="ml-auto text-slate-500">{fmtDate(a.createdAt)}{a.campaign ? ` · ${a.campaign.name}` : ""}</span>
                </div>
                {a.hook && <p className="mt-2 text-sm italic text-slate-600">« {a.hook} »</p>}
                <p className="mt-1 font-semibold">{a.headline}</p>
                {a.primaryText && <p className="mt-1 text-sm text-slate-800">{a.primaryText}</p>}
                {a.description && <p className="mt-1 text-sm text-slate-600">{a.description}</p>}
                {a.cta && <p className="mt-1 text-sm font-medium text-brand-700">CTA : {a.cta}</p>}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <CopyButton text={copy} />
                  {ctx.can("write") && <>
                    <InlineAction action={toggleWinnerAction} hidden={{ id: a.id }}>{a.isWinner ? "Retirer gagnante" : "Marquer gagnante"}</InlineAction>
                    <InlineAction action={duplicateAdAction} hidden={{ id: a.id }}>Dupliquer</InlineAction>
                    <InlineAction action={deleteAdAction} variant="ghost" hidden={{ id: a.id }} confirm="Supprimer cette annonce ?">Supprimer</InlineAction>
                  </>}
                </div>
                {ctx.can("write") && (
                  <details className="mt-3"><summary className="cursor-pointer text-sm font-medium text-brand-700">Modifier</summary>
                    <ActionForm action={updateAdAction} className="mt-3"><input type="hidden" name="id" value={a.id} />
                      <TextField name="hook" label="Accroche" defaultValue={a.hook} /><TextField name="headline" label="Titre" required defaultValue={a.headline} />
                      <TextAreaField name="primaryText" label="Texte principal" rows={3} defaultValue={a.primaryText} /><TextField name="description" label="Description" defaultValue={a.description} /><TextField name="cta" label="CTA" defaultValue={a.cta} />
                      <SubmitButton variant="secondary">Enregistrer</SubmitButton></ActionForm></details>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Section title="Historique des générations" description="Chaque appel est journalisé : fournisseur, modèle, jetons et coût estimé (si les tarifs sont configurés).">
        {gens.length === 0 ? <p className="text-sm text-slate-500">Aucune génération.</p> : (
          <ul className="divide-y divide-slate-100 text-sm">{gens.map((g) => <li key={g.id} className="flex flex-wrap justify-between gap-2 py-1.5"><span>{fmtDate(g.createdAt, true)} · {g.provider}/{g.model}</span><span className="text-slate-600">{g.status === "ok" ? `${g.promptTokens + g.completionTokens} jetons${g.costUsd != null ? ` · ≈ ${g.costUsd.toFixed(4)} $` : ""}` : <span className="text-red-700">Échec</span>}</span></li>)}</ul>
        )}
      </Section>
      <p className="text-xs text-slate-500"><Link href="/campaigns" className="underline">Retour aux campagnes</Link></p>
    </>
  );
}
