import type { Metadata } from "next";
import Link from "next/link";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { requireCtx } from "@/lib/tenant";
import { pageUrl } from "@/lib/landing";
import { Badge, Card, EmptyState, PageHeader, Section, fmtDate, type Tone } from "@/components/ui";
import { ActionForm, InlineAction, SelectField, SubmitButton, TextField } from "@/components/forms";
import { createPageAction, duplicatePageAction, publishPageAction } from "./actions";

export const metadata: Metadata = { title: "Landing Pages" };
const TONE: Record<string, Tone> = { draft: "gray", published: "green", archived: "orange" };
const LABEL: Record<string, string> = { draft: "Brouillon", published: "Publiée", archived: "Archivée" };

export default async function LandingPages({ searchParams }: { searchParams: Promise<{ archived?: string }> }) {
  const ctx = await requireCtx();
  const sp = await searchParams;
  const showArchived = sp.archived === "1";
  const [pages, offers, views, leads] = await Promise.all([
    db.landingPage.findMany({ where: { workspaceId: ctx.workspaceId, ...(showArchived ? {} : { status: { not: "archived" } }) }, orderBy: { updatedAt: "desc" } }),
    db.offer.findMany({ where: { workspaceId: ctx.workspaceId, status: { not: "archived" } }, orderBy: { name: "asc" } }),
    db.analyticsEvent.groupBy({ by: ["landingPageId"], where: { workspaceId: ctx.workspaceId, type: "page_view" }, _count: { _all: true } }),
    db.lead.groupBy({ by: ["landingPageId"], where: { workspaceId: ctx.workspaceId, deletedAt: null }, _count: { _all: true } }),
  ]);
  return (
    <>
      <PageHeader title="Landing pages" subtitle="Créez, publiez et mesurez vos pages de conversion. Chaque page capture des leads avec leurs paramètres UTM." />
      {ctx.can("write") && (
        <Section title="Nouvelle landing page">
          <ActionForm action={createPageAction} className="grid items-end gap-3 md:grid-cols-3 !space-y-0">
            <TextField name="name" label="Nom de la page" required placeholder="Ex. Devis salle de bain — Lyon" />
            <SelectField name="offerId" label="Partir d'une offre" options={offers.map((o) => [o.id, o.name] as const)} placeholder="— page vierge —" />
            <SubmitButton>Créer la page</SubmitButton>
          </ActionForm>
        </Section>
      )}
      {pages.length === 0 ? <EmptyState title="Aucune landing page">Créez votre première page pour commencer à capturer des leads.</EmptyState> : (
        <ul className="grid gap-3 md:grid-cols-2">
          {pages.map((p) => {
            const v = views.find((x) => x.landingPageId === p.id)?._count._all ?? 0;
            const l = leads.find((x) => x.landingPageId === p.id)?._count._all ?? 0;
            return (
              <li key={p.id}><Card className="h-full">
                <div className="flex items-start justify-between gap-2"><Link href={`/landing-pages/${p.id}`} className="min-w-0 break-words font-semibold text-brand-700 underline">{p.name}</Link><Badge tone={TONE[p.status]}>{LABEL[p.status]}</Badge></div>
                <p className="mt-1 break-all text-xs text-slate-500">{pageUrl(env.appUrl, ctx.workspace.slug, p.slug)}</p>
                <p className="mt-2 text-sm text-slate-700">{v} visite(s) · {l} lead(s){v > 0 ? ` · conversion ${((l / v) * 100).toFixed(1)} %` : ""}</p>
                <p className="text-xs text-slate-500">Modifiée le {fmtDate(p.updatedAt)}</p>
                {ctx.can("write") && <div className="mt-3 flex flex-wrap gap-2">
                  {p.status === "published" && <InlineAction action={publishPageAction} hidden={{ id: p.id, to: "draft" }}>Dépublier</InlineAction>}
                  {p.status !== "published" && p.status !== "archived" && <InlineAction action={publishPageAction} variant="primary" hidden={{ id: p.id, to: "published" }}>Publier</InlineAction>}
                  <InlineAction action={duplicatePageAction} hidden={{ id: p.id }}>Dupliquer</InlineAction>
                  {p.status !== "archived" ? <InlineAction action={publishPageAction} variant="ghost" hidden={{ id: p.id, to: "archived" }} confirm="Archiver cette page ? Elle ne sera plus accessible publiquement.">Archiver</InlineAction> : <InlineAction action={publishPageAction} hidden={{ id: p.id, to: "draft" }}>Restaurer</InlineAction>}
                </div>}
              </Card></li>
            );
          })}
        </ul>
      )}
      <p className="mt-4 text-sm"><Link className="text-brand-700 underline" href={showArchived ? "/landing-pages" : "/landing-pages?archived=1"}>{showArchived ? "Masquer les archivées" : "Afficher les archivées"}</Link></p>
    </>
  );
}
