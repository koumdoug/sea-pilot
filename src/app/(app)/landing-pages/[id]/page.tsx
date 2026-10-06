import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { requireCtx } from "@/lib/tenant";
import { DEFAULT_CONSENT, DEFAULT_FORM_FIELDS, formFieldsSchema, pageUrl, parseSections, themeSchema } from "@/lib/landing";
import { Alert, Badge, PageHeader, StatTile, type Tone, fmtDate } from "@/components/ui";
import { InlineAction } from "@/components/forms";
import { LandingEditor } from "@/components/landing-editor";
import { deletePageAction, duplicatePageAction, publishPageAction, savePageAction } from "../actions";

export const metadata: Metadata = { title: "Éditeur de landing page" };
const TONE: Record<string, Tone> = { draft: "gray", published: "green", archived: "orange" };
const LABEL: Record<string, string> = { draft: "Brouillon", published: "Publiée", archived: "Archivée" };

export default async function LandingEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCtx();
  const { id } = await params;
  const page = await db.landingPage.findFirst({ where: { id, workspaceId: ctx.workspaceId }, include: { forms: { orderBy: { createdAt: "asc" }, take: 1 } } });
  if (!page) notFound();
  const [campaigns, offers, views, clicks, leads] = await Promise.all([
    db.campaign.findMany({ where: { workspaceId: ctx.workspaceId, status: { not: "archived" } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.offer.findMany({ where: { workspaceId: ctx.workspaceId, status: { not: "archived" } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    db.analyticsEvent.count({ where: { workspaceId: ctx.workspaceId, landingPageId: id, type: "page_view" } }),
    db.analyticsEvent.count({ where: { workspaceId: ctx.workspaceId, landingPageId: id, type: "cta_click" } }),
    db.lead.count({ where: { workspaceId: ctx.workspaceId, landingPageId: id, deletedAt: null } }),
  ]);
  const f = page.forms[0];
  const fields = f ? formFieldsSchema.safeParse(f.fields) : null;
  const theme = themeSchema.safeParse(page.theme ?? {});
  const url = pageUrl(env.appUrl, ctx.workspace.slug, page.slug);
  const canWrite = ctx.can("write");

  return (
    <>
      <PageHeader title={page.name} subtitle={<><Link href="/landing-pages" className="underline">← Landing pages</Link> · <Badge tone={TONE[page.status]}>{LABEL[page.status]}</Badge> · modifiée le {fmtDate(page.updatedAt)}</>}
        actions={canWrite ? <>
          {page.status !== "published" && page.status !== "archived" && <InlineAction action={publishPageAction} variant="primary" size="md" hidden={{ id: page.id, to: "published" }}>Publier</InlineAction>}
          {page.status === "published" && <InlineAction action={publishPageAction} size="md" hidden={{ id: page.id, to: "draft" }}>Dépublier</InlineAction>}
          <InlineAction action={duplicatePageAction} size="md" hidden={{ id: page.id }}>Dupliquer</InlineAction>
          {page.status !== "archived" && <InlineAction action={publishPageAction} size="md" variant="ghost" hidden={{ id: page.id, to: "archived" }} confirm="Archiver cette page ?">Archiver</InlineAction>}
          {page.status === "draft" && <InlineAction action={deletePageAction} size="md" variant="danger" hidden={{ id: page.id }} confirm="Supprimer définitivement cette page ?">Supprimer</InlineAction>}
        </> : undefined} />
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Visites" value={views} /><StatTile label="Clics sur le bouton" value={clicks} /><StatTile label="Leads" value={leads} />
        <StatTile label="Conversion" value={views > 0 ? `${((leads / views) * 100).toFixed(1)} %` : "—"} hint={views === 0 ? "aucune visite mesurée" : undefined} />
      </div>
      {page.status === "published" ? <div className="mb-5"><Alert tone="success">Page publique : <a className="break-all underline" href={url} target="_blank" rel="noopener noreferrer">{url}</a> — ajoutez <code>?utm_source=…&utm_medium=…&utm_campaign=…</code> à vos liens pour suivre l'origine des leads.</Alert></div>
        : <div className="mb-5"><Alert tone="info">Cette page n'est pas publique. Adresse après publication : <code className="break-all">{url}</code></Alert></div>}
      {canWrite ? (
        <LandingEditor action={savePageAction}
          page={{ id: page.id, name: page.name, slug: page.slug, seoTitle: page.seoTitle, seoDescription: page.seoDescription, ogImage: page.ogImage, canonicalUrl: page.canonicalUrl, campaignId: page.campaignId, offerId: page.offerId, primary: theme.success ? theme.data.primary : "#2563eb", sections: parseSections(page.sections) }}
          form={{ fields: fields?.success ? fields.data : DEFAULT_FORM_FIELDS, consentText: f?.consentText ?? DEFAULT_CONSENT, successMessage: f?.successMessage ?? "Merci ! Nous revenons vers vous très vite.", redirectUrl: f?.redirectUrl ?? null, active: f?.active ?? true }}
          campaigns={campaigns.map((c) => [c.id, c.name] as const)} offers={offers.map((o) => [o.id, o.name] as const)} previewHref={`/p/${ctx.workspace.slug}/${page.slug}?preview=1`} />
      ) : <Alert tone="info">Votre rôle est en lecture seule. <a className="underline" href={`/p/${ctx.workspace.slug}/${page.slug}?preview=1`} target="_blank" rel="noopener noreferrer">Voir la page</a></Alert>}
    </>
  );
}
