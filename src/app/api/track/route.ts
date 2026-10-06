import { z } from "zod";
import { db } from "@/lib/db";
import { clientIp, rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const body = z.object({
  pageId: z.string().min(1).max(60),
  type: z.enum(["page_view", "cta_click"]),
  sessionId: z.string().max(64).optional(),
  path: z.string().max(300).optional(),
  referrer: z.string().max(500).optional(),
  utm: z.object({ source: z.string().max(200).optional(), medium: z.string().max(200).optional(), campaign: z.string().max(200).optional(), term: z.string().max(200).optional(), content: z.string().max(200).optional() }).optional(),
});

/**
 * Mesure d'audience des landing pages : sans cookie, sans adresse IP stockée, sans empreinte de navigateur.
 * L'identifiant de session reste dans le sessionStorage de l'onglet et n'identifie pas la personne.
 */
export async function POST(req: Request) {
  const ip = clientIp(req.headers);
  if (!rateLimit(`track:${ip}`, 120, 60_000).ok) return new Response(null, { status: 429 });
  let p: z.infer<typeof body>;
  try { p = body.parse(JSON.parse((await req.text()).slice(0, 10_000))); } catch { return new Response(null, { status: 400 }); }
  const page = await db.landingPage.findFirst({ where: { id: p.pageId, status: "published" }, select: { id: true, workspaceId: true, campaignId: true } });
  if (!page) return new Response(null, { status: 404 });
  await db.analyticsEvent.create({
    data: {
      workspaceId: page.workspaceId, type: p.type, landingPageId: page.id, campaignId: page.campaignId, sessionId: p.sessionId, path: p.path, referrer: p.referrer,
      utmSource: p.utm?.source, utmMedium: p.utm?.medium, utmCampaign: p.utm?.campaign, utmTerm: p.utm?.term, utmContent: p.utm?.content,
    },
  });
  return new Response(null, { status: 204 });
}
