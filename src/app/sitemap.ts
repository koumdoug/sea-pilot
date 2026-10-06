import type { MetadataRoute } from "next";
import { db } from "@/lib/db";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

/** Pages publiques de SEA Pilot + landing pages publiées (indexables). */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = env.appUrl;
  const staticPages: MetadataRoute.Sitemap = ["", "/demo", "/privacy", "/terms"].map((p) => ({ url: `${base}${p}`, changeFrequency: "monthly", priority: p === "" ? 1 : 0.5 }));
  let pages: MetadataRoute.Sitemap = [];
  try {
    const rows = await db.landingPage.findMany({ where: { status: "published", workspace: { deletedAt: null, isDemo: false } }, select: { slug: true, updatedAt: true, canonicalUrl: true, workspace: { select: { slug: true } } }, take: 5000 });
    pages = rows.filter((r) => !r.canonicalUrl).map((r) => ({ url: `${base}/p/${r.workspace.slug}/${r.slug}`, lastModified: r.updatedAt, changeFrequency: "weekly" as const, priority: 0.7 }));
  } catch { /* base indisponible au build : on renvoie les pages statiques */ }
  return [...staticPages, ...pages];
}
