import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { getSessionUser } from "@/lib/auth";
import { formFieldsSchema, pageUrl, parseSections, themeSchema } from "@/lib/landing";
import { LandingView } from "@/components/landing-view";

export const dynamic = "force-dynamic";

async function load(ws: string, slug: string) {
  const workspace = await db.workspace.findFirst({ where: { slug: ws, deletedAt: null }, select: { id: true, slug: true, name: true } });
  if (!workspace) return null;
  const page = await db.landingPage.findUnique({ where: { workspaceId_slug: { workspaceId: workspace.id, slug } }, include: { forms: { where: { active: true }, orderBy: { createdAt: "asc" }, take: 1 } } });
  if (!page || page.status === "archived") return null;
  return { workspace, page };
}

export async function generateMetadata({ params }: { params: Promise<{ ws: string; slug: string }> }): Promise<Metadata> {
  const { ws, slug } = await params;
  const d = await load(ws, slug);
  if (!d) return { title: "Page introuvable", robots: { index: false } };
  const { page, workspace } = d;
  const title = page.seoTitle || page.name;
  const url = page.canonicalUrl || pageUrl(env.appUrl, workspace.slug, page.slug);
  const published = page.status === "published";
  return {
    title: { absolute: title }, description: page.seoDescription ?? undefined, alternates: { canonical: url }, robots: { index: published, follow: published },
    openGraph: { title, description: page.seoDescription ?? undefined, url, type: "website", siteName: workspace.name, ...(page.ogImage ? { images: [page.ogImage] } : {}) },
    twitter: { card: page.ogImage ? "summary_large_image" : "summary", title, description: page.seoDescription ?? undefined },
  };
}

export default async function PublicLandingPage({ params, searchParams }: { params: Promise<{ ws: string; slug: string }>; searchParams: Promise<{ preview?: string }> }) {
  const { ws, slug } = await params;
  const sp = await searchParams;
  const d = await load(ws, slug);
  if (!d) notFound();
  const { page, workspace } = d;

  let preview = false;
  if (page.status !== "published") {
    // Un brouillon n'est visible que par un membre connecté de l'espace de travail.
    const user = sp.preview ? await getSessionUser() : null;
    const m = user ? await db.membership.findUnique({ where: { userId_workspaceId: { userId: user.id, workspaceId: workspace.id } } }) : null;
    if (!m) notFound();
    preview = true;
  }
  const f = page.forms[0];
  const fields = f ? formFieldsSchema.safeParse(f.fields) : null;
  const theme = themeSchema.safeParse(page.theme ?? {});
  const sections = parseSections(page.sections);
  const title = page.seoTitle || page.name;
  const jsonLd = { "@context": "https://schema.org", "@type": "WebPage", name: title, description: page.seoDescription ?? undefined, url: pageUrl(env.appUrl, workspace.slug, page.slug), publisher: { "@type": "Organization", name: workspace.name } };

  return (
    <>
      {preview && <div role="status" className="sticky top-0 z-50 bg-amber-300 px-4 py-2 text-center text-sm font-semibold text-amber-950">Aperçu du brouillon — cette page n'est pas publique. L'envoi du formulaire est désactivé.</div>}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
      <main id="contenu">
        <LandingView pageId={page.id} sections={sections} primary={theme.success ? theme.data.primary : "#2563eb"} preview={preview}
          form={f && fields?.success ? { id: f.id, fields: fields.data, consentText: f.consentText } : null} />
      </main>
    </>
  );
}
